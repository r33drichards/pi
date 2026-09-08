/**
 * Carry mcp-js execution state across a Session fork. A forked pi Session has
 * a new id, and the engine keys heaps and filesystem snapshots by session name,
 * so without this the fork would start on an empty sandbox. The coordinator
 * server exposes no fork endpoint, but `/api/exec` accepts explicit `heap` and
 * `fs` ids with a session name and records the run in that session's log, so
 * one no-op execution seeded from the source's latest ids is a fork.
 */

export interface EngineForkOptions {
	/** The mcp-js coordinator base URL, e.g. http://mcp-js:3000. */
	url: string;
	headers?: Record<string, string>;
	fetch?: typeof fetch;
	/** Poll interval while the seeding execution settles. */
	pollMs?: number;
}

interface SnapshotEntry {
	output_heap?: string | null;
	output_fs?: string | null;
}

/** Seed `target`'s engine session from `source`'s latest state. Returns false when the source has no state yet. */
export async function forkEngineSession(source: string, target: string, options: EngineForkOptions): Promise<boolean> {
	const doFetch = options.fetch ?? fetch;
	const base = options.url.replace(/\/+$/, "");
	const headers = { ...options.headers, "content-type": "application/json" };
	const snapshots = await doFetch(`${base}/api/sessions/${encodeURIComponent(source)}/snapshots`, { headers });
	if (snapshots.status === 404) return false;
	if (!snapshots.ok) throw new Error(`mcp-js snapshots for ${source}: HTTP ${snapshots.status}`);
	const entries = (await snapshots.json()) as SnapshotEntry[];
	const latest = [...entries].reverse().find((entry) => entry.output_heap || entry.output_fs);
	if (!latest) return false;
	const body: Record<string, unknown> = { session: target, code: `// forked from session ${source}` };
	if (latest.output_heap) body.heap = latest.output_heap;
	if (latest.output_fs) body.fs = latest.output_fs;
	const accepted = await doFetch(`${base}/api/exec`, { method: "POST", headers, body: JSON.stringify(body) });
	if (!accepted.ok) throw new Error(`mcp-js exec for fork: HTTP ${accepted.status} ${await accepted.text()}`);
	const { execution_id: id } = (await accepted.json()) as { execution_id: string };
	for (;;) {
		const info = await doFetch(`${base}/api/executions/${encodeURIComponent(id)}`, { headers });
		if (!info.ok) throw new Error(`mcp-js execution ${id}: HTTP ${info.status}`);
		const { status, error } = (await info.json()) as { status: string; error?: string | null };
		if (status === "completed") return true;
		if (status !== "running" && status !== "queued" && status !== "pending") {
			throw new Error(`mcp-js fork execution ${status}: ${error ?? "unknown error"}`);
		}
		await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 200));
	}
}
