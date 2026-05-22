// Shared client module — exposes the three functions the AntFleet
// on-demand review flow needs, in a form that any non-Aeon consumer
// (an npm import, a custom GitHub Action, a CLI tool) can reuse
// without dragging in the SKILL.md / aeon.yml machinery.
//
// Note: Aeon's `./add-skill` ONLY copies the per-skill folder (the one
// containing SKILL.md) into the user's Aeon project — this top-level
// `client/` directory is NOT bundled at install time. The skill's
// `run.mjs` is intentionally self-contained for that reason. This file
// is the parallel surface for non-Aeon callers.

import { privateKeyToAccount } from "viem/accounts";

const DEFAULT_API_BASE = "https://www.antfleet.dev";

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
 *
 * @param {object} args
 * @param {string} args.installationId UUID of the installation row.
 * @param {string} [args.apiBase] override the API base URL.
 * @returns {Promise<{challenge_id: string, challenge: string, installation_id: string, issued_at: string, expires_at: string}>}
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
 * Sign a challenge string with the bound wallet's private key
 * (EIP-191 personal_sign). The recovered address must match the
 * wallet bound at /bind for the install — server-side check.
 *
 * @param {object} args
 * @param {string} args.privateKey 0x-prefixed 64-hex private key.
 * @param {string} args.challenge the challenge string returned by mintChallenge.
 * @returns {Promise<string>} 0x... 130-hex signature.
 */
export async function signChallenge({ privateKey, challenge }) {
  const pk = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
  const account = privateKeyToAccount(pk);
  return account.signMessage({ message: challenge });
}

/**
 * Submit the signed review trigger. Returns the parsed response body
 * on success; throws AntfleetReviewError on any 4xx/5xx with code+body
 * attached so callers can branch on error types (e.g. retry on
 * `review_in_progress` 503, top up on `insufficient_channel_balance` 402).
 *
 * @param {object} args
 * @param {string} args.installationId
 * @param {string} args.challengeId
 * @param {string} args.signature
 * @param {number} [args.prNumber]
 * @param {string} [args.sha]
 * @param {string} [args.repo] owner/name override (required only for
 *                             multi-repo installs).
 * @param {string} [args.apiBase]
 * @returns {Promise<object>} the success body (findings, receipt, channel).
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
 * Convenience: mint + sign + submit in one call. Returns the
 * submitReview response. Useful for non-Aeon callers who want a
 * one-liner.
 *
 * Validates inputs locally BEFORE minting the server-side nonce so a
 * caller bug doesn't burn a single-use challenge just to surface a
 * 400 at the submit step.
 */
export async function triggerReview({ installationId, privateKey, prNumber, sha, repo, apiBase }) {
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
  return submitReview({
    installationId,
    challengeId: challenge.challenge_id,
    signature,
    prNumber,
    sha,
    repo,
    apiBase,
  });
}
