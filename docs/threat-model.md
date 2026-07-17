# Phewsh CLI threat model

**Status:** maintained self-assessment, not an independent audit. This model
describes the source tree that ships the CLI; verify the installed version and
package contents before relying on it.

## Security goals

Phewsh should preserve project truth without silently granting new authority,
make handoff loss visible, keep secrets and local evidence private by default,
and fail honestly when a boundary cannot be verified. It should not imply that
one AI tool's transcript, memory, permissions, or identity automatically moves
to another tool.

## Assets and authority

| Asset | Where it lives | What it proves |
|---|---|---|
| Project truth | `.intent/` markdown/JSON | What people and tools recorded; claims may still be wrong or stale |
| Native context projection | Marker blocks in tool files | A supported adapter received a snapshot of recorded truth |
| Handoff receipt | `~/.phewsh/handoffs/` | Local state fingerprints and explicit losses at one boundary |
| Credentials | `~/.phewsh/config.json` | Authority to Phewsh cloud/provider features; never tool-native credentials |
| Native tool session | Claude Code, Codex, Gemini, etc. | The tool acts with its own login and the user's OS permissions |
| Ion/cloud state | Supabase-backed services | Shared registry/team data governed by service auth and row-level policy |

`.intent/` is portable evidence, not automatic truth. `phewsh truth` labels
conflicts and unknowns; it cannot prove a product claim merely because that
claim appears in a file.

## Actors and assumptions

- The local user controls the project, OS account, and commands they approve.
- Native AI tools and model providers are separate trust domains with their own
  data policies and credentials.
- Other processes running as the same OS user may read accessible files or call
  local ports.
- Repository dependencies, install scripts, npm infrastructure, the public
  mirror, and cloud services are supply-chain or service trust boundaries.
- A malicious repository may contain hostile instructions or configuration.
  Phewsh does not make untrusted repositories safe to execute.

## Entry points and trust boundaries

| Boundary | Existing control | Residual risk |
|---|---|---|
| `.intent/` → native tool | Marker-bounded projection, explicit adapter setup, truth/drift checks | A model can misread or ignore context; stale or malicious files remain possible |
| Native tool execution | Tool-native login; before/after receipts; narrow pre-tool gate | The tool runs with user authority. Phewsh is not a sandbox |
| Local handoff receipt | Atomic owner-only file, hashes, redacted browser view | A hash is not a signature; same-user processes can forge or alter surrounding state |
| `phewsh serve` | IPv4/IPv6 loopback, browser-origin allowlist, project-bound claim rechecks | Loopback is not authentication; same-machine processes and non-browser clients remain in scope |
| MCP HTTP transport | Loopback default | No transport authentication; `PHEWSH_MCP_HOST` must not expose it to an untrusted network |
| Provider/BYOK call | User-selected route, direct provider/custom-endpoint request | The selected endpoint receives submitted prompts; its policy applies |
| Cloud/Ion | Supabase auth, application checks, intended row-level policies | Local diagnostics cannot prove production RLS or realtime policy correctness |
| npm/install script | Public source snapshot and inspectable package/installer | There is no release provenance or signed tag tying today's package to a commit |
| Pack installation | Named source, confirmation, marked/reversible vendored blocks; linked packs stay pointers | Source content can still be malicious or later change; review before enabling |

## Safety gate limits

The gate uses deterministic pattern and command-segment matching for known tool
events. It denies a narrow set of catastrophic filesystem/disk operations and
can require confirmation for some high-blast-radius commands. It is
**fail-open** when input cannot be parsed, is not a complete shell parser, and
does not cover every execution path or tool. It is a guardrail, not a sandbox,
policy engine, or substitute for OS isolation and least privilege.

## Local service limits

`phewsh serve` listens only on `127.0.0.1` and `::1`, while the MCP HTTP host
can be changed with `PHEWSH_MCP_HOST`. Origin checks reduce cross-site browser
requests; they do not authenticate local callers. **Loopback is not
authentication.** Do not expose an unauthenticated bridge beyond the local
machine, and stop it when not in use.

## Data disclosure boundaries

- Ambient hooks inject selected `.intent/` excerpts, recorded constraints,
  status, and local decision continuity. They do not receive native transcripts.
- Handoff receipts name and hash tracked/staged/untracked-unignored project
  paths. Gitignored files are not named or hashed. Path names and hashes may
  still be sensitive, so raw receipts stay local.
- Sustainability telemetry contains model, token counts, estimates, session id,
  and optional account id—not prompt or response text.
- Browse/provider/cloud features transmit the data required by the destination
  the user selected. “Local-first” does not mean every optional action is
  offline.

## Supply-chain boundary

Publishing and mirror synchronization are manual today. The public repository
is reviewable, but there is **no release provenance**, signed tag, or registry
attestation proving an npm tarball came from a specific public commit. The
project must not claim that linkage until the promotion gate in
[`release-checklist.md`](./release-checklist.md) is implemented and verified.

## Known residual risks

- Local ledgers outside the explicitly hardened config/handoff paths may depend
  on the user's umask and existing directory permissions.
- The legacy local dispatch bridge has broader local authority than the newer
  project-bound Ion claim flow.
- Cloud policy correctness needs production policy review and adversarial tests;
  local `ion doctor` output is not proof.
- Pattern-based gates can miss obfuscated or novel command forms.
- Models can hallucinate, follow hostile repository instructions, or make unsafe
  changes even when they start with accurate project context.

## Review triggers

Update this model when a new network destination, credential, local listener,
execution route, pack-install mechanism, cloud table/policy, or release channel
is added. An independent security assessment remains required before Phewsh is
described as audited.
