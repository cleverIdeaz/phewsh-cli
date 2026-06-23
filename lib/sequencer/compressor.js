// Compress ranked chunks to fit a target token budget.
// Rough estimate: 1 token ~= 4 chars (conservative for markdown).

const TOKEN_BUDGETS = {
  minimal: 500,
  standard: 2000,
  full: 5000,
  unlimited: Infinity,
};

function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

function compress(rankedChunks, budget = 'standard') {
  const maxTokens = TOKEN_BUDGETS[budget] || TOKEN_BUDGETS.standard;
  if (maxTokens === Infinity) return rankedChunks;

  const result = [];
  let totalTokens = 0;

  for (const chunk of rankedChunks) {
    const tokens = estimateTokens(chunk.content);

    if (totalTokens + tokens <= maxTokens) {
      result.push(chunk);
      totalTokens += tokens;
    } else {
      // Partial inclusion: if chunk is large but high-weight, take first lines
      const remainingTokens = maxTokens - totalTokens;
      if (remainingTokens > 50 && chunk.weight > 0.3) {
        const charBudget = remainingTokens * 4;
        const lines = chunk.content.split('\n');
        let partial = '';
        for (const line of lines) {
          if (partial.length + line.length + 1 > charBudget) break;
          partial += line + '\n';
        }
        if (partial.trim()) {
          result.push({ ...chunk, content: partial.trim(), _truncated: true });
          totalTokens += estimateTokens(partial);
        }
      }
      break; // Budget hit
    }
  }

  return result;
}

module.exports = { compress, estimateTokens, TOKEN_BUDGETS };
