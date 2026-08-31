import {
	RineApiError,
	holdsMlsState,
	loadMlsGroup,
	openMlsClient,
} from "@rine-network/core";

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
 * agent normally reaches. `has_read_access` (`src/rine/api/group_helpers.py`)
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
