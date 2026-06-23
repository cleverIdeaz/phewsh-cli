// Find the nearest known command to a typo — so an unknown slash command
// becomes "did you mean /clarify?" instead of a dead end. Pure + deterministic.
//
// Strategy, in order of confidence:
//   1. Exact prefix — user typed a real abbreviation (/cla → /clarify).
//   2. Small edit distance — a genuine typo (/claify → /clarify).
// Returns the single best candidate, or null when nothing is close enough.

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/**
 * @param {string} input — the unknown token (no leading slash)
 * @param {string[]} candidates — known command names
 * @param {object} [opts]
 * @param {number} [opts.maxDistance=2] — max edit distance to still suggest
 * @returns {string|null} best candidate or null
 */
function closest(input, candidates, opts = {}) {
  const maxDistance = opts.maxDistance ?? 2;
  if (!input || !candidates || candidates.length === 0) return null;
  const q = input.toLowerCase();

  // 1. Prefix match — shortest matching command wins (most specific abbrev).
  //    Require at least 2 chars so a stray "/a" doesn't latch onto everything.
  if (q.length >= 2) {
    const prefixes = candidates
      .filter(c => c.toLowerCase().startsWith(q))
      .sort((a, b) => a.length - b.length);
    if (prefixes.length) return prefixes[0];
  }

  // 2. Edit distance — nearest within threshold; scale threshold down for
  //    very short inputs so "x" doesn't "match" every 1-2 char command.
  const cap = Math.min(maxDistance, Math.max(1, Math.floor(q.length / 2) + 1));
  let best = null;
  let bestD = Infinity;
  for (const c of candidates) {
    const d = levenshtein(q, c.toLowerCase());
    if (d < bestD) { bestD = d; best = c; }
  }
  return bestD <= cap ? best : null;
}

module.exports = { closest, levenshtein };
