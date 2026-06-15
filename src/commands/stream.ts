import type { Command } from "commander";
import { createEventSource } from "eventsource-client";
import { createClient } from "../action.js";
import {
	type HttpClient,
	agentKeysExist,
	decryptGroupMessage,
	decryptMessage,
	fetchAgents,
	formatError,
	getOrRefreshToken,
	ingestSenderKeyDistribution,
	resolveAgent,
	resolveApiUrl,
	resolveConfigDir,
} from "@rine-network/core";
import { fetchAndIngestPendingSKDistributions } from "./sender-key-ops.js";
import { loadStreamCursor, saveStreamCursor } from "./stream-cursor.js";
import { printError } from "../output.js";
import type { GlobalOpts } from "../types.js";

interface MessageData {
	created_at?: string;
	sender_handle?: string;
	from_agent_id?: string;
	group_handle?: string;
	group_id?: string;
	type?: string;
	encrypted_payload?: string;
	encryption_version?: string;
}

type DisconnectReason = "heartbeat_timeout" | "server_close" | "error" | "signal";

interface StreamOpts {
	agent?: string;
	verbose?: boolean;
	persistent?: boolean;
	heartbeatTimeout?: string;
	monitor?: boolean;
}

function emitLifecycle(
	gOpts: GlobalOpts,
	monitor: boolean | undefined,
	data: Record<string, unknown>,
): void {
	if (gOpts.json) {
		const line = JSON.stringify({ event: "lifecycle", data });
		if (monitor) {
			process.stderr.write(`${line}\n`);
		} else {
			console.log(line);
		}
	}
}

function jitteredDelayMs(backoffSeconds: number): number {
	return Math.round(backoffSeconds * (0.5 + Math.random()) * 1000);
}

async function formatMessageLine(
	dataStr: string,
	agentId: string,
	configDir: string,
	client: HttpClient,
): Promise<string> {
	try {
		const data = JSON.parse(dataStr) as MessageData;
		const ts = (data.created_at ?? "").slice(0, 19) || "?";
		const sender = data.sender_handle ?? String(data.from_agent_id ?? "?");
		const msgType = data.type ?? "?";
		const target = data.group_handle
			? `${data.group_handle} (${msgType})`
			: msgType;

		let preview = "[encrypted]";
		if (data.encrypted_payload && agentKeysExist(configDir, agentId)) {
			let result: Awaited<ReturnType<typeof decryptMessage>> | undefined;

			if (data.encryption_version === "sender-key-v1" && data.group_id) {
				try {
					result = await decryptGroupMessage(configDir, agentId, data.group_id, data.encrypted_payload, client);
				} catch (err) {
					const match =
						err instanceof Error &&
						err.message.match(/^unknown sender key id: (.+)$/);
					if (match) {
						const ingested = await fetchAndIngestPendingSKDistributions(
							client, configDir, agentId, match[1],
						);
						if (ingested > 0) {
							try {
								result = await decryptGroupMessage(configDir, agentId, data.group_id, data.encrypted_payload, client);
							} catch { /* retry exhausted */ }
						}
					}
				}
			} else if (data.encryption_version === "hpke-v1") {
				try {
					result = await decryptMessage(configDir, agentId, data.encrypted_payload, client);
				} catch { /* decrypt failed */ }
			}

			if (result) {
				ingestSenderKeyDistribution(configDir, agentId, data.type ?? "", result);
				const verified = result.verified ? "\u2713" : "?";
				preview = `[${verified}] ${result.plaintext.slice(0, 60)}`;
			} else if (data.encryption_version === "hpke-v1" || data.encryption_version === "sender-key-v1") {
				preview = "[decrypt failed]";
			}
		}

		return `[${ts}] ${sender} \u2192 ${target}: ${preview}`;
	} catch {
		return `[message] ${dataStr.slice(0, 80)}`;
	}
}

export function registerStream(program: Command): void {
	program
		.command("stream")
		.description("Stream incoming messages via SSE")
		.option("--agent <id>", "Agent ID to stream (defaults to your agent)")
		.option("--verbose", "Show heartbeats and reconnect details")
		.option("--persistent", "Disable server-side connection timeout")
		.option("--heartbeat-timeout <seconds>", "Seconds of silence before reconnecting (default: 70)", "70")
		.option("--monitor", "Suppress non-message stdout (for CC plugin monitors)")
		.action(async (opts: StreamOpts) => {
			try {
				const gOpts = program.opts<GlobalOpts>();
				const configDir = resolveConfigDir();
				const apiUrl = resolveApiUrl();
				const { client, profileName, entry } = await createClient(
					configDir,
					apiUrl,
					gOpts.profile,
				);

				const agents = await fetchAgents(client);
				const agentId = await resolveAgent(apiUrl, agents, opts.agent, gOpts.as);

				let url = `${apiUrl}/agents/${agentId}/stream`;
				if (opts.persistent) {
					url += "?persistent=true";
				}

				const heartbeatTimeoutMs = Math.max(Number(opts.heartbeatTimeout) || 70, 10) * 1000;

				// Resume from the persisted cursor so a fresh process reconnects
				// from the last-seen event instead of cursorless (REQ-SSE-05).
				let lastEventId: string | undefined = loadStreamCursor(configDir, agentId);
				let backoff = 1;
				let attempt = 0;
				let stopped = false;

				process.on("SIGINT", () => {
					stopped = true;
					process.exitCode = 0;
				});

				while (!stopped) {
					attempt++;
					const state = { disconnectReason: "server_close" as DisconnectReason };

					try {
						const envToken = process.env.RINE_TOKEN;
						const token = await getOrRefreshToken(configDir, apiUrl, entry, profileName, {
							force: false,
							envToken,
						});
						const headers: Record<string, string> = {
							Authorization: `Bearer ${token}`,
							Accept: "text/event-stream",
						};
						if (lastEventId) {
							headers["Last-Event-ID"] = lastEventId;
						}

						emitLifecycle(gOpts, opts.monitor, { state: "connecting", attempt, url });

						await new Promise<void>((resolve) => {
							if (stopped) {
								resolve();
								return;
							}

							let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;

							const resetHeartbeatTimer = () => {
								if (heartbeatTimer) clearTimeout(heartbeatTimer);
								heartbeatTimer = setTimeout(() => {
									state.disconnectReason = "heartbeat_timeout";
									es.close();
									resolve();
								}, heartbeatTimeoutMs);
							};

							const es = createEventSource({
								url,
								headers,
								onMessage: ({ event, data, id }) => {
									resetHeartbeatTimer();

									if (id) {
										lastEventId = id;
										saveStreamCursor(configDir, agentId, id);
									}

									if (gOpts.json) {
										if (!opts.monitor || event === "message") {
											console.log(JSON.stringify({ event, id, data }));
										}
									} else if (event === "message") {
										formatMessageLine(data, agentId, configDir, client).then(
											(line) => console.log(line),
											() => console.log(`[message] ${data.slice(0, 80)}`),
										);
									} else if (event === "heartbeat" && opts.verbose) {
										process.stderr.write(`[heartbeat] ${data}\n`);
									}
								},
								onDisconnect: () => {
									if (heartbeatTimer) clearTimeout(heartbeatTimer);
									state.disconnectReason = "server_close";
									resolve();
								},
								onScheduleReconnect: () => {
									if (heartbeatTimer) clearTimeout(heartbeatTimer);
									es.close();
									resolve();
								},
							});

							// Start heartbeat timer and emit connected
							resetHeartbeatTimer();
							if (attempt === 1 && !gOpts.json) {
								process.stderr.write(`Connected to stream for agent ${agentId}\n`);
								if (opts.persistent) {
									process.stderr.write("Persistent mode (no server timeout)\n");
								}
							}
							emitLifecycle(gOpts, opts.monitor, { state: "connected", attempt });

							const onStop = () => {
								if (heartbeatTimer) clearTimeout(heartbeatTimer);
								state.disconnectReason = "signal";
								es.close();
								resolve();
							};
							if (stopped) {
								onStop();
								return;
							}
							process.once("SIGINT", onStop);
						});

						if (state.disconnectReason === "heartbeat_timeout") {
							const jitteredBackoff = jitteredDelayMs(backoff);
							emitLifecycle(gOpts, opts.monitor, {
								state: "reconnecting",
								reason: "heartbeat_timeout",
								attempt: attempt + 1,
								backoff_ms: jitteredBackoff,
							});
							if (!gOpts.json) {
								process.stderr.write(`Reconnecting (attempt ${attempt + 1}, heartbeat timeout)...\n`);
							}
							await new Promise((r) => setTimeout(r, jitteredBackoff));
							backoff = Math.min(backoff * 2, 30);
						} else if (state.disconnectReason === "signal") {
							emitLifecycle(gOpts, opts.monitor, { state: "stopped", reason: "signal" });
							break;
						} else {
							// Server-initiated close (heartbeat limit or clean close)
							emitLifecycle(gOpts, opts.monitor, {
								state: "reconnecting",
								reason: "server_close",
								attempt: attempt + 1,
								backoff_ms: 0,
							});
							if (!gOpts.json) {
								process.stderr.write(`Reconnecting (attempt ${attempt + 1}, server close)...\n`);
							}
							backoff = 1;
						}
					} catch (err) {
						if (stopped) {
							emitLifecycle(gOpts, opts.monitor, { state: "stopped", reason: "signal" });
							break;
						}
						const errorMsg = err instanceof Error ? err.message : String(err);
						const jitteredBackoff = jitteredDelayMs(backoff);
						emitLifecycle(gOpts, opts.monitor, {
							state: "reconnecting",
							reason: "error",
							attempt: attempt + 1,
							backoff_ms: jitteredBackoff,
							error: errorMsg,
						});
						if (opts.verbose) {
							process.stderr.write(`Reconnecting in ${Math.round(jitteredBackoff / 1000)}s (attempt ${attempt + 1}, error: ${errorMsg})...\n`);
						} else {
							process.stderr.write(`Reconnecting (attempt ${attempt + 1}, error)...\n`);
						}
						await new Promise((r) => setTimeout(r, jitteredBackoff));
						backoff = Math.min(backoff * 2, 30);
					}
				}
			} catch (err) {
				printError(formatError(err));
				process.exitCode = 1;
			}
		});
}
