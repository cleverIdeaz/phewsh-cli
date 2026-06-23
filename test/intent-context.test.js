const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadIntentContext, summarizeProjectJson } = require('../lib/intent-context');

test('loads status and summarizes project constraints without raw JSON', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-context-'));
  const intent = path.join(root, '.intent');
  fs.mkdirSync(intent);
  fs.writeFileSync(path.join(intent, 'status.md'), '---\nupdated: 2026-06-15\n---\n# Status\nCurrent truth.\n');
  fs.writeFileSync(path.join(intent, 'project.json'), JSON.stringify({
    name: 'Test',
    decisionGate: {
      goal: 'Ship truth',
      constraints: { budget: 50, timeHoursPerWeek: 15, urgency: 'urgent', autonomy: 'delegated' },
      successCriteria: ['truth command works'],
      responsibilitySplit: {
        ai: { primary_coder: { identity: 'Codex', may: ['implementation'], may_not: ['deploy'] } },
        human: ['approve release'],
      },
    },
  }));

  const loaded = loadIntentContext(root);
  assert.deepEqual(loaded.map(item => item.file), ['status.md', 'project.json']);
  const project = loaded.find(item => item.file === 'project.json');
  assert.match(project.promptContent, /Constraints: budget \$50; time 15h\/week; urgency urgent; autonomy delegated/);
  assert.match(project.promptContent, /Codex: implementation/);
  assert.match(project.promptContent, /Codex must not: deploy/);
  assert.doesNotMatch(project.promptContent, /"decisionGate"/);
});

test('summarizeProjectJson supports legacy array responsibility splits', () => {
  const summary = summarizeProjectJson({
    decisionGate: { responsibilitySplit: { ai: ['write tests'], human: ['approve'] } },
  });
  assert.match(summary, /- write tests/);
  assert.match(summary, /- approve/);
});
