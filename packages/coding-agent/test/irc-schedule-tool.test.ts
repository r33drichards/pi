import { type AfterToolCallContext, Agent, type BeforeToolCallContext } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import { installScheduleToolGuards, prepareScheduleTool } from "../src/irc/schedule-tool.ts";

function fixture() {
	const agent = new Agent({
		streamFn: () => {
			throw new Error("No inference in this test");
		},
	});
	const execute = vi.fn(async () => ({
		content: [{ type: "text" as const, text: "Error: missing parameters" }],
		details: { error: "Missing required parameters for add action: schedule and prompt" },
	}));
	agent.state.tools = [
		{
			name: "schedule_prompt",
			label: "Schedule",
			description: "Schedule a prompt",
			parameters: Type.Object({
				action: Type.String(),
				schedule: Type.Optional(Type.String()),
				prompt: Type.Optional(Type.String()),
			}),
			execute,
		},
	];
	return { agent, execute };
}

describe("IRC schedule_prompt adapter", () => {
	it("reproduces the published tool's permissive schema and success-shaped validation error", async () => {
		const { agent, execute } = fixture();
		expect(Value.Check(agent.state.tools[0]!.parameters, { action: "add" })).toBe(true);
		const result = await execute();
		expect(result.details.error).toContain("Missing required parameters");
		expect(result).not.toHaveProperty("isError");
	});

	it("requires schedule and prompt for add without breaking list or a valid add", () => {
		const { agent } = fixture();
		prepareScheduleTool(agent);
		const schema = agent.state.tools[0]!.parameters;
		expect(Value.Check(schema, { action: "add" })).toBe(false);
		expect(Value.Check(schema, { action: "list" })).toBe(true);
		expect(Value.Check(schema, { action: "add", schedule: "+10m", prompt: "remind me" })).toBe(true);
		prepareScheduleTool(agent);
		expect(agent.state.tools[0]!.parameters).toEqual(schema);
	});

	it("rejects blank add fields and marks returned scheduler errors as errors", async () => {
		const { agent, execute } = fixture();
		const before = vi.fn(async () => undefined);
		const after = vi.fn(async () => undefined);
		agent.beforeToolCall = before;
		agent.afterToolCall = after;
		installScheduleToolGuards(agent);
		const base = {
			toolCall: { name: "schedule_prompt", id: "call", type: "toolCall" },
			args: { action: "add", schedule: " ", prompt: "" },
		};
		expect(await agent.beforeToolCall?.(base as BeforeToolCallContext)).toMatchObject({ block: true });
		expect(
			await agent.beforeToolCall?.({
				...base,
				args: { action: "add", schedule: "+10m", prompt: "remind me" },
			} as BeforeToolCallContext),
		).toBeUndefined();
		expect(before).toHaveBeenCalledTimes(2);
		const result = await execute();
		expect(await agent.afterToolCall?.({ ...base, result, isError: false } as AfterToolCallContext)).toMatchObject({
			isError: true,
		});
		expect(after).toHaveBeenCalledOnce();
		expect(
			await agent.afterToolCall?.({
				...base,
				toolCall: { ...base.toolCall, name: "other" },
				result,
				isError: false,
			} as AfterToolCallContext),
		).toBeUndefined();
	});

	it("preserves existing schema constraints and non-add actions", () => {
		const { agent } = fixture();
		const tool = agent.state.tools[0]!;
		tool.parameters = { ...tool.parameters, anyOf: [{ required: ["prompt"] }] };
		prepareScheduleTool(agent);
		expect(Value.Check(tool.parameters, { action: "list" })).toBe(false);
		expect(Value.Check(tool.parameters, { action: "future-action", prompt: "present" })).toBe(true);
		expect(Value.Check(tool.parameters, { action: "add", prompt: "present" })).toBe(false);
	});
});
