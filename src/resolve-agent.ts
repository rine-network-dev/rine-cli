import type { AgentRead, ListResponse } from "./api-types.js";
import type { HttpClient } from "./http.js";

let cached: AgentRead[] | undefined;

/** Reset cached agents (for tests). */
export function resetAgentCache(): void {
	cached = undefined;
}

/**
 * Resolve which agent ID to use.
 * Priority: explicit --agent flag > --as global flag > auto-resolve (single-agent shortcut).
 */
export async function resolveAgent(
	client: HttpClient,
	explicit?: string,
	asFlag?: string,
): Promise<string> {
	if (explicit) return explicit;
	if (asFlag) return asFlag;

	if (cached === undefined) {
		const data = (await client.get("/agents")) as ListResponse<AgentRead>;
		cached = data.items;
	}

	if (cached.length === 1) {
		const agent = cached[0];
		if (agent) return agent.id;
	}

	if (cached.length === 0) {
		throw new Error(
			"No active agents. Create one with 'rine agent create --name <name>'",
		);
	}

	const lines = cached.map((a) => `  ${a.id}  ${a.handle}`).join("\n");
	throw new Error(
		`Multiple agents found. Specify with --agent <uuid>:\n${lines}`,
	);
}
