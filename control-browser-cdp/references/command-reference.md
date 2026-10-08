# CDP Browser Proxy Reference

## Contents

1. Browser prerequisites
2. Lifecycle and target commands
3. Browser actions
4. Raw CDP, batches, and event streams
5. NDJSON IPC protocol
6. Optional HTTP adapter
7. Environment variables
8. Concurrency and failure semantics
9. Troubleshooting

## 1. Browser prerequisites

Require Node.js 22 or newer. Enable remote debugging in Chrome, Edge, Brave, or Chromium before connecting the proxy. Prefer the browser's supported remote-debugging UI when available. When launching with a command-line flag, use a dedicated browser profile if the browser requires one.

The proxy discovers the browser in this order:

1. `CDP_PROXY_WS_URL`
2. `CDP_PROXY_PORT`
3. `CDP_PROXY_PORT_FILE`
4. Known `DevToolsActivePort` files for Chrome, Edge, Brave, and Chromium
5. Loopback ports from `CDP_PROXY_SCAN_PORTS` (default `9222,9229,9333`) through `/json/version`

The daemon never launches a browser. It owns exactly one successful browser-level WebSocket and keeps it open until the browser disconnects or the daemon stops. Every page or worker is attached with `Target.attachToTarget` and `flatten: true` on that connection.

Chrome 144+ may run the server enabled at `chrome://inspect/#remote-debugging` in approval-only mode. That server deliberately returns HTTP 404 for `/json/version`, `/json/list`, and other JSON discovery paths. When a valid `DevToolsActivePort` file or an explicit `CDP_PROXY_PORT` selects such a server, the proxy falls back to `ws://<host>:<port>/devtools/browser`; Chrome can then ask the user to approve that connection. This is distinct from the traditional GUID endpoint used by `--remote-debugging-port` with a non-default profile.

## 2. Lifecycle and target commands

Use this placeholder in the examples:

```text
node "<skill-dir>/scripts/cdp-proxy.mjs"
```

```text
... start [--no-connect]
... status
... connect
... stop
... list [--all] [--internal]
... open [url] [--foreground]
... close <target-prefix>
... activate <target-prefix>
... attach <target-prefix>
```

`start` creates the local daemon and normally waits for the browser connection. `--no-connect` starts only local IPC, which is useful for diagnostics. `status` never starts a missing daemon. `stop` waits for the pipe, daemon process, and matching state file to disappear before it reports success. `open` creates a background target unless `--foreground` is supplied.

`list` returns current page targets with an eight-character display ID. Longer prefixes are accepted and required when a short prefix is ambiguous. Use `--all` to include workers and other CDP target types.

`status` reports daemon health and browser health separately. Treat the connection as ready only when `browser.connected` is `true`; `status: ok` alone means only that the local daemon responded. After connection, run `list` and verify that the intended browser's tabs are present. A daemon keeps the endpoint configuration from its original `start`, so changing environment variables requires `stop` followed by `start`.

## 3. Browser actions

```text
... navigate <target> <url>
... reload <target> [--ignore-cache]
... back <target>
... forward <target>
... eval <target> <JavaScript expression>
... wait <target> <truthy JavaScript expression>
... snapshot <target> [--raw|--full]
... html <target> [CSS selector]
... screenshot <target> [output-file] [--full-page]
... click <target> <CSS selector>
... click-real <target> <CSS selector>
... hover-click <target> <CSS selector>
... clickxy <target> <x> <y>
... type <target> <text>
... key <target> <key> [text]
... scroll <target> [deltaY] [deltaX]
... set-files <target> <CSS selector> <file...>
... network <target>
```

Coordinates use CSS pixels. `click` invokes the element's DOM `click()` method. `click-real` and `hover-click` calculate the element center and send `Input.dispatchMouseEvent`; they are still automation and do not promise bypass of site detection.

Navigation helpers correlate main-frame lifecycle events with the loader created by the command. Same-document navigation completes only when its reported URL matches the requested or selected history URL; unrelated `pushState`/`replaceState` traffic does not satisfy a reload or cross-document wait.

`type` uses `Input.insertText` at the current focus. Use `click-real` first when focus is uncertain. Use raw `Input.dispatchKeyEvent` when exact key codes, modifiers, or composition events matter.

`network` returns the page's Resource Timing entries. Use raw `Network.enable` plus `events` for headers, status codes, request bodies, failures, WebSockets, or interception.

## 4. Raw CDP, batches, and event streams

Send any browser-scope command without a session:

```text
... raw browser Browser.getVersion '{}'
... raw browser Target.createBrowserContext '{}'
```

Send any target-session command through a target prefix:

```text
... raw A1B2C3D4 DOM.getDocument '{"depth":2,"pierce":true}'
... raw A1B2C3D4 Network.enable '{}'
```

Use `rpc` when fields such as `timeoutMs`, a known `sessionId`, or helper-specific options are needed:

```json
{
  "op": "raw",
  "target": "A1B2C3D4",
  "method": "Runtime.evaluate",
  "params": {"expression": "document.title", "returnByValue": true},
  "timeoutMs": 45000
}
```

Pass the JSON as the next argument or through stdin:

```text
... rpc '{...}'
... rpc < request.json
```

Run ordered commands with a serial batch:

```json
[
  {"op":"navigate","target":"A1B2C3D4","url":"https://example.com"},
  {"op":"snapshot","target":"A1B2C3D4"}
]
```

Run independent commands concurrently by appending `parallel` to the `batch` invocation or by setting `{"op":"batch","mode":"parallel","commands":[...]}` through `rpc`. A batch is not a CDP transaction; a failed or timed-out browser command cannot roll back earlier actions.

Stream exact events or a domain prefix:

```text
... events A1B2C3D4 'Network.*' 60000
... events browser 'Target.*' 60000
```

Target subscriptions infer and enable the event domain when possible. Subscribe before the action. Each event includes `subscriptionId`, `seq`, `generation`, `targetId`, `sessionId`, `method`, and `params`.

## 5. NDJSON IPC protocol

The socket path is reported by `status`. It is a Unix domain socket on macOS/Linux and a Windows named pipe on Windows. Read the random token from the `token` file under the reported runtime directory.

Send one UTF-8 JSON object per line:

```json
{"id":"client-1:42","token":"<token>","op":"raw","target":"A1B2C3D4","method":"Runtime.evaluate","params":{"expression":"location.href","returnByValue":true}}
```

Receive an ID-correlated response:

```json
{"id":"client-1:42","ok":true,"result":{"result":{"result":{"type":"string","value":"https://example.com/"}},"sessionId":"...","targetId":"..."}}
```

Errors are structured:

```json
{"id":"client-1:42","ok":false,"error":{"name":"CDPError","message":"Page.navigate: ...","code":-32000}}
```

Multiple lines and multiple clients may be in flight concurrently. IDs belong to the client protocol; the daemon maps them to separate monotonically increasing upstream CDP IDs. Use `pipe` to reuse one authenticated IPC connection from stdin/stdout. It emits NDJSON, applies backpressure in both directions, accepts a final input object without a newline, and uses private wire IDs so duplicate or structured client IDs remain correctly correlated. The default frame limit is 32 MiB, each client may hold 256 requests, and the browser connection may hold 2048 pending commands.

Subscription request:

```json
{"id":7,"token":"<token>","op":"subscribe","target":"A1B2C3D4","method":"Network.*","durationMs":60000,"maxEvents":10000}
```

Unsubscribe on the same socket:

```json
{"id":8,"token":"<token>","op":"unsubscribe","subscriptionId":"<subscription-id>"}
```

`pipe` remains open after stdin ends while an accepted subscription is active, then exits after its `complete` frame. Closing the IPC client aborts unfinished local work and removes upstream response waiters; it cannot undo a command that the browser already received.

## 6. Optional HTTP adapter

Set `CDP_PROXY_HTTP_PORT` before starting the daemon to expose an optional loopback-only adapter. It is disabled by default. Supply the runtime token on every request:

```text
Authorization: Bearer <token>
Content-Type: application/json
```

Use `POST /rpc` with one proxy request object. Use authenticated `GET /health` only for status. Streaming subscriptions and shutdown remain IPC-only. The adapter rejects unexpected Host or Origin values, non-JSON RPC bodies, oversized bodies, and mutation through GET.

## 7. Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `CDP_PROXY_WS_URL` | Exact browser WebSocket URL | auto-discover |
| `CDP_PROXY_HOST` | Debug endpoint host | `127.0.0.1` |
| `CDP_PROXY_PORT` | Debug port; resolve through `/json/version`, or use the guid-less approval WS when the explicit port returns 404 | unset |
| `CDP_PROXY_PORT_FILE` | Exact `DevToolsActivePort` file | unset |
| `CDP_PROXY_BROWSER` | `auto`, `chrome`, `edge`, `brave`, or `chromium` | `auto` |
| `CDP_PROXY_SCAN_PORTS` | Comma-separated fallback ports | `9222,9229,9333` |
| `CDP_PROXY_RUNTIME_DIR` | Token, state, log, and Unix socket directory | per-user cache |
| `CDP_PROXY_SOCKET` | Override Unix socket or Windows pipe path | per-user stable path |
| `CDP_PROXY_HTTP_PORT` | Enable loopback HTTP RPC | disabled |
| `CDP_PROXY_COMMAND_TIMEOUT_MS` | Default upstream command timeout | `30000` |
| `CDP_PROXY_CONNECT_TIMEOUT_MS` | One WebSocket handshake timeout | `10000` |
| `CDP_PROXY_CONNECT_ATTEMPTS` | Shared connection attempts | `12` |
| `CDP_PROXY_HEARTBEAT_MS` | Keepalive and reconnect interval | `20000` |
| `CDP_PROXY_MAX_PENDING` | Global upstream commands | `2048` |
| `CDP_PROXY_MAX_CLIENT_PENDING` | Requests per IPC client | `256` |
| `CDP_PROXY_MAX_SUBSCRIPTIONS` | Active subscriptions per IPC client | `32` |
| `CDP_PROXY_MAX_MESSAGE_BYTES` | One IPC/HTTP frame | `33554432` |
| `CDP_PROXY_MAX_WS_BUFFER_BYTES` | Maximum queued WebSocket bytes before waiting | `8388608` |
| `CDP_PROXY_MAX_BATCH` | Commands accepted in one batch | `1000` |

Set environment variables before the first `start`. A running daemon retains its startup configuration.

## 8. Concurrency and failure semantics

- One shared `connectPromise` prevents simultaneous clients from opening multiple browser WebSockets.
- Concurrent target lookups share one refresh, and discovered target metadata is reused for later session acquisition.
- One shared attach promise per target prevents duplicate flattened sessions.
- Upstream IDs correlate out-of-order command responses; event filters include `sessionId`.
- Different targets can run concurrently. Helper macros serialize their own multi-step action on the same target where ordering matters.
- Raw commands remain concurrent and can intentionally alter shared CDP domain state.
- The daemon rejects all pending commands immediately when the browser WebSocket closes.
- A client disconnect aborts that client's unfinished waits, lock queues, batches, and upstream response waiters. Input helpers still make a best-effort key-up or mouse-up after cancellation.
- The daemon never auto-replays a sent command. Repeating a click, navigation, input, upload, or download after disconnect could duplicate the action.
- The heartbeat reconnects only after a connection had previously succeeded. A browser restart creates a new generation and invalidates old target and session IDs.
- The daemon does not exit when idle. An explicit stop performs bounded cleanup and then terminates even if an upstream WebSocket peer never acknowledges its close frame.

## 9. Troubleshooting

`No Chromium remote-debugging endpoint was found`:

- Enable remote debugging in the intended browser.
- Set `CDP_PROXY_BROWSER` when several Chromium browsers are installed.
- Set `CDP_PROXY_PORT` or `CDP_PROXY_WS_URL` for a nonstandard endpoint.
- Keep the browser debug listener on loopback.

`Unable to establish the persistent browser CDP connection`:

- Approve the browser debugging prompt.
- Inspect the `browser.lastError` field from `status` and the reported proxy log.
- Verify `/json/version` on the selected loopback port.
- Do not start either original proxy in parallel; another upstream WebSocket can cause another approval prompt.

`HTTP 404` while Chrome shows `Server running at 127.0.0.1:<port>`:

- First run `status`; an old daemon may still be connected to another browser or port.
- Stop the old daemon before changing its endpoint configuration.
- Set `CDP_PROXY_BROWSER=chrome` and preferably `CDP_PROXY_PORT=<port>`, then start again. A valid Chrome `DevToolsActivePort` file is also auto-detected.
- For a manual WebSocket override in approval mode, use `CDP_PROXY_WS_URL=ws://127.0.0.1:<port>/devtools/browser` without a GUID suffix.
- Approve Chrome's connection prompt if it appears, then require `browser.connected: true` and verify the target list.
- Do not treat `/json/*` returning 404 as proof that the port is not Chrome when the browser explicitly reports an approval-mode server.

`No target matches prefix`:

- Run `list` again. Tabs and browser restarts change targets.

`Target prefix is ambiguous`:

- Supply more characters from `targetId`.

`CDP backpressure limit reached`:

- Reduce fan-out, consume event streams promptly, or split work into bounded batches.

Unexpected action after a disconnect:

- Inspect current URL, DOM, and page state before retrying. The proxy reports failure but cannot know whether a command reached the browser immediately before transport loss.
