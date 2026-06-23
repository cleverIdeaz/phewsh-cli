// Parse CLAUDE.md into MemoryChunks.
// Critical distinction: manual sections (user-curated, high authority)
// vs generated sections (PHEWSH markers, lower authority — derivative).

const fs = require('fs');

const PHEWSH_START = '<!-- PHEWSH:START -->';
const PHEWSH_END = '<!-- PHEWSH:END -->';

function parse(source) {
  const content = fs.readFileSync(source.path, 'utf-8');
  const mtime = fs.statSync(source.path).mtime.toISOString();
  const chunks = [];

  const startIdx = content.indexOf(PHEWSH_START);
  const endIdx = content.indexOf(PHEWSH_END);

  let manualContent = content;
  let generatedContent = null;

  if (startIdx !== -1 && endIdx !== -1) {
    // Split manual from generated
    manualContent = (
      content.slice(0, startIdx) +
      content.slice(endIdx + PHEWSH_END.length)
    ).trim();

    generatedContent = content.slice(
      startIdx + PHEWSH_START.length,
      endIdx
    ).trim();
  }

  // Parse manual sections
  if (manualContent) {
    const sections = splitSections(manualContent);
    for (const section of sections) {
      if (!section.body.trim()) continue;

      const kind = classifySection(section.title);
      chunks.push({
        source: `${source.name}:${section.title || 'root'}`,
        sourceType: 'claude-md-manual',
        scope: source.scope || 'project',
        kind,
        content: section.body.trim(),
        timestamp: mtime,
        metadata: { section: section.title },
      });
    }
  }

  // Generated section — lower authority, will get deduped against .intent/
  if (generatedContent) {
    chunks.push({
      source: `${source.name}:phewsh-generated`,
      sourceType: 'claude-md-generated',
      scope: source.scope || 'project',
      kind: 'context',
      content: generatedContent,
      timestamp: mtime,
      metadata: { generated: true },
    });
  }

  return chunks;
}

function splitSections(content) {
  const sections = [];
  let current = { title: '', body: '' };

  for (const line of content.split('\n')) {
    const heading = line.match(/^(#{1,2})\s+(.+)/);
    if (heading) {
      if (current.body.trim() || current.title) {
        sections.push(current);
      }
      current = { title: heading[2], body: '' };
    } else {
      current.body += line + '\n';
    }
  }
  if (current.body.trim() || current.title) {
    sections.push(current);
  }

  return sections;
}

function classifySection(title) {
  if (!title) return 'context';
  const t = title.toLowerCase();

  if (/architect|structure|infrastructure|system|stack/.test(t)) return 'context';
  if (/convention|rule|style|format|lint/.test(t)) return 'feedback';
  if (/deploy|build|ship|ci|cd/.test(t)) return 'context';
  if (/constraint|budget|time|limit/.test(t)) return 'constraint';
  if (/product|about|what|mission|vision/.test(t)) return 'identity';
  if (/command|usage|api|endpoint/.test(t)) return 'reference';
  if (/status|progress|current|state/.test(t)) return 'state';
  if (/key|secret|env|config/.test(t)) return 'reference';
  if (/monetiz|payment|stripe|billing/.test(t)) return 'context';

  return 'context';
}

module.exports = { parse };
