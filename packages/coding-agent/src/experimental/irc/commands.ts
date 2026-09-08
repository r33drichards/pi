/**
 * Commands typed in IRC. Comma-prefixed, like the irc-agent bot's command
 * prefixes, so they never collide with ordinary chat. The set is the union of
 * the session commands every presentation has (`,model`, `,thinking`,
 * `,compact`, `,reload`, see `session-commands.ts`) and the channel control
 * commands only this presentation has:
 *
 *   ,join #a,#b     join channels; each gets its own session
 *   ,fork #chan     join #chan with a session forked from the current channel's
 *   ,part #chan     leave a channel; its session stays for a later ,join
 *   ,sessions       list channel -> session
 *   ,help
 *
 * A mention whose body starts with `,` is a command (`pi ,model astra`); a
 * bare `,command` is honored in the control channel and DMs.
 */

import { parseSessionCommand, SESSION_COMMANDS, type SessionCommandAction } from "../session-commands.ts";

export type ControlCommand =
	| { kind: "join"; channels: string[] }
	| { kind: "fork"; channel: string; from?: string }
	| { kind: "part"; channel: string }
	| { kind: "sessions" }
	| { kind: "help" };

export type IrcCommand = ControlCommand | SessionCommandAction;

export const COMMAND_PREFIX = ",";

const CONTROL_COMMANDS = [
	{ usage: "join #a,#b", description: "join channels, one session each" },
	{ usage: "fork #chan [#from]", description: "join #chan with a session forked from #from (default: this channel)" },
	{ usage: "part #chan", description: "leave a channel (its session is kept)" },
	{ usage: "sessions", description: "list channel → session" },
	{ usage: "help", description: "this list" },
] as const;

export const HELP_LINES = [
	...SESSION_COMMANDS.map((command) => `,${command.usage} — ${command.description}`),
	...CONTROL_COMMANDS.map((command) => `,${command.usage} — ${command.description}`),
	"Mention me to talk (pi: … / … pi …) or DM me; `pi ,model astra` runs a command in a mention.",
];

const CHANNEL = /^[#&][^\s,]{1,63}$/;

export function isChannel(name: string): boolean {
	return CHANNEL.test(name);
}

/** Split a comma or space separated channel list, validating each entry. */
export function parseChannelList(text: string): { channels: string[]; invalid: string[] } {
	const channels: string[] = [];
	const invalid: string[] = [];
	for (const raw of text.split(/[,\s]+/)) {
		const name = raw.trim();
		if (name.length === 0) continue;
		if (isChannel(name)) {
			if (!channels.includes(name.toLowerCase())) channels.push(name.toLowerCase());
		} else invalid.push(name);
	}
	return { channels, invalid };
}

/** Parse a line as a command; undefined when it is not one. */
export function parseCommand(line: string): IrcCommand | undefined {
	const text = line.trim();
	if (!text.startsWith(COMMAND_PREFIX)) return undefined;
	const match = /^,(\w+)(?:\s+([\s\S]*))?$/.exec(text);
	if (!match) return undefined;
	const [, name, rest = ""] = match;
	const argument = rest.trim();
	const session = parseSessionCommand(name!, argument);
	if (session) return session;
	switch (name!.toLowerCase()) {
		case "join": {
			const { channels, invalid } = parseChannelList(argument);
			if (invalid.length > 0) return { kind: "error", message: `Not a channel: ${invalid.join(", ")}` };
			if (channels.length === 0) return { kind: "error", message: "Usage: ,join #channel[,#other]" };
			return { kind: "join", channels };
		}
		case "fork": {
			const { channels, invalid } = parseChannelList(argument);
			if (invalid.length > 0 || channels.length === 0 || channels.length > 2) {
				return { kind: "error", message: "Usage: ,fork #channel [#from]" };
			}
			const [channel, from] = channels;
			return from === undefined ? { kind: "fork", channel: channel! } : { kind: "fork", channel: channel!, from };
		}
		case "part": {
			const { channels } = parseChannelList(argument);
			if (channels.length !== 1) return { kind: "error", message: "Usage: ,part #channel" };
			return { kind: "part", channel: channels[0]! };
		}
		case "sessions":
			return { kind: "sessions" };
		case "help":
			return { kind: "help" };
		default:
			return { kind: "error", message: `Unknown command ,${name}. Try ,help` };
	}
}

/**
 * Whether a channel line mentions the bot, and the text to prompt with. A
 * leading address (`nick: text`, `nick, text`, `@nick text`) is stripped;
 * a mention anywhere else in the line (`does nick know?`) keeps the whole
 * line. Matching is case-insensitive on whole words, so `pi` does not match
 * `piano`. Unmentioned channel chatter is never a prompt.
 */
export function mentionText(line: string, nick: string): string | undefined {
	const escaped = nick.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const leading = new RegExp(`^\\s*@?${escaped}[:,]\\s*([\\s\\S]*)$`, "i").exec(line);
	if (leading) return leading[1]?.trim() || undefined;
	const leadingSpace = new RegExp(`^\\s*@?${escaped}\\s+([\\s\\S]+)$`, "i").exec(line);
	if (leadingSpace) return leadingSpace[1]?.trim() || undefined;
	const anywhere = new RegExp(`(^|[^\\w])@?${escaped}(?![\\w])`, "i");
	return anywhere.test(line) ? line.trim() : undefined;
}
