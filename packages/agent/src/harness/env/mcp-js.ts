import { posix } from "node:path";
import type { Context } from "../context.ts";
import { err, FileError, type FileErrorCode, type FileInfo, type FileSystem, ok, type Result } from "../types.ts";
import type { JavaScriptResult, JavaScriptRuntime } from "./javascript.ts";

/** Metadata record returned by the native stat calls (UniFFI `FsMetadata`). */
export interface McpJsNativeMetadata {
	/** Unix mode bits, type bits included; synthesized on other platforms. */
	mode: number;
	size: bigint | number;
	readonly: boolean;
	modifiedMs?: number;
}

/**
 * Structural boundary for the generated native UniFFI Engine created with
 * `createWithFilesystem`: `run_js` through the tool API, files through the typed
 * `fs*` methods. No HTTP or subprocess transport, no generated JavaScript for
 * file access. Bytes cross as ArrayBuffers; failures reject with the same message
 * the guest `fs.*` wrapper reports, including its Node-style code token.
 */
export interface McpJsNativeEngine {
	callToolAsync(name: string, argumentsJson: string, sessionId: undefined, headers: undefined): Promise<string>;
	hostFilesystemEnabled(): boolean;
	fsReadFile(path: string): Promise<ArrayBuffer>;
	fsReadFileRange(path: string, offset: bigint, maxBytes: bigint): Promise<ArrayBuffer>;
	fsReadTextFile(path: string): Promise<string>;
	fsWriteFile(path: string, data: ArrayBuffer): Promise<void>;
	fsAppendFile(path: string, data: ArrayBuffer): Promise<void>;
	fsStat(path: string): Promise<McpJsNativeMetadata>;
	fsLstat(path: string): Promise<McpJsNativeMetadata>;
	fsReadDir(path: string): Promise<string[]>;
	fsCanonicalPath(path: string): Promise<string>;
	fsMakeDir(path: string, recursive: boolean): Promise<void>;
	fsRemove(path: string, recursive: boolean): Promise<void>;
	fsRename(from: string, to: string): Promise<void>;
	fsExists(path: string): Promise<boolean>;
	close(): unknown;
	uniffiDestroy?(): void;
}

const MODE_TYPE_MASK = 0o170000;
const MODE_DIRECTORY = 0o040000;
const MODE_SYMLINK = 0o120000;
const MODE_FILE = 0o100000;

/** Bytes requested per native call while scanning a text file line by line. */
export const MCP_JS_LINE_READ_CHUNK_BYTES = 64 * 1024;

/**
 * Map a native failure to a backend-independent code. The native error message is
 * the guest wrapper's message, so the Node-style code tokens are the contract; the
 * generated binding's error shape (class fields versus `inner`) is not.
 */
export function nativeFileErrorCode(error: unknown): FileErrorCode {
	let text = String(error);
	try {
		text += ` ${JSON.stringify(error)}`;
	} catch {
		/* Unserializable errors still carry their message. */
	}
	if (/\bENOENT\b/.test(text)) return "not_found";
	if (/ denied by |\bEACCES\b|\bEPERM\b/.test(text)) return "permission_denied";
	if (/\bENOTDIR\b/.test(text)) return "not_directory";
	if (/\bEISDIR\b/.test(text)) return "is_directory";
	if (/invalid UTF-8|\bEINVAL\b/.test(text)) return "invalid";
	if (/\bENOSYS\b|not supported|not configured/.test(text)) return "not_supported";
	return "unknown";
}

function toArrayBuffer(content: string | Uint8Array): ArrayBuffer {
	const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function nativeMessage(error: unknown): string {
	if (error instanceof Error && error.message) return error.message;
	const inner = (error as { inner?: { message?: unknown } } | null)?.inner;
	if (inner && typeof inner.message === "string") return inner.message;
	return String(error);
}

/**
 * Owns a native Engine created with createWithFilesystem. Do not share the Engine
 * with other callers. Guest heaps are stateless; hook-gated host files persist.
 * File operations are typed native calls that run through the engine's hook
 * chain; they never evaluate JavaScript or fall back to Node's filesystem.
 * Cancellation is checked before dispatch and after settlement, not mid-call;
 * native execution deadlines bound in-flight JavaScript, and cleanup waits for
 * all in-flight work to settle.
 */
export class McpJsExecutionEnv implements FileSystem, JavaScriptRuntime {
	readonly cwd: string;
	private readonly engine: McpJsNativeEngine;
	private pending: Promise<void> = Promise.resolve();
	private readonly inflight = new Set<Promise<unknown>>();
	private closed = false;

	constructor(engine: McpJsNativeEngine, cwd: string) {
		if (!posix.isAbsolute(cwd)) throw new Error("mcp-js cwd must be an absolute POSIX path");
		if (!engine.hostFilesystemEnabled()) {
			throw new Error("mcp-js engine has no filesystem configuration; create it with createWithFilesystem");
		}
		this.engine = engine;
		this.cwd = posix.normalize(cwd);
	}

	async runJavaScript(code: string, timeout: number | undefined, context: Context): Promise<JavaScriptResult> {
		if (timeout !== undefined && (!Number.isInteger(timeout) || timeout < 1 || timeout > 300)) {
			throw new Error("timeout must be an integer from 1 to 300 seconds");
		}
		if (this.closed) throw new Error("mcp-js environment is closed");
		const operation = this.pending.then(async () => {
			if (context.abortSignal?.aborted) throw new Error("Operation aborted");
			const raw: unknown = JSON.parse(
				await this.engine.callToolAsync(
					"run_js",
					JSON.stringify({ code, execution_timeout_secs: timeout }),
					undefined,
					undefined,
				),
			);
			if (context.abortSignal?.aborted) throw new Error("Operation aborted after native execution settled");
			if (!raw || typeof raw !== "object") throw new Error("Invalid native execution response");
			const result = raw as Record<string, unknown>;
			if (result.output !== undefined && typeof result.output !== "string") throw new Error("Invalid native output");
			if (result.error !== undefined && result.error !== null && typeof result.error !== "string")
				throw new Error("Invalid native error");
			return {
				output: typeof result.output === "string" ? result.output : "",
				error: typeof result.error === "string" ? result.error : undefined,
			};
		});
		this.pending = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}

	private path(path: string): string {
		return posix.resolve(this.cwd, path);
	}

	/** Run one native file operation with abort checks and error mapping. */
	private async file<T>(path: string, context: Context, operation: () => Promise<T>): Promise<Result<T, FileError>> {
		const absolute = this.path(path);
		if (this.closed) return err(new FileError("not_supported", "mcp-js environment is closed", absolute));
		if (context.abortSignal?.aborted) return err(new FileError("aborted", "Operation aborted", absolute));
		const call = operation();
		this.inflight.add(call);
		try {
			const value = await call;
			if (context.abortSignal?.aborted) return err(new FileError("aborted", "Operation aborted", absolute));
			return ok(value);
		} catch (cause) {
			if (cause instanceof FileError) return err(cause);
			const code = context.abortSignal?.aborted ? "aborted" : nativeFileErrorCode(cause);
			return err(
				new FileError(
					code,
					nativeMessage(cause),
					absolute,
					cause instanceof Error ? cause : new Error(String(cause)),
				),
			);
		} finally {
			this.inflight.delete(call);
		}
	}

	private async info(absolute: string): Promise<FileInfo> {
		const stat = await this.engine.fsLstat(absolute);
		const type = stat.mode & MODE_TYPE_MASK;
		const kind =
			type === MODE_SYMLINK
				? "symlink"
				: type === MODE_DIRECTORY
					? "directory"
					: type === MODE_FILE
						? "file"
						: undefined;
		if (kind === undefined) throw new FileError("not_supported", `Unsupported file type at ${absolute}`, absolute);
		return {
			name: posix.basename(absolute),
			path: absolute,
			kind,
			size: Number(stat.size),
			mtimeMs: stat.modifiedMs ?? 0,
		};
	}

	async absolutePath(path: string, context: Context): Promise<Result<string, FileError>> {
		return this.file(path, context, async () => this.path(path));
	}
	async joinPath(parts: string[], context: Context): Promise<Result<string, FileError>> {
		return this.file(this.cwd, context, async () => posix.join(...parts));
	}
	async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
		return this.file(path, context, () => this.engine.fsReadTextFile(this.path(path)));
	}
	/**
	 * Read lines through bounded native range reads, stopping once `maxLines` lines
	 * are complete, so a large file is never loaded whole. Line breaks are `\n` or
	 * `\r\n`; a trailing line break does not produce an empty final line.
	 */
	async readTextLines(
		path: string,
		options: { maxLines?: number } | undefined,
		context: Context,
	): Promise<Result<string[], FileError>> {
		const maxLines = options?.maxLines;
		if (maxLines !== undefined && maxLines <= 0) return ok([]);
		return this.file(path, context, async () => {
			const absolute = this.path(path);
			const decoder = new TextDecoder("utf-8", { fatal: true });
			const lines: string[] = [];
			let carry = "";
			let offset = 0n;
			for (;;) {
				if (context.abortSignal?.aborted) throw new FileError("aborted", "Operation aborted", absolute);
				const chunk = new Uint8Array(
					await this.engine.fsReadFileRange(absolute, offset, BigInt(MCP_JS_LINE_READ_CHUNK_BYTES)),
				);
				const atEnd = chunk.byteLength < MCP_JS_LINE_READ_CHUNK_BYTES;
				offset += BigInt(chunk.byteLength);
				try {
					carry += decoder.decode(chunk, { stream: !atEnd });
				} catch (cause) {
					throw new FileError(
						"invalid",
						`Invalid UTF-8 in ${absolute}`,
						absolute,
						cause instanceof Error ? cause : undefined,
					);
				}
				let newline = carry.indexOf("\n");
				while (newline !== -1) {
					lines.push(carry.slice(0, newline).replace(/\r$/, ""));
					carry = carry.slice(newline + 1);
					if (maxLines !== undefined && lines.length >= maxLines) return lines;
					newline = carry.indexOf("\n");
				}
				if (atEnd) break;
			}
			if (carry.length > 0) lines.push(carry);
			return lines;
		});
	}
	async readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
		return this.file(path, context, async () => new Uint8Array(await this.engine.fsReadFile(this.path(path))));
	}
	async writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		return this.file(path, context, async () => {
			const absolute = this.path(path);
			await this.engine.fsMakeDir(posix.dirname(absolute), true);
			await this.engine.fsWriteFile(absolute, toArrayBuffer(content));
		});
	}
	async appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		return this.file(path, context, async () => {
			const absolute = this.path(path);
			await this.engine.fsMakeDir(posix.dirname(absolute), true);
			await this.engine.fsAppendFile(absolute, toArrayBuffer(content));
		});
	}
	async renameFile(source: string, destination: string, context: Context): Promise<Result<void, FileError>> {
		return this.file(source, context, () => this.engine.fsRename(this.path(source), this.path(destination)));
	}
	async fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
		return this.file(path, context, () => this.info(this.path(path)));
	}
	async listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
		return this.file(path, context, async () => {
			const absolute = this.path(path);
			const names = await this.engine.fsReadDir(absolute);
			const files: FileInfo[] = [];
			for (const name of names) {
				if (context.abortSignal?.aborted) throw new FileError("aborted", "Operation aborted", absolute);
				files.push(await this.info(posix.join(absolute, name)));
			}
			return files;
		});
	}
	async canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
		return this.file(path, context, () => this.engine.fsCanonicalPath(this.path(path)));
	}
	async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
		return this.file(path, context, () => this.engine.fsExists(this.path(path)));
	}
	async createDir(
		path: string,
		options: { recursive?: boolean } | undefined,
		context: Context,
	): Promise<Result<void, FileError>> {
		return this.file(path, context, () => this.engine.fsMakeDir(this.path(path), options?.recursive ?? true));
	}
	async remove(
		path: string,
		options: { recursive?: boolean; force?: boolean } | undefined,
		context: Context,
	): Promise<Result<void, FileError>> {
		const result = await this.file(path, context, () =>
			this.engine.fsRemove(this.path(path), options?.recursive ?? false),
		);
		return !result.ok && options?.force && result.error.code === "not_found" ? ok(undefined) : result;
	}
	/**
	 * Create a fresh directory under `cwd` using a non-recursive native mkdir, which
	 * fails when the name already exists, so the directory is exclusively created.
	 */
	async createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
		return this.file(this.cwd, context, async () => {
			let lastError: unknown;
			for (let attempt = 0; attempt < 8; attempt++) {
				const candidate = posix.join(this.cwd, `${prefix ?? "tmp-"}${Math.random().toString(36).slice(2, 10)}`);
				try {
					await this.engine.fsMakeDir(candidate, false);
					return candidate;
				} catch (cause) {
					lastError = cause;
					if (!/\bEEXIST\b/.test(String(cause))) throw cause;
				}
			}
			throw lastError;
		});
	}
	async createTempFile(
		_options: { prefix?: string; suffix?: string } | undefined,
		_context: Context,
	): Promise<Result<string, FileError>> {
		return err(new FileError("not_supported", "Native fs has no exclusive file creation operation"));
	}
	async cleanup(_context: Context): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		await this.pending;
		await Promise.allSettled(this.inflight);
		try {
			this.engine.close();
		} catch {
			/* Best-effort native shutdown. */
		}
		try {
			this.engine.uniffiDestroy?.();
		} catch {
			/* Best-effort native handle release. */
		}
	}
}
