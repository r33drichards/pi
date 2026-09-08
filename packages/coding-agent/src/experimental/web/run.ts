/**
 * `pi web`: the foreground experimental server plus the browser gateway, in
 * one process, shut down together on SIGINT/SIGTERM or when either fails.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebCommand } from "../../cli/experimental/commands/web.ts";
import type { RunningServer, startForegroundServer } from "../server.ts";
import { buildWebApp } from "./build.ts";
import { startWebGateway } from "./gateway.ts";

export type StartServer = typeof startForegroundServer;

export interface RunWebGatewayOptions {
	/** Where to print progress; defaults to console.log. */
	log?: (line: string) => void;
	/** Resolves when the process should stop; defaults to SIGINT/SIGTERM. */
	stop?: Promise<void>;
}

export async function runWebGateway(
	command: WebCommand,
	startServer: StartServer,
	options: RunWebGatewayOptions = {},
): Promise<void> {
	const log = options.log ?? ((line: string) => console.log(line));
	const server: RunningServer = await startServer({
		serverId: command.serverId,
		sessionDir: command.sessionDir,
		provider: command.provider,
		model: command.model,
		pluginPackages: command.pluginPackages ?? [],
	});
	const buildRoot = await mkdtemp(join(tmpdir(), "pi-web-"));
	try {
		const app = await buildWebApp(buildRoot);
		const gateway = await startWebGateway({
			socketPath: server.socketPath,
			serverId: server.serverId,
			staticDir: app.staticDir,
			host: command.host,
			port: command.port,
			token: command.token,
		});
		log(`Server: ${server.serverId}`);
		log(`Socket: ${server.socketPath}`);
		log(`Web: ${gateway.url}${command.token ? " (token required: append ?token=<your token>)" : ""}`);
		try {
			await new Promise<void>((resolve, reject) => {
				const cleanup = (): void => {
					process.off("SIGINT", finish);
					process.off("SIGTERM", finish);
				};
				const finish = (): void => {
					cleanup();
					resolve();
				};
				const fail = (error: unknown): void => {
					cleanup();
					reject(error);
				};
				process.once("SIGINT", finish);
				process.once("SIGTERM", finish);
				void server.closed.then(finish, fail);
				void options.stop?.then(finish, fail);
			});
		} finally {
			await gateway.close();
		}
	} finally {
		await server.close();
		await rm(buildRoot, { recursive: true, force: true });
	}
}
