import type { Command } from "commander";
import { createClient } from "../action.js";
import { actorLadder } from "../acting-agent.js";
import { actorOption, namedActor } from "../actor.js";
import {
	formatError,
	jitteredRefreshMargin,
	resolveApiUrl,
	resolveConfigDir,
	senderKeyExplainer,
	withPeekHeader,
} from "@rine-network/core";
import {
	type DisconnectReason,
	StreamHttpError,
	openStreamConnection,
} from "./stream-connection.js";
import { STREAM_HIDE_CONTROL_HELP } from "./hide-control.js";
import { loadStreamCursor, saveStreamCursor } from "./stream-cursor.js";
import { emitLifecycle } from "./stream-lifecycle.js";
import {
	closeStreamEnv,
	createStreamEnv,
	handleStreamEvent,
} from "./stream-message.js";
import { afterDisconnect, afterError } from "./stream-reconnect.js";
import { exitWhenFlushed, listenForStop } from "./stream-stop.js";
import { printError } from "../output.js";
import type { GlobalOpts } from "../types.js";

interface StreamOpts {
	agent?: string;
	verbose?: boolean;
	persistent?: boolean;
	heartbeatTimeout?: string;
	monitor?: boolean;
	hideControl?: boolean;
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
		.option("--hide-control", STREAM_HIDE_CONTROL_HELP)
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
				let mintFresh = false; // set by a 401: the cached token is dead
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

				// Settled rows are acknowledged in batches through `env.acks`.
				const env = createStreamEnv({
					json: Boolean(gOpts.json),
					monitor: opts.monitor,
					verbose: opts.verbose,
					hideControl: opts.hideControl,
					agentId,
					configDir,
					client,
					explain,
				});

				const stop = listenForStop();

				while (!stop.stopped) {
					attempt++;
					const startedAt = Date.now();
					const reconnect = () => ({
						gOpts,
						monitor: opts.monitor,
						verbose: opts.verbose,
						attempt,
						backoff,
						startedAt,
						stopping: stop.signal,
					});

					try {
						const token = await mintToken({ refreshMargin, force: mintFresh });
						mintFresh = false;
						// Peek on every connect: the server marks nothing delivered at
						// yield, and a row is acknowledged below once it has settled.
						const headers: Record<string, string> = withPeekHeader(
							{
								Authorization: `Bearer ${token}`,
								Accept: "text/event-stream",
							},
							true,
						);
						if (lastEventId) {
							headers["Last-Event-ID"] = lastEventId;
						}

						emitLifecycle(gOpts, opts.monitor, {
							state: "connecting",
							attempt,
							url,
						});
						let reason: DisconnectReason = "server_close";
						if (!stop.stopped) {
							const connection = openStreamConnection({
								url,
								headers,
								heartbeatTimeoutMs,
								onMessage: ({ event, data, id }) => {
									if (id) {
										lastEventId = id;
										saveStreamCursor(configDir, agentId, id);
									}

									handleStreamEvent(env, { event, data, id });
								},
							});
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
							if (stop.stopped) connection.stop();
							else stop.onStop(connection.stop);
							reason = await connection.closed;
							stop.onStop(undefined);
						}
						const next = await afterDisconnect(reason, reconnect());
						if (next === null) break;
						backoff = next;
					} catch (err) {
						mintFresh = err instanceof StreamHttpError && err.status === 401;
						const next = await afterError(err, stop.stopped, reconnect());
						if (next === null) break;
						backoff = next;
					}
				}
				await closeStreamEnv(env);
				// A bounded close can leave an abandoned request holding the event
				// loop open; end the process with the status already chosen.
				await exitWhenFlushed(process.exitCode ?? 0);
			} catch (err) {
				printError(formatError(err));
				process.exitCode = 1;
			}
		});
}
