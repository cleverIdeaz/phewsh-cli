const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { linkedCloudProjectId, resolveLocalClaim, claimCommand } = require('../lib/local-claim');

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const TASK_ID = '22222222-2222-4222-8222-222222222222';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-local-claim-'));
  fs.mkdirSync(path.join(dir, '.intent'));
  fs.writeFileSync(path.join(dir, '.intent', 'pps.json'), JSON.stringify({
    adapters: { phewsh: { cloud_id: PROJECT_ID } },
  }));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:Example/Team-App.git'], { cwd: dir });
  return { dir, project: { name: 'team-app', path: dir, remote: 'github.com/example/team-app', serve: true } };
}

test('same-machine claim resolves only a linked, registered, live-remote repo', () => {
  const { dir, project } = fixture();
  assert.equal(linkedCloudProjectId(dir), PROJECT_ID);
  const claim = resolveLocalClaim({ projectId: PROJECT_ID, taskId: TASK_ID, runtimeId: 'codex' }, [project], ['codex']);
  assert.equal(claim.project.path, dir);
  assert.equal(claim.runtimeId, 'codex');
  assert.deepEqual(claimCommand('/phewsh/bin.js', claim), ['/phewsh/bin.js', 'ion', 'claim', TASK_ID, '--via', 'codex']);
});

test('same-machine claim rejects unregistered, unlinked, and stale-remote repos', () => {
  const { project } = fixture();
  assert.throws(
    () => resolveLocalClaim({ projectId: PROJECT_ID, taskId: TASK_ID }, [{ ...project, serve: false }]),
    (error) => error.status === 404 && /not linked/i.test(error.message)
  );
  assert.throws(
    () => resolveLocalClaim({ projectId: '33333333-3333-4333-8333-333333333333', taskId: TASK_ID }, [project]),
    (error) => error.status === 404 && /not linked/i.test(error.message)
  );
  assert.throws(
    () => resolveLocalClaim({ projectId: PROJECT_ID, taskId: TASK_ID }, [project], [], () => 'github.com/example/other'),
    (error) => error.status === 409 && /no longer matches/i.test(error.message)
  );
});

test('same-machine claim rejects malformed ids and unavailable harnesses before spawning', () => {
  const { project } = fixture();
  assert.throws(() => resolveLocalClaim({ projectId: '../repo', taskId: TASK_ID }, [project]), /full cloud project id/i);
  assert.throws(() => resolveLocalClaim({ projectId: PROJECT_ID, taskId: 'next' }, [project]), /full task id/i);
  assert.throws(
    () => resolveLocalClaim({ projectId: PROJECT_ID, taskId: TASK_ID, runtimeId: 'not-a-harness' }, [project], ['codex']),
    /not an installed headless harness/i
  );
});
