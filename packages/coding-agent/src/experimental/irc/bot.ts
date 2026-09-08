/**
 * The IRC presentation: one Session per channel (and per DM peer), driven from
 * the control channel. Lines addressed to the bot become prompts to that
 * channel's Session; the model's completed messages and tool calls come back
 * as channel lines.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ServerError } from "@earendil-works/pi-client";
import { Client as IrcClient, type IrcPrivmsgEvent } from "irc-framework";
import { filterModels } from "../session-commands.ts";
import { HELP_LINES, type IrcCommand, isChannel, mentionText, parseCommand } from "./commands.ts";
import type { ControlHandlers, MergeRequest, MergeResult, SendRequest, SpawnRequest, SpawnResult } from "./control.ts";
import { type EngineForkOptions, forkEngineSession, type MergeStrategy, mergeEngineSessions } from "./engine-fork.ts";
import { framePrompt } from "./format.ts";
import { forkChannelName } from "./petname.ts";
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
	/** Only react to channel lines that mention the bot (DMs always count). Default and recommended: true. */
	addressedOnly: boolean;
	statePath: string;
	target: SessionLinkTarget;
	/** When set, `,fork` also carries the mcp-js filesystem (and heap, if persisted) across, and `,merge` works. */
	engineFork?: EngineForkOptions;
	/** Whether the engine persists heaps, for honest fork replies. */
	engineHeap?: boolean;
	/** Default wait for a spawned child's turn. */
	spawnTimeoutMs?: number;
	log: (line: string) => void;
	/** Test seam. */
	createClient?: () => IrcClient;
	/** Milliseconds between consecutive lines to one target. */
	sendSpacingMs?: number;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The server answered that the Session does not exist (as opposed to failing to start it). */
function isSessionGone(error: unknown): boolean {
	if (error instanceof ServerError && error.code === "session_not_found") return true;
	return /unknown session|session was not found/i.test(message(error));
}

export class IrcPiBot implements ControlHandlers {
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
					// Only a Session the server no longer knows gets replaced; a worker
					// or engine that is merely unavailable right now keeps its mapping.
					if (!isSessionGone(error)) throw error;
					this.#options.log(
						`IRC: ${key}: session ${record.sessionId} is gone (${message(error)}); creating a new one`,
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
		const control = room === this.#options.controlChannel.toLowerCase() || isDm;
		// Channel lines are prompts only when they mention the bot. DMs are
		// addressed by nature. Responding to everything is an explicit opt-in.
		const mentioned = mentionText(event.message, this.#nick);
		const body = isDm || !this.#options.addressedOnly ? (mentioned ?? event.message.trim()) : mentioned;
		// `pi ,model astra` is a command in a mention; a bare `,command` counts in the control channel and DMs.
		const command = body !== undefined ? parseCommand(body) : undefined;
		if (command) {
			// A command inside a mention is honored in any channel the bot is in.
			await this.#onCommand(command, room, true);
			return;
		}
		if (mentioned === undefined && control) {
			const bare = parseCommand(event.message);
			if (bare) {
				await this.#onCommand(bare, room, true);
				return;
			}
		}
		if (body === undefined || body.length === 0) return;
		const link = await this.#linkFor(room);
		const prompt = framePrompt(isDm ? `dm:${event.nick}` : room, event.nick, body);
		if (link.busy) this.say(room, `(steering the running turn)`);
		await link.prompt(prompt, {
			text: (lines) => this.say(room, lines),
			tool: (line) => this.say(room, line),
		});
	}

	/** Session commands act on the room's own Session. */
	async #onSessionCommand(command: IrcCommand, room: string): Promise<boolean> {
		if (
			command.kind !== "model" &&
			command.kind !== "thinking" &&
			command.kind !== "compact" &&
			command.kind !== "reload"
		) {
			return false;
		}
		const link = await this.#linkFor(room);
		const services = link.services;
		switch (command.kind) {
			case "model": {
				const state = services.models.state.value;
				const current = state?.configuration.model;
				const matches = filterModels(state?.catalog.availableModels ?? [], command.query);
				if (command.query.length === 0) {
					const names = matches.slice(0, 15).map((model) => `${model.provider}/${model.modelId}`);
					this.say(room, [
						`model: ${current ? `${current.provider}/${current.modelId}` : "none"} · thinking: ${state?.configuration.thinkingLevel ?? "?"}`,
						`available (${matches.length}): ${names.join(", ")}${matches.length > 15 ? ", …" : ""}`,
					]);
					return true;
				}
				const chosen = matches[0];
				if (!chosen) {
					this.say(room, `no model matches "${command.query}"`);
					return true;
				}
				await services.models.select({ provider: chosen.provider, modelId: chosen.modelId }, BACKGROUND_CONTEXT);
				this.say(
					room,
					`model → ${chosen.provider}/${chosen.modelId}${matches.length > 1 ? ` (${matches.length - 1} other match${matches.length > 2 ? "es" : ""})` : ""}`,
				);
				return true;
			}
			case "thinking": {
				const supported = await services.models.getThinkingLevels(BACKGROUND_CONTEXT);
				if (command.level !== undefined && !supported.includes(command.level)) {
					this.say(
						room,
						`thinking level ${command.level} is not supported by the current model; supported: ${supported.join(", ") || "none"}`,
					);
					return true;
				}
				if (command.level === undefined) await services.models.cycleThinking(BACKGROUND_CONTEXT);
				else await services.models.selectThinking(command.level, BACKGROUND_CONTEXT);
				const level = services.models.state.value?.configuration.thinkingLevel ?? command.level ?? "?";
				this.say(room, `thinking → ${level}`);
				return true;
			}
			case "compact": {
				const response = await services.agent.compact(
					{ customInstructions: command.instructions },
					BACKGROUND_CONTEXT,
				);
				this.say(room, response.accepted ? "compacted" : `compact rejected: ${response.error.message}`);
				return true;
			}
			case "reload":
				await services.plugins.reload(BACKGROUND_CONTEXT);
				this.say(room, "plugins reloaded");
				return true;
		}
	}

	async #onCommand(command: IrcCommand, room: string, control: boolean): Promise<void> {
		if (await this.#onSessionCommand(command, room)) return;
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
		if (command.kind === "merge") {
			const result = await this.mergeInto(room, command.channel, command.strategy);
			this.say(room, result.message);
			return;
		}
		if (command.kind === "fork") {
			// Fork the channel the command was typed in into every target; with no
			// target, into a fresh #<room>-<petname> (DMs fork into #<nick>-<petname>).
			const targets = command.channels.length > 0 ? command.channels : [this.#freshChannelName(room)];
			for (const channel of targets) {
				try {
					const forked = await this.#forkInto(room, channel);
					this.say(room, `forked ${room} -> ${channel} (session ${forked.sessionId}; ${forked.note})`);
				} catch (error) {
					this.say(room, `fork ${room} -> ${channel} failed: ${message(error)}`);
				}
			}
		}
	}

	/** `#<room>-<petname>` that no channel record uses yet. */
	#freshChannelName(room: string): string {
		const base = isChannel(room) ? room : `#${room.toLowerCase()}`;
		return forkChannelName(base, (candidate) => this.#store.get(candidate) !== undefined);
	}

	/**
	 * Fork `room`'s Session into `channel` (conversation, and engine files
	 * when a coordinator is configured), remember the fork base, and join.
	 */
	async #forkInto(room: string, channel: string): Promise<{ sessionId: string; note: string }> {
		if (channel === room) throw new Error(`${channel} is this channel; pick another target`);
		const existing = this.#store.get(channel);
		if (existing) {
			throw new Error(
				`${channel} already has a session (${existing.sessionId}); ,part it and remove it from the state file to refork`,
			);
		}
		const sourceLink = await this.#linkFor(room);
		const created = await sourceLink.services.management.fork(sourceLink.sessionId, {}, BACKGROUND_CONTEXT);
		let note = "conversation carried over";
		let forkBaseFs: string | undefined;
		if (this.#options.engineFork) {
			try {
				const carried = await forkEngineSession(sourceLink.sessionId, created.sessionId, this.#options.engineFork);
				forkBaseFs = carried.fs;
				note = carried.seeded
					? `files${this.#options.engineHeap && carried.heap ? ", heap," : ""} and conversation carried over`
					: "conversation carried over; the source had no files yet";
			} catch (error) {
				note = `conversation carried over; files NOT carried: ${message(error)}`;
			}
		}
		this.#store.set(channel, {
			sessionId: created.sessionId,
			createdAt: created.createdAt,
			forkedFrom: room,
			...(forkBaseFs === undefined ? {} : { forkBaseFs }),
		});
		this.#irc.join(channel);
		return { sessionId: created.sessionId, note };
	}

	/** The channel a Session id belongs to, for control calls that identify themselves by session. */
	#roomForSession(sessionId: string): string {
		const room = this.#store.channelFor(sessionId);
		if (room === undefined) throw new Error(`session ${sessionId} is not bound to a channel`);
		return room;
	}

	/** Merge `child`'s files into `room`'s Session; the reply text is ready for the channel. */
	async mergeInto(room: string, child: string, strategy?: MergeStrategy): Promise<MergeResult> {
		const engine = this.#options.engineFork;
		if (!engine)
			return {
				status: "nothing",
				reason: "no engine",
				message: "no mcp-js coordinator is configured; nothing to merge",
			};
		const childRecord = this.#store.get(child);
		if (!childRecord)
			return { status: "nothing", reason: "unknown child", message: `${child} has no session to merge from` };
		const parentLink = await this.#linkFor(room);
		const result = await mergeEngineSessions(
			{
				parent: parentLink.sessionId,
				child: childRecord.sessionId,
				...(childRecord.forkBaseFs ? { base: childRecord.forkBaseFs } : {}),
				...(strategy ? { prefer: strategy } : {}),
			},
			engine,
		);
		if (result.status === "merged") {
			return {
				status: "merged",
				fs: result.fs,
				message: `merged ${child} into ${room}: files are live (snapshot ${result.fs.slice(0, 12)})`,
			};
		}
		if (result.status === "conflict") {
			const paths = result.conflicts.map((conflict) => conflict.path).join(", ");
			return {
				status: "conflict",
				conflicts: result.conflicts,
				message: `merge ${child} into ${room} has conflicts in: ${paths}. Re-run with ours or theirs to resolve (,merge ${child} theirs).`,
			};
		}
		return { status: "nothing", reason: result.reason, message: `nothing to merge from ${child}: ${result.reason}` };
	}

	// ── control surface for worker-side tools ────────────────────────────────

	async spawn(request: SpawnRequest): Promise<SpawnResult> {
		const room = this.#roomForSession(request.session);
		const channel = request.name
			? isChannel(request.name)
				? request.name.toLowerCase()
				: `#${request.name.toLowerCase()}`
			: this.#freshChannelName(room);
		const forked = await this.#forkInto(room, channel);
		this.say(room, `spawned ${channel} (session ${forked.sessionId}; ${forked.note})`);
		const link = await this.#linkFor(channel);
		const timeoutMs = (request.timeoutSeconds ?? 0) * 1000 || this.#options.spawnTimeoutMs || 600_000;
		let partial = "";
		const relay = {
			text: (lines: string[]) => {
				partial = lines.join("\n");
				this.say(channel, lines);
			},
			tool: (line: string) => this.say(channel, line),
		};
		this.say(channel, `[from ${room}] ${request.prompt}`.split("\n"));
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<"timeout">((resolve) => {
			timer = setTimeout(() => resolve("timeout"), timeoutMs);
		});
		try {
			const outcome = await Promise.race([
				link.prompt(framePrompt(channel, room, request.prompt), relay).then((result) => result.text),
				timeout,
			]);
			if (outcome === "timeout") {
				await link.abort().catch(() => {});
				return { channel, sessionId: forked.sessionId, status: "timeout", text: partial };
			}
			return { channel, sessionId: forked.sessionId, status: "completed", text: outcome || partial };
		} catch (error) {
			return { channel, sessionId: forked.sessionId, status: "failed", text: partial, error: message(error) };
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	async send(request: SendRequest): Promise<void> {
		const room = this.#roomForSession(request.session);
		const channel = isChannel(request.channel) ? request.channel.toLowerCase() : request.channel;
		if (isChannel(channel) && !this.#store.get(channel) && !this.#links.has(channel)) {
			throw new Error(`not in ${channel}; ,join it first`);
		}
		this.say(channel, request.text.split("\n"));
		// The bot never hears its own lines, so a mention in the text prompts the
		// target channel's Session here, attributed to the sending channel.
		const mentioned = mentionText(request.text, this.#nick);
		if (mentioned !== undefined && channel !== room && isChannel(channel)) {
			void this.#linkFor(channel)
				.then((link) =>
					link.prompt(framePrompt(channel, room, mentioned), {
						text: (lines) => this.say(channel, lines),
						tool: (line) => this.say(channel, line),
					}),
				)
				.catch((error) => this.say(channel, `error: ${message(error)}`));
		}
	}

	async merge(request: MergeRequest): Promise<MergeResult> {
		const room = this.#roomForSession(request.session);
		const child = isChannel(request.channel) ? request.channel.toLowerCase() : `#${request.channel.toLowerCase()}`;
		const result = await this.mergeInto(room, child, request.strategy);
		this.say(room, result.message);
		return result;
	}

	async close(): Promise<void> {
		this.#closed = true;
		this.#irc.quit("pi shutting down");
		await Promise.allSettled([...this.#links.values()].map((link) => link.close()));
		this.#links.clear();
	}
}
