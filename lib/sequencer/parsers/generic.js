// Generic parser for .cursorrules, agent.md, soul.md, README.md, copilot-instructions.md
// These are all "read the whole file as one chunk" sources with type-appropriate kind.

const fs = require('fs');

const TYPE_TO_KIND = {
  cursor: 'feedback',     // .cursorrules are behavioral rules
  agent: 'identity',      // agent.md defines agent capabilities
  soul: 'identity',       // soul.md defines project soul
  copilot: 'feedback',    // copilot-instructions are behavioral rules
  readme: 'context',      // README is broad project context
};

// Strip phewsh's own auto-managed block so the sequencer never re-ingests its
// own output (AGENTS.md / GEMINI.md / .cursorrules are both written by phewsh
// AND read as sources — without this, each sync perturbs the next = churn loop).
function stripPhewshBlock(text) {
  return text.replace(/<!--\s*PHEWSH:START\s*-->[\s\S]*?<!--\s*PHEWSH:END\s*-->/g, '').trim();
}

function parse(source) {
  const content = stripPhewshBlock(fs.readFileSync(source.path, 'utf-8'));
  if (!content.trim()) return [];

  const mtime = fs.statSync(source.path).mtime.toISOString();
  const kind = TYPE_TO_KIND[source.type] || 'context';

  return [{
    source: source.name,
    sourceType: source.type,
    scope: source.scope || 'project',
    kind,
    content: content.trim(),
    timestamp: mtime,
    metadata: {},
  }];
}

module.exports = { parse };
