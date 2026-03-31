import type { AgentRead, ListResponse } from "./api-types.js";
import type { HttpClient } from "./http.js";
import { UUID_RE, resolveHandleViaWebFinger } from "./resolve-handle.js";

let cached: AgentRead[] | undefined;

/** Reset cached agents (for tests). */
export function resetAgentCache(): void {
	cached = undefined;
}

/**
 * Resolve a value that may be a UUID or a handle (containing @) to a UUID.
 * Handles are resolved via WebFinger. Required because local key storage
 * is indexed by UUID.
 */
export async function resolveToUuid(value: string): Promise<string> {
	if (!value.includes("@")) return value;
	const resolved = await resolveHandleViaWebFinger(value);
	if (!UUID_RE.test(resolved)) {
		throw new Error(
			`Cannot resolve handle "${value}" to agent ID. Ensure WebFinger is available or use a UUID.`,
		);
	}
	return resolved;
}

/**
 * Resolve which agent ID to use.
 * Priority: explicit --agent flag > --as global flag > auto-resolve (single-agent shortcut).
 * Accepts both UUIDs and handles (e.g. "bot@org.rine.network").
 */
export async function resolveAgent(
	client: HttpClient,
	explicit?: string,
	asFlag?: string,
): Promise<string> {
	if (explicit) return resolveToUuid(explicit);
	if (asFlag) return resolveToUuid(asFlag);

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
