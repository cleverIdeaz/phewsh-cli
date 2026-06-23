// Parse .intent/ artifacts into MemoryChunks.
// This is the highest-authority source — user-authored canonical intent.

const fs = require('fs');
const path = require('path');
const { flattenAiResponsibilities } = require('../../intent-context');

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: content };

  const meta = {};
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return { meta, body: match[2] };
}

function extractSections(body) {
  const sections = [];
  let current = null;

  for (const line of body.split('\n')) {
    const heading = line.match(/^##\s+(.+)/);
    if (heading) {
      if (current) sections.push(current);
      current = { title: heading[1], lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) sections.push(current);
  return sections;
}

function parseVision(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const { meta, body } = parseFrontmatter(content);
  const mtime = fs.statSync(filePath).mtime.toISOString();
  const timestamp = meta.updated || meta.created || mtime;
  const chunks = [];

  // Whole vision as identity
  chunks.push({
    source: '.intent/vision.md',
    sourceType: 'intent',
    kind: 'identity',
    content: body.trim(),
    timestamp,
    metadata: { frontmatter: meta },
  });

  return chunks;
}

function parsePlan(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const { meta, body } = parseFrontmatter(content);
  const mtime = fs.statSync(filePath).mtime.toISOString();
  const timestamp = meta.updated || meta.created || mtime;

  return [{
    source: '.intent/plan.md',
    sourceType: 'intent',
    kind: 'context',
    content: body.trim(),
    timestamp,
    metadata: { frontmatter: meta },
  }];
}

function parseStatus(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const { meta, body } = parseFrontmatter(content);
  const mtime = fs.statSync(filePath).mtime.toISOString();
  const timestamp = meta.updated || meta.created || mtime;
  // Harness projections need the curated current state, not the full journal.
  // Truncate before ranking/compression so a long history cannot crowd the
  // structured Next item and its accepted success criteria out of the budget.
  const lines = body.split('\n');
  let cut = lines.findIndex(line => /^---+\s*$/.test(line));
  if (cut < 0 || cut > 24) cut = 24;
  const current = lines.slice(0, cut).join('\n').trim();

  return [{
    source: '.intent/status.md',
    sourceType: 'intent',
    kind: 'state',
    content: current,
    timestamp,
    metadata: { frontmatter: meta },
  }];
}

function parseNext(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const { meta, body } = parseFrontmatter(content);
  const mtime = fs.statSync(filePath).mtime.toISOString();
  const timestamp = meta.updated || meta.created || mtime;
  const lines = body.split('\n');
  const sectionIndexes = lines
    .map((line, index) => (/^##\s+/.test(line) ? index : -1))
    .filter(index => index >= 0);
  const cut = sectionIndexes.length > 1
    ? sectionIndexes[1]
    : Math.min(lines.length, 24);

  return [{
    source: '.intent/next.md',
    sourceType: 'intent',
    kind: 'state',
    content: lines.slice(0, cut).join('\n').trim(),
    timestamp,
    metadata: { frontmatter: meta },
  }];
}

function parseNarrative(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const { meta, body } = parseFrontmatter(content);
  const mtime = fs.statSync(filePath).mtime.toISOString();
  const timestamp = meta.updated || meta.created || mtime;

  return [{
    source: '.intent/narrative.md',
    sourceType: 'intent',
    kind: 'identity',
    content: body.trim(),
    timestamp,
    metadata: { frontmatter: meta },
  }];
}

function parseProjectJson(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const mtime = fs.statSync(filePath).mtime.toISOString();
  let data;
  try { data = JSON.parse(raw); } catch { return []; }

  const chunks = [];

  // Project identity
  const identityParts = [];
  if (data.name) identityParts.push(`**Name**: ${data.name}`);
  if (data.tldr) identityParts.push(`**TLDR**: ${data.tldr}`);
  if (data.archetype) identityParts.push(`**Type**: ${data.archetype}`);
  if (identityParts.length > 0) {
    chunks.push({
      source: '.intent/project.json',
      sourceType: 'intent',
      kind: 'identity',
      content: identityParts.join('\n'),
      timestamp: mtime,
      metadata: {},
    });
  }

  // Decision gate constraints
  const gate = data.decisionGate;
  if (gate?.constraints) {
    const c = gate.constraints;
    const lines = [];
    if (c.budget > 0) lines.push(`Budget: $${c.budget}`);
    if (c.timeHoursPerWeek > 0) lines.push(`Time: ${c.timeHoursPerWeek} hrs/week`);
    if (c.skillLevel) lines.push(`Skill: ${c.skillLevel}`);
    if (c.urgency) lines.push(`Urgency: ${c.urgency}`);
    if (c.autonomy) lines.push(`Autonomy: ${c.autonomy}`);

    chunks.push({
      source: '.intent/project.json:constraints',
      sourceType: 'intent',
      kind: 'constraint',
      content: lines.join('\n'),
      timestamp: gate.createdAt || mtime,
      metadata: { constraints: c },
    });
  }

  // Success criteria
  if (gate?.successCriteria?.length > 0) {
    chunks.push({
      source: '.intent/project.json:success',
      sourceType: 'intent',
      kind: 'identity',
      content: 'Success criteria:\n' + gate.successCriteria.map(c => `- ${c}`).join('\n'),
      timestamp: gate.createdAt || mtime,
      metadata: {},
    });
  }

  // Responsibility split
  if (gate?.responsibilitySplit) {
    const lines = [];
    const aiResponsibilities = flattenAiResponsibilities(gate.responsibilitySplit.ai);
    if (aiResponsibilities.length > 0) {
      lines.push('AI can handle:');
      aiResponsibilities.forEach(r => lines.push(`- ${r}`));
    }
    if (gate.responsibilitySplit.human?.length > 0) {
      lines.push('Requires human:');
      gate.responsibilitySplit.human.forEach(r => lines.push(`- ${r}`));
    }
    if (lines.length > 0) {
      chunks.push({
        source: '.intent/project.json:responsibilities',
        sourceType: 'intent',
        kind: 'constraint',
        content: lines.join('\n'),
        timestamp: gate.createdAt || mtime,
        metadata: {},
      });
    }
  }

  // Actions as state
  if (data.actions?.length > 0) {
    const active = data.actions.filter(a => a.state !== 'reconciled');
    if (active.length > 0) {
      chunks.push({
        source: '.intent/project.json:actions',
        sourceType: 'intent',
        kind: 'action',
        content: active.map(a => `- [${a.state}] ${a.intent} (${a.category})`).join('\n'),
        timestamp: mtime,
        metadata: {},
      });
    }
  }

  return chunks;
}

function parseNextJson(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const mtime = fs.statSync(filePath).mtime.toISOString();
  let data;
  try { data = JSON.parse(raw); } catch { return []; }
  const items = Array.isArray(data?.items) ? data.items : [];
  const item = items.find(candidate => candidate?.state === 'now') ||
    items.find(candidate => candidate?.state === 'next');
  if (!item || !item.title) return [];

  const lines = [
    `**${item.state === 'now' ? 'Now' : 'Up next'}**: ${item.title}`,
  ];
  const criteria = Array.isArray(item.criteria)
    ? item.criteria.filter(criterion => criterion?.accepted !== false && criterion?.expected)
    : [];
  if (criteria.length) {
    lines.push('Accepted success criteria:');
    criteria.forEach(criterion => {
      lines.push(`- [${criterion.type === 'human' ? 'human judgment' : 'measurable'}] ${criterion.expected}`);
    });
  }
  return [{
    source: '.intent/next.json',
    sourceType: 'intent',
    kind: 'action',
    content: lines.join('\n'),
    timestamp: item.updated || item.created || mtime,
    metadata: { itemId: item.id, state: item.state },
  }];
}

const FILE_PARSERS = {
  'vision.md': parseVision,
  'plan.md': parsePlan,
  'status.md': parseStatus,
  'next.md': parseNext,
  'narrative.md': parseNarrative,
  'project.json': parseProjectJson,
  'next.json': parseNextJson,
};

function parse(source) {
  const parser = FILE_PARSERS[source.name];
  if (!parser) return [];
  try {
    return parser(source.path);
  } catch {
    return [];
  }
}

module.exports = { parse };
