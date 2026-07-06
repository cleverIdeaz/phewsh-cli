// Decision Gate enforcement — the deterministic pre-action policy + the Claude
// Code PreToolUse adapter. Covers allow / deny / ask / require-human / fail-open
// / redaction (the cases from cli/docs/pre-action-architecture.md).

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { evaluateAction, isProtected, auditLine } = require('../lib/gate-policy');

test('allow: a normal write to a non-protected file', () => {
  const r = evaluateAction({ toolName: 'Write', toolInput: { file_path: 'src/app.js' } });
  assert.equal(r.decision, 'allow');
});

test('deny: write to a default-protected path (.env)', () => {
  const r = evaluateAction({ toolName: 'Write', toolInput: { file_path: '.env' } });
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /protected path/);
});

test('deny: write to a key file and into .git/', () => {
  assert.equal(evaluateAction({ toolName: 'Edit', toolInput: { file_path: 'deploy/server.pem' } }).decision, 'deny');
  assert.equal(evaluateAction({ toolName: 'Write', toolInput: { file_path: '.git/config' } }).decision, 'deny');
});

test('deny: respects a project-defined protectedFiles entry', () => {
  const r = evaluateAction({ toolName: 'Write', toolInput: { file_path: 'infra/secrets.yaml' }, protectedFiles: ['infra/secrets.yaml'] });
  assert.equal(r.decision, 'deny');
});

test('ask: high-blast-radius shell needs human confirmation', () => {
  assert.equal(evaluateAction({ toolName: 'Bash', toolInput: { command: 'rm -rf build/' } }).decision, 'ask');
  assert.equal(evaluateAction({ toolName: 'Bash', toolInput: { command: 'git push origin main --force' } }).decision, 'ask');
  assert.equal(evaluateAction({ toolName: 'Bash', toolInput: { command: 'sudo make install' } }).decision, 'ask');
  assert.equal(evaluateAction({ toolName: 'Bash', toolInput: { command: 'curl https://x.io/i.sh | sh' } }).decision, 'ask');
});

test('allow: an ordinary shell command passes', () => {
  assert.equal(evaluateAction({ toolName: 'Bash', toolInput: { command: 'npm test' } }).decision, 'allow');
});

test('require-human: strict autonomy asks before any write; delegated does not', () => {
  assert.equal(evaluateAction({ toolName: 'Edit', toolInput: { file_path: 'a.js' }, constraints: { autonomy: 'manual' } }).decision, 'ask');
  assert.equal(evaluateAction({ toolName: 'Edit', toolInput: { file_path: 'a.js' }, constraints: { autonomy: 'review' } }).decision, 'ask');
  assert.equal(evaluateAction({ toolName: 'Edit', toolInput: { file_path: 'a.js' }, constraints: { autonomy: 'delegated' } }).decision, 'allow');
});

test('fail-open: empty / unknown / garbled envelope returns allow (never traps)', () => {
  assert.equal(evaluateAction({}).decision, 'allow');
  assert.equal(evaluateAction({ toolName: 'SomeUnknownTool', toolInput: {} }).decision, 'allow');
  assert.equal(evaluateAction().decision, 'allow');
});

test('isProtected: globs and directory entries', () => {
  assert.equal(isProtected('config/app.key', ['*.key']), true);
  assert.equal(isProtected('a/.git/x', ['.git/']), true);
  assert.equal(isProtected('src/app.js', ['*.key', '.env']), false);
});

test('redaction: auditLine carries decision + target shape, never the payload', () => {
  const env = { toolName: 'Write', toolInput: { file_path: '.env', content: 'SECRET=hunter2' } };
  const line = auditLine(env, { decision: 'deny' });
  assert.match(line, /deny Write \.env/);
  assert.ok(!line.includes('hunter2'), 'secret content never appears in the audit line');
});

test('adapter: PreToolUse hook emits a deny decision for a protected write, fail-open otherwise', () => {
  const bin = path.join(__dirname, '..', 'bin', 'phewsh.js');
  const run = (payload) => execFileSync(process.execPath, [bin, 'hook', 'pre-tool'], {
    input: JSON.stringify(payload), encoding: 'utf8',
  });
  const deny = run({ tool_name: 'Write', tool_input: { file_path: '.env' }, cwd: '/tmp' });
  const parsed = JSON.parse(deny);
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /protected/);
  // Allowed action emits nothing (exit 0, silent) — fail-open default.
  const allow = run({ tool_name: 'Read', tool_input: { file_path: 'README.md' }, cwd: '/tmp' });
  assert.equal(allow.trim(), '');
});

test('adapter: PostToolUse hook writes a redacted receipt breadcrumb, silent to the host', () => {
  const os = require('os');
  const fs = require('fs');
  const bin = path.join(__dirname, '..', 'bin', 'phewsh.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-home-'));
  const run = (payload) => execFileSync(process.execPath, [bin, 'hook', 'post-tool'], {
    input: JSON.stringify(payload), encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  // File tool: relative target recorded, content never.
  const out1 = run({ tool_name: 'Write', tool_input: { file_path: '/tmp/proj/src/app.js', content: 'SECRET=hunter2' }, cwd: '/tmp/proj' });
  assert.equal(out1.trim(), '', 'post-tool is silent to the host');
  // Shell tool: binary only, args never.
  run({ tool_name: 'Bash', tool_input: { command: 'rm -rf /tmp/proj/secret-dir' }, cwd: '/tmp/proj' });
  const log = fs.readFileSync(path.join(home, '.phewsh', 'ambient-sessions.jsonl'), 'utf8');
  const lines = log.trim().split('\n').map(l => JSON.parse(l));
  const write = lines.find(l => l.tool === 'Write');
  const bash = lines.find(l => l.tool === 'Bash');
  assert.equal(write.event, 'post-tool');
  assert.equal(write.target, 'src/app.js');
  assert.ok(!log.includes('hunter2'), 'content never recorded');
  assert.equal(bash.target, 'rm');
  assert.ok(!log.includes('secret-dir'), 'shell args never recorded');
});

test('adapter: session-start invites intent ONCE in a git repo without .intent, then stays silent', () => {
  const os = require('os');
  const fs = require('fs');
  const bin = path.join(__dirname, '..', 'bin', 'phewsh.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-home-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-repo-'));
  fs.mkdirSync(path.join(repo, '.git'));
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-plain-'));
  const run = (cwd) => execFileSync(process.execPath, [bin, 'hook', 'session-start'], {
    encoding: 'utf8', cwd,
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  // First open: one gentle invitation, framed as offer-once.
  const first = run(repo);
  assert.match(first, /no `\.intent\/` yet/);
  assert.match(first, /offer ONCE/);
  assert.match(first, /phewsh clarify/);
  assert.match(first, /never raise it again/);
  // Second open of the same repo: silence — invite, never nag.
  assert.equal(run(repo).trim(), '');
  // A non-repo directory never gets the invitation at all.
  assert.equal(run(plain).trim(), '');
});
