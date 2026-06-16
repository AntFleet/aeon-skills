---
name: AntFleet PR review
category: dev
description: Trigger a real two-model-consensus PR review on a specific PR or SHA via AntFleet, debiting the install's USDC channel on Base. Writes the finding to .outputs/pr-review-antfleet.md.
var: "TARGET"
tags: [dev, code-review, antfleet, base, x402]
---

> **${var}** — the review target. Either `PR=<number>` (e.g. `PR=42`) or `SHA=<hex>` (e.g. `SHA=deadbeef…`). Optionally append `;REPO=owner/name` if the installation covers multiple repos and you need to disambiguate. If `${var}` is empty, this skill no-ops with a clear message.

## What this skill does

Calls AntFleet's on-demand review endpoint
(`POST /api/v1/installations/{id}/review`) for the target PR. The API
returns 202 + a job ID immediately; the skill polls
`GET .../review/{jobId}` every 10 seconds until the two-model consensus
(Opus 4.7 + GPT-5) completes. Writes a human-readable report to
`.outputs/pr-review-antfleet.md`.

The same channel that pays for the GitHub App's automatic on-PR-open
reviews pays for this on-demand trigger — same price (`REVIEW_PRICE_USDC`,
default $0.50), same finding pipeline, same receipt flow. No new
payment surface.

## Prerequisites (one-time, per installation)

The operator must complete the AntFleet onboarding flow before this skill
can run:

1. Install `antfleet[bot]` on the target GitHub repo at
   <https://github.com/apps/antfleet>.
2. Create a wallet-bound installation row via the AntFleet dashboard
   or `POST /api/v1/installations`.
3. Sign the binding challenge with the same wallet and submit to
   `POST /api/v1/installations/{id}/bind`.
4. Send USDC on Base to the deposit address shown in the dashboard —
   the channel auto-credits and status flips to `active`.
5. Install Node.js 20+ deps inside this skill folder:
   ```bash
   cd skills/pr-review-antfleet
   npm install
   ```
   (One-time. Adds `viem` for EIP-191 signing.)

## Required env vars

The operator sets these in the GitHub Actions secrets (or via `aeon.yml`
`vars` block) on the Aeon project:

- `ANTFLEET_INSTALLATION_ID` — the UUID of the installation row (visible in
  the AntFleet dashboard).
- `ANTFLEET_WALLET_PRIVATE_KEY` — the bound wallet's private key (0x-prefixed
  64 hex chars). Only authorizes review triggers on this install; cannot
  move USDC out of the channel.
- `ANTFLEET_API_BASE` (optional) — default `https://www.antfleet.dev`.
- `ANTFLEET_OUTPUT_PATH` (optional) — default `.outputs/pr-review-antfleet.md`.

## What to do

Read `${var}`. If empty, log `ANTFLEET_NO_TARGET` to `memory/logs/${today}.md`
and exit.

Otherwise, parse the target spec:

- If `${var}` matches `PR=<number>` (optionally with `;REPO=...`), set
  `PR_NUMBER` and `REPO` accordingly.
- If `${var}` matches `SHA=<hex>` (optionally with `;REPO=...`), set
  `SHA` and `REPO`.
- Anything else: log `ANTFLEET_BAD_TARGET` with the literal value, exit.

Then invoke the runner from this skill folder:

```bash
cd skills/pr-review-antfleet
node run.mjs --pr "$PR_NUMBER" ${REPO:+--repo "$REPO"}
# or, for sha-only:
node run.mjs --sha "$SHA" ${REPO:+--repo "$REPO"}
```

The runner does the full four-step async protocol:

1. Mints a fresh single-use challenge from the API.
2. Signs the challenge string with `ANTFLEET_WALLET_PRIVATE_KEY` using
   EIP-191 personal_sign (via `viem`).
3. Submits the signed review request → receives 202 + `jobId`.
4. Polls `GET .../review/{jobId}` every 10s (up to 10 min) until
   the job reaches `complete` or `failed`, then writes the result to
   `${ANTFLEET_OUTPUT_PATH:-.outputs/pr-review-antfleet.md}`.

Stderr shows live progress: `[antfleet] queued · job <id>`,
`[antfleet] running · 45s elapsed`, `[antfleet] complete · 3 finding(s)`.

Exit codes:

- `0` — success (review completed, finding or no-finding written).
- `2` — permanent failure (4xx from API, or job failed with a
  non-retryable error like bad PR number). Error details are in the
  output file; do NOT retry blindly.
- `3` — transient error (network, poll timeout, 5xx). Safe to retry
  once after a short backoff.

After the runner completes, read `.outputs/pr-review-antfleet.md`
(or `$ANTFLEET_OUTPUT_PATH`) and summarize in `memory/logs/${today}.md`
under `### pr-review-antfleet`:

- For success: "Reviewed `owner/repo#PR_NUMBER` at sha `<short_sha>` —
  N finding(s), debited X USDC (or cached: no debit)."
- For 4xx: "Failed `owner/repo#PR_NUMBER` — `<error_code>`: `<message>`."
- For 3xx/5xx/network: "Errored — `<message>`. Will retry on next run."

If `${ALERT_CHANNEL}` is set and the review surfaced any finding with
severity `critical` or `high`, fire `./notify` with a one-line summary
(title, severity, file:line) and a link to the receipt URL.

## Idempotency

The POST endpoint accepts an optional `idempotency_key` parameter. When
set, re-submitting with the same key returns the existing job without
creating a new one or debiting again. Even without the key, the same
(installation, SHA) pair is cached — polling a completed job returns
`status: "complete"` with the prior finding and no re-debit.

## Output sample

```markdown
# AntFleet PR review

**Target:** acme/demo · PR #42 · sha `deadbeef1234`
**Cached:** no (fresh review) · **Findings:** 2
**Channel:** debited 0.500000 USDC · remaining 4.500000 USDC
**PR comment:** https://github.com/acme/demo/pull/42#issuecomment-...
**Receipt:** https://www.antfleet.dev/receipts/<review_id>

---

## 1. Off-by-one in date math

**severity:** high · **category:** bug · **confidence:** high

**Evidence:**

- `src/date.ts:L12-L14`

**Why it matters:**

The increment runs before the boundary check, allowing dates one day
past the configured maximum.

**Recommendation:**

Move the boundary check above the increment, or use a single
`Math.min(target, max)` clamp.
```

## Naming

This skill is **AntFleet PR review**. It is NOT "Patch Agent" or
"Patch Bot" — those are different AntFleet products (Patch Agent
suggests inline diffs alongside findings; it ships its own surface).
