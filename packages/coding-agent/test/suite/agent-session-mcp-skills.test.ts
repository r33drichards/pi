import { createHash } from "node:crypto";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { type JsonRpcRequest, LATEST_PROTOCOL_VERSION, type McpSkill, SKILLS_EXTENSION } from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpExtension } from "../../src/extensions/mcp/index.ts";
import { MCP_SKILLS_SECTION } from "../../src/extensions/mcp/skills.ts";
import { createHarness, createTestUiContext, getMessageText, getToolResult, type Harness } from "./harness.ts";

const uri = "skill://workflow/SKILL.md";
const skillText = "---\nname: workflow\ndescription: Test workflow\nallowed-tools: bash\n---\n\nUse the workflow.\n";
const guideUri = "skill://workflow/guide.md";
const guideText = "Use the reference.\n";
const skill: McpSkill = {
	uri,
	frontmatter: { name: "workflow", description: "Test workflow", "allowed-tools": "bash" },
	resources: [
		[uri, skillText],
		[guideUri, guideText],
	].map(([uri, text]) => ({
		uri,
		digest: `sha256:${createHash("sha256").update(text).digest("hex")}`,
		size: Buffer.byteLength(text),
	})),
};

const harnesses: Harness[] = [];
afterEach(() => {
	while (harnesses.length) harnesses.pop()?.cleanup();
});

async function setup(approve = true) {
	const requests: string[] = [];
	const confirm = vi.fn(async () => approve);
	const harness = await createHarness({
		initialActiveToolNames: [],
		extensionFactories: [
			createMcpExtension({
				loadConfig: () => ({
					servers: [{ name: "catalog", config: { command: "unused", exposure: "direct" }, source: "test" }],
					errors: [],
				}),
				createTransport: () => {
					const pair = createInMemoryTransportPair();
					pair.server.onMessage((message) => {
						if (!("id" in message) || !("method" in message)) return;
						const request = message as JsonRpcRequest;
						requests.push(request.method);
						let result: unknown;
						switch (request.method) {
							case "initialize":
								result = {
									protocolVersion: LATEST_PROTOCOL_VERSION,
									capabilities: { resources: {}, extensions: { [SKILLS_EXTENSION]: {} } },
									serverInfo: { name: "self-reported-name", version: "1" },
								};
								break;
							case "resources/list":
								result = { resources: [] };
								break;
							case "resources/templates/list":
								result = { resourceTemplates: [] };
								break;
							case "skills/list":
								result = { skills: [skill] };
								break;
							case "skills/get":
								result = { skill };
								break;
							case "resources/read": {
								const fileUri = (request.params as { uri: string }).uri;
								result = { contents: [{ uri: fileUri, text: fileUri === uri ? skillText : guideText }] };
								break;
							}
							default:
								throw new Error(`Unexpected method ${request.method}`);
						}
						void pair.server.send({ jsonrpc: "2.0", id: request.id, result });
					});
					void pair.server.start();
					return pair.client;
				},
			}),
		],
	});
	harnesses.push(harness);
	await harness.session.bindExtensions({ uiContext: createTestUiContext({ confirm }) });
	await vi.waitFor(() => expect(harness.session.getActiveToolNames()).toContain("load_mcp_skill"));
	return { harness, requests, confirm };
}

describe("Native Pi MCP skills", () => {
	it("publishes a catalog in the prompt and lazily loads verified, origin-tagged instructions", async () => {
		const { harness, requests, confirm } = await setup();
		expect(requests).not.toContain("resources/read");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("load_mcp_skill", { server: "catalog", uri })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("read_mcp_skill_file", { server: "catalog", uri, path: "guide.md" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("Use the workflow skill");
		expect(confirm).toHaveBeenCalledTimes(1);
		const loaded = getToolResult(harness, "load_mcp_skill");
		expect(loaded.isError).toBe(false);
		expect(getMessageText(loaded)).toContain('configured server "catalog"');
		expect(getMessageText(loaded)).toContain(skillText);
		expect(getMessageText(getToolResult(harness, "read_mcp_skill_file"))).toContain("Use the reference.");
		expect(
			harness.session.messages.some(
				(message) =>
					message.role === "system" && message.sections?.[MCP_SKILLS_SECTION]?.includes('"server":"catalog"'),
			),
		).toBe(true);
		expect(harness.session.getActiveToolNames()).not.toContain("bash");
		expect(requests.filter((method) => method === "resources/read")).toHaveLength(2);
	});

	it("denies activation without approval and leaves ordinary resource reads as data", async () => {
		const { harness, requests } = await setup(false);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("load_mcp_skill", { server: "catalog", uri })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("read_mcp_resource", { server: "catalog", uri })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("Inspect the skill");
		expect(getToolResult(harness, "load_mcp_skill").isError).toBe(true);
		expect(getToolResult(harness, "read_mcp_resource").isError).toBe(false);
		expect(requests.filter((method) => method === "resources/read")).toHaveLength(1);
		expect(
			harness.sessionManager
				.getBranch()
				.some((entry) => entry.type === "custom" && entry.customType === "mcp_skill_loaded"),
		).toBe(false);
	});
});
