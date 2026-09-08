# Sessions-only web UI on the experimental server

Date: 2026-09-07. Status: implemented under `packages/coding-agent/src/experimental/web/`.

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

Everything lives in `packages/coding-agent/src/experimental/web/`, next to
the terminal client, and is development-only like the rest of the
experimental tree (excluded from the published build). One command:

    PI_EXPERIMENTAL=1 pi web [--port 8600] [--host 127.0.0.1] [--token <t>]

`pi web` starts the foreground experimental server in-process (the same
`startForegroundServer` that `pi server` uses), bundles the app with esbuild
into a temporary directory, then starts an HTTP server that serves it and
accepts WebSocket upgrades at `/ws` (`web/run.ts`, `web/build.ts`,
`web/gateway.ts`). Each WebSocket
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

Plain TypeScript in `web/app/`, bundled with esbuild (already a repo
dependency). `lit` is the only new dependency, used for templating so
per-delta transcript updates re-render cheaply. The app directory has its own
`tsconfig.json` with the DOM lib and is excluded from the root program;
`npm run check:experimental-web` typechecks it. `activateBuiltinClientServices`
moved to the browser-safe `client-services.ts` so the terminal client and the
app share it.

Startup (`web/app/runtime.ts`): fetch `/api/server` for the server id, open a
WebSocket to `/ws` wrapped as a `ByteTransportFactory`, `Client.connect`,
build `ServerServiceSource` and `SessionServiceSource` exactly as
`openClientRuntime` does, then `activateBuiltinClientServices`.

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

- `test/experimental-web-gateway.test.ts`: bytes pass in both directions;
  wrong or missing token gets 401; only `/ws` upgrades; closing either side
  closes the other; static files cannot escape the app directory.
- `test/experimental-web-build.test.ts`: the bundle builds for the browser and
  contains no Node builtin imports.
- `test/experimental-web-commands.test.ts`: composer command parsing and
  completion. `test/experimental-cli-resolution.test.ts` covers `pi web`
  options.
- Verified by hand with Playwright against `pi web` started from a directory
  with an `mcpJs` coordinator setting: create a session, prompt, `run_js`
  writes `/notes.txt`, `read` returns it, the final answer renders, no
  console errors.

## Notes

- The sidebar lists every session in the server's session directory, which
  is shared by all experimental servers on the machine, not only sessions
  created from the browser.
- Model, thinking, compact, and reload are available both as toolbar
  controls and as `/model`, `/thinking`, `/compact`, `/reload` in the
  composer, with a completion popup while typing a command.

## Not in v1

Files pane for the session snapshot, session rename, multi-user auth,
presentation plugin facets, resuming the TUI's `PresentationUI` capabilities,
any seeding of the snapshot from a host directory.
