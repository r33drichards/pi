import { describe, expect, test, vi } from "vitest";
import { cli } from "../src/cli/experimental/cli.ts";

describe("experimental CLI command composition", () => {
	test("requires an experimental subcommand", () => {
		expect(cli.parse([])).toEqual({
			ok: false,
			errors: ["Expected experimental command: server, client, or irc"],
		});
	});

	test("passes server options to the command action", async () => {
		const runServer = vi.fn(() => undefined);
		const result = await cli.execute(
			[
				"server",
				"--server-id",
				"00000000-0000-4000-8000-000000000001",
				"--session-dir",
				"./sessions",
				"--provider",
				"anthropic",
				"--model",
				"claude-sonnet-4-5",
			],
			{
				runServer,
				runClient: vi.fn(() => undefined),
				runIrc: vi.fn(() => undefined),
			},
		);

		const command = {
			command: "server" as const,
			serverId: "00000000-0000-4000-8000-000000000001",
			sessionDir: "./sessions",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
		};
		expect(result).toEqual({ ok: true, command });
		expect(runServer).toHaveBeenCalledWith(command);
	});

	test.each(["server", "client", "irc"] as const)("executes the parsed %s command", async (name) => {
		const context = {
			runServer: vi.fn(() => undefined),
			runClient: vi.fn(() => undefined),
			runIrc: vi.fn(() => undefined),
		};
		const result = await cli.execute([name], context);

		expect(result).toEqual({ ok: true, command: { command: name } });
		expect(context.runServer).toHaveBeenCalledTimes(name === "server" ? 1 : 0);
		expect(context.runClient).toHaveBeenCalledTimes(name === "client" ? 1 : 0);
		expect(context.runIrc).toHaveBeenCalledTimes(name === "irc" ? 1 : 0);
	});

	test("parses irc options", async () => {
		const context = { runServer: vi.fn(), runClient: vi.fn(), runIrc: vi.fn(() => undefined) };
		const result = await cli.execute(
			["irc", "--server", "irc.example", "--port", "6697", "--tls", "--nick", "pi", "--channels", "#pi,#dev"],
			context,
		);
		expect(result).toEqual({
			ok: true,
			command: {
				command: "irc",
				server: "irc.example",
				port: 6697,
				tls: true,
				nick: "pi",
				channels: ["#pi", "#dev"],
			},
		});
		expect(cli.parse(["irc", "--port", "http"])).toEqual({
			ok: false,
			errors: ['Invalid --port "http"; expected an integer from 0 to 65535'],
		});
	});
});
