---
name: control-browser-cdp
description: Control and automate an existing Chrome, Edge, Brave, or Chromium browser through a persistent single-connection Chrome DevTools Protocol proxy. Use when Codex needs to authorize remote debugging once, preserve the browser's logged-in profile and tabs, control multiple targets concurrently, evaluate JavaScript, inspect DOM or accessibility state, capture screenshots, send arbitrary CDP methods, stream CDP events, or start, diagnose, and stop the bundled local CDP daemon.
---

# Control Browser through a Persistent CDP Proxy

Use the bundled Node.js proxy to keep one browser-level WebSocket alive and multiplex every tab through flattened CDP sessions. Route all later browser work through the daemon so the browser does not receive a new debugging connection for every command or tab.

## Start and reuse the daemon

1. Require Node.js 22 or newer and an already enabled Chromium remote-debugging endpoint.
2. Run `node "<skill-dir>/scripts/cdp-proxy.mjs" start`.
3. Ask the user to approve the browser's debugging prompt once if it appears. Wait for `browser.connected: true`.
4. Keep the daemon running. Do not connect another script directly to the browser WebSocket and do not restart the daemon between operations.
5. Run `node "<skill-dir>/scripts/cdp-proxy.mjs" list` and use a unique target ID prefix in later commands.

Set `CDP_PROXY_BROWSER=edge`, `chrome`, `brave`, or `chromium` when multiple browser debug endpoints exist. Prefer `CDP_PROXY_WS_URL` or `CDP_PROXY_PORT` when automatic discovery is ambiguous.

Chrome 144+ can expose `chrome://inspect/#remote-debugging` in approval-only mode. In that mode `/json/version` and other `/json/*` paths return HTTP 404 by design. The proxy now recognizes this when a valid `DevToolsActivePort` file or explicit `CDP_PROXY_PORT` identifies the browser and connects to the stable `ws://127.0.0.1:<port>/devtools/browser` approval endpoint. Do not copy the GUID-suffixed path from a stale `DevToolsActivePort` file into `CDP_PROXY_WS_URL`; if an exact override is necessary for approval mode, use the guid-less browser path. Read [references/command-reference.md](references/command-reference.md) for the diagnostic sequence.

## Choose the narrowest useful interface

- Use helper commands such as `navigate`, `eval`, `snapshot`, `screenshot`, `click-real`, `type`, and `set-files` for routine automation.
- Use `raw <target|browser> <CDP.method> [params-json]` for any protocol method not wrapped by a helper. Use `browser` for browser-scope methods and a target prefix for target-session methods.
- Use `events <target|browser> <Domain.event-or-prefix>` when the result depends on CDP events. The proxy filters events by flattened `sessionId` and includes the resolved target ID.
- Use `batch` with serial mode for ordered actions. Use parallel mode only for independent work, preferably across different targets.
- Use `pipe` or connect directly to the documented local NDJSON socket when many commands must share one client process with minimal overhead. `pipe` preserves client IDs, supports duplicate or structured IDs safely, and keeps subscription streams open through their completion frame.

Read [references/command-reference.md](references/command-reference.md) for complete commands, request schemas, environment variables, browser setup, and troubleshooting.

## Preserve correctness under concurrency

- Resolve targets from a fresh `list`; do not cache target IDs across a browser restart.
- Treat high-level multi-step actions on one target as ordered state changes. Avoid simultaneous navigations or click/type sequences on the same target.
- Allow raw CDP requests to run concurrently when their semantics are independent. Use one parallel batch to fan out across tabs.
- Subscribe before triggering an event-producing action when the event cannot be reconstructed afterward.
- Treat a connection-loss error as an unknown outcome for a command already sent. Re-check page state before repeating navigation, clicks, typing, uploads, or downloads.
- Closing an IPC or HTTP client cancels its unfinished proxy work and frees local pending slots. A CDP command may already have reached the browser, so cancellation is not a transaction rollback.
- Expect a new browser authorization only after the sole upstream WebSocket is genuinely lost, the browser restarts, or the daemon is stopped. Software cannot preserve an authorization across a destroyed browser debugging endpoint.

## Apply local security boundaries

- Keep the default authenticated Unix socket or Windows named pipe. The proxy stores its random token in the per-user runtime directory.
- Leave the HTTP adapter disabled unless another local program requires it. If enabled with `CDP_PROXY_HTTP_PORT`, send the same token as `Authorization: Bearer <token>` and use only loopback.
- Treat `eval`, raw CDP, screenshots, DOM reads, and file uploads as access to the user's logged-in browser. Do not expose the socket, token, debug port, or browser WebSocket to untrusted users or networks.
- Confirm local file paths before `set-files` or an explicit screenshot destination.

## Diagnose without breaking persistence

Run `status` first. `status: ok` means the daemon is alive; it does not prove browser control. Require `browser.connected: true`, then confirm a fresh `list` returns the intended targets. If the daemon is alive but disconnected, run `connect`; this reuses the single connection state machine. A running daemon retains the environment selected at `start`, so replace it with `stop` + `start` when changing browser, port, port file, or WebSocket URL. Inspect the log path reported by `status` only when connection or daemon startup fails. Run `stop` only when the user asks to end control or when replacing a broken or misconfigured daemon, because the next start may require browser approval again.

Run `node "<skill-dir>/scripts/cdp-proxy-selftest.mjs"` after modifying the proxy. The test covers connection, target-refresh, and attach single-flight behavior; 200-command response correlation; WebSocket and pending-command bounds; target destruction/detachment races; navigation lifecycle correlation; request cancellation and lock integrity; event cleanup; parallel batches; priority input release; and heartbeat safety under load.
