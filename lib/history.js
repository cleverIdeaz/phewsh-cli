// Persistent command history — so up-arrow remembers across sessions, like
// every serious shell and harness. Stored at ~/.phewsh/history, newest last.
//
// Never persists anything secret: lines that set an API key are skipped, so a
// key typed at the prompt can't linger on disk.

const fs = require('fs');
const path = require('path');
const os = require('os');

const FILE = path.join(os.homedir(), '.phewsh', 'history');

const SECRET = /^\/key\b/i; // /key <token> — never write the token to disk

/** Load up to `max` recent entries, oldest→newest (file order). */
function load(max = 100, file = FILE) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim().length);
    return lines.slice(-max);
  } catch {
    return [];
  }
}

/** Most-recent-first, the order Node's readline `history` option expects. */
function loadForReadline(max = 100, file = FILE) {
  return load(max, file).reverse();
}

/** Append one submitted line. No-ops on blank or secret-bearing input. */
function append(line, file = FILE) {
  if (!line || !line.trim()) return;
  if (SECRET.test(line.trim())) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, line.replace(/\r?\n/g, ' ') + '\n');
  } catch { /* read-only home — in-session history still works */ }
}

module.exports = { load, loadForReadline, append, FILE };
