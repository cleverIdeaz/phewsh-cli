# PHEWSH MCP — Interoperability Map

> The plan for turning `phewsh mcp` (CLI) and `phewsh.com` (web) into one
> synchronized coordination layer that any AI harness can plug into.

## What this is solving

Today, phewsh has substantial coordination infrastructure that doesn't yet
connect end-to-end:

1. **stdio MCP server** (`mcp/src/index.js`) — 8 coordination tools plus the
   enforcement layer (`phewsh_evaluate_action`). Claude Code, Cursor, pi
   connect over stdio. Persists to `~/.phewsh/{projects,sessions,results,spend}/`.
2. **Web bridge** (`intent/app/src/lib/mcp-bridge.ts`) — polls
   `localhost:7483` expecting an HTTP transport with `/health`, `/dispatch`,
   `/status/:id`, `/result/:id`. Until Phase 1, that HTTP server didn't
   exist, so the "live session" pill and live dispatch flow were inert.
3. **`mcp/AGENTS.md`** — protocol-level rules for harnesses. Already names
   `agent_id: "claude-code"`, `"cursor"`, `"hermes"` as first-class
   identities. The "torn between" pitch is already documented.
4. **phewsh.com/api gateway** — OpenAI-compatible routing for harnesses
   (Hermes / Cursor / Continue) with credits billing, key-bound budget. Already
   deployed (commit `c50d8a63`). This is the *inference* plane; MCP is the
   *coordination* plane. They complement each other.
5. **`/connect` ecosystem page** — already on the homepage portal as one of
   the four paths (CHAT / BUILD / AGENTS / CONNECT). Surfaces phewsh as the
   continuity/interoperability layer for an evolving ecosystem.

Phase 1 closes the missing pipe between (1) and (2). Subsequent phases give
the loop visibility, persistence, and autonomy.

## Architecture (target)

```
                                  ┌─────────────────────────┐
                                  │   ~/.phewsh/             │
                                  │   projects.json          │
                                  │   sessions/  results/    │
                                  │   spend/{date}.json      │
                                  └─────────────────────────┘
                                            ▲
                                            │  read/write
                ┌───────────────────────────┴───────────────────────────┐
                │   mcp/src/lib/handlers.js  +  store.js                 │
                │   loadProjects, generatePacket (incl. evaluation     │
                │   block), recordSession, buildBriefing. dispatch       │
                │   queue + runtime registry are DISK-BACKED via         │
                │   store.js (~/.phewsh/bridge/) so both processes share │
                └─────────────┬─────────────────────────────┬───────────┘
                              │                             │
                  ┌───────────▼──────────┐      ┌───────────▼──────────┐
                  │  stdio transport      │      │  HTTP transport       │
                  │  mcp/src/index.js     │      │  mcp/src/http-server  │
                  │  • 8 coord tools      │      │  127.0.0.1:7483       │
                  │  • phewsh_evaluate_   │      │  • /health            │
                  │    action enforcement │      │  • /dispatch          │
                  │  • daily spend gate   │      │  • /status /result    │
                  └───────────┬──────────┘      │  • /next /complete    │
                              │                  │  • /jobs              │
                              │                  └───────────┬──────────┘
                              │                              │
                  ┌───────────▼──────────┐      ┌────────────▼─────────┐
                  │  Claude Code, pi,    │      │  intent web app       │
                  │  Cursor, hermes      │      │  (mcp-bridge.ts)      │
                  │  → register as       │      │  → discovers runtimes │
                  │    runtime           │      │  → POSTs dispatch     │
                  └──────────────────────┘      └──────────────────────┘
```

Both transports share the same handler library **and the same on-disk state**.
The stdio server and the HTTP server are separate OS processes (Claude Code
spawns the former; `phewsh mcp serve` spawns the latter), so the dispatch
queue and runtime registry can't live in process memory — they'd never see
each other. They persist to `~/.phewsh/bridge/{jobs,runtimes}.json` via
`store.js` (atomic write + read-modify-write).

A harness connecting via stdio registers in the runtime registry; HTTP
`/health` reads the same file and surfaces it to the web. POST `/dispatch`
writes a job; the next time the targeted harness calls `phewsh_start` /
`phewsh_next_task` over stdio, it reads the same file and gets the job. On
`phewsh_complete_task`, the result is written back and the HTTP poller resolves.

That's the synchronization loop. It is verified end-to-end across two separate
processes (see commit; the smoke test dispatches from an HTTP process and
completes from a separate stdio process).

## Phases

### Phase 1 — HTTP transport (✅ VERIFIED local bridge)

The load-bearing unlock. Until it existed, the web bridge was talking to
nothing.

- ✅ `mcp/src/lib/handlers.js` — extracted project loading, packet generation
  (now including the `evaluation` block), task ordering, session/result
  recording, briefing builder. Both transports import from here.
- ✅ `mcp/src/lib/store.js` — tiny disk-backed JSON store (atomic write +
  read-modify-write) under `~/.phewsh/bridge/`. The substrate that lets two
  separate processes share queue + registry state.
- ✅ `mcp/src/lib/runtime-registry.js` — disk-backed registry of connected
  harnesses with 5-min staleness pruning. Shared across processes via store.js.
- ✅ `mcp/src/lib/dispatch-queue.js` — disk-backed job queue keyed by jobId and
  packet.id. Persists jobs across the stdio↔HTTP process boundary (and across
  server restarts — jobs linger 5 min after terminal, history capped at 200).
- ✅ `mcp/src/http-server.js` — `127.0.0.1:7483` Node http server. Endpoints
  match `mcp-bridge.ts` exactly: `/health`, `/dispatch`, `/status/:id`,
  `/result/:id`. Plus `/jobs`, `/next?runtime=X`, `/jobs/:id/complete` for
  HTTP-only harnesses.
- ✅ `mcp/src/index.js` — refactored to use shared handlers. Enforcement layer
  (`phewsh_evaluate_action`, `dailyBudgetStatus`, `recordSpend`,
  `COST_CATALOG`) preserved in-file because `tests/mcp-evaluateAction.mjs`
  imports directly. New bridge points: register runtime on `phewsh_start`,
  check queue in `phewsh_start` / `phewsh_next_task` / `phewsh_complete_task`,
  resolve queue on `phewsh_complete_task` / `phewsh_flag_blocker`.
- ✅ `cli/commands/mcp.js` — `phewsh mcp serve` boots the HTTP transport.
  `phewsh mcp status` reports HTTP bridge reachability + connected runtimes.
- ✅ 6/6 enforcement tests pass; 16/16 truth-tests pass. Cross-process smoke
  test green: HTTP process dispatches → separate stdio process pulls + marks
  executing → `/health` shows the stdio-registered runtime → stdio process
  completes → HTTP `/result` resolves. The HTTP endpoint contract
  (`/health` shape, `/dispatch` body, `/status`, `/result`) matches
  `intent/app/src/lib/mcp-bridge.ts` exactly, verified at curl level.

**Verified:** `phewsh mcp serve` → start intent app at `/intent` → WORK view
shows the "Live" pill and `Run · Claude Code` controls → browser dispatches a
task → a separate HTTP harness picks it up via `/next?runtime=claude-code` →
the harness completes via `/jobs/:id/complete` → the browser receives the
result and moves the task to review. See
`docs/truth/mcp-web-cli-interop-2026-06-09.md` for receipts and caveats.

### Phase 2 — Web `/mcp` visibility surface

Visibility into the coordination layer.

- `intent/app/src/app/mcp/page.tsx` — connected runtimes, recent dispatches,
  evaluations (blocked/modified/allowed), blockers. Mirrors `phewsh mcp
  status` for the web.
- Could live alongside or under `/connect`. Decision deferred until we see
  whether `/connect` ergonomically absorbs a dispatch board.
- "Dispatch test packet" button so the bidirectional flow can be proven from
  the web without needing real action work.

**Done when:** phewsh.com/mcp shows the same state as `phewsh mcp status` and
both update live as agents come and go.

### Phase 3 — Supabase persistence

Move sessions, results, dispatches, **and the spend log** from local
filesystem to Supabase so the web has an audit trail and multi-device sync
works.

- Tables: `dispatches`, `sessions`, `results`, `spend_log`. All RLS'd on
  `user_id`. Mirror the local file formats.
- Handlers gain a `storage` adapter so file mode (offline) and Supabase mode
  (signed-in) share the same write paths.
- `phewsh mcp sync` pushes local sessions/results/spend to Supabase.
- Web `/mcp` reads from Supabase instead of polling the local HTTP bridge.

**Done when:** completing a task on machine A shows up in the dispatch
history on phewsh.com from machine B.

### Phase 4 — Realtime sync

Replace polling with Supabase Realtime where it matters.

- Web subscribes to `dispatches`, `sessions`, `results` for live updates.
- HTTP server publishes to Supabase Realtime on state changes so the web
  doesn't need to know about the local server's port.

**Done when:** clicking Execute on phewsh.com dispatches to a connected
Claude Code with no perceptible polling delay.

### Phase 5 — Autonomous side work

The "do something autonomously on the side without disrupting you" piece.

- `phewsh mcp watch --autonomous` — daemon that picks next task, dispatches
  to the highest-ranked available runtime, reports back. Respects the
  enforcement gate: every action passes through `evaluateAction` before
  execution. Respects daily budget. Respects decision-gate constraints.
- Throttle + budget guards: configurable max-tasks-per-hour, never-execute
  flags for `canRevert: false` actions without human ack, hard stop on
  `phewsh_evaluate_action` returning `block`.
- Surfaces in web `/mcp` as "Background work" feed.

**Done when:** you can leave `phewsh mcp watch --autonomous` running, walk
away, and return to status.md updated with what was done while you weren't
watching — with every action verifiably gated.

## How this maps to the orchestration wedge pitch

> "you may be torn between claude code, codex, hermes... or maybe you use
> them all? Enter phewsh interoperable orchestration. Align every project —
> become truly platform agnostic. Whether from web (native cross platform)
> or cli, your new agent command center has arrived."

| Pitch claim | What backs it today |
|---|---|
| "torn between claude code, codex, hermes" | `mcp/AGENTS.md` names them as equal first-class harnesses |
| "interoperable orchestration" | stdio MCP + HTTP bridge (Phase 1) + phewsh.com/api gateway |
| "align every project" | `.intent/` artifacts are canonical across CLI/web/MCP locally; Supabase/multi-device sync is Phase 3, not shipped |
| "platform agnostic" | OpenAI-compat gateway routes any model; enforcement gates any harness |
| "whether from web or cli" | Phase 1 HTTP bridge makes web↔CLI dispatch real |
| "agent command center" | Experimental/roadmap language until Phase 2 `/mcp` visibility exists |

The pitch is buildable. Phase 1 just shipped the missing live coordination
loop. Phase 2 makes it visible on the web. Phases 3–5 make it durable,
real-time, and autonomous.

## Open questions to decide later

- **Auth on the HTTP server.** Phase 1 binds to `127.0.0.1` only — no auth
  needed for local same-machine use. Remote dispatch over the internet
  needs a tunnel + token. Park until then.
- **`/mcp` vs `/connect` placement.** Phase 2 visibility could be a new
  `/mcp` route or expansion of the existing `/connect` page. Decide once we
  see the IA constraints.
- **Port collision.** 7483 is hardcoded in `mcp-bridge.ts`. The CLI honors
  `PHEWSH_MCP_PORT`; the bridge already supports
  `localStorage.phewsh_mcp_url`. Document the default; both stay configurable.
- **Persistence boundary.** The spend log already exists at
  `~/.phewsh/spend/{date}.json`. Phase 3 should sync that too so the daily
  budget gate works consistently across machines.

## Naming hygiene

- **packet** (noun) = the structured execution contract (`generatePacket()`
  output, includes objective/constraints/verification/evaluation/runtime)
- **dispatch** (verb) = send a packet to a runtime
- **runtime** = an execution environment (claude-code, browser-agent, human)
- **harness** = the host process speaking MCP to us (Claude Code, pi, Cursor,
  hermes)
- **agent** = the role/identity making decisions inside a harness
- **enforcement gate** = `phewsh_evaluate_action`; runs before any
  write/terminal/browser action; deterministic allow/block/modify
