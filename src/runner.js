import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

const mode = process.env.LOAD_MODE || "http-get";
const intEnv = (name, fallback, min = 1) => {
	const value = process.env[name];
	if (value === undefined || value === "") return fallback;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < min) throw new Error(`${name} must be an integer >= ${min}`);
	return parsed;
};
const numberEnv = (name, fallback, min = 0) => {
	const value = process.env[name];
	if (value === undefined || value === "") return fallback;
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < min) throw new Error(`${name} must be a number >= ${min}`);
	return parsed;
};

function readJsonEnv(name, fallback) {
	if (!process.env[name]) return fallback;
	try {
		return JSON.parse(process.env[name]);
	} catch {
		throw new Error(`${name} must contain valid JSON`);
	}
}

async function readJsonFile(file) {
	return JSON.parse(await fs.readFile(path.resolve(file), "utf8"));
}

function seconds(value) {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
	const match = String(value).match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/);
	if (!match) throw new Error(`Invalid phase duration: ${value}`);
	const scale = { ms: 0.001, s: 1, m: 60, h: 3600 }[match[2]];
	const result = Number(match[1]) * scale;
	if (result <= 0) throw new Error("Phase durations must be positive.");
	return result;
}

function getPhases() {
	const phases = readJsonEnv("PROFILE_JSON", null);
	const result = phases || [{ name: "steady", duration: numberEnv("DURATION_SECONDS", 10, 0.1), rate: intEnv("RATE", 1) }];
	if (!Array.isArray(result) || !result.length) throw new Error("PROFILE_JSON must be a non-empty array of phases.");
	return result.map((phase, index) => {
		if (!phase || !Number.isFinite(Number(phase.rate)) || Number(phase.rate) < 1) {
			throw new Error(`Profile phase ${index + 1} needs a positive rate.`);
		}
		return {
			name: String(phase.name || `phase-${index + 1}`),
			durationSeconds: seconds(phase.duration),
			rate: Number(phase.rate)
		};
	});
}

function startMonitors() {
	const intervalMs = intEnv("MONITOR_INTERVAL_MS", 5000);
	const healthUrl = process.env.HEALTH_URL;
	const observationUrl = process.env.OBSERVATION_URL;
	const health = [];
	const observations = [];
	let stopped = false;
	let timer;
	let inFlight = Promise.resolve();
	const poll = async () => {
		if (stopped) return;
		const timestamp = new Date().toISOString();
		const requests = [];
		if (healthUrl) requests.push((async () => {
			const started = performance.now();
			try {
				const response = await fetch(healthUrl, { signal: AbortSignal.timeout(Math.min(intervalMs, 5000)) });
				health.push({ timestamp, ok: response.ok, status: response.status, latencyMs: performance.now() - started });
				await response.body?.cancel();
			} catch (error) {
				health.push({ timestamp, ok: false, error: error.message, latencyMs: performance.now() - started });
			}
		})());
		if (observationUrl) requests.push((async () => {
			try {
				const response = await fetch(observationUrl, { signal: AbortSignal.timeout(Math.min(intervalMs, 5000)) });
				const body = await response.json();
				observations.push({ timestamp, ok: response.ok, status: response.status, data: body });
			} catch (error) {
				observations.push({ timestamp, ok: false, error: error.message });
			}
		})());
		await Promise.all(requests);
		if (!stopped) timer = setTimeout(() => { inFlight = poll(); }, intervalMs);
	};
	if (healthUrl || observationUrl) inFlight = poll();
	return {
		stop: async () => { stopped = true; clearTimeout(timer); await inFlight; },
		result: () => ({
			health: healthUrl ? {
				url: healthUrl,
				checks: health.length,
				failures: health.filter((sample) => !sample.ok).length,
				availability: health.length ? health.filter((sample) => sample.ok).length / health.length : null,
				samples: health
			} : undefined,
			observations: observationUrl ? { url: observationUrl, samples: observations } : undefined
		})
	};
}

async function resolveEnvelope() {
	if (process.env.ENVELOPE_FILE) return readJsonFile(process.env.ENVELOPE_FILE);
	const envelope = readJsonEnv("ENVELOPE_JSON", null);
	if (envelope) return envelope;
	throw new Error("Set ENVELOPE_JSON or ENVELOPE_FILE to a CoCreate request envelope.");
}

function summarize(samples) {
	const sorted = samples.slice().sort((a, b) => a - b);
	const percentile = (p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] : null;
	return {
		count: sorted.length,
		min: sorted[0] ?? null,
		average: sorted.length ? sorted.reduce((sum, value) => sum + value, 0) / sorted.length : null,
		p50: percentile(0.5),
		p95: percentile(0.95),
		p99: percentile(0.99),
		max: sorted.at(-1) ?? null
	};
}

async function loadConfiguration() {
	const configPath = path.resolve(process.env.COCREATE_CONFIG || "cocreate-server-loadtest.config.json");
	let stored = {};
	try { stored = JSON.parse(await fs.readFile(configPath, "utf8")); }
	catch (error) { if (error.code !== "ENOENT") throw new Error(`Cannot read ${configPath}: ${error.message}`); }
	const connection = {
		...stored,
		host: process.env.HOST || stored.host,
		organization_id: process.env.ORGANIZATION_ID || process.env.ORG_ID || stored.organization_id,
		apikey: process.env.API_KEY || process.env.APIKEY || stored.apikey || stored.key,
		token: process.env.TOKEN || stored.token,
		user_id: process.env.USER_ID || stored.user_id
	};
	if (!connection.host || !connection.organization_id) {
		throw new Error(`Set HOST and ORGANIZATION_ID or run npm run setup to create ${configPath}.`);
	}
	return connection;
}

async function runHttp() {
	const url = process.env.HTTP_URL;
	if (!url || !/^https?:\/\//i.test(url)) throw new Error("HTTP_URL must be an explicit http:// or https:// URL.");
	const phases = getPhases();
	const timeoutMs = intEnv("REQUEST_TIMEOUT_MS", 10000);
	const method = mode === "http-post" ? "POST" : "GET";
	if (method === "POST" && process.env.ALLOW_HTTP_POST !== "YES") {
		throw new Error("HTTP POST may change data; set ALLOW_HTTP_POST=YES after selecting a disposable test endpoint.");
	}
	const headers = readJsonEnv("HEADERS_JSON", {});
		const body = process.env.BODY_JSON || JSON.stringify({ source: "CoCreate Server Load Test", uuid: "{{UUID}}", vu: "{{VU}}", iteration: "{{ITER}}" });
	const samples = [];
	const errors = [];
	let bytesReceived = 0;
	let started = 0;
	const tasks = new Set();
	const phaseResults = [];
	for (const phase of phases) {
		const phaseStartedAt = new Date().toISOString();
		const phaseStart = performance.now();
		const phaseEnd = phaseStart + phase.durationSeconds * 1000;
		const phaseFirstTask = started;
		const plannedRequests = Math.ceil(phase.rate * phase.durationSeconds - 1e-9);
		for (let phaseIssued = 0; phaseIssued < plannedRequests; phaseIssued++) {
			const scheduledAt = phaseStart + (phaseIssued * 1000) / phase.rate;
			const delay = scheduledAt - performance.now();
			if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
			if (performance.now() >= phaseEnd) break;
			const iteration = started++;
			const requestStart = performance.now();
			const task = (async () => {
				const controller = new AbortController();
				const timeout = setTimeout(() => controller.abort(), timeoutMs);
				let status;
				try {
					const payload = body.replaceAll("{{UUID}}", randomUUID()).replaceAll("{{VU}}", "1").replaceAll("{{ITER}}", String(iteration));
					const response = await fetch(url, {
						method,
						headers: method === "POST" ? { "content-type": "application/json", ...headers } : headers,
						body: method === "POST" ? payload : undefined,
						signal: controller.signal
					});
					status = response.status;
					let responseBytes = 0;
					if (response.body) {
						for await (const chunk of response.body) {
							responseBytes += chunk.byteLength;
							bytesReceived += chunk.byteLength;
						}
					}
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					samples.push({ iteration, phase: phase.name, latencyMs: performance.now() - requestStart, status: response.status, bytesReceived: responseBytes });
				} catch (error) {
					const sample = { iteration, phase: phase.name, latencyMs: performance.now() - requestStart, status, error: error.message };
					errors.push(sample);
					samples.push(sample);
				} finally {
					clearTimeout(timeout);
				}
			})();
			tasks.add(task);
			task.finally(() => tasks.delete(task));
		}
		const phaseRemaining = phaseEnd - performance.now();
		if (phaseRemaining > 0) await new Promise((resolve) => setTimeout(resolve, phaseRemaining));
		phaseResults.push({ ...phase, startedAt: phaseStartedAt, endedAt: new Date().toISOString(), plannedRequests, startedRequests: started - phaseFirstTask, missedStarts: plannedRequests - (started - phaseFirstTask) });
	}
	await Promise.all(tasks);
	const durationSeconds = phases.reduce((total, phase) => total + phase.durationSeconds, 0);
	return {
		mode,
		target: url,
		method,
		durationSeconds,
		phases: phaseResults,
		startedRequests: started,
		completedRequests: samples.length,
		failedRequests: errors.length,
		achievedRequestsPerSecond: samples.length / durationSeconds,
		bytesReceived,
		latencyMs: summarize(samples.filter((sample) => !sample.error).map((sample) => sample.latencyMs)),
		errors: errors.slice(0, 25),
		samples
	};
}

async function runEnvelope() {
	const envelope = await resolveEnvelope();
	if (!envelope?.method) throw new Error("The envelope requires a method.");
	if (!envelope.method.endsWith(".read") && process.env.ALLOW_ENVELOPE_WRITES !== "YES") {
		throw new Error("This envelope may change data; set ALLOW_ENVELOPE_WRITES=YES after selecting disposable test data.");
	}
	const connection = await loadConfiguration();
	const clients = intEnv("SOCKET_CLIENTS", 1);
	const phases = getPhases();
	const timeoutMs = intEnv("REQUEST_TIMEOUT_MS", 15000);
	const workerUrl = new URL("./worker.js", import.meta.url);
	const reconnectDelayMs = intEnv("RECONNECT_DELAY_MS", 1000);
	const maxReconnectDelayMs = intEnv("MAX_RECONNECT_DELAY_MS", 10000);
	const workers = Array.from({ length: clients }, (_, clientIndex) => new Worker(workerUrl, { workerData: { connection, clientIndex, timeoutMs, reconnectDelayMs, maxReconnectDelayMs } }));
	const stats = { started: 0, completed: 0, failures: 0, samples: [], errors: [], reconnectEvents: [] };
	const pending = new Map();
	let readyCount = 0;
	const ready = Promise.all(workers.map((worker) => new Promise((resolve, reject) => {
		worker.on("message", (message) => {
			if (message.fatal) { reject(new Error(message.fatal)); return; }
			if (message.ready) { readyCount++; resolve(); return; }
			if (message.reconnect) { stats.reconnectEvents.push(message.reconnect); return; }
			const task = pending.get(message.taskId);
			if (!task) return;
			pending.delete(message.taskId);
			stats.completed++;
			stats.samples.push({ ...task, latencyMs: message.latencyMs, ok: message.ok, status: message.status, responseBytes: message.responseBytes, error: message.error });
			if (!message.ok) { stats.failures++; if (stats.errors.length < 25) stats.errors.push(message.error || message.status); }
			if (pending.size === 0 && schedulingDone) finish?.();
		});
		worker.once("error", reject);
		worker.once("exit", (code) => { if (code && readyCount < workers.length) reject(new Error(`Socket worker exited with code ${code}`)); });
	})));
	let readyTimeout;
	try {
		await Promise.race([
			ready,
			new Promise((_, reject) => { readyTimeout = setTimeout(() => reject(new Error("Timed out initializing CoCreate socket clients.")), timeoutMs); })
		]);
	} catch (error) {
		await Promise.all(workers.map((worker) => worker.terminate()));
		throw error;
	} finally {
		clearTimeout(readyTimeout);
	}

	let schedulingDone = false;
	let finish;
	const allDone = new Promise((resolve) => { finish = resolve; });
	const phaseResults = [];
	for (const phase of phases) {
		const phaseStartedAt = new Date().toISOString();
		const phaseStart = performance.now();
		const phaseEnd = phaseStart + phase.durationSeconds * 1000;
		const phaseFirstTask = stats.started;
		const plannedRequests = Math.ceil(phase.rate * phase.durationSeconds - 1e-9);
		for (let phaseIssued = 0; phaseIssued < plannedRequests; phaseIssued++) {
			const scheduledAt = phaseStart + (phaseIssued * 1000) / phase.rate;
			const delay = scheduledAt - performance.now();
			if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
			if (performance.now() >= phaseEnd) break;
			const iteration = stats.started++;
			const taskId = randomUUID();
			const workerIndex = iteration % workers.length;
			pending.set(taskId, { phase: phase.name, iteration, clientIndex: workerIndex });
			workers[workerIndex].postMessage({ taskId, iteration, envelope, timeoutMs });
		}
		const phaseRemaining = phaseEnd - performance.now();
		if (phaseRemaining > 0) await new Promise((resolve) => setTimeout(resolve, phaseRemaining));
		phaseResults.push({ ...phase, startedAt: phaseStartedAt, endedAt: new Date().toISOString(), plannedRequests, startedRequests: stats.started - phaseFirstTask, missedStarts: plannedRequests - (stats.started - phaseFirstTask) });
	}
	schedulingDone = true;
	if (pending.size) {
		const timeout = setTimeout(() => finish(), timeoutMs + 1000);
		await allDone;
		clearTimeout(timeout);
	}
	for (const [taskId, task] of pending) {
		stats.completed++;
		stats.failures++;
		stats.samples.push({ ...task, ok: false, error: "Load generator stopped waiting before a response arrived." });
		if (stats.errors.length < 25) stats.errors.push("Load generator stopped waiting before a response arrived.");
		pending.delete(taskId);
	}
	await Promise.all(workers.map((worker) => new Promise((resolve) => {
		const timer = setTimeout(resolve, 1000);
		worker.once("message", (message) => {
			if (message.stopped) { clearTimeout(timer); resolve(); }
		});
		worker.postMessage({ stop: true });
	})));
	await Promise.all(workers.map((worker) => worker.terminate()));
	const durationSeconds = phases.reduce((total, phase) => total + phase.durationSeconds, 0);
	return {
		mode,
		host: connection.host,
		method: envelope.method,
		organization_id: connection.organization_id,
		durationSeconds,
		phases: phaseResults,
		socketClients: clients,
		startedRequests: stats.started,
		completedRequests: stats.completed,
		failedRequests: stats.failures,
		achievedRequestsPerSecond: stats.completed / durationSeconds,
		socketReconnectEvents: stats.reconnectEvents,
		latencyMs: summarize(stats.samples.filter((sample) => sample.ok).map((sample) => sample.latencyMs)),
		errors: stats.errors,
		samples: stats.samples
	};
}

async function main() {
	const monitors = startMonitors();
	const startedAt = new Date().toISOString();
	let result;
	try {
		result = mode.startsWith("http-") ? await runHttp() : mode === "envelope" ? await runEnvelope() : null;
		if (!result) throw new Error("LOAD_MODE must be http-get, http-post, or envelope.");
	} finally {
		await monitors.stop();
	}
	Object.assign(result, monitors.result());
	result.startedAt = startedAt;
	result.finishedAt = new Date().toISOString();
	result.testId = process.env.TEST_ID || randomUUID();
	for (const sample of result.samples || []) sample.testId = result.testId;
	result.generatedAt = new Date().toISOString();
	result.generator = { hostname: os.hostname(), platform: os.platform(), arch: os.arch(), cpus: os.availableParallelism() };
	result.testEnvironment = process.env.TEST_ENVIRONMENT || "unspecified";
	result.serverSize = process.env.SERVER_SIZE || "unspecified";
	result.serverWorkers = process.env.SERVER_WORKERS || "unspecified";
	const samples = result.samples || [];
	result.sampleCount = samples.length;
	if (process.env.SAMPLES_FILE) {
		const samplesPath = path.resolve(process.env.SAMPLES_FILE);
		await fs.mkdir(path.dirname(samplesPath), { recursive: true });
		await fs.writeFile(samplesPath, samples.map((record) => JSON.stringify(record)).join("\n") + (samples.length ? "\n" : ""));
		result.sampleFile = samplesPath;
	}
	delete result.samples;
	const output = `${JSON.stringify(result, null, 2)}\n`;
	if (process.env.RESULT_FILE) {
		const resultPath = path.resolve(process.env.RESULT_FILE);
		await fs.mkdir(path.dirname(resultPath), { recursive: true });
		await fs.writeFile(resultPath, output);
	}
	process.stdout.write(output);
	if (
		result.failedRequests > 0 ||
		result.phases.some((phase) => phase.missedStarts > 0) ||
		result.health?.failures > 0
	) process.exitCode = 1;
}

main().catch((error) => {
	console.error(`Load test failed: ${error.message}`);
	process.exitCode = 1;
});
