/**
 * Browser gateway for the experimental server.
 *
 * Serves the bundled sessions web app and relays each WebSocket at `/ws` to
 * the server's Unix socket as opaque bytes: one Unix connection per browser
 * connection, bytes copied in both directions, close propagated both ways.
 * The gateway never decodes the protocol; the browser's `pi-client` speaks it
 * end to end, so `pi-server` and `pi-protocol` stay unchanged.
 */

import { createReadStream, promises as fs } from "node:fs";
import { createServer as createHttpServer, type Server as HttpServer, type IncomingMessage } from "node:http";
import { createConnection, type Socket } from "node:net";
import { extname, join, normalize, resolve, sep } from "node:path";
import { WebSocket, WebSocketServer } from "ws";

export interface WebGatewayOptions {
	/** The experimental server's Unix socket. */
	socketPath: string;
	/** The logical server id the browser must expect in the protocol handshake. */
	serverId: string;
	/** Directory holding the bundled app: `index.html`, `app.js`, `app.css`. */
	staticDir: string;
	/** Bind address. Defaults to 127.0.0.1; do not expose without a token and TLS in front. */
	host?: string;
	/** Listening port; 0 picks a free one. Defaults to 8600. */
	port?: number;
	/** When set, `/ws` upgrades must carry `?token=<token>`; other requests are unaffected. */
	token?: string;
}

export interface WebGateway {
	readonly url: string;
	readonly wsUrl: string;
	readonly host: string;
	readonly port: number;
	close(): Promise<void>;
}

const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".map": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
};

/** Resolve a request path inside `staticDir`, refusing anything that escapes it. */
function staticFile(staticDir: string, requestPath: string): string | undefined {
	const cleaned = normalize(decodeURIComponent(requestPath)).replace(/^(\.\.[/\\])+/, "");
	const candidate = resolve(staticDir, `.${sep}${cleaned === "/" || cleaned === "" ? "index.html" : cleaned}`);
	const root = resolve(staticDir);
	if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) return undefined;
	return candidate;
}

function tokenMatches(expected: string | undefined, request: IncomingMessage): boolean {
	if (expected === undefined) return true;
	const url = new URL(request.url ?? "/", "http://localhost");
	return url.searchParams.get("token") === expected;
}

/** Copy bytes between a browser WebSocket and one fresh Unix connection until either side closes. */
function relay(socket: WebSocket, socketPath: string): void {
	const unix: Socket = createConnection(socketPath);
	let done = false;
	const finish = (code: number): void => {
		if (done) return;
		done = true;
		unix.destroy();
		if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close(code);
	};
	unix.on("data", (chunk) => {
		if (socket.readyState === WebSocket.OPEN) socket.send(chunk, { binary: true });
	});
	unix.on("close", () => finish(1000));
	unix.on("error", () => finish(1011));
	socket.on("message", (data) => {
		if (unix.destroyed) return;
		const chunk = Array.isArray(data)
			? Buffer.concat(data)
			: data instanceof ArrayBuffer
				? Buffer.from(new Uint8Array(data))
				: (data as Buffer);
		unix.write(chunk);
	});
	socket.on("close", () => finish(1000));
	socket.on("error", () => finish(1011));
}

export async function startWebGateway(options: WebGatewayOptions): Promise<WebGateway> {
	const host = options.host ?? "127.0.0.1";
	const staticDir = options.staticDir;
	const http: HttpServer = createHttpServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://localhost");
		if (request.method !== "GET" && request.method !== "HEAD") {
			response.writeHead(405).end();
			return;
		}
		if (url.pathname === "/api/server") {
			response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
			response.end(JSON.stringify({ serverId: options.serverId }));
			return;
		}
		const file = staticFile(staticDir, url.pathname);
		if (file === undefined) {
			response.writeHead(404).end();
			return;
		}
		void fs
			.stat(file)
			.then((stat) => {
				if (!stat.isFile()) throw new Error("not a file");
				response.writeHead(200, {
					"content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
					"content-length": stat.size,
					"cache-control": "no-cache",
				});
				if (request.method === "HEAD") response.end();
				else createReadStream(file).pipe(response);
			})
			.catch(() => response.writeHead(404).end());
	});

	const wss = new WebSocketServer({ noServer: true });
	const relays = new Set<WebSocket>();
	http.on("upgrade", (request, socket, head) => {
		const url = new URL(request.url ?? "/", "http://localhost");
		if (url.pathname !== "/ws") {
			socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
			socket.destroy();
			return;
		}
		if (!tokenMatches(options.token, request)) {
			socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
			socket.destroy();
			return;
		}
		wss.handleUpgrade(request, socket, head, (browser) => {
			relays.add(browser);
			browser.once("close", () => relays.delete(browser));
			relay(browser, options.socketPath);
		});
	});

	await new Promise<void>((resolveListen, reject) => {
		http.once("error", reject);
		http.listen(options.port ?? 8600, host, () => {
			http.off("error", reject);
			resolveListen();
		});
	});
	const address = http.address();
	const port = typeof address === "object" && address !== null ? address.port : (options.port ?? 8600);
	const url = `http://${host}:${port}`;
	return {
		url,
		wsUrl: `ws://${host}:${port}/ws`,
		host,
		port,
		async close() {
			for (const browser of relays) browser.close(1001);
			await new Promise<void>((resolveClose) => wss.close(() => resolveClose()));
			await new Promise<void>((resolveClose) => http.close(() => resolveClose()));
		},
	};
}

/** The bundled app's directory for a given build output root. */
export function staticDirFor(root: string): string {
	return join(root, "public");
}
