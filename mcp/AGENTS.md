# mcp/AGENTS.md

> MCP server integration rules for PHEWSH.
> Any agent connecting via MCP — Claude Code, Cursor, custom — reads this before acting.

---

## What This Server Does

`phewsh-mcp-server` exposes a structured coordination layer between humans and AI agents via the Model Context Protocol.

It loads project specs from:
1. **Local `.intent/`** — runs in cwd, auto-detected
2. **`~/.phewsh/projects.json`** — written by `phewsh mcp sync` or web export

It never implements. It coordinates: intent → dispatch packet → agent execution → completion → chain next task.

---

## Agent Identity

When calling any tool, pass `agent_id` consistently:

```
agent_id: "claude-code"    # Claude Code sessions
agent_id: "cursor"         # Cursor agent sessions
agent_id: "hermes"         # Hermes orchestration sessions
```

Unidentified sessions log as `anonymous`. Always provide it.

---

## Tool Usage Strategy

### Start here: `phewsh_start`

One call gives you full project briefing + first dispatch packet. Always call this at session open.

```json
{"project_id": "local", "agent_id": "claude-code"}
```

### Execute: dispatch packet runtime

The `phewsh_start` / `phewsh_next_task` response is an execution contract:

```json
{
  "objective": { "task": "...", "category": "...", "successState": "..." },
  "constraints": { "budget": "$50", "time": "15h/wk", "urgency": "urgent" },
  "verification": { "criteria": ["..."] },
  "continuation": { "reportBack": "...", "nextActions": ["..."] }
}
```

Preferred runtime is `claude-code`, inferred from task type. Execute in that runtime, then call `phewsh_complete_task`.

### Complete: `phewsh_complete_task`

One call reports results and chains to next task in one round trip:

```json
{
  "project_id": "local",
  "task_id": "act_1747500001_a1b2",
  "result": "Specific outputs and artifacts produced",
  "success": true,
  "issues": "Decisions made; scope creep noted",
  "agent_id": "claude-code"
}
```

### Blocker: `phewsh_flag_blocker`

When a task can't be done, the server returns alternative tasks.
Do not silently fail — always flag and get the next work item.

---

## Session History

Sessions are tracked per-project in `~/.phewsh/sessions/{project_id}_sessions.json`.
Every `start`, `complete`, `block` event is logged with `agent_id`, `timestamp`, and result payload.
Last 100 sessions retained per project.

`phewsh_session_history` reads this file. No server-side DB required.

---

## Scope Boundaries

**MCP server owns:** intent model storage, task ordering, dispatch packet construction, session logging. It never executes — agents that connect via MCP do.

**MCP server does NOT own:** credential management, code execution, file mutations. Agents that connect via MCP handle execution.

---

## Dispatch Regime (this repo)

```
Hermes (orchestrates, holds continuity context)
  └─► Claude Code CLI (delegate_task, terminal toolset)
          └─► GitHub (commit/push)
                  └─► GitHub webhook → next Hermes session
```

The MCP server is the handoff layer that makes this work without re-explaining the project every time.

---

## Quick Reference

| Tool | Purpose |
|---|---|
| `phewsh_start` | Session open: briefing + first task |
| `phewsh_next_task` | Pull next tasks by type (agent/ai/human) |
| `phewsh_complete_task` | Report result, chain next |
| `phewsh_flag_blocker` | Block a task, get alternatives |
| `phewsh_list_projects` | List all synced projects |
| `phewsh_get_context` | Deep dive: full vision/plan/gate read |
| `phewsh_check_verification` | Confirm acceptance criteria before marking done |

---

## Validation Status

- NPM publish: pending (`mcp/` not yet published as `@phewsh/mcp-server`)
- Local web↔HTTP-harness bridge: verified; see `docs/truth/mcp-web-cli-interop-2026-06-09.md`
- Claude Code MCP stdio connection: not yet proven end-to-end on this VPS
- Session history file: confirmed present (`~/.phewsh/sessions/`), not yet read by any viewer
- Spec reference: `spec/openapi.yaml` documents the API surface
