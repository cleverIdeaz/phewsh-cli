# Security & Data Flow — phewsh CLI

phewsh is a **local-first** tool. It runs on your machine, reads your project's
`.intent/` and your installed AI tools' config, and helps you carry context
between those tools. This document states — factually, traceable to source —
what it reads, writes, and sends. No vague claims; if something here is wrong,
it's a bug: **hello@phewsh.com**.

> Status: this is an honest self-documented inventory, **not** an independent
> audit. An external review and a public source repository are planned (see
> "Roadmap"). Until then, inspect the source you install: `npm view phewsh`,
> then read `bin/ commands/ lib/ mcp/`.

## What phewsh reads
- **`.intent/`** in your project (`vision.md`, `plan.md`, `status.md`, `next.md`,
  `project.json`, `next.json`). This is the source of truth it projects.
- **Your tools' context files** when present: `CLAUDE.md`, `AGENTS.md`,
  `GEMINI.md`, `.cursorrules`, `.github/copilot-instructions.md`, `README.md`.
- **Your Claude project memory** (`~/.claude/projects/<cwd>/memory/MEMORY.md` and
  files it links) and **global per-user memory** (`~/.claude/CLAUDE.md`,
  `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`) — read-only, used to enrich the
  `phewsh seq` summary. Global memory is **never** written into a project file
  unless you pass `--include-global` (`lib/sequencer/index.js`).
- **Git status** of the current repo (read-only: `git status`, HEAD, diff stats).

## What phewsh writes (and where)
Every generated block is wrapped in `<!-- PHEWSH:START -->` / `<!-- PHEWSH:END -->`
markers; **content outside the markers is preserved byte-for-byte** (tested).
- **Project context files** — the canonical `.intent/` projection into
  `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` / `.cursorrules` (only files that
  already exist, unless you create them). One canonical projector
  (`lib/selfheal.js`) is the single writer.
- **`~/.phewsh/`** — `config.json` (your settings/keys, mode **0600**, dir 0700),
  `briefs/` (saved handoff briefs), `sessions/`, `receipts/`, ledger files.
- **Shell rc** — only if you run `phewsh shim on` (adds one PATH line; reversible
  with `phewsh shim off`).
- **Global base files** — only if you run `phewsh ambient on`: a marker-wrapped
  block in `~/.claude/CLAUDE.md` etc. for tools you already have. Reversible with
  `phewsh ambient off`.
- **Claude Code hook** — `phewsh ambient on` registers `SessionStart`/`SessionEnd`
  hooks (context injection + a metadata breadcrumb; **never your transcript**).

## Network calls (exactly these)
phewsh makes **no network calls for its core local features** (sequencing,
projection, briefs, status). Calls happen only for these named actions:
- **`api.anthropic.com` / `openrouter.ai` / `api.together.xyz`** — only if you set
  a BYOK key and use `/run` or the API route. Your key goes **directly** to the
  provider; it is **not** proxied through phewsh servers.
- **`registry.npmjs.org`** — version check for `phewsh update` (notify-only by
  default).
- **`<project>.supabase.co`** — only if you `/login`: auth + optional cloud sync
  of your `.intent/` (you initiate `push`/`pull`).
- **`phewsh.com`** — only for `phewsh serve`/cloud-bridge actions you start.
- **Sustainability telemetry** (`trackSap`, `lib/supabase.js`) — sends **model
  name, token counts, and a kWh estimate only**. No prompts, no responses, no
  file contents. Tied to your account id only when logged in.

## Credentials
- A bring-your-own key lives in `~/.phewsh/config.json` at mode **0600**
  (`lib/config-file.js`) and is sent **directly to the provider**, never to us.
- phewsh routes through your installed tools on **their own login** (your Claude
  subscription, your ChatGPT plan) — it does not see or store those credentials.

## The local bridge
`phewsh serve` binds **`127.0.0.1` only** (loopback), with an origin allowlist,
and runs only while you run it.

## Known issues / hardening backlog (honest)
- **Local shell-injection surface (medium, local-only):** a few call sites build
  shell strings from REPL input via `execSync` (e.g. `commands/session.js` gate /
  outcomes arg passthrough). Inputs are your own typed/pasted text on your own
  machine, but crafted args could execute. Fix: convert to argument-safe
  `execFileSync`/`spawnSync`. Tracked as a Next item.
- **No release provenance yet** — npm provenance, signed tags, and a public
  source repo are planned (Roadmap) so the published artifact is verifiable.

## Disable / uninstall
- `phewsh ambient off` — removes injected hooks and global base files; restores
  your files.
- `phewsh shim off` — removes the PATH line.
- `npm uninstall -g phewsh` — removes the CLI. `rm -rf ~/.phewsh` removes local
  state. Generated `PHEWSH:START/END` blocks can be deleted by hand; everything
  outside them is yours and untouched.

## Roadmap to verifiable trust
Immediate (this/next pass): this doc, exec hardening, telemetry stays counts-only
and explicit. Before broad promotion: public CLI source repo with a reproducible
npm artifact, npm provenance, signed tags, `SECURITY.md` disclosure process,
dependency/secret scanning. For enterprise: a documented threat model and an
independent security assessment. We will not call phewsh "audited" until an
independent audit has actually occurred.

## Reporting
Security issues: **hello@phewsh.com**. Please allow reasonable time to remediate
before public disclosure.
