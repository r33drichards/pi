import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
	isMcpSkill,
	type JsonRpcRequest,
	LATEST_PROTOCOL_VERSION,
	MAX_SKILL_BYTES,
	McpClient,
	type McpSkill,
	MODERN_PROTOCOL_VERSION,
	SKILLS_EXTENSION,
	StreamableHttpTransport,
} from "../src/index.ts";
import { createInMemoryTransportPair } from "../src/testing/index.ts";

const text = "---\nname: workflow\ndescription: Test workflow\n---\n\nInstructions.\n";
const uri = "skill://team/workflow/SKILL.md";
const skill: McpSkill = {
	uri,
	frontmatter: { name: "workflow", description: "Test workflow" },
	resources: [
		{ uri, size: Buffer.byteLength(text), digest: `sha256:${createHash("sha256").update(text).digest("hex")}` },
	],
};
const clients: McpClient[] = [];
afterEach(async () => {
	await Promise.all(clients.splice(0).map((client) => client.close()));
});

async function server(
	options: {
		declared?: boolean;
		resources?: boolean;
		modern?: boolean;
		list?: (request: JsonRpcRequest) => unknown;
		get?: () => unknown;
	} = {},
) {
	const pair = createInMemoryTransportPair();
	const requests: JsonRpcRequest[] = [];
	pair.server.onMessage((message) => {
		if (!("id" in message) || !("method" in message)) return;
		requests.push(message);
		const capabilities = {
			...(options.resources === false ? {} : { resources: {} }),
			...(options.declared === false ? {} : { extensions: { [SKILLS_EXTENSION]: {} } }),
		};
		let result: unknown;
		switch (message.method) {
			case "initialize":
				result = {
					protocolVersion: LATEST_PROTOCOL_VERSION,
					capabilities,
					serverInfo: { name: "test", version: "1" },
				};
				break;
			case "server/discover":
				result = {
					resultType: "complete",
					supportedVersions: [MODERN_PROTOCOL_VERSION],
					capabilities,
					_meta: { "io.modelcontextprotocol/serverInfo": { name: "test", version: "1" } },
				};
				break;
			case "skills/list":
				result = options.list?.(message) ?? { skills: [skill] };
				break;
			case "skills/get":
				result = options.get?.() ?? { skill };
				break;
			case "resources/read":
				result = { contents: [{ uri, text }] };
				break;
			default:
				result = {};
		}
		if (options.modern && typeof result === "object" && result !== null)
			result = { resultType: "complete", ...result };
		void pair.server.send({ jsonrpc: "2.0", id: message.id, result });
	});
	await pair.server.start();
	const client = new McpClient({
		name: "pi",
		version: "1",
		protocolVersion: options.modern ? MODERN_PROTOCOL_VERSION : undefined,
		capabilities: { extensions: { [SKILLS_EXTENSION]: {} } },
	});
	clients.push(client);
	await client.connect(pair.client);
	return { client, requests };
}

describe("SEP-2640 client", () => {
	it("discovers manifests without reading any files, follows pagination, and gets unlisted URIs", async () => {
		const other = { ...skill, uri: "github://org/workflow/SKILL.md", resources: "dynamic" };
		const { client, requests } = await server({
			list: (request) =>
				(request.params as { cursor?: string })?.cursor
					? { skills: [other] }
					: { skills: [skill], nextCursor: "two" },
		});
		expect(await client.listSkills()).toEqual([skill, other]);
		expect(await client.listSkillsPage()).toEqual({ skills: [skill], nextCursor: "two" });
		expect(await client.getSkill(uri)).toEqual(skill);
		expect(requests.filter((request) => request.method === "resources/read")).toEqual([]);
	});

	it.each([{ declared: false }, { resources: false }])(
		"does not call extension methods without both declarations: %j",
		async (options) => {
			const { client, requests } = await server(options);
			expect(client.supportsSkills).toBe(false);
			await expect(client.listSkills()).rejects.toThrow("did not declare");
			await expect(client.getSkill(uri)).rejects.toThrow("did not declare");
			expect(requests.map((request) => request.method)).toEqual(["initialize"]);
		},
	);

	it("rejects repeated pagination cursors", async () => {
		const { client } = await server({ list: () => ({ skills: [skill], nextCursor: "again" }) });
		await expect(client.listSkills()).rejects.toThrow("duplicate cursor");
	});

	it("rejects missing manifests and mismatched get identities", async () => {
		const { client } = await server({
			list: () => ({ skills: [{ uri, frontmatter: skill.frontmatter }] }),
			get: () => ({ skill: { ...skill, uri: "skill://other/workflow/SKILL.md", resources: "dynamic" } }),
		});
		await expect(client.listSkills()).rejects.toThrow("Invalid entry");
		await expect(client.getSkill(uri)).rejects.toThrow("Invalid MCP skills/get");
	});

	it("uses modern discovery and required metadata on every request when selected", async () => {
		const { client, requests } = await server({ modern: true });
		await client.listSkills();
		await client.getSkill(uri);
		await client.readResource(uri);
		expect(requests.map((request) => request.method)).toEqual([
			"server/discover",
			"skills/list",
			"skills/get",
			"resources/read",
		]);
		for (const request of requests) {
			expect((request.params as { _meta: unknown })._meta).toMatchObject({
				"io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
				"io.modelcontextprotocol/clientCapabilities": { extensions: { [SKILLS_EXTENSION]: {} } },
			});
		}
	});

	it("carries modern HTTP metadata headers, encodes URI values, and preserves JSON-RPC errors", async () => {
		const seen: { method: string; name: string | null; version: string | null }[] = [];
		const transport = new StreamableHttpTransport({
			url: "http://test.invalid/mcp",
			fetch: async (_url, init) => {
				const request = JSON.parse(String(init?.body)) as JsonRpcRequest;
				const headers = new Headers(init?.headers);
				seen.push({
					method: headers.get("mcp-method") ?? "",
					name: headers.get("mcp-name"),
					version: headers.get("mcp-protocol-version"),
				});
				if (request.method === "server/discover")
					return Response.json({
						jsonrpc: "2.0",
						id: request.id,
						result: {
							resultType: "complete",
							supportedVersions: [MODERN_PROTOCOL_VERSION],
							capabilities: { resources: {}, extensions: { [SKILLS_EXTENSION]: {} } },
						},
					});
				return Response.json(
					{ jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "unknown URI" } },
					{ status: 400 },
				);
			},
		});
		const client = new McpClient({ name: "pi", version: "1", protocolVersion: MODERN_PROTOCOL_VERSION });
		clients.push(client);
		await client.connect(transport);
		await expect(client.readResource("docs://日本語")).rejects.toMatchObject({
			code: -32602,
			message: "unknown URI",
		});
		expect(seen).toEqual([
			{ method: "server/discover", name: null, version: MODERN_PROTOCOL_VERSION },
			{
				method: "resources/read",
				name: `=?base64?${Buffer.from("docs://日本語").toString("base64")}?=`,
				version: MODERN_PROTOCOL_VERSION,
			},
		]);
	});
});

describe("SEP-2640 manifests", () => {
	it.each([
		{ ...skill, resources: undefined },
		{ ...skill, resources: [] },
		{ ...skill, resources: [{ uri, digest: "sha256:no", size: 0 }] },
		{ ...skill, resources: [{ uri, digest: `sha256:${"0".repeat(64)}`, size: -1 }] },
		{ ...skill, resources: [...(skill.resources as []), ...(skill.resources as [])] },
		{
			...skill,
			resources: [{ uri: "skill://team/workflow/../secret", digest: `sha256:${"0".repeat(64)}`, size: 0 }],
		},
		{
			...skill,
			resources: [{ uri: "skill://team/workflow/%2e%2e/secret", digest: `sha256:${"0".repeat(64)}`, size: 0 }],
		},
		{ ...skill, frontmatter: { name: "different", description: "Mismatch" } },
	])("rejects malformed entries %#", (entry) => {
		expect(isMcpSkill(entry)).toBe(false);
	});

	it("accepts non-skill schemes and the full standard size and file-count limits", () => {
		expect(isMcpSkill({ ...skill, uri: "file:///team/workflow/SKILL.md", resources: "dynamic" })).toBe(true);
		const resources = Array.from({ length: 512 }, (_, index) => ({
			uri: index === 0 ? uri : `skill://team/workflow/files/${index}`,
			size: index === 0 ? MAX_SKILL_BYTES : 0,
			digest: `sha256:${"0".repeat(64)}`,
		}));
		expect(isMcpSkill({ ...skill, resources })).toBe(true);
		expect(
			isMcpSkill({ ...skill, resources: [...resources, { ...resources[0], uri: "skill://team/workflow/extra" }] }),
		).toBe(false);
		expect(isMcpSkill({ ...skill, resources: [{ ...resources[0], size: MAX_SKILL_BYTES + 1 }] })).toBe(false);
	});
});
