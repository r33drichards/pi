import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startWebGateway, type WebGateway } from "../src/experimental/web/gateway.ts";

/** A fake experimental server socket: echoes bytes back, records connections. */
function fakeUnixServer(): { path: string; server: Server; sockets: Socket[]; listening: Promise<void> } {
	const path = `/tmp/pi-gw-${randomBytes(4).toString("hex")}.sock`;
	const sockets: Socket[] = [];
	const server = createServer((socket) => {
		sockets.push(socket);
		socket.on("data", (chunk) => socket.write(chunk));
	});
	const listening = new Promise<void>((resolve) => server.listen(path, resolve));
	return { path, server, sockets, listening };
}

function connect(url: string): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(url);
		socket.binaryType = "arraybuffer";
		socket.once("open", () => resolve(socket));
		socket.once("error", reject);
	});
}

function nextMessage(socket: WebSocket): Promise<Uint8Array> {
	return new Promise((resolve) => socket.once("message", (data) => resolve(new Uint8Array(data as ArrayBuffer))));
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("condition not met in time");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function closed(socket: WebSocket): Promise<number> {
	return new Promise((resolve) => socket.once("close", (code) => resolve(code)));
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

async function fixture(
	options: { token?: string } = {},
): Promise<{ gateway: WebGateway; fake: ReturnType<typeof fakeUnixServer> }> {
	const fake = fakeUnixServer();
	await fake.listening;
	const staticDir = mkdtempSync(join(tmpdir(), "pi-web-static-"));
	writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>pi</title>");
	writeFileSync(join(staticDir, "app.js"), "console.log('app')");
	const gateway = await startWebGateway({
		socketPath: fake.path,
		serverId: "0ee6363e-5b38-49de-a333-37b71c4b583f",
		host: "127.0.0.1",
		port: 0,
		staticDir,
		...(options.token === undefined ? {} : { token: options.token }),
	});
	cleanups.push(async () => {
		await gateway.close();
		fake.server.close();
		rmSync(staticDir, { recursive: true, force: true });
	});
	return { gateway, fake };
}

describe("experimental web gateway", () => {
	it("serves the app and reports the server id", async () => {
		const { gateway } = await fixture();
		const index = await fetch(gateway.url);
		expect(index.status).toBe(200);
		expect(index.headers.get("content-type")).toContain("text/html");
		expect(await index.text()).toContain("<title>pi</title>");
		const app = await fetch(`${gateway.url}/app.js`);
		expect(app.headers.get("content-type")).toContain("javascript");
		const info = await fetch(`${gateway.url}/api/server`);
		expect(await info.json()).toEqual({ serverId: "0ee6363e-5b38-49de-a333-37b71c4b583f" });
		expect((await fetch(`${gateway.url}/missing.txt`)).status).toBe(404);
		expect((await fetch(`${gateway.url}/../etc/passwd`)).status).toBe(404);
	});

	it("relays bytes both ways between the browser and the unix socket", async () => {
		const { gateway, fake } = await fixture();
		const socket = await connect(`${gateway.wsUrl}`);
		cleanups.push(() => socket.close());
		const payload = new Uint8Array([0, 0, 0, 3, 1, 2, 3]);
		const echoed = nextMessage(socket);
		socket.send(payload);
		expect(await echoed).toEqual(payload);
		await waitFor(() => fake.sockets.length === 1);
		// The unix side can push unsolicited bytes too.
		const pushed = nextMessage(socket);
		fake.sockets[0]!.write(new Uint8Array([9, 9]));
		expect(await pushed).toEqual(new Uint8Array([9, 9]));
	});

	it("closes the websocket when the unix side closes, and vice versa", async () => {
		const { gateway, fake } = await fixture();
		const first = await connect(gateway.wsUrl);
		await waitFor(() => fake.sockets.length === 1);
		const firstClosed = closed(first);
		fake.sockets[0]!.destroy();
		expect(await firstClosed).toBe(1000);

		const second = await connect(gateway.wsUrl);
		await waitFor(() => fake.sockets.length === 2);
		const unixClosed = new Promise<void>((resolve) => fake.sockets[1]!.once("close", () => resolve()));
		second.close();
		await unixClosed;
	});

	it("rejects websocket upgrades without the configured token", async () => {
		const { gateway } = await fixture({ token: "s3cret" });
		await expect(connect(gateway.wsUrl)).rejects.toThrow(/401/);
		await expect(connect(`${gateway.wsUrl}?token=wrong`)).rejects.toThrow(/401/);
		const socket = await connect(`${gateway.wsUrl}?token=s3cret`);
		cleanups.push(() => socket.close());
		expect(socket.readyState).toBe(WebSocket.OPEN);
		// The page itself stays reachable; the token only guards the protocol.
		expect((await fetch(gateway.url)).status).toBe(200);
	});

	it("only upgrades the /ws path", async () => {
		const { gateway } = await fixture();
		await expect(connect(`${gateway.url.replace("http", "ws")}/other`)).rejects.toThrow(/404/);
	});
});
