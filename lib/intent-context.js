const fs = require('fs');
const path = require('path');

const MARKDOWN_ARTIFACTS = ['vision.md', 'plan.md', 'status.md', 'next.md'];

function readText(filePath) {
  try { return fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
}

function parseFrontmatter(content) {
  const match = String(content || '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: String(content || '') };
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.+)$/);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return { meta, body: match[2] };
}

function flattenAiResponsibilities(ai) {
  if (Array.isArray(ai)) return ai;
  if (!ai || typeof ai !== 'object') return [];
  const lines = [];
  for (const [role, details] of Object.entries(ai)) {
    if (!details || typeof details !== 'object') continue;
    const identity = details.identity || role.replace(/_/g, ' ');
    const may = Array.isArray(details.may) ? details.may : [];
    const mayNot = Array.isArray(details.may_not) ? details.may_not : [];
    lines.push(`${identity}: ${may.join('; ') || 'no capabilities listed'}`);
    if (mayNot.length) lines.push(`${identity} must not: ${mayNot.join('; ')}`);
  }
  return lines;
}

function summarizeProjectJson(data) {
  if (!data || typeof data !== 'object') return null;
  const gate = data.decisionGate || {};
  const constraints = gate.constraints || {};
  const lines = [];

  if (data.name) lines.push(`Project: ${data.name}`);
  if (data.tldr) lines.push(`TLDR: ${data.tldr}`);
  if (gate.goal) lines.push(`Goal: ${gate.goal}`);
  if (gate.feasibility) lines.push(`Feasibility: ${gate.feasibility}`);

  const constraintParts = [];
  if (constraints.budget != null) constraintParts.push(`budget $${constraints.budget}`);
  if (constraints.timeHoursPerWeek != null) constraintParts.push(`time ${constraints.timeHoursPerWeek}h/week`);
  if (constraints.skillLevel) constraintParts.push(`skill ${constraints.skillLevel}`);
  if (constraints.urgency) constraintParts.push(`urgency ${constraints.urgency}`);
  if (constraints.autonomy) constraintParts.push(`autonomy ${constraints.autonomy}`);
  if (constraintParts.length) lines.push(`Constraints: ${constraintParts.join('; ')}`);

  if (Array.isArray(gate.successCriteria) && gate.successCriteria.length) {
    lines.push('Success criteria:');
    gate.successCriteria.forEach(item => lines.push(`- ${item}`));
  }

  const split = gate.responsibilitySplit || {};
  const ai = flattenAiResponsibilities(split.ai);
  if (ai.length) {
    lines.push('AI responsibility:');
    ai.forEach(item => lines.push(`- ${item}`));
  }
  if (Array.isArray(split.human) && split.human.length) {
    lines.push('Human responsibility:');
    split.human.forEach(item => lines.push(`- ${item}`));
  }

  const activeActions = Array.isArray(data.actions)
    ? data.actions.filter(action => action && action.state !== 'reconciled')
    : [];
  if (activeActions.length) {
    lines.push('Recorded active actions:');
    activeActions.forEach(action => lines.push(`- [${action.state || 'unknown'}] ${action.intent}`));
  }

  return lines.length ? lines.join('\n') : null;
}

function loadIntentContext(cwd = process.cwd()) {
  const intentDir = path.join(cwd, '.intent');
  const loaded = [];

  for (const file of MARKDOWN_ARTIFACTS) {
    const filePath = path.join(intentDir, file);
    const content = readText(filePath);
    if (content == null) continue;
    const parsed = parseFrontmatter(content);
    loaded.push({
      file,
      content,
      promptContent: parsed.body.trim(),
      updated: parsed.meta.updated || parsed.meta.created || null,
      kind: file.replace(/\.md$/, ''),
    });
  }

  const projectPath = path.join(intentDir, 'project.json');
  const rawProject = readText(projectPath);
  if (rawProject != null) {
    try {
      const data = JSON.parse(rawProject);
      const summary = summarizeProjectJson(data);
      if (summary) {
        loaded.push({
          file: 'project.json',
          content: rawProject,
          promptContent: summary,
          updated: gateDate(data) || null,
          kind: 'constraints',
          structured: data,
        });
      }
    } catch {
      loaded.push({
        file: 'project.json',
        content: rawProject,
        promptContent: 'project.json exists but is invalid JSON; do not rely on it.',
        updated: null,
        kind: 'constraints',
        invalid: true,
      });
    }
  }

  return loaded;
}

function gateDate(data) {
  const gate = data && data.decisionGate;
  if (!gate) return null;
  const history = Array.isArray(gate.constraintHistory) ? gate.constraintHistory : [];
  return history.reduce((latest, item) => {
    const value = item && item.timestamp;
    return value && (!latest || value > latest) ? value : latest;
  }, gate.updatedAt || gate.createdAt || null);
}

module.exports = {
  MARKDOWN_ARTIFACTS,
  flattenAiResponsibilities,
  loadIntentContext,
  parseFrontmatter,
  summarizeProjectJson,
};
