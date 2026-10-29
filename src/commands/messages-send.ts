/**
 * `rine send` — resolve the recipient, seal the payload for it and post it.
 *
 * Registered by `messages.ts` alongside its siblings, top-level and under
 * `rine message`.
 */

import {
	type MessageRead,
	normalizeHandle,
	sealForAgent,
} from "@rine-network/core";
import type { Command } from "commander";
import { withClient } from "../action.js";
import { actorAliasOption, actorOption } from "../actor.js";
import { printError } from "../output.js";
import { x402SendExtras } from "../x402.js";
import { resolvePayload } from "./messages-payload.js";
import { printSent } from "./messages-rows.js";
import { type SealAndPost, sealForGroup } from "./messages-send-seal.js";
import { resolveSendGroup, resolveSendTarget } from "./messages-send-target.js";

/** Register `send` on the `message` command group. */
export function registerSend(parent: Command, program: Command): void {
	parent
		.command("send")
		.description("Send an encrypted message")
		.requiredOption(
			"--to <address>",
			// 🔴 It advertises no BARE name. `#logistics` — the sigil, no `@` —
			// resolves here: the sigil is what files a send as a group, and
			// `resolveGroupByHandle`'s fallback retries a handle's local part
			// against the org's own groups. The help advertises that spelling; it
			// widens no behaviour.
			//
			// 🔴 The bare-name rule holds, and this sentence must keep saying so: a
			// bare `logistics`, no sigil, is an AGENT on this surface and is sent as
			// `to_agent_id`. The CLI advertises and resolves `#logistics`, and
			// advertises and resolves NEITHER a bare `logistics` as a group. Erasing
			// the second half is a decision nobody has taken, not an omission.
			//
			// 🔴 A group's own ID is the third group spelling this slot takes: a
			// spelling this CLI accepts is either advertised here or announced when
			// it rewrites what the caller typed, and this one is both. The two
			// worked examples stay — the placeholder ban is a rule about REFUSALS.
			"Recipient: an agent handle (kofi@acme.rine.network), an agent ID, or a group — by handle (#logistics@acme.rine.network), by sigiled name (#logistics), or by the group's own ID",
		)
		.option("--type <type>", "Message type (default: rine.v1.dm)")
		.option("--payload <json>", "Message payload as JSON string")
		.option(
			"--payload-file <path>",
			"Read payload JSON from file (use - for stdin)",
		)
		.addOption(actorOption("which agent is acting, and sends"))
		.addOption(
			actorAliasOption(
				"--from <address>",
				"which agent is acting — the retired spelling of --agent (handle or agent ID)",
			),
		)
		.option("--idempotency-key <key>", "Idempotency key header")
		.option(
			"--no-marker",
			"For x402 message types: omit the cleartext status marker",
		)
		.action(
			withClient(
				program,
				async (
					ctx,
					opts: {
						to: string;
						type?: string;
						payload?: string;
						payloadFile?: string;
						from?: string;
						idempotencyKey?: string;
						marker?: boolean;
					},
				) => {
					const { client, gOpts, configDir, actingAgent } = ctx;
					const result = resolvePayload(opts.payload, opts.payloadFile);
					if ("error" in result) {
						printError(result.error);
						process.exitCode = 2;
						return;
					}
					const parsedPayload = result.parsed;

					const to = normalizeHandle(opts.to);
					const from = opts.from ? normalizeHandle(opts.from) : opts.from;

					// One ladder, whichever spelling named the sender: `--agent`,
					// the retired `--from`, the program's `--as`, `RINE_AGENT`, or
					// the org's only agent. `withClient` pinned `X-Rine-Agent`
					// while resolving, so nothing here has to carry it per call.
					const senderAgentId = await actingAgent();

					const extraHeaders: Record<string, string> = {};
					if (opts.idempotencyKey) {
						extraHeaders["Idempotency-Key"] = opts.idempotencyKey;
					}

					const target = await resolveSendTarget(ctx, opts.to, to);

					const resolvedType = opts.type ?? "rine.v1.dm";
					const body: Record<string, unknown> = { type: resolvedType };
					let sealAndPost: SealAndPost | undefined;

					// x402 types (quote/payment/receipt) carry cleartext extras: the
					// content_type/payload_schema descriptors and the optional coarse
					// status marker. rine-core validates the verbatim payload + builds
					// these; a non-x402 type returns null and sends unchanged.
					const x402 = x402SendExtras(
						resolvedType,
						parsedPayload,
						opts.marker !== false,
					);
					if (x402) {
						body.content_type = x402.content_type;
						body.payload_schema = x402.payload_schema;
						if (x402.metadata) body.metadata = x402.metadata;
					}

					// The group arm sets `to_handle` from the RESOLVED row below and
					// must not set a destination here — setting one makes the body
					// carry two, which the server refuses outright.
					if (target.kind === "agent") {
						if (to.includes("@")) {
							body.to_handle = to;
						} else {
							body.to_agent_id = to;
						}
					}

					if (from?.includes("@")) {
						body.from_handle = from;
					}

					if (target.kind === "group") {
						// Resolve the group once: the server's account of its
						// encryption is the only one a client gets, and both the
						// address below and the seal's downgrade guard read this row.
						const group = await resolveSendGroup(
							ctx,
							to,
							target.groupNamedById,
						);
						// 🔴 The wire carries the group the SERVER holds, never the
						// spelling that was typed. `POST /messages` looks `to_handle` up
						// by exact equality, and the handle fallback exists because the
						// two can differ — it resolves a handle whose ORG half is wrong.
						// Posting `to` would seal for the right group and then be
						// refused with a bare `Group not found`.
						body.to_handle = group.handle;
						sealAndPost = await sealForGroup(
							client,
							configDir,
							senderAgentId,
							group,
							parsedPayload,
							body,
						);
					} else if (target.recipientAgentId) {
						Object.assign(
							body,
							await sealForAgent(
								client,
								configDir,
								{ senderAgentId, recipientAgentId: target.recipientAgentId },
								parsedPayload,
							),
						);
					} else {
						throw new Error(
							"Cannot encrypt: unable to resolve sender or recipient. " +
								"Use UUIDs or ensure WebFinger is available.",
						);
					}

					const headers =
						Object.keys(extraHeaders).length > 0 ? extraHeaders : undefined;
					const post = (sent: Record<string, unknown>) =>
						client.post("/messages", sent, headers);
					const data = (sealAndPost
						? await sealAndPost((fields) => post({ ...body, ...fields }))
						: await post(body)) as MessageRead;

					printSent(data, gOpts.json);
				},
			),
		);
}
