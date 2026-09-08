/**
 * Control commands typed in IRC. Comma-prefixed, like the irc-agent bot's
 * command prefixes, so they never collide with ordinary chat.
 *
 *   ,join #a,#b     join channels; each gets its own session
 *   ,fork #chan     join #chan with a session forked from the current channel's
 *   ,part #chan     leave a channel; its session stays for a later ,join
 *   ,sessions       list channel -> session
 *   ,help
 */

export type IrcCommand =
	| { kind: "join"; channels: string[] }
	| { kind: "fork"; channel: string; from?: string }
	| { kind: "part"; channel: string }
	| { kind: "sessions" }
	| { kind: "help" }
	| { kind: "error"; message: string };

export const COMMAND_PREFIX = ",";

export const HELP_LINES = [
	",join #a,#b — join channels, one session each",
	",fork #chan [#from] — join #chan with a session forked from #from (default: this channel)",
	",part #chan — leave a channel (its session is kept)",
	",sessions — list channel → session",
	"Talk to me in a channel by addressing my nick (pi: …) or in a DM.",
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

/** Parse a line as a control command; undefined when it is not one. */
export function parseCommand(line: string): IrcCommand | undefined {
	const text = line.trim();
	if (!text.startsWith(COMMAND_PREFIX)) return undefined;
	const match = /^,(\w+)(?:\s+([\s\S]*))?$/.exec(text);
	if (!match) return undefined;
	const [, name, rest = ""] = match;
	const argument = rest.trim();
	switch (name.toLowerCase()) {
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
 * Whether a channel line is addressed to the bot, and the text without the
 * address. Accepts `nick: text`, `nick, text`, and `@nick text`.
 */
export function addressedText(line: string, nick: string): string | undefined {
	const escaped = nick.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = new RegExp(`^\\s*@?${escaped}\\s*[:,]?\\s+([\\s\\S]+)$`, "i").exec(line);
	return match?.[1]?.trim();
}
