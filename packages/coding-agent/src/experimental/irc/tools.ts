/**
 * Worker-side delegation tools for IRC sessions. They run inside the session
 * worker, which has no IRC connection, and call the presentation's loopback
 * control endpoint (`control.ts`) with the run's token. Registered only when
 * the control address is configured, so plain sessions never see them.
 */

import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import { CONTROL_TOKEN_ENV, CONTROL_URL_ENV, type MergeResult, type SpawnResult } from "./control.ts";

export interface IrcToolsOptions {
	url: string;
	token: string;
	/** The calling Session's id; the control surface maps it to its channel. */
	sessionId: string;
	fetch?: typeof fetch;
}

const spawnSchema = Type.Object({
	prompt: Type.String({ description: "The task for the child session, written as a complete instruction." }),
	name: Type.Optional(
		Type.String({ description: "Channel name for the child, e.g. #research; default #<this channel>-<petname>." }),
	),
	timeoutSeconds: Type.Optional(
		Type.Integer({ minimum: 10, maximum: 3600, description: "How long to wait for the child (default 600)." }),
	),
});
const sendSchema = Type.Object({
	channel: Type.String({ description: "IRC channel to send to, e.g. #pi. The bot must already be in it." }),
	text: Type.String({ description: "Message text; newlines become separate lines." }),
});
const mergeSchema = Type.Object({
	channel: Type.String({ description: "The child channel whose files to merge back, e.g. #pi-brave-otter." }),
	strategy: Type.Optional(
		Type.Union([Type.Literal("ours"), Type.Literal("theirs")], {
			description: "Resolve conflicts toward this side; omit to have conflicting paths reported instead.",
		}),
	),
});

async function call<T>(options: IrcToolsOptions, route: string, body: Record<string, unknown>): Promise<T> {
	const doFetch = options.fetch ?? fetch;
	const response = await doFetch(`${options.url}${route}`, {
		method: "POST",
		headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
		body: JSON.stringify({ session: options.sessionId, ...body }),
	});
	const payload = (await response.json().catch(() => ({}))) as { error?: string } & T;
	if (!response.ok) throw new Error(payload.error ?? `control ${route}: HTTP ${response.status}`);
	return payload;
}

/** Read the control address from the environment; undefined when not running under `pi irc`. */
export function ircToolsFromEnv(sessionId: string, env: NodeJS.ProcessEnv = process.env): IrcToolsOptions | undefined {
	const url = env[CONTROL_URL_ENV];
	const token = env[CONTROL_TOKEN_ENV];
	if (!url || !token) return undefined;
	return { url, token, sessionId };
}

export function createIrcTools<TContext extends object>(options: IrcToolsOptions): AgentHarnessTool<TContext>[] {
	const spawn: AgentHarnessTool<TContext, typeof spawnSchema, SpawnResult> = {
		name: "spawn_channel",
		label: "spawn_channel",
		description:
			"Delegate a task to a child session in a new IRC channel forked from this one. The child starts with this session's files and conversation, runs the prompt as its own turn (its tool calls and reply appear in the child channel), and this call waits for it to finish. Returns the child's final answer, its channel, and its session id. Use it for subtasks that can run on their own; bring the child's files back with merge_channel afterwards. Blocks until the child is done or the timeout passes.",
		parameters: spawnSchema,
		async execute(_id, params: Static<typeof spawnSchema>) {
			const result = await call<SpawnResult>(options, "/spawn", params);
			const summary =
				result.status === "completed"
					? `Child ${result.channel} (session ${result.sessionId}) finished.`
					: `Child ${result.channel} (session ${result.sessionId}) ${result.status}${result.error ? `: ${result.error}` : ""}.`;
			return {
				content: [{ type: "text", text: `${summary}\n\n${result.text || "(no reply text)"}` }],
				details: result,
			};
		},
	};
	const send: AgentHarnessTool<TContext, typeof sendSchema, undefined> = {
		name: "irc_send",
		label: "irc_send",
		description:
			"Send a message to an IRC channel the bot is in. Mentioning the bot's nick in the text (for example 'pi: summarize what you found') prompts that channel's session, so channels can talk to each other in the open. Plain text without a mention is just posted.",
		parameters: sendSchema,
		async execute(_id, params: Static<typeof sendSchema>) {
			await call(options, "/send", params);
			return { content: [{ type: "text", text: `Sent to ${params.channel}.` }], details: undefined };
		},
	};
	const merge: AgentHarnessTool<TContext, typeof mergeSchema, MergeResult> = {
		name: "merge_channel",
		label: "merge_channel",
		description:
			"Merge a child channel's files back into this session's filesystem, three-way from the point where the child was forked (spawn_channel or ,fork). Without a strategy, conflicting paths are returned and nothing changes; pass strategy 'theirs' to take the child's version of conflicts or 'ours' to keep this session's. After a successful merge the files are visible to run_js and the read tool immediately.",
		parameters: mergeSchema,
		async execute(_id, params: Static<typeof mergeSchema>) {
			const result = await call<MergeResult>(options, "/merge", params);
			return { content: [{ type: "text", text: result.message }], details: result };
		},
	};
	return [spawn, send, merge] as unknown as AgentHarnessTool<TContext>[];
}
