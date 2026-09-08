import { Command } from "./command.ts";
import { type ClientCommandContext, clientCommand } from "./commands/client.ts";
import { type IrcCommandContext, ircCommand } from "./commands/irc.ts";
import { type ServerCommandContext, serverCommand } from "./commands/server.ts";
import { type WebCommandContext, webCommand } from "./commands/web.ts";

interface ExperimentalCommandGroup {
	readonly command: "experimental";
}

export type CliContext = ServerCommandContext & ClientCommandContext & WebCommandContext & IrcCommandContext;

const experimentalCommand = new Command<ExperimentalCommandGroup, CliContext>("experimental").build(() => ({
	ok: false,
	errors: ["Expected experimental command: server, client, web, or irc"],
}));

export const cli = experimentalCommand
	.command(serverCommand)
	.command(clientCommand)
	.command(webCommand)
	.command(ircCommand);
