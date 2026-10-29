import {
	GROUP_NOT_FOUND_LEAD,
	RineApiError,
	holdsAnyMlsState,
	holdsMlsState,
	loadMlsGroup,
	namesASeatedSibling,
	openMlsClient,
	withEvictionPointer,
} from "@rine-network/core";
import type { ActionContext } from "../action.js";

const EVICTED_EXPLAINED =
	"A Remove commit evicted this agent's leaf from the group's ratchet tree, so" +
	" it can no longer send to the group, read anything committed since, or admit" +
	" anyone. Ask an admin to invite you again — returning takes a fresh" +
	" invitation and a new Welcome, not the keys this agent still holds.";

/**
 * What rine says when the native core reports this agent's handle is retired.
 *
 * `isActive()` goes false exactly once: a Remove commit evicted this member's
 * leaf. Until eviction shipped nothing ever sent that commit, so the state was
 * unreachable and every surface would have shown whatever the mls-rs binding
 * said. An evicted agent is told it was evicted, in rine's words, and what to
 * do about it.
 */
export function evictedMessage(groupId: string): string {
	return `You were removed from group ${groupId}. ${EVICTED_EXPLAINED}`;
}

/**
 * True when a Remove commit has already evicted this agent from the group.
 *
 * Local and network-free: the ratchet tree is what knows, and it is on disk.
 * Null means the question could not be answered — no local state, no key
 * material, an unreadable store — which is not the same as "still a member".
 */
export function isEvictedFrom(
	configDir: string,
	agentId: string,
	groupId: string,
): boolean | null {
	try {
		const group = loadMlsGroup(openMlsClient(configDir, agentId), groupId);
		return group === null ? null : !group.isActive();
	} catch {
		return null;
	}
}

/**
 * Re-word a group read the server refused, when this agent's own MLS state says
 * it used to be a member.
 *
 * This is the case eviction detection exists for and the only one an evicted
 * agent normally reaches. `has_read_access` (`src/rine/api/group_scope.py`)
 * 403s an evicted agent from another org, so the read never returns a group at
 * all — a check that runs on the response body cannot fire, and the operator
 * gets a bare refusal identical to the one an agent who was never a member
 * gets.
 *
 * `holdsMlsState` is what answers it, not `isEvictedFrom`: holding local MLS
 * state for a group the server will not let you read means one thing, whereas
 * `isActive()` turns false only once the Remove commit has been applied
 * locally, and an evicted agent has no reason to have synced. Everything else
 * is returned untouched, so an agent who was never a member still gets the
 * server's own answer, and an open (Sender-Keys) group — which holds no MLS
 * state and has no cryptographic eviction at all — is never described
 * as one.
 *
 * A refusal that names a seated sibling of this org is returned untouched too:
 * nobody was evicted, and the server's own sentence carries the remedy (retry
 * as that sibling). `namesASeatedSibling` needs the retry instruction as well
 * as the not-a-member clause, so the "no agent of your org is" arm — which a
 * genuinely evicted agent in a single-agent org reads — still gets the
 * eviction wording. The MCP twin (`rine-mcp/src/tools/group-eviction.ts`)
 * applies the same rule.
 *
 * The acting agent is resolved through a callback and only on the refusal path,
 * so a read that succeeded costs no extra round trip.
 */
export async function asGroupAccessError(
	configDir: string,
	groupId: string,
	err: unknown,
	actingAgent: () => Promise<string>,
): Promise<unknown> {
	if (!(err instanceof RineApiError)) return err;
	if (err.status !== 403 && err.status !== 404) return err;
	if (namesASeatedSibling(err.detail)) return err;
	return await asEvictionRefusal(configDir, groupId, err, actingAgent);
}

/**
 * The same rewrite, for a refusal whose status has already been swallowed.
 *
 * `resolveGroup`'s UUID rung catches exactly the 403/404 the guard above needs
 * and rethrows the roster refusal in its place, so a verb that resolves its
 * argument before it reads has no status left to branch on — only the local
 * question, which is the one that actually decides it. Its own export rather
 * than a loosening of the guard above: a caller still holding a live
 * `RineApiError` must prove the status, or a 500 comes back as an eviction.
 */
export async function asEvictionRefusal(
	configDir: string,
	groupId: string,
	err: unknown,
	actingAgent: () => Promise<string>,
): Promise<unknown> {
	try {
		if (!holdsMlsState(configDir, await actingAgent(), groupId)) return err;
	} catch {
		// Cannot tell which agent is reading, or the store is unreadable. Either
		// way this is not provably an eviction.
		return err;
	}
	return new Error(evictedMessage(groupId), { cause: err });
}

/**
 * Widen an unknown-group refusal with the eviction pointer, where it applies.
 *
 * The arm above it — a reference that is not a UUID — is where the eviction
 * sentence is unreachable: the ladder resolved to no row, so there is
 * no group id to ask `holdsMlsState` with, and an evicted agent naming its
 * group by handle reads "Group not found" over a roster it is no longer on.
 * That case is answered with a POINTER instead, composed in `rine-core`
 * beside the refusal it grows onto.
 *
 * Three gates, in this order and lazily, which is the whole cost argument:
 *
 * 1. the error is the UNKNOWN-group refusal, decided by the lead six published
 *    surfaces already branch on. 🔴 An AMBIGUOUS reference opens with a
 *    different lead and must not get this — it resolved to too many rows, not
 *    to none — and neither must a transport failure, which opens with neither;
 * 2. only then {@link ActionContext.actingAgent}, which costs a round trip on
 *    a multi-agent org;
 * 3. only then the local store scan.
 *
 * Either of the last two raising returns the error untouched, exactly as
 * {@link asEvictionRefusal} does: a store that cannot be read, or a caller
 * whose acting agent cannot be named, has not proved anything about a removal.
 *
 * 🔴 Not threaded down into `matchGroupByName`. That function is synchronous
 * and a published export of `@rine-network/core`, `actingAgent()` is async, and
 * computing the fact eagerly would pay it on every group verb call rather than
 * on the refusal path it is confined to.
 *
 * 🔴 Exported because `groupTarget` is not the only place these two
 * spellings are refused. `rine send --to '#standup@acme.rine.network'` does not
 * climb this ladder — it calls `resolveGroupByHandle` itself — and `send` is
 * the verb an evicted agent is most likely to reach for. One group, one
 * spelling, two different answers on two verbs is the inconsistency this
 * trigger exists to end, so it is shared rather than re-derived.
 *
 * 🔴 It stays off the JOIN path. `joinGroupTarget` names a group this org
 * holds no seat in BY DEFINITION, so "you may have been removed" is nonsense
 * there, not a milder version of the truth.
 */
export async function withEvictionPointerIfHeld(
	ctx: ActionContext,
	err: unknown,
): Promise<unknown> {
	if (!(err instanceof Error)) return err;
	if (!err.message.startsWith(GROUP_NOT_FOUND_LEAD)) return err;
	try {
		if (!holdsAnyMlsState(ctx.configDir, await ctx.actingAgent())) return err;
	} catch {
		return err;
	}
	return new Error(withEvictionPointer(err.message), { cause: err });
}
