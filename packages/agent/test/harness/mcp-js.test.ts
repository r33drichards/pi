import { describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT, withAbortSignal } from "../../src/harness/context.ts";
import { McpJsExecutionEnv } from "../../src/harness/env/mcp-js.ts";
import { createRunJsTool } from "../../src/harness/tools/run-js.ts";

function fixture(response = JSON.stringify({ output: "42" })) {
	const engine = {
		callToolAsync: vi.fn(
			async (_name: string, _arguments: string, _session: undefined, _headers: undefined) => response,
		),
		close: vi.fn(),
		uniffiDestroy: vi.fn(),
	};
	return { engine, env: new McpJsExecutionEnv(engine, "/work") };
}

describe("native mcp-js adapter boundary (not a native engine test)", () => {
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
	it("routes binary reads through guest fs", async () => {
		const { env, engine } = fixture(JSON.stringify({ output: "[0,255,10]" }));
		expect(await env.readBinaryFile("data", BACKGROUND_CONTEXT)).toEqual({
			ok: true,
			value: new Uint8Array([0, 255, 10]),
		});
		expect(engine.callToolAsync.mock.calls[0]?.[1]).toContain("fs.readFile");
	});
	it("preserves policy denial instead of falling back to host fs", async () => {
		const { env } = fixture(JSON.stringify({ error: "fs.lstat denied by policy" }));
		const result = await env.exists("secret", BACKGROUND_CONTEXT);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("permission_denied");
	});
	it("rejects invalid deadlines before dispatch", async () => {
		const { env, engine } = fixture();
		await expect(env.runJavaScript("1", 0, BACKGROUND_CONTEXT)).rejects.toThrow("timeout");
		expect(engine.callToolAsync).not.toHaveBeenCalled();
	});
	it("does not dispatch cancelled work", async () => {
		const { env, engine } = fixture();
		await expect(
			env.runJavaScript("1", undefined, withAbortSignal(AbortSignal.abort(), BACKGROUND_CONTEXT)),
		).rejects.toThrow("aborted");
		expect(engine.callToolAsync).not.toHaveBeenCalled();
	});
	it("releases the native engine only once", async () => {
		const { env, engine } = fixture();
		await env.cleanup(BACKGROUND_CONTEXT);
		await env.cleanup(BACKGROUND_CONTEXT);
		expect(engine.close).toHaveBeenCalledTimes(1);
		expect(engine.uniffiDestroy).toHaveBeenCalledTimes(1);
		await expect(env.runJavaScript("1", undefined, BACKGROUND_CONTEXT)).rejects.toThrow("closed");
	});
});
