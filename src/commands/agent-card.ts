/** An agent card as the CLI edits it: read, modify, strip, put back. */

const READ_ONLY_KEYS = [
	"id",
	"agent_id",
	"created_at",
	"updated_at",
	"signatures",
];

export type AgentCard = Record<string, unknown>;

function stripReadOnly(card: AgentCard): AgentCard {
	const result = { ...card };
	for (const key of READ_ONLY_KEYS) {
		delete result[key];
	}
	return result;
}

export function setRineField(card: AgentCard, key: string, value: unknown): AgentCard {
	const rine = { ...(card.rine as Record<string, unknown> | undefined) };
	rine[key] = value;
	return { ...card, rine };
}

export async function updateCard(
	client: {
		get: (path: string) => Promise<unknown>;
		put: (path: string, body?: unknown) => Promise<unknown>;
	},
	agentId: string,
	modify: (card: AgentCard) => AgentCard | void,
): Promise<AgentCard> {
	const card = (await client.get(`/agents/${agentId}/card`)) as AgentCard;
	const updated = modify(card) ?? card;
	const result = (await client.put(
		`/agents/${agentId}/card`,
		stripReadOnly(updated),
	)) as AgentCard;
	return result;
}
