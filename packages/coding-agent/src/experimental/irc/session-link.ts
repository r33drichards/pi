/**
 * One channel's link to its Session: a dedicated client connection to the
 * experimental server (a connection holds one attachment), the built-in
 * services, and a prompt driver that relays completed assistant messages and
 * tool calls to the channel while a turn runs.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Client } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { type ActivatedClientServices, activateBuiltinClientServices } from "../client-services.ts";
import {
	createServerServiceSource,
	createSessionServiceSource,
	type ServerServiceSource,
	type SessionServiceSource,
} from "../services/connection.ts";
import { describeToolCall, describeToolResult, toIrcLines } from "./format.ts";

export interface SessionLinkTarget {
	readonly serverId: string;
	readonly socketPath: string;
}

export interface RelayEvents {
	/** Completed assistant text, already split into IRC lines. */
	text(lines: string[]): void;
	/** One line per tool call and one per tool result. */
	tool(line: string): void;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string",
		)
		.map((block) => block.text)
		.join("");
}

export class SessionLink {
	readonly sessionId: string;
	readonly #client: Client;
	readonly #server: ServerServiceSource;
	readonly #session: SessionServiceSource;
	readonly #services: ActivatedClientServices;
	#running: Promise<void> = Promise.resolve();
	#queue = 0;

	private constructor(
		sessionId: string,
		client: Client,
		server: ServerServiceSource,
		session: SessionServiceSource,
		services: ActivatedClientServices,
	) {
		this.sessionId = sessionId;
		this.#client = client;
		this.#server = server;
		this.#session = session;
		this.#services = services;
	}

	/** Connect a fresh client to the server and attach it to `sessionId`. */
	static async open(target: SessionLinkTarget, sessionId: string): Promise<SessionLink> {
		const client = await Client.connect({
			serverId: target.serverId,
			transportFactory: createUnixTransportFactory({ path: target.socketPath }),
		});
		const server = createServerServiceSource(client);
		const session = createSessionServiceSource(client);
		try {
			const services = await activateBuiltinClientServices({ client, server, session });
			await services.management.attach(sessionId, BACKGROUND_CONTEXT);
			return new SessionLink(sessionId, client, server, session, services);
		} catch (error) {
			await session.dispose(BACKGROUND_CONTEXT).catch(() => {});
			await server.dispose(BACKGROUND_CONTEXT).catch(() => {});
			await client.dispose().catch(() => {});
			throw error;
		}
	}

	/** A connection with the server services bound but no Session attached, for management calls. */
	static async openDetached(target: SessionLinkTarget): Promise<SessionLink> {
		const client = await Client.connect({
			serverId: target.serverId,
			transportFactory: createUnixTransportFactory({ path: target.socketPath }),
		});
		const server = createServerServiceSource(client);
		const session = createSessionServiceSource(client);
		try {
			const services = await activateBuiltinClientServices({ client, server, session });
			return new SessionLink("", client, server, session, services);
		} catch (error) {
			await session.dispose(BACKGROUND_CONTEXT).catch(() => {});
			await server.dispose(BACKGROUND_CONTEXT).catch(() => {});
			await client.dispose().catch(() => {});
			throw error;
		}
	}

	get services(): ActivatedClientServices {
		return this.#services;
	}

	get busy(): boolean {
		return this.#queue > 0;
	}

	/**
	 * Send a prompt and relay the turn. Prompts on one channel run one after
	 * another; a prompt arriving mid-turn is delivered as steering instead of
	 * waiting, so the model sees it while it works.
	 */
	async prompt(message: string, relay: RelayEvents): Promise<{ text: string; steered: boolean }> {
		if (this.#queue > 0) {
			const response = await this.#services.agent.steer({ message, images: null }, BACKGROUND_CONTEXT);
			if (!response.accepted) throw new Error(response.error.message);
			return { text: "", steered: true };
		}
		this.#queue += 1;
		const run = this.#running.then(() => this.#runPrompt(message, relay));
		this.#running = run.then(
			() => {},
			() => {},
		);
		try {
			return { text: await run, steered: false };
		} finally {
			this.#queue -= 1;
		}
	}

	/** Run one prompt to completion; resolves with the last completed assistant text. */
	async #runPrompt(message: string, relay: RelayEvents): Promise<string> {
		const transcript = this.#services.transcript;
		let tail = Promise.resolve();
		let lastText = "";
		const unsubscribe = transcript.state.subscribe((value, _context, delivery) => {
			if (delivery.kind !== "update" || value.event === null) return;
			const event = value.event;
			tail = tail.then(() => {
				switch (event.type) {
					case "message_end": {
						if (event.message.role !== "assistant") return;
						const text = textOf(event.message.content);
						if (text.trim().length > 0) lastText = text;
						const lines = toIrcLines(text);
						if (lines.length > 0) relay.text(lines);
						return;
					}
					case "tool_start":
						relay.tool(describeToolCall(event.toolName, event.args));
						return;
					case "tool_end":
						relay.tool(describeToolResult(event.toolName, textOf(event.result.content), event.isError));
						return;
					default:
						return;
				}
			});
		});
		try {
			const response = await this.#services.agent.prompt({ message, images: null }, BACKGROUND_CONTEXT);
			if (!response.accepted) throw new Error(response.error.message);
			if (response.error !== null) throw new Error(response.error.message);
		} finally {
			unsubscribe();
			await tail;
		}
		return lastText;
	}

	async abort(): Promise<boolean> {
		const operation = this.#services.transcript.state.value?.snapshot?.operation;
		if (!operation) return false;
		await this.#services.agent.requestAbort(operation.id, BACKGROUND_CONTEXT);
		return true;
	}

	async close(): Promise<void> {
		await this.#session.dispose(BACKGROUND_CONTEXT).catch(() => {});
		await this.#server.dispose(BACKGROUND_CONTEXT).catch(() => {});
		await this.#client.dispose().catch(() => {});
	}
}
