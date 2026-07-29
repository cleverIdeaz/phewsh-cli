// Compress ranked chunks to fit a target token budget.
// Rough estimate: 1 token ~= 4 chars (conservative for markdown).

const TOKEN_BUDGETS = {
  minimal: 500,
  standard: 2000,
  full: 5000,
  // The canonical native projection (selfheal.buildContextCore) declares a
  // contract: Project, current state, accepted Next criteria, constraints, and
  // the Record must survive together. On a mature project those already exceed
  // `full`, so the tail — whichever section ranks last — was being silently
  // clipped. Bounded, not unlimited: a projection must still have a ceiling.
  canonical: 6500,
  unlimited: Infinity,
};

function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

function compress(rankedChunks, budget = 'standard') {
  const maxTokens = TOKEN_BUDGETS[budget] || TOKEN_BUDGETS.standard;
  if (maxTokens === Infinity) return rankedChunks;

  // Two passes, because rank order is by weight while cost is unrelated to it.
  // A single fat chunk used to consume the budget and drop everything behind it
  // — including the two-line project identity (name + TLDR), the cheapest and
  // highest-value thing a projection can carry. A sprawling status section must
  // not be able to silently delete the project's own name from every harness's
  // context file.
  //
  // Pass 1 seats every chunk that fits whole, in rank order.
  // Pass 2 spends whatever is left truncating the best chunk that missed out.
  const result = [];
  const skipped = [];
  let totalTokens = 0;

  for (const chunk of rankedChunks) {
    const tokens = estimateTokens(chunk.content);
    if (totalTokens + tokens <= maxTokens) {
      result.push(chunk);
      totalTokens += tokens;
    } else {
      skipped.push(chunk);
    }
  }

  // Only one chunk is ever truncated, so the projection degrades in a single
  // predictable place rather than becoming a wall of fragments. `skipped` is
  // already in rank order, so the first entry is the most valuable omission.
  const remainingTokens = maxTokens - totalTokens;
  const candidate = skipped.find((c) => c.weight > 0.3);
  if (candidate && remainingTokens > 50) {
    const charBudget = remainingTokens * 4;
    const lines = candidate.content.split('\n');
    let partial = '';
    for (const line of lines) {
      if (partial.length + line.length + 1 > charBudget) {
        // Never strand a semantic heading at the budget boundary. A projection
        // that says "Current Focus:" without the focus is more misleading than
        // a small soft-budget overrun. Allow one bounded value line, then stop.
        const last = partial.trimEnd().split('\n').pop() || '';
        const needsValue = /^#{1,6}\s/.test(last) || /:\*{0,2}$/.test(last);
        if (needsValue && line.trim() && line.length <= 400) partial += line + '\n';
        break;
      }
      partial += line + '\n';
    }
    if (partial.trim()) {
      result.push({ ...candidate, content: partial.trim(), _truncated: true });
    }
  }

  return result;
}

module.exports = { compress, estimateTokens, TOKEN_BUDGETS };
