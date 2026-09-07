import { posix } from "node:path";
import type { Context } from "../context.ts";
import { err, FileError, type FileInfo, type FileSystem, ok, type Result, toError } from "../types.ts";
import type { JavaScriptResult, JavaScriptRuntime } from "./javascript.ts";

/** Structural boundary for the generated native UniFFI Engine; no HTTP or subprocess transport. */
export interface McpJsNativeEngine {
	callToolAsync(name: string, argumentsJson: string, sessionId: undefined, headers: undefined): Promise<string>;
	close(): unknown;
	uniffiDestroy(): void;
}

/**
 * Owns a native Engine created with createWithFilesystem. Do not share the Engine
 * with other callers. Guest heaps are stateless; policy-gated host files persist.
 * Cancellation is checked before dispatch and after settlement, not mid-execution.
 * Native execution deadlines bound in-flight work; cleanup waits for it to settle.
 */
export class McpJsExecutionEnv implements FileSystem, JavaScriptRuntime {
	readonly cwd: string;
	private readonly engine: McpJsNativeEngine;
	private pending: Promise<void> = Promise.resolve();
	private closed = false;

	constructor(engine: McpJsNativeEngine, cwd: string) {
		if (!posix.isAbsolute(cwd)) throw new Error("mcp-js cwd must be an absolute POSIX path");
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

	private async file<T>(path: string, context: Context, operation: () => Promise<T>): Promise<Result<T, FileError>> {
		try {
			if (context.abortSignal?.aborted) return err(new FileError("aborted", "Operation aborted", path));
			return ok(await operation());
		} catch (cause) {
			const error = toError(cause);
			const code = context.abortSignal?.aborted
				? "aborted"
				: /denied by policy|EACCES|EPERM/.test(error.message)
					? "permission_denied"
					: /ENOENT/.test(error.message)
						? "not_found"
						: /ENOTDIR/.test(error.message)
							? "not_directory"
							: /EISDIR/.test(error.message)
								? "is_directory"
								: "unknown";
			return err(new FileError(code, error.message, path, error));
		}
	}

	private async evaluate(expression: string, context: Context): Promise<unknown> {
		const result = await this.runJavaScript(
			`console.log(JSON.stringify(await (async () => { ${expression} })()));`,
			undefined,
			context,
		);
		if (result.error) throw new Error(result.error);
		return JSON.parse(result.output);
	}

	async absolutePath(path: string, context: Context): Promise<Result<string, FileError>> {
		return this.file(path, context, async () => this.path(path));
	}
	async joinPath(parts: string[], context: Context): Promise<Result<string, FileError>> {
		return this.file(this.cwd, context, async () => posix.join(...parts));
	}
	async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
		return this.file(path, context, async () => {
			const value = await this.evaluate(
				`return await fs.readFile(${JSON.stringify(this.path(path))}, "utf8");`,
				context,
			);
			if (typeof value !== "string") throw new Error("Invalid native text result");
			return value;
		});
	}
	async readTextLines(
		path: string,
		options: { maxLines?: number } | undefined,
		context: Context,
	): Promise<Result<string[], FileError>> {
		const result = await this.readTextFile(path, context);
		return result.ok ? ok(result.value.split("\n").slice(0, options?.maxLines)) : result;
	}
	async readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
		return this.file(path, context, async () => {
			const value = await this.evaluate(
				`return Array.from(await fs.readFile(${JSON.stringify(this.path(path))}));`,
				context,
			);
			if (
				!Array.isArray(value) ||
				!value.every(
					(byte: unknown) => typeof byte === "number" && Number.isInteger(byte) && byte >= 0 && byte <= 255,
				)
			)
				throw new Error("Invalid native binary result");
			return Uint8Array.from(value);
		});
	}
	async writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		return this.file(path, context, async () => {
			const absolute = this.path(path);
			const data =
				typeof content === "string"
					? JSON.stringify(content)
					: `new Uint8Array(${JSON.stringify(Array.from(content))})`;
			await this.evaluate(
				`await fs.mkdir(${JSON.stringify(posix.dirname(absolute))}, { recursive: true }); await fs.writeFile(${JSON.stringify(absolute)}, ${data}); return null;`,
				context,
			);
		});
	}
	async appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		if (typeof content !== "string")
			return err(new FileError("not_supported", "Native fs.appendFile does not support binary append", path));
		return this.file(path, context, async () => {
			const absolute = this.path(path);
			await this.evaluate(
				`await fs.mkdir(${JSON.stringify(posix.dirname(absolute))}, { recursive: true }); await fs.appendFile(${JSON.stringify(absolute)}, ${JSON.stringify(content)}); return null;`,
				context,
			);
		});
	}
	async renameFile(source: string, destination: string, context: Context): Promise<Result<void, FileError>> {
		return this.file(source, context, async () => {
			await this.evaluate(
				`await fs.rename(${JSON.stringify(this.path(source))}, ${JSON.stringify(this.path(destination))}); return null;`,
				context,
			);
		});
	}
	async fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
		return this.file(path, context, async () => {
			const absolute = this.path(path);
			const value = await this.evaluate(
				`const s = await fs.lstat(${JSON.stringify(absolute)}); return { kind: s.isSymbolicLink() ? "symlink" : s.isDirectory() ? "directory" : s.isFile() ? "file" : null, size: s.size, mtimeMs: s.mtimeMs };`,
				context,
			);
			if (!value || typeof value !== "object") throw new Error("Invalid native stat");
			const stat = value as Record<string, unknown>;
			if (
				(stat.kind !== "file" && stat.kind !== "directory" && stat.kind !== "symlink") ||
				typeof stat.size !== "number" ||
				typeof stat.mtimeMs !== "number"
			)
				throw new Error("Unsupported native stat");
			return {
				name: posix.basename(absolute),
				path: absolute,
				kind: stat.kind,
				size: stat.size,
				mtimeMs: stat.mtimeMs,
			};
		});
	}
	async listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
		return this.file(path, context, async () => {
			const names = await this.evaluate(`return await fs.readdir(${JSON.stringify(this.path(path))});`, context);
			if (!Array.isArray(names) || !names.every((name: unknown) => typeof name === "string"))
				throw new Error("Invalid native directory listing");
			const files: FileInfo[] = [];
			for (const name of names) {
				const info = await this.fileInfo(posix.join(this.path(path), name), context);
				if (!info.ok) throw info.error;
				files.push(info.value);
			}
			return files;
		});
	}
	async canonicalPath(path: string, _context: Context): Promise<Result<string, FileError>> {
		return err(new FileError("not_supported", "Native fs has no realpath operation", path));
	}
	async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
		const info = await this.fileInfo(path, context);
		if (info.ok) return ok(true);
		return info.error.code === "not_found" ? ok(false) : info;
	}
	async createDir(
		path: string,
		options: { recursive?: boolean } | undefined,
		context: Context,
	): Promise<Result<void, FileError>> {
		return this.file(path, context, async () => {
			await this.evaluate(
				`await fs.mkdir(${JSON.stringify(this.path(path))}, { recursive: ${options?.recursive ?? true} }); return null;`,
				context,
			);
		});
	}
	async remove(
		path: string,
		options: { recursive?: boolean; force?: boolean } | undefined,
		context: Context,
	): Promise<Result<void, FileError>> {
		const result = await this.file(path, context, async () => {
			await this.evaluate(
				`await fs.rm(${JSON.stringify(this.path(path))}, { recursive: ${options?.recursive ?? false} }); return null;`,
				context,
			);
		});
		return !result.ok && options?.force && result.error.code === "not_found" ? ok(undefined) : result;
	}
	async createTempDir(_prefix: string | undefined, _context: Context): Promise<Result<string, FileError>> {
		return err(new FileError("not_supported", "Native fs has no exclusive temporary directory operation"));
	}
	async createTempFile(
		_options: { prefix?: string; suffix?: string } | undefined,
		_context: Context,
	): Promise<Result<string, FileError>> {
		return err(new FileError("not_supported", "Native fs has no exclusive temporary file operation"));
	}
	async cleanup(_context: Context): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		await this.pending;
		try {
			this.engine.close();
		} catch {
			/* Best-effort native shutdown. */
		}
		try {
			this.engine.uniffiDestroy();
		} catch {
			/* Best-effort native handle release. */
		}
	}
}
