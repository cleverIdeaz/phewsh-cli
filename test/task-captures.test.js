const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  assertTaskCaptureRows,
  parseTaskCaptureManifest,
  purgeTaskCaptureDirectory,
  taskCaptureClaimRequest,
  materializeTaskCaptures,
} = require('../lib/task-captures');
const { downloadStorageObject, SUPABASE_URL } = require('../lib/supabase');

const PROJECT = 'p_123';
const TASK = '33333333-3333-4333-8333-333333333333';
const USER = '22222222-2222-4222-8222-222222222222';
const CAPTURE = '11111111-1111-4111-8111-111111111111';
const BYTES = Buffer.from('private task input');
const SHA256 = crypto.createHash('sha256').update(BYTES).digest('hex');

function taskWithCapture(overrides = {}) {
  const capture = {
    id: CAPTURE,
    kind: 'text',
    bucket: 'project-captures',
    storage_path: `${PROJECT}/${USER}/${TASK}/${CAPTURE}-brief.txt`,
    name: 'brief.txt',
    mime_type: 'text/plain',
    size_bytes: BYTES.length,
    sha256: SHA256,
    ...overrides,
  };
  return { id: TASK, title: 'Use the brief', packet: { captures: [capture] } };
}

function manifestRows(overrides = {}) {
  return [{
    id: CAPTURE,
    project_id: PROJECT,
    task_id: TASK,
    uploaded_by: USER,
    kind: 'text',
    storage_path: `${PROJECT}/${USER}/${TASK}/${CAPTURE}-brief.txt`,
    original_name: 'brief.txt',
    mime_type: 'text/plain',
    size_bytes: BYTES.length,
    sha256: SHA256,
    ...overrides,
  }];
}

test('capture manifest is project/task bound and structurally strict', () => {
  assert.equal(parseTaskCaptureManifest(taskWithCapture(), PROJECT).length, 1);
  assert.throws(
    () => parseTaskCaptureManifest(taskWithCapture({ storage_path: `other/${USER}/${TASK}/${CAPTURE}-brief.txt` }), PROJECT),
    /outside this project task/,
  );
  assert.throws(
    () => parseTaskCaptureManifest(taskWithCapture({ name: '../../secret' }), PROJECT),
    /unsafe file name/,
  );
  assert.throws(
    () => parseTaskCaptureManifest(taskWithCapture({ mime_type: 'text/html' }), PROJECT),
    /inconsistent type/,
  );
});

test('packet captures must match immutable project manifest rows', () => {
  const captures = parseTaskCaptureManifest(taskWithCapture(), PROJECT);
  assert.doesNotThrow(() => assertTaskCaptureRows(captures, manifestRows(), PROJECT, TASK));
  assert.throws(
    () => assertTaskCaptureRows(captures, manifestRows({ sha256: '0'.repeat(64) }), PROJECT, TASK),
    /does not match the immutable project manifest/,
  );
  assert.throws(
    () => assertTaskCaptureRows(captures, [], PROJECT, TASK),
    /does not match the immutable project manifest/,
  );
});

test('captured tasks use the versioned claim RPC while text-only tasks stay compatible', () => {
  assert.deepEqual(taskCaptureClaimRequest(TASK, [{}]), {
    functionName: 'claim_task_with_captures',
    params: {
      p_task_id: TASK,
      p_capture_protocol: 'private-captures-v1',
    },
  });
  assert.deepEqual(taskCaptureClaimRequest(TASK, []), {
    functionName: 'claim_task',
    params: { p_task_id: TASK },
  });
});

test('materialization verifies bytes before creating a private local file', async (t) => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-captures-'));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  let calls = 0;
  const result = await materializeTaskCaptures({
    task: taskWithCapture(),
    projectId: PROJECT,
    accessToken: 'session-token',
    homeDir,
    manifestRows: manifestRows(),
    download: async (bucket, storagePath, token) => {
      calls += 1;
      assert.equal(bucket, 'project-captures');
      assert.equal(storagePath, `${PROJECT}/${USER}/${TASK}/${CAPTURE}-brief.txt`);
      assert.equal(token, 'session-token');
      return BYTES;
    },
  });

  assert.equal(result.captures.length, 1);
  assert.equal(fs.readFileSync(result.captures[0].localPath, 'utf8'), BYTES.toString());
  assert.equal(fs.statSync(result.captures[0].localPath).mode & 0o777, 0o600);

  await materializeTaskCaptures({
    task: taskWithCapture(),
    projectId: PROJECT,
    accessToken: 'session-token',
    homeDir,
    manifestRows: manifestRows(),
    download: async () => {
      calls += 1;
      return BYTES;
    },
  });
  assert.equal(calls, 1, 'a verified immutable local file is reused');
});

test('materialization rejects a digest mismatch without exposing a final file', async (t) => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-captures-bad-'));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  await assert.rejects(
    materializeTaskCaptures({
      task: taskWithCapture(),
      projectId: PROJECT,
      accessToken: 'session-token',
      homeDir,
      manifestRows: manifestRows(),
      download: async () => Buffer.from('tampered task input'),
    }),
    /byte-count|SHA-256/,
  );
  const directory = path.join(homeDir, '.phewsh', 'task-inputs', TASK);
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('local capture cleanup accepts a unique prefix and removes only that task directory', async (t) => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-captures-clean-'));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  await materializeTaskCaptures({
    task: taskWithCapture(),
    projectId: PROJECT,
    accessToken: 'session-token',
    homeDir,
    manifestRows: manifestRows(),
    download: async () => BYTES,
  });
  const siblingTask = '44444444-4444-4444-8444-444444444444';
  const sibling = path.join(homeDir, '.phewsh', 'task-inputs', siblingTask);
  fs.mkdirSync(sibling, { recursive: true });
  fs.writeFileSync(path.join(sibling, 'keep.txt'), 'keep');

  const result = purgeTaskCaptureDirectory(TASK.slice(0, 8), { homeDir });
  assert.equal(result.removed, true);
  assert.equal(result.taskId, TASK);
  assert.equal(fs.existsSync(path.join(homeDir, '.phewsh', 'task-inputs', TASK)), false);
  assert.equal(fs.readFileSync(path.join(sibling, 'keep.txt'), 'utf8'), 'keep');
});

test('local capture cleanup rejects ambiguous prefixes and symlinked roots', () => {
  const ambiguousHome = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-captures-ambiguous-'));
  const root = path.join(ambiguousHome, '.phewsh', 'task-inputs');
  fs.mkdirSync(path.join(root, '33333333-3333-4333-8333-333333333333'), { recursive: true });
  fs.mkdirSync(path.join(root, '33333333-4444-4444-8444-444444444444'), { recursive: true });
  assert.throws(
    () => purgeTaskCaptureDirectory('33333333', { homeDir: ambiguousHome }),
    /matches multiple local input directories/,
  );
  fs.rmSync(ambiguousHome, { recursive: true, force: true });

  const symlinkHome = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-captures-symlink-'));
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-captures-target-'));
  fs.mkdirSync(path.join(symlinkHome, '.phewsh'), { recursive: true });
  fs.symlinkSync(target, path.join(symlinkHome, '.phewsh', 'task-inputs'));
  assert.throws(
    () => purgeTaskCaptureDirectory(TASK, { homeDir: symlinkHome }),
    /not a plain directory/,
  );
  fs.rmSync(symlinkHome, { recursive: true, force: true });
  fs.rmSync(target, { recursive: true, force: true });
});

test('private Storage download uses the current object route and member bearer token', async (t) => {
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return new Response(BYTES, {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    });
  };
  t.after(() => { global.fetch = originalFetch; });

  const result = await downloadStorageObject(
    'project-captures',
    `${PROJECT}/${USER}/${TASK}/${CAPTURE}-brief with space.txt`,
    'member-token',
  );
  assert.deepEqual(result, BYTES);
  assert.equal(
    request.url,
    `${SUPABASE_URL}/storage/v1/object/project-captures/`
      + `${PROJECT}/${USER}/${TASK}/${CAPTURE}-brief%20with%20space.txt`,
  );
  assert.equal(request.options.headers.Authorization, 'Bearer member-token');
});
