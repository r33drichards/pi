import { isServerId, type ServerId } from "@earendil-works/pi-protocol";
import { Command, flagOption, stringOption, valueOption } from "../command.ts";
import { unsupportedOptions } from "../command-options.ts";

/** `pi irc`: the experimental server plus an IRC presentation, one Session per channel. */
export interface IrcCommand {
	readonly command: "irc";
	readonly server?: string;
	readonly port?: number;
	readonly tls?: boolean;
	readonly nick?: string;
	readonly password?: string;
	readonly channels?: readonly string[];
	readonly controlChannel?: string;
	readonly all?: boolean;
	readonly stateDir?: string;
	readonly webPort?: number;
	readonly webToken?: string;
	readonly provider?: string;
	readonly model?: string;
	readonly pluginPackages?: readonly string[];
	readonly serverId?: ServerId;
	readonly sessionDir?: string;
}

export interface IrcCommandContext {
	runIrc(command: IrcCommand): void | Promise<void>;
}

function portOption(name: `-${string}`) {
	return valueOption(name, (value) => {
		const port = Number(value);
		return Number.isInteger(port) && port >= 0 && port <= 65535
			? { ok: true, value: port }
			: { ok: false, error: `Invalid ${name} "${value}"; expected an integer from 0 to 65535` };
	});
}

const serverOption = stringOption("--server");
const ircPortOption = portOption("--port");
const tlsOption = flagOption("--tls");
const nickOption = stringOption("--nick");
const passwordOption = stringOption("--password");
const channelsOption = stringOption("--channels");
const controlChannelOption = stringOption("--control-channel");
const allOption = flagOption("--all");
const stateDirOption = stringOption("--state-dir");
const webPortOption = portOption("--web-port");
const webTokenOption = stringOption("--web-token");
const providerOption = stringOption("--provider");
const modelOption = stringOption("--model");
const pluginPackageOption = stringOption("-e", { repeatable: true });
const serverIdOption = valueOption("--server-id", (value) =>
	isServerId(value)
		? { ok: true, value }
		: { ok: false, error: `Invalid --server-id "${value}"; expected a lowercase UUIDv4` },
);
const sessionDirOption = stringOption("--session-dir");

export const ircCommand = new Command<IrcCommand, IrcCommandContext>("irc")
	.option(serverOption)
	.option(ircPortOption)
	.option(tlsOption)
	.option(nickOption)
	.option(passwordOption)
	.option(channelsOption)
	.option(controlChannelOption)
	.option(allOption)
	.option(stateDirOption)
	.option(webPortOption)
	.option(webTokenOption)
	.option(providerOption)
	.option(modelOption)
	.option(pluginPackageOption)
	.option(serverIdOption)
	.option(sessionDirOption)
	.build((input) => {
		const server = input.value(serverOption);
		const port = input.value(ircPortOption);
		const tls = input.value(tlsOption);
		const nick = input.value(nickOption);
		const password = input.value(passwordOption);
		const channelsText = input.value(channelsOption);
		const controlChannel = input.value(controlChannelOption);
		const all = input.value(allOption);
		const stateDir = input.value(stateDirOption);
		const webPort = input.value(webPortOption);
		const webToken = input.value(webTokenOption);
		const provider = input.value(providerOption);
		const model = input.value(modelOption);
		const pluginPackages = input.values(pluginPackageOption);
		const serverId = input.value(serverIdOption);
		const sessionDir = input.value(sessionDirOption);
		const channels = channelsText
			?.split(",")
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0);
		const errors = [
			...(provider !== undefined && model === undefined ? ["--provider requires --model"] : []),
			...unsupportedOptions("irc", input),
		];
		if (errors.length > 0) return { ok: false, errors };
		return {
			ok: true,
			command: {
				command: "irc",
				...(server === undefined ? {} : { server }),
				...(port === undefined ? {} : { port }),
				...(tls ? { tls: true } : {}),
				...(nick === undefined ? {} : { nick }),
				...(password === undefined ? {} : { password }),
				...(channels === undefined || channels.length === 0 ? {} : { channels }),
				...(controlChannel === undefined ? {} : { controlChannel }),
				...(all ? { all: true } : {}),
				...(stateDir === undefined ? {} : { stateDir }),
				...(webPort === undefined ? {} : { webPort }),
				...(webToken === undefined ? {} : { webToken }),
				...(provider === undefined ? {} : { provider }),
				...(model === undefined ? {} : { model }),
				...(pluginPackages.length === 0 ? {} : { pluginPackages }),
				...(serverId === undefined ? {} : { serverId }),
				...(sessionDir === undefined ? {} : { sessionDir }),
			},
		};
	})
	.action((command, context) => context.runIrc(command));
