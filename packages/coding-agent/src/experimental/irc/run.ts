/**
 * `pi irc`: the foreground experimental server plus the IRC presentation.
 * Configuration comes from flags, then IRC_* environment variables.
 */

import { join } from "node:path";
import type { IrcCommand } from "../../cli/experimental/commands/irc.ts";
import { getAgentDir } from "../../config.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import type { RunningServer, startForegroundServer } from "../server.ts";
import { type IrcBotOptions, IrcPiBot } from "./bot.ts";
import { CONTROL_TOKEN_ENV, CONTROL_URL_ENV, type ControlServer, startControlServer } from "./control.ts";
import { type EngineForkOptions, engineCapabilities } from "./engine-fork.ts";

export type StartServer = typeof startForegroundServer;

export interface ResolvedIrcConfig {
	server: string;
	port: number;
	tls: boolean;
	nick: string;
	password?: string;
	channels: string[];
	controlChannel: string;
	addressedOnly: boolean;
	statePath: string;
}

function envFlag(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

/** Flags win over `IRC_*` environment variables, which win over defaults. */
export function resolveIrcConfig(command: IrcCommand, env: NodeJS.ProcessEnv, agentDir: string): ResolvedIrcConfig {
	const server = command.server ?? env.IRC_SERVER;
	if (!server) throw new Error("IRC server is required: pass --server or set IRC_SERVER");
	const envPort = env.IRC_PORT === undefined ? undefined : Number(env.IRC_PORT);
	const tls = command.tls ?? envFlag(env.IRC_TLS) ?? false;
	const port = command.port ?? (envPort !== undefined && Number.isInteger(envPort) ? envPort : tls ? 6697 : 6667);
	const controlChannel = (command.controlChannel ?? env.IRC_CONTROL_CHANNEL ?? "#pi").toLowerCase();
	const envChannels = env.IRC_CHANNELS?.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
	const channels = [
		...new Set([controlChannel, ...(command.channels ?? envChannels ?? []).map((c) => c.toLowerCase())]),
	];
	const stateDir = command.stateDir ?? env.PI_IRC_STATE_DIR ?? join(agentDir, "irc");
	return {
		server,
		port,
		tls,
		nick: command.nick ?? env.IRC_NICK ?? "pi",
		...((command.password ?? env.IRC_PASSWORD) ? { password: command.password ?? env.IRC_PASSWORD } : {}),
		channels,
		controlChannel,
		addressedOnly: !(command.all ?? envFlag(env.IRC_RESPOND_TO_ALL) ?? false),
		statePath: join(stateDir, "channels.json"),
	};
}

/** The mcp-js coordinator this server's sessions use, so `,fork` can carry engine state. */
export function resolveEngineFork(cwd: string): EngineForkOptions | undefined {
	const settings = SettingsManager.create(cwd).getMcpJs();
	if (settings?.mode !== "coordinator" || !settings.url) return undefined;
	return { url: settings.url, ...(settings.headers === undefined ? {} : { headers: settings.headers }) };
}

export interface RunIrcOptions {
	log?: (line: string) => void;
	stop?: Promise<void>;
	env?: NodeJS.ProcessEnv;
}

export async function runIrcPresentation(
	command: IrcCommand,
	startServer: StartServer,
	options: RunIrcOptions = {},
): Promise<void> {
	const log = options.log ?? ((line: string) => console.log(line));
	const env = options.env ?? process.env;
	const config = resolveIrcConfig(command, env, getAgentDir());
	// The control surface must exist before the server so every session worker
	// inherits its address and token and registers the delegation tools.
	let control: ControlServer | undefined;
	const handlers: { current: IrcPiBot | undefined } = { current: undefined };
	control = await startControlServer({
		spawn: (request) => handlers.current!.spawn(request),
		send: (request) => handlers.current!.send(request),
		merge: (request) => handlers.current!.merge(request),
	});
	process.env[CONTROL_URL_ENV] = control.url;
	process.env[CONTROL_TOKEN_ENV] = control.token;
	const server: RunningServer = await startServer({
		serverId: command.serverId,
		sessionDir: command.sessionDir,
		provider: command.provider,
		model: command.model,
		pluginPackages: command.pluginPackages ?? [],
	});
	log(`Server: ${server.serverId}`);
	log(`Socket: ${server.socketPath}`);
	let bot: IrcPiBot | undefined;
	try {
		const engineFork = resolveEngineFork(process.cwd());
		let engineHeap = false;
		if (engineFork) {
			try {
				engineHeap = (await engineCapabilities(engineFork)).heap;
			} catch (error) {
				log(
					`IRC: could not read engine capabilities from ${engineFork.url}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		const botOptions: IrcBotOptions = {
			...config,
			target: { serverId: server.serverId, socketPath: server.socketPath },
			...(engineFork === undefined ? {} : { engineFork, engineHeap }),
			log,
		};
		bot = new IrcPiBot(botOptions);
		handlers.current = bot;
		log(`Control: ${control.url} (delegation tools enabled for session workers)`);
		log(
			`IRC: connecting to ${config.server}:${config.port}${config.tls ? " (tls)" : ""} as ${config.nick}, control ${config.controlChannel}`,
		);
		await bot.start();
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
		await bot?.close();
		await server.close();
		await control?.close();
	}
}
