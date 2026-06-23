function createLineDispatcher(handleInput, {
  onError = (err) => { throw err; },
  onNoop = () => {},
  onBatch = () => {},
  schedule = setImmediate,
} = {}) {
  let pendingLines = [];
  let scheduled = false;
  let chain = Promise.resolve();

  function flush() {
    scheduled = false;
    const lines = pendingLines;
    pendingLines = [];
    const input = lines.join('\n').trim();
    if (!input) {
      onNoop();
      return;
    }
    onBatch({ input, lines });
    chain = chain.then(() => handleInput(input)).catch(onError);
  }

  function push(line) {
    pendingLines.push(String(line));
    if (scheduled) return;
    scheduled = true;
    schedule(flush);
  }

  async function drain() {
    if (scheduled) flush();
    await chain;
  }

  return { push, drain };
}

function createFailureTracker() {
  const seen = new Map();

  function classify(harnessId, message) {
    const text = String(message || '').trim();
    const firstLine = text.split('\n')[0].trim();
    const isClaudeUsageLimit = harnessId === 'claude-code'
      && /(usage|rate|session|weekly|monthly)?\s*(limit|quota)|exhaust|resets?\s/i.test(text);

    if (!isClaudeUsageLimit) {
      return { kind: 'failure', duplicate: false, key: null };
    }

    const normalized = text.toLowerCase().replace(/\s+/g, ' ').slice(0, 300);
    const key = `${harnessId}:${normalized}`;
    const count = (seen.get(key) || 0) + 1;
    seen.set(key, count);
    return {
      kind: 'usage-limit',
      duplicate: count > 1,
      key,
    };
  }

  return { classify };
}

module.exports = {
  createFailureTracker,
  createLineDispatcher,
};
