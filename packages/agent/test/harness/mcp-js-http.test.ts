import { describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "../../src/harness/context.ts";
import { McpJsExecutionEnv } from "../../src/harness/env/mcp-js.ts";
import { McpJsHttpEngine, waitForMcpJsReady } from "../../src/harness/env/mcp-js-http.ts";

type Route = (url: URL, init: RequestInit) => Response | Promise<Response>;

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A fake mcp-js server: one session snapshot held in memory, executions settle on the next poll. */
function server(options: { filesystem?: boolean } = {}) {
	const files = new Map<string, Uint8Array>();
	const executions = new Map<string, { status: string; output: string; polls: number }>();
	const calls: Array<{ method: string; path: string }> = [];
	const route: Route = async (url, init) => {
		const method = init.method ?? "GET";
		calls.push({ method, path: `${url.pathname}${url.search}` });
		if (url.pathname === "/api/capabilities") {
			return json({ heap: true, filesystem: options.filesystem ?? true, sessions: true });
		}
		if (url.pathname === "/api/exec") {
			const body = JSON.parse(String(init.body)) as { code: string; session?: string };
			const id = `exec-${executions.size + 1}`;
			executions.set(id, { status: "running", output: `${body.session}:${body.code}`, polls: 0 });
			return json({ execution_id: id }, 202);
		}
		const execution = url.pathname.match(/^\/api\/executions\/([^/]+)(\/output|\/cancel)?$/);
		if (execution) {
			const record = executions.get(execution[1]!);
			if (!record) return json({ error: "unknown execution" }, 404);
			if (execution[2] === "/cancel") {
				record.status = "cancelled";
				return json({ cancelled: true });
			}
			if (execution[2] === "/output") return json({ data: record.output });
			if (record.status === "running" && ++record.polls >= 2) record.status = "completed";
			return json({ execution_id: execution[1], status: record.status, heap: "h1", fs: "f1", error: null });
		}
		const session = url.pathname.match(/^\/api\/sessions\/([^/]+)\/(files|entries|dir|fs|snapshots)(?:\/(.*))?$/);
		if (!session) return json({ error: `no route ${url.pathname}` }, 404);
		const path = `/${decodeURIComponent(session[3] ?? "")}`;
		switch (session[2]) {
			case "files": {
				if (method === "GET") {
					const file = files.get(path);
					if (!file) return json({ error: `fs.readFile: ${path}: ENOENT`, kind: "not_found" }, 404);
					const offset = Number(url.searchParams.get("offset") ?? 0);
					const max = url.searchParams.get("max_bytes");
					const slice = file.slice(offset, max === null ? undefined : offset + Number(max));
					return new Response(slice, { headers: { "content-type": "application/octet-stream" } });
				}
				if (method === "PUT") {
					const incoming = new Uint8Array(await new Response(init.body as ArrayBuffer).arrayBuffer());
					if (url.searchParams.get("append") === "true") {
						files.set(path, new Uint8Array([...(files.get(path) ?? []), ...incoming]));
					} else files.set(path, incoming);
					return new Response(null, { status: 204 });
				}
				if (method === "DELETE") {
					if (!files.delete(path)) return json({ error: `fs.rm: ${path}: ENOENT`, kind: "not_found" }, 404);
					return new Response(null, { status: 204 });
				}
				break;
			}
			case "entries": {
				const file = files.get(path);
				if (!file) return json({ error: `fs.lstat: ${path}: ENOENT`, kind: "not_found" }, 404);
				return json({ kind: "file", size: file.byteLength, readonly: false, mode: 0o100644, modified_ms: 5 });
			}
			case "dir": {
				const prefix = path === "/" ? "/" : `${path}/`;
				return json({
					names: [...files.keys()].filter((f) => f.startsWith(prefix)).map((f) => f.slice(prefix.length)),
				});
			}
			case "fs": {
				const body = JSON.parse(String(init.body)) as { op: string; path: string; to?: string };
				const target = `/${body.path.replace(/^\/+/, "")}`;
				if (body.op === "exists") return json({ exists: files.has(target) });
				if (body.op === "mkdir") return json({ ok: true });
				if (body.op === "canonical") return json({ path: target });
				if (body.op === "rename") {
					const file = files.get(target);
					if (!file) return json({ error: `fs.rename: ${target}: ENOENT`, kind: "not_found" }, 404);
					files.delete(target);
					files.set(`/${body.to?.replace(/^\/+/, "")}`, file);
					return json({ ok: true });
				}
				return json({ error: `unknown fs op: ${body.op}`, kind: "other" }, 400);
			}
			case "snapshots":
				return json([{ index: 0, output_heap: "h1", output_fs: "f1", code: "x", timestamp: "t" }]);
		}
		return json({ error: "unsupported" }, 405);
	};
	const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) =>
		route(new URL(String(input)), init),
	) as unknown as typeof globalThis.fetch;
	return { fetch, files, executions, calls };
}

describe("mcp-js HTTP engine (coordinator mode)", () => {
	it("reads capabilities on connect and only offers session views", async () => {
		const fake = server();
		const engine = await McpJsHttpEngine.connect({
			url: "http://node1:3000/",
			fetch: fake.fetch,
			headers: { authorization: "Bearer t" },
		});
		expect(engine.capabilities()).toEqual({ heap: true, filesystem: true, sessions: true });
		expect(engine.hostFilesystemEnabled()).toBe(true);
		expect(() => engine.fsView(undefined)).toThrow("host filesystem");
		expect(fake.calls[0]).toEqual({ method: "GET", path: "/api/capabilities" });
		const [, init] = (fake.fetch as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0]!;
		expect((init.headers as Record<string, string>).authorization).toBe("Bearer t");
	});

	it("drives run_js through /api/exec and settles it by polling", async () => {
		const fake = server();
		const engine = await McpJsHttpEngine.connect({ url: "http://node1:3000", fetch: fake.fetch, pollIntervalMs: 1 });
		const env = new McpJsExecutionEnv(engine, "/work", { session: "pi-1" });
		expect(env.files).toBe("session");
		expect(await env.runJavaScript("console.log(1)", 5, BACKGROUND_CONTEXT)).toEqual({
			output: "pi-1:console.log(1)",
			error: undefined,
		});
		expect(fake.calls.map((call) => call.path)).toEqual([
			"/api/capabilities",
			"/api/capabilities",
			"/api/exec",
			"/api/executions/exec-1",
			"/api/executions/exec-1",
			"/api/executions/exec-1/output",
		]);
		const exec = (fake.fetch as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[2]!;
		expect(JSON.parse(String(exec[1].body))).toEqual({
			code: "console.log(1)",
			session: "pi-1",
			execution_timeout_secs: 5,
		});
	});

	it("moves file bytes through the session file endpoints", async () => {
		const fake = server();
		const engine = await McpJsHttpEngine.connect({ url: "http://node1:3000", fetch: fake.fetch });
		const env = new McpJsExecutionEnv(engine, "/work", { session: "pi-1" });
		const bytes = new Uint8Array([0, 255, 10]);
		expect(await env.writeFile("blob.bin", bytes, BACKGROUND_CONTEXT)).toEqual({ ok: true, value: undefined });
		expect(fake.files.get("/work/blob.bin")).toEqual(bytes);
		expect(await env.readBinaryFile("blob.bin", BACKGROUND_CONTEXT)).toEqual({ ok: true, value: bytes });
		expect(await env.appendFile("blob.bin", new Uint8Array([7]), BACKGROUND_CONTEXT)).toEqual({
			ok: true,
			value: undefined,
		});
		expect(fake.files.get("/work/blob.bin")).toEqual(new Uint8Array([0, 255, 10, 7]));
		expect(await env.writeFile("notes.txt", "a\nb\nc\n", BACKGROUND_CONTEXT)).toEqual({ ok: true, value: undefined });
		expect(await env.readTextLines("notes.txt", { maxLines: 2 }, BACKGROUND_CONTEXT)).toEqual({
			ok: true,
			value: ["a", "b"],
		});
		expect(await env.fileInfo("notes.txt", BACKGROUND_CONTEXT)).toEqual({
			ok: true,
			value: { name: "notes.txt", path: "/work/notes.txt", kind: "file", size: 6, mtimeMs: 5 },
		});
		const listing = await env.listDir(".", BACKGROUND_CONTEXT);
		expect(listing.ok && listing.value.map((entry) => entry.name).sort()).toEqual(["blob.bin", "notes.txt"]);
		expect(await env.renameFile("notes.txt", "moved.txt", BACKGROUND_CONTEXT)).toEqual({
			ok: true,
			value: undefined,
		});
		expect(await env.exists("notes.txt", BACKGROUND_CONTEXT)).toEqual({ ok: true, value: false });
		const missing = await env.readTextFile("notes.txt", BACKGROUND_CONTEXT);
		expect(!missing.ok && missing.error.code).toBe("not_found");
		expect(await env.remove("moved.txt", undefined, BACKGROUND_CONTEXT)).toEqual({ ok: true, value: undefined });
		expect(fake.calls.some((call) => call.path.includes("/api/sessions/pi-1/files/work/blob.bin?append=true"))).toBe(
			true,
		);
	});

	it("serves the snapshot root without a server round trip", async () => {
		const fake = server();
		const engine = await McpJsHttpEngine.connect({ url: "http://node1:3000", fetch: fake.fetch });
		const env = new McpJsExecutionEnv(engine, "/", { session: "pi-root" });
		// A fresh session is an empty snapshot whose root always exists.
		expect(await env.fileInfo(".", BACKGROUND_CONTEXT)).toEqual({
			ok: true,
			value: { name: "", path: "/", kind: "directory", size: 0, mtimeMs: 0 },
		});
		expect(await env.exists("/", BACKGROUND_CONTEXT)).toEqual({ ok: true, value: true });
		const empty = await env.listDir(".", BACKGROUND_CONTEXT);
		expect(empty.ok && empty.value).toEqual([]);
		expect(fake.calls.some((call) => /\/api\/sessions\/pi-root\/entries\/?(\?|$)/.test(call.path))).toBe(false);
		expect(fake.calls.some((call) => call.path.endsWith("/api/sessions/pi-root/dir"))).toBe(true);
		// Files resolve against the root, and reading the root itself is a directory error.
		expect(await env.writeFile("notes.txt", "hi", BACKGROUND_CONTEXT)).toEqual({ ok: true, value: undefined });
		expect(fake.files.get("/notes.txt")).toEqual(new TextEncoder().encode("hi"));
		const listing = await env.listDir("/", BACKGROUND_CONTEXT);
		expect(listing.ok && listing.value.map((entry) => entry.name)).toEqual(["notes.txt"]);
		const root = await env.readTextFile("/", BACKGROUND_CONTEXT);
		expect(!root.ok && root.error.code).toBe("is_directory");
	});

	it("cancels a remote execution when the caller aborts", async () => {
		const fake = server();
		const engine = await McpJsHttpEngine.connect({ url: "http://node1:3000", fetch: fake.fetch, pollIntervalMs: 1 });
		engine.cancelExecution("exec-9");
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(fake.calls.at(-1)).toEqual({ method: "POST", path: "/api/executions/exec-9/cancel" });
	});
});

describe("mcp-js cold-start readiness", () => {
	it.each([401, 403, 400, 500])("does not retry HTTP %s at the timeout boundary or parse its body", async (status) => {
		const controller = new AbortController();
		controller.abort(new DOMException("Probe timed out", "TimeoutError"));
		const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
		const response = json({}, status);
		const parse = vi.spyOn(response, "json");
		const fetch = vi.fn(async () => response);
		try {
			await expect(waitForMcpJsReady({ url: "http://engine", fetch })).rejects.toThrow(`HTTP ${status}`);
			expect(fetch).toHaveBeenCalledTimes(1);
			expect(parse).not.toHaveBeenCalled();
		} finally {
			timeout.mockRestore();
		}
	});

	it.each(["bad JSON", "bad schema"])("does not retry %s even when the attempt timer fired", async (kind) => {
		const controller = new AbortController();
		controller.abort(new DOMException("Probe timed out", "TimeoutError"));
		const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
		const fetch = vi.fn(async () => (kind === "bad JSON" ? new Response("{") : json({ heap: "no" })));
		try {
			await expect(waitForMcpJsReady({ url: "http://engine", fetch })).rejects.toThrow();
			expect(fetch).toHaveBeenCalledTimes(1);
		} finally {
			timeout.mockRestore();
		}
	});

	it("rejects a successful probe arriving at the total deadline", async () => {
		let now = 0;
		const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
		const fetch = vi.fn(async () => {
			now = 20;
			return json({ heap: false, filesystem: true, sessions: true });
		});
		try {
			await expect(waitForMcpJsReady({ url: "http://engine", fetch, readinessTimeoutMs: 20 })).rejects.toThrow(
				"not submitted",
			);
			expect(fetch).toHaveBeenCalledTimes(1);
		} finally {
			clock.mockRestore();
		}
	});

	it("forwards configured headers on every retry and on the single mutation", async () => {
		const seen: RequestInit[] = [];
		let probes = 0;
		const engine = await McpJsHttpEngine.connect({
			url: "http://engine",
			headers: { authorization: "test-only", "x-route": "test" },
			fetch: async (input, init = {}) => {
				seen.push(init);
				if (String(input).endsWith("/api/capabilities")) {
					return ++probes === 1 ? json({}, 502) : json({ heap: false, filesystem: true, sessions: true });
				}
				return json({ execution_id: "one" });
			},
		});
		await engine.callToolAsync("run_js", '{"code":"once"}', "s", undefined);
		for (const init of seen) {
			expect(new Headers(init.headers).get("authorization")).toBe("test-only");
			expect(new Headers(init.headers).get("x-route")).toBe("test");
		}
		expect(seen.filter((init) => init.method === "POST")).toHaveLength(1);
	});

	it("aborts during backoff without waiting for the retry interval or submitting", async () => {
		const controller = new AbortController();
		const fetch = vi.fn(async () => {
			setTimeout(() => controller.abort(), 20);
			return json({}, 502);
		});
		const start = performance.now();
		await expect(waitForMcpJsReady({ url: "http://engine", fetch }, controller.signal)).rejects.toThrow();
		expect(performance.now() - start).toBeLessThan(300);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("retries identifiable connection errors but not arbitrary TypeErrors", async () => {
		let calls = 0;
		await waitForMcpJsReady({
			url: "http://engine",
			fetch: async () => {
				if (++calls === 1) throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
				return json({ heap: false, filesystem: true, sessions: true });
			},
		});
		expect(calls).toBe(2);
		const fetch = vi.fn(async () => {
			throw new TypeError("invalid request configuration");
		});
		await expect(waitForMcpJsReady({ url: "http://engine", fetch })).rejects.toThrow("invalid request");
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("recovers a readiness 502 before submitting a mutation once", async () => {
		const fake = server();
		let probes = 0;
		const engine = await McpJsHttpEngine.connect({
			url: "http://engine",
			readinessTimeoutMs: 2000,
			fetch: async (input, init) => {
				if (String(input).endsWith("/api/capabilities") && ++probes === 2) return json({}, 502);
				return fake.fetch(input, init);
			},
		});
		await engine.callToolAsync("run_js", '{"code":"once"}', "s", undefined);
		expect(probes).toBe(3);
		expect(fake.calls.filter((call) => call.path === "/api/exec")).toHaveLength(1);
	});

	it("bounds a hanging readiness probe and never submits the mutation", async () => {
		let probes = 0;
		let submits = 0;
		const engine = await McpJsHttpEngine.connect({
			url: "http://engine",
			readinessTimeoutMs: 30,
			fetch: async (input, init) => {
				if (!String(input).endsWith("/api/capabilities")) {
					submits++;
					return json({});
				}
				if (++probes === 1) return json({ heap: false, filesystem: true, sessions: true });
				return new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
				});
			},
		});
		await expect(engine.callToolAsync("run_js", '{"code":"once"}', "s", undefined)).rejects.toThrow("not submitted");
		expect(submits).toBe(0);
	});

	it.each(["lost response", "502"])("never replays an ambiguous mutation: %s", async (failure) => {
		const fake = server();
		const engine = await McpJsHttpEngine.connect({
			url: "http://engine",
			fetch: async (input, init) => {
				const response = await fake.fetch(input, init);
				if (String(input).endsWith("/api/exec")) {
					if (failure === "502") return json({}, 502);
					throw new TypeError("lost response after acceptance");
				}
				return response;
			},
		});
		await expect(engine.callToolAsync("run_js", '{"code":"once"}', "s", undefined)).rejects.toThrow();
		expect(fake.executions.size).toBe(1);
		expect(fake.calls.filter((call) => call.path === "/api/exec")).toHaveLength(1);
	});

	it("preserves files when execution lookup disappears; never recreates the execution", async () => {
		const fake = server();
		const engine = await McpJsHttpEngine.connect({ url: "http://engine", fetch: fake.fetch });
		await engine.fsView("s").writeFile("proof", new TextEncoder().encode("persisted").buffer);
		const accepted = JSON.parse(await engine.callToolAsync("run_js", '{"code":"once"}', "s", undefined));
		fake.executions.clear();
		await expect(engine.awaitExecution(accepted.execution_id)).rejects.toThrow("unknown execution");
		expect(await engine.fsView("s").readTextFile("proof")).toBe("persisted");
		expect(fake.calls.filter((call) => call.path === "/api/exec")).toHaveLength(1);
	});

	it("does not retry authorization failures or probe while idle", async () => {
		const denied = vi.fn(async () => json({}, 401));
		await expect(McpJsHttpEngine.connect({ url: "http://engine", fetch: denied })).rejects.toThrow("401");
		expect(denied).toHaveBeenCalledTimes(1);
		const fake = server();
		await McpJsHttpEngine.connect({ url: "http://engine", fetch: fake.fetch });
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(fake.calls).toHaveLength(1);
	});
});
