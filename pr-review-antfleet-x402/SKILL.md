---
name: AntFleet PR review (x402)
category: dev
description: Pull-mode two-model-consensus PR review via x402. Pay-per-call USDC on Base, no AntFleet installation required. Public repos only. v1 access restricted to aeon-ecosystem callers.
var: "TARGET"
tags: [dev, code-review, antfleet, base, x402, public]
---

> **${var}** - the review target. Either `PR=<number>` or `SHA=<hex>`.
> Append `;REPO=owner/name`; the x402 variant requires an explicit public repo.

## What this skill does

Calls AntFleet's public-repo x402 endpoint:

- `POST /api/v1/review/x402`
- `GET /api/v1/review/x402/{jobId}`

The runner performs the x402 402 -> sign -> retry flow, polls every 10
seconds for up to 10 minutes, and writes a markdown report to
`.outputs/pr-review-antfleet-x402.md`.

This skill does not require `antfleet[bot]`, an AntFleet installation row,
or a prepaid channel. It is public-repo only and v1 access is restricted
to aeon-ecosystem callers via `X-Aeon-Context`.

## Required env vars

- `AEON_X402_WALLET_PRIVATE_KEY` - paying wallet private key, 0x-prefixed.
- `AEON_CONTEXT_TOKEN` - value sent as `X-Aeon-Context`.

## Optional env vars

- `ANTFLEET_API_BASE` - default `https://www.antfleet.dev`.
- `ANTFLEET_OUTPUT_PATH` - default `.outputs/pr-review-antfleet-x402.md`.
- `ALERT_CHANNEL` - if set and a finding is critical/high, call `./notify`.

## Not required

- `ANTFLEET_INSTALLATION_ID`
- `ANTFLEET_WALLET_PRIVATE_KEY`

## What to do

Read `${var}`. If empty, log `ANTFLEET_NO_TARGET` and exit.

Parse the target:

- `PR=<number>;REPO=owner/name`
- `SHA=<hex>;REPO=owner/name`

Then invoke:

```bash
cd skills/pr-review-antfleet-x402
node run.mjs --pr "$PR_NUMBER" --repo "$REPO"
# or
node run.mjs --sha "$SHA" --repo "$REPO"
```

The runner sets an EIP-3009 authorization window of `validAfter=now`
and `validBefore=now+600s`. Exit codes:

- `0` - review completed and output was written.
- `2` - permanent failure, such as bad target or terminal failed job.
- `3` - transient failure, such as network, poll timeout, or 5xx.

Output includes `**Paid via:** x402`, a review-level receipt URL, and no
`**PR comment:**` line because the public-repo x402 path has no GitHub
App permission to post comments.
