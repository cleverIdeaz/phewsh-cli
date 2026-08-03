// `phewsh ion claim` must not take its execution authority from where you stand.
//
// The serve route resolves a cloud task to exactly one DELIBERATELY REGISTERED
// repo and re-verifies its live origin before anything spawns. Run the same
// command directly in a terminal and none of that happened: `repoRoot` came from
// `git rev-parse --show-toplevel` against `process.cwd()`, and the machine's
// registry was never consulted at all. A directory containing a hand-written
// `.intent/pps.json` and a matching origin was therefore enough to execute a
// cloud task in a repo nobody ever registered.
//
// One rule, both doors: unknown, ambiguous, unregistered, moved or mismatched
// state fails closed, and an exact project id is the explicit escape hatch.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { resolveClaimWorkspace } = require('../lib/local-claim');
const { projectId } = require('../lib/projects-index');

const CLOUD_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_CLOUD_ID = '33333333-3333-4333-8333-333333333333';

function repo(name, cloudId = CLOUD_ID) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `phewsh-ws-${name}-`));
  fs.mkdirSync(path.join(dir, '.intent'));
  if (cloudId) {
    fs.writeFileSync(
      path.join(dir, '.intent', 'pps.json'),
      JSON.stringify({ adapters: { phewsh: { cloud_id: cloudId } } }),
    );
  }
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:Example/Team-App.git'], { cwd: dir });
  return {
    dir,
    // The shape callers actually pass: registry entries with the stable id
    // mapped in, exactly as `serve.js:registeredProjects()` does.
    entry: {
      id: projectId(dir), name, path: dir, remote: 'github.com/example/team-app', serve: true,
    },
  };
}

test('a registered, linked, live repo is the workspace — and cwd is not consulted for it', () => {
  const { dir, entry } = repo('bound');
  const resolved = resolveClaimWorkspace({
    cloudProjectId: CLOUD_ID,
    projects: [entry],
    cwd: dir,
  });
  assert.equal(resolved.path, dir);
  assert.equal(resolved.name, 'bound');
});

test('an unregistered repo cannot claim, however convincing its .intent/ looks', () => {
  // The whole point: this directory links itself to the cloud project and has
  // the right origin. It was simply never `phewsh project add`-ed, and that is
  // the deliberate gesture the serve route requires.
  const { dir, entry } = repo('unregistered');
  assert.throws(
    () => resolveClaimWorkspace({ cloudProjectId: CLOUD_ID, projects: [{ ...entry, serve: false }], cwd: dir }),
    (error) => error.status === 404 && /registered/i.test(error.message),
  );
  // ...and with nothing registered at all.
  assert.throws(
    () => resolveClaimWorkspace({ cloudProjectId: CLOUD_ID, projects: [], cwd: dir }),
    (error) => error.status === 404,
  );
});

test('two registered repos linked to one cloud project refuse rather than pick', () => {
  const a = repo('twin-a');
  const b = repo('twin-b');
  assert.throws(
    () => resolveClaimWorkspace({ cloudProjectId: CLOUD_ID, projects: [a.entry, b.entry], cwd: a.dir }),
    (error) => error.status === 409 && /more than one/i.test(error.message),
  );
});

test('a moved or re-pointed repo fails closed on live origin', () => {
  const { dir, entry } = repo('moved');
  assert.throws(
    () => resolveClaimWorkspace({
      cloudProjectId: CLOUD_ID,
      projects: [entry],
      cwd: dir,
      originFor: () => 'github.com/example/somewhere-else',
    }),
    (error) => error.status === 409 && /no longer matches/i.test(error.message),
  );
});

test('standing in a different repo than the one that resolved is refused, not relocated', () => {
  // Silently running somewhere other than where the person is standing is the
  // same class of surprise this whole layer exists to prevent — so it refuses
  // and names the explicit way to say what you meant.
  const bound = repo('resolved');
  const elsewhere = repo('elsewhere', null);
  const error = (() => {
    try {
      resolveClaimWorkspace({ cloudProjectId: CLOUD_ID, projects: [bound.entry], cwd: elsewhere.dir });
      return null;
    } catch (e) { return e; }
  })();
  assert.ok(error, 'a claim from an unrelated directory must not be accepted');
  assert.equal(error.status, 409);
  assert.match(error.message, /--project/, 'the refusal must name the explicit escape hatch');
});

test('an exact project id is the explicit escape hatch, and must still be linked and live', () => {
  const { dir, entry } = repo('explicit');
  const elsewhere = repo('standing-here', null);
  const id = projectId(dir);

  // Named exactly: cwd no longer has to match.
  const resolved = resolveClaimWorkspace({
    cloudProjectId: CLOUD_ID,
    projects: [entry],
    cwd: elsewhere.dir,
    requestedProjectId: id,
  });
  assert.equal(resolved.path, dir);

  // But a named project that is not linked to THIS cloud project is refused —
  // an explicit id names a repo, it does not grant one.
  assert.throws(
    () => resolveClaimWorkspace({
      cloudProjectId: OTHER_CLOUD_ID,
      projects: [entry],
      cwd: dir,
      requestedProjectId: id,
    }),
    (error) => error.status === 409 && /not linked/i.test(error.message),
  );

  // A named project that is linked to nothing cannot be claimed into either:
  // the cloud identity is read from the workspace's own .intent/, so an
  // unlinked one has no identity to read.
  const unlinked = repo('unlinked', null);
  assert.throws(
    () => resolveClaimWorkspace({
      projects: [unlinked.entry],
      cwd: dir,
      requestedProjectId: projectId(unlinked.dir),
    }),
    (error) => error.status === 409 && /not linked/i.test(error.message),
  );

  // With no id named and no cloud link in the current folder, it refuses and
  // names the escape hatch rather than guessing a project.
  assert.throws(
    () => resolveClaimWorkspace({ projects: [entry], cwd: elsewhere.dir }),
    (error) => error.status === 404 && /--project/.test(error.message),
  );

  // An unknown id is a refusal, never a fallback to the current folder.
  assert.throws(
    () => resolveClaimWorkspace({
      cloudProjectId: CLOUD_ID,
      projects: [entry],
      cwd: dir,
      requestedProjectId: 'deadbeefdeadbeef',
    }),
    (error) => error.status === 404,
  );
});

test('a cwd outside any git repository is not a reason to guess', () => {
  const { dir, entry } = repo('nogit');
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-ws-bare-'));
  assert.throws(
    () => resolveClaimWorkspace({ cloudProjectId: CLOUD_ID, projects: [entry], cwd: bare }),
    (error) => error.status === 409 && /--project/.test(error.message),
  );
  // Sanity: the same registry resolves fine from inside the repo itself.
  assert.equal(resolveClaimWorkspace({ cloudProjectId: CLOUD_ID, projects: [entry], cwd: dir }).path, dir);
});
