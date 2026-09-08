/**
 * The IRC bot: one agent session per channel (and per DM peer), driven from
 * the control channel. Lines addressed to the bot become prompts to that
 * channel's session; the model's completed messages and tool calls come back
 * as channel lines.
 *
 * Sessions run in this process on the classic `AgentSession` runtime, so
 * installed pi extensions work and the delegation tools call straight into
 * this object instead of going through a control socket.
 */

import { Client as IrcClient, type IrcPrivmsgEvent } from "irc-framework";
import type { ModelRuntime } from "../core/model-runtime.ts";
import type { ResourceLoader } from "../core/resource-loader.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import { ChannelSession, type ChannelSessionDeps } from "./channel-session.ts";
import { HELP_LINES, type IrcCommand, isChannel, mentionText, parseCommand } from "./commands.ts";
import { type EngineForkOptions, forkEngineSession, type MergeStrategy, mergeEngineSessions } from "./engine-fork.ts";
import { forkNotice, framePrompt } from "./format.ts";
import { forkChannelName } from "./petname.ts";
import { filterModels } from "./session-commands.ts";
import { ChannelSessionStore } from "./state.ts";
import type { ChannelDelegate } from "./tools.ts";

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
	cwd: string;
	agentDir: string;
	sessionDir: string;
	settingsManager: SettingsManager;
	resourceLoader: ResourceLoader;
	modelRuntime: ModelRuntime;
	/** When set, channels get mcp-js sandbox tools and `,fork`/`,merge` carry files. */
	engineFork?: EngineForkOptions;
	/** Whether the engine persists heaps, for honest fork replies. */
	engineHeap?: boolean;
	/** What the guest can reach, for an honest `run_js` description. */
	guest?: { network?: boolean; modules?: boolean };
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

/**
 * Whether a prompt explicitly asks for another channel, which is what lets a
 * forked session post outside its own channel. Naming the channel is the
 * signal; without it a fork's answer belongs in the fork.
 */
export function promptNamesChannel(prompt: string, channel: string): boolean {
	const bare = channel.replace(/^[#&]/, "");
	if (bare.length === 0) return false;
	const escaped = bare.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`[#&]${escaped}(?![\\w-])`, "i").test(prompt);
}

export class IrcPiBot implements ChannelDelegate {
	readonly #options: IrcBotOptions;
	readonly #irc: IrcClient;
	readonly #store: ChannelSessionStore;
	readonly #sessions = new Map<string, ChannelSession>();
	readonly #opening = new Map<string, Promise<ChannelSession>>();
	readonly #sendQueues = new Map<string, Promise<void>>();
	/** Channels whose next prompt carries the "you are in X" fork notice. */
	readonly #pendingNotice = new Map<string, string>();
	/** The last prompt text a channel received, for the irc_send policy. */
	readonly #lastPrompt = new Map<string, string>();
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

	#deps(): ChannelSessionDeps {
		return {
			cwd: this.#options.cwd,
			agentDir: this.#options.agentDir,
			sessionDir: this.#options.sessionDir,
			settingsManager: this.#options.settingsManager,
			resourceLoader: this.#options.resourceLoader,
			modelRuntime: this.#options.modelRuntime,
			delegate: this,
			...(this.#options.engineFork === undefined ? {} : { engine: this.#options.engineFork }),
			...(this.#options.guest === undefined ? {} : { guest: this.#options.guest }),
			log: this.#options.log,
		};
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
			void this.#sessionFor(event.channel).catch((error) => log(`IRC: ${event.channel}: ${message(error)}`));
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

	/** The relay that puts a channel's session activity into that channel. */
	#relayTo(channel: string) {
		return {
			text: (lines: string[]) => this.say(channel, lines),
			tool: (line: string) => this.say(channel, line),
		};
	}

	/** Open (or reuse) a channel's session, creating it on first use. */
	async #sessionFor(name: string): Promise<ChannelSession> {
		const key = name.toLowerCase();
		const existing = this.#sessions.get(key);
		if (existing) return existing;
		const pending = this.#opening.get(key);
		if (pending) return pending;
		const open = (async () => {
			const record = this.#store.get(key);
			if (record?.sessionFile) {
				try {
					return await ChannelSession.open(key, this.#deps(), { sessionFile: record.sessionFile });
				} catch (error) {
					this.#options.log(
						`IRC: ${key}: could not reopen session ${record.sessionId} (${message(error)}); starting a new one`,
					);
					this.#store.delete(key);
				}
			}
			const created = await ChannelSession.open(key, this.#deps());
			this.#store.set(key, {
				sessionId: created.sessionId,
				sessionFile: created.sessionFile,
				createdAt: Date.now(),
			});
			return created;
		})();
		this.#opening.set(key, open);
		try {
			const session = await open;
			this.#sessions.set(key, session);
			// A session relays its own activity even when nobody is prompting, so an
			// extension (a scheduled prompt, say) still reaches the channel.
			session.watch(this.#relayTo(key));
			return session;
		} finally {
			this.#opening.delete(key);
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
		const session = await this.#sessionFor(room);
		const prompt = this.#framePromptFor(room, isDm ? `dm:${event.nick}` : room, event.nick, body);
		if (session.busy) this.say(room, `(steering the running turn)`);
		await session.prompt(prompt, this.#relayTo(room));
	}

	/** The prompt text a session sees, with a one-time fork notice when it has just been forked. */
	#framePromptFor(room: string, label: string, nick: string, body: string): string {
		this.#lastPrompt.set(room, body);
		const notice = this.#pendingNotice.get(room);
		if (notice !== undefined) this.#pendingNotice.delete(room);
		const framed = framePrompt(label, nick, body);
		return notice === undefined ? framed : `${notice}\n${framed}`;
	}

	/** Session commands act on the room's own session. */
	async #onSessionCommand(command: IrcCommand, room: string): Promise<boolean> {
		if (
			command.kind !== "model" &&
			command.kind !== "thinking" &&
			command.kind !== "compact" &&
			command.kind !== "reload"
		) {
			return false;
		}
		const session = await this.#sessionFor(room);
		switch (command.kind) {
			case "model": {
				const available = await this.#options.modelRuntime.getAvailable();
				const choices = available.map((model) => ({
					provider: model.provider,
					modelId: model.id,
					name: model.name,
					model,
				}));
				const matches = filterModels(choices, command.query);
				if (command.query.length === 0) {
					const names = matches.slice(0, 15).map((choice) => `${choice.provider}/${choice.modelId}`);
					this.say(room, [
						`model: ${session.modelLabel()} · thinking: ${session.thinkingLevel()}`,
						`available (${matches.length}): ${names.join(", ")}${matches.length > 15 ? ", …" : ""}`,
					]);
					return true;
				}
				const chosen = matches[0];
				if (!chosen) {
					this.say(room, `no model matches "${command.query}"`);
					return true;
				}
				await session.setModel(chosen.model);
				this.say(
					room,
					`model → ${chosen.provider}/${chosen.modelId}${matches.length > 1 ? ` (${matches.length - 1} other match${matches.length > 2 ? "es" : ""})` : ""}`,
				);
				return true;
			}
			case "thinking": {
				const supported = session.availableThinkingLevels();
				if (command.level !== undefined && !supported.includes(command.level)) {
					this.say(
						room,
						`thinking level ${command.level} is not supported by the current model; supported: ${supported.join(", ") || "none"}`,
					);
					return true;
				}
				if (command.level === undefined) session.cycleThinkingLevel();
				else session.setThinkingLevel(command.level);
				this.say(room, `thinking → ${session.thinkingLevel()}`);
				return true;
			}
			case "compact":
				await session.compact(command.instructions);
				this.say(room, "compacted");
				return true;
			case "reload":
				await session.reload();
				this.say(room, "extensions reloaded");
				return true;
		}
		return false;
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
								this.#sessions.has(channel) ? "" : " (not connected)"
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
			const session = this.#sessions.get(command.channel);
			this.#sessions.delete(command.channel);
			await session?.close();
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
	 * Fork `room`'s session into `channel` (conversation, and engine files when
	 * a coordinator is configured), remember the fork base, and join.
	 */
	async #forkInto(room: string, channel: string): Promise<{ sessionId: string; note: string }> {
		if (channel === room) throw new Error(`${channel} is this channel; pick another target`);
		const existing = this.#store.get(channel);
		if (existing) {
			throw new Error(
				`${channel} already has a session (${existing.sessionId}); ,part it and remove it from the state file to refork`,
			);
		}
		const source = await this.#sessionFor(room);
		const created = await ChannelSession.open(channel, this.#deps(), { forkFrom: source.sessionFile });
		let note = "conversation carried over";
		let forkBaseFs: string | undefined;
		if (this.#options.engineFork) {
			try {
				const carried = await forkEngineSession(source.sessionId, created.sessionId, this.#options.engineFork);
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
			sessionFile: created.sessionFile,
			createdAt: Date.now(),
			forkedFrom: room,
			...(forkBaseFs === undefined ? {} : { forkBaseFs }),
		});
		this.#sessions.set(channel, created);
		created.watch(this.#relayTo(channel));
		// The fork inherits the parent's conversation, so it has to be told where
		// it now lives; otherwise it answers as if it were still in the parent.
		this.#pendingNotice.set(channel, forkNotice(channel, room));
		this.#irc.join(channel);
		return { sessionId: created.sessionId, note };
	}

	/** Merge `child`'s files into `room`'s session; the reply text is ready for the channel. */
	async mergeInto(
		room: string,
		child: string,
		strategy?: MergeStrategy,
	): Promise<{ status: string; message: string }> {
		const engine = this.#options.engineFork;
		if (!engine) return { status: "nothing", message: "no mcp-js coordinator is configured; nothing to merge" };
		const childRecord = this.#store.get(child);
		if (!childRecord) return { status: "nothing", message: `${child} has no session to merge from` };
		const parent = await this.#sessionFor(room);
		const result = await mergeEngineSessions(
			{
				parent: parent.sessionId,
				child: childRecord.sessionId,
				...(childRecord.forkBaseFs ? { base: childRecord.forkBaseFs } : {}),
				...(strategy ? { prefer: strategy } : {}),
			},
			engine,
		);
		if (result.status === "merged") {
			return {
				status: "merged",
				message: `merged ${child} into ${room}: files are live (snapshot ${result.fs.slice(0, 12)})`,
			};
		}
		if (result.status === "conflict") {
			const paths = result.conflicts.map((conflict) => conflict.path).join(", ");
			return {
				status: "conflict",
				message: `merge ${child} into ${room} has conflicts in: ${paths}. Re-run with ours or theirs to resolve (,merge ${child} theirs).`,
			};
		}
		return { status: "nothing", message: `nothing to merge from ${child}: ${result.reason}` };
	}

	// ── delegation tools, called from a channel's own session ────────────────

	async spawn(request: { room: string; prompt: string; name?: string; timeoutSeconds?: number }): Promise<{
		channel: string;
		sessionId: string;
		status: "completed" | "timeout" | "failed";
		text: string;
		error?: string;
	}> {
		const room = request.room;
		const channel = request.name
			? isChannel(request.name)
				? request.name.toLowerCase()
				: `#${request.name.toLowerCase()}`
			: this.#freshChannelName(room);
		const forked = await this.#forkInto(room, channel);
		this.say(room, `spawned ${channel} (session ${forked.sessionId}; ${forked.note})`);
		const session = await this.#sessionFor(channel);
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
			const prompt = this.#framePromptFor(channel, channel, room, request.prompt);
			const outcome = await Promise.race([session.prompt(prompt, relay).then((result) => result.text), timeout]);
			if (outcome === "timeout") {
				await session.abort().catch(() => {});
				return { channel, sessionId: forked.sessionId, status: "timeout", text: partial };
			}
			return { channel, sessionId: forked.sessionId, status: "completed", text: outcome || partial };
		} catch (error) {
			return { channel, sessionId: forked.sessionId, status: "failed", text: partial, error: message(error) };
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	async send(request: { room: string; channel: string; text: string }): Promise<void> {
		const room = request.room;
		const channel = isChannel(request.channel) ? request.channel.toLowerCase() : request.channel;
		// A fork answers in its own channel. Posting back to the channel it was
		// forked from needs the user to have asked for it by name.
		const parent = this.#store.get(room)?.forkedFrom;
		if (parent !== undefined && channel === parent.toLowerCase()) {
			const asked = promptNamesChannel(this.#lastPrompt.get(room) ?? "", channel);
			if (!asked) {
				throw new Error(
					`${room} was forked from ${channel}; your reply already goes to ${room}. Only post to ${channel} when the user asks for it by name.`,
				);
			}
		}
		if (isChannel(channel) && !this.#store.get(channel) && !this.#sessions.has(channel)) {
			throw new Error(`not in ${channel}; ,join it first`);
		}
		this.say(channel, request.text.split("\n"));
		// The bot never hears its own lines, so a mention in the text prompts the
		// target channel's session here, attributed to the sending channel.
		const mentioned = mentionText(request.text, this.#nick);
		if (mentioned !== undefined && channel !== room && isChannel(channel)) {
			void this.#sessionFor(channel)
				.then((session) =>
					session.prompt(this.#framePromptFor(channel, channel, room, mentioned), this.#relayTo(channel)),
				)
				.catch((error) => this.say(channel, `error: ${message(error)}`));
		}
	}

	async merge(request: { room: string; channel: string; strategy?: MergeStrategy }): Promise<{ message: string }> {
		const child = isChannel(request.channel) ? request.channel.toLowerCase() : `#${request.channel.toLowerCase()}`;
		const result = await this.mergeInto(request.room, child, request.strategy);
		this.say(request.room, result.message);
		return result;
	}

	async close(): Promise<void> {
		this.#closed = true;
		this.#irc.quit("pi shutting down");
		await Promise.allSettled([...this.#sessions.values()].map((session) => session.close()));
		this.#sessions.clear();
	}
}
