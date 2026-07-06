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

// Render the open feedback queue. Pure — testable without the network.
function formatIssues(issues) {
  if (!Array.isArray(issues) || issues.length === 0) {
    return ['  No open feedback right now — the queue is clear.'];
  }
  const lines = issues.slice(0, 15).map(i => {
    const age = Math.max(0, Math.floor((Date.now() - new Date(i.created_at).getTime()) / 86400000));
    const labels = (i.labels || []).map(l => l.name).filter(Boolean).join(', ');
    return `  ${g('#' + i.number)} ${w(String(i.title).slice(0, 70))} ${g(`· ${age}d${labels ? ' · ' + labels : ''}`)}`;
  });
  lines.push('');
  lines.push(`  ${g('Pull one into the project room:')} ${cyan('phewsh dispatch "fix: <title> (#<n>)"')} ${g('— teammate or agent claims it, PR closes the loop.')}`);
  return lines;
}

// `phewsh feedback list` — read the public queue so feedback lands in
// phewsh's own loop (issue → task → claim → PR → record), with phewsh as
// the database rather than any one chat.
async function list() {
  console.log('');
  console.log(`  ${b(w('Open feedback'))} ${g('— github.com/cleverIdeaz/phewsh-cli/issues')}`);
  console.log('');
  try {
    const res = await fetch('https://api.github.com/repos/cleverIdeaz/phewsh-cli/issues?state=open&per_page=15', {
      headers: { accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    const issues = (await res.json()).filter(i => !i.pull_request); // issues only, not PRs
    formatIssues(issues).forEach(l => console.log(l));
  } catch (err) {
    console.log(`  ${g('Could not reach GitHub (' + err.message + ') — browse directly:')}`);
    console.log(`  ${w('https://github.com/cleverIdeaz/phewsh-cli/issues')}`);
  }
  console.log('');
}

function main() {
  const argv = process.argv.slice(3);
  if (argv[0] === 'list') return list();
  const text = argv.filter(a => !a.startsWith('--')).join(' ');
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
module.exports.formatIssues = formatIssues;
