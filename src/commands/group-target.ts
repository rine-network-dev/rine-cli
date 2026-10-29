/**
 * How every group verb on this CLI takes the group it acts on.
 *
 * Thirteen commands used to declare `.argument("<group-id>", "Group ID")` and
 * hand the raw string straight to `GET /groups/{id}`. That sentence was TRUE:
 * nothing on this surface called `resolveGroup`, and the server does not answer
 * `/groups/{handle}`, so a handle really was refused. Taking one is therefore a
 * user-visible WIDENING, not a help-text tidy-up — twelve verbs begin
 * accepting a handle, a name and a unique prefix here for the first time, and
 * the resolve happens in ONE place instead of thirteen. `rine thread --group`
 * is the only group reference that already climbed the ladder; its help string
 * is the one these twelve now share.
 *
 * 🔴 `GROUP_REFERENCE_HELP` stays HERE and is deliberately not hoisted into
 * `rine-core`. A constant in the shared package is a constant the Python stack
 * is then expected to twin (`GROUP_NOT_FOUND_LEAD` and `GENERIC_GROUP_NOUNS`
 * both are, and both are gated), and this is CLI help text for a CLI argument —
 * there is no Python twin to keep it honest with, so hoisting it would mint an
 * obligation nothing pays.
 *
 * 🔴 **`join` is not on this ladder.** {@link joinGroupTarget} is a separate
 * export for a separate resolver, and the two must never be collapsed: `join`
 * is aimed at a group the caller holds no seat in by definition, so the member
 * ladder's first rung — the caller's own group list — is the one thing that cannot
 * answer it.
 */

import {
	type GroupTarget,
	RineApiError,
	type SeatedGroupTarget,
	UUID_RE,
	resolveGroup,
	resolveGroupForJoin,
} from "@rine-network/core";
import type { ActionContext } from "../action.js";
import {
	asEvictionRefusal,
	asGroupAccessError,
	withEvictionPointerIfHeld,
} from "./group-eviction.js";

/**
 * What the twelve member-ladder group arguments say they take.
 *
 * Byte-for-byte the sentence `rine thread --group` already published, because
 * the two resolve through the same ladder and a caller who reads both must not
 * be told they differ.
 */
export const GROUP_REFERENCE_HELP =
	"Group handle (e.g. #logistics@acme.rine.network), name or UUID";

/**
 * What the thirteenth one says instead.
 *
 * `rine discover groups inspect` reads the PUBLIC directory, which is not the
 * caller's own group list: the member ladder's rungs — the org roster, a
 * normalised name, a unique prefix — have nothing to match against there, so
 * the widening the other twelve verbs got cannot land here. The help
 * says so, and {@link directoryGroupUuidRefusal} says it again to anyone who
 * tries.
 */
export const DIRECTORY_GROUP_ID_HELP =
	"Group UUID (the public directory indexes groups by id only — `rine discover groups` lists them with theirs)";

/**
 * The refusal `rine discover groups inspect` gives a handle or a name.
 *
 * 🔴 It does NOT open with `GROUP_NOT_FOUND_LEAD`: nothing was looked up. The
 * reference was refused on its shape, before any request, and six published
 * surfaces branch on that lead to decide which half of the directory a model is
 * sent to. Naming the two verbs that DO take a name is the whole point — a
 * refusal that only says no leaves the caller with the same question.
 */
export function directoryGroupUuidRefusal(ref: string): string {
	return (
		`'${ref}' is not a group UUID, and the public directory indexes groups by` +
		" id only. Run `rine discover groups` to find the group and its UUID, or" +
		" — for a group this org is already in — `rine group get`, which takes a" +
		" handle or a name."
	);
}

/**
 * Resolve one of the twelve member-ladder group arguments, carrying the row.
 *
 * The row comes back because {@link resolveGroup} already paid for it: its UUID
 * rung reads `GET /groups/{id}` and its two name rungs match against the org
 * roster, so a caller that re-fetches the group afterwards is buying a row it
 * was handed. Every PRE-mutation read on this CLI folds into this call. A read
 * taken AFTER the verb mutated the group does not, and must not — that one is
 * asking what the group became, which is a different question from what it was.
 *
 * 🔴 **The eviction wrap is load-bearing, not defensive.** `readableGroupById`
 * swallows exactly the 403 and 404 that `asGroupAccessError` needs and rethrows
 * the roster refusal instead, so an evicted agent naming its group by UUID
 * would be told "Group not found" and a list it is no longer on — the eviction
 * sentence pre-empted by the very read that used to raise it. The status is
 * gone by the time we catch, which is why this asks the local question
 * ({@link asEvictionRefusal}) rather than re-running the status guard.
 *
 * A `RineApiError` that reaches here is some OTHER fault — the UUID rung
 * rethrows anything that is not a 403/404 — and keeps its own message.
 */
export async function groupTarget(
	ctx: ActionContext,
	ref: string,
): Promise<SeatedGroupTarget> {
	try {
		return await resolveGroup(ctx.client, ref, {
			extraHeaders: ctx.extraHeaders,
		});
	} catch (err) {
		if (!UUID_RE.test(ref)) throw await withEvictionPointerIfHeld(ctx, err);
		const actingAgent = () => ctx.actingAgent();
		// Two shapes reach here and both are the same caller. The UUID rung
		// swallowed its own 403/404 and threw the roster refusal, which carries no
		// status — that one is decided locally. But the roster read the rung fell
		// back to can be refused too, and THAT error arrives alive: it keeps the
		// status guard, so a 500 is still a 500 and never an eviction.
		throw err instanceof RineApiError
			? await asGroupAccessError(ctx.configDir, ref, err, actingAgent)
			: await asEvictionRefusal(ctx.configDir, ref, err, actingAgent);
	}
}

/**
 * Resolve `rine group join`'s argument — the one verb aimed outside the org.
 *
 * 🔴 **`resolveGroupForJoin`, never `resolveGroup`.** The rungs differ because
 * the question differs: `join` names a group the caller holds no seat in, so
 * `GET /groups` answering nothing is this ladder's FIRST rung rather than its
 * refusal, and its UUID rung is a passthrough on purpose — there is no
 * readable row to check it against, and inventing one would be a client
 * asserting a membership fact it has not been told.
 *
 * `row` and `handle` come back UNSET for that reason, and a caller that needs
 * either asks after the join lands. No eviction wrap: an agent that holds MLS
 * state for a group it is joining is not the eviction case at all.
 *
 * Headers are the client's own defaults and nothing more — resolving the acting
 * agent here would make a multi-agent org name one before it may join, which is
 * a refusal this verb does not have today.
 */
export async function joinGroupTarget(
	ctx: ActionContext,
	ref: string,
): Promise<GroupTarget> {
	return await resolveGroupForJoin(ctx.client, ref, {
		extraHeaders: ctx.extraHeaders,
	});
}
