const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('colliding result filenames preserve both pieces of evidence', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-result-collision-'));
  const receiptsModule = path.join(__dirname, '..', 'lib', 'receipts-data');
  const script = `
    Date.now = () => 1780000000000;
    const crypto = require('node:crypto');
    const identities = [
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
    ];
    crypto.randomUUID = () => identities.shift();

    const { recordResultFile, RESULTS_DIR } = require(${JSON.stringify(receiptsModule)});
    const first = recordResultFile({ taskId: 'same/stem', evidence: 'first' });
    const second = recordResultFile({ taskId: 'same?stem', evidence: 'second' });
    const read = file => JSON.parse(require('node:fs').readFileSync(file, 'utf-8'));
    console.log(JSON.stringify({
      first,
      second,
      firstRecord: read(first),
      secondRecord: read(second),
      files: require('node:fs').readdirSync(RESULTS_DIR),
      resultsDir: RESULTS_DIR,
    }));
  `;

  try {
    const output = execFileSync(process.execPath, ['-e', script], {
      env: { ...process.env, HOME: home },
    }).toString();
    const result = JSON.parse(output);

    assert.notEqual(result.first, result.second);
    assert.deepEqual(
      [result.firstRecord.evidence, result.secondRecord.evidence],
      ['first', 'second'],
    );
    assert.equal(result.files.length, 2);
    assert.ok(result.first.startsWith(result.resultsDir + path.sep));
    assert.ok(result.second.startsWith(result.resultsDir + path.sep));
    assert.ok(result.files.every(file => /^same-stem_[A-Za-z0-9._-]+\.json$/u.test(file)));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
