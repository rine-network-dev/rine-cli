import type { Command } from "commander";
import { createEventSource } from "eventsource-client";
import { createClient } from "../action.js";
import { actorLadder } from "../acting-agent.js";
import { actorOption, namedActor } from "../actor.js";
import {
	formatError,
	jitteredDelayMs,
	jitteredRefreshMargin,
	nextReconnectBackoffSeconds,
	resolveApiUrl,
	resolveConfigDir,
	senderKeyExplainer,
	sleep,
} from "@rine-network/core";
import { loadStreamCursor, saveStreamCursor } from "./stream-cursor.js";
import { messageEventLine } from "./stream-cleartext.js";
import { formatMessageLine } from "./stream-format.js";
import { printError } from "../output.js";
import type { GlobalOpts } from "../types.js";

type DisconnectReason =
	"heartbeat_timeout" | "server_close" | "error" | "signal";

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

export function registerStream(program: Command): void {
	program
		.command("stream")
		.description("Stream incoming messages via SSE")
		.addOption(actorOption(
			"which agent is acting, and whose messages stream (name, handle, or agent ID)",
		))
		.option("--verbose", "Show heartbeats and reconnect details")
		.option("--persistent", "Disable server-side connection timeout")
		.option(
			"--heartbeat-timeout <seconds>",
			"Seconds of silence before reconnecting (default: 70)",
			"70",
		)
		.option("--monitor", "Suppress non-message stdout (for CC plugin monitors)")
		.action(async (opts: StreamOpts, command: Command) => {
			try {
				const gOpts = program.opts<GlobalOpts>();
				const configDir = resolveConfigDir();
				const apiUrl = resolveApiUrl();
				const { client, token: mintToken } = await createClient(
					apiUrl,
					gOpts.profile,
				);

				const { actingAgent } = actorLadder(namedActor(command, gOpts), client);
				const agentId = await actingAgent();

				let url = `${apiUrl}/agents/${agentId}/stream`;
				if (opts.persistent) {
					url += "?persistent=true";
				}

				const heartbeatTimeoutMs =
					Math.max(Number(opts.heartbeatTimeout) || 70, 10) * 1000;

				// Resume from the persisted cursor so a fresh process reconnects
				// from the last-seen event instead of cursorless.
				let lastEventId: string | undefined = loadStreamCursor(
					configDir,
					agentId,
				);
				let backoff = 1;
				let attempt = 0;
				let stopped = false;
				// Drawn once for this long-lived stream so co-located agents
				// desynchronize their token refreshes across reconnects.
				const refreshMargin = jitteredRefreshMargin();

				// One `rine stream` invocation is one render, so the "have I explained
				// the missing sender key yet" state lives here, in this invocation's
				// own closure, and is dropped with it.
				//
				// Deliberately OUTSIDE the reconnect loop below: a heartbeat timeout is
				// an event in the network, not in the reading — re-explaining after
				// every reconnect would make how often an agent is told depend on how
				// flaky its link is. Equally deliberately NOT at module scope, where
				// the state would outlive the stream and no test could pin it.
				const explain = senderKeyExplainer();

				// One SIGINT listener for the whole stream, not one per connection:
				// it stops the loop and closes whichever connection is open.
				let stopConnection: (() => void) | undefined;
				process.on("SIGINT", () => {
					stopped = true;
					process.exitCode = 0;
					stopConnection?.();
				});

				while (!stopped) {
					attempt++;
					const state = {
						disconnectReason: "server_close" as DisconnectReason,
					};

					try {
						const token = await mintToken({ refreshMargin });
						const headers: Record<string, string> = {
							Authorization: `Bearer ${token}`,
							Accept: "text/event-stream",
						};
						if (lastEventId) {
							headers["Last-Event-ID"] = lastEventId;
						}

						emitLifecycle(gOpts, opts.monitor, {
							state: "connecting",
							attempt,
							url,
						});

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
											console.log(messageEventLine(event, id, data));
										}
									} else if (event === "message") {
										formatMessageLine(
											data,
											agentId,
											configDir,
											client,
											explain,
										).then(
											({ line, notice }) => {
												if (notice !== null) printError(notice);
												console.log(line);
											},
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
								process.stderr.write(
									`Connected to stream for agent ${agentId}\n`,
								);
								if (opts.persistent) {
									process.stderr.write("Persistent mode (no server timeout)\n");
								}
							}
							emitLifecycle(gOpts, opts.monitor, {
								state: "connected",
								attempt,
							});

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
							stopConnection = onStop;
						});
						stopConnection = undefined;

						if (state.disconnectReason === "heartbeat_timeout") {
							const jitteredBackoff = jitteredDelayMs(backoff);
							emitLifecycle(gOpts, opts.monitor, {
								state: "reconnecting",
								reason: "heartbeat_timeout",
								attempt: attempt + 1,
								backoff_ms: jitteredBackoff,
							});
							if (!gOpts.json) {
								process.stderr.write(
									`Reconnecting (attempt ${attempt + 1}, heartbeat timeout)...\n`,
								);
							}
							await sleep(jitteredBackoff);
							backoff = nextReconnectBackoffSeconds(backoff);
						} else if (state.disconnectReason === "signal") {
							emitLifecycle(gOpts, opts.monitor, {
								state: "stopped",
								reason: "signal",
							});
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
								process.stderr.write(
									`Reconnecting (attempt ${attempt + 1}, server close)...\n`,
								);
							}
							backoff = 1;
						}
					} catch (err) {
						if (stopped) {
							emitLifecycle(gOpts, opts.monitor, {
								state: "stopped",
								reason: "signal",
							});
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
							process.stderr.write(
								`Reconnecting in ${Math.round(jitteredBackoff / 1000)}s (attempt ${attempt + 1}, error: ${errorMsg})...\n`,
							);
						} else {
							process.stderr.write(
								`Reconnecting (attempt ${attempt + 1}, error)...\n`,
							);
						}
						await sleep(jitteredBackoff);
						backoff = nextReconnectBackoffSeconds(backoff);
					}
				}
			} catch (err) {
				printError(formatError(err));
				process.exitCode = 1;
			}
		});
}
