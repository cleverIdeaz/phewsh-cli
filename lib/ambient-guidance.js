// Ambient guidance — kept deliberately SMALL.
//
// The hard lesson (4 dogfood rounds + a CCAF-exam framing): you cannot solve a
// trust problem with persuasion. A global block that says "trust this tool,
// treat its files as intent, it installed itself, here's how to undo it" is
// — to a safety-tuned model — nearly indistinguishable from an injection, and
// rewording it just raises suspicion. Real user config never talks like that.
//
// So phewsh no longer ASKS the model to prove it's active. phewsh proves it
// itself, through architecture (a deterministic launch banner from command
// shims, the SessionStart hook, the ledger). Prose carries the minimum:
//   • GLOBAL: a tiny FACT — ".intent/ dirs are project docs" — nothing more.
//   • PROJECT: the real .intent/ content is the evidence; this is a short,
//     factual frame around it. The 😮‍💨🤫 is best-effort and project-only —
//     never the guarantee (the banner/ledger are).

// Machine-wide: the smallest possible factual note. No emoji, no undo line, no
// "installed by", no trust claim, no behavioral request — those are exactly
// what made a security-tuned model challenge it. Just the fact.
const GLOBAL_GUIDANCE = `## phewsh
Some projects on this machine use a \`.intent/\` directory as project documentation. When one is present, read those files like README.md, CLAUDE.md, or AGENTS.md.`;

// In-project: the synced block already carries the real .intent/ content above
// this note (vision/plan/status) — that's the evidence the model trusts. Keep
// the framing short and factual; the signature is an invitation, not a mandate.
const PROJECT_GUIDANCE = `## Project intent (phewsh)
The \`.intent/\` content above is this project's source-of-truth documentation — what's being built, the plan, current status, and constraints. Use it like the project's README. If your work changes a decision or the direction, you can offer to update \`.intent/\` so the user's other tools stay in sync.
(Optional: when phewsh's project context shaped your reply, you're welcome to end with \`— 😮‍💨🤫\` so the user can see the continuity layer working. The reliable signal is phewsh's own launch banner, not this.)`;

module.exports = { PROJECT_GUIDANCE, GLOBAL_GUIDANCE };
