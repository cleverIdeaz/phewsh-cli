// Parse Claude auto-memory files into MemoryChunks.
// Reads individual .md files with YAML-like frontmatter (name, description, type).

const fs = require('fs');

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

// Map Claude memory types to our chunk kinds
const TYPE_TO_KIND = {
  user: 'identity',
  feedback: 'feedback',
  project: 'context',
  reference: 'reference',
};

function parse(source) {
  const content = fs.readFileSync(source.path, 'utf-8');
  const mtime = fs.statSync(source.path).mtime.toISOString();

  // MEMORY.md index file — skip, we read the linked files directly
  if (source.type === 'claude-memory') return [];

  // Individual memory files
  const { meta, body } = parseFrontmatter(content);
  if (!body.trim()) return [];

  const kind = TYPE_TO_KIND[meta.type] || 'context';

  return [{
    source: `claude-memory:${source.name}`,
    sourceType: 'claude-memory-file',
    kind,
    content: body.trim(),
    timestamp: mtime,
    metadata: {
      name: meta.name,
      description: meta.description,
      memoryType: meta.type,
    },
  }];
}

module.exports = { parse };
