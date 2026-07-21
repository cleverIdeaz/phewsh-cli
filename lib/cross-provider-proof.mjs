// Provider-native continuity challenge + read-only verifier.
//
// `prepare` prints an exact MCP-only turn for a second provider. It deliberately
// omits the current revision so the provider must read active project context.
// `verify` reads the append-only ledger and checks the resulting records against
// their sequence numbers and claimed transport provider/client metadata.
// Native-provider identity still requires human capture or future OAuth client
// binding because User-Agent is caller-controlled.

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { mintToken } = require('./mcp-token');
const MCP = 'https://fpnpfnahwaztdlxuayyv.supabase.co/functions/v1/mcp';
const DEFAULT_PROJECT = 'Phewsh Ecosystem';
const PROOF_PROVIDERS = new Set(['anthropic', 'google', 'moonshot', 'xai']);
const RECORDED_PROVIDERS = new Set(['anthropic', 'openai', 'google', 'moonshot', 'xai']);
const CLIENT_LABELS = [
  ['claude', 'claude'],
  ['codex', 'codex'],
  ['chatgpt', 'chatgpt'],
  ['gemini', 'gemini'],
  ['kimi', 'kimi'],
  ['grok', 'grok'],
];
const CAPTURE_MEDIA_TYPES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.txt', 'text/plain'],
  ['.log', 'text/plain'],
  ['.json', 'application/json'],
]);
const MAX_CAPTURE_BYTES = 25 * 1024 * 1024;

export function parseArgs(argv) {
  const [mode = 'help', ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    const value = rest[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
    flags[key] = value;
    i += 1;
  }
  return { mode, flags };
}

export function validateChallenge(value) {
  if (!/^[a-z0-9][a-z0-9-]{7,63}$/u.test(value || '')) {
    throw new Error('Challenge must be 8–64 lowercase letters, numbers, or hyphens.');
  }
  return value;
}

export function validateProofProvider(value) {
  if (!PROOF_PROVIDERS.has(value || '')) {
    throw new Error(`Provider must be one of: ${[...PROOF_PROVIDERS].join(', ')}.`);
  }
  return value;
}

export function safeProviderLabel(value) {
  if (!value) return null;
  return RECORDED_PROVIDERS.has(value) ? value : 'unrecognized';
}

export function safeClientLabel(value) {
  if (typeof value !== 'string' || !value) return null;
  const normalized = value.toLowerCase();
  return CLIENT_LABELS.find(([marker]) => normalized.includes(marker))?.[1] || 'unrecognized';
}

export function visionAnchor(artifacts) {
  const vision = artifacts.find((artifact) => artifact.kind === 'vision')?.content || '';
  const lines = vision.split('\n');
  const heading = lines.findIndex((line) => /^#{1,6}\s+North Star\s*$/iu.test(line.trim()));
  if (heading < 0) return null;
  for (const raw of lines.slice(heading + 1)) {
    const trimmed = raw.trim();
    if (/^#{1,6}\s+/u.test(trimmed)) return null;
    const line = trimmed.replace(/^[>*_-]+\s*/u, '').replace(/\*\*|__|`/gu, '').trim();
    if (!line) continue;
    return line.match(/^.*?[.!?](?:\s|$)/u)?.[0]?.trim() || line;
  }
  return null;
}

export function buildProviderPrompt({ projectId, projectName, challenge }) {
  const marker = `[PHEWSH-CROSS-PROVIDER:${challenge}]`;
  return `Use the connected Phewsh MCP server only. Do not use a shell, edit files, reveal credentials, or claim human approval.

This is a falsifiable continuity proof for project ${projectName} (${projectId}).

1. Call phewsh_get_active_context with project_id ${projectId}.
2. Let R be freshness.revision from that tool result. Do not use a revision supplied by this prompt.
3. Call phewsh_record_decision with:
   - project_id: ${projectId}
   - body: "${marker} Read project truth at revision R. Vision anchor: <V> Decision: the next AI received the same recorded Project · Next · Work · Record, not private model memory."
     Replace R with the integer you read. Replace V with the exact first sentence under the vision artifact's North Star heading.
   - verification_status: observed
   - idempotency_key: ${challenge}-decision
   - expected_revision: R
   - omit source so Phewsh records claimed transport provider/client metadata
4. Let D be the revision returned by phewsh_record_decision.
5. Call phewsh_create_handoff with:
   - project_id: ${projectId}
   - title: "${marker} Provider handoff"
   - summary: "Read project truth at revision R. Decision revision D. This bounded handoff was written through the provider's native MCP connection; private transcript and reasoning did not transfer."
     Replace R and D with the integers returned by the tools.
   - next_steps: ["Run the read-only cross-provider verifier", "Review the two events in /intent/app"]
   - idempotency_key: ${challenge}-handoff
   - expected_revision: D
   - omit source again
6. Call phewsh_get_changes_since with project_id ${projectId} and since_revision R. Confirm that both new events appear in order, then report their revisions and the loss boundary in one sentence.`;
}

export function assessChallengeEvents(events, {
  challenge, expectedProvider, expectedAnchor, clientContains = '', distinctFrom = '',
}) {
  const marker = `[PHEWSH-CROSS-PROVIDER:${challenge}]`;
  const decisions = events.filter((event) => event.event_type === 'decision_recorded'
    && typeof event.payload?.body === 'string' && event.payload.body.startsWith(marker));
  const handoffs = events.filter((event) => event.event_type === 'handoff_created'
    && event.payload?.title === `${marker} Provider handoff`);
  const decision = decisions.length === 1 ? decisions[0] : null;
  const handoff = handoffs.length === 1 ? handoffs[0] : null;
  const readRevision = Number(decision?.payload?.body?.match(/Read project truth at revision (\d+)\./u)?.[1]);
  const decisionRevision = Number(handoff?.payload?.summary?.match(/Decision revision (\d+)\./u)?.[1]);
  const clients = [decision?.source_client, handoff?.source_client].filter(Boolean);
  const decisionStillCurrent = Boolean(decision?.entity_id && !events.some((event) => (
    event.seq > decision.seq
    && event.event_type === 'decision_superseded'
    && event.payload?.supersedes_id === decision.entity_id
  )));
  const priorProviderRecorded = Boolean(decision && events.some((event) => {
    const provider = event.source_provider?.trim().toLowerCase() || '';
    return event.seq < decision.seq
      && event.entity_id !== decision.entity_id
      && event.entity_id !== handoff?.entity_id
      && event.actor_type === 'agent'
      && RECORDED_PROVIDERS.has(provider)
      && provider !== expectedProvider
      && (!distinctFrom || provider === distinctFrom);
  }));

  const checks = [
    ['exactly one challenged decision exists', decisions.length === 1],
    ['exactly one challenged handoff exists', handoffs.length === 1],
    ['challenged decision has not been superseded', decisionStillCurrent],
    ['decision revision matches ledger position', Boolean(decision) && readRevision === decision.seq - 1],
    ['decision carries the current vision anchor', Boolean(expectedAnchor)
      && decision?.payload?.body?.includes(`Vision anchor: <${expectedAnchor}>`)],
    ['handoff follows the decision', Boolean(decision && handoff) && handoff.seq === decision.seq + 1
      && decisionRevision === decision.seq],
    ['both events are agent-authored', decision?.actor_type === 'agent' && handoff?.actor_type === 'agent'],
    ['claimed provider metadata matches', decision?.source_provider === expectedProvider
      && handoff?.source_provider === expectedProvider],
    ['client provenance is stable', clients.length === 2 && clients[0] === clients[1]],
    ['client provenance matches expectation', !clientContains
      || (clients.length === 2
        && clients.every((client) => client.toLowerCase().includes(clientContains.toLowerCase())))],
    ['a different known provider appears earlier in the ledger', priorProviderRecorded],
    ['decision remains bounded to observed evidence', decision?.payload?.verification_status === 'observed'],
  ];
  return {
    checks: checks.map(([label, passed]) => [label, passed === true]),
    decision,
    handoff,
    readRevision,
    transport: {
      decision: {
        claimed_provider: safeProviderLabel(decision?.source_provider),
        client_label: safeClientLabel(decision?.source_client),
      },
      handoff: {
        claimed_provider: safeProviderLabel(handoff?.source_provider),
        client_label: safeClientLabel(handoff?.source_client),
      },
    },
  };
}

export function describeNativeCapture(file) {
  if (!file) {
    return {
      status: 'missing',
      human_review_required: true,
      boundary: 'No native provider capture is attached to this packet.',
    };
  }
  const absolute = path.resolve(file);
  const stat = statSync(absolute);
  if (!stat.isFile() || stat.size === 0) throw new Error('Native capture must be a non-empty file.');
  if (stat.size > MAX_CAPTURE_BYTES) throw new Error('Native capture must be 25 MiB or smaller.');
  const sha256 = createHash('sha256').update(readFileSync(absolute)).digest('hex');
  return {
    status: 'attached',
    media_type_hint: CAPTURE_MEDIA_TYPES.get(path.extname(absolute).toLowerCase()) || 'application/octet-stream',
    bytes: stat.size,
    sha256,
    human_review_required: true,
    boundary: 'The hash binds this packet to a separately retained capture; Phewsh does not inspect or authenticate its contents.',
  };
}

export function buildEvidenceBundle({
  challenge, project, expectedProvider, expectedAnchor, result, nativeCapture, generatedAt = new Date().toISOString(),
}) {
  const ledgerPassed = result.checks.every(([, passed]) => passed);
  const capture = nativeCapture || describeNativeCapture();
  return {
    schema_version: 1,
    kind: 'phewsh-cross-provider-continuity-evidence',
    generated_at: generatedAt,
    challenge,
    project: { id: project.id, name: project.name },
    ledger: {
      passed: ledgerPassed,
      read_revision: Number.isFinite(result.readRevision) ? result.readRevision : null,
      decision_revision: result.decision?.seq ?? null,
      handoff_revision: result.handoff?.seq ?? null,
      vision_anchor_sha256: expectedAnchor
        ? createHash('sha256').update(expectedAnchor).digest('hex')
        : null,
      checks: result.checks.map(([label, passed]) => ({ label, passed })),
    },
    transport: {
      expected_provider: expectedProvider,
      decision: result.transport?.decision || { claimed_provider: null, client_label: null },
      handoff: result.transport?.handoff || { claimed_provider: null, client_label: null },
    },
    native_capture: capture,
    review: {
      packet_complete: ledgerPassed && capture.status === 'attached',
      provider_identity: 'human_review_required',
      proof_credit: ledgerPassed && capture.status === 'attached' ? 'pending_human_review' : 'incomplete',
    },
    boundaries: [
      'This packet contains no model transcript, hidden reasoning, credential, or raw project artifact.',
      'Allowlisted provider and client labels derive from caller-controlled transport metadata, not authenticated identity.',
      'A native capture hash proves file continuity only; a human must inspect the retained capture before submission credit.',
      'OAuth client binding is the later machine-verifiable identity path.',
    ],
  };
}

export function writeEvidenceBundle(file, bundle, { captureFile = '', random = randomBytes } = {}) {
  const absolute = path.resolve(file);
  mkdirSync(path.dirname(absolute), { recursive: true });
  if (captureFile) {
    const captureReal = realpathSync(path.resolve(captureFile));
    if (existsSync(absolute)) {
      const outputReal = realpathSync(absolute);
      const captureStat = statSync(captureReal);
      const outputStat = statSync(outputReal);
      if (captureReal === outputReal
        || (captureStat.dev === outputStat.dev && captureStat.ino === outputStat.ino)) {
        throw new Error('Evidence output must not overwrite or alias the native capture.');
      }
    } else {
      const outputParent = realpathSync(path.dirname(absolute));
      const canonicalOutput = path.join(outputParent, path.basename(absolute));
      if (canonicalOutput === captureReal) {
        throw new Error('Evidence output must not overwrite or alias the native capture.');
      }
    }
  }
  let temporary = '';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const suffix = random(12).toString('hex');
    const candidate = path.join(path.dirname(absolute), `.${path.basename(absolute)}.${process.pid}.${suffix}.tmp`);
    try {
      writeFileSync(candidate, `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      temporary = candidate;
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  if (!temporary) throw new Error('Could not create a private temporary evidence file.');
  try {
    renameSync(temporary, absolute);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* best-effort cleanup */ }
    throw error;
  }
  return absolute;
}

export async function loadProofBearer({ mint = mintToken } = {}) {
  const session = await mint();
  if (!session?.token) throw new Error('No Phewsh MCP bearer available. Run phewsh login first.');
  return session.token;
}

function usage() {
  return `Usage:
  phewsh mcp proof prepare [--challenge <id>] [--project-name <name>]
  phewsh mcp proof verify --challenge <id> --provider <provider> --client-contains <text> [--distinct-from openai] [--project-name <name>] [--native-capture <file> --evidence-out <file>]`;
}

export async function runCrossProviderProof(argv = process.argv.slice(2)) {
  const { mode, flags } = parseArgs(argv);
  if (!['prepare', 'verify'].includes(mode)) {
    console.log(usage());
    return mode === 'help' ? 0 : 2;
  }

  const bearer = await loadProofBearer();

  let rpcId = 0;
  async function call(name, args = {}) {
    const response = await fetch(MCP, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bearer}`,
        'Content-Type': 'application/json',
        'User-Agent': 'phewsh cross-provider-verifier',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }),
    });
    const body = await response.json().catch(() => null);
    if (response.status !== 200) throw new Error(`MCP HTTP ${response.status}`);
    if (body?.result?.isError) throw new Error(`${name}: ${body.result.structuredContent?.code || 'tool_error'}`);
    return body?.result?.structuredContent;
  }

  const projects = await call('phewsh_list_projects');
  const projectName = flags['project-name'] || DEFAULT_PROJECT;
  const project = (projects.projects || []).find((item) => item.name === projectName);
  if (!project) throw new Error(`Cloud project not found: ${projectName}`);

  const challenge = validateChallenge(flags.challenge
    || `phewsh-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${randomBytes(4).toString('hex')}`);

  if (mode === 'prepare') {
    await call('phewsh_get_active_context', { project_id: project.id });
    console.log(`Challenge: ${challenge}\nProject: ${project.name} (${project.id})\n`);
    console.log(buildProviderPrompt({ projectId: project.id, projectName: project.name, challenge }));
    console.log(`\nCapture the native provider UI/tool log; User-Agent metadata alone does not authenticate provider identity.\nAfter the provider finishes:\n  phewsh mcp proof verify --challenge ${challenge} --provider <anthropic|google|moonshot|xai> --client-contains <native-client-marker> --distinct-from openai`);
    return 0;
  }

  const expectedProvider = validateProofProvider(flags.provider);
  if (!flags['client-contains']) throw new Error('verify requires --client-contains <native client marker>.');
  const activeContext = await call('phewsh_get_active_context', { project_id: project.id });
  const expectedAnchor = visionAnchor(activeContext.artifacts || []);
  if (!expectedAnchor) throw new Error('Could not derive the current vision North Star anchor.');
  const events = [];
  let since = 0;
  for (;;) {
    const page = await call('phewsh_get_changes_since', { project_id: project.id, since_revision: since, limit: 200 });
    events.push(...(page.events || []));
    if (!page.has_more || !page.events?.length) break;
    since = page.events.at(-1).seq;
  }

  const result = assessChallengeEvents(events, {
    challenge,
    expectedProvider,
    expectedAnchor,
    clientContains: flags['client-contains'] || '',
    distinctFrom: flags['distinct-from'] || '',
  });
  for (const [label, passed] of result.checks) console.log(`  ${passed ? '✓' : '✗'} ${label}`);
  const passed = result.checks.every(([, value]) => value);
  if (flags['native-capture'] && !flags['evidence-out']) {
    throw new Error('--native-capture requires --evidence-out so the binding is recorded.');
  }
  if (flags['evidence-out']) {
    const nativeCapture = describeNativeCapture(flags['native-capture']);
    const bundle = buildEvidenceBundle({
      challenge,
      project,
      expectedProvider,
      expectedAnchor,
      result,
      nativeCapture,
    });
    const written = writeEvidenceBundle(flags['evidence-out'], bundle, { captureFile: flags['native-capture'] });
    console.log(`\nEvidence packet: ${written}`);
    console.log(bundle.review.packet_complete
      ? 'Ledger checks and capture binding are present; provider identity still requires human review.'
      : 'Evidence packet is incomplete; no submission proof was credited.');
  }
  if (passed) {
    console.log(`\nCROSS-PROVIDER LEDGER EVIDENCE PASSED — claimed ${expectedProvider}/${result.transport.decision.client_label}; revisions ${result.decision.seq} → ${result.handoff.seq}. Native provider identity still requires human capture or OAuth client binding.`);
  } else {
    console.log('\nCROSS-PROVIDER LEDGER EVIDENCE NOT SATISFIED — no human gate was credited.');
  }
  return passed ? 0 : 1;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) runCrossProviderProof().then((code) => { process.exitCode = code; }).catch((error) => {
  console.error(`cross-provider proof: ${error.message}`);
  process.exitCode = 1;
});
