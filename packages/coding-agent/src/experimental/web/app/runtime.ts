/**
 * Browser-side connection to the experimental server through the gateway:
 * the same `Client` and service sources the terminal client uses, over a
 * WebSocket instead of a Unix socket.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Client } from "@earendil-works/pi-client";
import { type ActivatedClientServices, activateBuiltinClientServices } from "../../client-services.ts";
import {
	createServerServiceSource,
	createSessionServiceSource,
	type ServerServiceSource,
	type SessionServiceSource,
} from "../../services/connection.ts";
import { createWebSocketTransportFactory } from "./transport.ts";

export interface WebRuntime extends ActivatedClientServices {
	readonly serverId: string;
	readonly client: Client;
	readonly server: ServerServiceSource;
	readonly session: SessionServiceSource;
	/** Fires once when the connection to the server is lost. */
	onDisconnect(listener: (reason: string) => void): () => void;
	dispose(): Promise<void>;
}

/** Where the page came from is where the gateway is; the token, if any, is in the page URL. */
export function gatewayWsUrl(location: Location): string {
	const url = new URL("/ws", location.href);
	url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
	const token = new URLSearchParams(location.search).get("token");
	if (token) url.searchParams.set("token", token);
	return url.toString();
}

export async function connectWebRuntime(location: Location): Promise<WebRuntime> {
	const info = (await (await fetch(new URL("/api/server", location.href))).json()) as { serverId: string };
	const client = await Client.connect({
		serverId: info.serverId,
		transportFactory: createWebSocketTransportFactory(gatewayWsUrl(location)),
	});
	const server = createServerServiceSource(client);
	const session = createSessionServiceSource(client);
	const disconnectListeners = new Set<(reason: string) => void>();
	client.onConnectionStateChange((change) => {
		if (change.state !== "disconnected") return;
		const reason = change.error?.message ?? "disconnected";
		for (const listener of disconnectListeners) listener(reason);
	});
	const activated = await activateBuiltinClientServices({ client, server, session });
	return {
		...activated,
		serverId: info.serverId,
		onDisconnect(listener) {
			disconnectListeners.add(listener);
			return () => disconnectListeners.delete(listener);
		},
		async dispose() {
			await session.dispose(BACKGROUND_CONTEXT).catch(() => {});
			await server.dispose(BACKGROUND_CONTEXT).catch(() => {});
			await client.dispose().catch(() => {});
		},
	};
}
