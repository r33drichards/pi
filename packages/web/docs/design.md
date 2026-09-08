# Sessions-only web UI on the experimental server

Date: 2026-09-07. Status: agreed, not yet implemented.

## Goal

A browser UI for pi with sessions and nothing else: no projects, no
workspaces, no host directory. Every session runs on the mcp-js execution
environment (`read`, `write`, `run_js`; no bash) and starts with an empty
session snapshot. The UI reaches the existing experimental server; it does not
fork pi-web.

## Why this shape

- The experimental server already runs sessions on mcp-js through the session
  worker, keeps them durable, and replicates the lane to presentations. A
  browser is one more presentation.
- `@earendil-works/pi-client` and `pi-protocol` are browser-safe (they are in
  the repo's browser smoke bundle). `activateBuiltinClientServices` in
  `packages/coding-agent/src/experimental/client-runtime.ts` binds every
  service the TUI uses and is transport-neutral; only Unix socket discovery
  is Node-specific.
- pi-web embeds the classic SDK `AgentSession`, which does not know the
  mcp-js environment. Forking it would mean a second integration of mcp-js
  into a different session path.

## Process layout

New package `packages/web` (`@earendil-works/pi-web-sessions`, private,
development-only like `client` and `server`). One command:

    PI_EXPERIMENTAL=1 pi web [--port 8600] [--host 127.0.0.1] [--token <t>]

`pi web` starts the foreground experimental server in-process (the same
`startForegroundServer` that `pi server` uses), then an HTTP server that
serves the bundled app and accepts WebSocket upgrades at `/ws`. Each WebSocket
is a byte relay to the server's Unix socket: one Unix connection per browser
connection, bytes copied both ways, close propagated both ways. The gateway
does not decode the protocol, so `pi-server` and `pi-protocol` are unchanged.

Sessions run on mcp-js because the server is started from a directory whose
settings select it (`mcpJs` in project or global settings), as today. There
is no cwd concept in the UI; every mcp-js session starts with an empty
snapshot mounted at `/`.

Auth in v1: bind `127.0.0.1`; when `--token` is given, the upgrade must carry
`?token=` matching it, otherwise 401. No multi-user model.

## Browser app

Plain TypeScript, bundled with esbuild (already a repo dependency) into
`packages/web/dist/public/`. `lit` is the only new dependency, used for
templating so per-delta transcript updates re-render cheaply.

Startup: open a WebSocket to `/ws`, wrap it as a `ByteTransportFactory`,
`Client.connect`, build `ServerServiceSource` and `SessionServiceSource`
exactly as `openClientRuntime` does, then `activateBuiltinClientServices`.

Regions:

- Sessions list: from `SessionDirectory` replicated state. New session calls
  `SessionManagement.create` then `attach`; delete calls `remove`. Selecting a
  session calls `attach`. Session label is its name or first user message.
- Transcript: renders the `Transcript` service's replicated `LaneSnapshot`
  (`snapshot.transcript`, `operation.streamingMessage`,
  `operation.runningTools`, `queues`). Cards for user, assistant (text,
  thinking collapsed), and tool calls. `run_js` shows code and output;
  `read` and `write` show path and result. Streaming text and partial tool
  arguments come from the same snapshot, as in `client-tui-chat.ts`.
- Composer: textarea, Enter sends via `AgentController.prompt`, Shift+Enter
  newline. While an operation runs, Enter queues via `steer` and an Abort
  button calls `requestAbort`. Model picker and thinking level from the
  `Models` service, plus Compact and Reload buttons.
- Slash commands: the composer parses `/model <query>`, `/thinking <level>`,
  `/compact`, `/reload` with a small autocomplete popup, mapping to the same
  service calls as the buttons. This is a browser-local registry, mirroring
  the TUI's `SlashCommands` which never crosses the wire.

## Error handling

- WebSocket close or server error shows a banner with a Reconnect button;
  reconnect re-runs startup and re-attaches the selected session.
- Service call failures surface as a toast with the server's error message.
- A replicated-state gap (chord throws and clears) is treated like a
  disconnect: re-subscribe by re-attaching.

## Testing

- Relay unit tests (vitest, Node): bytes pass in both directions across
  fragmentation; wrong or missing token gets 401; closing either side closes
  the other.
- The app entry is added to `scripts/browser-smoke-entry.ts` so a Node-only
  import in any module it pulls in fails `npm run check`.
- Composer command parsing has unit tests.
- One scripted Playwright run against `pi web`: create a session, send a
  prompt that writes and reads a file through `run_js`, assert the `run_js`
  card and final answer render.

## Not in v1

Files pane for the session snapshot, session rename, multi-user auth,
presentation plugin facets, resuming the TUI's `PresentationUI` capabilities,
any seeding of the snapshot from a host directory.
