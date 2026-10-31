import { parentPort, workerData } from "node:worker_threads";
import { randomBytes, randomUUID } from "node:crypto";

const clientId = randomBytes(12).toString("hex");
const frameId = randomBytes(8).toString("hex");
const socketId = randomBytes(8).toString("hex");
const pending = new Map();
const timeoutMs = workerData.timeoutMs;
const reconnectDelayMs = workerData.reconnectDelayMs;
const maxReconnectDelayMs = workerData.maxReconnectDelayMs;

function socketUrl() {
	let host = workerData.connection.host.trim();
	if (!host) throw new Error("A host is required for envelope tests.");
	if (!/^[a-z]+:\/\//i.test(host)) {
		host = `${/^(localhost|127\.|\[::1\])/.test(host) ? "ws" : "wss"}://${host}`;
	} else if (host.startsWith("https://")) host = host.replace(/^https:/, "wss:");
	else if (host.startsWith("http://")) host = host.replace(/^http:/, "ws:");
	else if (!/^wss?:\/\//i.test(host)) throw new Error("HOST must use http(s):// or ws(s)://.");

	const url = new URL(host);
	url.pathname = `/${encodeURIComponent(workerData.connection.organization_id || "")}`;
	url.search = "";
	const options = {
		socketId,
		clientId,
		clientInfo: {
			name: "CoCreate Server Load Test",
			runtime: `Node.js ${process.version}`,
			platform: process.platform,
			arch: process.arch
		},
		user_id: workerData.connection.user_id || "",
		token: workerData.connection.token || ""
	};
	return { url, protocol: encodeURIComponent(JSON.stringify(options)) };
}

const { url: connectionUrl, protocol } = socketUrl();
if (typeof WebSocket !== "function") throw new Error("Node.js global WebSocket is unavailable; use Node.js 22.4 or newer.");
let socket;
let connected = false;
let everConnected = false;
let stopRequested = false;
let reconnectTimer;
let currentReconnectDelay = reconnectDelayMs;

function finishPending(uuid, response) {
	const item = pending.get(uuid);
	if (!item) return;
	pending.delete(uuid);
	clearTimeout(item.timer);
	parentPort.postMessage({
		taskId: item.taskId,
		ok: !response?.error,
		status: response?.status || (response?.error ? "error" : "ok"),
		latencyMs: performance.now() - item.started,
		responseBytes: Buffer.byteLength(JSON.stringify(response ?? null)),
		error: response?.error
	});
}

function connect() {
	const currentSocket = new WebSocket(connectionUrl, protocol);
	socket = currentSocket;
	currentSocket.addEventListener("message", (event) => {
		let response;
		try { response = JSON.parse(String(event.data)); }
		catch { return; }
		if (response.method === "connect") {
			connected = true;
			if (everConnected) {
				parentPort.postMessage({ reconnect: { event: "reconnected", timestamp: new Date().toISOString(), clientIndex: workerData.clientIndex } });
				currentReconnectDelay = reconnectDelayMs;
			} else {
				everConnected = true;
				parentPort.postMessage({ ready: true, clientIndex: workerData.clientIndex });
			}
			return;
		}
		if (response.uuid) finishPending(response.uuid, response);
	});

	currentSocket.addEventListener("error", () => {
		if (!everConnected && !stopRequested) parentPort.postMessage({ fatal: "WebSocket connection failed." });
	});
	currentSocket.addEventListener("close", (event) => {
		if (socket !== currentSocket) return;
		connected = false;
		for (const [uuid] of pending) finishPending(uuid, { error: `WebSocket closed (${event.code}).` });
		if (stopRequested) {
			parentPort.postMessage({ stopped: true });
			return;
		}
		if (!everConnected) {
			parentPort.postMessage({ fatal: `WebSocket closed before connect (${event.code}).` });
			return;
		}
		parentPort.postMessage({ reconnect: { event: "disconnected", timestamp: new Date().toISOString(), code: event.code, clientIndex: workerData.clientIndex } });
		reconnectTimer = setTimeout(() => {
			currentReconnectDelay = Math.min(currentReconnectDelay * 2, maxReconnectDelayMs);
			connect();
		}, currentReconnectDelay);
	});
}

connect();

function replaceTokens(value, iteration) {
	if (typeof value === "string") {
		return value.replaceAll("{{VU}}", String(workerData.clientIndex))
			.replaceAll("{{ITER}}", String(iteration))
			.replaceAll("{{UUID}}", randomUUID());
	}
	if (Array.isArray(value)) return value.map((item) => replaceTokens(item, iteration));
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceTokens(item, iteration)]));
	}
	return value;
}

parentPort.on("message", ({ stop, taskId, iteration, envelope }) => {
	if (stop) {
		stopRequested = true;
		clearTimeout(reconnectTimer);
		if (socket && socket.readyState !== WebSocket.CLOSED) socket.close(1000, "load test complete");
		else parentPort.postMessage({ stopped: true });
		return;
	}
	if (!connected || socket.readyState !== WebSocket.OPEN) {
		parentPort.postMessage({ taskId, ok: false, error: "Socket is not connected.", latencyMs: 0 });
		return;
	}
	const request = replaceTokens(structuredClone(envelope), iteration);
	const uuid = randomUUID();
	Object.assign(request, {
		clientId,
		frameId,
		socketId,
		uuid,
		timeStamp: new Date().toISOString(),
		organization_id: request.organization_id || workerData.connection.organization_id
	});
	if (workerData.connection.apikey) request.apikey = workerData.connection.apikey;
	if (workerData.connection.user_id && !request.user_id) request.user_id = workerData.connection.user_id;
	const item = { taskId, started: performance.now() };
	item.timer = setTimeout(() => finishPending(uuid, { error: `Request timed out after ${timeoutMs}ms.` }), timeoutMs);
	pending.set(uuid, item);
	socket.send(JSON.stringify(request));
});

setTimeout(() => {
	if (!connected) parentPort.postMessage({ fatal: `Timed out connecting to ${connectionUrl.origin}.` });
}, timeoutMs).unref();
