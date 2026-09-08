/**
 * Composer slash commands for the browser app. This registry is presentation
 * local, like the terminal client's `SlashCommands`: nothing here crosses the
 * wire. Each command maps to the same service call its toolbar button makes.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export const COMMANDS = [
	{ name: "/model", description: "Pick a model; optional query filters the list" },
	{ name: "/thinking", description: "Set the thinking level: off, minimal, low, medium, high, xhigh, max" },
	{ name: "/compact", description: "Compact the session context; optional instructions" },
	{ name: "/reload", description: "Reload the session's plugins" },
] as const;

export type ComposerAction =
	| { kind: "prompt"; text: string }
	| { kind: "model"; query: string }
	| { kind: "thinking"; level: ThinkingLevel | undefined }
	| { kind: "compact"; instructions: string | null }
	| { kind: "reload" }
	| { kind: "error"; message: string };

function isThinkingLevel(value: string): value is ThinkingLevel {
	return (THINKING_LEVELS as readonly string[]).includes(value);
}

/** Interpret the composer text as a command or a prompt. Empty input is a prompt with empty text. */
export function parseComposerInput(input: string): ComposerAction {
	const text = input.trim();
	const match = /^\/(\w+)(?:\s+([\s\S]*))?$/.exec(text);
	if (!match) return { kind: "prompt", text };
	const [, name, rest = ""] = match;
	const argument = rest.trim();
	switch (name) {
		case "model":
			return { kind: "model", query: argument };
		case "thinking":
			if (argument.length === 0) return { kind: "thinking", level: undefined };
			if (!isThinkingLevel(argument)) {
				return {
					kind: "error",
					message: `Unknown thinking level "${argument}"; expected one of ${THINKING_LEVELS.join(", ")}`,
				};
			}
			return { kind: "thinking", level: argument };
		case "compact":
			return { kind: "compact", instructions: argument.length === 0 ? null : argument };
		case "reload":
			return { kind: "reload" };
		default:
			return { kind: "prompt", text };
	}
}

/** Command names matching a partially typed command, for the composer popup. */
export function completeCommand(input: string): string[] {
	if (!input.startsWith("/") || /\s/.test(input)) return [];
	return COMMANDS.filter((command) => command.name.startsWith(input)).map((command) => command.name);
}
