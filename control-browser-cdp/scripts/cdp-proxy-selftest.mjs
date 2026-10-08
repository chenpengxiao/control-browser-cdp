#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

process.env.CDP_PROXY_MAX_PENDING = '256';
process.env.CDP_PROXY_MAX_WS_BUFFER_BYTES = '1024';
process.env.CDP_PROXY_HEARTBEAT_MS = '1000';
const { CDPConnection, ProxyService, discoverBrowserEndpoint, resolveTargetPrefix } = await import('./cdp-proxy.mjs');

async function withDiscoveryServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  try {
    return await run(port);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

const DISCOVERY_ENV = ['CDP_PROXY_WS_URL', 'CDP_PROXY_PORT', 'CDP_PROXY_PORT_FILE', 'CDP_PROXY_HOST'];

async function withDiscoveryEnvironment(values, run) {
  const previous = Object.fromEntries(DISCOVERY_ENV.map(name => [name, process.env[name]]));
  for (const name of DISCOVERY_ENV) delete process.env[name];
  Object.assign(process.env, values);
  try {
    return await run();
  } finally {
    for (const name of DISCOVERY_ENV) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
}

function discoverExplicitPort(port) {
  return withDiscoveryEnvironment({
    CDP_PROXY_PORT: String(port),
    CDP_PROXY_HOST: '127.0.0.1',
  }, discoverBrowserEndpoint);
}

async function discoverExplicitPortFile(port) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-proxy-selftest-'));
  const portFile = path.join(directory, 'DevToolsActivePort');
  fs.writeFileSync(portFile, `${port}\n/devtools/browser/stale-guid\n`, 'utf8');
  try {
    return await withDiscoveryEnvironment({
      CDP_PROXY_PORT_FILE: portFile,
      CDP_PROXY_HOST: '127.0.0.1',
    }, discoverBrowserEndpoint);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

const approvalEndpoint = await withDiscoveryServer((_request, response) => {
  response.statusCode = 404;
  response.end();
}, discoverExplicitPort);
assert.equal(approvalEndpoint.wsUrl, `ws://127.0.0.1:${approvalEndpoint.port}/devtools/browser`);
assert.equal(approvalEndpoint.approvalMode, true);
assert.match(approvalEndpoint.source, /:approval$/);

const approvalPortFileEndpoint = await withDiscoveryServer((_request, response) => {
  response.statusCode = 404;
  response.end();
}, discoverExplicitPortFile);
assert.equal(approvalPortFileEndpoint.wsUrl, `ws://127.0.0.1:${approvalPortFileEndpoint.port}/devtools/browser`);
assert.equal(approvalPortFileEndpoint.approvalMode, true);
assert.doesNotMatch(approvalPortFileEndpoint.wsUrl, /stale-guid/);

const traditionalEndpoint = await withDiscoveryServer((request, response) => {
  const port = request.socket.localPort;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({
    Browser: 'Fake Chrome',
    webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/traditional-guid`,
  }));
}, discoverExplicitPort);
assert.match(traditionalEndpoint.wsUrl, /\/devtools\/browser\/traditional-guid$/);
assert.equal(traditionalEndpoint.approvalMode, undefined);

class FakeWebSocket {
  static instances = [];
  static attachCalls = 0;
  static discoveryDelayMs = 0;
  static attachDelayMs = 10;
  static destroyDuringAttach = false;
  static detachDuringAttach = false;

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.bufferedAmount = 0;
    this.listeners = new Map();
    this.sentMethods = [];
    this.peakBufferedAmount = 0;
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit('open', {});
    });
  }

  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(listener);
  }

  emit(name, event) {
    for (const listener of this.listeners.get(name) || []) listener(event);
  }

  respond(id, result, delayMs = 0) {
    setTimeout(() => {
      if (this.readyState !== 1) return;
      this.emit('message', { data: JSON.stringify({ id, result }) });
    }, delayMs);
  }

  send(text) {
    const message = JSON.parse(text);
    const bytes = Buffer.byteLength(text);
    this.bufferedAmount += bytes;
    this.peakBufferedAmount = Math.max(this.peakBufferedAmount, this.bufferedAmount);
    setTimeout(() => { this.bufferedAmount = Math.max(0, this.bufferedAmount - bytes); }, 2);
    this.sentMethods.push(message.method);
    if (message.method === 'Target.setDiscoverTargets') {
      this.respond(message.id, {}, FakeWebSocket.discoveryDelayMs);
      return;
    }
    if (message.method === 'Runtime.fail') {
      setTimeout(() => this.emit('message', {
        data: JSON.stringify({ id: message.id, error: { code: -32_000, message: 'expected failure' } }),
      }), 0);
      return;
    }
    if (message.method === 'Runtime.never') return;
    if (message.method === 'Target.getTargets') {
      this.respond(message.id, {
        targetInfos: [{
          targetId: 'ABCDEF0123456789', type: 'page', title: 'Fake page',
          url: 'https://example.test/', attached: false,
        }],
      }, 1);
      return;
    }
    if (message.method === 'Target.attachToTarget') {
      FakeWebSocket.attachCalls += 1;
      if (FakeWebSocket.destroyDuringAttach) {
        this.emit('message', { data: JSON.stringify({
          method: 'Target.attachedToTarget',
          params: {
            sessionId: 'SESSION-STALE',
            targetInfo: { targetId: 'ABCDEF0123456789', type: 'page', title: 'Fake page', url: 'https://example.test/' },
            waitingForDebugger: false,
          },
        }) });
        setTimeout(() => this.emit('message', { data: JSON.stringify({
          method: 'Target.targetDestroyed', params: { targetId: 'ABCDEF0123456789' },
        }) }), 2);
        this.respond(message.id, { sessionId: 'SESSION-STALE' }, 10);
        return;
      }
      if (FakeWebSocket.detachDuringAttach) {
        this.emit('message', { data: JSON.stringify({
          method: 'Target.attachedToTarget',
          params: {
            sessionId: 'SESSION-DETACHED',
            targetInfo: { targetId: 'ABCDEF0123456789', type: 'page', title: 'Fake page', url: 'https://example.test/' },
            waitingForDebugger: false,
          },
        }) });
        setTimeout(() => this.emit('message', { data: JSON.stringify({
          method: 'Target.detachedFromTarget',
          params: { sessionId: 'SESSION-DETACHED', targetId: 'ABCDEF0123456789' },
        }) }), 2);
        this.respond(message.id, { sessionId: 'SESSION-DETACHED' }, 10);
        return;
      }
      this.respond(message.id, { sessionId: 'SESSION-1' }, FakeWebSocket.attachDelayMs);
      return;
    }
    if (message.method === 'Runtime.evaluate') {
      this.respond(message.id, { result: { type: 'number', value: message.params.expression } }, message.id % 7);
      return;
    }
    if (message.method === 'Page.getFrameTree') {
      this.respond(message.id, { frameTree: { frame: { id: 'MAIN', loaderId: 'LOADER-OLD', url: 'https://example.test/' } } });
      return;
    }
    this.respond(message.id, { echo: message.params, method: message.method }, message.id % 5);
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    queueMicrotask(() => this.emit('close', { code: 1006, reason: 'test close' }));
  }
}

const discoveryCalls = { count: 0 };
const cdp = new CDPConnection({
  WebSocketImpl: FakeWebSocket,
  discover: async () => {
    discoveryCalls.count += 1;
    return { wsUrl: 'ws://127.0.0.1:9222/devtools/browser/fake', source: 'selftest', host: '127.0.0.1', port: 9222 };
  },
});

await Promise.all(Array.from({ length: 100 }, () => cdp.ensureConnected()));
assert.equal(FakeWebSocket.instances.length, 1, 'concurrent connects must share one WebSocket');
assert.equal(discoveryCalls.count, 1, 'concurrent connects must share discovery');

FakeWebSocket.discoveryDelayMs = 40;
const barrierConnection = new CDPConnection({
  WebSocketImpl: FakeWebSocket,
  discover: async () => ({ wsUrl: 'ws://127.0.0.1:9222/devtools/browser/barrier', source: 'selftest' }),
});
const connecting = barrierConnection.ensureConnected();
await new Promise(resolve => setTimeout(resolve, 5));
const barrierSocket = FakeWebSocket.instances.at(-1);
const commandBehindBarrier = barrierConnection.send('Browser.getVersion');
await new Promise(resolve => setTimeout(resolve, 10));
assert.deepEqual(barrierSocket.sentMethods, ['Target.setDiscoverTargets'], 'commands must wait for connection initialization');
await Promise.all([connecting, commandBehindBarrier]);
barrierConnection.close();
FakeWebSocket.discoveryDelayMs = 0;

const socket = FakeWebSocket.instances[0];
const concurrent = await Promise.all(Array.from({ length: 200 }, (_, index) => (
  cdp.send('Runtime.evaluate', { expression: index }, 'SESSION-1')
)));
assert.deepEqual(concurrent.map(item => item.result.value), Array.from({ length: 200 }, (_, index) => index));
assert.equal(cdp.state().pendingCommands, 0, 'all correlated commands must leave the pending map');
assert.ok(socket.peakBufferedAmount <= 1024, 'WebSocket buffered bytes must stay within the configured cap');

await assert.rejects(() => cdp.send('Runtime.fail'), /expected failure/);

const eventWait = cdp.waitForEvent({ method: 'Page.loadEventFired', sessionId: 'SESSION-1', timeoutMs: 1_000 });
socket.emit('message', { data: JSON.stringify({ method: 'Page.loadEventFired', sessionId: 'OTHER', params: { timestamp: 1 } }) });
socket.emit('message', { data: JSON.stringify({ method: 'Page.loadEventFired', sessionId: 'SESSION-1', params: { timestamp: 2 } }) });
const event = await eventWait.promise;
assert.equal(event.params.timestamp, 2, 'event routing must include sessionId');

const service = new ProxyService(cdp);
const targetRefreshesBefore = socket.sentMethods.filter(method => method === 'Target.getTargets').length;
const sessions = await Promise.all(Array.from({ length: 100 }, () => service.sessionForTarget('ABCD')));
assert.equal(FakeWebSocket.attachCalls, 1, 'concurrent target acquisition must single-flight attach');
assert.equal(
  socket.sentMethods.filter(method => method === 'Target.getTargets').length - targetRefreshesBefore,
  1,
  'concurrent target resolution must single-flight one target refresh',
);
assert.ok(sessions.every(item => item.sessionId === 'SESSION-1'));

FakeWebSocket.destroyDuringAttach = true;
const staleConnection = new CDPConnection({
  WebSocketImpl: FakeWebSocket,
  discover: async () => ({ wsUrl: 'ws://127.0.0.1:9222/devtools/browser/stale', source: 'selftest' }),
});
await staleConnection.ensureConnected();
const staleService = new ProxyService(staleConnection);
await assert.rejects(() => staleService.sessionForTarget('ABCD'), /destroyed or detached while attaching/);
assert.equal(staleService.sessionsByTarget.size, 0, 'destroyed target must not regain a stale session mapping');
staleConnection.close();
FakeWebSocket.destroyDuringAttach = false;

FakeWebSocket.destroyDuringAttach = true;
const overlappingConnection = new CDPConnection({
  WebSocketImpl: FakeWebSocket,
  discover: async () => ({ wsUrl: 'ws://127.0.0.1:9222/devtools/browser/overlapping-attach', source: 'selftest' }),
});
await overlappingConnection.ensureConnected();
const overlappingService = new ProxyService(overlappingConnection);
const overlappingCallsBefore = FakeWebSocket.attachCalls;
const obsoleteAttach = overlappingService.sessionForTarget('ABCD');
const obsoleteRejected = assert.rejects(obsoleteAttach, /destroyed or detached while attaching/);
while ((overlappingService.targetEpochs.get('ABCDEF0123456789') || 0) === 0) {
  await new Promise(resolve => setTimeout(resolve, 1));
}
FakeWebSocket.destroyDuringAttach = false;
FakeWebSocket.attachDelayMs = 100;
const replacementAttach = overlappingService.sessionForTarget('ABCD');
await obsoleteRejected;
const thirdAttach = overlappingService.sessionForTarget('ABCD');
const [replacementResult, thirdResult] = await Promise.all([replacementAttach, thirdAttach]);
assert.equal(replacementResult.sessionId, thirdResult.sessionId);
assert.equal(
  FakeWebSocket.attachCalls - overlappingCallsBefore,
  2,
  'an obsolete attach completion must not delete the replacement single-flight promise',
);
overlappingConnection.close();
FakeWebSocket.attachDelayMs = 10;

FakeWebSocket.detachDuringAttach = true;
const detachedConnection = new CDPConnection({
  WebSocketImpl: FakeWebSocket,
  discover: async () => ({ wsUrl: 'ws://127.0.0.1:9222/devtools/browser/detached', source: 'selftest' }),
});
await detachedConnection.ensureConnected();
const detachedService = new ProxyService(detachedConnection);
await assert.rejects(() => detachedService.sessionForTarget('ABCD'), /destroyed or detached while attaching/);
assert.equal(detachedService.sessionsByTarget.size, 0, 'detached target must not regain a stale session mapping');
detachedConnection.close();
FakeWebSocket.detachDuringAttach = false;

const sharedConnection = new CDPConnection({
  WebSocketImpl: FakeWebSocket,
  discover: async () => ({ wsUrl: 'ws://127.0.0.1:9222/devtools/browser/shared-attach', source: 'selftest' }),
});
await sharedConnection.ensureConnected();
const sharedService = new ProxyService(sharedConnection);
FakeWebSocket.attachDelayMs = 100;
const firstAttachController = new AbortController();
const attachCallsBefore = FakeWebSocket.attachCalls;
const firstSharedAttach = sharedService.executeSafe({ op: 'attach', target: 'ABCD' }, firstAttachController.signal);
while (FakeWebSocket.attachCalls === attachCallsBefore) await new Promise(resolve => setTimeout(resolve, 1));
const secondSharedAttach = sharedService.executeSafe({ op: 'attach', target: 'ABCD' }, new AbortController().signal);
await new Promise(resolve => setTimeout(resolve, 2));
firstAttachController.abort(Object.assign(new Error('first attach client left'), { name: 'AbortError' }));
const [firstAttachResult, secondAttachResult] = await Promise.all([firstSharedAttach, secondSharedAttach]);
assert.equal(firstAttachResult.ok, false, 'the departed attach waiter must be cancelled');
assert.equal(firstAttachResult.error.name, 'AbortError');
assert.equal(secondAttachResult.ok, true, 'one waiter cancellation must not cancel a shared target attach');
assert.equal(FakeWebSocket.attachCalls, attachCallsBefore + 1, 'shared attach still must use one CDP command');
sharedConnection.close();
FakeWebSocket.attachDelayMs = 10;

let expectedLoadEmitted = false;
const navigationResult = await service.runNavigation('SESSION-1', async () => {
  setTimeout(() => socket.emit('message', { data: JSON.stringify({
    method: 'Page.navigatedWithinDocument',
    sessionId: 'SESSION-1',
    params: { frameId: 'MAIN', url: 'https://example.test/#intermediate' },
  }) }), 2);
  setTimeout(() => {
    expectedLoadEmitted = true;
    socket.emit('message', { data: JSON.stringify({
      method: 'Page.lifecycleEvent',
      sessionId: 'SESSION-1',
      params: { frameId: 'MAIN', loaderId: 'LOADER-NEW', name: 'load' },
    }) });
  }, 15);
  return { frameId: 'MAIN', loaderId: 'LOADER-NEW' };
}, { timeoutMs: 1_000, waitUntil: 'complete' });
assert.equal(navigationResult.loaderId, 'LOADER-NEW');
assert.equal(expectedLoadEmitted, true, 'same-document events must not complete a cross-document navigation');
let reloadLoadEmitted = false;
await service.runNavigation('SESSION-1', async () => {
  setTimeout(() => socket.emit('message', { data: JSON.stringify({
    method: 'Page.navigatedWithinDocument',
    sessionId: 'SESSION-1',
    params: { frameId: 'MAIN', url: 'https://example.test/#unrelated' },
  }) }), 2);
  setTimeout(() => {
    reloadLoadEmitted = true;
    socket.emit('message', { data: JSON.stringify({
      method: 'Page.lifecycleEvent',
      sessionId: 'SESSION-1',
      params: { frameId: 'MAIN', loaderId: 'LOADER-RELOAD', name: 'load' },
    }) });
  }, 15);
  return {};
}, { timeoutMs: 1_000, waitUntil: 'complete' });
assert.equal(reloadLoadEmitted, true, 'unrelated same-document events must not complete reload-like navigation');
await assert.rejects(
  () => service.runNavigation('SESSION-1', async () => ({}), { waitUntil: 'almost' }),
  /waitUntil must be/,
);

const abortController = new AbortController();
const cancelledRequest = service.executeSafe({
  op: 'raw', target: 'browser', method: 'Runtime.never', timeoutMs: 10_000,
}, abortController.signal);
await new Promise(resolve => setTimeout(resolve, 10));
abortController.abort(Object.assign(new Error('selftest client disconnect'), { name: 'AbortError' }));
const cancelledResult = await cancelledRequest;
assert.equal(cancelledResult.ok, false, 'aborted request must fail');
assert.equal(cancelledResult.error.name, 'AbortError');
assert.equal(cdp.state().pendingCommands, 0, 'aborted requests must release CDP pending slots');
assert.equal(cdp.connected, true, 'aborting one request must not close the shared browser connection');

const blockedController = new AbortController();
socket.bufferedAmount = 1024;
const blockedSentBefore = socket.sentMethods.length;
const blockedRequest = service.executeSafe({
  op: 'raw', target: 'browser', method: 'Runtime.blocked', timeoutMs: 10_000,
}, blockedController.signal);
await new Promise(resolve => setTimeout(resolve, 10));
blockedController.abort(Object.assign(new Error('cancel while waiting for writable transport'), { name: 'AbortError' }));
const blockedResult = await blockedRequest;
socket.bufferedAmount = 0;
assert.equal(blockedResult.ok, false);
assert.equal(blockedResult.error.name, 'AbortError');
assert.equal(socket.sentMethods.length, blockedSentBefore, 'aborted backpressure wait must not send the command afterward');

const lockTargetId = 'ABCDEF0123456789';
const lockStarts = [];
let releaseHeldLock;
const heldLock = service.withTargetLock(lockTargetId, async () => {
  lockStarts.push('held');
  await new Promise(resolve => { releaseHeldLock = resolve; });
});
while (!releaseHeldLock) await new Promise(resolve => setTimeout(resolve, 1));
const heldTail = service.targetLocks.get(lockTargetId);
const queuedController = new AbortController();
const cancelledQueuedAction = service.executeSafe({ op: 'type', target: 'ABCD', text: 'cancelled' }, queuedController.signal);
while (service.targetLocks.get(lockTargetId) === heldTail) await new Promise(resolve => setTimeout(resolve, 1));
queuedController.abort(Object.assign(new Error('cancel queued target action'), { name: 'AbortError' }));
const cancelledQueuedResult = await cancelledQueuedAction;
assert.equal(cancelledQueuedResult.ok, false);
const insertTextBefore = socket.sentMethods.filter(method => method === 'Input.insertText').length;
const followingAction = service.executeSafe({ op: 'type', target: 'ABCD', text: 'after' });
await new Promise(resolve => setTimeout(resolve, 10));
assert.equal(
  socket.sentMethods.filter(method => method === 'Input.insertText').length,
  insertTextBefore,
  'cancelling a queued target action must not let a later action bypass the held lock',
);
releaseHeldLock();
await Promise.all([heldLock, followingAction]);

const closingConnection = new CDPConnection({
  WebSocketImpl: FakeWebSocket,
  discover: async () => ({ wsUrl: 'ws://127.0.0.1:9222/devtools/browser/closing', source: 'selftest' }),
});
await closingConnection.ensureConnected();
const closeWaiter = closingConnection.waitForEvent({ method: 'Page.never', timeoutMs: 10_000 });
closingConnection.close();
await assert.rejects(closeWaiter.promise, /shutting down/);
const socketsBeforeNoReconnect = FakeWebSocket.instances.length;
await assert.rejects(
  () => closingConnection.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape' }, 'SESSION-1', 1_000, {
    connect: false, ignoreRequestAbort: true, internal: true,
  }),
  /not open/,
);
assert.equal(FakeWebSocket.instances.length, socketsBeforeNoReconnect, 'safety release must never reconnect a closed transport');

const heartbeatConnection = new CDPConnection({
  WebSocketImpl: FakeWebSocket,
  discover: async () => ({ wsUrl: 'ws://127.0.0.1:9222/devtools/browser/heartbeat', source: 'selftest' }),
});
await heartbeatConnection.ensureConnected();
const heartbeatSocket = FakeWebSocket.instances.at(-1);
const heartbeatPending = heartbeatConnection.send('Runtime.never').catch(error => error);
heartbeatConnection.startHeartbeat();
await new Promise(resolve => setTimeout(resolve, 1_100));
assert.equal(heartbeatSocket.readyState, 1, 'heartbeat must skip a busy connection instead of invalidating it');
heartbeatConnection.close();
await heartbeatPending;

const batch = await service.execute({
  op: 'batch',
  mode: 'parallel',
  commands: Array.from({ length: 20 }, (_, index) => ({
    op: 'raw', target: 'ABCD', method: 'Runtime.evaluate', params: { expression: index },
  })),
});
assert.equal(batch.length, 20);
assert.ok(batch.every(item => item.ok));

assert.equal(resolveTargetPrefix('abcd', [
  { targetId: 'ABCDEF0123456789' },
  { targetId: '9999999999999999' },
]).targetId, 'ABCDEF0123456789');
assert.throws(() => resolveTargetPrefix('ABCD', [
  { targetId: 'ABCDEF0123456789' },
  { targetId: 'ABCD000000000000' },
]), /ambiguous/);

const overload = Array.from({ length: 300 }, () => cdp.send('Runtime.never').then(
  value => ({ status: 'fulfilled', value }),
  reason => ({ status: 'rejected', reason }),
));
await new Promise(resolve => setTimeout(resolve, 10));
const safetyRelease = await cdp.send(
  'Input.dispatchKeyEvent',
  { type: 'keyUp', key: 'Escape' },
  'SESSION-1',
  1_000,
  { connect: false, ignoreRequestAbort: true, internal: true },
);
assert.equal(safetyRelease.method, 'Input.dispatchKeyEvent', 'safety release must bypass saturated user pending slots');
const internalOverload = Array.from({ length: 70 }, () => cdp.send(
  'Runtime.never', {}, 'SESSION-1', 10_000, { connect: false, ignoreRequestAbort: true, internal: true },
).then(
  value => ({ status: 'fulfilled', value }),
  reason => ({ status: 'rejected', reason }),
));
await new Promise(resolve => setTimeout(resolve, 10));
socket.close();
const [overloadResults, internalOverloadResults] = await Promise.all([
  Promise.all(overload),
  Promise.all(internalOverload),
]);
const backpressureRejections = overloadResults.filter(item => (
  item.status === 'rejected' && /backpressure limit/.test(item.reason.message)
)).length;
assert.equal(backpressureRejections, 44, 'pending command reservations must enforce the exact global limit');
const internalLimitRejections = internalOverloadResults.filter(item => (
  item.status === 'rejected' && /Internal CDP safety-command limit/.test(item.reason.message)
)).length;
assert.equal(internalLimitRejections, 6, 'priority safety commands must retain a fixed bounded allowance');
assert.ok(overloadResults.every(item => item.status === 'rejected'));
assert.equal(cdp.state().pendingCommands, 0, 'disconnect must reject and clear pending commands');

cdp.close();
console.log(JSON.stringify({
  ok: true,
  checks: {
    connectSingleFlight: 100,
    approvalMode404Fallback: true,
    approvalModePortFileFallback: true,
    traditionalDiscoveryPreserved: true,
    connectionInitializationBarrier: true,
    concurrentResponseRouting: concurrent.length,
    attachSingleFlight: sessions.length,
    targetRefreshSingleFlight: sessions.length,
    staleAttachRejected: true,
    replacementAttachOwnership: true,
    staleDetachRejected: true,
    parallelBatch: batch.length,
    eventSessionRouting: true,
    backpressureLimit: 256,
    websocketBufferLimitBytes: 1024,
    requestCancellation: true,
    sharedAttachCancellationIsolation: true,
    cancellationBeforeSend: true,
    cancelledLockWaiterPreservesMutualExclusion: true,
    navigationLoaderCorrelation: true,
    reloadIgnoresSameDocumentNoise: true,
    closeWaiterCleanup: true,
    noReconnectSafetyRelease: true,
    prioritySafetyRelease: true,
    boundedSafetyAllowance: 64,
    busyHeartbeatSafe: true,
    disconnectCleanup: true,
  },
}, null, 2));
