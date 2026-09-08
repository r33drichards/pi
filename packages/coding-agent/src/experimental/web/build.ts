/**
 * Bundle the browser app with esbuild. Development-only: `pi web` bundles at
 * startup into a private directory, so there is no separate build step and
 * no artifact to publish.
 */

import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const appDir = join(dirname(fileURLToPath(import.meta.url)), "app");

export interface WebAppBuild {
	/** Directory containing `index.html`, `app.js`, and `app.css`. */
	readonly staticDir: string;
}

export async function buildWebApp(outputRoot: string): Promise<WebAppBuild> {
	const staticDir = join(outputRoot, "public");
	await mkdir(staticDir, { recursive: true });
	await build({
		entryPoints: [join(appDir, "main.ts")],
		bundle: true,
		platform: "browser",
		format: "esm",
		// Prefer workspace sources so a checkout does not need built dist output for
		// the chord and coding-agent modules the app imports; published packages
		// without a source condition fall back to their import entry.
		conditions: ["source", "browser", "import"],
		target: ["es2022"],
		sourcemap: true,
		logLevel: "silent",
		outfile: join(staticDir, "app.js"),
	});
	await copyFile(join(appDir, "index.html"), join(staticDir, "index.html"));
	await copyFile(join(appDir, "styles.css"), join(staticDir, "app.css"));
	return { staticDir };
}
