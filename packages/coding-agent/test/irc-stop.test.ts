import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import type { Client } from "irc-framework";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { createSendQueue, IrcPiBot } from "../src/irc/bot.ts";
import { ChannelSession, type ChannelSessionDeps } from "../src/irc/channel-session.ts";
import { parseCommand } from "../src/irc/commands.ts";

const sdk = vi.hoisted(() => ({ session: undefined as unknown }));
vi.mock("../src/core/sdk.ts", () => ({ createAgentSession: async () => ({ session: sdk.session }) }));
const roots: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class FakeSession {
	isStreaming = false;
	agent = new Agent({
		streamFn: () => {
			throw new Error("No inference in this test");
		},
	});
	listeners = new Set<(event: AgentSessionEvent) => void>();
	finish: (() => void) | undefined;
	bindExtensions = vi.fn(async () => {});
	clearQueue = vi.fn(() => ({ steering: [], followUp: [] }));
	steer = vi.fn(async () => {});
	dispose = vi.fn();
	getLastAssistantText = () => "done";
	subscribe(listener: (event: AgentSessionEvent) => void) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	emit(event: { type: string; [key: string]: unknown }) {
		for (const listener of this.listeners) listener(event as AgentSessionEvent);
	}
	prompt = vi.fn(async () => {
		this.emit({ type: "agent_start" });
		this.emit({ type: "turn_start" });
		await new Promise<void>((resolve) => {
			this.finish = resolve;
		});
		this.emit({ type: "agent_end", messages: [] });
	});
	abort = vi.fn(async () => {
		this.finish?.();
	});
}

async function fixture(channel = "#test") {
	const root = mkdtempSync(join(tmpdir(), "irc-stop-"));
	roots.push(root);
	const fake = new FakeSession();
	sdk.session = fake;
	const deps = {
		cwd: root,
		agentDir: root,
		sessionDir: root,
		createResources: async () => ({}),
		modelRuntime: {},
		delegate: {},
		log: () => {},
		runLimits: { maxTurns: 3, maxDurationMs: 1000 },
	} as unknown as ChannelSessionDeps;
	const session = await ChannelSession.open(channel, deps);
	const lines: string[] = [];
	session.watch({ text: (text) => lines.push(...text), tool: (line) => lines.push(line) });
	return { root, fake, session, deps, lines };
}

describe("IRC cancellation", () => {
	it("stops a delegated child without waiting for a stuck tool or disturbing an independent channel", async () => {
		const parent = await fixture("#parent");
		const child = await fixture("#child");
		const independent = await fixture("#independent");
		const slow = await fixture("#slow");
		let releaseSlow!: () => void;
		const sessions = new Map([
			["#parent", parent.session],
			["#child", child.session],
			["#independent", independent.session],
			["#slow", slow.session],
		]);
		const open = vi.spyOn(ChannelSession, "open").mockImplementation(async (channel) => {
			if (channel === "#slow")
				await new Promise<void>((resolve) => {
					releaseSlow = resolve;
				});
			return sessions.get(channel)!;
		});
		const handlers = new Map<string, (event: unknown) => void>();
		const said: string[] = [];
		const irc = {
			on: (name: string, handler: (event: unknown) => void) => handlers.set(name, handler),
			connect: () => {},
			join: (channel: string) => queueMicrotask(() => handlers.get("join")?.({ channel, nick: "pi" })),
			say: (room: string, text: string) => said.push(`${room}: ${text}`),
			quit: () => {},
		};
		const bot = new IrcPiBot({
			...parent.deps,
			server: "test",
			port: 6667,
			tls: false,
			nick: "pi",
			channels: [],
			controlChannel: "#parent",
			addressedOnly: true,
			statePath: join(parent.root, "channels.json"),
			workspaceRoot: parent.root,
			createClient: () => irc as unknown as Client,
			sendSpacingMs: 0,
		});
		await bot.start();
		const controller = new AbortController();
		parent.fake.prompt.mockImplementationOnce(async () => {
			parent.fake.emit({ type: "agent_start" });
			await bot
				.spawn({ room: "#parent", name: "child", prompt: "child work", signal: controller.signal })
				.catch(() => {});
			parent.fake.emit({ type: "agent_end", messages: [] });
		});
		parent.fake.abort.mockImplementationOnce(async () => {
			controller.abort();
		});
		// Simulate a third-party child tool that does not honor cancellation.
		child.fake.abort.mockImplementationOnce(async () => {});
		const independentRun = independent.session.prompt("independent work");
		handlers.get("privmsg")?.({ nick: "user", target: "#parent", message: "pi: delegate" });
		await vi.waitFor(() => expect(child.fake.prompt).toHaveBeenCalledOnce());
		handlers.get("privmsg")?.({ nick: "user", target: "#parent", message: ",stop" });
		await vi.waitFor(() => expect(said).toContain("#parent: stopped; ready for a new prompt"));
		expect(child.fake.abort).toHaveBeenCalledOnce();
		expect(independent.fake.abort).not.toHaveBeenCalled();
		expect(child.session.busy).toBe(true);
		child.fake.emit({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "late orphan output" }] },
		});
		await Promise.resolve();
		expect(said.join("\n")).not.toContain("late orphan output");
		const next = parent.session.prompt("legitimate next turn");
		await Promise.resolve();
		parent.fake.finish?.();
		await next;
		child.fake.finish?.();
		await vi.waitFor(() => expect(child.session.busy).toBe(false));
		const childAbort = vi.spyOn(child.fake.agent, "abort");
		child.fake.emit({ type: "agent_start" });
		expect(childAbort).toHaveBeenCalledOnce();
		child.fake.emit({ type: "agent_end", messages: [] });
		const childNext = child.session.prompt("explicit child resume");
		await Promise.resolve();
		child.fake.finish?.();
		await childNext;
		expect(childAbort).toHaveBeenCalledOnce();
		independent.fake.finish?.();
		await independentRun;
		await independent.session.close();
		const slowController = new AbortController();
		const slowSpawn = bot.spawn({
			room: "#parent",
			name: "slow",
			prompt: "must not start",
			signal: slowController.signal,
		});
		await vi.waitFor(() => expect(releaseSlow).toBeDefined());
		slowController.abort();
		await expect(slowSpawn).rejects.toThrow();
		await expect(bot.spawn({ room: "#parent", name: "slow", prompt: "retry too soon" })).rejects.toThrow(
			"opening in progress",
		);
		handlers.get("privmsg")?.({ nick: "user", target: "#slow", message: "pi: concurrent prompt" });
		await vi.waitFor(() => expect(said.join("\n")).toContain("fork in progress"));
		expect(open.mock.calls.filter(([channel]) => channel === "#slow")).toHaveLength(1);
		releaseSlow();
		await vi.waitFor(() => expect(bot.store.get("#slow")).toBeDefined());
		expect(slow.fake.prompt).not.toHaveBeenCalled();
		expect(slow.fake.abort).toHaveBeenCalledOnce();
		await bot.close();
	});
	it("parses stop separately from prompts", () => {
		expect(parseCommand(",stop")).toEqual({ kind: "stop" });
		expect(parseCommand(",stop later")).toMatchObject({ kind: "error" });
	});

	it("cancels a prompt before its queued callback starts", async () => {
		const { fake, session } = await fixture();
		const prompt = session.prompt("queued");
		await session.abort();
		await prompt;
		expect(fake.prompt).not.toHaveBeenCalled();
		expect(session.busy).toBe(false);
	});

	it("waits for in-flight steering before acknowledging cancellation", async () => {
		const { fake, session } = await fixture();
		const first = session.prompt("work");
		await Promise.resolve();
		let finishSteering!: () => void;
		fake.steer.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					finishSteering = resolve;
				}),
		);
		const steering = session.prompt("stale steering");
		let stopped = false;
		const stopping = session.abort().then(() => {
			stopped = true;
		});
		await Promise.resolve();
		expect(stopped).toBe(false);
		await expect(session.prompt("too early")).rejects.toThrow("Cancellation");
		finishSteering();
		await Promise.all([first, steering, stopping]);
		expect(stopped).toBe(true);
		expect(fake.clearQueue).toHaveBeenCalled();
		await session.close();
	});

	it("stops while busy, clears steering, is idempotent, and allows a clean next turn", async () => {
		const { fake, session } = await fixture();
		const first = session.prompt("work");
		await Promise.resolve();
		await session.prompt("pending steering");
		const stopping = session.abort();
		expect(session.abort()).toBe(stopping);
		await stopping;
		await first;
		expect(fake.abort).toHaveBeenCalledTimes(1);
		expect(fake.clearQueue).toHaveBeenCalledTimes(2);
		expect(session.busy).toBe(false);
		const next = session.prompt("legitimate new work");
		await Promise.resolve();
		fake.finish?.();
		await next;
		expect(fake.prompt).toHaveBeenCalledTimes(2);
		await session.close();
		expect(fake.listeners.size).toBe(0);
		expect(fake.dispose).toHaveBeenCalledOnce();
	});

	it("keeps cancellation pending when steering rejects before inference settles", async () => {
		const { fake, session } = await fixture();
		const first = session.prompt("work");
		await Promise.resolve();
		fake.abort.mockImplementationOnce(async () => {});
		let rejectSteering!: (error: Error) => void;
		fake.steer.mockImplementationOnce(
			() =>
				new Promise<void>((_, reject) => {
					rejectSteering = reject;
				}),
		);
		const steering = session.prompt("bad steering").catch(() => {});
		let settled = false;
		const stopping = session.abort().catch(() => {
			settled = true;
		});
		rejectSteering(new Error("input hook failed"));
		await steering;
		await Promise.resolve();
		expect(settled).toBe(false);
		await expect(session.prompt("too early")).rejects.toThrow("Cancellation");
		fake.finish?.();
		await Promise.all([first, stopping]);
		expect(settled).toBe(true);
		await session.close();
	});

	it("aborts a run whose preflight completes after stop", async () => {
		const { fake, session } = await fixture();
		let release!: () => void;
		const abort = vi.spyOn(fake.agent, "abort");
		fake.prompt.mockImplementationOnce(async () => {
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			fake.emit({ type: "agent_start" });
			fake.emit({ type: "agent_end", messages: [] });
		});
		const first = session.prompt("slow preflight");
		await Promise.resolve();
		const stopping = session.abort();
		release();
		await Promise.all([first, stopping]);
		expect(abort).toHaveBeenCalledOnce();
		await session.close();
	});

	it("cleans up listeners and disposes even if abort rejects", async () => {
		const { fake, session } = await fixture();
		fake.abort.mockRejectedValueOnce(new Error("abort failed"));
		await expect(session.close()).rejects.toThrow("abort failed");
		expect(fake.listeners.size).toBe(0);
		expect(fake.dispose).toHaveBeenCalledOnce();
	});

	it("allows different arguments producing the same tool error", async () => {
		const { fake, session } = await fixture();
		const prompt = session.prompt("try different files");
		await Promise.resolve();
		for (let i = 0; i < 3; i++) {
			fake.emit({
				type: "tool_execution_start",
				toolCallId: String(i),
				toolName: "read",
				args: { path: String(i) },
			});
			fake.emit({
				type: "tool_execution_end",
				toolCallId: String(i),
				toolName: "read",
				isError: true,
				result: { content: [{ type: "text", text: "not found" }] },
			});
		}
		expect(fake.abort).not.toHaveBeenCalled();
		fake.finish?.();
		await prompt;
		await session.close();
	});

	it("bounds repeated failing tool calls and inference turns", async () => {
		const { fake, session, lines } = await fixture();
		const prompt = session.prompt("repeat");
		await Promise.resolve();
		for (let i = 0; i < 3; i++)
			fake.emit({
				type: "tool_execution_end",
				toolName: "schedule_prompt",
				isError: true,
				result: { content: [{ type: "text", text: "missing schedule and prompt" }] },
			});
		await prompt;
		await session.abort();
		expect(lines.join(" ")).toContain("same error three times");
		const next = session.prompt("loop without errors");
		await Promise.resolve();
		for (let i = 0; i < 3; i++) fake.emit({ type: "turn_start" });
		await next;
		expect(lines.join(" ")).toContain("exceeded 3 turns");
	});

	it("bounds a hanging run and removes its timer after stop", async () => {
		vi.useFakeTimers();
		const { fake, session } = await fixture();
		const prompt = session.prompt("hang");
		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(1000);
		await prompt;
		expect(fake.abort).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("discards outgoing backlog without delaying cancellation acknowledgements", async () => {
		vi.useFakeTimers();
		const sent: string[] = [];
		const queue = createSendQueue(
			(line) => sent.push(line),
			350,
			() => {},
		);
		const old = queue(["one", "old two", "old three"]);
		await Promise.resolve();
		queue.clear();
		const stopped = queue(["stopped"]);
		await Promise.resolve();
		expect(sent).toEqual(["one", "stopped"]);
		await vi.runAllTimersAsync();
		await Promise.all([old, stopped]);
		expect(sent).toEqual(["one", "stopped"]);
	});

	it.each([
		{ nick: "user", target: "#test", room: "#test" },
		{ nick: "Alice", target: "pi", room: "alice" },
	])("handles bare stop while busy in $room", async ({ nick, target, room }) => {
		const { root, session, fake, deps } = await fixture();
		vi.spyOn(ChannelSession, "open").mockResolvedValue(session);
		const handlers = new Map<string, (event: unknown) => void>();
		const said: string[] = [];
		const targets: string[] = [];
		const irc = {
			on: (name: string, handler: (event: unknown) => void) => handlers.set(name, handler),
			connect: () => {},
			say: (destination: string, text: string) => {
				targets.push(destination);
				said.push(text);
			},
			quit: () => {},
		};
		const bot = new IrcPiBot({
			...deps,
			server: "test",
			port: 6667,
			tls: false,
			nick: "pi",
			channels: [],
			controlChannel: "#control",
			addressedOnly: true,
			statePath: join(root, "channels.json"),
			workspaceRoot: root,
			createClient: () => irc as unknown as Client,
			sendSpacingMs: 0,
		});
		await bot.start();
		handlers.get("privmsg")?.({ nick, target, message: "pi: work" });
		await vi.waitFor(() => expect(fake.prompt).toHaveBeenCalledOnce());
		handlers.get("privmsg")?.({ nick, target, message: ",stop" });
		await vi.waitFor(() => expect(said).toContain("stopped; ready for a new prompt"));
		expect(session.busy).toBe(false);
		expect(targets.every((destination) => destination === room)).toBe(true);
		await bot.close();
	});
});
