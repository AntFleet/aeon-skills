#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

const DEFAULT_API_BASE = "https://www.antfleet.dev";
const DEFAULT_OUTPUT_PATH = ".outputs/pr-review-antfleet-x402.md";
const POLL_INTERVAL_MS = 10_000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

function die(message, code = 1) {
  console.error(`[antfleet:x402] ${message}`);
  process.exit(code);
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) die(`${name} env var is required`, 2);
  return value;
}

function parseArgs(argv) {
  const out = { pr: null, sha: null, repo: null };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--pr") out.pr = Number(argv[++i]);
    else if (arg === "--sha") out.sha = argv[++i];
    else if (arg === "--repo") out.repo = argv[++i];
    else if (arg === "--help" || arg === "-h") {
      console.log("usage: node run.mjs (--pr <number> | --sha <hex>) --repo owner/name");
      process.exit(0);
    } else {
      die(`unknown arg: ${arg}`, 2);
    }
  }
  if (out.pr === null && out.sha === null) die("either --pr or --sha is required", 2);
  if (out.pr !== null && (!Number.isInteger(out.pr) || out.pr <= 0)) {
    die("--pr must be a positive integer", 2);
  }
  if (out.sha !== null && !/^[0-9a-f]{7,64}$/i.test(out.sha)) {
    die("--sha must be 7-64 hex chars", 2);
  }
  if (out.repo === null || !/^[^/\s]+\/[^/\s]+$/.test(out.repo)) {
    die("--repo owner/name is required for x402 public-repo reviews", 2);
  }
  return out;
}

function makeClient(privateKey) {
  const account = privateKeyToAccount(privateKey);
  const publicClient = createPublicClient({
    chain: base,
    transport: http(process.env.BASE_RPC_URL ?? "https://mainnet.base.org"),
  });
  const core = new x402Client();
  registerExactEvmScheme(core, {
    signer: toClientEvmSigner(account, publicClient),
    networks: ["eip155:8453"],
    schemeOptions: {
      [base.id]: {
        rpcUrl: process.env.BASE_RPC_URL ?? "https://mainnet.base.org",
        authorizationWindowSeconds: 600,
      },
    },
  });
  return new x402HTTPClient(core);
}

async function postPaid(httpClient, apiBase, aeonContext, args) {
  const body = { target: { repo: args.repo } };
  if (args.pr !== null) body.target.pr = args.pr;
  if (args.sha !== null) body.target.sha = args.sha;

  const res = await httpClient.fetch(`${apiBase}/api/v1/review/x402`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-aeon-context": aeonContext,
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body: json };
}

async function poll(apiBase, jobId) {
  const start = Date.now();
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    const res = await fetch(`${apiBase}/api/v1/review/x402/${jobId}`);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, status: res.status, body: json };
    if (json.status === "complete") return { ok: true, status: res.status, body: json };
    if (json.status === "failed" || json.status === "expired") {
      return { ok: false, status: res.status, body: json, jobFailed: true };
    }
    console.error(`[antfleet:x402] ${json.status} · ${Math.round((Date.now() - start) / 1000)}s`);
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  return {
    ok: false,
    status: 0,
    body: { error: { code: "poll_timeout", message: "polling timed out after 10 minutes" } },
  };
}

function renderMarkdown({ payload, args, apiBase }) {
  const result = payload.result ?? payload;
  const findings = Array.isArray(result.findings) ? result.findings : [];
  const reviewId = result.reviewId ?? result.review_id ?? payload.reviewId ?? "";
  const receipt = result.receipt_url
    ? `${apiBase}${result.receipt_url}`
    : `${apiBase}/receipts/review/${reviewId}`;
  const sha = result.commitSha ?? result.sha ?? args.sha ?? "";
  const lines = [
    "# AntFleet PR review",
    "",
    `**Target:** ${args.repo} · PR #${result.prNumber ?? result.pr_number ?? args.pr ?? "?"} · sha \`${String(sha).slice(0, 12)}\``,
    `**Paid via:** x402`,
    `**Cached:** ${result.cached === true ? "yes (no new payment)" : "no (fresh review)"}`,
    `**Findings:** ${findings.length}`,
    `**Receipt:** ${receipt}`,
    "",
    "---",
    "",
  ];
  if (findings.length === 0) {
    lines.push("No findings — clean review.", "");
    return lines.join("\n");
  }
  findings.forEach((finding, index) => {
    lines.push(`## ${index + 1}. ${finding.title ?? "(untitled)"}`, "");
    lines.push(`**severity:** ${finding.severity ?? "unknown"} · **category:** ${finding.category ?? "unknown"}`, "");
    if (finding.reasoning) lines.push(String(finding.reasoning), "");
    if (finding.recommendation) lines.push("**Recommendation:**", "", String(finding.recommendation), "");
  });
  return lines.join("\n");
}

function renderError({ status, body, args, apiBase }) {
  const code = body?.error?.code ?? body?.failureMode ?? "unknown_error";
  const message = body?.error?.message ?? body?.failureMessage ?? "Review failed";
  return [
    "# AntFleet PR review — failed",
    "",
    `**Target:** ${args.repo} · PR #${args.pr ?? "—"} · sha \`${args.sha ?? "—"}\``,
    `**Paid via:** x402`,
    `**Status:** ${status} \`${code}\``,
    `**Message:** ${message}`,
    `**API base:** ${apiBase}`,
    "",
  ].join("\n");
}

async function writeOutput(path, markdown) {
  const abs = resolve(process.cwd(), path);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, markdown, "utf8");
  console.error(`[antfleet:x402] wrote ${path}`);
}

async function maybeNotify(markdown) {
  if (!process.env.ALERT_CHANNEL) return;
  if (!/\*\*severity:\*\* (critical|high)\b/i.test(markdown)) return;
  try {
    const { spawn } = await import("node:child_process");
    const child = spawn("./notify", [process.env.ALERT_CHANNEL, "AntFleet x402 review found high-severity issue"], {
      stdio: "ignore",
      detached: true,
    });
    child.unref();
  } catch {
    // Notification is best effort; the review output remains authoritative.
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const apiBase = (process.env.ANTFLEET_API_BASE ?? DEFAULT_API_BASE).replace(/\/$/, "");
  const outputPath = process.env.ANTFLEET_OUTPUT_PATH ?? DEFAULT_OUTPUT_PATH;
  const privateKey = requireEnv("AEON_X402_WALLET_PRIVATE_KEY");
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    die("AEON_X402_WALLET_PRIVATE_KEY must be a 0x-prefixed 32-byte key", 2);
  }
  const aeonContext = requireEnv("AEON_CONTEXT_TOKEN");
  const httpClient = makeClient(privateKey);

  const submitted = await postPaid(httpClient, apiBase, aeonContext, args);
  if (!submitted.ok || !submitted.body.jobId) {
    await writeOutput(outputPath, renderError({ status: submitted.status, body: submitted.body, args, apiBase }));
    die(`submit failed ${submitted.status}`, submitted.status >= 500 ? 3 : 2);
  }

  console.error(`[antfleet:x402] queued · job ${submitted.body.jobId}`);
  const final = await poll(apiBase, submitted.body.jobId);
  if (!final.ok) {
    await writeOutput(outputPath, renderError({ status: final.status, body: final.body, args, apiBase }));
    die(`review failed ${final.status}`, final.status >= 500 || final.status === 0 ? 3 : 2);
  }

  const markdown = renderMarkdown({ payload: final.body, args, apiBase });
  await writeOutput(outputPath, markdown);
  await maybeNotify(markdown);
}

main().catch(async (err) => {
  console.error(`[antfleet:x402] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(3);
});
