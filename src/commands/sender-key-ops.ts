import {
	type HttpClient,
	type MessageRead,
	type PaginatedResponse,
	decryptMessage,
	ingestSenderKeyDistribution,
} from "@rine-network/core";

// Re-export from core so existing CLI imports keep working
export {
	distributeSenderKey,
	getOrCreateSenderKey,
} from "@rine-network/core";

/**
 * Fetch pending sender key distributions from the inbox and ingest them.
 * Used by `read` and `stream` to auto-recover when a sender key is missing.
 *
 * Optionally short-circuits once `targetSenderKeyId` is ingested.
 * Returns the number of newly ingested keys.
 */
export async function fetchAndIngestPendingSKDistributions(
	client: HttpClient,
	configDir: string,
	agentId: string,
	targetSenderKeyId?: string,
): Promise<number> {
	const inbox = (await client.get(`/agents/${agentId}/messages`, {
		type: "rine.v1.sender_key_distribution",
		limit: 100,
	})) as PaginatedResponse<MessageRead>;

	let ingested = 0;
	for (const msg of inbox.items) {
		try {
			const full = (await client.get(
				`/messages/${msg.id}`,
			)) as MessageRead;
			const result = await decryptMessage(
				configDir,
				agentId,
				full.encrypted_payload,
				client,
			);
			if (ingestSenderKeyDistribution(configDir, agentId, full.type, result)) {
				ingested++;
				if (targetSenderKeyId) {
					const dist = JSON.parse(result.plaintext) as {
						sender_key_id: string;
					};
					if (dist.sender_key_id === targetSenderKeyId) break;
				}
			}
		} catch {
			// Skip undecryptable or already-ingested distributions
		}
	}
	return ingested;
}
