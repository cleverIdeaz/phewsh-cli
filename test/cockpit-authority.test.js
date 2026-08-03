const baseTest = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const MONOREPO = fs.existsSync(path.join(ROOT, 'cockpit', 'index.html'));
const test = MONOREPO ? baseTest : baseTest.skip;
const bridgeModule = MONOREPO ? require('../../cockpit/bridge-client') : null;

function response(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() { return body; },
  };
}

function queuedFetch(items) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    const next = items.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return { calls, fetchImpl };
}

test('Cockpit pairs deliberately, keeps authority in memory, and sends it only to /cockpit', async () => {
  const network = queuedFetch([
    response(202, { pairingId: 'pair-1', expiresAt: 123 }),
    response(200, {
      hostGrant: 'host-secret',
      scopes: ['host:discover', 'host:diagnostics'],
    }),
    response(200, { project: { name: 'phewsh', intentFiles: [] }, version: '0.15.83' }),
  ]);
  const bridge = bridgeModule.createCockpitBridge({
    bridge: 'http://localhost:7483',
    fetchImpl: network.fetchImpl,
    requestOptions: () => ({}),
  });

  assert.deepEqual(await bridge.readCockpit(), { state: 'authority_needed' });
  assert.equal(network.calls.length, 0, 'Cockpit probed loopback before a deliberate pairing gesture');

  const pairing = await bridge.beginPairing();
  assert.equal(pairing.state, 'pairing');
  assert.equal(network.calls[0].url, 'http://localhost:7483/host/pair/request');
  assert.deepEqual(JSON.parse(network.calls[0].options.body), { client: 'cockpit-web' });

  const paired = await bridge.completePairing(pairing.pairingId, 'ABC234');
  assert.equal(paired.state, 'paired');
  const view = await bridge.readCockpit();
  assert.equal(view.state, 'ready');
  assert.equal(network.calls[2].url, 'http://localhost:7483/cockpit');
  assert.equal(network.calls[2].options.headers['x-phewsh-host-grant'], 'host-secret');
});

test('Cockpit distinguishes expired authority, protocol errors, and an offline node', async () => {
  const expiredNetwork = queuedFetch([
    response(202, { pairingId: 'pair-2', expiresAt: 123 }),
    response(200, {
      hostGrant: 'host-expiring',
      scopes: ['host:discover', 'host:diagnostics'],
    }),
    response(401, { error: 'expired' }),
  ]);
  const expired = bridgeModule.createCockpitBridge({
    fetchImpl: expiredNetwork.fetchImpl,
    requestOptions: () => ({}),
  });
  const pairing = await expired.beginPairing();
  await expired.completePairing(pairing.pairingId, 'ABC234');
  assert.deepEqual(await expired.readCockpit(), { state: 'authority_needed', status: 401 });
  assert.equal(expired.isPaired(), false);

  const malformedNetwork = queuedFetch([
    response(202, { pairingId: 'pair-3', expiresAt: 123 }),
    response(200, {
      hostGrant: 'host-valid',
      scopes: ['host:discover', 'host:diagnostics'],
    }),
    { status: 200, ok: true, async json() { throw new SyntaxError('bad json'); } },
  ]);
  const malformed = bridgeModule.createCockpitBridge({
    fetchImpl: malformedNetwork.fetchImpl,
    requestOptions: () => ({}),
  });
  const malformedPairing = await malformed.beginPairing();
  await malformed.completePairing(malformedPairing.pairingId, 'ABC234');
  assert.deepEqual(await malformed.readCockpit(), { state: 'bridge_error', status: 200 });

  const offlineNetwork = queuedFetch([new TypeError('connection refused')]);
  const offline = bridgeModule.createCockpitBridge({
    fetchImpl: offlineNetwork.fetchImpl,
    requestOptions: () => ({}),
  });
  assert.deepEqual(await offline.beginPairing(), { state: 'offline' });
});

test('public Cockpit explains diagnostics authority and never asks for global receipts', () => {
  const html = fs.readFileSync(path.join(ROOT, 'cockpit', 'index.html'), 'utf8');
  assert.match(html, /bridge-client\.js/);
  assert.match(html, /registered project names and device diagnostics/i);
  assert.match(html, /cannot run work, write project truth, or open the global receipt feed/i);
  assert.match(html, /phewsh receipts/);
  assert.doesNotMatch(html, /BRIDGE\s*\+\s*['"]\/receipts|fetch\([^)]*\/receipts/);
  assert.doesNotMatch(html, /localStorage|sessionStorage|document\.cookie|URLSearchParams/);
});
