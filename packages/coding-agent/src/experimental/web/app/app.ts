/**
 * The sessions-only browser presentation. It renders the replicated lane
 * snapshot from the `Transcript` service and drives the worker through
 * `AgentController`, `Models`, and `SessionManagement`, the same services the
 * terminal client uses. There is no project, workspace, or host directory:
 * every session is an mcp-js session that starts empty.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { LaneTranscriptSnapshot, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { html, LitElement, nothing, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type { ModelSummary, ModelsState } from "../../services/models.ts";
import type { SessionSummary } from "../../services/sessions.ts";
import type { TranscriptState } from "../../services/transcript.ts";
import { COMMANDS, completeCommand, parseComposerInput, THINKING_LEVELS } from "./commands.ts";
import { connectWebRuntime, type WebRuntime } from "./runtime.ts";

type Entry = LaneTranscriptSnapshot["transcript"][number];
type RunningTool = NonNullable<LaneTranscriptSnapshot["operation"]>["runningTools"][number];
type Block = { type: string; [key: string]: unknown };

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function blocks(content: unknown): Block[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	return Array.isArray(content) ? (content as Block[]) : [];
}

function textOf(content: unknown): string {
	return blocks(content)
		.filter((block) => block.type === "text")
		.map((block) => String(block.text ?? ""))
		.join("");
}

function shortId(id: string): string {
	return id.slice(0, 8);
}

function when(timestamp: number): string {
	return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function pretty(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

export class PiSessionsApp extends LitElement {
	static properties = {
		phase: { state: true },
		sessions: { state: true },
		attached: { state: true },
		lane: { state: true },
		models: { state: true },
		draft: { state: true },
		notice: { state: true },
		modelPicker: { state: true },
		modelQuery: { state: true },
		busy: { state: true },
	};

	declare phase: "connecting" | "ready" | "disconnected";
	declare sessions: SessionSummary[];
	declare attached: string | undefined;
	declare lane: LaneTranscriptSnapshot | null;
	declare models: ModelsState | undefined;
	declare draft: string;
	declare notice: { kind: "error" | "info"; text: string } | undefined;
	declare modelPicker: boolean;
	declare modelQuery: string;
	declare busy: boolean;

	#runtime: WebRuntime | undefined;
	#unsubscribe: Array<() => void> = [];
	#disconnectReason = "";
	#stickToBottom = true;

	constructor() {
		super();
		this.phase = "connecting";
		this.sessions = [];
		this.attached = undefined;
		this.lane = null;
		this.models = undefined;
		this.draft = "";
		this.notice = undefined;
		this.modelPicker = false;
		this.modelQuery = "";
		this.busy = false;
	}

	/** Light DOM so the page stylesheet applies. */
	protected createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	connectedCallback(): void {
		super.connectedCallback();
		void this.#connect();
	}

	disconnectedCallback(): void {
		super.disconnectedCallback();
		void this.#teardown();
	}

	async #teardown(): Promise<void> {
		for (const off of this.#unsubscribe.splice(0)) off();
		await this.#runtime?.dispose();
		this.#runtime = undefined;
	}

	async #connect(): Promise<void> {
		this.phase = "connecting";
		this.notice = undefined;
		try {
			const runtime = await connectWebRuntime(window.location);
			this.#runtime = runtime;
			this.#unsubscribe.push(
				runtime.directory.state.subscribe((state) => {
					this.sessions = [...state.sessions].sort((a, b) => b.createdAt - a.createdAt);
				}),
				runtime.session.attachment.subscribe((state) => {
					this.attached = state.status === "detached" ? undefined : state.sessionId;
					if (state.status === "detached") {
						this.lane = null;
						this.models = undefined;
					}
				}),
				runtime.transcript.state.subscribe((state: TranscriptState) => {
					this.lane = state.snapshot;
					this.#scrollSoon();
				}),
				runtime.models.state.subscribe((state) => {
					this.models = state;
				}),
				runtime.onDisconnect((reason) => {
					this.#disconnectReason = reason;
					this.phase = "disconnected";
				}),
			);
			this.phase = "ready";
			const wanted = new URLSearchParams(window.location.search).get("session");
			if (wanted) await this.#attach(wanted);
		} catch (error) {
			this.#disconnectReason = message(error);
			this.phase = "disconnected";
		}
	}

	async #reconnect(): Promise<void> {
		const previous = this.attached;
		await this.#teardown();
		await this.#connect();
		if (previous && this.phase === "ready") await this.#attach(previous);
	}

	#scrollSoon(): void {
		if (!this.#stickToBottom) return;
		void this.updateComplete.then(() => {
			const pane = this.querySelector<HTMLElement>(".transcript");
			if (pane) pane.scrollTop = pane.scrollHeight;
		});
	}

	#onTranscriptScroll(event: Event): void {
		const pane = event.currentTarget as HTMLElement;
		this.#stickToBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 40;
	}

	async #call<T>(label: string, action: () => Promise<T>): Promise<T | undefined> {
		this.busy = true;
		try {
			return await action();
		} catch (error) {
			this.notice = { kind: "error", text: `${label}: ${message(error)}` };
			return undefined;
		} finally {
			this.busy = false;
		}
	}

	async #attach(sessionId: string): Promise<void> {
		if (!this.#runtime || this.attached === sessionId) return;
		await this.#call("Attach", () => this.#runtime!.management.attach(sessionId, BACKGROUND_CONTEXT));
		this.#stickToBottom = true;
		const url = new URL(window.location.href);
		url.searchParams.set("session", sessionId);
		history.replaceState(null, "", url);
		this.#scrollSoon();
	}

	async #createSession(): Promise<void> {
		if (!this.#runtime) return;
		const created = await this.#call("Create session", () =>
			this.#runtime!.management.create({}, BACKGROUND_CONTEXT),
		);
		if (created) await this.#attach(created.sessionId);
	}

	async #removeSession(sessionId: string): Promise<void> {
		if (!this.#runtime) return;
		if (!window.confirm(`Delete session ${shortId(sessionId)}? This cannot be undone.`)) return;
		await this.#call("Delete session", () => this.#runtime!.management.remove(sessionId, BACKGROUND_CONTEXT));
	}

	async #submit(): Promise<void> {
		const runtime = this.#runtime;
		if (!runtime || this.attached === undefined) return;
		const action = parseComposerInput(this.draft);
		if (action.kind === "prompt" && action.text.length === 0) return;
		this.draft = "";
		this.notice = undefined;
		switch (action.kind) {
			case "prompt": {
				const running = this.lane?.operation != null;
				const request = { message: action.text, images: null };
				if (running) {
					const response = await this.#call("Steer", () => runtime.agent.steer(request, BACKGROUND_CONTEXT));
					if (response && !response.accepted) this.notice = { kind: "error", text: response.error.message };
					else if (response) this.notice = { kind: "info", text: "Queued as steering." };
				} else {
					const response = await this.#call("Prompt", () => runtime.agent.prompt(request, BACKGROUND_CONTEXT));
					if (response && !response.accepted) this.notice = { kind: "error", text: response.error.message };
					else if (response?.error) this.notice = { kind: "error", text: response.error.message };
				}
				this.#stickToBottom = true;
				break;
			}
			case "model":
				this.modelQuery = action.query;
				this.modelPicker = true;
				break;
			case "thinking":
				if (action.level === undefined) {
					await this.#call("Thinking", () => runtime.models.cycleThinking(BACKGROUND_CONTEXT));
				} else {
					const level = action.level;
					await this.#call("Thinking", () => runtime.models.selectThinking(level, BACKGROUND_CONTEXT));
				}
				break;
			case "compact":
				await this.#compact(action.instructions);
				break;
			case "reload":
				await this.#call("Reload", () => runtime.plugins.reload(BACKGROUND_CONTEXT));
				this.notice = { kind: "info", text: "Plugins reloaded." };
				break;
			case "error":
				this.notice = { kind: "error", text: action.message };
				break;
		}
	}

	async #compact(instructions: string | null): Promise<void> {
		const runtime = this.#runtime;
		if (!runtime) return;
		const response = await this.#call("Compact", () =>
			runtime.agent.compact({ customInstructions: instructions }, BACKGROUND_CONTEXT),
		);
		if (response && !response.accepted) this.notice = { kind: "error", text: response.error.message };
	}

	async #abort(): Promise<void> {
		const runtime = this.#runtime;
		const operation = this.lane?.operation;
		if (!runtime || !operation) return;
		await this.#call("Abort", () => runtime.agent.requestAbort(operation.id, BACKGROUND_CONTEXT));
	}

	async #selectModel(model: ModelSummary): Promise<void> {
		const runtime = this.#runtime;
		if (!runtime) return;
		this.modelPicker = false;
		await this.#call("Select model", () =>
			runtime.models.select({ provider: model.provider, modelId: model.modelId }, BACKGROUND_CONTEXT),
		);
	}

	async #selectThinking(event: Event): Promise<void> {
		const runtime = this.#runtime;
		if (!runtime) return;
		const level = (event.target as HTMLSelectElement).value as ThinkingLevel;
		await this.#call("Thinking", () => runtime.models.selectThinking(level, BACKGROUND_CONTEXT));
	}

	#onComposerKey(event: KeyboardEvent): void {
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			void this.#submit();
		} else if (event.key === "Escape" && this.modelPicker) {
			this.modelPicker = false;
		}
	}

	#dismissNotice(): void {
		this.notice = undefined;
	}

	#useCompletion(name: string): void {
		this.draft = `${name} `;
	}

	#onModelQuery(event: Event): void {
		this.modelQuery = (event.target as HTMLInputElement).value;
	}

	#onComposerInput(event: Event): void {
		this.draft = (event.target as HTMLTextAreaElement).value;
	}

	// ── rendering ────────────────────────────────────────────────────────────

	render(): TemplateResult {
		return html`
			<aside class="sidebar">
				<header>
					<h1>pi sessions</h1>
					<button class="primary" ?disabled=${this.phase !== "ready" || this.busy} @click=${() => this.#createSession()}>
						New session
					</button>
				</header>
				<ul class="sessions">
					${repeat(
						this.sessions,
						(session) => session.sessionId,
						(session) => html`
							<li class=${session.sessionId === this.attached ? "active" : ""}>
								<button class="session" @click=${() => this.#attach(session.sessionId)}>
									<span class="id">${shortId(session.sessionId)}</span>
									<span class="meta">${new Date(session.createdAt).toLocaleString()}</span>
								</button>
								<button class="icon" title="Delete session" @click=${() => this.#removeSession(session.sessionId)}>×</button>
							</li>
						`,
					)}
					${this.sessions.length === 0 && this.phase === "ready" ? html`<li class="empty">No sessions yet.</li>` : nothing}
				</ul>
				<footer class="connection ${this.phase}">
					${
						this.phase === "ready"
							? "connected"
							: this.phase === "connecting"
								? "connecting…"
								: html`disconnected: ${this.#disconnectReason} <button @click=${() => this.#reconnect()}>Reconnect</button>`
					}
				</footer>
			</aside>
			<main class="main">
				${this.attached === undefined ? this.#renderEmpty() : this.#renderSession()}
			</main>
		`;
	}

	#renderEmpty(): TemplateResult {
		return html`<div class="placeholder">
			<p>Select a session or create a new one.</p>
			<p class="hint">Every session runs on mcp-js with <code>read</code>, <code>write</code>, and <code>run_js</code>, and starts with an empty filesystem.</p>
		</div>`;
	}

	#renderSession(): TemplateResult {
		const lane = this.lane;
		const operation = lane?.operation ?? null;
		return html`
			<div class="transcript" @scroll=${(event: Event) => this.#onTranscriptScroll(event)}>
				${
					lane === null
						? html`<div class="placeholder">Loading session…</div>`
						: html`
						${repeat(
							lane.transcript,
							(entry) => entry.id,
							(entry) => this.#renderEntry(entry),
						)}
						${operation?.streamingMessage ? this.#renderAssistant(operation.streamingMessage, true) : nothing}
						${
							operation
								? repeat(
										operation.runningTools,
										(tool) => tool.toolCallId,
										(tool) => this.#renderRunningTool(tool),
									)
								: nothing
						}
						${lane.queues.length > 0 ? html`<div class="queued">${lane.queues.length} queued message(s)</div>` : nothing}
					`
				}
			</div>
			${this.notice ? html`<div class="notice ${this.notice.kind}">${this.notice.text} <button class="icon" @click=${() => this.#dismissNotice()}>×</button></div>` : nothing}
			${this.#renderStatus(lane)}
			${this.#renderComposer(operation !== null)}
		`;
	}

	#renderEntry(entry: Entry): TemplateResult {
		switch (entry.type) {
			case "message": {
				const msg = entry.message as { role: string; content?: unknown; timestamp?: number } & Record<
					string,
					unknown
				>;
				if (msg.role === "user") {
					return html`<article class="card user">
						<header><span>You</span><time>${when(Number(msg.timestamp ?? entry.timestamp))}</time></header>
						<pre class="text">${textOf(msg.content)}</pre>
					</article>`;
				}
				if (msg.role === "assistant") return this.#renderAssistant(msg, false);
				if (msg.role === "toolResult") {
					return html`<article class="card tool-result ${msg.isError ? "error" : ""}">
						<header><span>${String(msg.toolName)} result</span>${msg.isError ? html`<span class="badge">error</span>` : nothing}</header>
						<pre class="output">${textOf(msg.content)}</pre>
					</article>`;
				}
				return html`<article class="card other"><header><span>${msg.role}</span></header><pre class="text">${textOf(msg.content)}</pre></article>`;
			}
			case "compaction":
				return html`<article class="card system"><header><span>Compacted</span></header><pre class="text">${entry.summary}</pre></article>`;
			case "branch_summary":
				return html`<article class="card system"><header><span>Branch summary</span></header><pre class="text">${entry.summary}</pre></article>`;
			default:
				return html``;
		}
	}

	#renderAssistant(msg: Record<string, unknown>, streaming: boolean): TemplateResult {
		const parts = blocks(msg.content);
		const model = [msg.provider, msg.model].filter(Boolean).join("/");
		return html`<article class="card assistant ${streaming ? "streaming" : ""}">
			<header><span>Assistant</span><span class="meta">${model}${streaming ? " · streaming" : ""}</span></header>
			${parts.map((part) => {
				if (part.type === "text") return html`<pre class="text">${String(part.text ?? "")}</pre>`;
				if (part.type === "thinking")
					return html`<details class="thinking"><summary>Thinking</summary><pre class="text">${String(part.thinking ?? "")}</pre></details>`;
				if (part.type === "toolCall")
					return this.#renderToolCall(String(part.name), part.arguments ?? part.partialArgs);
				return nothing;
			})}
			${msg.stopReason === "error" ? html`<div class="badge">error: ${String(msg.errorMessage ?? "")}</div>` : nothing}
		</article>`;
	}

	#renderToolCall(name: string, args: unknown): TemplateResult {
		const record = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
		if (name === "run_js" && typeof record.code === "string") {
			return html`<div class="tool-call"><div class="tool-name">run_js</div><pre class="code">${record.code}</pre></div>`;
		}
		if ((name === "read" || name === "write") && typeof record.path === "string") {
			return html`<div class="tool-call"><div class="tool-name">${name} <code>${record.path}</code></div>${
				name === "write" && typeof record.content === "string"
					? html`<pre class="code">${record.content}</pre>`
					: nothing
			}</div>`;
		}
		return html`<div class="tool-call"><div class="tool-name">${name}</div><pre class="code">${typeof args === "string" ? args : pretty(args)}</pre></div>`;
	}

	#renderRunningTool(tool: RunningTool): TemplateResult {
		const output = tool.result ? textOf(tool.result.content) : "";
		return html`<article class="card tool-result running">
			<header><span>${tool.toolName}</span><span class="meta">${tool.status === "running" ? "running…" : "settled"}</span></header>
			${this.#renderToolCall(tool.toolName, tool.args)}
			${output ? html`<pre class="output">${output}</pre>` : nothing}
		</article>`;
	}

	#renderStatus(lane: LaneTranscriptSnapshot | null): TemplateResult {
		const operation = lane?.operation ?? null;
		const usage = lane?.stats.usage;
		return html`<div class="status">
			<span class="dot ${operation ? "working" : "idle"}"></span>
			<span>${operation ? `${operation.kind} · ${operation.status}` : "idle"}</span>
			${operation ? html`<button class="danger" @click=${() => this.#abort()}>Abort</button>` : nothing}
			<span class="spacer"></span>
			${usage ? html`<span class="meta">↑${usage.input} ↓${usage.output}${lane?.stats.messageCount !== undefined ? ` · ${lane.stats.messageCount} messages` : ""}</span>` : nothing}
		</div>`;
	}

	#renderComposer(running: boolean): TemplateResult {
		const models = this.models;
		const current = models?.configuration.model;
		const currentLabel = current ? `${current.provider}/${current.modelId}` : "model";
		const completions = completeCommand(this.draft);
		return html`<div class="composer">
			${this.modelPicker ? this.#renderModelPicker() : nothing}
			${
				completions.length > 0 && !this.modelPicker
					? html`<ul class="completions">${completions.map((name) => {
							const command = COMMANDS.find((c) => c.name === name);
							return html`<li><button @click=${() => this.#useCompletion(name)}><code>${name}</code> <span class="meta">${command?.description ?? ""}</span></button></li>`;
						})}</ul>`
					: nothing
			}
			<textarea
				placeholder=${running ? "Steer the running turn… (Enter to send)" : "Message pi… (Enter to send, Shift+Enter for newline, / for commands)"}
				.value=${this.draft}
				@input=${(event: Event) => this.#onComposerInput(event)}
				@keydown=${(event: KeyboardEvent) => this.#onComposerKey(event)}
				?disabled=${this.phase !== "ready"}
			></textarea>
			<div class="toolbar">
				<button title="/model" @click=${() => {
					this.modelQuery = "";
					this.modelPicker = !this.modelPicker;
				}}>${currentLabel}</button>
				<select title="/thinking" .value=${models?.configuration.thinkingLevel ?? "medium"} @change=${(event: Event) => this.#selectThinking(event)}>
					${THINKING_LEVELS.map((level) => html`<option value=${level} ?selected=${models?.configuration.thinkingLevel === level}>thinking: ${level}</option>`)}
				</select>
				<button title="/compact" ?disabled=${running} @click=${() => this.#compact(null)}>Compact</button>
				<button title="/reload" @click=${() => {
					this.draft = "/reload";
					void this.#submit();
				}}>Reload</button>
				<span class="spacer"></span>
				<button class="primary" ?disabled=${this.phase !== "ready" || this.draft.trim().length === 0} @click=${() => this.#submit()}>${running ? "Steer" : "Send"}</button>
			</div>
		</div>`;
	}

	#renderModelPicker(): TemplateResult {
		const query = this.modelQuery.toLowerCase();
		const available = this.models?.catalog.availableModels ?? [];
		const shown = available.filter((model) =>
			query.length === 0 ? true : `${model.provider}/${model.modelId} ${model.name}`.toLowerCase().includes(query),
		);
		return html`<div class="model-picker">
			<input placeholder="Filter models" .value=${this.modelQuery} @input=${(event: Event) => this.#onModelQuery(event)} @keydown=${(
				event: KeyboardEvent,
			) => {
				if (event.key === "Escape") this.modelPicker = false;
				if (event.key === "Enter" && shown[0]) void this.#selectModel(shown[0]);
			}} autofocus />
			<ul>
				${shown.slice(0, 50).map((model) => html`<li><button @click=${() => this.#selectModel(model)}><code>${model.provider}/${model.modelId}</code> <span class="meta">${model.name}${model.reasoning ? " · reasoning" : ""}</span></button></li>`)}
				${shown.length === 0 ? html`<li class="empty">No models match.</li>` : nothing}
			</ul>
		</div>`;
	}
}

customElements.define("pi-sessions-app", PiSessionsApp);
