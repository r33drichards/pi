import type { ExecutionEnv, FileSystem, JavaScriptRuntime } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { createSessionWorkerTools } from "../src/experimental/session-worker.ts";

function shellEnv(): FileSystem & ExecutionEnv {
	return { cwd: "/work", exec: async () => ({ ok: true }) } as unknown as FileSystem & ExecutionEnv;
}

function javaScriptEnv(): FileSystem & JavaScriptRuntime {
	return { cwd: "/work", runJavaScript: async () => ({ output: "" }) } as unknown as FileSystem & JavaScriptRuntime;
}

describe("session worker tool selection", () => {
	it("offers bash alongside the file tools when the environment has a shell", () => {
		expect(createSessionWorkerTools(shellEnv()).map((tool) => tool.name)).toEqual(["read", "write", "bash"]);
	});

	it("offers run_js instead of bash for a JavaScript-only environment", () => {
		expect(createSessionWorkerTools(javaScriptEnv()).map((tool) => tool.name)).toEqual(["read", "write", "run_js"]);
	});
});
