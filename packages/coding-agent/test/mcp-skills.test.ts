import { createHash } from "node:crypto";
import type { McpSkill, ReadResourceResult } from "@earendil-works/pi-mcp";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { McpSkillRegistry, type McpSkillServer, renderMcpSkillsSection } from "../src/extensions/mcp/skills.ts";
import { createTestUiContext } from "./suite/harness.ts";

const uri = "skill://workflow/SKILL.md";
const text =
	"---\nname: workflow\ndescription: Test workflow\nmetadata:\n  owner: test\n---\n\nRead references/guide.md.\n";
const guideUri = "skill://workflow/references/guide.md";

function fixture(name = "docs") {
	const files = new Map([
		[uri, text],
		[guideUri, "Guide.\n"],
	]);
	const skill: McpSkill = {
		uri,
		frontmatter: { name: "workflow", description: "Test workflow", metadata: { owner: "test" } },
		resources: [...files].map(([uri, text]) => ({
			uri,
			digest: `sha256:${createHash("sha256").update(text).digest("hex")}`,
			size: Buffer.byteLength(text),
		})),
	};
	const read = vi.fn(
		async (uri: string): Promise<ReadResourceResult> => ({ contents: [{ uri, text: files.get(uri) ?? "unlisted" }] }),
	);
	const server: McpSkillServer = {
		name,
		timeoutMs: 1000,
		skills: [skill],
		getSkill: vi.fn(async () => skill),
		allSkills: vi.fn(async () => [skill]),
		readResource: read,
		readSkillResource: read,
	};
	return { server, files, skill, read };
}

describe("MCP skill loading", () => {
	it("loads only SKILL.md, verifies supporting files on demand, and isolates caches by server", async () => {
		const a = fixture("a"),
			b = fixture("b");
		const registry = new McpSkillRegistry();
		await registry.load(a.server, uri, async () => true);
		expect(a.read.mock.calls).toEqual([[uri, {}]]);
		expect(b.read).not.toHaveBeenCalled();
		const first = await registry.read(a.server, uri, "references/guide.md", {});
		(first.contents[0] as { text: string }).text = "mutated caller copy";
		expect(await registry.read(a.server, uri, "references/guide.md", {})).toEqual({
			contents: [{ uri: guideUri, text: "Guide.\n" }],
		});
		expect(a.read).toHaveBeenCalledTimes(2);
		await expect(registry.read(b.server, uri, "references/guide.md", {})).rejects.toThrow("Load this skill");
		await registry.load(b.server, uri, async () => true);
		expect(registry.active.map((entry) => entry.server)).toEqual(["a", "b"]);
	});

	it("does not fetch content when consent is denied or the manifest is dynamic", async () => {
		const { server, read, skill } = fixture();
		const registry = new McpSkillRegistry();
		await expect(registry.load(server, uri, async () => false)).rejects.toThrow("not approved");
		skill.resources = "dynamic";
		await expect(registry.load(server, uri, async () => true)).rejects.toThrow("Dynamic");
		expect(read).not.toHaveBeenCalled();
		expect(registry.active).toEqual([]);
	});

	it.each(["digest", "size", "frontmatter"])("rejects %s mismatches before activation", async (failure) => {
		const { server, skill, files } = fixture();
		if (skill.resources === "dynamic") throw new Error("static fixture");
		if (failure === "digest") files.set(uri, text.replace("Read", "Fake"));
		if (failure === "size") skill.resources[0].size++;
		if (failure === "frontmatter") skill.frontmatter.metadata = { owner: "different" };
		const registry = new McpSkillRegistry();
		await expect(registry.load(server, uri, async () => true)).rejects.toThrow(/verification failed|frontmatter/);
		expect(registry.active).toEqual([]);
	});

	it("rejects changed supporting content, unlisted files, and escaping paths", async () => {
		const { server, files, read } = fixture();
		const registry = new McpSkillRegistry();
		await registry.load(server, uri, async () => true);
		files.set(guideUri, "Changed.\n");
		await expect(registry.read(server, uri, "references/guide.md", {})).rejects.toThrow("verification failed");
		await expect(registry.read(server, uri, "new.md", {})).rejects.toThrow("Unlisted");
		await expect(registry.read(server, uri, "%2e%2e/secret", {})).rejects.toThrow("Invalid skill resource path");
		expect(read).toHaveBeenCalledTimes(2);
		expect(() =>
			registry.verifyRead(server.name, "skill://workflow/new.md", {
				contents: [{ uri: "skill://workflow/new.md", text: "new" }],
			}),
		).toThrow("Unlisted");
	});

	it("verifies binary bytes and treats nested SKILL.md as supporting data", async () => {
		const { server, skill, read } = fixture();
		if (skill.resources === "dynamic") throw new Error("static fixture");
		const binaryUri = "skill://workflow/assets/data.bin";
		const nestedUri = "skill://workflow/nested/SKILL.md";
		const bytes = Buffer.from([0, 255, 1, 2]);
		const nested = "---\nname: nested\ndescription: Nested\nallowed-tools: bash\n---\n";
		for (const [uri, data] of [
			[binaryUri, bytes],
			[nestedUri, Buffer.from(nested)],
		] as const) {
			skill.resources.push({
				uri,
				size: data.length,
				digest: `sha256:${createHash("sha256").update(data).digest("hex")}`,
			});
		}
		const registry = new McpSkillRegistry();
		await registry.load(server, uri, async () => true);
		read.mockImplementation(async (uri) => ({
			contents: [{ uri, blob: (uri === binaryUri ? bytes : Buffer.from(nested)).toString("base64") }],
		}));
		expect(await registry.read(server, uri, "assets/data.bin", {})).toEqual({
			contents: [{ uri: binaryUri, blob: bytes.toString("base64") }],
		});
		await registry.read(server, uri, "nested/SKILL.md", {});
		expect(registry.active).toHaveLength(1);
	});

	it("revokes execution consent when the manifest changes and on transcript restoration", async () => {
		const { server, skill } = fixture();
		const registry = new McpSkillRegistry();
		const ctx = { hasUI: true, ui: createTestUiContext() } as ExtensionContext;
		await registry.load(server, uri, async () => true);
		expect(await registry.allowExecution(ctx)).toBe(true);
		const changed = structuredClone(skill);
		if (changed.resources === "dynamic") throw new Error("static fixture");
		changed.resources[1].digest = `sha256:${"0".repeat(64)}`;
		registry.observe(server.name, [changed]);
		expect(await registry.allowExecution(ctx)).toBe(false);
		const resumed = new McpSkillRegistry();
		resumed.restore(registry.active);
		expect(await resumed.allowExecution(ctx)).toBe(false);
	});

	it("requires per-call cross-origin approval and shows same-name skills separately", async () => {
		const a = fixture("a"),
			b = fixture("b");
		const registry = new McpSkillRegistry();
		await registry.load(a.server, uri, async () => true);
		const confirm = vi.fn(async () => false);
		const ctx = { hasUI: true, ui: createTestUiContext({ confirm }) } as ExtensionContext;
		expect(await registry.allowRead("a", ctx)).toBe(true);
		expect(await registry.allowRead("b", ctx)).toBe(false);
		expect(confirm.mock.calls[0]).toEqual([
			"Cross-origin MCP resource read",
			expect.stringContaining("a requested a resource from b"),
		]);
		const section = renderMcpSkillsSection([a.server, b.server]);
		expect(section).toContain('"server":"a"');
		expect(section).toContain('"server":"b"');
		b.skill.frontmatter["disable-model-invocation"] = true;
		expect(renderMcpSkillsSection([b.server])).toBeUndefined();
	});
});
