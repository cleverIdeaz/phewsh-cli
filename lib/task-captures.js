// Private task inputs are coordination data, not executable project truth.
// This module validates the cloud manifest, downloads exact objects with the
// member's session, and writes immutable local files for the selected harness.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash, randomBytes } = require('crypto');

const PROJECT_CAPTURE_BUCKET = 'project-captures';
const MAX_CAPTURE_FILES = 6;
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const MAX_CAPTURE_TOTAL_BYTES = 20 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,179}$/;
const CAPTURE_CLAIM_PROTOCOL = 'private-captures-v1';

const MIME_KIND = new Map([
  ['image/png', 'image'],
  ['image/jpeg', 'image'],
  ['image/webp', 'image'],
  ['audio/webm', 'audio'],
  ['audio/mpeg', 'audio'],
  ['audio/wav', 'audio'],
  ['audio/mp4', 'audio'],
  ['text/plain', 'text'],
  ['text/markdown', 'text'],
  ['application/json', 'text'],
  ['application/pdf', 'document'],
]);

function requireString(item, field) {
  const value = item?.[field];
  if (typeof value !== 'string' || !value) {
    throw new Error(`Capture manifest field ${field} is missing.`);
  }
  return value;
}

function parseTaskCaptureManifest(task, projectId) {
  const raw = task?.packet?.captures;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error('Capture manifest must be an array.');
  if (raw.length > MAX_CAPTURE_FILES) {
    throw new Error(`Capture manifest exceeds ${MAX_CAPTURE_FILES} files.`);
  }

  let totalBytes = 0;
  return raw.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`Capture ${index + 1} is not an object.`);
    }
    const id = requireString(item, 'id').toLowerCase();
    const kind = requireString(item, 'kind');
    const bucket = requireString(item, 'bucket');
    const storagePath = requireString(item, 'storage_path');
    const name = requireString(item, 'name');
    const mimeType = requireString(item, 'mime_type');
    const sha256 = requireString(item, 'sha256').toLowerCase();
    const sizeBytes = item.size_bytes;

    if (!UUID.test(id)) throw new Error(`Capture ${index + 1} has an invalid id.`);
    if (bucket !== PROJECT_CAPTURE_BUCKET) throw new Error(`Capture ${index + 1} names an unsupported bucket.`);
    if (!SAFE_NAME.test(name)) throw new Error(`Capture ${index + 1} has an unsafe file name.`);
    if (MIME_KIND.get(mimeType) !== kind) throw new Error(`Capture ${index + 1} has inconsistent type metadata.`);
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > MAX_CAPTURE_BYTES) {
      throw new Error(`Capture ${index + 1} has an invalid byte count.`);
    }
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`Capture ${index + 1} has an invalid SHA-256.`);

    const segments = storagePath.split('/');
    if (
      segments.length !== 4
      || segments[0] !== projectId
      || !UUID.test(segments[1])
      || segments[2] !== task.id
      || segments[3] !== `${id}-${name}`
    ) {
      throw new Error(`Capture ${index + 1} has a path outside this project task.`);
    }

    totalBytes += sizeBytes;
    if (totalBytes > MAX_CAPTURE_TOTAL_BYTES) {
      throw new Error('Capture manifest exceeds the 20 MiB task limit.');
    }

    return {
      id,
      kind,
      bucket,
      storagePath,
      name,
      mimeType,
      sizeBytes,
      sha256,
    };
  });
}

function assertTaskCaptureRows(captures, rows, projectId, taskId) {
  if (!Array.isArray(rows)) {
    throw new Error('Private capture manifest rows are unavailable.');
  }
  if (rows.length !== captures.length) {
    throw new Error('Private capture packet does not match the immutable project manifest.');
  }

  const byId = new Map();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || byId.has(String(row.id).toLowerCase())) {
      throw new Error('Private capture manifest contains an invalid or duplicate row.');
    }
    byId.set(String(row.id).toLowerCase(), row);
  }

  for (const capture of captures) {
    const row = byId.get(capture.id);
    const uploaderId = capture.storagePath.split('/')[1];
    if (
      !row
      || row.project_id !== projectId
      || row.task_id !== taskId
      || String(row.uploaded_by).toLowerCase() !== uploaderId.toLowerCase()
      || row.kind !== capture.kind
      || row.storage_path !== capture.storagePath
      || row.original_name !== capture.name
      || row.mime_type !== capture.mimeType
      || Number(row.size_bytes) !== capture.sizeBytes
      || String(row.sha256).toLowerCase() !== capture.sha256
    ) {
      throw new Error(`Private capture ${capture.name} does not match the immutable project manifest.`);
    }
  }
}

function taskCaptureClaimRequest(taskId, captures) {
  if (captures.length) {
    return {
      functionName: 'claim_task_with_captures',
      params: {
        p_task_id: taskId,
        p_capture_protocol: CAPTURE_CLAIM_PROTOCOL,
      },
    };
  }
  return {
    functionName: 'claim_task',
    params: { p_task_id: taskId },
  };
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function verifyBytes(capture, bytes) {
  if (bytes.length !== capture.sizeBytes) {
    throw new Error(`${capture.name} failed byte-count verification.`);
  }
  if (digest(bytes) !== capture.sha256) {
    throw new Error(`${capture.name} failed SHA-256 verification.`);
  }
}

function ensurePlainDirectory(directory) {
  if (fs.existsSync(directory)) {
    const status = fs.lstatSync(directory);
    if (status.isSymbolicLink() || !status.isDirectory()) {
      throw new Error(`Capture destination is not a plain directory: ${directory}`);
    }
    fs.chmodSync(directory, 0o700);
    return;
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const status = fs.lstatSync(directory);
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new Error(`Capture destination is not a plain directory: ${directory}`);
  }
  fs.chmodSync(directory, 0o700);
}

function purgeTaskCaptureDirectory(taskIdOrPrefix, options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const prefix = String(taskIdOrPrefix || '').trim().toLowerCase();
  if (!/^[0-9a-f-]{6,36}$/.test(prefix)) {
    throw new Error('Use at least six hexadecimal task-id characters to clean local inputs.');
  }

  const root = path.join(homeDir, '.phewsh', 'task-inputs');
  if (!fs.existsSync(root)) return { removed: false, taskId: null, directory: null };
  const rootStatus = fs.lstatSync(root);
  if (rootStatus.isSymbolicLink() || !rootStatus.isDirectory()) {
    throw new Error(`Local task-input root is not a plain directory: ${root}`);
  }

  const matches = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && UUID.test(entry.name) && entry.name.toLowerCase().startsWith(prefix))
    .map((entry) => entry.name);
  if (matches.length > 1) {
    throw new Error(`Task prefix ${prefix} matches multiple local input directories.`);
  }
  if (!matches.length) return { removed: false, taskId: null, directory: null };

  const taskId = matches[0];
  const directory = path.join(root, taskId);
  const status = fs.lstatSync(directory);
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new Error(`Local task-input path is not a plain directory: ${directory}`);
  }
  fs.rmSync(directory, { recursive: true, force: false });
  return { removed: true, taskId, directory };
}

function verifiedExistingFile(outputPath, capture) {
  if (!fs.existsSync(outputPath)) return false;
  const status = fs.lstatSync(outputPath);
  if (status.isSymbolicLink() || !status.isFile()) {
    throw new Error(`Refusing unsafe existing capture path: ${outputPath}`);
  }
  const bytes = fs.readFileSync(outputPath);
  verifyBytes(capture, bytes);
  fs.chmodSync(outputPath, 0o600);
  return true;
}

function writeNewVerifiedFile(outputPath, bytes) {
  const directory = path.dirname(outputPath);
  const partial = path.join(
    directory,
    `.partial-${process.pid}-${randomBytes(6).toString('hex')}`,
  );
  try {
    fs.writeFileSync(partial, bytes, { flag: 'wx', mode: 0o600 });
    fs.linkSync(partial, outputPath);
  } finally {
    try { fs.unlinkSync(partial); } catch { /* partial never existed or was cleaned */ }
  }
}

async function materializeTaskCaptures({
  task,
  projectId,
  accessToken,
  download,
  manifestRows,
  homeDir = os.homedir(),
}) {
  const captures = parseTaskCaptureManifest(task, projectId);
  if (!captures.length) return { directory: null, captures: [] };
  if (typeof download !== 'function') throw new Error('Private capture downloader is unavailable.');
  assertTaskCaptureRows(captures, manifestRows, projectId, task.id);

  const phewshRoot = path.join(homeDir, '.phewsh');
  const root = path.join(phewshRoot, 'task-inputs');
  const directory = path.join(root, task.id);
  ensurePlainDirectory(phewshRoot);
  ensurePlainDirectory(root);
  ensurePlainDirectory(directory);

  const materialized = [];
  for (let index = 0; index < captures.length; index += 1) {
    const capture = captures[index];
    const outputName = `${String(index + 1).padStart(2, '0')}-${capture.id.slice(0, 8)}-${capture.name}`;
    const outputPath = path.join(directory, outputName);
    if (!verifiedExistingFile(outputPath, capture)) {
      const downloaded = await download(
        capture.bucket,
        capture.storagePath,
        accessToken,
      );
      const bytes = Buffer.isBuffer(downloaded)
        ? downloaded
        : Buffer.from(downloaded);
      verifyBytes(capture, bytes);
      writeNewVerifiedFile(outputPath, bytes);
    }
    materialized.push({ ...capture, localPath: outputPath });
  }

  return { directory, captures: materialized };
}

module.exports = {
  PROJECT_CAPTURE_BUCKET,
  MAX_CAPTURE_FILES,
  MAX_CAPTURE_BYTES,
  MAX_CAPTURE_TOTAL_BYTES,
  CAPTURE_CLAIM_PROTOCOL,
  parseTaskCaptureManifest,
  assertTaskCaptureRows,
  taskCaptureClaimRequest,
  materializeTaskCaptures,
  purgeTaskCaptureDirectory,
};
