const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { diagnoseIon } = require('../lib/ion-doctor');

function project() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-ion-doctor-'));
  fs.mkdirSync(path.join(cwd, '.intent'));
  fs.writeFileSync(path.join(cwd, '.intent', 'vision.md'), '# Vision\nOne truth.\n');
  fs.writeFileSync(path.join(cwd, '.intent', 'pps.json'), JSON.stringify({
    adapters: { phewsh: { cloud_id: '11111111-1111-4111-8111-111111111111' } },
  }));
  return cwd;
}

test('Ion doctor proves machine-readable preflight evidence without claiming browser proof', async () => {
  const cwd = project();
  const remote = 'github.com/example/project';
  const token = 'private-token-that-must-not-be-rendered';
  const calls = [];
  const report = await diagnoseIon({
    cwd,
    config: { supabaseUserId: 'user-1', supabaseAccessToken: token, email: 'builder@example.com' },
    registeredProjects: [{ path: cwd, remote, serve: true }],
    harnesses: [{ id: 'codex', label: 'Codex CLI', installed: true, headless: true }],
    getOrigin: () => remote,
    isGithubReady: () => true,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        status: 'ok',
        projects: [{ remote, cloudProjectId: '11111111-1111-4111-8111-111111111111' }],
      }),
    }),
    supabase: {
      select: async (table, query, accessToken) => {
        calls.push({ table, query, accessToken });
        return table === 'projects'
          ? [{ id: '11111111-1111-4111-8111-111111111111', name: 'Project', github_remote: remote }]
          : [];
      },
    },
  });

  assert.equal(report.readyForWalkthrough, true);
  assert.equal(report.summary.fail, 0);
  assert.equal(report.summary.human, 2);
  assert.equal(report.checks.find((check) => check.id === 'cloud-room').status, 'pass');
  assert.equal(report.checks.find((check) => check.id === 'realtime').status, 'human');
  assert.deepEqual(calls.map((call) => call.table), ['projects', 'tasks']);
  assert.ok(calls.every((call) => call.accessToken === token));
  assert.doesNotMatch(JSON.stringify(report), /private-token/);
  assert.doesNotMatch(JSON.stringify(report), /builder@example\.com/);
});

test('Ion doctor gives exact repair actions and offline mode makes no network claims', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-ion-doctor-empty-'));
  let fetched = false;
  const report = await diagnoseIon({
    cwd,
    config: {},
    registeredProjects: [],
    harnesses: [],
    getOrigin: () => null,
    isGithubReady: () => false,
    offline: true,
    fetchImpl: async () => { fetched = true; throw new Error('must not run'); },
  });

  assert.equal(fetched, false);
  assert.equal(report.readyForWalkthrough, false);
  assert.ok(report.summary.fail >= 7);
  assert.equal(report.summary.skip, 2);
  assert.match(report.checks.find((check) => check.id === 'project-truth').fix, /phewsh init/);
  assert.match(report.checks.find((check) => check.id === 'worker-registration').fix, /phewsh project add/);
  assert.match(report.checks.find((check) => check.id === 'github').fix, /gh auth login/);
});
