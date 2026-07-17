# Security & Data Flow — phewsh CLI

Phewsh is a **local-first continuity layer**, not a sandbox. It reads project
records, projects bounded context into supported AI tools, and can launch tools
that run with your user account's authority. This page is a source-backed
inventory of what the CLI reads, writes, and sends.

> **Status:** self-documented and tested, **not independently audited**. The
> MIT-licensed source snapshot is public at
> [cleverIdeaz/phewsh-cli](https://github.com/cleverIdeaz/phewsh-cli). The npm
> artifact is manually published today and is not yet cryptographically linked
> to that repository. See the [threat model](./docs/threat-model.md) and
> [release integrity checklist](./docs/release-checklist.md).

## What phewsh reads

- Project truth in `.intent/`, plus Git status, HEAD, and diff statistics.
- Existing native context files such as `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`,
  `.cursorrules`, Copilot instructions, and `README.md`.
- Claude project/global memory and other supported tools' global context files
  when building a `phewsh seq` summary. Global content is not copied into a
  project unless you pass `--include-global`.
- Local Phewsh configuration, receipts, decisions, and session metadata.

Phewsh does not read or store native tool transcripts through its ambient
hooks. A native tool may still read files or send prompts under that tool's own
permissions and policy.

## What phewsh writes

- Marker-wrapped projections in supported native context files. Content outside
  `<!-- PHEWSH:START -->` / `<!-- PHEWSH:END -->` is preserved.
- Local state under `~/.phewsh/`: configuration, briefs, handoff receipts,
  session metadata, and ledgers. `config.json` and handoff receipt paths are
  explicitly owner-only (`0600` files, `0700` directories) on POSIX systems.
  Other local ledgers rely on the owning account and process umask today; treat
  the whole directory as sensitive.
- A reversible PATH line only after `phewsh shim on`.
- Reversible, marker-wrapped global adapter blocks and unmodified Phewsh-owned
  intent-skill copies only after `phewsh ambient on`.
- Claude Code and Codex lifecycle/safety hooks after `phewsh ambient on`.

Handoff receipts contain paths, fingerprints, Git state, route labels, and a
brief hash—not file contents, prompts, responses, transcripts, or model
reasoning. Gitignored files are not named or hashed. Browser-facing receipt
views are redacted. A SHA-256 match detects later change; it is **not a
signature** and does not prove who created the receipt.

## Network boundaries

Core projection, status, local brief generation, and receipt verification can
run without network access. Network calls occur when a user selects a feature
that needs them, including:

- npm registry version checks and optional updates;
- direct requests to configured model providers, a configured custom endpoint,
  local Ollama, or Phewsh's pooled provider route;
- Supabase authentication, cloud sync, Ion/team features, and sustainability
  telemetry;
- user-requested URL browsing, YouTube captions, GitHub API feedback/listing,
  and OAuth flows;
- same-machine HTTP bridges started by the user.

BYOK requests go to the selected provider or configured endpoint. The endpoint
receives the prompt supplied to that provider. Sustainability telemetry sends
the model, prompt/completion token counts, estimated kWh/CO2/water, a session
identifier, and an account identifier when logged in—never prompt or response
content. A user-requested browse sends a request to the supplied URL.

## Credentials

Phewsh stores its own Supabase tokens and BYOK values in
`~/.phewsh/config.json`, hardened to mode `0600` inside a `0700` directory on
POSIX systems. Phewsh does not read Claude Code, Codex, Gemini, or Cursor
credentials; spawned tools authenticate themselves.

## Local bridges

`phewsh serve` binds IPv4 and IPv6 loopback (`127.0.0.1` and `::1`) and applies
a browser-origin allowlist. Project claims are rechecked against registration,
cloud project identity, and Git origin. The legacy local dispatch surface is
broader and should be treated as local-user authority.

**Loopback is not authentication.** Another process running as your user may
be able to call a local service, and non-browser clients do not supply a browser
Origin header. The optional MCP HTTP transport is also unauthenticated. Never
set `PHEWSH_MCP_HOST` to a non-loopback interface on an untrusted network.

## Safety gate

The pre-tool gate blocks a narrow set of catastrophic command shapes and may
ask about high-blast-radius operations depending on autonomy. It is deliberately
**fail-open** if hook input cannot be understood, uses pattern/segment matching
rather than a complete shell parser, and covers known tool names. It is a
last-line safety aid, **not a sandbox or authorization system**.

## Supply chain status

The npm release and public source mirror are synchronized manually. There is
currently **no release provenance**, signed tag, or registry attestation tying
an installed tarball to a public commit. Users can inspect `npm pack`, the
public source snapshot, or the installer before running it, but similarity is
not cryptographic proof. The required release procedure and promotion gate are
in the [release integrity checklist](./docs/release-checklist.md).

## Disable / uninstall

- `phewsh ambient off` removes injected hooks, global blocks, and unchanged
  Phewsh-owned intent-skill copies.
- `phewsh shim off` removes the PATH line.
- `npm uninstall -g phewsh` removes the CLI. Local `~/.phewsh/` state and
  project `.intent/` files remain yours and can be removed separately.

## Reporting

Security issues: **hello@phewsh.com**. Please allow reasonable time to
remediate before public disclosure.
