# AntFleet skills for Aeon

**On-demand AI PR reviews for [Aeon](https://github.com/aaronjmars/aeon) agents — powered by [AntFleet](https://www.antfleet.dev) on Base.**

```bash
./add-skill antfleet/aeon-skills pr-review-antfleet
```

This skill pack ships:

- `pr-review-antfleet` → trigger a real two-model-consensus PR review
  (Opus 4.7 + GPT-5 agreement gate) against a specific PR or SHA. The
  finding lands in `.outputs/pr-review-antfleet.md` and the same channel
  that pays for AntFleet's automatic on-PR-open reviews pays for this
  on-demand trigger — $0.50 USDC per review on Base, billed to the
  installation's prefunded channel.

This is the pull-mode counterpart to AntFleet's GitHub App webhook
(push-mode, automatic on PR open). Use it when your agent needs a
review of a specific commit _right now_ during a session, not waiting
for the next push.

---

## Prerequisites — before this skill can run

You need a wallet-bound AntFleet installation on the target GitHub
repo, funded with USDC on Base. The full onboarding takes about 5
minutes:

### 1. Install the GitHub App

Open <https://github.com/apps/antfleet> and install `antfleet[bot]` on
the repos you want reviewed. Pick "All repositories" or "Selected
repositories" — both work.

### 2. Bind a wallet

Pick a Base wallet you'll use to fund reviews. Treat this as a
single-purpose wallet — the private key will live in CI secrets, so
don't reuse a wallet that holds significant assets elsewhere.

```bash
# Create the installation row
curl -sS -X POST https://www.antfleet.dev/api/v1/installations \
  -H 'content-type: application/json' \
  -d '{"wallet_address": "0xYOURWALLET"}'
# → {"installation_id": "<UUID>", "binding_challenge": "...", ...}
```

Sign the `binding_challenge` string with your wallet (EIP-191
personal_sign — most wallets and `viem`/`ethers` support it). Submit:

```bash
curl -sS -X POST https://www.antfleet.dev/api/v1/installations/<UUID>/bind \
  -H 'content-type: application/json' \
  -d '{"signature": "0x..."}'
# → status: "awaiting_deposit"
```

### 3. Fund the channel

Send USDC on Base to the deposit address shown by the AntFleet
dashboard (or by the bind-response `next_step` field). A scan-deposits
cron credits the channel every minute; once credited, the status flips
to `active` and the channel is ready to spend.

Default review price is $0.50 USDC — fund at least $1–5 for early
testing.

### 4. Install this skill into Aeon

From your Aeon project root:

```bash
./add-skill antfleet/aeon-skills pr-review-antfleet
```

Then install the skill's Node dep:

```bash
cd skills/pr-review-antfleet
npm install     # one-time, adds viem for EIP-191 signing
```

### 5. Configure env vars

Add three secrets to your Aeon project (GitHub Actions secrets, or the
`vars` block in `aeon.yml`):

| Name                          | Required | What                                                                                        |
| ----------------------------- | -------- | ------------------------------------------------------------------------------------------- |
| `ANTFLEET_INSTALLATION_ID`    | ✅       | UUID from step 2. Shown in the AntFleet dashboard.                                          |
| `ANTFLEET_WALLET_PRIVATE_KEY` | ✅       | 0x-prefixed private key of the wallet bound at step 2. **Security note below.**             |
| `ANTFLEET_API_BASE`           | optional | Defaults to `https://www.antfleet.dev`. Override only for testing against a preview deploy. |
| `ANTFLEET_OUTPUT_PATH`        | optional | Defaults to `.outputs/pr-review-antfleet.md`.                                               |

### Security of `ANTFLEET_WALLET_PRIVATE_KEY`

This key signs review-trigger challenges. **It cannot move USDC out of
the channel** — only spend channel funds on reviews at the
`REVIEW_PRICE_USDC` rate (default $0.50/call). The blast radius if
exposed is bounded to the channel balance.

That said: treat it like any other secret. Don't commit it. Don't paste
it in chat. Use a single-purpose wallet that you can rotate cheaply by
running steps 1–3 again with a fresh wallet.

---

## Use

Enable the skill in `aeon.yml`:

```yaml
skills:
  pr-review-antfleet:
    enabled: true
    var: "PR=42" # the target PR number on the install's bound repo
    # var: "SHA=deadbeef1234"        # alternative: review by head SHA
    # var: "PR=42;REPO=acme/demo"    # disambiguate when multi-repo install
```

Or invoke directly:

```bash
cd skills/pr-review-antfleet
ANTFLEET_INSTALLATION_ID=<uuid> \
ANTFLEET_WALLET_PRIVATE_KEY=0x... \
node run.mjs --pr 42
```

The runner does the full three-call protocol (mint challenge → sign →
submit) and writes the finding to `.outputs/pr-review-antfleet.md`. The
exit code is:

- `0` = success (finding(s) written, or "no agreed findings" if the
  two-model consensus produced no defects)
- `2` = server returned a 4xx; the output file has the error code and
  message. Common cases: `insufficient_channel_balance` (top up),
  `pr_not_open` (PR is closed/merged), `challenge_already_used` (re-run),
  `signature_mismatch` (wrong private key for this install).
- `3` = unexpected error (network, signing). Safe to retry.

### Idempotency

The endpoint caches by `(installation_id, sha)` permanently. Calling
again for the same SHA returns the prior finding with `cached: true`
and does NOT debit again. Push a new commit (new SHA) to get a fresh
review.

---

## Architecture

```
your-aeon-project/
└── skills/
    └── pr-review-antfleet/        ← copied here by ./add-skill
        ├── SKILL.md               ← instructions Aeon reads at run time
        ├── package.json           ← declares viem dep
        └── run.mjs                ← the three-call runner
```

The skill folder is self-contained — `run.mjs` imports `viem` from its
own `node_modules`, makes its own HTTP calls, writes its own output.
No shared runtime between this skill pack and the broader Aeon project.

### For non-Aeon callers

If you want to trigger reviews from a custom script (your own CI,
another agent framework, a CLI), use the parallel module at
`client/antfleet.mjs` directly:

```js
import { triggerReview } from "@antfleet/aeon-skills";

const result = await triggerReview({
  installationId: process.env.ANTFLEET_INSTALLATION_ID,
  privateKey: process.env.ANTFLEET_WALLET_PRIVATE_KEY,
  prNumber: 42,
  repo: "acme/demo",
});
console.log(`${result.findings.length} finding(s), cached=${result.cached}`);
```

This exposes `mintChallenge`, `signChallenge`, `submitReview`, and the
one-shot `triggerReview` helper. Same surface as `run.mjs`, more
ergonomic for programmatic use.

---

## Naming

This skill is **AntFleet PR review**. It is NOT _Patch Agent_ or _Patch
Bot_ — those are a different AntFleet product (Patch Agent suggests
inline diff fixes alongside findings; it ships its own surface and
isn't part of this skill pack).

---

## Reference

- [AntFleet docs / skill pack contract](https://github.com/antfleet/antfleet/blob/main/docs/aeon-skill-pack.md)
  — full endpoint contract, signature flow, error codes
- [AntFleet dashboard](https://www.antfleet.dev) — install lookup, channel balance, deposit address
- [Aeon framework](https://github.com/aaronjmars/aeon) — the agent runtime this skill is for
- [`add-skill` script](https://github.com/aaronjmars/aeon/blob/main/add-skill) — what installs this pack

## License

MIT.
