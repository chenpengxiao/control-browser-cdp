#!/usr/bin/env node

/**
 * Persistent Chrome DevTools Protocol proxy.
 *
 * One daemon owns one browser-level WebSocket. Local clients share that
 * connection through an authenticated Unix socket / Windows named pipe.
 * Node.js 22+ is required for the built-in WebSocket client.
 */

import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';

const VERSION = '1.2.0';
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const IS_WINDOWS = process.platform === 'win32';
const OPEN = 1;
const REQUEST_CONTEXT = new AsyncLocalStorage();

function envInt(name, fallback, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function optionalHttpPort() {
  const raw = (process.env.CDP_PROXY_HTTP_PORT || '').trim();
  if (!raw) return 0;
  if (!/^\d+$/.test(raw)) throw new Error('CDP_PROXY_HTTP_PORT must be an integer from 1 to 65535');
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('CDP_PROXY_HTTP_PORT must be an integer from 1 to 65535');
  }
  return port;
}

const COMMAND_TIMEOUT_MS = envInt('CDP_PROXY_COMMAND_TIMEOUT_MS', 30_000, 100, 600_000);
const CONNECT_TIMEOUT_MS = envInt('CDP_PROXY_CONNECT_TIMEOUT_MS', 10_000, 100, 120_000);
const CONNECT_ATTEMPTS = envInt('CDP_PROXY_CONNECT_ATTEMPTS', 12, 1, 100);
const HEARTBEAT_MS = envInt('CDP_PROXY_HEARTBEAT_MS', 20_000, 1_000, 600_000);
const MAX_PENDING_CDP = envInt('CDP_PROXY_MAX_PENDING', 2_048, 1, 100_000);
const MAX_CLIENT_PENDING = envInt('CDP_PROXY_MAX_CLIENT_PENDING', 256, 1, 100_000);
const MAX_SUBSCRIPTIONS_PER_CLIENT = envInt('CDP_PROXY_MAX_SUBSCRIPTIONS', 32, 1, 10_000);
const MAX_IPC_MESSAGE_BYTES = envInt('CDP_PROXY_MAX_MESSAGE_BYTES', 32 * 1024 * 1024, 1_024, 512 * 1024 * 1024);
const MAX_WS_BUFFER_BYTES = envInt('CDP_PROXY_MAX_WS_BUFFER_BYTES', 8 * 1024 * 1024, 1_024, 512 * 1024 * 1024);
const MAX_BATCH_COMMANDS = envInt('CDP_PROXY_MAX_BATCH', 1_000, 1, 100_000);
const INTERNAL_PENDING_ALLOWANCE = 64;
const IPC_TIMEOUT_GRACE_MS = 5_000;
const CONNECT_REQUEST_TIMEOUT_MS = Math.min(
  600_000,
  CONNECT_ATTEMPTS * CONNECT_TIMEOUT_MS +
    Array.from({ length: Math.max(0, CONNECT_ATTEMPTS - 1) }, (_, index) => Math.min(500 * (index + 1), 5_000))
      .reduce((sum, value) => sum + value, 0) +
    10_000,
);

const DEFAULT_RUNTIME_DIR = IS_WINDOWS
  ? path.resolve(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'codex-cdp-proxy')
  : process.env.XDG_RUNTIME_DIR
    ? path.resolve(process.env.XDG_RUNTIME_DIR, 'codex-cdp-proxy')
    : path.resolve(os.homedir(), '.cache', 'codex-cdp-proxy');
const RUNTIME_DIR = path.resolve(process.env.CDP_PROXY_RUNTIME_DIR || DEFAULT_RUNTIME_DIR);
const TOKEN_PATH = path.join(RUNTIME_DIR, 'token');
const STATE_PATH = path.join(RUNTIME_DIR, 'daemon.json');
const LOG_PATH = path.join(RUNTIME_DIR, 'proxy.log');
const LOCK_PATH = path.join(RUNTIME_DIR, 'daemon.lock');

function commandCreatesRuntimeIdentity() {
  const command = process.argv[2] || '';
  return !['', 'help', '--help', '-h', 'version', '--version', 'status', 'stop'].includes(command);
}

function readDaemonState() {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    return state && typeof state === 'object' && !Array.isArray(state) ? state : null;
  } catch {
    return null;
  }
}

function defaultSocketPath() {
  if (!IS_WINDOWS) return path.join(RUNTIME_DIR, 'proxy.sock');
  const state = readDaemonState();
  if (typeof state?.socket === 'string' && state.socket.startsWith('\\\\.\\pipe\\codex-cdp-proxy-')) return state.socket;
  let token;
  try { token = fs.readFileSync(TOKEN_PATH, 'utf8').trim(); } catch {}
  if ((!token || token.length < 32) && commandCreatesRuntimeIdentity()) token = readOrCreateToken();
  if (token?.length >= 32) {
    const key = crypto.createHash('sha256').update(`${RUNTIME_DIR}\0${token}`).digest('hex').slice(0, 20);
    return `\\\\.\\pipe\\codex-cdp-proxy-${key}`;
  }
  const unavailableKey = crypto.createHash('sha256').update(RUNTIME_DIR).digest('hex').slice(0, 20);
  return `\\\\.\\pipe\\codex-cdp-proxy-unavailable-${unavailableKey}`;
}

const SOCKET_PATH = process.env.CDP_PROXY_SOCKET || defaultSocketPath();
const SOCKET_OVERRIDDEN = Boolean(process.env.CDP_PROXY_SOCKET);

function ensureRuntimeDir() {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 });
  if (!IS_WINDOWS) {
    try { fs.chmodSync(RUNTIME_DIR, 0o700); } catch {}
  }
}

function readOrCreateToken() {
  ensureRuntimeDir();
  try {
    const existing = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch {}

  const created = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(TOKEN_PATH, `${created}\n`, { flag: 'wx', mode: 0o600 });
    return created;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
    if (existing.length < 32) throw new Error(`Invalid proxy token file: ${TOKEN_PATH}`);
    return existing;
  }
}

function readExistingToken() {
  let token;
  try {
    token = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
  } catch (cause) {
    const error = new Error(`Proxy identity token is missing or unreadable: ${TOKEN_PATH}`, { cause });
    error.code = 'EIDENTITY';
    throw error;
  }
  if (token.length < 32) {
    const error = new Error(`Invalid proxy token file: ${TOKEN_PATH}`);
    error.code = 'EIDENTITY';
    throw error;
  }
  return token;
}

function tokensEqual(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function requestSignal() {
  return REQUEST_CONTEXT.getStore()?.signal;
}

function abortReason(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error('Client request was aborted');
  error.name = 'AbortError';
  return error;
}

function throwIfRequestAborted(signal = requestSignal()) {
  if (signal?.aborted) throw abortReason(signal);
}

function delay(ms, signal) {
  if (!signal) return new Promise(resolve => setTimeout(resolve, ms));
  throwIfRequestAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function waitWithSignal(promise, signal) {
  if (!signal) return promise;
  throwIfRequestAborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function errorObject(error) {
  return {
    name: error?.name || 'Error',
    message: error?.message || String(error),
    ...(error?.code != null ? { code: error.code } : {}),
    ...(error?.data != null ? { data: error.data } : {}),
  };
}

function appendLog(level, message) {
  try {
    ensureRuntimeDir();
    if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > 5 * 1024 * 1024) {
      try {
        try { fs.unlinkSync(`${LOG_PATH}.1`); } catch {}
        fs.renameSync(LOG_PATH, `${LOG_PATH}.1`);
      } catch {}
    }
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${level} ${message}\n`, { mode: 0o600 });
  } catch {}
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function browserPortFileCandidates() {
  const home = os.homedir();
  const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const preference = (process.env.CDP_PROXY_BROWSER || 'auto').toLowerCase();
  const groups = {
    chrome: IS_WINDOWS
      ? [
          path.join(local, 'Google', 'Chrome', 'User Data', 'DevToolsActivePort'),
          path.join(local, 'Google', 'Chrome Beta', 'User Data', 'DevToolsActivePort'),
          path.join(local, 'Google', 'Chrome SxS', 'User Data', 'DevToolsActivePort'),
          path.join(local, 'Google', 'Chrome for Testing', 'User Data', 'DevToolsActivePort'),
        ]
      : process.platform === 'darwin'
        ? [
            path.join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'DevToolsActivePort'),
            path.join(home, 'Library', 'Application Support', 'Google', 'Chrome Beta', 'DevToolsActivePort'),
            path.join(home, 'Library', 'Application Support', 'Google', 'Chrome for Testing', 'DevToolsActivePort'),
          ]
        : [
            path.join(home, '.config', 'google-chrome', 'DevToolsActivePort'),
            path.join(home, '.config', 'google-chrome-beta', 'DevToolsActivePort'),
          ],
    edge: IS_WINDOWS
      ? [
          path.join(local, 'Microsoft', 'Edge', 'User Data', 'DevToolsActivePort'),
          path.join(local, 'Microsoft', 'Edge Beta', 'User Data', 'DevToolsActivePort'),
          path.join(local, 'Microsoft', 'Edge Dev', 'User Data', 'DevToolsActivePort'),
          path.join(local, 'Microsoft', 'Edge SxS', 'User Data', 'DevToolsActivePort'),
        ]
      : process.platform === 'darwin'
        ? [path.join(home, 'Library', 'Application Support', 'Microsoft Edge', 'DevToolsActivePort')]
        : [path.join(home, '.config', 'microsoft-edge', 'DevToolsActivePort')],
    brave: IS_WINDOWS
      ? [path.join(local, 'BraveSoftware', 'Brave-Browser', 'User Data', 'DevToolsActivePort')]
      : process.platform === 'darwin'
        ? [path.join(home, 'Library', 'Application Support', 'BraveSoftware', 'Brave-Browser', 'DevToolsActivePort')]
        : [path.join(home, '.config', 'BraveSoftware', 'Brave-Browser', 'DevToolsActivePort')],
    chromium: IS_WINDOWS
      ? [path.join(local, 'Chromium', 'User Data', 'DevToolsActivePort')]
      : process.platform === 'darwin'
        ? [path.join(home, 'Library', 'Application Support', 'Chromium', 'DevToolsActivePort')]
        : [path.join(home, '.config', 'chromium', 'DevToolsActivePort')],
  };

  const order = preference === 'auto'
    ? ['chrome', 'edge', 'brave', 'chromium']
    : Object.hasOwn(groups, preference)
      ? [preference]
      : ['chrome', 'edge', 'brave', 'chromium'];
  return unique([process.env.CDP_PROXY_PORT_FILE, ...order.flatMap(name => groups[name])]);
}

async function fetchJson(url, timeoutMs = 2_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function parsePortFile(portFile, host) {
  const lines = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
  const port = /^\d+$/.test(lines[0] || '') ? Number(lines[0]) : NaN;
  const wsPath = lines[1]?.trim();
  if (!Number.isInteger(port) || port < 1 || port > 65_535 || !wsPath?.startsWith('/')) {
    throw new Error(`Invalid DevToolsActivePort file: ${portFile}`);
  }
  return {
    wsUrl: `ws://${host}:${port}${wsPath}`,
    source: portFile,
    host,
    port,
  };
}

function approvalEndpoint(host, port, source) {
  return {
    wsUrl: `ws://${host}:${port}/devtools/browser`,
    source: `${source}:approval`,
    host,
    port,
    approvalMode: true,
  };
}

function isApprovalMode404(error) {
  return error?.message === 'HTTP 404';
}

async function endpointFromPort(host, port, source, { allowApprovalFallback = false } = {}) {
  let version;
  try {
    version = await fetchJson(`http://${host}:${port}/json/version`);
  } catch (error) {
    if (allowApprovalFallback && isApprovalMode404(error)) {
      return approvalEndpoint(host, port, source);
    }
    throw error;
  }
  if (!version.webSocketDebuggerUrl) {
    throw new Error(`No webSocketDebuggerUrl at http://${host}:${port}/json/version`);
  }
  const url = new URL(version.webSocketDebuggerUrl);
  url.hostname = host;
  return { wsUrl: url.href, source, host, port, version };
}

async function endpointFromPortFile(portFile, host, { explicit = false } = {}) {
  const parsed = parsePortFile(portFile, host);
  try {
    return await endpointFromPort(host, parsed.port, portFile, { allowApprovalFallback: true });
  } catch (error) {
    if (!explicit) {
      throw new Error(`endpoint is not reachable: ${error.message}`);
    }
    // An explicitly selected DevToolsActivePort path remains authoritative
    // during non-404 transient HTTP failures. Approval-mode HTTP 404 was
    // already converted to the stable guid-less browser endpoint above.
    return parsed;
  }
}

export async function discoverBrowserEndpoint() {
  if (process.env.CDP_PROXY_WS_URL) {
    const url = new URL(process.env.CDP_PROXY_WS_URL);
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
      throw new Error('CDP_PROXY_WS_URL must use ws:// or wss://');
    }
    return { wsUrl: url.href, source: 'CDP_PROXY_WS_URL', host: url.hostname, port: Number(url.port) || null };
  }

  const host = process.env.CDP_PROXY_HOST || '127.0.0.1';
  if (process.env.CDP_PROXY_PORT) {
    const port = envInt('CDP_PROXY_PORT', 0, 1, 65_535);
    return endpointFromPort(host, port, 'CDP_PROXY_PORT', { allowApprovalFallback: true });
  }

  const failures = [];
  for (const portFile of browserPortFileCandidates()) {
    if (!fs.existsSync(portFile)) continue;
    try {
      const explicitPortFile = process.env.CDP_PROXY_PORT_FILE && (
        IS_WINDOWS
          ? path.resolve(portFile).toLowerCase() === path.resolve(process.env.CDP_PROXY_PORT_FILE).toLowerCase()
          : path.resolve(portFile) === path.resolve(process.env.CDP_PROXY_PORT_FILE)
      );
      return await endpointFromPortFile(portFile, host, { explicit: Boolean(explicitPortFile) });
    } catch (error) {
      failures.push(`${portFile}: ${error.message}`);
    }
  }

  const scanPortValues = (process.env.CDP_PROXY_SCAN_PORTS || '9222,9229,9333').split(',').map(value => value.trim());
  if (scanPortValues.some(value => !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65_535)) {
    throw new Error('CDP_PROXY_SCAN_PORTS must be a comma-separated list of ports from 1 to 65535');
  }
  const commonPorts = unique(scanPortValues.map(Number));
  for (const port of commonPorts) {
    try {
      return await endpointFromPort(host, port, `scan:${port}`);
    } catch (error) {
      failures.push(`${host}:${port}: ${error.message}`);
    }
  }

  const detail = failures.length ? `\nChecked:\n- ${failures.join('\n- ')}` : '';
  throw new Error(
    'No Chromium remote-debugging endpoint was found. Enable remote debugging once, or set ' +
    'CDP_PROXY_WS_URL / CDP_PROXY_PORT / CDP_PROXY_PORT_FILE.' + detail,
  );
}

function messageText(data) {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  return String(data);
}

class CDPError extends Error {
  constructor(method, payload) {
    super(`${method}: ${payload?.message || 'CDP command failed'}`);
    this.name = 'CDPError';
    this.code = payload?.code;
    this.data = payload?.data;
  }
}

export class CDPConnection {
  constructor({ WebSocketImpl = globalThis.WebSocket, discover = discoverBrowserEndpoint } = {}) {
    if (!WebSocketImpl) throw new Error('Node.js 22+ is required (global WebSocket is unavailable)');
    this.WebSocketImpl = WebSocketImpl;
    this.discover = discover;
    this.ws = null;
    this.connectPromise = null;
    this.endpoint = null;
    this.pending = new Map();
    this.internalPending = 0;
    this.reservedInternalSends = 0;
    this.reservedSends = 0;
    this.sendTail = Promise.resolve();
    this.listeners = new Set();
    this.disconnectListeners = new Set();
    this.nextId = 0;
    this.connectedAt = null;
    this.lastMessageAt = null;
    this.lastError = null;
    this.everConnected = false;
    this.closed = false;
    this.heartbeatTimer = null;
  }

  get connected() {
    return this.ws?.readyState === OPEN;
  }

  state() {
    return {
      connected: this.connected,
      connecting: Boolean(this.connectPromise),
      endpoint: this.endpoint ? {
        source: this.endpoint.source,
        host: this.endpoint.host,
        port: this.endpoint.port,
        ...(this.endpoint.approvalMode ? { approvalMode: true } : {}),
      } : null,
      pendingCommands: this.pending.size,
      internalPendingCommands: this.internalPending,
      reservedCommands: this.reservedSends,
      reservedInternalCommands: this.reservedInternalSends,
      connectedAt: this.connectedAt,
      lastMessageAt: this.lastMessageAt,
      lastError: this.lastError,
    };
  }

  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onDisconnect(listener) {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  startHeartbeat() {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      if (this.closed) return;
      if (this.connected) {
        const socket = this.ws;
        if (this.connectPromise || this.pending.size || this.reservedSends || socket.bufferedAmount) return;
        let sent = false;
        this.#sendConnected(
          'Browser.getVersion',
          {},
          undefined,
          Math.min(COMMAND_TIMEOUT_MS, 10_000),
          { internal: true, onSent: () => { sent = true; } },
        ).catch(error => {
          if (!sent || socket !== this.ws || this.closed) {
            this.lastError = error.message;
            return;
          }
          this.#invalidateSocket(socket, `Heartbeat failed: ${error.message}`);
        });
      } else if (this.everConnected) {
        this.ensureConnected().catch(error => {
          this.lastError = error.message;
        });
      }
    }, HEARTBEAT_MS);
    this.heartbeatTimer.unref?.();
  }

  async ensureConnected() {
    if (this.closed) throw new Error('CDP connection is closed');
    if (this.connectPromise) return this.connectPromise;
    if (this.connected) return this.state();
    this.connectPromise = this.#connectWithRetry().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  async #connectWithRetry() {
    let lastError;
    for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt += 1) {
      if (this.closed) throw new Error('CDP connection is closed');
      try {
        const endpoint = await this.discover();
        await this.#open(endpoint);
        await this.#sendConnected('Target.setDiscoverTargets', { discover: true }, undefined, CONNECT_TIMEOUT_MS);
        if (!this.connected) throw new Error('Browser CDP connection closed during initialization');
        this.endpoint = endpoint;
        this.connectedAt = new Date().toISOString();
        this.lastError = null;
        this.everConnected = true;
        return this.state();
      } catch (error) {
        lastError = error;
        this.lastError = error.message;
        this.#discardSocket();
        if (attempt < CONNECT_ATTEMPTS) {
          await delay(Math.min(500 * attempt, 5_000));
        }
      }
    }
    throw new Error(
      `Unable to establish the persistent browser CDP connection after ${CONNECT_ATTEMPTS} attempts: ` +
      `${lastError?.message || 'unknown error'}`,
    );
  }

  #open(endpoint) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let socket;
      try {
        socket = new this.WebSocketImpl(endpoint.wsUrl);
      } catch (error) {
        reject(error);
        return;
      }
      this.ws = socket;
      try { socket.binaryType = 'arraybuffer'; } catch {}

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { socket.close(); } catch {}
        reject(new Error(`WebSocket handshake timed out after ${CONNECT_TIMEOUT_MS}ms`));
      }, CONNECT_TIMEOUT_MS);
      timer.unref?.();

      const finishOpen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const failOpen = event => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`WebSocket connection failed: ${event?.message || event?.type || 'unknown error'}`));
      };
      const handleClose = event => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`WebSocket closed during handshake (${event?.code || 'no code'})`));
        }
        if (this.ws === socket) this.#handleDisconnect(event);
      };
      const handleMessage = event => {
        if (this.ws !== socket) return;
        this.#handleMessage(event);
      };

      if (typeof socket.addEventListener === 'function') {
        socket.addEventListener('open', finishOpen);
        socket.addEventListener('error', failOpen);
        socket.addEventListener('close', handleClose);
        socket.addEventListener('message', handleMessage);
      } else {
        socket.on('open', finishOpen);
        socket.on('error', failOpen);
        socket.on('close', handleClose);
        socket.on('message', data => handleMessage({ data }));
      }
    });
  }

  #handleMessage(event) {
    let message;
    try {
      message = JSON.parse(messageText(event?.data ?? event));
    } catch (error) {
      this.lastError = `Invalid CDP message: ${error.message}`;
      return;
    }
    this.lastMessageAt = new Date().toISOString();

    if (message.id != null) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      pending.cleanup?.();
      if (message.error) pending.reject(new CDPError(pending.method, message.error));
      else pending.resolve(message.result ?? {});
      return;
    }

    if (message.method) {
      for (const listener of [...this.listeners]) {
        try { listener(message); } catch (error) { this.lastError = error.message; }
      }
    }
  }

  #handleDisconnect(event) {
    const reason = `Browser CDP connection closed (${event?.code || 'no code'}${event?.reason ? `: ${event.reason}` : ''})`;
    this.ws = null;
    this.connectedAt = null;
    this.lastError = reason;
    for (const pending of this.pending.values()) {
      pending.cleanup?.();
      pending.reject(new Error(reason));
    }
    this.pending.clear();
    this.internalPending = 0;
    for (const listener of [...this.disconnectListeners]) {
      try { listener(reason); } catch {}
    }
  }

  #invalidateSocket(socket, reason) {
    if (!socket || socket !== this.ws) return;
    this.#handleDisconnect({ code: 'transport', reason });
    try { socket.close(); } catch {}
  }

  #discardSocket() {
    const socket = this.ws;
    this.ws = null;
    if (socket) {
      try { socket.close(); } catch {}
    }
  }

  async #waitForWritable(socket, frameBytes, deadline, signal) {
    if (frameBytes > MAX_WS_BUFFER_BYTES) {
      throw new Error(`CDP request frame exceeds WebSocket buffer limit (${frameBytes} > ${MAX_WS_BUFFER_BYTES} bytes)`);
    }
    if (Date.now() >= deadline) throw new Error('CDP command timed out before it could be sent');
    while (socket.bufferedAmount + frameBytes > MAX_WS_BUFFER_BYTES) {
      throwIfRequestAborted(signal);
      if (socket !== this.ws || socket.readyState !== OPEN) throw new Error('Browser CDP connection is not open');
      if (Date.now() >= deadline) throw new Error('Timed out waiting for WebSocket backpressure to drain');
      await delay(5, signal);
    }
  }

  async #withSendLock(operation, signal) {
    const previous = this.sendTail;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const tail = previous.catch(() => {}).then(() => gate);
    this.sendTail = tail;
    try {
      await waitWithSignal(previous.catch(() => {}), signal);
      throwIfRequestAborted(signal);
      return await operation();
    } finally {
      release();
      const cleanup = () => {
        if (this.sendTail === tail) this.sendTail = Promise.resolve();
      };
      tail.then(cleanup, cleanup);
    }
  }

  async send(method, params = {}, sessionId, timeoutMs = COMMAND_TIMEOUT_MS, options = {}) {
    const signal = options.ignoreRequestAbort ? undefined : (options.signal || requestSignal());
    throwIfRequestAborted(signal);
    if (options.connect === false) {
      if (!this.connected) throw new Error('Browser CDP connection is not open');
    } else {
      await this.ensureConnected();
    }
    throwIfRequestAborted(signal);
    return this.#sendConnected(method, params, sessionId, timeoutMs, { internal: options.internal === true, signal });
  }

  async #sendConnected(method, params = {}, sessionId, timeoutMs = COMMAND_TIMEOUT_MS, options = {}) {
    const { internal = false, onSent, signal } = options;
    throwIfRequestAborted(signal);
    if (typeof method !== 'string' || !method.includes('.')) throw new Error('A CDP method such as Page.navigate is required');
    if (!internal && this.pending.size - this.internalPending + this.reservedSends >= MAX_PENDING_CDP) {
      throw new Error(`CDP backpressure limit reached (${MAX_PENDING_CDP} pending commands)`);
    }
    if (internal && this.internalPending + this.reservedInternalSends >= INTERNAL_PENDING_ALLOWANCE) {
      throw new Error(`Internal CDP safety-command limit reached (${INTERNAL_PENDING_ALLOWANCE})`);
    }
    const socket = this.ws;
    if (!socket || socket.readyState !== OPEN) throw new Error('Browser CDP connection is not open');
    const deadline = Date.now() + timeoutMs;
    if (internal) this.reservedInternalSends += 1;
    else this.reservedSends += 1;
    let reservationHeld = true;
    try {
      const holder = await this.#withSendLock(async () => {
        throwIfRequestAborted(signal);
        if (socket !== this.ws || socket.readyState !== OPEN) throw new Error('Browser CDP connection changed before send');
        const id = ++this.nextId;
        const payload = { id, method, params: params || {} };
        if (sessionId) payload.sessionId = sessionId;
        const encoded = JSON.stringify(payload);
        await this.#waitForWritable(socket, Buffer.byteLength(encoded), deadline, signal);
        throwIfRequestAborted(signal);
        if (socket !== this.ws || socket.readyState !== OPEN) throw new Error('Browser CDP connection changed before send');

        const response = new Promise((resolve, reject) => {
          let abortListener;
          let registered = true;
          const cleanup = () => {
            if (!registered) return;
            registered = false;
            clearTimeout(timer);
            if (abortListener) signal?.removeEventListener('abort', abortListener);
            if (internal) this.internalPending = Math.max(0, this.internalPending - 1);
          };
          const remainingMs = Math.max(1, deadline - Date.now());
          const timer = setTimeout(() => {
            if (!this.pending.has(id)) return;
            this.pending.delete(id);
            cleanup();
            reject(new Error(`CDP command timed out after ${timeoutMs}ms: ${method}`));
          }, remainingMs);
          timer.unref?.();
          if (internal) this.internalPending += 1;
          this.pending.set(id, { resolve, reject, timer, cleanup, method });
          if (signal) {
            abortListener = () => {
              if (!this.pending.has(id)) return;
              this.pending.delete(id);
              cleanup();
              reject(abortReason(signal));
            };
            signal.addEventListener('abort', abortListener, { once: true });
            if (signal.aborted) {
              abortListener();
              return;
            }
          }
          try {
            socket.send(encoded);
            onSent?.();
          } catch (error) {
            this.pending.delete(id);
            cleanup();
            reject(error);
            this.#invalidateSocket(socket, `WebSocket send failed: ${error.message}`);
          }
        });
        return { response };
      }, signal);
      if (internal) this.reservedInternalSends -= 1;
      else this.reservedSends -= 1;
      reservationHeld = false;
      return await holder.response;
    } finally {
      if (reservationHeld) {
        if (internal) this.reservedInternalSends -= 1;
        else this.reservedSends -= 1;
      }
    }
  }

  waitForEvent({ method, sessionId, predicate, timeoutMs = COMMAND_TIMEOUT_MS }) {
    let timer;
    let off;
    let offDisconnect;
    let settled = false;
    let rejectPromise;
    const cleanup = () => {
      clearTimeout(timer);
      off?.();
      offDisconnect?.();
    };
    const promise = new Promise((resolve, reject) => {
      rejectPromise = reject;
      off = this.onEvent(message => {
        if (method && message.method !== method) return;
        if (sessionId !== undefined && message.sessionId !== sessionId) return;
        if (predicate && !predicate(message.params || {}, message)) return;
        settled = true;
        cleanup();
        resolve(message);
      });
      offDisconnect = this.onDisconnect(reason => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(reason));
      });
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(`Timed out waiting for CDP event: ${method || '*'}`));
      }, timeoutMs);
      timer.unref?.();
    });
    return {
      promise,
      cancel(reason = 'CDP event wait cancelled') {
        if (settled) return;
        settled = true;
        cleanup();
        const error = new Error(reason);
        error.name = 'AbortError';
        rejectPromise(error);
      },
    };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    const socket = this.ws;
    if (socket) this.#invalidateSocket(socket, 'CDP proxy is shutting down');
    else {
      const reason = 'CDP proxy is shutting down';
      for (const pending of this.pending.values()) {
        pending.cleanup?.();
        pending.reject(new Error(reason));
      }
      this.pending.clear();
      this.internalPending = 0;
      for (const listener of [...this.disconnectListeners]) {
        try { listener(reason); } catch {}
      }
    }
  }
}

function boundedTimeout(value, fallback = COMMAND_TIMEOUT_MS) {
  if (value == null) return fallback;
  const timeout = Number(value);
  if (!Number.isFinite(timeout) || timeout < 100 || timeout > 600_000) {
    throw new Error('timeoutMs must be from 100 to 600000');
  }
  return Math.trunc(timeout);
}

function numericOption(value, name, { defaultValue, minimum = -Number.MAX_VALUE, maximum = Number.MAX_VALUE, integer = false } = {}) {
  if (value == null || value === '') {
    if (defaultValue !== undefined) return defaultValue;
    throw new Error(`${name} is required`);
  }
  const number = Number(value);
  if (!Number.isFinite(number) || (integer && !Number.isInteger(number)) || number < minimum || number > maximum) {
    throw new Error(`${name} must be ${integer ? 'an integer' : 'a finite number'} from ${minimum} to ${maximum}`);
  }
  return number;
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function normalizeTargetPrefix(prefix) {
  return String(prefix || '').trim().toUpperCase();
}

export function resolveTargetPrefix(prefix, targetInfos) {
  const normalized = normalizeTargetPrefix(prefix);
  if (!normalized) throw new Error('target is required; run list first');
  const exact = targetInfos.find(info => info.targetId.toUpperCase() === normalized);
  if (exact) return exact;
  if (normalized.length < 4) throw new Error('target prefix must contain at least 4 characters');
  const matches = targetInfos.filter(info => info.targetId.toUpperCase().startsWith(normalized));
  if (matches.length === 0) throw new Error(`No target matches prefix "${prefix}"`);
  if (matches.length > 1) throw new Error(`Target prefix "${prefix}" is ambiguous (${matches.length} matches)`);
  return matches[0];
}

function shouldShowAxNode(node, compact) {
  const role = node.role?.value || '';
  const name = node.name?.value ?? '';
  const value = node.value?.value;
  if (compact && role === 'InlineTextBox') return false;
  return role !== 'none' && role !== 'generic' && !(name === '' && (value === '' || value == null));
}

function formatAxTree(nodes, compact = true) {
  const nodesById = new Map(nodes.map(node => [node.nodeId, node]));
  const childrenByParent = new Map();
  for (const node of nodes) {
    if (!node.parentId) continue;
    if (!childrenByParent.has(node.parentId)) childrenByParent.set(node.parentId, []);
    childrenByParent.get(node.parentId).push(node);
  }

  const output = [];
  const visited = new Set();
  const visit = (node, depth) => {
    if (!node || visited.has(node.nodeId)) return;
    visited.add(node.nodeId);
    if (shouldShowAxNode(node, compact)) {
      const role = node.role?.value || '';
      const name = node.name?.value ?? '';
      const value = node.value?.value;
      let line = `${'  '.repeat(Math.min(depth, 12))}[${role}]`;
      if (name !== '') line += ` ${name}`;
      if (!(value === '' || value == null)) line += ` = ${JSON.stringify(value)}`;
      output.push(line);
    }
    const children = [];
    const seen = new Set();
    for (const childId of node.childIds || []) {
      const child = nodesById.get(childId);
      if (child && !seen.has(child.nodeId)) {
        seen.add(child.nodeId);
        children.push(child);
      }
    }
    for (const child of childrenByParent.get(node.nodeId) || []) {
      if (!seen.has(child.nodeId)) {
        seen.add(child.nodeId);
        children.push(child);
      }
    }
    for (const child of children) visit(child, depth + 1);
  };

  const roots = nodes.filter(node => !node.parentId || !nodesById.has(node.parentId));
  for (const root of roots) visit(root, 0);
  for (const node of nodes) visit(node, 0);
  return output.join('\n');
}

function remoteValue(result) {
  if (result.exceptionDetails) {
    const message = result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'JavaScript evaluation failed';
    throw new Error(message);
  }
  const remote = result.result || {};
  if (Object.hasOwn(remote, 'value')) return remote.value;
  if (remote.unserializableValue != null) return remote.unserializableValue;
  if (remote.type === 'undefined') return null;
  return remote.description ?? null;
}

function fileMimeType(format) {
  return format === 'jpeg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png';
}

function urlsEquivalent(actual, expected, base) {
  if (actual === expected) return true;
  try {
    return new URL(actual, base).href === new URL(expected, base).href;
  } catch {
    return false;
  }
}

const TARGET_OPERATIONS = new Set([
  'eval', 'evaluate', 'wait', 'navigate', 'reload', 'back', 'forward',
  'snapshot', 'html', 'screenshot', 'click', 'click-real', 'hover-click',
  'clickxy', 'type', 'key', 'scroll', 'set-files', 'network',
]);

export class ProxyService {
  constructor(cdp) {
    this.cdp = cdp;
    this.sessionsByTarget = new Map();
    this.targetsBySession = new Map();
    this.targetInfos = new Map();
    this.targetRefreshPromise = null;
    this.attachPromises = new Map();
    this.enabledDomains = new Map();
    this.domainPromises = new Map();
    this.targetLocks = new Map();
    this.targetEpochs = new Map();
    this.generation = 1;
    this.instanceId = crypto.randomUUID();
    this.startedAt = new Date().toISOString();

    cdp.onEvent(message => this.#trackEvent(message));
    cdp.onDisconnect(() => {
      this.generation += 1;
      this.sessionsByTarget.clear();
      this.targetsBySession.clear();
      this.targetInfos.clear();
      this.targetRefreshPromise = null;
      this.attachPromises.clear();
      this.enabledDomains.clear();
      this.domainPromises.clear();
      this.targetEpochs.clear();
    });
  }

  #trackEvent(message) {
    const params = message.params || {};
    if ((message.method === 'Target.targetCreated' || message.method === 'Target.targetInfoChanged') && params.targetInfo?.targetId) {
      this.targetInfos.set(params.targetInfo.targetId, params.targetInfo);
      return;
    }
    if (message.method === 'Target.attachedToTarget' && params.targetInfo?.targetId && params.sessionId) {
      this.targetInfos.set(params.targetInfo.targetId, params.targetInfo);
      this.sessionsByTarget.set(params.targetInfo.targetId, params.sessionId);
      this.targetsBySession.set(params.sessionId, params.targetInfo.targetId);
      return;
    }
    if (message.method === 'Target.detachedFromTarget' && params.sessionId) {
      const targetId = this.targetsBySession.get(params.sessionId) || params.targetId;
      if (targetId) this.targetEpochs.set(targetId, (this.targetEpochs.get(targetId) || 0) + 1);
      this.targetsBySession.delete(params.sessionId);
      this.enabledDomains.delete(params.sessionId);
      if (targetId && this.sessionsByTarget.get(targetId) === params.sessionId) {
        this.sessionsByTarget.delete(targetId);
      }
      return;
    }
    if (message.method === 'Inspector.detached' && message.sessionId) {
      const targetId = this.targetsBySession.get(message.sessionId);
      if (targetId) this.targetEpochs.set(targetId, (this.targetEpochs.get(targetId) || 0) + 1);
      this.targetsBySession.delete(message.sessionId);
      this.enabledDomains.delete(message.sessionId);
      if (targetId && this.sessionsByTarget.get(targetId) === message.sessionId) this.sessionsByTarget.delete(targetId);
      return;
    }
    if (message.method === 'Target.targetCrashed' && params.targetId) {
      this.targetEpochs.set(params.targetId, (this.targetEpochs.get(params.targetId) || 0) + 1);
      const sessionId = this.sessionsByTarget.get(params.targetId);
      this.sessionsByTarget.delete(params.targetId);
      this.attachPromises.delete(params.targetId);
      if (sessionId) {
        this.targetsBySession.delete(sessionId);
        this.enabledDomains.delete(sessionId);
      }
      return;
    }
    if (message.method === 'Target.targetDestroyed' && params.targetId) {
      this.targetEpochs.set(params.targetId, (this.targetEpochs.get(params.targetId) || 0) + 1);
      const sessionId = this.sessionsByTarget.get(params.targetId);
      this.sessionsByTarget.delete(params.targetId);
      this.targetInfos.delete(params.targetId);
      this.attachPromises.delete(params.targetId);
      if (sessionId) {
        this.targetsBySession.delete(sessionId);
        this.enabledDomains.delete(sessionId);
      }
    }
  }

  async health({ connect = false } = {}) {
    if (connect) await this.cdp.ensureConnected();
    return {
      status: 'ok',
      version: VERSION,
      pid: process.pid,
      instanceId: this.instanceId,
      startedAt: this.startedAt,
      generation: this.generation,
      sessions: this.sessionsByTarget.size,
      knownTargets: this.targetInfos.size,
      runtimeDir: RUNTIME_DIR,
      socket: SOCKET_PATH,
      httpPort: optionalHttpPort() || null,
      browser: this.cdp.state(),
    };
  }

  async allTargets() {
    const signal = requestSignal();
    throwIfRequestAborted(signal);
    if (!this.targetRefreshPromise) {
      const refreshing = this.cdp.send(
        'Target.getTargets', {}, undefined, COMMAND_TIMEOUT_MS, { ignoreRequestAbort: true },
      ).then(({ targetInfos }) => {
        for (const info of targetInfos || []) {
          if (info?.targetId) this.targetInfos.set(info.targetId, info);
        }
        return targetInfos || [];
      }).finally(() => {
        if (this.targetRefreshPromise === refreshing) this.targetRefreshPromise = null;
      });
      this.targetRefreshPromise = refreshing;
    }
    return waitWithSignal(this.targetRefreshPromise, signal);
  }

  async pageTargets({ includeInternal = false } = {}) {
    const targets = (await this.allTargets()).filter(info => info.type === 'page');
    return includeInternal ? targets : targets.filter(info => !info.url.startsWith('devtools://'));
  }

  async resolveTarget(targetRef, { pagesOnly = false } = {}) {
    const targets = pagesOnly ? await this.pageTargets({ includeInternal: true }) : await this.allTargets();
    return resolveTargetPrefix(targetRef, targets);
  }

  async sessionForTarget(targetRef) {
    const signal = requestSignal();
    throwIfRequestAborted(signal);
    let target;
    if (this.targetInfos.size) {
      try {
        target = resolveTargetPrefix(targetRef, [...this.targetInfos.values()]);
      } catch (error) {
        if (!/^No target matches prefix/.test(error.message)) throw error;
      }
    }
    target ||= await this.resolveTarget(targetRef);
    const cached = this.sessionsByTarget.get(target.targetId);
    if (cached) return { target, sessionId: cached };
    if (this.attachPromises.has(target.targetId)) {
      return waitWithSignal(this.attachPromises.get(target.targetId), signal);
    }

    const generation = this.generation;
    const targetEpoch = this.targetEpochs.get(target.targetId) || 0;
    const attaching = (async () => {
      const { sessionId } = await this.cdp.send('Target.attachToTarget', {
        targetId: target.targetId,
        flatten: true,
      }, undefined, COMMAND_TIMEOUT_MS, { ignoreRequestAbort: true });
      if (!sessionId) throw new Error(`Target.attachToTarget returned no session for ${target.targetId}`);
      if (generation !== this.generation) throw new Error('Browser connection changed while attaching target');
      if ((this.targetEpochs.get(target.targetId) || 0) !== targetEpoch) {
        throw new Error(`Target was destroyed or detached while attaching: ${target.targetId}`);
      }
      this.sessionsByTarget.set(target.targetId, sessionId);
      this.targetsBySession.set(sessionId, target.targetId);
      return { target, sessionId };
    })().finally(() => {
      if (this.attachPromises.get(target.targetId) === attaching) this.attachPromises.delete(target.targetId);
    });
    this.attachPromises.set(target.targetId, attaching);
    return waitWithSignal(attaching, signal);
  }

  async ensureDomain(sessionId, domain) {
    const signal = requestSignal();
    throwIfRequestAborted(signal);
    const enabled = this.enabledDomains.get(sessionId) || new Set();
    this.enabledDomains.set(sessionId, enabled);
    if (enabled.has(domain)) return;
    const key = `${sessionId}:${domain}`;
    if (this.domainPromises.has(key)) return waitWithSignal(this.domainPromises.get(key), signal);
    const enabling = this.cdp.send(
      `${domain}.enable`, {}, sessionId, COMMAND_TIMEOUT_MS, { ignoreRequestAbort: true },
    ).then(() => {
      enabled.add(domain);
    }).finally(() => {
      this.domainPromises.delete(key);
    });
    this.domainPromises.set(key, enabling);
    return waitWithSignal(enabling, signal);
  }

  async withTargetLock(targetId, operation) {
    const previous = this.targetLocks.get(targetId) || Promise.resolve();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const tail = previous.catch(() => {}).then(() => gate);
    this.targetLocks.set(targetId, tail);
    try {
      await waitWithSignal(previous.catch(() => {}), requestSignal());
      throwIfRequestAborted();
      return await operation();
    } finally {
      release();
      const cleanup = () => {
        if (this.targetLocks.get(targetId) === tail) this.targetLocks.delete(targetId);
      };
      tail.then(cleanup, cleanup);
    }
  }

  async withFreshTargetLock(targetId, expectedSessionId, operation) {
    return this.withTargetLock(targetId, async () => {
      let sessionId = this.sessionsByTarget.get(targetId);
      if (!sessionId || sessionId !== expectedSessionId) {
        sessionId = (await this.sessionForTarget(targetId)).sessionId;
      }
      return operation(sessionId);
    });
  }

  async evaluate(sessionId, expression, options = {}) {
    const result = await this.cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: options.returnByValue !== false,
      awaitPromise: options.awaitPromise !== false,
      userGesture: options.userGesture === true,
      ...(options.contextId != null ? { contextId: options.contextId } : {}),
    }, sessionId, boundedTimeout(options.timeoutMs));
    return options.raw ? result : remoteValue(result);
  }

  async waitForExpression(sessionId, expression, options = {}) {
    const timeoutMs = boundedTimeout(options.timeoutMs, 30_000);
    const intervalMs = numericOption(options.intervalMs, 'intervalMs', { defaultValue: 100, minimum: 20, maximum: 5_000 });
    const deadline = Date.now() + timeoutMs;
    const signal = requestSignal();
    const targetId = options.targetId;
    let currentSessionId = sessionId;
    let generation = this.generation;
    let lastError;
    while (Date.now() < deadline) {
      throwIfRequestAborted(signal);
      try {
        const value = await this.evaluate(currentSessionId, expression, { timeoutMs: Math.min(COMMAND_TIMEOUT_MS, Math.max(100, deadline - Date.now())) });
        if (value) return value;
      } catch (error) {
        throwIfRequestAborted(signal);
        lastError = error;
        if (targetId && (generation !== this.generation || this.sessionsByTarget.get(targetId) !== currentSessionId)) {
          try {
            const attached = await this.sessionForTarget(targetId);
            currentSessionId = attached.sessionId;
            generation = this.generation;
          } catch (attachError) {
            throwIfRequestAborted(signal);
            lastError = attachError;
          }
        }
      }
      await delay(Math.min(intervalMs, Math.max(0, deadline - Date.now())), signal);
    }
    throw new Error(`Timed out waiting for expression${lastError ? ` (${lastError.message})` : ''}`);
  }

  async runNavigation(sessionId, action, options = {}) {
    const timeoutMs = boundedTimeout(options.timeoutMs, 60_000);
    const waitUntil = options.waitUntil || 'complete';
    if (!['none', 'interactive', 'complete', 'networkIdle'].includes(waitUntil)) {
      throw new Error('waitUntil must be none, interactive, complete, or networkIdle');
    }
    await this.ensureDomain(sessionId, 'Page');
    await this.cdp.send('Page.setLifecycleEventsEnabled', { enabled: true }, sessionId, timeoutMs);
    const frameTree = await this.cdp.send('Page.getFrameTree', {}, sessionId, timeoutMs);
    const mainFrame = frameTree.frameTree?.frame || {};
    const beforeLoaderId = mainFrame.loaderId;
    const mainFrameId = mainFrame.id;
    const events = [];
    let disconnectReason;
    const offEvent = this.cdp.onEvent(message => {
      if (message.sessionId !== sessionId) return;
      if (message.method === 'Page.lifecycleEvent' || message.method === 'Page.navigatedWithinDocument') {
        events.push(message);
      }
    });
    const offDisconnect = this.cdp.onDisconnect(reason => { disconnectReason = reason; });
    const deadline = Date.now() + timeoutMs;
    let eventCursor = 0;
    try {
      const result = await action();
      if (waitUntil === 'none' || result?.isDownload) return result;
      const expectedLoaderId = result?.loaderId;
      const desiredNames = waitUntil === 'interactive'
        ? new Set(['DOMContentLoaded', 'load'])
        : new Set([waitUntil === 'networkIdle' ? 'networkIdle' : 'load']);

      while (Date.now() < deadline) {
        if (disconnectReason) throw new Error(disconnectReason);
        while (eventCursor < events.length) {
          const event = events[eventCursor++];
          const params = event.params || {};
          if (mainFrameId && params.frameId && params.frameId !== mainFrameId) continue;
          if (
            event.method === 'Page.navigatedWithinDocument' &&
            !expectedLoaderId &&
            options.sameDocumentUrl != null &&
            urlsEquivalent(params.url, options.sameDocumentUrl, mainFrame.url)
          ) return result;
          const loaderMatches = expectedLoaderId
            ? params.loaderId === expectedLoaderId
            : params.loaderId && params.loaderId !== beforeLoaderId;
          if (loaderMatches && desiredNames.has(params.name)) return result;
        }
        if (eventCursor > 1_024) {
          events.splice(0, eventCursor);
          eventCursor = 0;
        }
        await delay(Math.min(20, Math.max(1, deadline - Date.now())), requestSignal());
      }
      throw new Error(`Timed out waiting for Page lifecycle event (${waitUntil})`);
    } finally {
      offEvent();
      offDisconnect();
    }
  }

  async execute(request) {
    throwIfRequestAborted();
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Request must be a JSON object');
    const op = requireString(request.op, 'op');

    if (op === 'health' || op === 'status') return this.health({ connect: request.connect === true });
    if (op === 'connect') return this.health({ connect: true });

    if (op === 'list' || op === 'targets') {
      const targets = request.all
        ? await this.allTargets()
        : await this.pageTargets({ includeInternal: request.includeInternal === true });
      return targets.map(info => ({
        targetId: info.targetId,
        id: info.targetId.slice(0, 8),
        type: info.type,
        title: info.title,
        url: info.url,
        attached: info.attached,
      }));
    }

    if (op === 'open' || op === 'new') {
      const url = request.url || 'about:blank';
      const result = await this.cdp.send('Target.createTarget', {
        url,
        background: request.background !== false,
        ...(request.newWindow === true ? { newWindow: true } : {}),
      });
      return { targetId: result.targetId, id: result.targetId?.slice(0, 8), url };
    }

    if (op === 'close') {
      const target = await this.resolveTarget(request.target);
      const result = await this.cdp.send('Target.closeTarget', { targetId: target.targetId });
      return { targetId: target.targetId, success: result.success === true };
    }

    if (op === 'activate') {
      const target = await this.resolveTarget(request.target, { pagesOnly: true });
      await this.cdp.send('Target.activateTarget', { targetId: target.targetId });
      return { targetId: target.targetId, activated: true };
    }

    if (op === 'attach') {
      const { target, sessionId } = await this.sessionForTarget(request.target);
      return { targetId: target.targetId, sessionId, generation: this.generation };
    }

    if (op === 'raw') {
      const method = requireString(request.method, 'method');
      let sessionId = request.sessionId;
      let targetId;
      if (!sessionId && request.target && request.target !== 'browser' && request.target !== '-') {
        const attached = await this.sessionForTarget(request.target);
        sessionId = attached.sessionId;
        targetId = attached.target.targetId;
      }
      const result = await this.cdp.send(method, request.params || {}, sessionId, boundedTimeout(request.timeoutMs));
      return { result, sessionId: sessionId || null, targetId: targetId || this.targetsBySession.get(sessionId) || null };
    }

    if (op === 'batch') {
      const commands = request.commands;
      if (!Array.isArray(commands) || commands.length === 0) throw new Error('commands must be a non-empty array');
      if (commands.length > MAX_BATCH_COMMANDS) throw new Error(`Batch exceeds ${MAX_BATCH_COMMANDS} commands`);
      if (commands.some(command => ['batch', 'subscribe', 'shutdown'].includes(command?.op))) {
        throw new Error('Nested batch, subscribe, and shutdown operations are not allowed');
      }
      const run = command => this.execute(command).then(
        result => ({ ok: true, result }),
        error => ({ ok: false, error: errorObject(error) }),
      );
      if (request.mode === 'parallel') return Promise.all(commands.map(run));
      const results = [];
      for (const command of commands) {
        throwIfRequestAborted();
        const result = await run(command);
        results.push(result);
        if (!result.ok && request.stopOnError !== false) break;
      }
      return results;
    }

    if (!TARGET_OPERATIONS.has(op)) throw new Error(`Unknown operation: ${op}`);
    const { target, sessionId } = await this.sessionForTarget(request.target);
    const targetId = target.targetId;

    if (op === 'eval' || op === 'evaluate') {
      const value = await this.evaluate(sessionId, requireString(request.expression, 'expression'), request);
      return { targetId, value };
    }

    if (op === 'wait') {
      const value = await this.waitForExpression(sessionId, requireString(request.expression, 'expression'), { ...request, targetId });
      return { targetId, value };
    }

    if (op === 'navigate') {
      const url = requireString(request.url, 'url');
      return this.withFreshTargetLock(targetId, sessionId, async sessionId => {
        const result = await this.runNavigation(sessionId, async () => {
          const navigation = await this.cdp.send('Page.navigate', { url }, sessionId, boundedTimeout(request.timeoutMs, 60_000));
          if (navigation.errorText) throw new Error(`Navigation failed: ${navigation.errorText}`);
          return navigation;
        }, { timeoutMs: request.timeoutMs, waitUntil: request.waitUntil, sameDocumentUrl: url });
        return { targetId, frameId: result.frameId, loaderId: result.loaderId || null, url };
      });
    }

    if (op === 'reload') {
      return this.withFreshTargetLock(targetId, sessionId, async sessionId => {
        await this.runNavigation(
          sessionId,
          () => this.cdp.send('Page.reload', { ignoreCache: request.ignoreCache === true }, sessionId, boundedTimeout(request.timeoutMs, 60_000)),
          { timeoutMs: request.timeoutMs, waitUntil: request.waitUntil },
        );
        return { targetId, reloaded: true };
      });
    }

    if (op === 'back' || op === 'forward') {
      return this.withFreshTargetLock(targetId, sessionId, async sessionId => {
        const history = await this.cdp.send('Page.getNavigationHistory', {}, sessionId);
        const offset = op === 'back' ? -1 : 1;
        const entry = history.entries?.[history.currentIndex + offset];
        if (!entry) throw new Error(`No ${op} history entry is available`);
        await this.runNavigation(
          sessionId,
          () => this.cdp.send('Page.navigateToHistoryEntry', { entryId: entry.id }, sessionId),
          { timeoutMs: request.timeoutMs, waitUntil: request.waitUntil, sameDocumentUrl: entry.url },
        );
        return { targetId, entryId: entry.id, url: entry.url };
      });
    }

    if (op === 'snapshot') {
      const { nodes } = await this.cdp.send('Accessibility.getFullAXTree', {}, sessionId, boundedTimeout(request.timeoutMs));
      return request.raw ? { targetId, nodes } : { targetId, text: formatAxTree(nodes || [], request.compact !== false) };
    }

    if (op === 'html') {
      const expression = request.selector
        ? `document.querySelector(${JSON.stringify(request.selector)})?.outerHTML ?? null`
        : 'document.documentElement.outerHTML';
      const value = await this.evaluate(sessionId, expression, request);
      return { targetId, html: value };
    }

    if (op === 'screenshot') {
      const format = ['png', 'jpeg', 'webp'].includes(request.format) ? request.format : 'png';
      const params = {
        format,
        fromSurface: true,
        captureBeyondViewport: request.fullPage === true,
      };
      if (format === 'jpeg' && request.quality != null) {
        params.quality = numericOption(request.quality, 'quality', { minimum: 0, maximum: 100, integer: true });
      }
      if (request.fullPage === true) {
        const metrics = await this.cdp.send('Page.getLayoutMetrics', {}, sessionId);
        const size = metrics.cssContentSize || metrics.contentSize;
        if (size) params.clip = { x: 0, y: 0, width: size.width, height: size.height, scale: 1 };
      }
      const { data } = await this.cdp.send('Page.captureScreenshot', params, sessionId, boundedTimeout(request.timeoutMs, 60_000));
      if (!data) throw new Error('Page.captureScreenshot returned no data');
      if (request.file) {
        throwIfRequestAborted();
        if (!path.isAbsolute(request.file)) throw new Error('screenshot file must be an absolute path');
        const outputPath = path.normalize(request.file);
        fs.writeFileSync(outputPath, Buffer.from(data, 'base64'), { flag: request.overwrite === false ? 'wx' : 'w' });
        return { targetId, file: outputPath, bytes: Buffer.byteLength(data, 'base64'), mimeType: fileMimeType(format) };
      }
      return { targetId, data, mimeType: fileMimeType(format) };
    }

    if (op === 'click') {
      const selector = requireString(request.selector, 'selector');
      return this.withFreshTargetLock(targetId, sessionId, async sessionId => {
        const expression = `(() => {
          const element = document.querySelector(${JSON.stringify(selector)});
          if (!element) return { error: 'Element not found' };
          element.scrollIntoView({ block: 'center', inline: 'center' });
          element.click();
          return { tag: element.tagName, text: (element.textContent || '').trim().slice(0, 160) };
        })()`;
        const value = await this.evaluate(sessionId, expression, { userGesture: true });
        if (value?.error) throw new Error(`${value.error}: ${selector}`);
        return { targetId, clicked: true, ...value };
      });
    }

    if (op === 'click-real' || op === 'hover-click') {
      const selector = requireString(request.selector, 'selector');
      return this.withFreshTargetLock(targetId, sessionId, async sessionId => {
        const expression = `(() => {
          const element = document.querySelector(${JSON.stringify(selector)});
          if (!element) return { error: 'Element not found' };
          element.scrollIntoView({ block: 'center', inline: 'center' });
          const rect = element.getBoundingClientRect();
          if (!rect.width || !rect.height) return { error: 'Element has no visible box' };
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2,
            tag: element.tagName, text: (element.textContent || '').trim().slice(0, 160) };
        })()`;
        const point = await this.evaluate(sessionId, expression);
        if (point?.error) throw new Error(`${point.error}: ${selector}`);
        const inputGeneration = this.generation;
        await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y }, sessionId);
        if (op === 'hover-click') await delay(numericOption(request.hoverMs, 'hoverMs', { defaultValue: 600, minimum: 0, maximum: 30_000 }), requestSignal());
        const base = {
          x: point.x,
          y: point.y,
          button: request.button || 'left',
          clickCount: numericOption(request.clickCount, 'clickCount', { defaultValue: 1, minimum: 1, maximum: 1_000, integer: true }),
        };
        let pressAttempted = false;
        let primaryError;
        try {
          pressAttempted = true;
          await this.cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' }, sessionId);
          await delay(numericOption(request.holdMs, 'holdMs', { defaultValue: 30, minimum: 0, maximum: 5_000 }), requestSignal());
        } catch (error) {
          primaryError = error;
          throw error;
        } finally {
          if (pressAttempted && inputGeneration === this.generation && this.sessionsByTarget.get(targetId) === sessionId && this.cdp.connected) {
            try {
              await this.cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' }, sessionId, 1_000, { connect: false, ignoreRequestAbort: true, internal: true });
            } catch (releaseError) {
              if (!primaryError) throw releaseError;
            }
          }
        }
        return { targetId, clicked: true, ...point };
      });
    }

    if (op === 'clickxy') {
      const x = Number(request.x);
      const y = Number(request.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('x and y must be finite CSS-pixel coordinates');
      return this.withFreshTargetLock(targetId, sessionId, async sessionId => {
        const inputGeneration = this.generation;
        const base = {
          x,
          y,
          button: request.button || 'left',
          clickCount: numericOption(request.clickCount, 'clickCount', { defaultValue: 1, minimum: 1, maximum: 1_000, integer: true }),
        };
        await this.cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved' }, sessionId);
        let pressAttempted = false;
        let primaryError;
        try {
          pressAttempted = true;
          await this.cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' }, sessionId);
          await delay(numericOption(request.holdMs, 'holdMs', { defaultValue: 30, minimum: 0, maximum: 5_000 }), requestSignal());
        } catch (error) {
          primaryError = error;
          throw error;
        } finally {
          if (pressAttempted && inputGeneration === this.generation && this.sessionsByTarget.get(targetId) === sessionId && this.cdp.connected) {
            try {
              await this.cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' }, sessionId, 1_000, { connect: false, ignoreRequestAbort: true, internal: true });
            } catch (releaseError) {
              if (!primaryError) throw releaseError;
            }
          }
        }
        return { targetId, clicked: true, x, y };
      });
    }

    if (op === 'type') {
      const text = requireString(request.text, 'text');
      return this.withFreshTargetLock(targetId, sessionId, async sessionId => {
        await this.cdp.send('Input.insertText', { text }, sessionId);
        return { targetId, characters: [...text].length };
      });
    }

    if (op === 'key') {
      const key = requireString(request.key, 'key');
      const base = {
        key,
        code: request.code || key,
        ...(request.text != null ? { text: String(request.text), unmodifiedText: String(request.text) } : {}),
        ...(request.modifiers != null ? { modifiers: numericOption(request.modifiers, 'modifiers', { minimum: 0, maximum: 15, integer: true }) } : {}),
        ...(request.windowsVirtualKeyCode != null ? { windowsVirtualKeyCode: numericOption(request.windowsVirtualKeyCode, 'windowsVirtualKeyCode', { minimum: 0, maximum: 65_535, integer: true }) } : {}),
      };
      return this.withFreshTargetLock(targetId, sessionId, async sessionId => {
        const inputGeneration = this.generation;
        let pressAttempted = false;
        let primaryError;
        try {
          pressAttempted = true;
          await this.cdp.send('Input.dispatchKeyEvent', { ...base, type: 'keyDown' }, sessionId);
        } catch (error) {
          primaryError = error;
          throw error;
        } finally {
          if (pressAttempted && inputGeneration === this.generation && this.sessionsByTarget.get(targetId) === sessionId && this.cdp.connected) {
            try {
              await this.cdp.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' }, sessionId, 1_000, { connect: false, ignoreRequestAbort: true, internal: true });
            } catch (releaseError) {
              if (!primaryError) throw releaseError;
            }
          }
        }
        return { targetId, key };
      });
    }

    if (op === 'scroll') {
      const deltaX = numericOption(request.deltaX, 'deltaX', { defaultValue: 0 });
      const deltaY = numericOption(request.deltaY, 'deltaY', { defaultValue: 600 });
      const x = numericOption(request.x, 'x', { defaultValue: 0 });
      const y = numericOption(request.y, 'y', { defaultValue: 0 });
      return this.withFreshTargetLock(targetId, sessionId, async sessionId => {
        await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY }, sessionId);
        return { targetId, deltaX, deltaY };
      });
    }

    if (op === 'set-files') {
      const selector = requireString(request.selector, 'selector');
      if (!Array.isArray(request.files) || request.files.length === 0 || request.files.some(file => typeof file !== 'string')) {
        throw new Error('files must be a non-empty array of local paths');
      }
      return this.withFreshTargetLock(targetId, sessionId, async sessionId => {
        await this.ensureDomain(sessionId, 'DOM');
        const document = await this.cdp.send('DOM.getDocument', { depth: 0, pierce: true }, sessionId);
        const found = await this.cdp.send('DOM.querySelector', {
          nodeId: document.root.nodeId,
          selector,
        }, sessionId);
        if (!found.nodeId) throw new Error(`Element not found: ${selector}`);
        const files = request.files.map(file => {
          if (!path.isAbsolute(file)) throw new Error(`Upload path must be absolute: ${file}`);
          return path.normalize(file);
        });
        for (const file of files) {
          if (!fs.existsSync(file)) throw new Error(`Upload file does not exist: ${file}`);
        }
        await this.cdp.send('DOM.setFileInputFiles', { nodeId: found.nodeId, files }, sessionId);
        return { targetId, files };
      });
    }

    if (op === 'network') {
      const value = await this.evaluate(sessionId, `performance.getEntriesByType('resource').map(entry => ({
        name: entry.name, type: entry.initiatorType, duration: entry.duration,
        transferSize: entry.transferSize, encodedBodySize: entry.encodedBodySize,
        decodedBodySize: entry.decodedBodySize
      }))`);
      return { targetId, entries: value };
    }

    throw new Error(`Operation is not implemented: ${op}`);
  }

  async executeSafe(request, signal) {
    const run = async () => {
      try {
        return { ok: true, result: await this.execute(request) };
      } catch (error) {
        return { ok: false, error: errorObject(error) };
      }
    };
    return signal ? REQUEST_CONTEXT.run({ signal }, run) : run();
  }
}

function safeSocketWrite(socket, value) {
  if (socket.destroyed || !socket.writable) return false;
  let line;
  try {
    line = `${JSON.stringify(value)}\n`;
  } catch (error) {
    line = `${JSON.stringify({ ok: false, error: errorObject(error) })}\n`;
  }
  const bytes = Buffer.byteLength(line);
  if (bytes > MAX_IPC_MESSAGE_BYTES || socket.writableLength + bytes > MAX_IPC_MESSAGE_BYTES * 2) {
    socket.destroy(new Error('Client output exceeded the proxy backpressure limit'));
    return false;
  }
  const writable = socket.write(line);
  if (!writable) socket.pause();
  return true;
}

function methodMatches(pattern, method) {
  if (!pattern || pattern === '*') return true;
  if (pattern.endsWith('*')) return method.startsWith(pattern.slice(0, -1));
  return method === pattern;
}

async function createSubscription(service, socket, request, subscriptions, connectionState) {
  const pattern = request.method ?? '*';
  if (typeof pattern !== 'string' || !(/^\*$/.test(pattern) || /^[A-Za-z][A-Za-z0-9_]*\.(?:[A-Za-z][A-Za-z0-9_]*|\*)$/.test(pattern))) {
    throw new Error('subscription method must be *, Domain.event, or Domain.*');
  }
  let sessionId;
  let targetId;
  if (request.target && request.target !== 'browser' && request.target !== '-') {
    const attached = await service.sessionForTarget(request.target);
    sessionId = attached.sessionId;
    targetId = attached.target.targetId;
    if (request.enable !== false && pattern.includes('.')) {
      const domain = pattern.split('.')[0];
      if (!['Target', 'Browser'].includes(domain)) {
        await service.ensureDomain(sessionId, domain).catch(error => {
          if (request.enable === true) throw error;
        });
      }
    }
  }
  if (connectionState.closed) throw new Error('IPC client disconnected while creating subscription');

  const subscriptionId = crypto.randomUUID();
  const maxEvents = numericOption(request.maxEvents, 'maxEvents', { defaultValue: 10_000, minimum: 1, maximum: 1_000_000, integer: true });
  const durationMs = request.durationMs == null
    ? 60_000
    : numericOption(request.durationMs, 'durationMs', { minimum: 100, maximum: 3_600_000, integer: true });
  let sequence = 0;
  let timer;
  let off = () => {};
  let offDisconnect = () => {};
  const cancel = (reason, { notify = true } = {}) => {
    const subscription = subscriptions.get(subscriptionId);
    if (!subscription) return;
    subscriptions.delete(subscriptionId);
    connectionState.subscriptionSlots = Math.max(0, connectionState.subscriptionSlots - 1);
    clearTimeout(timer);
    off();
    offDisconnect();
    if (notify) safeSocketWrite(socket, { subscriptionId, complete: true, reason, events: sequence });
  };
  off = service.cdp.onEvent(message => {
    if (!methodMatches(pattern, message.method)) return;
    if (sessionId !== undefined && message.sessionId !== sessionId) return;
    sequence += 1;
    const routedTarget = message.sessionId ? service.targetsBySession.get(message.sessionId) : null;
    safeSocketWrite(socket, {
      subscriptionId,
      event: true,
      seq: sequence,
      generation: service.generation,
      targetId: routedTarget || targetId || null,
      sessionId: message.sessionId || null,
      method: message.method,
      params: message.params || {},
    });
    if (sequence >= maxEvents) cancel('maxEvents');
  });
  offDisconnect = service.cdp.onDisconnect(() => cancel('disconnect'));
  timer = setTimeout(() => cancel('timeout'), durationMs);
  timer.unref?.();
  subscriptions.set(subscriptionId, { cancel });
  return { subscriptionId, targetId: targetId || null, sessionId: sessionId || null, method: pattern, durationMs, maxEvents };
}

function attachIpcConnection(serverContext, socket) {
  const { service, token, shutdown, ready } = serverContext;
  let buffer = '';
  let pendingCount = 0;
  const subscriptions = new Map();
  const connectionState = { closed: false, subscriptionSlots: 0 };
  const abortController = new AbortController();

  socket.setNoDelay(true);
  socket.setEncoding('utf8');
  socket.on('drain', () => socket.resume());
  socket.on('error', error => appendLog('WARN', `IPC client error: ${error.message}`));
  socket.on('close', () => {
    connectionState.closed = true;
    abortController.abort(Object.assign(new Error('IPC client disconnected'), { name: 'AbortError' }));
    for (const subscription of [...subscriptions.values()]) subscription.cancel('socket-close', { notify: false });
  });

  const respond = (id, response) => safeSocketWrite(socket, { id, ...response });
  const handleLine = async line => {
    let request;
    try {
      request = parseJson(line, 'IPC request');
    } catch {
      respond(null, { ok: false, error: { name: 'SyntaxError', message: 'Invalid JSON request' } });
      return;
    }
    const id = request?.id ?? null;
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      respond(id, { ok: false, error: { name: 'TypeError', message: 'Request must be a JSON object' } });
      return;
    }
    if (!tokensEqual(request.token, token)) {
      respond(id, { ok: false, error: { name: 'AuthError', message: 'Invalid proxy token' } });
      return;
    }
    if (pendingCount >= MAX_CLIENT_PENDING) {
      respond(id, { ok: false, error: { name: 'BackpressureError', message: `Client has ${MAX_CLIENT_PENDING} pending requests` } });
      return;
    }

    pendingCount += 1;
    try {
      await ready;
      if (request.op === 'subscribe') {
        if (connectionState.subscriptionSlots >= MAX_SUBSCRIPTIONS_PER_CLIENT) {
          throw new Error(`Subscription limit reached (${MAX_SUBSCRIPTIONS_PER_CLIENT})`);
        }
        connectionState.subscriptionSlots += 1;
        let committed = false;
        try {
          const result = await REQUEST_CONTEXT.run(
            { signal: abortController.signal },
            () => createSubscription(service, socket, request, subscriptions, connectionState),
          );
          committed = true;
          respond(id, { ok: true, result });
        } finally {
          if (!committed) connectionState.subscriptionSlots -= 1;
        }
        return;
      }
      if (request.op === 'unsubscribe') {
        const subscription = subscriptions.get(request.subscriptionId);
        if (!subscription) throw new Error(`Unknown subscription: ${request.subscriptionId}`);
        subscription.cancel('client');
        respond(id, { ok: true, result: { subscriptionId: request.subscriptionId, unsubscribed: true } });
        return;
      }
      if (request.op === 'shutdown') {
        respond(id, {
          ok: true,
          result: { shuttingDown: true, pid: process.pid, instanceId: service.instanceId, startedAt: service.startedAt },
        });
        setImmediate(() => shutdown('IPC request'));
        return;
      }
      respond(id, await service.executeSafe(request, abortController.signal));
    } catch (error) {
      respond(id, { ok: false, error: errorObject(error) });
    } finally {
      pendingCount -= 1;
    }
  };

  socket.on('data', chunk => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      if (Buffer.byteLength(line) > MAX_IPC_MESSAGE_BYTES) {
        respond(null, { ok: false, error: { name: 'RangeError', message: `IPC frame exceeds ${MAX_IPC_MESSAGE_BYTES} bytes` } });
        socket.destroy();
        return;
      }
      void handleLine(line);
    }
    if (Buffer.byteLength(buffer) > MAX_IPC_MESSAGE_BYTES) {
      respond(null, { ok: false, error: { name: 'RangeError', message: `IPC frame exceeds ${MAX_IPC_MESSAGE_BYTES} bytes` } });
      socket.destroy();
    }
  });
}

async function socketAcceptsConnections(socketPath = SOCKET_PATH, timeoutMs = 300) {
  return new Promise(resolve => {
    const socket = net.connect(socketPath);
    let settled = false;
    const done = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    timer.unref?.();
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function acquireDaemonLock() {
  ensureRuntimeDir();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(LOCK_PATH, 'wx', 0o600);
      fs.writeFileSync(fd, `${process.pid}\n`);
      return fd;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let pid = 0;
      try { pid = Number.parseInt(fs.readFileSync(LOCK_PATH, 'utf8'), 10); } catch {}
      if (processExists(pid) || await socketAcceptsConnections()) {
        throw new Error(`A CDP proxy daemon is already running (pid ${pid || 'unknown'})`);
      }
      try { fs.unlinkSync(LOCK_PATH); } catch {}
    }
  }
  throw new Error('Unable to acquire the CDP proxy daemon lock');
}

async function listenIpc(serverContext) {
  if (!IS_WINDOWS && fs.existsSync(SOCKET_PATH)) {
    const initial = fs.lstatSync(SOCKET_PATH);
    if (!initial.isSocket() || initial.isSymbolicLink()) {
      throw new Error(`Refusing to replace a non-socket IPC path: ${SOCKET_PATH}`);
    }
    if (typeof process.getuid === 'function' && initial.uid !== process.getuid()) {
      throw new Error(`Refusing to replace an IPC socket owned by another user: ${SOCKET_PATH}`);
    }
    if (await socketAcceptsConnections()) throw new Error('A CDP proxy daemon is already listening');
    if (SOCKET_OVERRIDDEN) {
      const state = readDaemonState();
      if (state?.socket !== SOCKET_PATH || processExists(state?.pid)) {
        throw new Error(`Refusing to remove an unverified stale overridden socket: ${SOCKET_PATH}`);
      }
    }
    const current = fs.lstatSync(SOCKET_PATH);
    if (!current.isSocket() || current.dev !== initial.dev || current.ino !== initial.ino) {
      throw new Error(`IPC socket changed while checking whether it was stale: ${SOCKET_PATH}`);
    }
    fs.unlinkSync(SOCKET_PATH);
  }
  return new Promise((resolve, reject) => {
    const server = net.createServer(socket => attachIpcConnection(serverContext, socket));
    server.once('error', reject);
    server.listen({ path: SOCKET_PATH, readableAll: false, writableAll: false }, () => {
      server.off('error', reject);
      server.on('error', error => appendLog('ERROR', `IPC server error: ${error.message}`));
      if (!IS_WINDOWS) {
        try { fs.chmodSync(SOCKET_PATH, 0o600); } catch {}
      }
      resolve(server);
    });
  });
}

async function readHttpBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_IPC_MESSAGE_BYTES) throw new Error(`HTTP body exceeds ${MAX_IPC_MESSAGE_BYTES} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function startHttpAdapter(service, token, connections, ready) {
  const port = optionalHttpPort();
  if (!port) return Promise.resolve(null);

  const server = http.createServer(async (request, response) => {
    const abortController = new AbortController();
    request.once('aborted', () => abortController.abort(Object.assign(new Error('HTTP client disconnected'), { name: 'AbortError' })));
    response.once('close', () => {
      if (!response.writableEnded) abortController.abort(Object.assign(new Error('HTTP client disconnected'), { name: 'AbortError' }));
    });
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    const host = (request.headers.host || '').toLowerCase();
    const origin = request.headers.origin;
    let hostAllowed = false;
    let originAllowed = !origin || origin === 'null';
    try {
      const authority = new URL(`http://${host}`);
      hostAllowed = ['127.0.0.1', 'localhost'].includes(authority.hostname) && Number(authority.port || 80) === port;
    } catch {}
    if (!originAllowed) {
      try {
        const parsedOrigin = new URL(origin);
        originAllowed = parsedOrigin.protocol === 'http:' &&
          ['127.0.0.1', 'localhost'].includes(parsedOrigin.hostname) &&
          Number(parsedOrigin.port || 80) === port;
      } catch {}
    }
    const bearer = request.headers.authorization?.match(/^Bearer (.+)$/i)?.[1];
    if (!hostAllowed || !originAllowed || !tokensEqual(bearer, token)) {
      response.statusCode = 403;
      response.end(JSON.stringify({ ok: false, error: { name: 'AuthError', message: 'Forbidden' } }));
      return;
    }

    try {
      await ready;
      if (request.method === 'GET' && request.url === '/health') {
        response.end(JSON.stringify(await service.executeSafe({ op: 'health' }, abortController.signal)));
        return;
      }
      if (request.method !== 'POST' || request.url !== '/rpc') {
        response.statusCode = 404;
        response.end(JSON.stringify({ ok: false, error: { name: 'NotFoundError', message: 'Use POST /rpc' } }));
        return;
      }
      if (!(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
        response.statusCode = 415;
        response.end(JSON.stringify({ ok: false, error: { name: 'TypeError', message: 'Content-Type must be application/json' } }));
        return;
      }
      const body = parseJson(await readHttpBody(request), 'HTTP request');
      if (['subscribe', 'unsubscribe', 'shutdown'].includes(body?.op)) {
        throw new Error(`${body.op} is available only through local IPC`);
      }
      const result = await service.executeSafe(body, abortController.signal);
      response.statusCode = result.ok ? 200 : 400;
      response.end(JSON.stringify(result));
    } catch (error) {
      response.statusCode = 400;
      response.end(JSON.stringify({ ok: false, error: errorObject(error) }));
    }
  });
  server.on('connection', socket => {
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      server.on('error', error => appendLog('ERROR', `HTTP server error: ${error.message}`));
      resolve(server);
    });
  });
}

function closeServer(server) {
  if (!server) return Promise.resolve();
  return new Promise(resolve => {
    try {
      server.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

async function runDaemon() {
  ensureRuntimeDir();
  if (!IS_WINDOWS) process.umask(0o077);
  const lockFd = await acquireDaemonLock();
  const token = readOrCreateToken();
  const cdp = new CDPConnection();
  const service = new ProxyService(cdp);
  const connections = new Set();
  let ipcServer;
  let httpServer;
  let shuttingDown = false;
  let stateWritten = false;
  const temporaryState = `${STATE_PATH}.${process.pid}.tmp`;
  let shutdownPromise;
  let markReady;
  let failReady;
  const ready = new Promise((resolve, reject) => {
    markReady = resolve;
    failReady = reject;
  });
  ready.catch(() => {});

  const shutdown = reason => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      shuttingDown = true;
      appendLog('INFO', `Stopping daemon: ${reason}`);
      cdp.close();
      const closing = Promise.all([closeServer(httpServer), closeServer(ipcServer)]);
      await delay(50);
      for (const socket of connections) socket.destroy();
      try { httpServer?.closeAllConnections?.(); } catch {}
      await closing;
      if (!IS_WINDOWS) {
        try { fs.unlinkSync(SOCKET_PATH); } catch {}
      }
      try { if (lockFd != null) fs.closeSync(lockFd); } catch {}
      try {
        if (Number.parseInt(fs.readFileSync(LOCK_PATH, 'utf8'), 10) === process.pid) fs.unlinkSync(LOCK_PATH);
      } catch {}
      if (stateWritten) {
        try {
          const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
          if (state.pid === process.pid) fs.unlinkSync(STATE_PATH);
        } catch {}
      }
      try { fs.unlinkSync(temporaryState); } catch {}
      if (reason !== 'startup failure') {
        setTimeout(() => process.exit(0), 25);
      }
    })();
    return shutdownPromise;
  };

  const serverContext = { service, token, shutdown, connections, ready };
  try {
    ipcServer = await listenIpc(serverContext);
    ipcServer.on('connection', socket => {
      connections.add(socket);
      socket.once('close', () => connections.delete(socket));
    });
    httpServer = await startHttpAdapter(service, token, connections, ready);
    const state = {
      version: VERSION,
      pid: process.pid,
      instanceId: service.instanceId,
      startedAt: service.startedAt,
      socket: SOCKET_PATH,
      runtimeDir: RUNTIME_DIR,
      httpPort: optionalHttpPort() || null,
      script: SCRIPT_PATH,
    };
    fs.writeFileSync(temporaryState, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporaryState, STATE_PATH);
    stateWritten = true;
    cdp.startHeartbeat();
    markReady();
    appendLog('INFO', `Daemon ${VERSION} listening on ${SOCKET_PATH}`);

    process.once('SIGINT', () => { void shutdown('SIGINT'); });
    process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
    process.once('SIGHUP', () => { void shutdown('SIGHUP'); });
    await new Promise(resolve => ipcServer.once('close', resolve));
  } catch (error) {
    failReady(error);
    appendLog('ERROR', `Daemon failed: ${error.stack || error.message}`);
    await shutdown('startup failure');
    throw error;
  }
}

function connectToDaemon(timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(SOCKET_PATH);
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off('connect', onConnect);
      socket.off('error', onError);
      if (error) {
        socket.destroy();
        reject(error);
      } else {
        resolve(value);
      }
    };
    const onConnect = () => {
      socket.setEncoding('utf8');
      finish(null, socket);
    };
    const onError = error => finish(error);
    const timer = setTimeout(() => finish(new Error(`Timed out connecting to proxy daemon at ${SOCKET_PATH}`)), timeoutMs);
    socket.once('connect', onConnect);
    socket.once('error', onError);
  });
}

async function ensureDaemon() {
  try {
    const existing = await connectToDaemon(300);
    existing.destroy();
    return;
  } catch {}

  ensureRuntimeDir();
  readOrCreateToken();
  const logFd = fs.openSync(LOG_PATH, 'a', 0o600);
  try {
    const child = spawn(process.execPath, [SCRIPT_PATH, 'daemon'], {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', logFd, logFd],
      env: process.env,
    });
    child.unref();
  } finally {
    fs.closeSync(logFd);
  }

  let lastError;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await delay(100);
    try {
      const socket = await connectToDaemon(300);
      socket.destroy();
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`CDP proxy daemon did not start: ${lastError?.message || 'unknown error'} (see ${LOG_PATH})`);
}

async function requestDaemon(request, { timeoutMs = 120_000, start = true } = {}) {
  if (start) await ensureDaemon();
  const socket = await connectToDaemon();
  let token;
  try {
    token = start ? readOrCreateToken() : readExistingToken();
  } catch (error) {
    socket.destroy();
    throw error;
  }
  const id = crypto.randomUUID();
  const payload = { ...request, id, token };
  return new Promise((resolve, reject) => {
    let buffer = '';
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('end', onEnd);
      socket.off('close', onClose);
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        socket.destroy();
        reject(error);
      } else {
        socket.end();
        resolve(value);
      }
    };
    const onData = chunk => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        if (Buffer.byteLength(line) > MAX_IPC_MESSAGE_BYTES) {
          finish(new Error('Proxy response exceeded the message limit'));
          return;
        }
        let message;
        try { message = JSON.parse(line); } catch (error) { finish(error); return; }
        if (message.id === id) {
          finish(null, message);
          return;
        }
      }
      if (Buffer.byteLength(buffer) > MAX_IPC_MESSAGE_BYTES) finish(new Error('Proxy response exceeded the message limit'));
    };
    const onError = error => finish(error);
    const onEnd = () => finish(new Error('Proxy daemon ended the connection before responding'));
    const onClose = () => finish(new Error('Proxy daemon closed the connection before responding'));
    const timer = setTimeout(() => finish(new Error(`Proxy request timed out after ${timeoutMs}ms`)), timeoutMs);
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('end', onEnd);
    socket.on('close', onClose);
    socket.write(`${JSON.stringify(payload)}\n`);
  });
}

function isDaemonAbsentError(error) {
  return ['ENOENT', 'ECONNREFUSED', 'ENXIO'].includes(error?.code);
}

async function waitForDaemonExit(identity, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let socketAbsent = false;
    try {
      const socket = await connectToDaemon(250);
      socket.destroy();
    } catch (error) {
      if (isDaemonAbsentError(error)) socketAbsent = true;
      else throw error;
    }
    const pidGone = !Number.isInteger(identity?.pid) || !processExists(identity.pid);
    const currentState = readDaemonState();
    const stateGone = identity?.instanceId
      ? currentState?.instanceId !== identity.instanceId
      : !Number.isInteger(identity?.pid) || currentState?.pid !== identity.pid;
    if (socketAbsent && pidGone && stateGone) return;
    await delay(50);
  }
  throw new Error(`CDP proxy daemon did not stop within ${timeoutMs}ms`);
}

function printValue(value) {
  if (typeof value === 'string') console.log(value);
  else console.log(JSON.stringify(value, null, 2));
}

function parseJson(value, label = 'JSON') {
  const source = typeof value === 'string' ? value.replace(/^\uFEFF/, '') : value;
  try { return JSON.parse(source); }
  catch (error) { throw new Error(`Invalid ${label}: ${error.message}`); }
}

async function stdinText() {
  let body = '';
  for await (const chunk of process.stdin) body += chunk;
  return body;
}

function commandRequest(command, args) {
  switch (command) {
    case 'connect': return { op: 'connect' };
    case 'list': case 'ls': case 'targets': return { op: 'list', all: args.includes('--all'), includeInternal: args.includes('--internal') };
    case 'open': case 'new': {
      const positional = args.filter(arg => arg !== '--foreground');
      return { op: 'open', url: positional[0] || 'about:blank', background: !args.includes('--foreground') };
    }
    case 'close': return { op: 'close', target: args[0] };
    case 'activate': return { op: 'activate', target: args[0] };
    case 'attach': return { op: 'attach', target: args[0] };
    case 'eval': case 'evaluate': return { op: 'eval', target: args[0], expression: args.slice(1).join(' ') };
    case 'wait': return { op: 'wait', target: args[0], expression: args.slice(1).join(' ') };
    case 'navigate': case 'nav': return { op: 'navigate', target: args[0], url: args[1] };
    case 'reload': return { op: 'reload', target: args[0], ignoreCache: args.includes('--ignore-cache') };
    case 'back': case 'forward': return { op: command, target: args[0] };
    case 'snapshot': case 'snap': return { op: 'snapshot', target: args[0], raw: args.includes('--raw'), compact: !args.includes('--full') };
    case 'html': return { op: 'html', target: args[0], selector: args.slice(1).join(' ') || undefined };
    case 'screenshot': case 'shot': {
      const fullPage = args.includes('--full-page');
      const positional = args.filter(arg => arg !== '--full-page');
      const target = positional[0];
      const file = positional[1]
        ? path.resolve(positional[1])
        : path.resolve(process.cwd(), `cdp-${String(target || 'page').slice(0, 8)}-${Date.now()}.png`);
      return { op: 'screenshot', target, file, fullPage };
    }
    case 'click': return { op: 'click', target: args[0], selector: args.slice(1).join(' ') };
    case 'click-real': return { op: 'click-real', target: args[0], selector: args.slice(1).join(' ') };
    case 'hover-click': return { op: 'hover-click', target: args[0], selector: args.slice(1).join(' ') };
    case 'clickxy': return { op: 'clickxy', target: args[0], x: args[1], y: args[2] };
    case 'type': return { op: 'type', target: args[0], text: args.slice(1).join(' ') };
    case 'key': return { op: 'key', target: args[0], key: args[1], text: args[2] };
    case 'scroll': return { op: 'scroll', target: args[0], deltaY: args[1], deltaX: args[2] };
    case 'set-files': return { op: 'set-files', target: args[0], selector: args[1], files: args.slice(2).map(file => path.resolve(file)) };
    case 'network': case 'net': return { op: 'network', target: args[0] };
    case 'raw': {
      const target = args[0];
      const method = args[1];
      const paramsText = args.slice(2).join(' ');
      return { op: 'raw', target, method, params: paramsText ? parseJson(paramsText, 'CDP params') : {} };
    }
    default: throw new Error(`Unknown command: ${command}`);
  }
}

async function streamEvents(args) {
  await ensureDaemon();
  const token = readOrCreateToken();
  const socket = await connectToDaemon();
  const id = crypto.randomUUID();
  const target = args[0];
  const method = args[1] || '*';
  const durationMs = args[2] ? Number(args[2]) : 60_000;
  const request = { id, token, op: 'subscribe', target, method, durationMs };
  return new Promise((resolve, reject) => {
    let buffer = '';
    let subscriptionId;
    let settled = false;
    const onStdoutDrain = () => {
      socket.resume();
    };
    const writeEvent = value => {
      if (!process.stdout.write(`${JSON.stringify(value)}\n`)) {
        socket.pause();
      }
    };
    const cleanup = () => {
      process.off('SIGINT', onInterrupt);
      process.stdout.off('drain', onStdoutDrain);
      socket.removeAllListeners();
      socket.end();
    };
    const finish = error => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onInterrupt = () => finish();
    process.once('SIGINT', onInterrupt);
    process.stdout.on('drain', onStdoutDrain);
    socket.on('error', finish);
    socket.on('end', () => finish(subscriptionId ? null : new Error('Proxy ended before subscription was accepted')));
    socket.on('data', chunk => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        if (Buffer.byteLength(line) > MAX_IPC_MESSAGE_BYTES) {
          finish(new Error('Event stream exceeded the frame limit'));
          return;
        }
        let message;
        try { message = parseJson(line, 'event message'); }
        catch (error) { finish(error); return; }
        if (message.id === id) {
          if (!message.ok) {
            finish(new Error(message.error?.message || 'Subscription failed'));
            return;
          }
          subscriptionId = message.result.subscriptionId;
          writeEvent(message.result);
        } else if (message.subscriptionId === subscriptionId) {
          writeEvent(message);
          if (message.complete) finish();
        }
      }
      if (Buffer.byteLength(buffer) > MAX_IPC_MESSAGE_BYTES) finish(new Error('Event stream exceeded the frame limit'));
    });
    socket.write(`${JSON.stringify(request)}\n`);
  });
}

async function pipeClient() {
  await ensureDaemon();
  const token = readOrCreateToken();
  const socket = await connectToDaemon();
  let inputBuffer = '';
  let outputBuffer = '';
  let nextId = 0;
  const pending = new Map();
  const activeSubscriptions = new Set();
  const completedSubscriptions = new Set();
  const inputQueue = [];
  const outputQueue = [];
  let inputQueueBytes = 0;
  let outputQueueBytes = 0;
  let socketBackpressured = false;
  let stdoutBackpressured = false;
  let inputEnded = false;
  let socketClosed = false;
  let resolveCompletion;

  const maybeComplete = () => {
    if (socketClosed && !stdoutBackpressured && outputQueue.length === 0) resolveCompletion?.();
  };

  const maybeEnd = () => {
    if (inputEnded && inputQueue.length === 0 && pending.size === 0 && activeSubscriptions.size === 0 && !socket.destroyed) socket.end();
  };

  const fail = error => {
    if (!socket.destroyed) socket.destroy(error);
  };

  const flushOutput = () => {
    if (stdoutBackpressured) return;
    while (outputQueue.length) {
      const line = outputQueue.shift();
      outputQueueBytes -= Buffer.byteLength(line);
      if (!process.stdout.write(line)) {
        stdoutBackpressured = true;
        socket.pause();
        return;
      }
    }
    socket.resume();
    maybeComplete();
  };

  const routeOutputLine = line => {
    if (!line.trim()) return;
    if (Buffer.byteLength(line) > MAX_IPC_MESSAGE_BYTES) {
      fail(new Error('Output frame exceeded the message limit'));
      return;
    }
    let message;
    try { message = JSON.parse(line); }
    catch (error) {
      fail(new Error(`Invalid proxy output: ${error.message}`));
      return;
    }
    if (pending.has(message.id)) {
      const correlation = pending.get(message.id);
      pending.delete(message.id);
      message.id = correlation.clientId;
      if (correlation.op === 'subscribe' && message.ok && message.result?.subscriptionId) {
        const subscriptionId = message.result.subscriptionId;
        if (completedSubscriptions.has(subscriptionId)) completedSubscriptions.delete(subscriptionId);
        else activeSubscriptions.add(subscriptionId);
      }
    }
    if (message.complete === true && message.subscriptionId) {
      if (!activeSubscriptions.delete(message.subscriptionId)) completedSubscriptions.add(message.subscriptionId);
    }
    const encoded = `${JSON.stringify(message)}\n`;
    outputQueue.push(encoded);
    outputQueueBytes += Buffer.byteLength(encoded);
    if (outputQueueBytes > MAX_IPC_MESSAGE_BYTES * 2) {
      fail(new Error('Output queue exceeded the backpressure limit'));
      return;
    }
    flushOutput();
    maybeEnd();
  };

  const onSocketData = chunk => {
    outputBuffer += chunk;
    const lines = outputBuffer.split('\n');
    outputBuffer = lines.pop();
    for (const line of lines) routeOutputLine(line);
    if (Buffer.byteLength(outputBuffer) > MAX_IPC_MESSAGE_BYTES) fail(new Error('Output frame exceeded the message limit'));
  };

  const flushInput = () => {
    if (socketBackpressured || socket.destroyed) return;
    while (inputQueue.length) {
      const line = inputQueue.shift();
      inputQueueBytes -= Buffer.byteLength(line);
      if (!line.trim()) continue;
      if (Buffer.byteLength(line) > MAX_IPC_MESSAGE_BYTES) {
        fail(new Error('Input frame exceeded the message limit'));
        return;
      }
      let request;
      try { request = parseJson(line, 'pipe request'); }
      catch (error) { fail(error); return; }
      if (!request || typeof request !== 'object' || Array.isArray(request)) {
        fail(new Error('Pipe request must be a JSON object'));
        return;
      }
      const clientId = Object.hasOwn(request, 'id') ? request.id : ++nextId;
      const wireId = `pipe:${process.pid}:${crypto.randomUUID()}`;
      const encoded = `${JSON.stringify({ ...request, id: wireId, token })}\n`;
      if (Buffer.byteLength(encoded) > MAX_IPC_MESSAGE_BYTES) {
        fail(new Error('Authenticated input frame exceeded the message limit'));
        return;
      }
      pending.set(wireId, { clientId, op: request.op });
      if (!socket.write(encoded)) {
        socketBackpressured = true;
        process.stdin.pause();
        return;
      }
    }
    maybeEnd();
  };

  const onInputData = chunk => {
    inputBuffer += chunk;
    const lines = inputBuffer.split('\n');
    inputBuffer = lines.pop();
    for (const line of lines) {
      inputQueue.push(line);
      inputQueueBytes += Buffer.byteLength(line);
    }
    if (inputQueueBytes > MAX_IPC_MESSAGE_BYTES * 2) {
      fail(new Error('Input queue exceeded the backpressure limit'));
      return;
    }
    if (Buffer.byteLength(inputBuffer) > MAX_IPC_MESSAGE_BYTES) {
      fail(new Error('Input frame exceeded the message limit'));
      return;
    }
    flushInput();
  };

  const onInputEnd = () => {
    if (inputBuffer.trim()) {
      inputQueue.push(inputBuffer);
      inputQueueBytes += Buffer.byteLength(inputBuffer);
    }
    inputBuffer = '';
    inputEnded = true;
    flushInput();
    maybeEnd();
  };

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', onInputData);
  process.stdin.on('end', onInputEnd);
  socket.on('data', onSocketData);
  socket.on('drain', () => {
    socketBackpressured = false;
    process.stdin.resume();
    flushInput();
  });
  const onStdoutDrain = () => {
    stdoutBackpressured = false;
    flushOutput();
  };
  process.stdout.on('drain', onStdoutDrain);

  try {
    await new Promise((resolve, reject) => {
      resolveCompletion = resolve;
      socket.once('close', hadError => {
        socketClosed = true;
        if (hadError) return;
        if (outputBuffer.trim()) {
          reject(new Error('Proxy closed with an incomplete output frame'));
          return;
        }
        if (pending.size || activeSubscriptions.size) {
          reject(new Error(`Proxy closed with ${pending.size} pending request(s) and ${activeSubscriptions.size} active subscription(s)`));
          return;
        }
        if (!inputEnded || inputBuffer.trim() || inputQueue.length) {
          reject(new Error('Proxy closed before all pipe input was sent'));
          return;
        }
        maybeComplete();
      });
      socket.once('error', reject);
      process.stdin.resume();
    });
  } finally {
    process.stdin.pause();
    process.stdin.off('data', onInputData);
    process.stdin.off('end', onInputEnd);
    process.stdout.off('drain', onStdoutDrain);
  }
}

const USAGE = `CDP Browser Proxy ${VERSION}

Usage: node cdp-proxy.mjs <command> [arguments]

Lifecycle:
  start [--no-connect]                  Start one persistent daemon; authorize browser once
  status                                Show daemon/browser state without starting it
  connect                               Connect/reconnect the daemon to the browser
  stop                                  Stop the daemon (next use may require authorization)

Targets and common operations:
  list [--all] [--internal]             List current targets
  open [url]                            Open a background tab
  close|activate|attach <target>         Manage a target (unique prefixes accepted)
  navigate <target> <url>               Navigate and wait for correlated lifecycle completion
  eval <target> <expression>            Evaluate JavaScript and await promises
  wait <target> <expression>            Poll until an expression is truthy
  snapshot <target> [--raw|--full]      Accessibility tree
  html <target> [selector]              Page or element HTML
  screenshot <target> [file] [--full-page]
  click|click-real|hover-click <target> <selector>
  clickxy <target> <x> <y>              Real click in CSS pixels
  type <target> <text>                   Insert text at the current focus
  key <target> <key> [text]             Dispatch keyDown/keyUp
  scroll <target> [deltaY] [deltaX]      Dispatch a wheel event
  set-files <target> <selector> <files...>
  network <target>                      Resource Timing snapshot

Full CDP and concurrency:
  raw <target|browser|-> <method> [json] Send any CDP command
  events <target|browser|-> <pattern> [durationMs]
  rpc [json]                             Send a full proxy request (or read JSON from stdin)
  batch [json-array] [parallel]          Run requests serially or concurrently
  pipe                                  Persistent NDJSON client over stdin/stdout

Environment: CDP_PROXY_WS_URL, CDP_PROXY_PORT, CDP_PROXY_PORT_FILE,
CDP_PROXY_BROWSER, CDP_PROXY_RUNTIME_DIR, CDP_PROXY_HTTP_PORT.
`;

async function cliMain() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || ['help', '--help', '-h'].includes(command)) {
    console.log(USAGE);
    return;
  }
  if (command === '--version' || command === 'version') {
    console.log(VERSION);
    return;
  }
  if (command === 'daemon') {
    await runDaemon();
    return;
  }
  if (command === 'status') {
    try {
      const response = await requestDaemon({ op: 'health' }, { start: false, timeoutMs: 3_000 });
      if (!response.ok) throw new Error(response.error?.message || 'Status failed');
      printValue(response.result);
    } catch (error) {
      if (!isDaemonAbsentError(error)) throw error;
      printValue({ status: 'stopped', version: VERSION, runtimeDir: RUNTIME_DIR, socket: SOCKET_PATH });
    }
    return;
  }
  if (command === 'start') {
    await ensureDaemon();
    const noConnect = args.includes('--no-connect');
    const response = await requestDaemon(
      { op: noConnect ? 'health' : 'connect' },
      { timeoutMs: noConnect ? 10_000 : CONNECT_REQUEST_TIMEOUT_MS + IPC_TIMEOUT_GRACE_MS },
    );
    if (!response.ok) throw new Error(response.error?.message || 'Unable to start proxy');
    printValue(response.result);
    return;
  }
  if (command === 'stop') {
    const previousState = readDaemonState();
    try {
      const response = await requestDaemon({ op: 'shutdown' }, { start: false, timeoutMs: 3_000 });
      if (!response.ok) throw new Error(response.error?.message || 'Unable to stop proxy');
      const identity = {
        pid: Number.isInteger(response.result?.pid) ? response.result.pid : previousState?.pid,
        instanceId: response.result?.instanceId || previousState?.instanceId,
      };
      await waitForDaemonExit(identity);
      printValue(response.result);
    } catch (error) {
      if (!isDaemonAbsentError(error)) throw error;
      printValue({ stopped: true, alreadyStopped: true });
    }
    return;
  }
  if (command === 'events') {
    await streamEvents(args);
    return;
  }
  if (command === 'pipe') {
    await pipeClient();
    return;
  }

  let request;
  if (command === 'rpc') {
    const source = args.join(' ') || (await stdinText()).trim();
    request = parseJson(requireString(source, 'RPC JSON'), 'RPC request');
  } else if (command === 'batch') {
    const mode = args.at(-1) === 'parallel' ? 'parallel' : 'serial';
    const jsonArgs = mode === 'parallel' ? args.slice(0, -1) : args;
    const source = jsonArgs.join(' ') || (await stdinText()).trim();
    request = { op: 'batch', mode, commands: parseJson(requireString(source, 'batch JSON'), 'batch array') };
  } else {
    request = commandRequest(command, args);
  }

  const operationTimeoutMs = request.op === 'connect'
    ? CONNECT_REQUEST_TIMEOUT_MS
    : boundedTimeout(request.timeoutMs, 120_000);
  const response = await requestDaemon(request, { timeoutMs: operationTimeoutMs + IPC_TIMEOUT_GRACE_MS });
  if (!response.ok) {
    const error = new Error(response.error?.message || 'Proxy request failed');
    Object.assign(error, response.error || {});
    throw error;
  }
  printValue(response.result);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(SCRIPT_PATH);
if (isMain) {
  cliMain().catch(error => {
    console.error(error.message || String(error));
    process.exitCode = 1;
  });
}

export const runtimePaths = Object.freeze({
  runtimeDir: RUNTIME_DIR,
  socket: SOCKET_PATH,
  token: TOKEN_PATH,
  state: STATE_PATH,
  log: LOG_PATH,
});
