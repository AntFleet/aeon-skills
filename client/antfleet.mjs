// Shared client module (v2.0) — async polling contract.
//
// POST returns 202 + jobId; poll GET until complete/failed.
// Any non-Aeon consumer (npm import, GitHub Action, CLI tool) can
// reuse this without the SKILL.md / aeon.yml machinery.
//
// Note: Aeon's `./add-skill` ONLY copies the per-skill folder (the one
// containing SKILL.md) into the user's Aeon project — this top-level
// `client/` directory is NOT bundled at install time. The skill's
// `run.mjs` is intentionally self-contained for that reason. This file
// is the parallel surface for non-Aeon callers.

import { privateKeyToAccount } from "viem/accounts";

const DEFAULT_API_BASE = "https://www.antfleet.dev";
const DEFAULT_POLL_INTERVAL_MS = 10_000;
const DEFAULT_POLL_TIMEOUT_MS = 10 * 60 * 1000;

export class AntfleetReviewError extends Error {
  constructor(message, { status, code, body } = {}) {
    super(message);
    this.name = "AntfleetReviewError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

function normalizeBase(apiBase) {
  return (apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, "");
}

/**
 * Mint a single-use challenge for the given installation.
 */
export async function mintChallenge({ installationId, apiBase }) {
  const url = `${normalizeBase(apiBase)}/api/v1/installations/${installationId}/review/challenge`;
  const res = await fetch(url, { method: "POST" });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new AntfleetReviewError("challenge mint failed", {
      status: res.status,
      code: body?.error?.code,
      body,
    });
  }
  return body;
}

/**
 * Sign a challenge string with the bound wallet's private key (EIP-191).
 */
export async function signChallenge({ privateKey, challenge }) {
  const pk = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
  const account = privateKeyToAccount(pk);
  return account.signMessage({ message: challenge });
}

/**
 * Submit the signed review trigger. Returns { jobId, statusUrl }.
 * POST now returns 202 (async). Use pollJob() to wait for the result.
 */
export async function submitReview({
  installationId,
  challengeId,
  signature,
  prNumber,
  sha,
  repo,
  apiBase,
}) {
  if (prNumber === undefined && sha === undefined) {
    throw new AntfleetReviewError("either prNumber or sha is required");
  }
  const url = `${normalizeBase(apiBase)}/api/v1/installations/${installationId}/review`;
  const body = { challenge_id: challengeId, signature };
  if (prNumber !== undefined) body.pr_number = prNumber;
  if (sha !== undefined) body.sha = sha;
  if (repo !== undefined) body.repo = repo;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = await res.json().catch(() => null);
  if (!res.ok) {
    throw new AntfleetReviewError(parsed?.error?.message ?? `review failed: ${res.status}`, {
      status: res.status,
      code: parsed?.error?.code,
      body: parsed,
    });
  }
  return parsed;
}

/**
 * Poll a job until it reaches a terminal state (complete or failed).
 * Returns the final poll response body.
 *
 * @param {object} args
 * @param {string} args.installationId
 * @param {string} args.jobId
 * @param {string} args.challengeId   — same challenge used for POST
 * @param {string} args.signature     — same signature used for POST
 * @param {string} [args.apiBase]
 * @param {number} [args.pollIntervalMs]  default 10s
 * @param {number} [args.pollTimeoutMs]   default 10min
 * @param {function} [args.onPoll]  callback(status, elapsedMs) on each tick
 * @returns {Promise<object>}
 */
export async function pollJob({
  installationId,
  jobId,
  challengeId,
  signature,
  apiBase,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  pollTimeoutMs = DEFAULT_POLL_TIMEOUT_MS,
  onPoll,
}) {
  const base = `${normalizeBase(apiBase)}/api/v1/installations/${installationId}/review/${jobId}`;
  const url = `${base}?challenge_id=${encodeURIComponent(challengeId)}&signature=${encodeURIComponent(signature)}`;
  const t0 = Date.now();

  while (Date.now() - t0 < pollTimeoutMs) {
    const res = await fetch(url);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new AntfleetReviewError(json?.error?.message ?? `poll failed: ${res.status}`, {
        status: res.status,
        code: json?.error?.code,
        body: json,
      });
    }

    const elapsed = Date.now() - t0;
    if (onPoll) onPoll(json.status, elapsed);

    if (json.status === "complete") return json;
    if (json.status === "failed" || json.status === "expired") {
      throw new AntfleetReviewError(json.failureMessage ?? `job ${json.status}`, {
        status: res.status,
        code: json.failureMode ?? json.status,
        body: json,
      });
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  throw new AntfleetReviewError("polling timed out", { code: "poll_timeout" });
}

/**
 * Convenience: mint + sign + submit + poll in one call.
 * Returns the completed review result.
 */
export async function triggerReview({
  installationId,
  privateKey,
  prNumber,
  sha,
  repo,
  apiBase,
  pollIntervalMs,
  pollTimeoutMs,
  onPoll,
}) {
  if (prNumber === undefined && sha === undefined) {
    throw new AntfleetReviewError("either prNumber or sha is required");
  }
  if (prNumber !== undefined && !(Number.isInteger(prNumber) && prNumber > 0)) {
    throw new AntfleetReviewError("prNumber must be a positive integer");
  }
  if (sha !== undefined && !/^[0-9a-f]{7,64}$/i.test(sha)) {
    throw new AntfleetReviewError("sha must be 7-64 hex chars");
  }
  if (repo !== undefined && !/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    throw new AntfleetReviewError("repo must be owner/name");
  }
  const challenge = await mintChallenge({ installationId, apiBase });
  const signature = await signChallenge({ privateKey, challenge: challenge.challenge });
  const submitted = await submitReview({
    installationId,
    challengeId: challenge.challenge_id,
    signature,
    prNumber,
    sha,
    repo,
    apiBase,
  });
  return pollJob({
    installationId,
    jobId: submitted.jobId,
    challengeId: challenge.challenge_id,
    signature,
    apiBase,
    pollIntervalMs,
    pollTimeoutMs,
    onPoll,
  });
}
