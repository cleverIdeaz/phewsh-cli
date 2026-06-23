// Rank memory chunks by recency, impact, source authority, and deduplication.
// Weight = recency * impact * sourceAuthority * dedupPenalty

const crypto = require('crypto');

// Impact by chunk kind — what matters most across all contexts
const KIND_IMPACT = {
  constraint: 1.0,
  identity: 0.9,
  feedback: 0.8,
  state: 0.7,
  action: 0.6,
  reference: 0.4,
  context: 0.5,
};

// Source authority — how much to trust this origin
const SOURCE_AUTHORITY = {
  'intent': 1.0,            // User-authored canonical intent
  'claude-md-manual': 0.9,  // User-curated CLAUDE.md sections
  'claude-md-generated': 0.5, // Machine-generated CLAUDE.md sections (derivative)
  'agent': 0.8,             // Deliberate agent identity docs
  'soul': 0.8,              // Project soul/values
  'claude-memory-file': 0.7, // AI-observed memories (may be stale)
  'claude-memory': 0.6,     // Memory index (pointers, not content)
  'cursor': 0.7,            // Tool-specific rules
  'copilot': 0.7,           // Tool-specific rules
  'readme': 0.4,            // Often stale, broad
};

function recencyScore(timestamp) {
  if (!timestamp) return 0.3;

  const now = Date.now();
  const then = new Date(timestamp).getTime();
  if (isNaN(then)) return 0.3;

  const daysAgo = (now - then) / (1000 * 60 * 60 * 24);

  if (daysAgo < 1) return 1.0;
  if (daysAgo < 7) return 0.8;
  if (daysAgo < 30) return 0.6;
  return 0.3;
}

function contentHash(content) {
  return crypto.createHash('md5').update(content.trim().toLowerCase()).digest('hex');
}

function rank(chunks) {
  // Assign raw weights
  for (const chunk of chunks) {
    const recency = recencyScore(chunk.timestamp);
    const impact = KIND_IMPACT[chunk.kind] || 0.5;
    const authority = SOURCE_AUTHORITY[chunk.sourceType] || 0.5;
    chunk.weight = recency * impact * authority;
  }

  // Deduplication: penalize near-duplicate content across sources
  const seen = new Map(); // hash → highest-weight chunk
  for (const chunk of chunks) {
    const hash = contentHash(chunk.content);
    chunk._hash = hash;

    if (seen.has(hash)) {
      const existing = seen.get(hash);
      if (chunk.weight > existing.weight) {
        existing.weight *= 0.05; // near-zero the weaker duplicate
        seen.set(hash, chunk);
      } else {
        chunk.weight *= 0.05;
      }
    } else {
      seen.set(hash, chunk);
    }
  }

  // Sort by weight descending
  chunks.sort((a, b) => b.weight - a.weight);

  return chunks;
}

module.exports = { rank, recencyScore, KIND_IMPACT, SOURCE_AUTHORITY };
