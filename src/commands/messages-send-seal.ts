/** Sealing a group send: the MLS seal-and-post, or the sender-key ratchet. */

import {
	type GroupRead,
	type HttpClient,
	MlsInitInFlightError,
	type MlsSealedFields,
	assertNoMlsDowngrade,
	encryptGroupMessage,
	groupAcceptsMlsSendOnly,
	sealAndPostMlsGroupMessage,
} from "@rine-network/core";
import { getOrCreateSenderKey } from "./sender-key-ops.js";

export type SealAndPost = (
	post: (fields: MlsSealedFields) => Promise<unknown>,
) => Promise<unknown>;

/**
 * Seal a group send: an MLS group returns the seal-and-post it needs, a
 * sender-key group has its ciphertext merged into `body`.
 *
 * The guard runs between the resolve and the branch, because reaching the
 * sender-key branch has already leaked the key (`assertNoMlsDowngrade`). No
 * fallback, no sender-key retry.
 */
export async function sealForGroup(
	client: HttpClient,
	configDir: string,
	senderAgentId: string,
	group: GroupRead,
	payload: unknown,
	body: Record<string, unknown>,
): Promise<SealAndPost | undefined> {
	// The SEND question, not the render question; `groupAcceptsMlsSendOnly`
	// documents why `mls_group_id` alone walks into a server 409 during the init
	// window.
	const mlsOnly = groupAcceptsMlsSendOnly(group);
	assertNoMlsDowngrade(configDir, senderAgentId, group.id, mlsOnly);
	if (mlsOnly) {
		// The group's own handle, never the typed spelling: the rungs accept
		// spellings that are not a handle — a UUID, a sigiled short form, an org
		// half that does not match.
		if (group.mls_group_id == null) throw new MlsInitInFlightError(group.handle);
		// Keyed by the rine group UUID.
		return (sendFields) =>
			sealAndPostMlsGroupMessage(
				{ configDir, agentId: senderAgentId, client },
				group.id,
				payload,
				sendFields,
			);
	}
	const { state, groupId } = await getOrCreateSenderKey(
		client,
		configDir,
		senderAgentId,
		group.handle,
	);
	const { result } = await encryptGroupMessage(
		configDir,
		senderAgentId,
		groupId,
		state,
		payload,
	);
	Object.assign(body, result);
	return undefined;
}
