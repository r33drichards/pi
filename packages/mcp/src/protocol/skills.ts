import { isObject } from "./jsonrpc.ts";

/** SEP-2640 (io.modelcontextprotocol/skills). Identity is (configured server, uri). */
export const SKILLS_EXTENSION = "io.modelcontextprotocol/skills";
export const MAX_SKILL_RESOURCES = 512;
export const MAX_SKILL_BYTES = 16 * 1024 * 1024;

export interface SkillResource {
	uri: string;
	digest: string;
	size: number;
}

export interface McpSkill {
	uri: string;
	frontmatter: { name: string; description: string; [key: string]: unknown };
	resources: SkillResource[] | "dynamic";
}

export interface ListSkillsResult {
	skills: McpSkill[];
	nextCursor?: string;
}

/** Reject ambiguous/escaping paths without assuming the server uses skill://. */
export function skillResourcePath(skillUri: string, resourceUri: string): string {
	const root = skillUri.slice(0, -"SKILL.md".length);
	if (!skillUri.endsWith("/SKILL.md") || !resourceUri.startsWith(root)) {
		throw new Error("Resource is outside the skill directory");
	}
	const path = resourceUri.slice(root.length);
	if (!path || /[?#\\\x00-\x1f]/.test(path)) throw new Error("Invalid skill resource path");
	for (const part of path.split("/")) {
		const decoded = decodeURIComponent(part);
		if (!decoded || decoded === "." || decoded === ".." || /[/\\\x00-\x1f]/.test(decoded)) {
			throw new Error("Invalid skill resource path");
		}
	}
	return path;
}

export function isMcpSkill(value: unknown): value is McpSkill {
	if (!isObject(value)) return false;
	if (
		typeof value.uri !== "string" ||
		!URL.canParse(value.uri) ||
		/[?#\\\x00-\x1f]/.test(value.uri) ||
		!value.uri.endsWith("/SKILL.md") ||
		!isObject(value.frontmatter)
	)
		return false;
	const { name, description } = value.frontmatter;
	if (
		typeof name !== "string" ||
		name.length > 64 ||
		!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) ||
		typeof description !== "string" ||
		!description.trim() ||
		description.length > 1024
	)
		return false;
	try {
		const segments = value.uri.slice(0, -"/SKILL.md".length).split("/");
		if (decodeURIComponent(segments.at(-1) ?? "") !== name) return false;
		const url = new URL(value.uri);
		if (url.username || url.password) return false;
		// URL normalization must not hide dot segments in the skill's own namespace.
		const namespace = value.uri.slice(value.uri.indexOf(":") + 1).replace(/^\/+/, "");
		for (const segment of namespace.split("/")) {
			const part = decodeURIComponent(segment);
			if (!part || part === "." || part === ".." || /[/\\\x00-\x1f]/.test(part)) return false;
		}
		if (value.resources === "dynamic") return true;
		if (
			!Array.isArray(value.resources) ||
			value.resources.length === 0 ||
			value.resources.length > MAX_SKILL_RESOURCES
		)
			return false;
		const uris = new Set<string>();
		let size = 0;
		for (const resource of value.resources) {
			if (
				!isObject(resource) ||
				typeof resource.uri !== "string" ||
				typeof resource.digest !== "string" ||
				!/^sha256:[0-9a-f]{64}$/.test(resource.digest) ||
				typeof resource.size !== "number" ||
				!Number.isSafeInteger(resource.size) ||
				resource.size < 0 ||
				uris.has(resource.uri)
			)
				return false;
			skillResourcePath(value.uri, resource.uri);
			uris.add(resource.uri);
			size += resource.size;
			if (size > MAX_SKILL_BYTES) return false;
		}
		return uris.has(value.uri);
	} catch {
		return false;
	}
}
