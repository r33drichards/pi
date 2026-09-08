/**
 * A `pi-client` byte transport over a browser WebSocket. The gateway relays the
 * bytes to the experimental server's Unix socket unchanged, so the framed CBOR
 * protocol runs end to end between this page and the server.
 */

import type { ByteTransport, ByteTransportFactory } from "@earendil-works/pi-client";

export function createWebSocketTransportFactory(url: string): ByteTransportFactory {
	return (handlers) =>
		new Promise<ByteTransport>((resolve, reject) => {
			const socket = new WebSocket(url);
			socket.binaryType = "arraybuffer";
			let connected = false;
			let terminal = false;
			const finish = (error?: Error): void => {
				if (terminal) return;
				terminal = true;
				if (!connected) reject(error ?? new Error("WebSocket closed before connecting"));
				else if (error) handlers.onError(error);
				else handlers.onClose();
			};
			socket.addEventListener("open", () => {
				connected = true;
				resolve({
					send(chunk) {
						if (socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("WebSocket is not open"));
						socket.send(chunk);
						return Promise.resolve();
					},
					close() {
						if (terminal) return;
						terminal = true;
						socket.close(1000);
					},
				});
			});
			socket.addEventListener("message", (event) => {
				if (terminal) return;
				const data = event.data;
				if (data instanceof ArrayBuffer) handlers.onData(new Uint8Array(data));
			});
			socket.addEventListener("close", (event) => {
				finish(
					event.code === 1000 || event.code === 1001 ? undefined : new Error(`WebSocket closed (${event.code})`),
				);
			});
			socket.addEventListener("error", () => finish(new Error("WebSocket error")));
		});
}
