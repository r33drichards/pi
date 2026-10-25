/**
 * One IRC channel's agent session.
 *
 * A channel owns a classic `AgentSession` running in the bot's own process,
 * with the host file tools replaced by this channel's mcp-js sandbox and the
 * delegation tools bound to the channel. Installed pi extensions load
 * normally, which is the point of running on this runtime.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import { McpJsExecutionEnv, McpJsHttpEngine } from "@earendil-works/pi-agent-core/node";
import type { AgentSession } from "../core/agent-session.ts";
import type { ToolDefinition } from "../core/extensions/index.ts";
import type { ModelRuntime } from "../core/model-runtime.ts";
import type { ResourceLoader } from "../core/resource-loader.ts";
import { createAgentSession } from "../core/sdk.ts";
import { SessionManager } from "../core/session-manager.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import type { EngineForkOptions } from "./engine-fork.ts";
import { runInDomain } from "./fault-domain.ts";
import { describeToolCall, describeToolResult, toIrcLines } from "./format.ts";
import { installScheduleToolGuards, prepareScheduleTool } from "./schedule-tool.ts";
import { type ChannelDelegate, createDelegationTools, createSandboxTools } from "./tools.ts";

export interface RelayEvents {
	/** Completed assistant text, already split into IRC lines. */
	text(lines: string[]): void;
	/** One line per tool call and one per tool result. */
	tool(line: string): void;
}

export interface ChannelSessionDeps {
	cwd: string;
	agentDir: string;
	sessionDir: string;
	/**
	 * Built per channel, not shared: an extension is one instance per loader,
	 * and several of them keep project-local state under `cwd`. Sharing a
	 * loader would give every channel the first channel's extension state.
	 */
	createResources: (cwd: string) => Promise<{ resourceLoader: ResourceLoader; settingsManager: SettingsManager }>;
	modelRuntime: ModelRuntime;
	delegate: ChannelDelegate;
	/** The mcp-js coordinator backing every channel's sandbox. */
	engine?: EngineForkOptions;
	/** What the guest can reach, for an honest `run_js` description. */
	guest?: { network?: boolean; modules?: boolean };
	log: (line: string) => void;
	/** Hard limits per agent run, including extension-triggered runs. */
	runLimits?: { maxTurns: number; maxDurationMs: number };
}

export interface OpenChannelSession {
	/** An existing session file to reopen. */
	sessionFile?: string;
	/** Fork the session in this file instead of starting fresh. */
	forkFrom?: string;
}

function assistantText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: "text"; text: string } => {
			const candidate = block as { type?: unknown; text?: unknown };
			return candidate?.type === "text" && typeof candidate.text === "string";
		})
		.map((block) => block.text)
		.join("");
}

/** A channel's session plus the sandbox it runs in. */
export class ChannelSession {
	readonly channel: string;
	readonly sessionId: string;
	readonly sessionFile: string;
	readonly session: AgentSession;
	readonly #env: McpJsExecutionEnv | undefined;
	readonly #relays = new Set<RelayEvents>();
	#running: Promise<unknown> = Promise.resolve();
	#steering = new Set<Promise<void>>();
	#depth = 0;
	#generation = 0;
	#stopping: Promise<void> | undefined;
	#delegationPaused = false;
	#runTimer: ReturnType<typeof setTimeout> | undefined;
	#turns = 0;
	#lastToolError = "";
	#toolArguments = new Map<string, string>();
	#repeatedToolErrors = 0;
	#unsubscribe: (() => void) | undefined;
	#runLimits = { maxTurns: 32, maxDurationMs: 300_000 };

	private constructor(
		channel: string,
		sessionId: string,
		sessionFile: string,
		session: AgentSession,
		env: McpJsExecutionEnv | undefined,
	) {
		this.channel = channel;
		this.sessionId = sessionId;
		this.sessionFile = sessionFile;
		this.session = session;
		this.#env = env;
	}

	/**
	 * Build a channel's session: its session file, its mcp-js sandbox (named
	 * after the pi session so forks can carry engine state), its tools, and the
	 * extension bindings every host has to install.
	 */
	static open(channel: string, deps: ChannelSessionDeps, options: OpenChannelSession = {}): Promise<ChannelSession> {
		// Everything this session does — extension setup included — belongs to
		// this channel, so timers it starts report their failures here.
		return runInDomain(channel, () => ChannelSession.#open(channel, deps, options));
	}

	static async #open(
		channel: string,
		deps: ChannelSessionDeps,
		options: OpenChannelSession = {},
	): Promise<ChannelSession> {
		const sessionManager = options.sessionFile
			? SessionManager.open(options.sessionFile, deps.sessionDir, deps.cwd)
			: options.forkFrom
				? SessionManager.forkFrom(options.forkFrom, deps.cwd, deps.sessionDir)
				: SessionManager.create(deps.cwd, deps.sessionDir);
		const sessionId = sessionManager.getSessionId();
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error(`session for ${channel} has no file`);

		let env: McpJsExecutionEnv | undefined;
		const customTools: ToolDefinition[] = [];
		if (deps.engine) {
			const engine = await McpJsHttpEngine.connect({
				url: deps.engine.url,
				...(deps.engine.headers === undefined ? {} : { headers: deps.engine.headers }),
			});
			env = new McpJsExecutionEnv(engine, "/", {
				session: sessionId,
				files: "session",
				...(deps.guest === undefined ? {} : { guest: deps.guest }),
			});
			customTools.push(...createSandboxTools(env));
		}
		customTools.push(...createDelegationTools(deps.delegate, channel));

		const { resourceLoader, settingsManager } = await deps.createResources(deps.cwd);
		const { session } = await createAgentSession({
			cwd: deps.cwd,
			agentDir: deps.agentDir,
			modelRuntime: deps.modelRuntime,
			settingsManager,
			resourceLoader,
			sessionManager,
			// The sandbox tools replace pi's host-filesystem built-ins; extension
			// tools stay enabled, which is what "builtin" means here.
			...(env ? { noTools: "builtin" as const } : {}),
			customTools,
		});
		installScheduleToolGuards(session.agent);
		// Extensions initialize on the session_start this emits; without it an
		// installed extension loads but never sets itself up.
		await session.bindExtensions({
			mode: "rpc",
			commandContextActions: {
				waitForIdle: () => session.waitForIdle(),
				reload: async () => {
					await session.reload();
					prepareScheduleTool(session.agent);
				},
				// A channel's session is bound to its channel: replacing or
				// re-rooting it is the bot's job, through ,fork and ,join.
				newSession: async () => ({ cancelled: true }),
				fork: async () => ({ cancelled: true }),
				navigateTree: async () => ({ cancelled: true }),
				switchSession: async () => ({ cancelled: true }),
			},
			onError: (error: unknown) => deps.log(`IRC: ${channel}: extension error: ${String(error)}`),
		});

		prepareScheduleTool(session.agent);

		const channelSession = new ChannelSession(channel, sessionId, sessionFile, session, env);
		if (deps.runLimits) channelSession.#runLimits = deps.runLimits;
		channelSession.#subscribe();
		return channelSession;
	}

	/**
	 * Relay the session's own events, so anything that prompts it — a channel
	 * line, a spawned parent, or an extension such as a scheduled prompt —
	 * shows up in the channel.
	 */
	#subscribe(): void {
		this.#unsubscribe = this.session.subscribe((event) => {
			if (event.type === "agent_start") {
				// prompt() can still be awaiting extension/auth preflight when stop
				// arrives. Abort its newly created controller before inference starts.
				if (this.#stopping || this.#delegationPaused) {
					this.session.agent.abort();
					return;
				}
				this.#turns = 0;
				this.#lastToolError = "";
				this.#repeatedToolErrors = 0;
				this.#toolArguments.clear();
				clearTimeout(this.#runTimer);
				this.#runTimer = setTimeout(() => this.#limit("run exceeded five minutes"), this.#runLimits.maxDurationMs);
				this.#runTimer.unref();
			} else if (event.type === "agent_end") {
				this.#toolArguments.clear();
				clearTimeout(this.#runTimer);
				this.#runTimer = undefined;
			} else if (event.type === "turn_start" && ++this.#turns > this.#runLimits.maxTurns) {
				this.#limit(`run exceeded ${this.#runLimits.maxTurns} turns`);
			}
			if (event.type === "tool_execution_start") {
				this.#toolArguments.set(event.toolCallId, JSON.stringify(event.args));
			}
			if (event.type === "tool_execution_end" && !this.#stopping) {
				const result = event.result as { content?: unknown } | undefined;
				const args = this.#toolArguments.get(event.toolCallId);
				this.#toolArguments.delete(event.toolCallId);
				const error = event.isError ? `${event.toolName}:${args}:${assistantText(result?.content)}` : "";
				this.#repeatedToolErrors =
					error && error === this.#lastToolError ? this.#repeatedToolErrors + 1 : error ? 1 : 0;
				this.#lastToolError = error;
				if (this.#repeatedToolErrors >= 3) {
					this.#limit(`${event.toolName} returned the same error three times`);
					return;
				}
			}
			if (this.#relays.size === 0 || this.#stopping || this.#delegationPaused) return;
			switch (event.type) {
				case "message_end": {
					const message = event.message as { role?: string; content?: unknown };
					if (message.role !== "assistant") return;
					const lines = toIrcLines(assistantText(message.content));
					if (lines.length > 0) for (const relay of this.#relays) relay.text(lines);
					return;
				}
				case "tool_execution_start": {
					const line = describeToolCall(event.toolName, event.args);
					for (const relay of this.#relays) relay.tool(line);
					return;
				}
				case "tool_execution_end": {
					const result = event.result as { content?: unknown } | undefined;
					const line = describeToolResult(event.toolName, assistantText(result?.content), event.isError);
					for (const relay of this.#relays) relay.tool(line);
					return;
				}
				default:
					return;
			}
		});
	}

	#limit(reason: string): void {
		if (this.#stopping) return;
		for (const relay of this.#relays)
			relay.text([`Stopping: ${reason}. Send a new prompt after cancellation finishes.`]);
		void this.abort().catch(() => {});
	}

	/** Relay this session's activity for as long as the returned handle is open. */
	watch(relay: RelayEvents): () => void {
		this.#relays.add(relay);
		return () => this.#relays.delete(relay);
	}

	get busy(): boolean {
		return this.#depth > 0 || this.session.isStreaming;
	}

	/**
	 * Prompt the session and wait for the turn. A prompt arriving mid-turn is
	 * delivered as steering instead of queueing, so the model sees it while it
	 * works.
	 */
	async prompt(message: string, relay?: RelayEvents): Promise<{ text: string; steered: boolean }> {
		if (this.#stopping) throw new Error("Cancellation is still in progress; send the prompt again when stopped.");
		this.#delegationPaused = false;
		const generation = this.#generation;
		if (this.busy) {
			const steering = this.session.steer(message);
			this.#steering.add(steering);
			try {
				await steering;
			} finally {
				this.#steering.delete(steering);
			}
			if (generation !== this.#generation) this.session.clearQueue();
			return { text: "", steered: true };
		}
		this.#depth += 1;
		// The channel's own relay is already attached for the session's lifetime;
		// an extra one here is only for callers that need to capture the text.
		const stop = relay ? this.watch(relay) : () => {};
		const run = this.#running.then(() =>
			runInDomain(this.channel, async () => {
				if (generation !== this.#generation) return "";
				await this.session.prompt(message);
				return this.session.getLastAssistantText() ?? "";
			}),
		);
		this.#running = run.then(
			() => {},
			() => {},
		);
		try {
			return { text: await run, steered: false };
		} finally {
			stop();
			this.#depth -= 1;
		}
	}

	/** Fence an owned child's late output and scheduled runs until an explicit prompt. */
	cancelDelegation(): void {
		this.#delegationPaused = true;
		void this.abort().catch(() => {});
	}

	abort(): Promise<void> {
		if (this.#stopping) return this.#stopping;
		this.#generation += 1;
		clearTimeout(this.#runTimer);
		this.#runTimer = undefined;
		this.session.clearQueue();
		const aborted = this.session.abort();
		// A failed steering transform must not release the cancellation barrier
		// while inference or another steering transform is still settling.
		this.#stopping = Promise.allSettled([aborted, this.#running, ...this.#steering])
			.then((results) => {
				const failure = results.find((result) => result.status === "rejected");
				if (failure?.status === "rejected") throw failure.reason;
			})
			.finally(() => {
				this.session.clearQueue();
				this.#stopping = undefined;
			});
		return this.#stopping;
	}

	async close(): Promise<void> {
		try {
			await this.abort();
		} finally {
			this.#unsubscribe?.();
			try {
				this.session.dispose();
			} finally {
				await this.#env?.cleanup(BACKGROUND_CONTEXT);
			}
		}
	}

	// ── session commands ─────────────────────────────────────────────────────

	availableThinkingLevels(): ThinkingLevel[] {
		return this.session.getAvailableThinkingLevels();
	}

	thinkingLevel(): ThinkingLevel {
		return this.session.thinkingLevel;
	}

	modelLabel(): string {
		const model = this.session.model;
		return model ? `${model.provider}/${model.id}` : "none";
	}

	async setModel(model: Parameters<AgentSession["setModel"]>[0]): Promise<void> {
		await this.session.setModel(model);
	}

	setThinkingLevel(level: ThinkingLevel): void {
		this.session.setThinkingLevel(level);
	}

	cycleThinkingLevel(): ThinkingLevel | undefined {
		return this.session.cycleThinkingLevel();
	}

	async compact(instructions: string | null): Promise<void> {
		await this.session.compact(instructions ?? undefined);
	}

	async reload(): Promise<void> {
		await this.session.reload();
		prepareScheduleTool(this.session.agent);
	}
}
