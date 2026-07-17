---
name: intent
description: Create, inspect, refine, or reconcile a project's portable .intent/ truth. Use when the user asks what a project is building, wants to initialize or improve its intent, needs Project · Next · Work · Record aligned, or wants context to survive across Claude Code, Codex, Gemini, Cursor, and other AI tools.
license: MIT
metadata:
  author: phewsh
  version: "2"
---

# Phewsh Intent

Treat `.intent/` as the project's tool-neutral truth. The skill is a workflow;
the files are the memory. Never create a second truth inside a harness-specific
folder.

## Start

1. Locate the nearest project root containing `.intent/` or `.git/`.
2. If `.intent/README.md` exists, read it first; it maps the artifacts for that
   project.
3. Run `phewsh status` when available, then inspect the relevant `.intent/`
   files and the repository state. Declared intent is authoritative for goals
   and decisions, but it is not proof that implementation shipped.
4. If intent already exists and the requested operation is ambiguous, ask
   whether to refine the existing artifacts or intentionally start fresh.

## The four-word model

Keep the public model intact: **Project · Next · Work · Record**.

- **Project** — what is being built and why. `vision.md` is the north star;
  `project.json` carries structured constraints and policy; `plan.md` may hold
  the current strategy.
- **Next** — what should happen next. Prefer `next.json` for a structured task
  queue and `next.md` for its human-readable forward narrative when present.
- **Work** — what is happening now. It is a derived view (`phewsh work`), not a
  new persistent schema. Do not invent a top-level work artifact.
- **Record** — what happened and what was learned. Durable decisions belong in
  `decisions.md`; use `phewsh remember` when practical.

`status.md` may be a living current-state journal. It supports the model; it
does not replace **Next** or become a fifth word.

## Discovery and ownership

Phewsh installs this workflow at user level so Claude Code and Codex can share
the same byte-identical skill without adding files to every repository:

- `~/.agents/skills/intent/SKILL.md` — Codex and compatible Agent Skills tools;
- `~/.claude/skills/intent/SKILL.md` — Claude Code.

A repository may also contain `.agents/skills/intent/SKILL.md` or
`.claude/skills/intent/SKILL.md`. Harnesses can prefer that project-local copy
over the user-level skill. Treat it as user-owned: inspect it for contradictory
instructions, report the precedence through `phewsh ambient status`, and never
overwrite or remove it automatically. The project-local skill is still only a
workflow adapter; `.intent/` remains the project truth.

## Create intent

When `.intent/` is absent:

1. Ask conversationally what is being built and what success looks like. Get a
   concrete answer rather than accepting placeholder language.
2. Run `phewsh init` to create the guarded baseline.
3. Refine the generated `vision.md`, `plan.md`, and `next.md` from the user's
   answers. Remove generator placeholders from every section you touch.
4. Preserve `pps.json`; it is the compiler receipt used to protect
   hand-authored files.

`phewsh init` creates `.intent/`. It must not create `.agents/skills/`,
`.claude/skills/`, or another harness-owned source of project truth.

## Refine intent

Change the smallest artifact that owns the new information:

- sharpen the north star without silently changing direction;
- evolve the strategy when the approach changes;
- update Next when priorities or accepted success criteria change;
- record a decision when a choice or lesson must survive the chat;
- update status only for current-state claims.

Never overwrite a hand-authored artifact wholesale just to normalize its
format. Preserve project-specific files and history. If the repository and the
documents disagree, trust verified repository evidence for what exists, call
out the drift, and propose the smallest reconciliation.

## Verify and hand off

After changing intent:

1. Run `phewsh seq --write` so existing `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, and
   `.cursorrules` projections receive the same canonical core.
2. Run `phewsh status` and report any remaining drift or blocked decision.
3. State exactly which `.intent/` files changed and what was preserved.
4. Do not push to cloud automatically. If the user wants cloud/team sync, use
   `phewsh push` only with their authorization.

The success condition is simple: another human or AI harness can enter cold,
read the same project truth, and continue without a verbal re-brief.
