import { isServerId, type ServerId } from "@earendil-works/pi-protocol";
import { Command, stringOption, valueOption } from "../command.ts";
import { unsupportedOptions } from "../command-options.ts";

export interface WebCommand {
	readonly command: "web";
	readonly host?: string;
	readonly port?: number;
	readonly token?: string;
	readonly provider?: string;
	readonly model?: string;
	readonly pluginPackages?: readonly string[];
	readonly serverId?: ServerId;
	readonly sessionDir?: string;
}

export interface WebCommandContext {
	runWeb(command: WebCommand): void | Promise<void>;
}

const hostOption = stringOption("--host");
const portOption = valueOption("--port", (value) => {
	const port = Number(value);
	return Number.isInteger(port) && port >= 0 && port <= 65535
		? { ok: true, value: port }
		: { ok: false, error: `Invalid --port "${value}"; expected an integer from 0 to 65535` };
});
const tokenOption = stringOption("--token");
const serverIdOption = valueOption("--server-id", (value) =>
	isServerId(value)
		? { ok: true, value }
		: { ok: false, error: `Invalid --server-id "${value}"; expected a lowercase UUIDv4` },
);
const sessionDirOption = stringOption("--session-dir");
const providerOption = stringOption("--provider");
const modelOption = stringOption("--model");
const pluginPackageOption = stringOption("-e", { repeatable: true });

/** `pi web`: the experimental server plus a browser gateway serving the sessions app. */
export const webCommand = new Command<WebCommand, WebCommandContext>("web")
	.option(hostOption)
	.option(portOption)
	.option(tokenOption)
	.option(serverIdOption)
	.option(sessionDirOption)
	.option(providerOption)
	.option(modelOption)
	.option(pluginPackageOption)
	.build((input) => {
		const host = input.value(hostOption);
		const port = input.value(portOption);
		const token = input.value(tokenOption);
		const serverId = input.value(serverIdOption);
		const sessionDir = input.value(sessionDirOption);
		const provider = input.value(providerOption);
		const model = input.value(modelOption);
		const pluginPackages = input.values(pluginPackageOption);
		const errors = [
			...(provider !== undefined && model === undefined ? ["--provider requires --model"] : []),
			...(host !== undefined && host !== "127.0.0.1" && host !== "localhost" && token === undefined
				? [`--host ${host} exposes the gateway beyond loopback; pass --token to require one`]
				: []),
			...unsupportedOptions("web", input),
		];
		if (errors.length > 0) return { ok: false, errors };
		return {
			ok: true,
			command: {
				command: "web",
				...(host === undefined ? {} : { host }),
				...(port === undefined ? {} : { port }),
				...(token === undefined ? {} : { token }),
				...(provider === undefined ? {} : { provider }),
				...(model === undefined ? {} : { model }),
				...(pluginPackages.length === 0 ? {} : { pluginPackages }),
				...(serverId === undefined ? {} : { serverId }),
				...(sessionDir === undefined ? {} : { sessionDir }),
			},
		};
	})
	.action((command, context) => context.runWeb(command));
