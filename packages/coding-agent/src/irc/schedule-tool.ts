import type { Agent } from "@earendil-works/pi-agent-core";

const preparedSchemas = new WeakSet<object>();

/** pi-schedule-prompt 0.4.1 makes add fields optional and returns errors as successes. */
export function prepareScheduleTool(agent: Agent): void {
	for (const tool of agent.state.tools) {
		if (tool.name !== "schedule_prompt") continue;
		if (preparedSchemas.has(tool.parameters)) continue;
		tool.parameters = {
			...tool.parameters,
			allOf: [
				...(tool.parameters.allOf ?? []),
				{
					anyOf: [
						{ properties: { action: { const: "add" } }, required: ["action", "schedule", "prompt"] },
						{ properties: { action: { not: { const: "add" } } }, required: ["action"] },
					],
				},
			],
		};
		preparedSchemas.add(tool.parameters);
	}
}

export function installScheduleToolGuards(agent: Agent): void {
	const before = agent.beforeToolCall;
	const after = agent.afterToolCall;
	agent.beforeToolCall = async (context, signal) => {
		const previous = await before?.(context, signal);
		if (previous?.block) return previous;
		if (context.toolCall.name === "schedule_prompt") {
			const args = context.args as { action?: unknown; schedule?: unknown; prompt?: unknown };
			if (
				args?.action === "add" &&
				(typeof args.schedule !== "string" ||
					!args.schedule.trim() ||
					typeof args.prompt !== "string" ||
					!args.prompt.trim())
			) {
				return {
					block: true,
					reason:
						'schedule_prompt add requires non-empty schedule and prompt. Supply both, e.g. {"action":"add","schedule":"+10m","prompt":"Your requested reminder","type":"once"}. Do not retry unchanged arguments.',
				};
			}
		}
		return previous;
	};
	agent.afterToolCall = async (context, signal) => {
		const previous = await after?.(context, signal);
		const details = (previous?.details ?? context.result.details) as { error?: unknown } | undefined;
		if (context.toolCall.name === "schedule_prompt" && typeof details?.error === "string" && details.error) {
			return { ...previous, isError: true };
		}
		return previous;
	};
}
