# Pre/Post-Action Enforcement — Architecture & Support Matrix

> Design doc, **not yet implemented**. Records the architecture so a bounded,
> Claude-Code-first slice can ship later without hard-coding the policy model to
> one provider. The Decision Gate stays the pre-action authority — this is its
> enforcement surface, **not** a new top-level concept.

## Three clearly separated layers
1. **Deterministic enforcement** — block / require approval / modify an action
   *before* it executes. Only possible where a provider exposes a real
   pre-execution hook that can veto. Must fail safe and be bypassable.
2. **Advisory checks** — phewsh evaluates and warns, but cannot veto (the tool
   runs regardless). Used where no veto hook exists.
3. **Post-hoc observation** — phewsh observes results after the fact (postflight,
   receipts, outcomes). Already exists today.

## The shared contract (one internal action envelope)
Reuse existing concepts; do **not** add a fifth user word. An action envelope:
`{ proposed action, tool/provider, target/resource, estimated cost/risk,
relevant constraints (from project.json: budget/time/skill/autonomy + accepted
criteria + protected files), gate decision: approve|reject|modify|require-human,
execution result, verification result, record/outcome }`. The gate decision is
the existing Decision Gate; the record/outcome is the existing Record.

## Provider support matrix (verified capability, not assumption)
| Provider | Native pre-tool hook | Native post-tool hook | phewsh can today |
|----------|----------------------|------------------------|------------------|
| **Claude Code** | **Yes** (`PreToolUse`, can deny/modify) | **Yes** (`PostToolUse`) | only `SessionStart`/`SessionEnd` (`commands/hook.js`) — **no pre/post-tool yet** |
| Codex CLI | varies / limited | varies | advise + observe; launch-through |
| Cursor | no general veto hook | — | advise + observe |
| Gemini CLI | limited | limited | advise + observe |
| OpenCode | varies | varies | advise + observe |
| Generic MCP agents | via MCP server gating (request-time) | — | advise; proposal-based, never silent mutation |

**Conclusion:** deterministic enforcement is realistic **first on Claude Code**
(real `PreToolUse` veto). Everyone else is advisory + post-hoc until/unless they
ship veto hooks. The core policy model must be provider-neutral; Claude Code is
just the first adapter.

## First slice (a future Next item — bounded)
- Claude Code `PreToolUse` adapter that evaluates an action envelope against
  `project.json` constraints + accepted criteria + a protected-files list.
- Decisions: approve / require-human / reject, with an explainable reason.
- **Opt-in**, fail-safe (a broken policy never traps the user — bypass/recovery),
  local-first (no secrets or full tool payloads to the cloud by default), and
  decisions logged without logging sensitive content.
- Distinguish a phewsh policy denial from a provider/tool failure.
- Tests: allow, deny, modify, require-human, unavailable-hook fallback, redaction.

Do **not** build the full cross-provider framework just to say hooks exist.
