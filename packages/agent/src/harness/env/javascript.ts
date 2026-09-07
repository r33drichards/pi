import type { Context } from "../context.ts";
import type { FileSystem } from "../types.ts";

export interface JavaScriptResult {
	output: string;
	error?: string;
}

/** JavaScript execution, distinct from Shell.exec and its shell syntax. */
export interface JavaScriptRuntime {
	/** Await guest promises. Reject on host failure or cancellation; guest errors are returned with output. */
	runJavaScript(code: string, timeout: number | undefined, context: Context): Promise<JavaScriptResult>;
}

export interface JavaScriptToolContext {
	env: FileSystem & JavaScriptRuntime;
}
