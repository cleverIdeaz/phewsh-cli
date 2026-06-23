// PPS — Portable Project Spec
// pps.json is the source of truth. .md files are generated views.

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

function generateViews(pps) {
  const { entity, intent, tasks, created, updated, archetype } = pps;

  const vision = `---
entity: ${entity}
archetype: ${archetype}
created: ${created}
updated: ${updated}
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

module.exports = { readPPS, writePPS, createPPS, generateViews, genId };
