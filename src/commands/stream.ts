import type { Command } from "commander";
import { createEventSource } from "eventsource-client";
import { createClient } from "../action.js";
import { actorLadder } from "../acting-agent.js";
import { actorOption, namedActor } from "../actor.js";
import {
  type HttpClient,
  SENDER_KEY_UNAVAILABLE_PREVIEW,
  type SenderKeyExplainer,
  type SenderKeyUnavailableError,
  agentKeysExist,
  asSenderKeyUnavailable,
  decryptGroupMessageWithRecovery,
  decryptMessage,
  formatError,
  getOrRefreshToken,
  ingestSenderKeyDistribution,
  isAuthenticityFailure,
  jitteredRefreshMargin,
  resolveApiUrl,
  resolveConfigDir,
  senderKeyExplainer,
} from "@rine-network/core";
import { loadStreamCursor, saveStreamCursor } from "./stream-cursor.js";
import { printError } from "../output.js";
import type { GlobalOpts } from "../types.js";

interface MessageData {
  /** The row's own id — what `rine message read` takes, on the one line that offers it. */
  id?: string;
  created_at?: string;
  sender_handle?: string;
  from_agent_id?: string;
  group_handle?: string;
  group_id?: string;
  type?: string;
  encrypted_payload?: string;
  encryption_version?: string;
}

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

function jitteredDelayMs(backoffSeconds: number): number {
  return Math.round(backoffSeconds * (0.5 + Math.random()) * 1000);
}

/**
 * Encryption versions the stream preview can decrypt. A payload carrying one of
 * these that still fails is reported as "[decrypt failed]" rather than the
 * misleading "[encrypted]", which is reserved for versions we never attempt.
 *
 * One failure says more than that: a group message whose sender key never
 * arrived reports {@link SENDER_KEY_UNAVAILABLE_PREVIEW}, which names the cause
 * and the move. Every other failure keeps the generic line, because nothing
 * here knows enough about it to say anything truer.
 */
const DECRYPTABLE_VERSIONS = new Set([
  "hpke-v1",
  "hpke-hybrid-v1",
  "sender-key-v1",
  "mls-v1",
]);

/**
 * One rendered stream line, plus — at most once per `rine stream` — the
 * paragraph that says why a group message could not be opened.
 *
 * The paragraph does not go IN the line. This stream is line-oriented and
 * consumed by monitors that read one message per line; a ~600-character
 * sentence spliced into a preview corrupts that for every reader of the stream,
 * so it goes beside the line instead, on the channel that is already not the
 * message channel (stderr, via `printError`).
 */
interface StreamLine {
  readonly line: string;
  readonly notice: string | null;
}

async function formatMessageLine(
  dataStr: string,
  agentId: string,
  configDir: string,
  client: HttpClient,
  explain: SenderKeyExplainer,
): Promise<StreamLine> {
  try {
    const data = JSON.parse(dataStr) as MessageData;
    const ts = (data.created_at ?? "").slice(0, 19) || "?";
    const sender = data.sender_handle ?? String(data.from_agent_id ?? "?");
    const msgType = data.type ?? "?";
    const target = data.group_handle
      ? `${data.group_handle} (${msgType})`
      : msgType;

    let preview = "[encrypted]";
    let notice: string | null = null;
    // The envelope's claim of authorship is checked against the sender the
    // server authenticated on the event. An event without one carries nothing
    // to check it against, so its payload is left sealed.
    const fromAgentId = data.from_agent_id;
    if (
      data.encrypted_payload &&
      fromAgentId &&
      agentKeysExist(configDir, agentId)
    ) {
      let result: Awaited<ReturnType<typeof decryptMessage>> | undefined;
      // Set when the one-shot recovery has had its turn and the sender key
      // still is not here — the one decrypt failure this preview can explain,
      // and it carries the sentence the paragraph is made of.
      let unavailable: SenderKeyUnavailableError | null = null;

      // Group ciphertext: the group decrypt dispatches on the version byte
      // (sender-key vs MLS) and self-heals MLS state internally (welcomes +
      // epoch sync), so the sender-key ingest retry is the only recovery this
      // path asks for — and core owns that one.
      if (
        (data.encryption_version === "sender-key-v1" ||
          data.encryption_version === "mls-v1") &&
        data.group_id
      ) {
        try {
          // The ingest-and-retry is core's, not a third copy of it here: both
          // ways it can end — the scan found nothing, or it found keys but not
          // this one — come back as the one refusal, and `[decrypt failed]`
          // names neither the cause nor the thing that fixes it.
          result = await decryptGroupMessageWithRecovery(
            client,
            configDir,
            agentId,
            data.group_id,
            data.encrypted_payload,
            fromAgentId,
          );
        } catch (err) {
          // Any other failure stays the generic line.
          unavailable = asSenderKeyUnavailable(err, data.group_id);
        }
      } else if (
        data.encryption_version === "hpke-v1" ||
        data.encryption_version === "hpke-hybrid-v1"
      ) {
        try {
          result = await decryptMessage(
            configDir,
            agentId,
            data.encrypted_payload,
            client,
            fromAgentId,
          );
        } catch {
          /* decrypt failed */
        }
      }

      if (result && isAuthenticityFailure(result.verificationStatus)) {
        // Tampered bytes, or content signed by someone other than the sender
        // the server authenticated: never previewed under that sender's name.
        preview =
          result.verificationStatus === "sender-mismatch"
            ? "[\u2717 sender mismatch]"
            : "[\u2717 invalid signature]";
      } else if (result?.plaintext !== undefined) {
        ingestSenderKeyDistribution(
          configDir,
          agentId,
          data.type ?? "",
          result,
        );
        const verified = result.verified ? "\u2713" : "?";
        preview = `[${verified}] ${result.plaintext.slice(0, 60)}`;
      } else if (unavailable !== null) {
        // The line always carries the bounded marker; the explanation, if this
        // stream has not given it yet, rides beside it as its own notice.
        //
        // The marker's whole premise is that the full sentence is one `rine
        // message read` away, and every other MULTI surface hands the operator
        // the id that read needs. A stream line did not: an operator who
        // scrolled past the once-per-stream notice had to run `rine message
        // list` and correlate by timestamp to get back to it. The id is this
        // reader's own delivery and discloses nothing the row did not, and the
        // marker stays byte-identical so no one can count distinct keys off a
        // stream.
        preview = data.id
          ? `${SENDER_KEY_UNAVAILABLE_PREVIEW} rine message read ${data.id}`
          : SENDER_KEY_UNAVAILABLE_PREVIEW;
        notice = explain(unavailable.message).notice;
      } else if (DECRYPTABLE_VERSIONS.has(data.encryption_version ?? "")) {
        preview = "[decrypt failed]";
      }
    }

    return { line: `[${ts}] ${sender} \u2192 ${target}: ${preview}`, notice };
  } catch {
    return { line: `[message] ${dataStr.slice(0, 80)}`, notice: null };
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
        const { client, profileName, entry } = await createClient(
          configDir,
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

        process.on("SIGINT", () => {
          stopped = true;
          process.exitCode = 0;
        });

        while (!stopped) {
          attempt++;
          const state = {
            disconnectReason: "server_close" as DisconnectReason,
          };

          try {
            const envToken = process.env.RINE_TOKEN;
            const token = await getOrRefreshToken(
              configDir,
              apiUrl,
              entry,
              profileName,
              {
                force: false,
                envToken,
                refreshMargin,
              },
            );
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
                      console.log(JSON.stringify({ event, id, data }));
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
                process.stderr.write(
                  `Reconnecting (attempt ${attempt + 1}, heartbeat timeout)...\n`,
                );
              }
              await new Promise((r) => setTimeout(r, jitteredBackoff));
              backoff = Math.min(backoff * 2, 30);
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
