/**
 * The presentation's control surface for session workers. Tool execution
 * happens in the worker, which has no IRC connection, so the worker-side
 * tools (`spawn_channel`, `irc_send`, `merge_channel`) call this loopback HTTP
 * endpoint in the `pi irc` process. Its address and a per-run token reach the
 * workers through the environment; the bot's IRC and Session machinery does
 * the work.
 */

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export const CONTROL_URL_ENV = "PI_IRC_CONTROL_URL";
export const CONTROL_TOKEN_ENV = "PI_IRC_CONTROL_TOKEN";

export interface SpawnRequest {
	/** The calling session, which identifies the parent channel. */
	session: string;
	prompt: string;
	/** Target channel; default `#<parent>-<petname>`. */
	name?: string;
	timeoutSeconds?: number;
}

export interface SpawnResult {
	channel: string;
	sessionId: string;
	status: "completed" | "timeout" | "failed";
	/** The child's final assistant text (partial on timeout or failure). */
	text: string;
	error?: string;
}

export interface SendRequest {
	session: string;
	channel: string;
	text: string;
}

export interface MergeRequest {
	session: string;
	/** The child channel to merge from. */
	channel: string;
	strategy?: "ours" | "theirs";
}

export interface MergeResult {
	status: "merged" | "conflict" | "nothing";
	fs?: string;
	conflicts?: Array<{ path: string; kind?: string }>;
	reason?: string;
	message: string;
}

/** What the bot must implement for the control surface. */
export interface ControlHandlers {
	spawn(request: SpawnRequest): Promise<SpawnResult>;
	send(request: SendRequest): Promise<void>;
	merge(request: MergeRequest): Promise<MergeResult>;
}

export interface ControlServer {
	readonly url: string;
	readonly token: string;
	close(): Promise<void>;
}

function readJson(request: IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			try {
				resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8")));
			} catch (error) {
				reject(error);
			}
		});
		request.on("error", reject);
	});
}

function answer(response: ServerResponse, status: number, body: unknown): void {
	response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	response.end(JSON.stringify(body));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Start the loopback control server with a fresh token. */
export function startControlServer(handlers: ControlHandlers, options: { port?: number } = {}): Promise<ControlServer> {
	const token = randomBytes(24).toString("base64url");
	const server: Server = createServer(async (request, response) => {
		try {
			if (request.headers.authorization !== `Bearer ${token}`) {
				answer(response, 401, { error: "unauthorized" });
				return;
			}
			if (request.method !== "POST") {
				answer(response, 405, { error: "method not allowed" });
				return;
			}
			const body = await readJson(request);
			if (!isRecord(body) || typeof body.session !== "string") {
				answer(response, 400, { error: "session is required" });
				return;
			}
			switch (request.url) {
				case "/spawn": {
					if (typeof body.prompt !== "string" || body.prompt.trim().length === 0) {
						answer(response, 400, { error: "prompt is required" });
						return;
					}
					answer(
						response,
						200,
						await handlers.spawn({
							session: body.session,
							prompt: body.prompt,
							...(typeof body.name === "string" ? { name: body.name } : {}),
							...(typeof body.timeoutSeconds === "number" ? { timeoutSeconds: body.timeoutSeconds } : {}),
						}),
					);
					return;
				}
				case "/send": {
					if (typeof body.channel !== "string" || typeof body.text !== "string") {
						answer(response, 400, { error: "channel and text are required" });
						return;
					}
					await handlers.send({ session: body.session, channel: body.channel, text: body.text });
					answer(response, 200, { ok: true });
					return;
				}
				case "/merge": {
					if (typeof body.channel !== "string") {
						answer(response, 400, { error: "channel is required" });
						return;
					}
					const strategy = body.strategy === "ours" || body.strategy === "theirs" ? body.strategy : undefined;
					answer(
						response,
						200,
						await handlers.merge({
							session: body.session,
							channel: body.channel,
							...(strategy ? { strategy } : {}),
						}),
					);
					return;
				}
				default:
					answer(response, 404, { error: "unknown route" });
			}
		} catch (error) {
			answer(response, 500, { error: error instanceof Error ? error.message : String(error) });
		}
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port ?? 0, "127.0.0.1", () => {
			server.off("error", reject);
			const address = server.address();
			const port = typeof address === "object" && address !== null ? address.port : 0;
			resolve({
				url: `http://127.0.0.1:${port}`,
				token,
				close: () => new Promise<void>((done) => server.close(() => done())),
			});
		});
	});
}
