import { afterEach, describe, expect, it, vi } from "vitest";
import { channelWorkspace, createSendQueue } from "../src/irc/bot.ts";
import { currentDomain, faultingDomain, installFaultDomains, runInDomain } from "../src/irc/fault-domain.ts";

const uninstallers: Array<() => void> = [];
afterEach(() => {
	while (uninstallers.length > 0) uninstallers.pop()?.();
	vi.useRealTimers();
});

function install() {
	const uninstall = installFaultDomains();
	uninstallers.push(uninstall);
	return uninstall;
}

/** What `run.ts` does: catch the process-level failure and ask who caused it. */
function attributeUncaught(fn: () => void): { channel: string | undefined; error: unknown } {
	try {
		fn();
		return { channel: faultingDomain(), error: undefined };
	} catch (error) {
		// The throw escapes the callback exactly as it would to the process;
		// the domain is still readable while it unwinds.
		return { channel: faultingDomain(), error };
	}
}

describe("per-channel fault attribution", () => {
	it("names the channel whose timer threw, without swallowing the throw", async () => {
		install();
		let attributed: { channel: string | undefined; error: unknown } | undefined;
		let betaRan = false;

		// An extension in #alpha schedules work that throws later, the way a
		// widget refresh does once its session context is stale.
		runInDomain("#alpha", () => {
			setTimeout(() => {
				attributed = attributeUncaught(() => {
					throw new Error("stale ctx");
				});
			}, 1);
		});
		runInDomain("#beta", () => {
			setTimeout(() => {
				betaRan = true;
			}, 1);
		});
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(attributed?.channel).toBe("#alpha");
		expect((attributed?.error as Error).message).toBe("stale ctx");
		expect(betaRan).toBe(true);
	});

	it("keeps the domain across a timer that re-arms itself", async () => {
		install();
		const seen: Array<string | undefined> = [];
		runInDomain("#alpha", () => {
			setTimeout(() => {
				seen.push(currentDomain());
				// The widget pattern: the callback schedules the next refresh.
				setTimeout(() => seen.push(currentDomain()), 1);
			}, 1);
		});
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(seen).toEqual(["#alpha", "#alpha"]);
	});

	it("leaves timers outside any channel alone and attributes nothing", async () => {
		install();
		expect(currentDomain()).toBeUndefined();
		let ran = false;
		let attributed: string | undefined = "unset";
		setTimeout(() => {
			ran = true;
			attributed = faultingDomain();
		}, 1);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(ran).toBe(true);
		expect(attributed).toBeUndefined();
	});

	it("forgets the channel once its callback returns", async () => {
		install();
		runInDomain("#alpha", () => {
			setTimeout(() => {}, 1);
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(faultingDomain()).toBeUndefined();
	});

	it("restores the real timers when uninstalled", () => {
		const before = globalThis.setTimeout;
		const uninstall = install();
		expect(globalThis.setTimeout).not.toBe(before);
		uninstall();
		expect(globalThis.setTimeout).toBe(before);
	});
});

describe("regressions found by running the bot", () => {
	it("gives each channel its own working directory", () => {
		// Extensions keep project-local state under cwd; sharing one directory
		// made every channel write into the first channel's store.
		const root = "/tmp/irc-channels";
		expect(channelWorkspace(root, "#pi")).toBe("/tmp/irc-channels/pi");
		expect(channelWorkspace(root, "#pi-brave-otter")).toBe("/tmp/irc-channels/pi-brave-otter");
		expect(channelWorkspace(root, "#pi")).not.toBe(channelWorkspace(root, "#pi2"));
		// An awkward channel name still resolves inside the root.
		expect(channelWorkspace(root, "&weird/../name")).toBe("/tmp/irc-channels/weird_.._name");
		expect(channelWorkspace(root, "#")).toBe("/tmp/irc-channels/default");
	});

	it("keeps sending after a line fails, instead of silencing the channel", async () => {
		const sent: string[] = [];
		const errors: unknown[] = [];
		let failNext = false;
		const queue = createSendQueue(
			(line) => {
				if (failNext) {
					failNext = false;
					throw new Error("write failed");
				}
				sent.push(line);
			},
			0,
			(error) => errors.push(error),
		);

		await queue(["first"]);
		failNext = true;
		await queue(["boom"]);
		// The chain must keep running: this is the bug that silenced a channel
		// for the rest of the process's life.
		await queue(["after the failure"]);
		expect(sent).toEqual(["first", "after the failure"]);
		expect(errors).toHaveLength(1);
	});

	it("sends a target's lines in order and stops when the bot closes", async () => {
		const sent: string[] = [];
		let closed = false;
		const queue = createSendQueue(
			(line) => sent.push(line),
			0,
			() => {},
			() => closed,
		);
		await Promise.all([queue(["a", "b"]), queue(["c"])]);
		expect(sent).toEqual(["a", "b", "c"]);
		closed = true;
		await queue(["not sent"]);
		expect(sent).toEqual(["a", "b", "c"]);
	});
});
