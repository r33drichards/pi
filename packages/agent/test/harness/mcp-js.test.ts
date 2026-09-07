import { posix } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT, withAbortSignal } from "../../src/harness/context.ts";
import {
	MCP_JS_LINE_READ_CHUNK_BYTES,
	McpJsExecutionEnv,
	type McpJsNativeEngine,
	type McpJsNativeMetadata,
	nativeFileErrorCode,
} from "../../src/harness/env/mcp-js.ts";
import { createRunJsTool } from "../../src/harness/tools/run-js.ts";

const MODE_DIRECTORY = 0o040755;
const MODE_FILE = 0o100644;

/** In-memory stand-in for the generated Engine: same method shapes, same error messages. */
class FakeEngine implements McpJsNativeEngine {
	files = new Map<string, Uint8Array>();
	dirs = new Set<string>(["/", "/work"]);
	denied = new Set<string>();
	rangeCalls: Array<{ offset: bigint; maxBytes: bigint }> = [];
	closeCalls = 0;
	destroyCalls = 0;
	filesystem = true;
	callToolAsync = vi.fn(async (_name: string, _arguments: string, _session: undefined, _headers: undefined) =>
		JSON.stringify({ output: "42" }),
	);

	private gate(op: string, path: string): void {
		if (this.denied.has(path)) throw new Error(`fs.${op} denied by policy: ${path} is not allowed`);
	}
	private mustFile(op: string, path: string): Uint8Array {
		this.gate(op, path);
		const file = this.files.get(path);
		if (file === undefined) {
			if (this.dirs.has(path)) throw new Error(`fs.${op}: ${path}: EISDIR: is a directory`);
			throw new Error(`fs.${op}: ${path}: ENOENT: No such file or directory`);
		}
		return file;
	}
	hostFilesystemEnabled(): boolean {
		return this.filesystem;
	}
	async fsReadFile(path: string): Promise<ArrayBuffer> {
		return this.mustFile("readFile", path).slice().buffer as ArrayBuffer;
	}
	async fsReadFileRange(path: string, offset: bigint, maxBytes: bigint): Promise<ArrayBuffer> {
		this.rangeCalls.push({ offset, maxBytes });
		const file = this.mustFile("readFile", path);
		return file.slice(Number(offset), Number(offset) + Number(maxBytes)).buffer as ArrayBuffer;
	}
	async fsReadTextFile(path: string): Promise<string> {
		const file = this.mustFile("readFile", path);
		try {
			return new TextDecoder("utf-8", { fatal: true }).decode(file);
		} catch {
			throw new Error(`fs.readFile: invalid UTF-8 in ${path}: invalid utf-8 sequence`);
		}
	}
	async fsWriteFile(path: string, data: ArrayBuffer): Promise<void> {
		this.gate("writeFile", path);
		if (!this.dirs.has(posix.dirname(path)))
			throw new Error(`fs.writeFile: ${path}: ENOENT: No such file or directory`);
		this.files.set(path, new Uint8Array(data));
	}
	async fsAppendFile(path: string, data: ArrayBuffer): Promise<void> {
		this.gate("appendFile", path);
		const existing = this.files.get(path) ?? new Uint8Array();
		this.files.set(path, new Uint8Array([...existing, ...new Uint8Array(data)]));
	}
	async fsStat(path: string): Promise<McpJsNativeMetadata> {
		return this.fsLstat(path);
	}
	async fsLstat(path: string): Promise<McpJsNativeMetadata> {
		this.gate("lstat", path);
		if (this.dirs.has(path)) return { mode: MODE_DIRECTORY, size: 0n, readonly: false, modifiedMs: 5 };
		const file = this.files.get(path);
		if (file === undefined) throw new Error(`fs.lstat: ${path}: ENOENT: No such file or directory`);
		return { mode: MODE_FILE, size: BigInt(file.byteLength), readonly: false, modifiedMs: 7 };
	}
	async fsReadDir(path: string): Promise<string[]> {
		this.gate("readdir", path);
		if (!this.dirs.has(path)) throw new Error(`fs.readdir: ${path}: ENOENT: No such file or directory`);
		const children = [...this.dirs, ...this.files.keys()].filter(
			(entry) => posix.dirname(entry) === path && entry !== path,
		);
		return children.map((entry) => posix.basename(entry));
	}
	async fsCanonicalPath(path: string): Promise<string> {
		this.mustFile("stat", path);
		return path;
	}
	async fsMakeDir(path: string, recursive: boolean): Promise<void> {
		this.gate("mkdir", path);
		if (this.dirs.has(path)) {
			if (recursive) return;
			throw new Error(`fs.mkdir: ${path}: EEXIST: File exists`);
		}
		if (!recursive && !this.dirs.has(posix.dirname(path)))
			throw new Error(`fs.mkdir: ${path}: ENOENT: No such file or directory`);
		for (let dir = path; !this.dirs.has(dir); dir = posix.dirname(dir)) this.dirs.add(dir);
	}
	async fsRemove(path: string, _recursive: boolean): Promise<void> {
		this.gate("rm", path);
		if (!this.files.delete(path) && !this.dirs.delete(path))
			throw new Error(`fs.rm: ${path}: ENOENT: No such file or directory`);
	}
	async fsRename(from: string, to: string): Promise<void> {
		const file = this.mustFile("rename", from);
		this.files.delete(from);
		this.files.set(to, file);
	}
	async fsExists(path: string): Promise<boolean> {
		this.gate("exists", path);
		return this.files.has(path) || this.dirs.has(path);
	}
	close(): void {
		this.closeCalls++;
	}
	uniffiDestroy(): void {
		this.destroyCalls++;
	}
}

function fixture() {
	const engine = new FakeEngine();
	return { engine, env: new McpJsExecutionEnv(engine, "/work") };
}

const text = (value: string) => new TextEncoder().encode(value);

describe("native mcp-js adapter boundary (not a native engine test)", () => {
	it("requires an engine with a filesystem configuration", () => {
		const engine = new FakeEngine();
		engine.filesystem = false;
		expect(() => new McpJsExecutionEnv(engine, "/work")).toThrow("createWithFilesystem");
		expect(() => new McpJsExecutionEnv(new FakeEngine(), "relative")).toThrow("absolute");
	});

	it("dispatches JavaScript without a shell", async () => {
		const { engine, env } = fixture();
		expect(await env.runJavaScript("console.log(42)", 2, BACKGROUND_CONTEXT)).toEqual({
			output: "42",
			error: undefined,
		});
		expect(engine.callToolAsync).toHaveBeenCalledWith(
			"run_js",
			JSON.stringify({ code: "console.log(42)", execution_timeout_secs: 2 }),
			undefined,
			undefined,
		);
		expect(createRunJsTool().name).toBe("run_js");
	});

	it("moves file bytes through typed native calls, never through JavaScript", async () => {
		const { engine, env } = fixture();
		const bytes = new Uint8Array([0, 255, 10, 128]);
		expect(await env.writeFile("nested/data.bin", bytes, BACKGROUND_CONTEXT)).toEqual({ ok: true, value: undefined });
		expect(engine.dirs.has("/work/nested")).toBe(true);
		expect(engine.files.get("/work/nested/data.bin")).toEqual(bytes);
		expect(await env.readBinaryFile("nested/data.bin", BACKGROUND_CONTEXT)).toEqual({ ok: true, value: bytes });
		expect(await env.appendFile("nested/data.bin", new Uint8Array([1]), BACKGROUND_CONTEXT)).toEqual({
			ok: true,
			value: undefined,
		});
		expect(engine.files.get("/work/nested/data.bin")).toEqual(new Uint8Array([0, 255, 10, 128, 1]));
		expect(await env.writeFile("/work/notes.txt", "héllo", BACKGROUND_CONTEXT)).toEqual({
			ok: true,
			value: undefined,
		});
		expect(await env.readTextFile("notes.txt", BACKGROUND_CONTEXT)).toEqual({ ok: true, value: "héllo" });
		expect(engine.callToolAsync).not.toHaveBeenCalled();
	});

	it("reads lines through bounded range reads and stops at maxLines", async () => {
		const { engine, env } = fixture();
		engine.files.set("/work/big.txt", text(`first\r\n${"x".repeat(MCP_JS_LINE_READ_CHUNK_BYTES * 3)}\nlast\n`));
		expect(await env.readTextLines("big.txt", { maxLines: 1 }, BACKGROUND_CONTEXT)).toEqual({
			ok: true,
			value: ["first"],
		});
		expect(engine.rangeCalls).toHaveLength(1);
		expect(engine.rangeCalls[0]).toEqual({ offset: 0n, maxBytes: BigInt(MCP_JS_LINE_READ_CHUNK_BYTES) });

		engine.rangeCalls = [];
		const all = await env.readTextLines("big.txt", undefined, BACKGROUND_CONTEXT);
		expect(all.ok && all.value.length).toBe(3);
		expect(all.ok && all.value[2]).toBe("last");
		expect(engine.rangeCalls.length).toBeGreaterThan(3);
		expect(await env.readTextLines("big.txt", { maxLines: 0 }, BACKGROUND_CONTEXT)).toEqual({ ok: true, value: [] });
	});

	it("decodes multi-byte characters split across range boundaries", async () => {
		const { engine, env } = fixture();
		const line = `${"a".repeat(MCP_JS_LINE_READ_CHUNK_BYTES - 1)}é`;
		engine.files.set("/work/split.txt", text(`${line}\nz`));
		const result = await env.readTextLines("split.txt", undefined, BACKGROUND_CONTEXT);
		expect(result).toEqual({ ok: true, value: [line, "z"] });
		expect(engine.rangeCalls.length).toBe(2);
	});

	it("reports invalid UTF-8 as an invalid file", async () => {
		const { engine, env } = fixture();
		engine.files.set("/work/bad.txt", new Uint8Array([0xff, 0xfe, 0x0a]));
		const lines = await env.readTextLines("bad.txt", undefined, BACKGROUND_CONTEXT);
		expect(!lines.ok && lines.error.code).toBe("invalid");
		const whole = await env.readTextFile("bad.txt", BACKGROUND_CONTEXT);
		expect(!whole.ok && whole.error.code).toBe("invalid");
	});

	it("preserves policy denial instead of falling back to host fs", async () => {
		const { engine, env } = fixture();
		engine.denied.add("/work/secret");
		const result = await env.exists("secret", BACKGROUND_CONTEXT);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("permission_denied");
			expect(result.error.path).toBe("/work/secret");
			expect(result.error.message).toContain("denied by policy");
		}
	});

	it("maps native messages to backend-independent codes", () => {
		expect(nativeFileErrorCode(new Error("fs.readFile: /x: ENOENT: No such file"))).toBe("not_found");
		expect(nativeFileErrorCode(new Error("fs.readFile denied by pre hook (quota): /x is not allowed"))).toBe(
			"permission_denied",
		);
		expect(nativeFileErrorCode({ inner: { message: "fs.readdir: /x: ENOTDIR: Not a directory" } })).toBe(
			"not_directory",
		);
		expect(nativeFileErrorCode(new Error("fs.readFile: /x: EISDIR: Is a directory"))).toBe("is_directory");
		expect(nativeFileErrorCode(new Error("fs.readFile: invalid UTF-8 in /x: bad"))).toBe("invalid");
		expect(nativeFileErrorCode(new Error("filesystem access is not configured"))).toBe("not_supported");
		expect(nativeFileErrorCode(new Error("fs.rm: /home/ENOENTish: boom"))).toBe("unknown");
	});

	it("derives entry kinds from mode bits and lists directories", async () => {
		const { engine, env } = fixture();
		engine.files.set("/work/a.txt", text("abc"));
		engine.dirs.add("/work/sub");
		expect(await env.fileInfo("a.txt", BACKGROUND_CONTEXT)).toEqual({
			ok: true,
			value: { name: "a.txt", path: "/work/a.txt", kind: "file", size: 3, mtimeMs: 7 },
		});
		const listing = await env.listDir(".", BACKGROUND_CONTEXT);
		expect(listing.ok && listing.value.map((entry) => `${entry.kind}:${entry.name}`).sort()).toEqual([
			"directory:sub",
			"file:a.txt",
		]);
		expect(await env.canonicalPath("a.txt", BACKGROUND_CONTEXT)).toEqual({ ok: true, value: "/work/a.txt" });
		expect(await env.renameFile("a.txt", "b.txt", BACKGROUND_CONTEXT)).toEqual({ ok: true, value: undefined });
		expect(await env.exists("a.txt", BACKGROUND_CONTEXT)).toEqual({ ok: true, value: false });
		const missing = await env.remove("a.txt", undefined, BACKGROUND_CONTEXT);
		expect(!missing.ok && missing.error.code).toBe("not_found");
		expect(await env.remove("a.txt", { force: true }, BACKGROUND_CONTEXT)).toEqual({ ok: true, value: undefined });
		expect(await env.remove("b.txt", undefined, BACKGROUND_CONTEXT)).toEqual({ ok: true, value: undefined });
	});

	it("creates temporary directories exclusively with a non-recursive mkdir", async () => {
		const { engine, env } = fixture();
		const spy = vi.spyOn(engine, "fsMakeDir");
		const result = await env.createTempDir("scratch-", BACKGROUND_CONTEXT);
		expect(result.ok && result.value.startsWith("/work/scratch-")).toBe(true);
		expect(spy).toHaveBeenCalledWith(expect.stringMatching(/^\/work\/scratch-/), false);
		const file = await env.createTempFile(undefined, BACKGROUND_CONTEXT);
		expect(!file.ok && file.error.code).toBe("not_supported");
	});

	it("rejects invalid deadlines before dispatch", async () => {
		const { env, engine } = fixture();
		await expect(env.runJavaScript("1", 0, BACKGROUND_CONTEXT)).rejects.toThrow("timeout");
		expect(engine.callToolAsync).not.toHaveBeenCalled();
	});

	it("does not dispatch cancelled work", async () => {
		const { env, engine } = fixture();
		const cancelled = withAbortSignal(AbortSignal.abort(), BACKGROUND_CONTEXT);
		await expect(env.runJavaScript("1", undefined, cancelled)).rejects.toThrow("aborted");
		expect(engine.callToolAsync).not.toHaveBeenCalled();
		const spy = vi.spyOn(engine, "fsReadTextFile");
		const read = await env.readTextFile("x", cancelled);
		expect(!read.ok && read.error.code).toBe("aborted");
		expect(spy).not.toHaveBeenCalled();
	});

	it("releases the native engine only once, after in-flight work settles", async () => {
		const { env, engine } = fixture();
		let release: (() => void) | undefined;
		engine.fsExists = () =>
			new Promise((resolve) => {
				release = () => resolve(true);
			});
		const pending = env.exists("x", BACKGROUND_CONTEXT);
		const cleanup = env.cleanup(BACKGROUND_CONTEXT);
		await Promise.resolve();
		expect(engine.closeCalls).toBe(0);
		release?.();
		await cleanup;
		expect(await pending).toEqual({ ok: true, value: true });
		await env.cleanup(BACKGROUND_CONTEXT);
		expect(engine.closeCalls).toBe(1);
		expect(engine.destroyCalls).toBe(1);
		await expect(env.runJavaScript("1", undefined, BACKGROUND_CONTEXT)).rejects.toThrow("closed");
		const closed = await env.exists("x", BACKGROUND_CONTEXT);
		expect(!closed.ok && closed.error.code).toBe("not_supported");
	});
});
