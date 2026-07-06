// PPS — Portable Project Spec compiler.
//
// TRUTH RULING (decisions.md, Jul 5 2026): the .md files ARE the project
// truth — user-owned, hand-editable, what every tool reads. pps.json is the
// compiler's receipt: structured output from clarify/init plus the hashes of
// what it generated, so regeneration can tell machine-owned files from
// hand-authored ones. phewsh never overwrites a file the human has edited.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function genId() {
  return `p_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

function genTaskId(index) {
  return `t_${String(index + 1).padStart(3, '0')}`;
}

function readPPS(intentDir) {
  const p = path.join(intentDir, 'pps.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

function writePPS(intentDir, data) {
  fs.mkdirSync(intentDir, { recursive: true });
  const now = new Date().toISOString().split('T')[0];
  data.updated = now;
  fs.writeFileSync(path.join(intentDir, 'pps.json'), JSON.stringify(data, null, 2));
}

function createPPS({ entity, archetype = 'product', raw = '', intent = {} }) {
  const now = new Date().toISOString().split('T')[0];
  return {
    id: genId(),
    version: '0.1',
    entity,
    archetype,
    created: now,
    updated: now,
    intent: {
      raw,
      goal: intent.goal || '',
      success_criteria: intent.success_criteria || [],
      constraints: intent.constraints || [],
      inputs: intent.inputs || [],
      outputs: intent.outputs || [],
    },
    tasks: (intent.tasks || []).map((t, i) => ({
      id: genTaskId(i),
      text: t.text,
      status: 'open',
      type: t.type || 'do',
      blocked_by: null,
    })),
    state: {
      phase: 'clarify',
      last_action: now,
      progress: 0,
    },
    assets: [],
    adapters: {
      anthropic: { project_id: null, last_synced: null },
      openai: { project_id: null, last_synced: null },
    },
  };
}

// One line of provenance in every generated file — the user must never
// mistake compiled output for something they wrote (or vice versa).
const PROVENANCE = 'provenance: compiled by phewsh clarify — yours to edit; phewsh never regenerates a file you have edited';

function generateViews(pps) {
  const { entity, intent, tasks, created, updated, archetype } = pps;

  const vision = `---
entity: ${entity}
archetype: ${archetype}
created: ${created}
updated: ${updated}
${PROVENANCE}
---

# Vision

## North Star
${intent.goal || `What is ${entity} and why does it exist?`}

## Outcomes
${intent.success_criteria.length > 0
  ? intent.success_criteria.map(c => `- ${c}`).join('\n')
  : '<!-- What does success look like? 3-5 concrete outcomes. -->'}

## Principles
${intent.constraints.length > 0
  ? intent.constraints.map(c => `- ${c}`).join('\n')
  : '<!-- Non-negotiable values and constraints. -->'}

## Beneficiaries
<!-- Who benefits from this and how? -->
`;

  const plan = `---
entity: ${entity}
archetype: ${archetype}
created: ${created}
updated: ${updated}
${PROVENANCE}
---

# Plan

## Current Strategy
<!-- One paragraph: the approach and why it's the right one right now. -->

## Systems
${intent.inputs.length > 0 || intent.outputs.length > 0
  ? [
      intent.inputs.length > 0 ? `**Inputs:** ${intent.inputs.join(', ')}` : '',
      intent.outputs.length > 0 ? `**Outputs:** ${intent.outputs.join(', ')}` : '',
    ].filter(Boolean).join('\n')
  : '<!-- Key components, tools, structures. -->'}

## Sequence
${tasks.length > 0
  ? tasks.slice(0, 5).map((t, i) => `- Phase ${i + 1}: ${t.text}`).join('\n')
  : '- Phase 1:\n- Phase 2:\n- Phase 3:'}

## Constraints
${intent.constraints.length > 0
  ? intent.constraints.map(c => `- ${c}`).join('\n')
  : '<!-- What limits this? Budget, time, team, technical. -->'}

## Resources
<!-- What do you have available? Team, tools, existing assets. -->
`;

  const next = `---
entity: ${entity}
archetype: ${archetype}
created: ${created}
updated: ${updated}
${PROVENANCE}
---

# Next

## Current State
${intent.goal ? `Building: ${intent.goal}` : '<!-- Where things stand right now. -->'}

## Next Actions
${tasks.length > 0
  ? tasks.map(t => `- [ ] **${t.text}**`).join('\n')
  : `- [ ] **Refine the vision** — Open the web compass and complete vision.md
- [ ] **Define Phase 1** — What is the smallest thing you can ship?
- [ ] **Identify the first blocker** — What is standing between you and execution?`}

## Blocked
<!-- What is stuck and why? -->

## Metrics
<!-- 2-3 numbers that tell you if it's working. -->
`;

  return { vision, plan, next };
}

function hashContent(s) {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
}

// The truth guard. Writes generated views, but a file is only machine-owned
// while its on-disk content still matches the hash recorded when we generated
// it. Hand-edited since then — or existing before we ever generated it (a
// hand-authored .intent/, like phewsh's own) — means it IS the truth now:
// preserve it, never overwrite. Records fresh hashes in pps.generated and
// persists pps.json. Returns { written, preserved }.
function writeGuardedViews(intentDir, pps) {
  fs.mkdirSync(intentDir, { recursive: true });
  const views = generateViews(pps);
  const prior = (pps.generated && pps.generated.hashes) || {};
  const written = [];
  const preserved = [];
  pps.generated = { ...(pps.generated || {}), hashes: { ...prior } };
  for (const [key, file] of [['vision', 'vision.md'], ['plan', 'plan.md'], ['next', 'next.md']]) {
    const fp = path.join(intentDir, file);
    let current = null;
    try { current = fs.readFileSync(fp, 'utf-8'); } catch { /* absent → ours to write */ }
    if (current !== null && (!prior[file] || hashContent(current) !== prior[file])) {
      preserved.push(file);
      continue;
    }
    fs.writeFileSync(fp, views[key]);
    pps.generated.hashes[file] = hashContent(views[key]);
    written.push(file);
  }
  writePPS(intentDir, pps);
  return { written, preserved };
}

module.exports = { readPPS, writePPS, createPPS, generateViews, writeGuardedViews, genId };
