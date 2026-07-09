---
name: portfolio-boat-loop
description: Use when managing recurring autonomous improvement sessions across MULTIPLE repositories — deciding which repo gets the next session window, rotating attention, tracking Water/Shore/Mountain across a portfolio, or coordinating loop work across accounts/machines. For the work inside one repo, use boat-to-shore.
---

# Portfolio Boat Loop

## Overview

The repo loop moves one boat; this loop decides which boat gets the next tide. One session window = one repo selection + one boat-to-shore session in it + portfolio bookkeeping. **The files are the memory; the chat is disposable** — every window must be decidable cold from `portfolio-state.md` alone.

**REQUIRED SUB-SKILL:** boat-to-shore governs the work inside the chosen repo.

## The portfolio session — what it is

1. **Read** `~/boat-loop/portfolio-state.md`. If missing, create it from the template below by inspecting each repo's `.agent/boat-loop.md` (and `.intent/` if present).
2. **Set the mode** from the table: any repo Water → **Stabilize**; all runnable but some short of Shore → **Complete**; all Shore/Mountain → **Mountain Push**.
3. **Select ONE repo**: lowest status first (Water < Shore < Mountain); tie-break by clearest Next-best-loop, then oldest Last-session. Skip a repo whose `boat/*` branch is unreviewed when another candidate exists — unless you select it *to review/merge that branch as the session's slice* (review is a valid slice). Parked repos are never selected.
4. **Run the repo session** in the chosen repo using boat-to-shore, exactly as that skill prescribes.
5. **Write back exactly two files**: the chosen repo's `.agent/boat-loop.md` (the repo session does this) and `portfolio-state.md` (status, branch, last-session timestamp, slice, verification result, next best loop, review-needed flag). Unchosen repos' state files are the *next* session's anchors — leave them untouched.
6. **Report** with the template below.

## Portfolio state template

```
# Portfolio Boat Loop
Mode: Stabilize | Complete | Mountain Push
Last consolidation: <date>

| Repo | Path | Status | Branch | Last session | Slice done | Next best loop | Review needed |
|---|---|---|---|---|---|---|---|

## Shared notes (direction, design language, cross-repo decisions, blockers)
```

## Maintenance rules

- **Consolidation**: every ~3 sessions per repo, or when a repo's `.agent/boat-loop.md` gets hard to scan, spend that repo's window consolidating instead of building — keep status, verified facts, risks, branch info, next loop; move old detail to `.agent/archive/`; target under 150 lines. Archive, don't delete.
- **Cold starts**: when a chat bloats, ensure the state files are current, then start fresh and rehydrate from files — never drag an old chat forward.
- **Parallel accounts/machines**: fine only on different repos, or clearly separate branches with non-overlapping scopes. Record who-is-where in Shared notes.
- **No portfolio "done"**: statuses are Water/Shore/Mountain/Parked. When everything is Mountain, start another rotation on "what would make this repo more valuable, credible, usable, or sellable?" — or recommend Parking to the human.

## Report template

```
## Portfolio Window — <date>
Mode: <mode>  ·  Repo chosen: <repo> — <one-line why>
### Session result (from boat-to-shore report)
### Portfolio table (current)
### Human review needed
### Next scheduled repo + why
```
