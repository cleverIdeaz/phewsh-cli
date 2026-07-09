---
name: boat-to-shore
description: Use when running recurring autonomous improvement sessions on a repository (e.g. via /loop or a scheduled continuation), when resuming work after a session reset or context loss, or when moving a repo from unfinished/TODO-riddled toward shippable without a human available to answer questions.
---

# Boat to Shore

## Overview

Move the repo from **Water** (broken, unclear, unfinished) to **Shore** (runs, builds, core flow works, verified) to **Mountain** (polished, tested, documented, launch-ready). One verified slice per session. The state file is the anchor: every session starts by reading it and ends by updating it. The loop's output is not just code — it's a repo the next session can pick up cold.

**Violating the letter of these rules is violating the spirit of the loop.** A high-quality sprawl is still a sprawl.

## Session sequence

1. **Rehydrate.** Read `./.agent/boat-loop.md`, `git status`/recent log, and README. If the repo has a `.intent/` directory (phewsh), treat it as the project plan and read it first. If the state file is missing, create it: run a first-pass diagnostic (stack, how to run/build/test, TODO/FIXME/placeholder sweep, run the checks) plus a blind-spot pass (unknown unknowns, risky assumptions, map-vs-territory disagreements — the plan is the map, the repo is the territory; when they disagree, trust the territory and log the disagreement).
2. **Choose ONE slice.** If the state file already names a Current Session Goal or Next best loop, that is your slice — do not renegotiate it. Otherwise pick the single highest-leverage goal completable and verifiable this session. A slice is one *goal*, not everything that happens to live in the same files. Priority order: runs → builds → core flow works → user understands it → verified → survives real use → feels excellent → next agent moves faster.
3. **Branch.** `git checkout -b boat/<slug>-<date>` (or reuse the existing boat branch). Never work directly on main/master.
4. **Implement small.** Smallest coherent change that completes the slice. Check `git diff` as you go. No unrelated refactors, no rewrites without proving the current architecture can't support the goal.
5. **Verify.** Strongest feasible ladder: typecheck/lint → tests → build → local smoke → browser/Playwright when UI behavior matters. A claim without a run check is not a result.
6. **Push harder — inside the slice's blast radius.** After it works: is there an error/empty/loading state, a locking test, or a doc line attached to *this* slice? Do the best one. Adjacent backlog items are the next loop's slices, not this one's dessert.
7. **Update state.** Append to `.agent/boat-loop.md` (never overwrite the log): what changed, what was verified, current status (Water/Shore/Mountain), and **Next best loop**. Log non-obvious decisions and deviations from the plan in `.agent/implementation-notes.md` (discovery → decision → why → risk → verification).
8. **Report** using the template below.

## Hard rules

- **One slice per session.** Even if the backlog looks small enough to finish. Finishing the backlog in one sitting produces an unreviewable diff and an untestable session.
- **Never commit to main/master.** Branch, always, even in tiny repos.
- **"Done" is not a state.** There are only Water, Shore, Mountain — and Mountain still gets a "Next best loop" (a strategic push, or an explicit recommendation to the human to stop the loop). If you wrote "Done", replace it.
- **Verify before claiming.** If a check fails and is out of scope, document it precisely — don't hide it.
- **Blocked?** Make the safest reversible assumption, log it, keep moving. Ask a question only if it would change architecture, data model, auth, pricing, or ownership — never "should I continue?"
- **Bounded research.** Competitor/reference scan at most once per repo, only after Shore, output = implementation moves (not a report), stored in `.agent/competitors.md`.

| Rationalization | Reality |
|---|---|
| "The remaining items are small — I'll just do them all" | That's three sessions' worth of review risk in one diff. One slice. |
| "It's all in the same two tiny files — one coherent slice" | File adjacency doesn't merge goals. The state file's scope instruction wins. |
| "This repo is tiny, master is fine" | The loop runs unattended. Branches are the undo button. |
| "Everything on the list is fixed — mark it Done" | The list was the map. Re-inspect the territory: embarrassment test, then write the next loop. |
| "It seems finished" | Prove it: run the checks, load the UI, read it as a stranger. |
| "Pushing harder means doing more items" | Pushing harder means making *this* slice excellent. |

## Red flags — stop and re-read Hard rules

Working on main · second backlog item in one session · "Done" anywhere · claiming results with no check run · state file unchanged at session end · asking the human what to do next.

## Session report template

```
## Session Result — <repo> — <date>
Status: Water | Shore | Mountain
### Slice completed
### Verified (commands run + results)
### Deviations & assumptions (map vs territory)
### Remaining risks
### Next best loop
### Quiz for the human (3 Qs: main improvement? riskiest assumption? what should the next loop do?)
```

## The mountain question

Before ending any Shore/Mountain session: *if a real user, a buyer, and a future maintainer saw this tomorrow, what would embarrass us?* The highest-impact answer is the next loop's slice.
