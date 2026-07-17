# phewsh

**The next AI starts from your files.**

PHEWSH is the continuity layer for AI-assisted work: it turns what you're
building into durable project intent (`.intent/`) and carries it across
Claude Code, Codex, Cursor, Gemini, your terminal, and your team — so the
next AI can see what was recorded — and what was not.

## Install

```bash
curl -fsSL https://phewsh.com/install.sh | sh
```

The installer never runs npm with sudo and is nvm-aware. If an older Phewsh
install is root-owned, it discloses and requests one `sudo chown` repair first.
(Prefer a package manager? `npm install -g phewsh` installs the same npm package.)

Then let it improve the AI tools you already have — without launching anything:

```bash
phewsh ambient on    # one open intent skill + your verified .intent/ brief reach
                     # Claude Code, Codex, Gemini, Cursor (reversible)
```

A bare first launch keeps adapters off. `ambient on` enumerates every file it
may write before asking; choosing No changes only Phewsh's local opt-out receipt.

phewsh isn't just a CLI — `ambient` makes every supported tool start aligned to
what you're building. What it reads, writes, and sends is documented, factually,
in [SECURITY.md](./SECURITY.md), the [threat model](./docs/threat-model.md), and
the [release checklist](./docs/release-checklist.md). It's local-first and MIT;
the public source snapshot is manually synchronized today, without release
provenance yet.

`phewsh init` creates only the tool-neutral `.intent/` project record. Ambient
installs the same open `intent` skill at user scope for Codex
(`~/.agents/skills/intent/`) and Claude Code (`~/.claude/skills/intent/`), so
projects stay clean and neither harness becomes the source of truth.
If a repository already contains `.agents/skills/intent/` or
`.claude/skills/intent/`, that user-owned project override may take precedence.
Phewsh reports it through `status` and `ambient status` but never edits or
removes it; `.intent/` remains the project truth.

## Quick Start

```bash
phewsh status       # Project · Next · Work · Record at a glance
phewsh next add "ship the feature"
phewsh next criteria 1 file dist/app.js
phewsh next start 1
phewsh codex        # verified brief → native tool → automatic postflight
```

Every native handoff now leaves an integrity-checksummed local receipt. The next tool sees the
exact `.intent/` and repository state that crossed the boundary, plus an
explicit list of what did not: transcripts, model reasoning, editor buffers,
harness-local memory, and unrecorded decisions. `phewsh status` re-hashes the
current state and says **verified**, **moved**, **partial**, or **invalid**
instead of silently claiming continuity. Dirty evidence means Git tracked,
staged, and untracked-unignored files; ignored files are never hashed or named.

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

## One package, modular adapters

The package includes the CLI plus optional native skills, hooks, projections,
MCP capabilities, and bridges. They all adapt tools around `.intent/`; none is
a second project record.

`phewsh mcp setup` adds the bundled stdio adapter to a supported client. That
client can receive bounded Project, Next, constraints, and task capabilities.
MCP access does not claim work, transfer private model memory, or grant remote
execution authority.

Rule of thumb: `phewsh serve` is the same-machine, project-bound worker used
after a human claim. `phewsh mcp setup` lets a configured client read and report
through bounded capabilities during its own session.

## Ambient — continuity without launching phewsh

```bash
phewsh ambient on
```

A consent screen shows exactly what changes. The layers stay independent:

- one byte-identical open Intent skill installs natively for Claude Code and Codex;
- generated blocks align `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, and
  `.cursorrules` while preserving human-authored content;
- Claude Code session hooks add a bounded start brief and a metadata-only end
  breadcrumb; safety/receipt hooks for Claude and Codex are controlled by the
  separate `phewsh gate enforce on|off|status` toggle.

`phewsh ambient status` reports those layers separately. `phewsh ambient off`
removes only unchanged Phewsh-managed additions and preserves user-owned skills,
hooks, and notes. It does not disable the independent safety/receipt layer.

## Ion — work with people and agents

[Phewsh Ion](https://phewsh.com/ion) is the shared project room. A person
requests work, a human deliberately claims it for a local agent, and the
branch, pull request, evidence, review, and accepted Record return to the same
room.

Make a repository available to **your own machine's** worker:

```bash
phewsh project add    # once inside each repo you explicitly allow
phewsh serve          # one loopback worker for the whole machine
phewsh ion doctor     # read-only two-person preflight
```

The bridge listens on `localhost:7483`. Registration does not execute work,
teammates cannot reach your localhost, and Ion does not grant remote execution
authority. Work begins only after a human clicks **Run on this machine** in
their browser or runs `phewsh ion claim <task-id>`. The claim runs in an
isolated Git worktree, opens a PR through your authenticated `gh`, and returns
bounded evidence to Ion; accepted work becomes project truth only through
normal review, merge, and Record reconciliation.

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

Phewsh records four answers that supported harness adapters can read:

- **Project** — what you are building and why (`.intent/`)
- **Next** — the current task and accepted success criteria (`.intent/next.json`)
- **Work** — the active native session and evidence-backed verification view
- **Record** — what happened, what was kept, and what was learned

The lifecycle is explicit: intent → criteria → verified brief → native tool →
observed evidence → verdict → approved reconciliation → supported adapters can
read the updated project record. Native transcripts and hidden tool memory do
not cross that boundary.

Want to falsify that claim without an AI subscription? Run the exact public
[Claude Code → Codex handoff fixture](./docs/handoff-proof.md). It writes the
receipt before any destination-model output and verifies the checkout using the
same receipt code as the CLI.

## All Commands

```bash
phewsh                    # The front door — routes through your installed agents
phewsh setup              # Guided setup: pick your default route (60 seconds)
phewsh status             # Git status for AI continuity
phewsh next               # Queue work and define success criteria
phewsh work               # Current work + verification + human review
phewsh truth              # Read-only source-of-truth audit
phewsh brief              # Verified state + accepted work contract
phewsh seq --write        # One-shot .intent/ refresh into all native project files
phewsh watch              # Deliberately running native refresh + optional cloud push
phewsh ambient on         # Preview + install reversible native adapters
phewsh outcomes           # Decision record — what was kept, reverted, or failed
phewsh serve              # Same-machine worker; human-initiated, project-bound claims
phewsh clarify            # AI-assisted artifact generation
phewsh intent --init      # Create .intent/ without entering the shell
phewsh intent --status    # Check artifact state
phewsh ai run "prompt"    # One-shot AI with .intent/ context
phewsh login              # Authenticate + set API key
phewsh push               # Sync local .intent/ to cloud
phewsh pull               # Sync cloud to local
phewsh mcp setup          # Configure the optional bounded MCP adapter
phewsh mcp serve          # Serve bounded capabilities over stdio/HTTP
phewsh receipts           # Proof trail — what agents actually did, with evidence
phewsh update             # Update phewsh to the latest version
phewsh style              # Build your style identity
```

## Receipts

Every task and native tool handoff that runs through PHEWSH leaves evidence on
your machine — sessions, results, blockers, gate checks, handoff receipts, spend
— in `~/.phewsh/`. See it:

```bash
phewsh receipts           # merged timeline, newest first
phewsh receipts --json    # machine-readable, for agents and scripts
```

The same trail is visible at [phewsh.com/intent/receipts](https://phewsh.com/intent/receipts)
only while this browser can reach a local bridge. `phewsh serve` supports the
same-machine manual-claim path; `phewsh mcp serve` exposes the optional adapter.
Neither makes a teammate's browser able to reach your localhost or grants
cross-machine execution authority.

Handoff receipts live in `~/.phewsh/handoffs/`. They contain paths and SHA-256
fingerprints, never file contents or transcripts. A hash detects corruption or
an unrecomputed edit; it is integrity evidence, not authenticated identity.

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

Cloud sync is never triggered by `init`, `ambient`, or `seq`. `phewsh push` is
the explicit one-shot upload. Deliberately starting `phewsh watch` opts into
automatic push while that process runs for a signed-in user; use
`phewsh watch --no-push` for local projections only. Local harness projections
self-heal from the same canonical `.intent/` source.

## Environment variables

All optional; phewsh needs no configuration to run. None of these hold secrets.

| Variable | Effect |
|---|---|
| `PHEWSH_DEBUG` | Verbose diagnostics for session handling |
| `PHEWSH_OFFLINE` | Skip network checks in the truth audit (`phewsh truth`) |
| `PHEWSH_WIDTH` | Override terminal width when the terminal misreports it |
| `PHEWSH_AUTOWORK` | Auto-run `/work` on session start (used by the `phewsh <harness>` shortcut) |
| `PHEWSH_MCP_PORT` / `PHEWSH_MCP_HOST` | Bind address for the local MCP HTTP bridge |
| `PHEWSH_ALLOWED_ORIGINS` | Extra CORS origins for the local serve bridge (loopback by default) |
| `PHEWSH_PROJECT_INDEX` | Override the path of the local project index |

## Web app

[phewsh.com/intent](https://phewsh.com/intent)

## Feedback

Something missing, confusing, or broken?

```bash
phewsh feedback "what you expected vs what happened"
```

That opens a prefilled public issue on this repo (only your words plus
version/OS/node — documented in [SECURITY.md](./SECURITY.md)). Private
channel: hello@phewsh.com.

## License

MIT
