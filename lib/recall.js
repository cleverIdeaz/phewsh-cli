// Recall — the record warning you before you repeat a mistake.
//
// Every decision is labeled. When you're about to do something close to what
// you already tried and *reverted* or *failed*, phewsh should say so — once,
// quietly, before you spend the turn. This is the decision gate looking
// backward: "you've been here; it didn't hold."
//
// Pure: feed it past decisions + the new text, get back the closest prior
// regret, or null. Similarity is token-overlap (Jaccard) so it matches intent
// ("add dark mode toggle" ≈ "build the dark-mode switch"), not exact strings.

const STOP = new Set([
  'the', 'a', 'an', 'to', 'of', 'and', 'or', 'for', 'in', 'on', 'at', 'with',
  'is', 'it', 'this', 'that', 'i', 'we', 'my', 'our', 'me', 'be', 'do', 'can',
  'will', 'would', 'should', 'let', 'lets', 'please', 'just', 'make', 'add',
  'use', 'using', 'get', 'set', 'so', 'as', 'by', 'from', 'into', 'up',
]);

const REGRET = new Set(['reverted', 'failed']);

function tokens(s) {
  return new Set(
    String(s || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !STOP.has(w))
  );
}

/** Jaccard overlap of two strings' meaningful tokens, 0..1. */
function similarity(a, b) {
  const A = tokens(a), B = tokens(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * Prior reverted/failed decisions similar to `text`, most-similar first.
 * @param {object[]} decisions
 * @param {string} text
 * @param {object} [opts] { project, minSimilarity=0.5 }
 */
function recallSimilar(decisions, text, { project = null, minSimilarity = 0.5 } = {}) {
  return (decisions || [])
    .filter((d) => d && REGRET.has(d.outcome) && (!project || d.project === project))
    .map((d) => ({ ...d, similarity: similarity(text, d.summary) }))
    .filter((d) => d.similarity >= minSimilarity)
    .sort((a, b) => b.similarity - a.similarity);
}

/** The single closest prior regret, or null. */
function closestRegret(decisions, text, opts = {}) {
  const hits = recallSimilar(decisions, text, opts);
  return hits.length ? hits[0] : null;
}

module.exports = { similarity, recallSimilar, closestRegret, tokens };
