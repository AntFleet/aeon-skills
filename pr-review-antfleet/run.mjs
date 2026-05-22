#!/usr/bin/env node
// Self-contained AntFleet PR review trigger for Aeon agents.
//
// Flow (matches docs/aeon-skill-pack.md, three-call protocol):
//   1. POST {ANTFLEET_API_BASE}/api/v1/installations/{id}/review/challenge
//      → challenge_id, challenge string, expires_at
//   2. Sign the challenge string with ANTFLEET_WALLET_PRIVATE_KEY using
//      EIP-191 personal_sign (viem's signMessage).
//   3. POST {ANTFLEET_API_BASE}/api/v1/installations/{id}/review with the
//      signed body → 200 with findings, channel state.
//
// On success, writes a clean human-readable markdown report to
// .outputs/pr-review-antfleet.md so the Aeon agent (and the operator
// who reads memory/logs) can see the verdict at a glance. Exits 0 on
// 200 cached or fresh, non-zero on any failure with a clear stderr.
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
// only spend it on reviews. Treat it as a low-blast-radius secret but
// don't commit it to git. The signature lifetime is bounded to 10 min
// per challenge (single-use, server-enforced).

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { privateKeyToAccount } from "viem/accounts";

const DEFAULT_API_BASE = "https://www.antfleet.dev";
const DEFAULT_OUTPUT_PATH = ".outputs/pr-review-antfleet.md";

function die(msg, code = 1) {
  console.error(`pr-review-antfleet: ${msg}`);
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
  // Validate locally before we mint a server-side challenge — bad input
  // shouldn't burn a nonce just to surface a 400 from the API.
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
    // Return a structured failure so main() can write the error report
    // file before exiting — the Aeon agent reads that file for its
    // summary, so we mustn't exit without writing it.
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
  if (!res.ok) {
    // Surface the error code + body verbatim so the Aeon agent can react
    // (e.g., "402 insufficient_channel_balance" → message the operator).
    return { ok: false, status: res.status, body: json };
  }
  return { ok: true, status: res.status, body: json };
}

function renderFindingsMd({ payload, args, apiBase }) {
  const r = payload.receipt ?? {};
  const ch = payload.channel ?? {};
  const findings = Array.isArray(payload.findings) ? payload.findings : [];
  const lines = [];
  lines.push("# AntFleet PR review");
  lines.push("");
  const shaForHeader = r.sha ?? args.sha;
  const shaCell = shaForHeader ? `\`${String(shaForHeader).slice(0, 12)}\`` : "—";
  lines.push(
    `**Target:** ${r.repo?.owner ?? args.repo ?? "?"}/${r.repo?.name ?? ""} ` +
      `· PR #${r.pr_number ?? args.pr ?? "?"} · sha ${shaCell}`,
  );
  lines.push(
    `**Cached:** ${payload.cached ? "yes (no debit)" : "no (fresh review)"} ` +
      `· **Findings:** ${findings.length}`,
  );
  if (ch.debited_usdc !== undefined && ch.debited_usdc !== null) {
    lines.push(
      `**Channel:** debited ${ch.debited_usdc} USDC · remaining ${ch.remaining_usdc ?? "?"} USDC`,
    );
  } else {
    lines.push(`**Channel:** no debit (cached) · remaining ${ch.remaining_usdc ?? "?"} USDC`);
  }
  if (r.pr_comment_url) {
    lines.push(`**PR comment:** ${r.pr_comment_url}`);
  }
  lines.push(`**Receipt:** ${apiBase}/receipts/${r.review_id ?? ""}`);
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
  const code = body?.error?.code ?? "unknown_error";
  const msg = body?.error?.message ?? "(no message)";
  const shaCell = args.sha ? `\`${args.sha.slice(0, 12)}\`` : "—";
  const lines = [
    "# AntFleet PR review — failed",
    "",
    `**Stage:** ${stage === "challenge" ? "challenge mint" : "review submit"}`,
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
  } else if (code === "review_in_progress") {
    lines.push(
      `The worker failed transiently and will be retried by the cron sweep. Re-run this skill with a fresh challenge in ~60 seconds — the cached SHA cache means you won't be re-debited; you'll get the cached finding once the sweep completes.`,
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

  // TLS enforcement: refuse plaintext API bases. Signed challenges
  // posted over http would leak (wallet, install_id, signature) to any
  // on-path observer. Single-use semantics bound replay but the
  // disclosure is still a real cost; cheap to reject up front.
  if (!apiBase.startsWith("https://")) {
    die("ANTFLEET_API_BASE must use https:// — refusing to send signed challenges over plaintext");
  }

  // Output-path traversal guard: ANTFLEET_OUTPUT_PATH is operator-set,
  // but an adversarial sibling skill that can write to the env could
  // point us at e.g. ~/.ssh/authorized_keys. Resolve against cwd and
  // reject anything that escapes the project root.
  const cwd = process.cwd();
  const outputPath = resolve(cwd, process.env.ANTFLEET_OUTPUT_PATH ?? DEFAULT_OUTPUT_PATH);
  if (relative(cwd, outputPath).startsWith("..")) {
    die("ANTFLEET_OUTPUT_PATH must resolve within the current working directory");
  }

  // The challenge is server-issued and single-use; we mint a fresh one
  // every invocation rather than caching one ahead of time.
  const challengeResult = await mintChallenge(apiBase, installationId);
  if (!challengeResult.ok) {
    const md = renderErrorMd({
      status: challengeResult.status,
      body: challengeResult.body,
      args,
      apiBase,
      installationId,
      stage: "challenge",
    });
    await writeOutput(outputPath, md);
    const code = challengeResult.body?.error?.code ?? "";
    const msg = challengeResult.body?.error?.message ?? "";
    console.error(
      `pr-review-antfleet: challenge mint failed: ${challengeResult.status} ${code} ${msg}`,
    );
    console.error(`pr-review-antfleet: wrote error report to ${outputPath}`);
    process.exit(2);
  }
  const challenge = challengeResult.body;
  if (typeof challenge?.challenge_id !== "string" || typeof challenge?.challenge !== "string") {
    die(`unexpected challenge response shape: ${JSON.stringify(challenge)}`);
  }

  // EIP-191 personal_sign via viem. The recovered address on the server
  // side is compared lowercased to the wallet bound at /bind — if this
  // private key isn't the bound wallet, we get 401 signature_mismatch.
  const pkHex = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
  const account = privateKeyToAccount(pkHex);
  const signature = await account.signMessage({ message: challenge.challenge });

  const body = buildBody({
    challengeId: challenge.challenge_id,
    signature,
    pr: args.pr,
    sha: args.sha,
    repo: args.repo,
  });
  const result = await submitReview(apiBase, installationId, body);

  if (!result.ok) {
    const md = renderErrorMd({
      status: result.status,
      body: result.body,
      args,
      apiBase,
      installationId,
    });
    await writeOutput(outputPath, md);
    console.error(
      `pr-review-antfleet: ${result.status} ${result.body?.error?.code ?? ""} ${result.body?.error?.message ?? ""}`,
    );
    console.error(`pr-review-antfleet: wrote error report to ${outputPath}`);
    // 5xx is treated as transient (exit 3, "safe to retry") to match the
    // SKILL.md / README exit-code contract. 4xx is a permanent caller-
    // error condition (exit 2, "do NOT retry blindly").
    process.exit(result.status >= 500 ? 3 : 2);
  }

  const md = renderFindingsMd({ payload: result.body, args, apiBase });
  await writeOutput(outputPath, md);
  const findingCount = Array.isArray(result.body?.findings) ? result.body.findings.length : 0;
  const cached = result.body?.cached === true ? " (cached)" : "";
  console.log(`pr-review-antfleet: ${findingCount} finding(s)${cached} · wrote ${outputPath}`);
}

main().catch((err) => {
  console.error("pr-review-antfleet: unexpected error:", err?.stack ?? err);
  process.exit(3);
});
