import type { Command } from "commander";
import { createEventSource } from "eventsource-client";
import { getApiUrl } from "../config.js";
import { ingestSenderKeyDistribution } from "../crypto/ingest.js";
import { agentKeysExist } from "../crypto/keys.js";
import { decryptGroupMessage, decryptMessage } from "../crypto/message.js";
import { formatError } from "../errors.js";
import { type HttpClient, createClient, getOrRefreshToken } from "../http.js";
import { fetchAndIngestPendingSKDistributions } from "./sender-key-ops.js";
import { printError } from "../output.js";
import { resolveAgent } from "../resolve-agent.js";
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

async function formatMessageLine(
	dataStr: string,
	agentId: string,
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
		if (data.encrypted_payload && agentKeysExist(agentId)) {
			let result: Awaited<ReturnType<typeof decryptMessage>> | undefined;

			if (data.encryption_version === "sender-key-v1" && data.group_id) {
				try {
					result = await decryptGroupMessage(agentId, data.group_id, data.encrypted_payload, client);
				} catch (err) {
					const match =
						err instanceof Error &&
						err.message.match(/^unknown sender key id: (.+)$/);
					if (match) {
						const ingested = await fetchAndIngestPendingSKDistributions(
							client, agentId, match[1],
						);
						if (ingested > 0) {
							try {
								result = await decryptGroupMessage(agentId, data.group_id, data.encrypted_payload, client);
							} catch { /* retry exhausted */ }
						}
					}
				}
			} else if (data.encryption_version === "hpke-v1") {
				try {
					result = await decryptMessage(agentId, data.encrypted_payload, client);
				} catch { /* decrypt failed */ }
			}

			if (result) {
				ingestSenderKeyDistribution(agentId, data.type ?? "", result);
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
		.action(async (opts: { agent?: string; verbose?: boolean }) => {
			try {
				const gOpts = program.opts<GlobalOpts>();
				const { client, profileName, entry } = await createClient(
					gOpts.profile,
				);

				const agentId = await resolveAgent(client, opts.agent, gOpts.as);

				const apiUrl = getApiUrl();
				const url = `${apiUrl}/agents/${agentId}/stream`;
				let lastEventId: string | undefined;
				let backoff = 1;

				let stopped = false;
				process.on("SIGINT", () => {
					stopped = true;
					process.exitCode = 0;
				});

				while (!stopped) {
					try {
						const token = await getOrRefreshToken(entry, profileName, false);
						const headers: Record<string, string> = {
							Authorization: `Bearer ${token}`,
							Accept: "text/event-stream",
						};
						if (lastEventId) {
							headers["Last-Event-ID"] = lastEventId;
						}

						await new Promise<void>((resolve) => {
							if (stopped) {
								resolve();
								return;
							}
							const es = createEventSource({
								url,
								headers,
								onMessage: ({ event, data, id }) => {
									if (id) lastEventId = id;

									if (gOpts.json) {
										console.log(JSON.stringify({ event, id, data }));
									} else if (event === "message") {
										formatMessageLine(data, agentId, client).then(
											(line) => console.log(line),
											() => console.log(`[message] ${data.slice(0, 80)}`),
										);
									} else if (event === "heartbeat" && opts.verbose) {
										process.stderr.write(`[heartbeat] ${data}\n`);
									}
								},
								onDisconnect: () => resolve(),
								onScheduleReconnect: () => {
									es.close();
									resolve();
								},
							});

							const onStop = () => {
								es.close();
								resolve();
							};
							if (stopped) {
								onStop();
								return;
							}
							process.once("SIGINT", onStop);
						});

						backoff = 1;
					} catch {
						if (stopped) break;
						if (opts.verbose) {
							process.stderr.write(`Reconnecting in ${backoff}s...\n`);
						} else {
							process.stderr.write("Reconnecting...\n");
						}
						await new Promise((r) => setTimeout(r, backoff * 1000));
						backoff = Math.min(backoff * 2, 30);
					}
				}
			} catch (err) {
				printError(formatError(err));
				process.exitCode = 1;
			}
		});
}
