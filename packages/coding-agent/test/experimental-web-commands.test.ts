import { describe, expect, it } from "vitest";
import { completeCommand, parseComposerInput } from "../src/experimental/web/app/commands.ts";

describe("web composer slash commands", () => {
	it("passes ordinary text through as a prompt", () => {
		expect(parseComposerInput("hello there")).toEqual({ kind: "prompt", text: "hello there" });
		expect(parseComposerInput("  spaced  ")).toEqual({ kind: "prompt", text: "spaced" });
		// A leading slash that is not a known command is still a prompt, e.g. a path.
		expect(parseComposerInput("/etc/hosts is a file")).toEqual({ kind: "prompt", text: "/etc/hosts is a file" });
	});

	it("parses the four built-in commands", () => {
		expect(parseComposerInput("/model")).toEqual({ kind: "model", query: "" });
		expect(parseComposerInput("/model gpt-5.4")).toEqual({ kind: "model", query: "gpt-5.4" });
		expect(parseComposerInput("/thinking high")).toEqual({ kind: "thinking", level: "high" });
		expect(parseComposerInput("/thinking")).toEqual({ kind: "thinking", level: undefined });
		expect(parseComposerInput("/compact")).toEqual({ kind: "compact", instructions: null });
		expect(parseComposerInput("/compact keep the file list")).toEqual({
			kind: "compact",
			instructions: "keep the file list",
		});
		expect(parseComposerInput("/reload")).toEqual({ kind: "reload" });
	});

	it("rejects unknown thinking levels", () => {
		expect(parseComposerInput("/thinking loud")).toEqual({
			kind: "error",
			message: 'Unknown thinking level "loud"; expected one of off, minimal, low, medium, high, xhigh, max',
		});
	});

	it("completes command names while typing", () => {
		expect(completeCommand("/")).toEqual(["/model", "/thinking", "/compact", "/reload"]);
		expect(completeCommand("/mo")).toEqual(["/model"]);
		expect(completeCommand("/model ")).toEqual([]);
		expect(completeCommand("plain")).toEqual([]);
	});
});
