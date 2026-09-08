# IRC presentation on the experimental server (`pi irc`)

Date: 2026-09-07. Status: implemented under `packages/coding-agent/src/experimental/irc/`.

`pi irc` runs the experimental server in-process and joins an IRC network as a
bot. Every channel it is in (and every DM peer) has its own Session, and the
sessions are whatever the server's settings select: started from a directory
whose `mcpJs` setting names a coordinator, each channel is an mcp-js sandbox
with `read`, `write`, and `run_js` on its own empty filesystem snapshot.

    PI_EXPERIMENTAL=1 ./pi-test.sh irc --server irc.example --port 6667 --nick pi [--web-port 8600]

## Talking to it

In a channel the bot only reacts to lines that mention its nick: a leading
address (`pi: list the files`, `pi, …`, `@pi …`) is stripped, and a mention
anywhere else (`does pi know?`) sends the whole line. Matching is
case-insensitive on whole words, so `piano` and `api` are not mentions.
Unmentioned chatter is never a prompt. DMs are addressed by nature and always
count. Reacting to every channel line is an explicit opt-in (`--all` /
`IRC_RESPOND_TO_ALL=1`) and off by default. Each line becomes the prompt `[IRC #chan] <nick> text` to that
channel's Session. While a turn runs, further lines are delivered as steering.
The bot relays every completed assistant message as channel lines, and one
line per tool call and result (`[run_js] 3 lines: …`, `[read] → hi`).

## Commands

Comma-prefixed. Inside a mention they work anywhere (`pi ,model astra`,
`pi: ,thinking high`); bare `,command` lines are honored in the control
channel (default `#pi`) and DMs. `,help` lists all of them.

Session commands act on the channel's own Session and are the same set the
browser composer has as `/model`, `/thinking`, `/compact`, `/reload`
(shared parser in `session-commands.ts`):

| Command | Effect |
| --- | --- |
| `,model [query]` | No query: show the current model and the available ones. With a query: select the first model whose `provider/id name` contains it (case-insensitive), the same filter as the web picker. |
| `,thinking [level]` | Set the thinking level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`); no level cycles. |
| `,compact [instructions]` | Compact the Session context. |
| `,reload` | Reload the Session's plugins. |

Channel control commands, accepted in the control channel and DMs:

| Command | Effect |
| --- | --- |
| `,join #a,#b` | Join channels; each gets a new Session (or its remembered one). |
| `,fork #chan [#from]` | Join `#chan` with a Session forked from `#from` (default: the channel the command was typed in). The conversation tree is copied with `SessionManagement.fork`; with an mcp-js coordinator the source's latest heap and filesystem snapshot are carried over too (`engine-fork.ts`). |
| `,part #chan` | Leave; the Session is kept and reused on the next `,join`. |
| `,sessions` | List channel → session. |
| `,help` | Command reference. |

Channel → session mappings live in `<agentDir>/irc/channels.json`
(`PI_IRC_STATE_DIR` or `--state-dir`), so a restart rejoins every remembered
channel and reattaches its Session.

## Configuration

Flags win over environment variables:

| Flag | Env | Default |
| --- | --- | --- |
| `--server` | `IRC_SERVER` | required |
| `--port` | `IRC_PORT` | 6667, or 6697 with TLS |
| `--tls` | `IRC_TLS` | off |
| `--nick` | `IRC_NICK` | `pi` |
| `--password` | `IRC_PASSWORD` | none (server PASS) |
| `--channels` | `IRC_CHANNELS` | control channel only |
| `--control-channel` | `IRC_CONTROL_CHANNEL` | `#pi` |
| `--all` | `IRC_RESPOND_TO_ALL` | off |
| `--state-dir` | `PI_IRC_STATE_DIR` | `<agentDir>/irc` |
| `--web-port`, `--web-token` | `PI_WEB_PORT`, `PI_WEB_TOKEN`, `PI_WEB_HOST` | web gateway off |

With `--web-port`, the `pi web` gateway runs on the same server, so every
channel's Session can be watched in the browser.

## How it is built

- `session-link.ts`: one client connection per channel (a connection holds
  one attachment), the built-in services, and a prompt driver that relays
  `message_end` and `tool_start`/`tool_end` events from the Transcript state.
- `bot.ts`: irc-framework client, message routing, control commands, a
  per-target send queue with spacing to stay under flood limits.
- `SessionManagement.fork` is new on the server: `repo.fork` with tree scope,
  exposed through the same client wrapper the TUI and web app use.

Tests: `test/experimental-irc.test.ts` (commands, formatting, store, engine
fork over a fake coordinator, config) and the fork case in
`test/experimental-remote-runtime.test.ts`.
