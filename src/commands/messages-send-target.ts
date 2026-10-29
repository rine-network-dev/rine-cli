/**
 * Who `rine send` is addressing: a group or an agent, and which one.
 *
 * The classification and the agent lookup run before the body is built; the
 * group row is read later, by `resolveSendGroup`, between the body and the seal.
 */

import {
	type GroupRead,
	readableGroupById,
	resolveGroupByHandle,
	resolveToUuid,
	UUID_RE,
} from "@rine-network/core";
import type { ActionContext } from "../action.js";
import { announceHandleCompletion } from "../handle-completion.js";
import { printError } from "../output.js";
import { withEvictionPointerIfHeld } from "./group-eviction.js";

export type SendTarget =
	| { readonly kind: "group"; readonly groupNamedById: GroupRead | undefined }
	| { readonly kind: "agent"; readonly recipientAgentId: string };

/**
 * What a caller is told when the ID they typed named a group, not an agent.
 *
 * 🔴 It quotes the caller's own spelling and the handle the wire will carry,
 * and nothing else. A third handle would be a placeholder in a sentence about
 * a real send, and an `@org` slot for the caller to fill would advertise a
 * spelling this notice is not about.
 *
 * 🔴 It stays on this surface rather than moving into `@rine-network/core`,
 * for `GROUP_REFERENCE_HELP`'s reason (`group-target.ts`): a constant in the
 * shared package is a constant the Python stack is then expected to twin and a
 * gate is expected to hold, and this is one CLI's rendering of a substitution
 * the shared door discharges through its RETURN VALUE — `RecipientTarget`
 * carries `spelling` beside `handle` so every other surface can compare the
 * two and say it in its own idiom. Hoisting it would mint an obligation
 * nothing pays.
 */
function groupIdRecipientNote(spelling: string, handle: string): string {
	return `Note: '${spelling}' is a group ID, so this was addressed to the group '${handle}' and not to an agent.`;
}

/**
 * Classify the recipient, `typed` as the caller wrote it and `to` normalised.
 *
 * 🔴 The sigil decides this, not the `@`. A group is named
 * `#logistics@acme.rine.network` OR `#logistics`, and the second spelling has
 * no `@`: read by the `@` alone it would become `to_agent_id` while the group
 * branch sets `to_handle`, and `MessageCreate.check_exactly_one_destination`
 * refuses both (`schemas_message.py`) after the message has been sealed. A BARE
 * `logistics`, no sigil, is an agent on this surface and resolves as one.
 *
 * 🔴 The second thing that decides it is a READ, and it is the only spelling on
 * this surface that spends one to be classified. An ID names an entity, not a
 * namespace, so the namespaces are asked in the order their SCOPES rank:
 * `GET /groups/{id}` answers only for a group this caller's credential reads
 * (an org key: one its org owns or is seated in; an agent or branch key: one
 * seated in its scope), while `GET /agents/{id}/keys` is unauthenticated and global —
 * asking the agent side first would prefer a stranger's namespace over the
 * caller's own org's.
 *
 * 🔴 `readableGroupById` and never a hand-rolled read of the same route: it is
 * the one place that turns a 404 and a 403 into the same miss and refuses a
 * body naming a group nobody asked about. And never `groupTarget`/
 * `resolveGroup`, which buy the roster and THROW on a miss — a throw here would
 * refuse every agent ID.
 *
 * 🔴 This is a UUID-ONLY rung, not a migration onto `resolveRecipient`. That
 * door reads a BARE word as a group, and this surface reads it as an agent;
 * routing `send` through it would silently turn `--to logistics` into a group
 * send, and nothing in `rine-core` would go red for it.
 */
export async function resolveSendTarget(
	{ client, apiUrl }: ActionContext,
	typed: string,
	to: string,
): Promise<SendTarget> {
	const groupNamedById = UUID_RE.test(to)
		? await readableGroupById(client, to)
		: undefined;
	if (to.startsWith("#") || groupNamedById !== undefined) {
		// 🔴 No silent acceptance. An ID resolved in the group namespace is a
		// rewrite of what the caller typed — the wire carries a handle they never
		// wrote — and stdout carries only the send result, so the notice goes to
		// stderr and is NOT gated on `--json`: a machine reader is the caller a
		// silent rewrite harms most, and stdout stays byte-for-byte parseable
		// because the notice was never on it.
		if (groupNamedById !== undefined) {
			printError(groupIdRecipientNote(typed, groupNamedById.handle));
		}
		return { kind: "group", groupNamedById };
	}
	// A group has no recipient agent; an agent ID is its own recipient.
	if (!to.includes("@")) return { kind: "agent", recipientAgentId: to };
	// 🔴 A completed handle is announced: the message goes to whoever the
	// completed handle names, and a silent completion tells the caller nothing.
	//
	// 🔴 `typed`, NOT `to`. `to` is already normalised, so comparing it against
	// its own normalisation can never differ; handed `to`, the notice is dead
	// code that reads exactly like a working one.
	announceHandleCompletion(typed);
	return { kind: "agent", recipientAgentId: await resolveToUuid(apiUrl, to) };
}

/**
 * The group row a send is sealed for and addressed to.
 *
 * 🔴 The refusal is widened the same way the member-ladder verbs widen theirs.
 * `send` does not climb that ladder — it resolves the handle here — so without
 * this an evicted agent gets the pointer from `rine group get` and a bare
 * roster refusal from `rine send`, on the same spelling of the same group.
 * `registerSend` resolves the acting agent before it gets here, so the gate's
 * `actingAgent()` costs no round trip. The ID rung already holds the row it
 * read, so the handle lookup runs only for the two sigiled spellings.
 */
export async function resolveSendGroup(
	ctx: ActionContext,
	to: string,
	groupNamedById: GroupRead | undefined,
): Promise<GroupRead> {
	return (
		groupNamedById ??
		(await resolveGroupByHandle(ctx.client, to).catch(
			async (err): Promise<never> => {
				throw await withEvictionPointerIfHeld(ctx, err);
			},
		))
	);
}
