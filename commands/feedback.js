// phewsh feedback — the door the launch post points at.
//
//   phewsh feedback                 open a prefilled GitHub issue in the browser
//   phewsh feedback "it broke..."   same, with your words already in the body
//
// Deliberately no hidden telemetry: everything sent is shown first, travels
// as a URL you can read, and lands in the public issue tracker. Email stays
// the quiet alternative for anything private.

const os = require('os');
const { execFileSync } = require('child_process');

const REPO_ISSUES = 'https://github.com/cleverIdeaz/phewsh-cli/issues/new';
const EMAIL = 'hello@phewsh.com';

const b = (s) => `\x1b[1m${s}\x1b[0m`;
const g = (s) => `\x1b[38;5;247m${s}\x1b[0m`;
const w = (s) => `\x1b[97m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;

function buildUrl(text) {
  const version = require('../package.json').version;
  const body = [
    text ? text.trim() : '<!-- What happened? What did you expect? -->',
    '',
    '---',
    `phewsh ${version} · ${process.platform} ${os.release()} · node ${process.version}`,
  ].join('\n');
  const params = new URLSearchParams({ title: text ? text.trim().slice(0, 72) : '', body });
  return `${REPO_ISSUES}?${params.toString()}`;
}

// Arg-array spawn only — the URL carries user text; it must never touch a shell.
function openBrowser(url) {
  try {
    if (process.platform === 'darwin') execFileSync('open', [url]);
    else if (process.platform === 'win32') execFileSync('cmd', ['/c', 'start', '', url]);
    else execFileSync('xdg-open', [url]);
    return true;
  } catch { return false; }
}

function main() {
  const text = process.argv.slice(3).filter(a => !a.startsWith('--')).join(' ');
  const url = buildUrl(text);
  console.log('');
  console.log(`  ${b(w('phewsh feedback'))} ${g('— where it breaks is exactly what we want to hear')}`);
  console.log(`  ${g('Includes only what you see: your words + version/OS/node. Nothing else.')}`);
  console.log('');
  const opened = openBrowser(url);
  if (opened) {
    console.log(`  ${cyan('●')} ${g('Opened a prefilled GitHub issue in your browser.')}`);
  } else {
    console.log(`  ${g('Open this to file it:')}`);
    console.log(`  ${w(url)}`);
  }
  console.log(`  ${g('Prefer email?')} ${w(EMAIL)}`);
  console.log('');
}

module.exports = main;
module.exports.buildUrl = buildUrl;
