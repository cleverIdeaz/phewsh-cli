const path = require('path');

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

function visibleLength(value) {
  return String(value || '').replace(ANSI_RE, '').length;
}

function estimateTokens(value) {
  return Math.max(0, Math.ceil(String(value || '').length / 4));
}

function formatTokenCount(tokens) {
  if (tokens < 1000) return String(tokens);
  return `${(tokens / 1000).toFixed(tokens < 10000 ? 1 : 0)}k`;
}

function shouldCollapsePaste(lines, input, threshold = 300) {
  return lines.length > 1 || input.length >= threshold;
}

function formatPasteSummary(input, lineCount) {
  const chars = input.length.toLocaleString('en-US');
  const lines = lineCount > 1 ? ` · ${lineCount} lines` : '';
  return `[pasted ${chars} chars${lines} · Ctrl+O to expand]`;
}

function echoedRows(lines, prompt, columns = 80) {
  const width = Math.max(20, columns || 80);
  return lines.reduce((total, line, index) => {
    const prefix = index === 0 ? visibleLength(prompt) : 0;
    return total + Math.max(1, Math.ceil((prefix + visibleLength(line)) / width));
  }, 0);
}

function relativeFolder(cwd, home) {
  if (!cwd) return '';
  const relative = home ? path.relative(home, cwd) : cwd;
  if (home && relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return `~/${relative}`;
  }
  if (home && relative === '') return '~';
  return cwd;
}

module.exports = {
  echoedRows,
  estimateTokens,
  formatPasteSummary,
  formatTokenCount,
  relativeFolder,
  shouldCollapsePaste,
  visibleLength,
};
