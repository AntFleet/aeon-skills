#!/usr/bin/env node
// Self-contained AntFleet PR review trigger for Aeon agents (v2.0).
//
// Async polling contract:
//   1. POST .../review/challenge → challenge_id, challenge string
//   2. Sign the challenge with ANTFLEET_WALLET_PRIVATE_KEY (EIP-191).
//   3. POST .../review → 202 { jobId, statusUrl }
//   4. Poll GET .../review/{jobId}?challenge_id=...&signature=...
//      every 10s until status is complete or failed.
//
// On success, writes a clean human-readable markdown report to
// .outputs/pr-review-antfleet.md. Exits 0 on complete, non-zero
// on any failure with a clear stderr.
//
// Usage:
//   node run.mjs --pr 42                       (uses install's bound repo)
//   node run.mjs --pr 42 --repo owner/name     (override)
//   node run.mjs --sha <hex>                   (resolve to PR via GitHub)
//   node run.mjs --sha <hex> --repo owner/name
//
// Required env vars:
//   ANTFLEET_INSTALLATION_ID     UUID from the AntFleet dashboard
//   ANTFLEET_WALLET_PRIVATE_KEY  0x... 32-byte hex of the bound wallet
//
// Optional env vars:
//   ANTFLEET_API_BASE            Default: https://www.antfleet.dev
//   ANTFLEET_OUTPUT_PATH         Default: .outputs/pr-review-antfleet.md
//
// Security: ANTFLEET_WALLET_PRIVATE_KEY only authorizes review triggers
// on this single installation — it cannot move USDC out of the channel,
// only spend it on reviews. The signature lifetime is bounded to 10 min
// per challenge (single-use, server-enforced).

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { privateKeyToAccount } from "viem/accounts";

const DEFAULT_API_BASE = "https://www.antfleet.dev";
const DEFAULT_OUTPUT_PATH = ".outputs/pr-review-antfleet.md";
const POLL_INTERVAL_MS = 10_000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

function die(msg, code = 1) {
  console.error(`[antfleet] ${msg}`);
  process.exit(code);
}

function parseArgs(argv) {
  const out = { pr: null, sha: null, repo: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--pr") out.pr = Number(argv[++i]);
    else if (a === "--sha") out.sha = argv[++i];
    else if (a === "--repo") out.repo = argv[++i];
    else if (a === "--help" || a === "-h") {
      console.log("usage: node run.mjs (--pr <number> | --sha <hex>) [--repo owner/name]");
      process.exit(0);
    } else {
      die(`unknown arg: ${a}`);
    }
  }
  if (out.pr === null && out.sha === null) {
    die("either --pr or --sha is required");
  }
  if (out.pr !== null && !(Number.isInteger(out.pr) && out.pr > 0)) {
    die("--pr must be a positive integer");
  }
  if (out.sha !== null && !/^[0-9a-f]{7,64}$/i.test(out.sha)) {
    die("--sha must be 7-64 hex chars (0-9, a-f)");
  }
  if (out.repo !== null && !/^[^/\s]+\/[^/\s]+$/.test(out.repo)) {
    die("--repo must be owner/name");
  }
  return out;
}

function requireEnv(name) {
  const v = process.env[name];
  if (v === undefined || v.length === 0) {
    die(`${name} env var is required`);
  }
  return v;
}

function buildBody({ challengeId, signature, pr, sha, repo }) {
  const body = { challenge_id: challengeId, signature };
  if (pr !== null) body.pr_number = pr;
  if (sha !== null) body.sha = sha;
  if (repo !== null) body.repo = repo;
  return body;
}

async function mintChallenge(apiBase, installationId) {
  const url = `${apiBase}/api/v1/installations/${installationId}/review/challenge`;
  const res = await fetch(url, { method: "POST" });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    return { ok: false, status: res.status, body };
  }
  return { ok: true, status: res.status, body };
}

async function submitReview(apiBase, installationId, body) {
  const url = `${apiBase}/api/v1/installations/${installationId}/review`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body: json };
}

async function pollJobStatus(apiBase, installationId, jobId, challengeId, signature) {
  const base = `${apiBase}/api/v1/installations/${installationId}/review/${jobId}`;
  const url = `${base}?challenge_id=${encodeURIComponent(challengeId)}&signature=${encodeURIComponent(signature)}`;

  const t0 = Date.now();
  let elapsed = 0;

  while (elapsed < POLL_TIMEOUT_MS) {
    const res = await fetch(url);
    const json = await res.json().catch(() => ({}));

    if (!res.ok) {
      return { ok: false, status: res.status, body: json };
    }

    const status = json.status;
    elapsed = Date.now() - t0;

    if (status === "complete") {
      console.error(`[antfleet] complete · ${Math.round(elapsed / 1000)}s elapsed`);
      return { ok: true, status: res.status, body: json };
    }

    if (status === "failed") {
      console.error(`[antfleet] failed · ${json.failureMode ?? "unknown"}`);
      return { ok: false, status: res.status, body: json, jobFailed: true };
    }

    if (status === "expired") {
      console.error(`[antfleet] expired`);
      return { ok: false, status: res.status, body: json, jobFailed: true };
    }

    // Still queued or running
    console.error(`[antfleet] ${status} · ${Math.round(elapsed / 1000)}s elapsed`);
    await sleep(POLL_INTERVAL_MS);
  }

  return { ok: false, status: 0, body: { error: { code: "poll_timeout", message: "polling timed out after 10 minutes" } } };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function renderFindingsMd({ payload, args, apiBase }) {
  const result = payload.result ?? payload;
  const r = result.receipt ?? result;
  const findings = Array.isArray(result.findings) ? result.findings : [];
  const lines = [];
  lines.push("# AntFleet PR review");
  lines.push("");
  const shaForHeader = r.commitSha ?? r.sha ?? args.sha;
  const shaCell = shaForHeader ? `\`${String(shaForHeader).slice(0, 12)}\`` : "—";
  const owner = r.owner ?? r.repo?.owner ?? args.repo ?? "?";
  const repo = r.repo?.name ?? r.repo ?? "";
  lines.push(`**Target:** ${owner}/${repo} · PR #${r.prNumber ?? r.pr_number ?? args.pr ?? "?"} · sha ${shaCell}`);

  const cached = result.cached === true;
  lines.push(
    `**Cached:** ${cached ? "yes (no debit)" : "no (fresh review)"} ` +
      `· **Findings:** ${findings.length}`,
  );

  if (r.prCommentUrl ?? r.pr_comment_url) {
    lines.push(`**PR comment:** ${r.prCommentUrl ?? r.pr_comment_url}`);
  }
  const reviewId = result.reviewId ?? r.reviewId ?? r.review_id ?? "";
  lines.push(`**Receipt:** ${apiBase}/receipts/${reviewId}`);
  lines.push("");

  if (findings.length === 0) {
    lines.push("---");
    lines.push("");
    lines.push("No agreed findings. Two-model consensus produced no defects worth flagging.");
    lines.push("");
    return lines.join("\n");
  }
  lines.push("---");
  lines.push("");
  findings.forEach((f, i) => {
    lines.push(`## ${i + 1}. ${f.title ?? "(untitled)"}`);
    lines.push("");
    const meta = [
      f.severity ? `**severity:** ${f.severity}` : null,
      f.category ? `**category:** ${f.category}` : null,
      f.confidence ? `**confidence:** ${f.confidence}` : null,
    ].filter(Boolean);
    if (meta.length > 0) {
      lines.push(meta.join(" · "));
      lines.push("");
    }
    if (Array.isArray(f.evidence) && f.evidence.length > 0) {
      lines.push("**Evidence:**");
      for (const e of f.evidence) {
        const range =
          e.startLine !== null && e.endLine !== null && e.startLine !== undefined
            ? `:L${e.startLine}-L${e.endLine}`
            : "";
        lines.push(`- \`${e.path ?? "?"}${range}\`${e.symbol ? ` — \`${e.symbol}\`` : ""}`);
        if (e.quote) {
          lines.push("  ```");
          lines.push(`  ${String(e.quote).split("\n").join("\n  ")}`);
          lines.push("  ```");
        }
      }
      lines.push("");
    }
    if (f.reasoning) {
      lines.push("**Why it matters:**");
      lines.push("");
      lines.push(f.reasoning);
      lines.push("");
    }
    if (f.recommendation) {
      lines.push("**Recommendation:**");
      lines.push("");
      lines.push(f.recommendation);
      lines.push("");
    }
    if (f.suggestedRegressionTest) {
      lines.push("**Suggested regression test:**");
      lines.push("");
      lines.push("```");
      lines.push(f.suggestedRegressionTest);
      lines.push("```");
      lines.push("");
    }
  });
  return lines.join("\n");
}

function renderErrorMd({ status, body, args, apiBase, installationId, stage = "submit" }) {
  const code = body?.error?.code ?? body?.failureMode ?? "unknown_error";
  const msg = body?.error?.message ?? body?.failureMessage ?? "(no message)";
  const shaCell = args.sha ? `\`${args.sha.slice(0, 12)}\`` : "—";
  const lines = [
    "# AntFleet PR review — failed",
    "",
    `**Stage:** ${stage}`,
    `**Status:** ${status} \`${code}\``,
    `**Message:** ${msg}`,
    `**Install:** ${installationId}`,
    `**Target:** ${args.repo ?? "(install default)"} · PR #${args.pr ?? "—"} · sha ${shaCell}`,
    `**API base:** ${apiBase}`,
    "",
  ];
  if (code === "insufficient_channel_balance") {
    lines.push(
      `Top up the channel: send USDC on Base to the deposit address shown in the AntFleet dashboard.`,
      `Required: ${body?.required_usdc ?? "?"} USDC · Current: ${body?.current_usdc ?? "?"} USDC.`,
    );
  } else if (code === "sync_mode_removed") {
    lines.push(
      `This skill version is outdated. Update to aeon-skills v2.0+ which uses the async polling contract.`,
    );
  } else if (code === "challenge_already_used" || code === "expired_challenge") {
    lines.push(
      `The challenge nonce is single-use and lifetime-bounded to 10 minutes. Re-run this skill to mint a fresh one.`,
    );
  } else if (code === "pr_not_open") {
    lines.push(`Only open PRs can be reviewed. The pull-mode flow mirrors the GitHub App webhook.`);
  } else if (code === "github_app_not_installed") {
    lines.push(
      `Install antfleet[bot] on the target repo first: https://github.com/apps/antfleet`,
      `Then re-run.`,
    );
  } else if (code === "signature_mismatch") {
    lines.push(
      `The signature did not recover to the wallet bound to this installation. Check that ANTFLEET_WALLET_PRIVATE_KEY matches the wallet you used at /bind.`,
    );
  } else if (code === "not_eligible") {
    lines.push(
      `The installation is not eligible for review challenges. This is the deliberately-collapsed code for: row missing, no wallet claimed, or wallet not yet bound. Run the onboarding flow (/api/v1/installations → /bind → fund).`,
    );
  } else if (code === "poll_timeout") {
    lines.push(
      `The review job did not complete within 10 minutes. It may still finish — check the AntFleet dashboard or re-run with the same PR/SHA (idempotent, no re-debit).`,
    );
  }
  return lines.join("\n");
}

async function writeOutput(outputPath, content) {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, content, "utf-8");
}

async function main() {
  const args = parseArgs(process.argv);
  const installationId = requireEnv("ANTFLEET_INSTALLATION_ID");
  const privateKey = requireEnv("ANTFLEET_WALLET_PRIVATE_KEY");
  const apiBase = (process.env.ANTFLEET_API_BASE ?? DEFAULT_API_BASE).replace(/\/+$/, "");

  if (!apiBase.startsWith("https://")) {
    die("ANTFLEET_API_BASE must use https:// — refusing to send signed challenges over plaintext");
  }

  const cwd = process.cwd();
  const outputPath = resolve(cwd, process.env.ANTFLEET_OUTPUT_PATH ?? DEFAULT_OUTPUT_PATH);
  if (relative(cwd, outputPath).startsWith("..")) {
    die("ANTFLEET_OUTPUT_PATH must resolve within the current working directory");
  }

  // Step 1: Mint challenge
  console.error(`[antfleet] minting challenge...`);
  const challengeResult = await mintChallenge(apiBase, installationId);
  if (!challengeResult.ok) {
    const md = renderErrorMd({
      status: challengeResult.status,
      body: challengeResult.body,
      args,
      apiBase,
      installationId,
      stage: "challenge mint",
    });
    await writeOutput(outputPath, md);
    const code = challengeResult.body?.error?.code ?? "";
    console.error(`[antfleet] challenge mint failed: ${challengeResult.status} ${code}`);
    process.exit(2);
  }
  const challenge = challengeResult.body;
  if (typeof challenge?.challenge_id !== "string" || typeof challenge?.challenge !== "string") {
    die(`unexpected challenge response shape: ${JSON.stringify(challenge)}`);
  }

  // Step 2: Sign
  const pkHex = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
  const account = privateKeyToAccount(pkHex);
  const signature = await account.signMessage({ message: challenge.challenge });

  // Step 3: Submit (POST → 202)
  const body = buildBody({
    challengeId: challenge.challenge_id,
    signature,
    pr: args.pr,
    sha: args.sha,
    repo: args.repo,
  });
  console.error(`[antfleet] submitting review...`);
  const result = await submitReview(apiBase, installationId, body);

  if (!result.ok) {
    const md = renderErrorMd({
      status: result.status,
      body: result.body,
      args,
      apiBase,
      installationId,
      stage: "review submit",
    });
    await writeOutput(outputPath, md);
    console.error(`[antfleet] submit failed: ${result.status} ${result.body?.error?.code ?? ""}`);
    process.exit(result.status >= 500 ? 3 : 2);
  }

  const jobId = result.body?.jobId;
  if (!jobId) {
    die(`unexpected submit response — no jobId: ${JSON.stringify(result.body)}`);
  }
  console.error(`[antfleet] queued · job ${jobId}`);

  // Step 4: Poll until complete/failed
  const pollResult = await pollJobStatus(
    apiBase,
    installationId,
    jobId,
    challenge.challenge_id,
    signature,
  );

  if (!pollResult.ok) {
    const stage = pollResult.jobFailed ? "review processing" : "poll";
    const md = renderErrorMd({
      status: pollResult.status,
      body: pollResult.body,
      args,
      apiBase,
      installationId,
      stage,
    });
    await writeOutput(outputPath, md);
    const code = pollResult.body?.error?.code ?? pollResult.body?.failureMode ?? "";
    console.error(`[antfleet] failed: ${code}`);
    process.exit(pollResult.jobFailed ? 2 : 3);
  }

  // Complete — render findings from the result
  const md = renderFindingsMd({ payload: pollResult.body, args, apiBase });
  await writeOutput(outputPath, md);

  const result2 = pollResult.body.result ?? pollResult.body;
  const findings = Array.isArray(result2.findings) ? result2.findings : [];
  const agreedDecision = result2.agreementDecision ?? {};
  const agreed = Array.isArray(agreedDecision.agreed) ? agreedDecision.agreed : findings;
  console.log(`[antfleet] ${agreed.length} finding(s) · wrote ${outputPath}`);
}

main().catch((err) => {
  console.error("[antfleet] unexpected error:", err?.stack ?? err);
  process.exit(3);
});
