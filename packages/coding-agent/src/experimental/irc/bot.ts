/**
 * The IRC presentation: one Session per channel (and per DM peer), driven from
 * the control channel. Lines addressed to the bot become prompts to that
 * channel's Session; the model's completed messages and tool calls come back
 * as channel lines.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Client as IrcClient, type IrcPrivmsgEvent } from "irc-framework";
import { addressedText, HELP_LINES, type IrcCommand, isChannel, parseCommand } from "./commands.ts";
import { type EngineForkOptions, forkEngineSession } from "./engine-fork.ts";
import { framePrompt } from "./format.ts";
import { SessionLink, type SessionLinkTarget } from "./session-link.ts";
import { ChannelSessionStore } from "./state.ts";

export interface IrcBotOptions {
	server: string;
	port: number;
	tls: boolean;
	nick: string;
	password?: string;
	/** Channels joined at startup; the control channel is always included. */
	channels: string[];
	controlChannel: string;
	/** Only react to channel lines addressed to the bot (DMs always count). */
	addressedOnly: boolean;
	statePath: string;
	target: SessionLinkTarget;
	/** When set, `,fork` also carries the mcp-js heap and filesystem across. */
	engineFork?: EngineForkOptions;
	log: (line: string) => void;
	/** Test seam. */
	createClient?: () => IrcClient;
	/** Milliseconds between consecutive lines to one target. */
	sendSpacingMs?: number;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class IrcPiBot {
	readonly #options: IrcBotOptions;
	readonly #irc: IrcClient;
	readonly #store: ChannelSessionStore;
	readonly #links = new Map<string, SessionLink>();
	readonly #opening = new Map<string, Promise<SessionLink>>();
	readonly #sendQueues = new Map<string, Promise<void>>();
	#control: SessionLink | undefined;
	#nick: string;
	#closed = false;

	constructor(options: IrcBotOptions) {
		this.#options = options;
		this.#nick = options.nick;
		this.#irc = options.createClient ? options.createClient() : new IrcClient();
		this.#store = new ChannelSessionStore(options.statePath);
	}

	get nick(): string {
		return this.#nick;
	}

	get store(): ChannelSessionStore {
		return this.#store;
	}

	/** Channels to be in: startup list plus everything remembered from earlier runs. */
	#wantedChannels(): string[] {
		const wanted = new Set<string>([this.#options.controlChannel.toLowerCase()]);
		for (const channel of this.#options.channels) wanted.add(channel.toLowerCase());
		for (const [channel] of this.#store.entries()) if (isChannel(channel)) wanted.add(channel);
		return [...wanted];
	}

	async start(): Promise<void> {
		const { server, port, tls, nick, password, log } = this.#options;
		this.#irc.on("registered", (event) => {
			this.#nick = event.nick;
			log(`IRC: registered as ${event.nick} on ${server}:${port}`);
			for (const channel of this.#wantedChannels()) this.#irc.join(channel);
		});
		this.#irc.on("nick in use", () => {
			this.#irc.changeNick(`${this.#nick}_`);
		});
		this.#irc.on("join", (event) => {
			if (event.nick !== this.#nick) return;
			log(`IRC: joined ${event.channel}`);
			void this.#linkFor(event.channel).catch((error) => log(`IRC: ${event.channel}: ${message(error)}`));
		});
		this.#irc.on("privmsg", (event) => {
			void this.#onMessage(event).catch((error) => {
				log(`IRC: message handling failed: ${message(error)}`);
				this.say(event.target === this.#nick ? event.nick : event.target, `error: ${message(error)}`);
			});
		});
		this.#irc.on("close", (error) => log(`IRC: connection closed${error ? " (error)" : ""}`));
		this.#irc.on("reconnecting", (event) =>
			log(`IRC: reconnecting (attempt ${event.attempt}, wait ${event.wait}ms)`),
		);
		this.#irc.on("irc error", (event) =>
			log(`IRC: server error ${event.error}${event.reason ? `: ${event.reason}` : ""}`),
		);
		this.#irc.connect({
			host: server,
			port,
			tls,
			nick,
			username: nick,
			gecos: "pi coding agent",
			...(password === undefined ? {} : { password }),
			auto_reconnect: true,
			auto_reconnect_max_retries: 1_000,
			auto_reconnect_max_wait: 60_000,
		});
	}

	/** Send lines to a target with spacing, so a long reply does not trip flood limits. */
	say(target: string, text: string | string[]): void {
		const lines = Array.isArray(text) ? text : [text];
		const spacing = this.#options.sendSpacingMs ?? 350;
		const previous = this.#sendQueues.get(target) ?? Promise.resolve();
		const next = previous.then(async () => {
			for (const line of lines) {
				if (this.#closed) return;
				this.#irc.say(target, line);
				await new Promise((resolve) => setTimeout(resolve, spacing));
			}
		});
		this.#sendQueues.set(target, next);
	}

	/** The management service, over the control channel's link or a temporary one. */
	async #management(): Promise<SessionLink> {
		if (this.#control) return this.#control;
		const first = this.#store.entries()[0];
		if (first) {
			this.#control = await this.#linkFor(first[0]);
			return this.#control;
		}
		this.#control = await this.#linkFor(this.#options.controlChannel);
		return this.#control;
	}

	/** Open (or reuse) the link for a channel or DM peer, creating its Session on first use. */
	async #linkFor(name: string): Promise<SessionLink> {
		const key = name.toLowerCase();
		const existing = this.#links.get(key);
		if (existing) return existing;
		const pending = this.#opening.get(key);
		if (pending) return pending;
		const open = (async () => {
			const record = this.#store.get(key);
			if (record) {
				try {
					return await SessionLink.open(this.#options.target, record.sessionId);
				} catch (error) {
					this.#options.log(
						`IRC: ${key}: session ${record.sessionId} unavailable (${message(error)}); creating a new one`,
					);
					this.#store.delete(key);
				}
			}
			const created = await this.#createSession();
			this.#store.set(key, { sessionId: created, createdAt: Date.now() });
			return await SessionLink.open(this.#options.target, created);
		})();
		this.#opening.set(key, open);
		try {
			const link = await open;
			this.#links.set(key, link);
			return link;
		} finally {
			this.#opening.delete(key);
		}
	}

	/** Create a Session through any connected link, or a throwaway connection when none exists yet. */
	async #createSession(): Promise<string> {
		const any = this.#links.values().next().value as SessionLink | undefined;
		if (any) return (await any.services.management.create({}, BACKGROUND_CONTEXT)).sessionId;
		const probe = await SessionLink.openDetached(this.#options.target);
		try {
			return (await probe.services.management.create({}, BACKGROUND_CONTEXT)).sessionId;
		} finally {
			await probe.close();
		}
	}

	async #onMessage(event: IrcPrivmsgEvent): Promise<void> {
		if (event.from_server || event.nick === this.#nick) return;
		const isDm = event.target.toLowerCase() === this.#nick.toLowerCase();
		const room = isDm ? event.nick : event.target.toLowerCase();
		const command = parseCommand(event.message);
		if (command) {
			await this.#onCommand(command, room, isDm);
			return;
		}
		let text: string | undefined;
		if (isDm || !this.#options.addressedOnly) text = addressedText(event.message, this.#nick) ?? event.message.trim();
		else text = addressedText(event.message, this.#nick);
		if (text === undefined || text.length === 0) return;
		const link = await this.#linkFor(room);
		const prompt = framePrompt(isDm ? `dm:${event.nick}` : room, event.nick, text);
		if (link.busy) this.say(room, `(steering the running turn)`);
		await link.prompt(prompt, {
			text: (lines) => this.say(room, lines),
			tool: (line) => this.say(room, line),
		});
	}

	async #onCommand(command: IrcCommand, room: string, isDm: boolean): Promise<void> {
		const control = room === this.#options.controlChannel.toLowerCase() || isDm;
		switch (command.kind) {
			case "help":
				this.say(room, HELP_LINES);
				return;
			case "sessions": {
				const entries = this.#store.entries();
				if (entries.length === 0) {
					this.say(room, "no sessions yet");
					return;
				}
				this.say(
					room,
					entries.map(
						([channel, record]) =>
							`${channel} → ${record.sessionId}${record.forkedFrom ? ` (forked from ${record.forkedFrom})` : ""}${
								this.#links.has(channel) ? "" : " (not connected)"
							}`,
					),
				);
				return;
			}
			case "error":
				this.say(room, command.message);
				return;
			case "join":
			case "fork":
			case "part":
				if (!control) {
					this.say(room, `,${command.kind} only works in ${this.#options.controlChannel} or a DM`);
					return;
				}
				break;
		}
		if (command.kind === "join") {
			for (const channel of command.channels) {
				const record = this.#store.get(channel);
				this.#irc.join(channel);
				this.say(
					room,
					record ? `joining ${channel} (session ${record.sessionId})` : `joining ${channel} with a new session`,
				);
			}
			return;
		}
		if (command.kind === "part") {
			const link = this.#links.get(command.channel);
			this.#links.delete(command.channel);
			await link?.close();
			this.#irc.part(command.channel, "session kept; ,join to resume");
			this.say(room, `left ${command.channel}; its session is kept`);
			return;
		}
		if (command.kind === "fork") {
			const from = (command.from ?? room).toLowerCase();
			if (this.#store.get(command.channel)) {
				this.say(
					room,
					`${command.channel} already has a session; ,part it and remove it from the state file to refork`,
				);
				return;
			}
			const sourceLink = await this.#linkFor(from);
			const created = await sourceLink.services.management.fork(sourceLink.sessionId, {}, BACKGROUND_CONTEXT);
			let engine = "no engine state to carry";
			if (this.#options.engineFork) {
				try {
					const carried = await forkEngineSession(
						sourceLink.sessionId,
						created.sessionId,
						this.#options.engineFork,
					);
					engine = carried ? "heap and files carried over" : "source had no engine state yet";
				} catch (error) {
					engine = `engine state NOT carried: ${message(error)}`;
				}
			}
			this.#store.set(command.channel, {
				sessionId: created.sessionId,
				createdAt: created.createdAt,
				forkedFrom: from,
			});
			this.#irc.join(command.channel);
			this.say(room, `forked ${from} → ${command.channel} as session ${created.sessionId} (${engine})`);
		}
	}

	async close(): Promise<void> {
		this.#closed = true;
		this.#irc.quit("pi shutting down");
		await Promise.allSettled([...this.#links.values()].map((link) => link.close()));
		this.#links.clear();
	}
}
