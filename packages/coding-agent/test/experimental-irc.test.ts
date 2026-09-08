import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { addressedText, parseChannelList, parseCommand } from "../src/experimental/irc/commands.ts";
import { forkEngineSession } from "../src/experimental/irc/engine-fork.ts";
import { describeToolCall, describeToolResult, framePrompt, toIrcLines } from "../src/experimental/irc/format.ts";
import { resolveIrcConfig } from "../src/experimental/irc/run.ts";
import { ChannelSessionStore } from "../src/experimental/irc/state.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-irc-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("irc control commands", () => {
	it("parses join with comma or space separated channels", () => {
		expect(parseCommand(",join #a,#b")).toEqual({ kind: "join", channels: ["#a", "#b"] });
		expect(parseCommand(",join #A #b, #a")).toEqual({ kind: "join", channels: ["#a", "#b"] });
		expect(parseCommand(",join")).toEqual({ kind: "error", message: "Usage: ,join #channel[,#other]" });
		expect(parseCommand(",join nope")).toEqual({ kind: "error", message: "Not a channel: nope" });
	});

	it("parses fork, part, sessions, help, and unknown commands", () => {
		expect(parseCommand(",fork #dev")).toEqual({ kind: "fork", channel: "#dev" });
		expect(parseCommand(",fork #dev #pi")).toEqual({ kind: "fork", channel: "#dev", from: "#pi" });
		expect(parseCommand(",fork")).toEqual({ kind: "error", message: "Usage: ,fork #channel [#from]" });
		expect(parseCommand(",part #dev")).toEqual({ kind: "part", channel: "#dev" });
		expect(parseCommand(",sessions")).toEqual({ kind: "sessions" });
		expect(parseCommand(",HELP")).toEqual({ kind: "help" });
		expect(parseCommand(",dance")).toEqual({ kind: "error", message: "Unknown command ,dance. Try ,help" });
	});

	it("leaves ordinary lines alone", () => {
		expect(parseCommand("hello, world")).toBeUndefined();
		expect(parseCommand("pi: ,join is a command")).toBeUndefined();
		expect(parseChannelList("#x,, #y")).toEqual({ channels: ["#x", "#y"], invalid: [] });
	});

	it("detects lines addressed to the bot", () => {
		expect(addressedText("pi: list files", "pi")).toBe("list files");
		expect(addressedText("Pi, list files", "pi")).toBe("list files");
		expect(addressedText("@pi list files", "pi")).toBe("list files");
		expect(addressedText("pi list files", "pi")).toBe("list files");
		expect(addressedText("piano is nice", "pi")).toBeUndefined();
		expect(addressedText("what about pi?", "pi")).toBeUndefined();
	});
});

describe("irc formatting", () => {
	it("splits replies into non-empty lines and caps them", () => {
		expect(toIrcLines("a\n\n```js\nb\n```\nc\r\n")).toEqual(["a", "b", "c"]);
		const many = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
		const lines = toIrcLines(many, 5);
		expect(lines).toHaveLength(6);
		expect(lines[5]).toBe("… (25 more lines)");
	});

	it("summarizes tool calls and results in one line", () => {
		expect(describeToolCall("run_js", { code: "const a = 1;\n\nconsole.log(a)" })).toBe(
			"[run_js] 2 lines: const a = 1;",
		);
		expect(describeToolCall("read", { path: "/x.txt" })).toBe("[read] /x.txt");
		expect(describeToolCall("mystery", {})).toBe("[mystery]");
		expect(describeToolResult("run_js", "42", false)).toBe("[run_js] → 42");
		expect(describeToolResult("run_js", "a\nb\nc", false)).toBe("[run_js] → a (+2 lines)");
		expect(describeToolResult("read", "ENOENT", true)).toBe("[read] error: ENOENT");
		expect(framePrompt("#pi", "bob", "hi")).toBe("[IRC #pi] <bob> hi");
	});
});

describe("channel session store", () => {
	it("persists channel to session mappings across instances", () => {
		const path = join(dir, "state", "channels.json");
		const store = new ChannelSessionStore(path);
		expect(store.entries()).toEqual([]);
		store.set("#Pi", { sessionId: "s1", createdAt: 1 });
		store.set("#dev", { sessionId: "s2", createdAt: 2, forkedFrom: "#pi" });
		expect(existsSync(path)).toBe(true);
		const reloaded = new ChannelSessionStore(path);
		expect(reloaded.get("#PI")).toEqual({ sessionId: "s1", createdAt: 1 });
		expect(reloaded.channelFor("s2")).toBe("#dev");
		expect(reloaded.delete("#dev")).toBe(true);
		expect(reloaded.delete("#dev")).toBe(false);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
			version: 1,
			channels: { "#pi": { sessionId: "s1", createdAt: 1 } },
		});
	});
});

describe("engine fork over the coordinator API", () => {
	it("seeds the target session from the source's latest heap and fs ids", async () => {
		const calls: Array<{ url: string; body?: unknown }> = [];
		let polls = 0;
		const fakeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
			if (url.endsWith("/api/sessions/src/snapshots")) {
				return Response.json([
					{ output_heap: "h1", output_fs: "f1" },
					{ output_heap: "h2", output_fs: "f2" },
				]);
			}
			if (url.endsWith("/api/exec")) return Response.json({ execution_id: "e1" });
			if (url.endsWith("/api/executions/e1"))
				return Response.json({ status: ++polls < 2 ? "running" : "completed" });
			return new Response("no", { status: 404 });
		}) as unknown as typeof fetch;
		await expect(
			forkEngineSession("src", "dst", { url: "http://engine/", fetch: fakeFetch, pollMs: 1 }),
		).resolves.toBe(true);
		expect(calls[1]?.body).toEqual({ session: "dst", code: "// forked from session src", heap: "h2", fs: "f2" });
		await expect(forkEngineSession("missing", "dst", { url: "http://engine", fetch: fakeFetch })).resolves.toBe(
			false,
		);
	});
});

describe("irc config resolution", () => {
	it("prefers flags, then IRC_* env, then defaults", () => {
		const env = {
			IRC_SERVER: "irc.env",
			IRC_PORT: "6697",
			IRC_TLS: "true",
			IRC_CHANNELS: "#a,#b",
			IRC_NICK: "envpi",
		};
		const fromEnv = resolveIrcConfig({ command: "irc" }, env, "/agent");
		expect(fromEnv).toMatchObject({
			server: "irc.env",
			port: 6697,
			tls: true,
			nick: "envpi",
			controlChannel: "#pi",
			addressedOnly: true,
		});
		expect(fromEnv.channels).toEqual(["#pi", "#a", "#b"]);
		expect(fromEnv.statePath).toBe("/agent/irc/channels.json");
		const fromFlags = resolveIrcConfig(
			{ command: "irc", server: "irc.flag", channels: ["#Z"], all: true, controlChannel: "#Ops" },
			env,
			"/agent",
		);
		expect(fromFlags).toMatchObject({ server: "irc.flag", port: 6697, controlChannel: "#ops", addressedOnly: false });
		expect(fromFlags.channels).toEqual(["#ops", "#z"]);
		expect(resolveIrcConfig({ command: "irc", server: "x" }, {}, "/agent").port).toBe(6667);
		expect(() => resolveIrcConfig({ command: "irc" }, {}, "/agent")).toThrow("IRC_SERVER");
	});
});
