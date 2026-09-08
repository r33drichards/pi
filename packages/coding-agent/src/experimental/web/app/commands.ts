/**
 * Composer slash commands for the browser app. This registry is presentation
 * local, like the terminal client's `SlashCommands`: nothing here crosses the
 * wire. Parsing is shared with the IRC bot through `session-commands.ts`;
 * only the `/` prefix and completion popup live here.
 */

import {
	parseSessionCommand,
	SESSION_COMMANDS,
	type SessionCommandAction,
	THINKING_LEVELS,
} from "../../session-commands.ts";

export { THINKING_LEVELS };

export const COMMANDS = SESSION_COMMANDS.map((command) => ({
	name: `/${command.name}`,
	description: command.description,
}));

export type ComposerAction = { kind: "prompt"; text: string } | SessionCommandAction;

/** Interpret the composer text as a command or a prompt. Empty input is a prompt with empty text. */
export function parseComposerInput(input: string): ComposerAction {
	const text = input.trim();
	const match = /^\/(\w+)(?:\s+([\s\S]*))?$/.exec(text);
	if (!match) return { kind: "prompt", text };
	const [, name, rest = ""] = match;
	return parseSessionCommand(name!, rest) ?? { kind: "prompt", text };
}

/** Command names matching a partially typed command, for the composer popup. */
export function completeCommand(input: string): string[] {
	if (!input.startsWith("/") || /\s/.test(input)) return [];
	return COMMANDS.filter((command) => command.name.startsWith(input)).map((command) => command.name);
}
