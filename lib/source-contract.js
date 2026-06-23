const SOURCE_CONTRACT = [
  {
    category: 'Verified runtime',
    authority: 'external/runtime',
    sources: ['package registry', 'deployment provider', 'installed runtime'],
    rule: 'Current release and deployment facts are true only when checked at the actual runtime or publication target.',
  },
  {
    category: 'Working state',
    authority: 'working-tree',
    sources: ['Git working tree', 'untracked files'],
    rule: 'Proves local uncommitted state. It must never be described as shipped.',
  },
  {
    category: 'Committed state',
    authority: 'git',
    sources: ['Git HEAD', 'commit history'],
    rule: 'Proves committed repository state, not publication or deployment.',
  },
  {
    category: 'Project intent',
    authority: 'authoritative-claim',
    sources: ['.intent/vision.md', '.intent/plan.md', '.intent/status.md', '.intent/next.md', '.intent/project.json'],
    rule: 'Authoritative for purpose, constraints, decisions, and declared status. Claims about code or releases still require verification.',
  },
  {
    category: 'Outcomes',
    authority: 'historical-evidence',
    sources: ['~/.phewsh/outcomes/decisions.json'],
    rule: 'Records user judgments after actions. It informs future choices but does not redefine repository state.',
  },
  {
    category: 'Receipts',
    authority: 'historical-evidence',
    sources: ['~/.phewsh/sessions/', '~/.phewsh/results/', '~/.phewsh/spend/', '~/.phewsh/bridge/'],
    rule: 'Proves execution events. It is never the current plan or current repository state.',
  },
  {
    category: 'Generated context',
    authority: 'generated',
    sources: ['CLAUDE.md adaptive block', '.phewsh.context', 'tool-specific generated rules'],
    rule: 'Disposable projection of stronger sources. Regenerate when safe; never resolve conflicts in its favor.',
  },
  {
    category: 'Local memory',
    authority: 'local-only',
    sources: ['~/.phewsh/', 'model memories', 'session history', 'ambient breadcrumbs'],
    rule: 'Useful recall that may disappear on another machine. Promote durable facts into intent, Git, decisions, or outcomes.',
  },
];

const RESOLUTION_ORDER = [
  'external runtime state',
  'working tree',
  'Git',
  '.intent/',
  'decisions and outcomes',
  'receipts',
  'generated context',
  'model memories and session history',
];

function formatSourceContract({ compact = false } = {}) {
  const lines = ['Source-of-truth contract:'];
  for (const item of SOURCE_CONTRACT) {
    if (compact) {
      lines.push(`- ${item.category} [${item.authority}]: ${item.sources.join(', ')}`);
    } else {
      lines.push(`- ${item.category} [${item.authority}]`);
      lines.push(`  Sources: ${item.sources.join(', ')}`);
      lines.push(`  Rule: ${item.rule}`);
    }
  }
  lines.push(`Resolution order: ${RESOLUTION_ORDER.join(' -> ')}`);
  lines.push('Conflicts stay visible; weaker sources never silently override stronger ones.');
  return lines.join('\n');
}

module.exports = { SOURCE_CONTRACT, RESOLUTION_ORDER, formatSourceContract };
