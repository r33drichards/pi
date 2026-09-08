import { describe, expect, test, vi } from "vitest";
import { cli } from "../src/cli/experimental/cli.ts";

describe("experimental CLI command composition", () => {
	test("requires an experimental subcommand", () => {
		expect(cli.parse([])).toEqual({
			ok: false,
			errors: ["Expected experimental command: server, client, or web"],
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
			{ runServer, runClient: vi.fn(() => undefined), runWeb: vi.fn(() => undefined) },
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

	test.each(["server", "client", "web"] as const)("executes the parsed %s command", async (name) => {
		const context = {
			runServer: vi.fn(() => undefined),
			runClient: vi.fn(() => undefined),
			runWeb: vi.fn(() => undefined),
		};
		const result = await cli.execute([name], context);

		expect(result).toEqual({ ok: true, command: { command: name } });
		expect(context.runServer).toHaveBeenCalledTimes(name === "server" ? 1 : 0);
		expect(context.runClient).toHaveBeenCalledTimes(name === "client" ? 1 : 0);
		expect(context.runWeb).toHaveBeenCalledTimes(name === "web" ? 1 : 0);
	});

	test("parses web gateway options and refuses a non-loopback host without a token", async () => {
		const context = { runServer: vi.fn(), runClient: vi.fn(), runWeb: vi.fn(() => undefined) };
		expect(await cli.execute(["web", "--port", "8601", "--token", "abc"], context)).toEqual({
			ok: true,
			command: { command: "web", port: 8601, token: "abc" },
		});
		expect(context.runWeb).toHaveBeenCalledWith({ command: "web", port: 8601, token: "abc" });
		expect(cli.parse(["web", "--host", "0.0.0.0"])).toEqual({
			ok: false,
			errors: ["--host 0.0.0.0 exposes the gateway beyond loopback; pass --token to require one"],
		});
		expect(cli.parse(["web", "--port", "http"])).toEqual({
			ok: false,
			errors: ['Invalid --port "http"; expected an integer from 0 to 65535'],
		});
	});
});
