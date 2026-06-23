# phewsh

Turn intent into action. Structure your thinking, execute your next step.

## Install

```bash
curl -fsSL https://phewsh.com/install.sh | sh
```

No sudo, nvm-aware. (Prefer a package manager? `npm install -g phewsh` —
same artifact, built from this repo.)

Then let it improve the AI tools you already have — without launching anything:

```bash
phewsh ambient on    # your .intent/ + a verified brief reach Claude Code, Codex,
                     # Gemini, Cursor at the start of every session (reversible)
```

phewsh isn't just a CLI — `ambient` makes every supported tool start aligned to
what you're building. What it reads, writes, and sends is documented, factually,
in [SECURITY.md](./SECURITY.md). It's local-first and MIT; this repo is an exact
mirror of the published npm package.

## Quick Start

```bash
phewsh status       # Project · Next · Work · Record at a glance
phewsh next add "ship the feature"
phewsh next criteria 1 file dist/app.js
phewsh next start 1
phewsh codex        # verified brief → native tool → automatic postflight
```

## No API key needed

phewsh is not another agent — it's the layer that uses the ones you already
have. If Claude Code, Codex CLI, Gemini CLI, Cursor Agent, or OpenCode is
installed, phewsh runs through it on **its own login** (your Claude
subscription, ChatGPT plan, Google account):

```bash
phewsh ai run "what should I build next?"     # auto-uses an installed agent CLI
phewsh ai run -p codex "..."                  # pin one explicitly
phewsh ai providers                           # see what's installed
```

API keys (OpenRouter, Anthropic, Groq, …) and PHEWSH pooled credits remain
available as alternatives — `phewsh login --set-key`.

## One package, one system

Everything ships in `phewsh` — the CLI (intent authoring, sync, bridges,
receipts, dispatch) *and* the MCP server. `phewsh mcp setup` wires the
bundled server into Claude Code / Cursor / any MCP client via
`phewsh mcp serve --stdio`: an *interactive* agent session gets your
project's briefing, task queue, and enforcement gate over stdio, and shares
state with the bridges (`~/.phewsh/`). No second install.

Rule of thumb: `phewsh serve` = dispatch tasks *to* your agents.
`phewsh mcp setup` = your agents pull tasks *from* PHEWSH mid-session.

## Ambient — continuity without launching phewsh

```bash
phewsh ambient on
```

A consent screen shows exactly what changes. Phewsh then keeps one canonical
generated core aligned across `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, and
`.cursorrules`, while preserving human-authored content outside its managed
blocks. Claude Code also receives a session-start brief and leaves a one-line
metadata breadcrumb (never transcript contents) in
`~/.phewsh/ambient-sessions.jsonl`. `phewsh ambient status` shows the ledger;
`phewsh ambient off` removes Phewsh-managed blocks without deleting your notes.

## Live Execution

Connect the web app to your local machine for real-time task execution:

```bash
phewsh serve
```

This starts a bridge on `localhost:7483`. Open [phewsh.com/intent](https://phewsh.com/intent) and go to the Work tab — you'll see a green "Live" indicator. Agent tasks get a "Run Live" button that executes on your machine through whichever agent CLIs you have installed: **Claude Code, Codex, Gemini, Cursor Agent, OpenCode**. PHEWSH detects them automatically and every run leaves a receipt (`phewsh receipts`).

## Interactive Shell

```bash
phewsh
```

Inside the shell:

```
/init       Create .intent/ artifacts
/clarify    AI-assisted artifact generation
/push       Sync local to cloud
/pull       Sync cloud to local
/context    View loaded artifacts
/help       All commands
```

The prompt includes a compact status rail with the current folder, route,
loaded `.intent/` files, and approximate context size. Multi-line pastes and
single-line pastes of 300+ characters collapse after submission:

```text
[pasted 1,284 chars · 12 lines · Ctrl+O to expand]
```

Press `Ctrl+O` to inspect the last submitted paste and `Esc` to clear input or
cancel an in-flight provider turn.

## The four answers

Phewsh keeps the same four answers available to you and every harness:

- **Project** — what you are building and why (`.intent/`)
- **Next** — the current task and accepted success criteria (`.intent/next.json`)
- **Work** — the active native session and evidence-backed verification view
- **Record** — what happened, what was kept, and what was learned

The lifecycle is explicit: intent → criteria → verified brief → native tool →
observed evidence → verdict → approved reconciliation → every other tool
inherits the updated truth.

## All Commands

```bash
phewsh                    # The front door — routes through your installed agents
phewsh setup              # Guided setup: pick your default route (60 seconds)
phewsh status             # Git status for AI continuity
phewsh next               # Queue work and define success criteria
phewsh work               # Current work + verification + human review
phewsh truth              # Read-only source-of-truth audit
phewsh brief              # Verified state + accepted work contract
phewsh watch              # Sync native harness files + optional cloud mirror
phewsh ambient on         # Automatic cross-tool continuity, with consent
phewsh outcomes           # Decision record — what was kept, reverted, or failed
phewsh serve              # Live execution bridge for web app
phewsh clarify            # AI-assisted artifact generation
phewsh intent --init      # Create .intent/ without entering the shell
phewsh intent --status    # Check artifact state
phewsh ai run "prompt"    # One-shot AI with .intent/ context
phewsh login              # Authenticate + set API key
phewsh push               # Sync local .intent/ to cloud
phewsh pull               # Sync cloud to local
phewsh mcp setup          # Configure MCP server for agent connectivity
phewsh mcp serve          # Coordination bridge — route work to live agents
phewsh receipts           # Proof trail — what agents actually did, with evidence
phewsh update             # Update phewsh to the latest version
phewsh style              # Build your style identity
```

## Receipts

Every task that runs through PHEWSH leaves evidence on your machine —
sessions, results, blockers, gate checks, spend — in `~/.phewsh/`. See it:

```bash
phewsh receipts           # merged timeline, newest first
phewsh receipts --json    # machine-readable, for agents and scripts
```

The same trail is visible at [phewsh.com/intent/receipts](https://phewsh.com/intent/receipts)
while a local bridge is running (`phewsh serve` or `phewsh mcp serve` — the
first executes tasks directly via Claude Code, the second routes them to
live connected agents; both record identical receipts).

## Outcomes

A receipt says *what ran*. An outcome says *what became of it*. Every routed
action in a session records a decision; label it when you actually know —
seconds later or three weeks later:

```bash
# in a session, right after a response: type 1-4
# 1 kept · 2 reverted · 3 superseded · 4 failed

phewsh outcomes           # totals, kept-rate by route and mode, recent decisions
phewsh outcomes label     # label anything still pending
```

Over time this becomes the record no platform keeps for you: which decisions
held up, which model is most reliable for which kind of work, and where your
effort actually went.

## Sync

CLI and web ([phewsh.com/intent](https://phewsh.com/intent)) share the same cloud via Supabase.

```bash
phewsh login        # authenticate
phewsh push         # upload .intent/ to cloud
phewsh pull         # download from cloud
```

Cloud sync is manual. Local harness projections self-heal automatically from
the same canonical `.intent/` source.

## Web app

[phewsh.com/intent](https://phewsh.com/intent)

## License

MIT
