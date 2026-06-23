# Sequencer Spec — Universal Memory Transform Layer

> `phewsh sequence` / `phewsh seq`

The sequencer reads every memory file that rules an AI session — regardless of format, tool, or origin — and produces one optimal context file for any target agent. It's the MIDI of intent: a universal representation layer that any instrument can play.

---

## The Problem

A developer's project knowledge is scattered across:
- `.intent/vision.md`, `plan.md`, `status.md`, `project.json` (PHEWSH)
- `CLAUDE.md` (Claude Code)
- `.claude/MEMORY.md` + individual memory files (Claude Code auto-memory)
- `.cursorrules` (Cursor)
- `agent.md` / `soul.md` / `AGENTS.md` (emerging conventions)
- `README.md`, `CONTRIBUTING.md` (traditional)
- `.github/copilot-instructions.md` (GitHub Copilot)

Each one encodes project intent, identity, constraints, and operational memory — but none of them talk to each other. Switch tools, lose context. Start a new session, re-explain yourself.

## What the Sequencer Does

```
INPUT                          SEQUENCER                        OUTPUT
                           ┌──────────────┐
.intent/vision.md     ──→  │              │  ──→  CLAUDE.md
.intent/plan.md       ──→  │   PARSE      │  ──→  .cursorrules
.intent/project.json  ──→  │   RANK       │  ──→  agent.md
CLAUDE.md             ──→  │   DEDUPE     │  ──→  soul.md
MEMORY.md + files     ──→  │   COMPRESS   │  ──→  copilot-instructions.md
.cursorrules          ──→  │   EMIT       │  ──→  .phewsh.context
agent.md / soul.md    ──→  │              │  ──→  JSON (MCP/API)
README.md             ──→  └──────────────┘  ──→  stdout
```

One command. N inputs. 1 optimal output per target format.

---

## Architecture

### 1. Parsers (Input Adapters)

Each parser reads one source format and returns a normalized `MemoryChunk[]`.

```js
// A MemoryChunk is the universal internal unit
{
  id: string,              // hash of source + content for dedup
  source: string,          // e.g. ".intent/vision.md", "CLAUDE.md"
  sourceType: string,      // "intent" | "claude" | "cursor" | "agent" | "readme" | "memory"
  kind: string,            // "identity" | "constraint" | "state" | "feedback" | "reference" | "action"
  content: string,         // the actual text
  weight: number,          // 0-1, how important (computed by ranker)
  timestamp: string|null,  // ISO date if available from frontmatter/git
  metadata: {              // anything format-specific
    frontmatter?: object,
    section?: string,      // which section it came from
    line?: number,
  }
}
```

**Parsers to build:**

| Parser | Source | Extracts |
|--------|--------|----------|
| `intent` | `.intent/*.md`, `project.json`, `pps.json` | vision, plan, state, constraints, actions, success criteria |
| `claude-md` | `CLAUDE.md` | Project instructions, architecture, conventions |
| `claude-memory` | `.claude/**/MEMORY.md` + linked `.md` files | User prefs, feedback, project knowledge, references |
| `cursor` | `.cursorrules` | Behavioral rules, conventions |
| `agent` | `agent.md`, `AGENTS.md` | Agent definitions, capabilities, behavioral rules |
| `soul` | `soul.md` | Project identity, values, anti-drift rules |
| `readme` | `README.md` | Project description, setup, architecture (low weight) |
| `copilot` | `.github/copilot-instructions.md` | Copilot-specific instructions |
| `generic-md` | Any `.md` with YAML frontmatter | Attempt parse by frontmatter type field |

Each parser is a function: `(filePath: string) => MemoryChunk[]`

Discovery is automatic — the sequencer walks known paths and probes for files.

### 2. Ranker

Takes all chunks and assigns `weight` based on:

```
weight = recency * impact * sourceAuthority * deduplicationPenalty
```

**Recency** (0.3-1.0):
- Timestamp < 24h: 1.0
- Timestamp < 7d: 0.8
- Timestamp < 30d: 0.6
- Timestamp > 30d or unknown: 0.3
- Derived from: frontmatter date, file mtime, git blame

**Impact** (0.2-1.0):
- `kind: "constraint"` → 1.0 (always relevant)
- `kind: "identity"` → 0.9 (project soul)
- `kind: "feedback"` → 0.8 (learned behavior)
- `kind: "state"` → 0.7 (current but ephemeral)
- `kind: "action"` → 0.6 (task-level)
- `kind: "reference"` → 0.4 (pointers, not content)

**Source Authority** (0.5-1.0):
- `.intent/` → 1.0 (canonical, user-authored intent)
- `CLAUDE.md` manual sections → 0.9 (user-curated)
- `CLAUDE.md` generated sections → 0.6 (derivative)
- `.claude/MEMORY.md` → 0.7 (AI-observed, may be stale)
- `agent.md` / `soul.md` → 0.8 (deliberate identity docs)
- `.cursorrules` → 0.7 (tool-specific)
- `README.md` → 0.4 (often stale, broad)

**Deduplication Penalty** (0-1.0):
- Content-hash similarity > 90%: keep highest-authority source, penalty others to 0
- Semantic overlap (same constraint stated differently): keep most specific, penalize vague

### 3. Compressor

After ranking, compress to fit target token budgets.

```js
const TOKEN_BUDGETS = {
  minimal: 500,     // MCP tool context, quick dispatch
  standard: 2000,   // CLAUDE.md section, .cursorrules
  full: 5000,       // Full agent briefing, soul.md
  unlimited: null,   // Dump everything
};
```

Compression strategy:
1. Sort chunks by weight descending
2. Include chunks until budget hit
3. For chunks that are partially useful, extract the high-signal sentences
4. Always include: project name, archetype, top 3 constraints, current execution state
5. Never compress: user feedback memories (they're already concise)

### 4. Emitters (Output Adapters)

Each emitter takes ranked + compressed chunks and produces one target format.

| Emitter | Output | Format |
|---------|--------|--------|
| `claude-md` | `CLAUDE.md` section (between markers) | Markdown with behavioral instructions |
| `cursorrules` | `.cursorrules` | Rules-first, terse |
| `agent-md` | `agent.md` | Agent capability + project context |
| `soul-md` | `soul.md` | Identity, values, anti-drift |
| `copilot` | `.github/copilot-instructions.md` | GitHub Copilot format |
| `context` | `.phewsh.context` | Generic portable briefing |
| `json` | stdout or file | MCP/API structured data |
| `stdout` | terminal | Human-readable summary |

Each emitter is a function: `(chunks: RankedChunk[], options: EmitOptions) => string`

---

## CLI Interface

```bash
# Auto-detect all sources, emit optimized CLAUDE.md section
phewsh sequence

# Explicit target format
phewsh seq --target claude-md
phewsh seq --target cursorrules
phewsh seq --target agent-md
phewsh seq --target soul-md
phewsh seq --target json

# Control token budget
phewsh seq --budget minimal      # 500 tokens — for MCP dispatch
phewsh seq --budget standard     # 2000 tokens — default
phewsh seq --budget full         # 5000 tokens — deep briefing

# Write to file (default: stdout)
phewsh seq --out CLAUDE.md
phewsh seq --out .cursorrules

# Show what was found + how it was ranked (debug)
phewsh seq --explain

# Dry run — show sources found, chunks extracted, no output
phewsh seq --dry-run

# Only read specific sources
phewsh seq --sources intent,claude-memory
phewsh seq --sources intent,readme

# Emit ALL formats at once (useful for multi-tool setups)
phewsh seq --all
```

### In-session (phewsh REPL)

```
/seq                    # Quick sequence → stdout
/seq claude             # Sequence → CLAUDE.md
/seq cursor             # Sequence → .cursorrules
/seq explain            # Show ranking breakdown
/seq all                # Emit all target formats
```

### Watch integration

`phewsh watch` already syncs `.intent/` → `CLAUDE.md`. The sequencer replaces that pipeline:

```
OLD:  .intent/ change → regenerate CLAUDE.md section → push cloud
NEW:  any source change → sequence all → regenerate all targets → push cloud
```

The watcher expands from watching `.intent/` to watching all known source paths.

---

## File Layout

```
cli/
├── lib/
│   └── sequencer/
│       ├── index.js           # Main orchestrator: discover → parse → rank → compress → emit
│       ├── discover.js        # Walk known paths, find all source files
│       ├── parsers/
│       │   ├── intent.js      # .intent/*.md, project.json, pps.json
│       │   ├── claude-md.js   # CLAUDE.md (split manual vs generated sections)
│       │   ├── claude-memory.js  # .claude/MEMORY.md + linked files
│       │   ├── cursor.js      # .cursorrules
│       │   ├── agent.js       # agent.md, AGENTS.md
│       │   ├── soul.js        # soul.md
│       │   ├── readme.js      # README.md
│       │   ├── copilot.js     # .github/copilot-instructions.md
│       │   └── generic.js     # Any .md with recognized frontmatter
│       ├── ranker.js          # Weight calculation: recency * impact * authority * dedup
│       ├── compressor.js      # Token-budget-aware compression
│       └── emitters/
│           ├── claude-md.js   # CLAUDE.md section output
│           ├── cursorrules.js # .cursorrules output
│           ├── agent-md.js    # agent.md output
│           ├── soul-md.js     # soul.md output
│           ├── copilot.js     # copilot-instructions.md output
│           ├── context.js     # .phewsh.context output
│           ├── json.js        # Structured JSON (MCP/API)
│           └── stdout.js      # Human-readable terminal output
├── commands/
│   └── sequence.js            # CLI command handler
```

---

## How It Replaces Current Code

| Current | Sequencer Equivalent |
|---------|---------------------|
| `context.js` → `generateContext()` | `sequencer/index.js` → `sequence({ target: 'context' })` |
| `watch.js` → `generateClaudeSection()` | `sequencer/index.js` → `sequence({ target: 'claude-md' })` |
| `context-export.ts` → `generateContext()` | Web app calls sequencer JSON endpoint or shared logic |
| `context-export.ts` → `generateClaudeMd()` | `sequencer/emitters/claude-md.js` |
| `context-export.ts` → `generateSoulMd()` | `sequencer/emitters/soul-md.js` |
| `context-export.ts` → `exportForMCP()` | `sequencer/emitters/json.js` |

The sequencer subsumes all existing context generation. `context.js` and the watch CLAUDE.md generator become thin wrappers that call `sequence()`.

---

## Web App Integration

The web app at `phewsh.com/intent` needs the same sequencer logic. Two paths:

**Option A: Shared core (recommended)**
Extract sequencer ranking + compression + emitting logic into a shared package that both CLI (Node) and web app (browser) can import. Parsers differ (CLI reads fs, web reads Supabase), but ranker/compressor/emitters are identical.

```
@phewsh/sequencer-core    # ranker, compressor, emitters — isomorphic
cli/lib/sequencer/        # CLI parsers (fs-based) + imports core
intent/app/src/lib/seq/   # Web parsers (Supabase-based) + imports core
```

**Option B: CLI as source of truth**
Web app calls CLI via the serve bridge or generates a simpler version. Keeps logic in one place but limits web-only users.

**Recommendation**: Start with Option B (CLI-first), extract to shared core when web app needs full parity.

---

## The Compass

The sequencer needs a compass — a schema for what matters. Different domains have different compasses:

**Intent Compass** (default — project work):
```
Priority order:
1. Constraints (budget, time, skill, urgency) — always first
2. Identity (what is this, why does it exist) — mission-critical
3. Current state (what's done, what's blocked) — ephemeral but actionable
4. Feedback (learned behaviors, corrections) — shapes how, not what
5. Actions (specific tasks) — most granular, most perishable
6. References (pointers to external systems) — include if space permits
```

**The compass is what makes sequencing intelligent, not just concatenation.** Different output formats emphasize different compass points:
- `claude-md`: Constraints + Identity + State (behavioral shaping)
- `soul-md`: Identity + Feedback + Constraints (character persistence)
- `cursorrules`: Feedback + Constraints (terse rules)
- MCP JSON: State + Actions + Constraints (dispatch-ready)

Future compasses:
- **Musical compass** (circle of fifths analog for StyleTree)
- **Narrative compass** (for content/copy work)
- **Debug compass** (for incident investigation)

---

## Build Order

### Phase 1: Core Pipeline (MVP)
1. `discover.js` — find all source files in cwd
2. `parsers/intent.js` — parse `.intent/` (already have this logic in context.js)
3. `parsers/claude-md.js` — parse `CLAUDE.md` manual vs generated sections
4. `ranker.js` — weight calculation (simplified: recency + kind-based impact)
5. `compressor.js` — token budget truncation
6. `emitters/claude-md.js` — produce CLAUDE.md section
7. `emitters/stdout.js` — human-readable terminal output
8. `commands/sequence.js` — wire it up as `phewsh seq`

**Replaces**: `context.js` generateContext + `watch.js` generateClaudeSection

### Phase 2: Full Format Support
9. `parsers/claude-memory.js` — read `.claude/**/MEMORY.md` + linked files
10. `parsers/cursor.js`, `parsers/agent.js`, `parsers/soul.js`
11. `emitters/cursorrules.js`, `emitters/agent-md.js`, `emitters/soul-md.js`
12. `emitters/json.js` — MCP-compatible structured output
13. Update `watch.js` to use sequencer instead of inline generation

### Phase 3: Intelligence
14. Content-hash deduplication (same info stated in .intent/ AND CLAUDE.md)
15. Semantic compression (extract high-signal sentences from long sections)
16. `--explain` mode showing full ranking breakdown
17. Session REPL `/seq` commands

### Phase 4: Web Parity
18. Extract `@phewsh/sequencer-core` (ranker + compressor + emitters)
19. Web parsers reading from Supabase instead of fs
20. "Sequence" button in phewsh.com/intent replacing current export

---

## What This Unlocks

1. **True tool interop**: Change your intent in Claude Code → `.cursorrules` auto-updates → Cursor knows too
2. **Memory portability**: Claude's learned feedback about you becomes available to every tool
3. **One-command setup**: Clone a repo, run `phewsh seq --all`, every AI tool is configured
4. **Compound intelligence**: Every session makes the context better, not just for one tool but all of them
5. **Format-native output**: Each tool gets context in its own language, not a lowest-common-denominator dump

This is the pipe. Everything else — the particle experiences, the compass modes, the StyleTree integration — flows through it.
