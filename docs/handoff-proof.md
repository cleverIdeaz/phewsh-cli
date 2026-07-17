# Reproduce the Claude Code → Codex handoff proof

This public fixture proves one narrow claim: **before Codex produces any model
output, Phewsh can write a local handoff receipt and re-check the recorded
project state against the destination checkout.** It does not claim that a
Claude transcript, hidden reasoning, or model memory moved to Codex.

## Run it

```bash
git clone https://github.com/cleverIdeaz/phewsh-cli.git
cd phewsh-cli
node --test test/public-handoff-proof.test.js
```

The test consumes [`handoff-proof-fixture.json`](./handoff-proof-fixture.json),
creates its exact `.intent/` files and dirty working path in a temporary Git
repository, writes the exact saved brief, creates a Claude Code → Codex receipt,
and asks the real receipt verifier to inspect the unchanged checkout.

The proof passes only when:

- the receipt exists before any destination-model call;
- its source, destination, trigger, `.intent/` paths, dirty path, Git HEAD, and
  exact brief fingerprint match the fixture;
- pickup returns `verified` from the real verifier;
- the receipt explicitly lists conversation transcript, model reasoning,
  editor buffers, harness-local memory, and unrecorded decisions as not carried;
- the failed Claude attempt remains outside the receipt rather than being
  counterfeited as portable context.

Hashes and temporary Git commit identifiers vary on each run. The semantic
inputs and assertions do not. Receipt hashes detect change; they are not
signatures or proof of authorship.

## What this does not prove

This fixture does not call Claude Code or Codex, grade either model, verify a
production npm artifact, or demonstrate Ion's two-person workflow. Those are
separate boundaries. The fixture isolates the continuity claim so anyone can
falsify it without an AI subscription or cloud account.
