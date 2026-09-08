import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildWebApp } from "../src/experimental/web/build.ts";

const root = mkdtempSync(join(tmpdir(), "pi-web-build-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("experimental web app bundle", () => {
	it("bundles for the browser without Node-only imports", async () => {
		const { staticDir } = await buildWebApp(root);
		expect(existsSync(join(staticDir, "index.html"))).toBe(true);
		expect(existsSync(join(staticDir, "app.css"))).toBe(true);
		const bundle = readFileSync(join(staticDir, "app.js"), "utf8");
		// esbuild leaves unresolvable Node builtins as bare imports or requires.
		expect(bundle).not.toMatch(/from\s*"node:/);
		expect(bundle).not.toMatch(/require\("node:/);
		expect(bundle).not.toMatch(/__require\("(fs|net|path|os|child_process)"\)/);
		expect(bundle).toContain("pi-sessions-app");
	}, 60_000);
});
