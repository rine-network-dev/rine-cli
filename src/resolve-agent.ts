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
	if (!value.includes("@")) {
		if (UUID_RE.test(value)) return value;
		throw new Error(
			`Invalid agent identifier '${value}': expected a UUID or handle (e.g. agent@org.rine.network).`,
		);
	}
	const resolved = await resolveHandleViaWebFinger(value);
	if (!UUID_RE.test(resolved)) {
		throw new Error(
			`Cannot resolve handle "${value}" to agent ID. Ensure WebFinger is available or use a UUID.`,
		);
	}
	return resolved;
}

/** Check if a value is a bare agent name (not a UUID, not a handle). */
export function isBareAgentName(value: string): boolean {
	return !value.includes("@") && !UUID_RE.test(value);
}

async function fetchAgents(
	client: HttpClient,
): Promise<AgentRead[]> {
	if (cached === undefined) {
		const data = (await client.get("/agents")) as ListResponse<AgentRead>;
		cached = data.items;
	}
	return cached;
}

/** Resolve a bare agent name against the org's agent list (case-insensitive). */
async function resolveBareName(
	client: HttpClient,
	name: string,
): Promise<string> {
	const agents = await fetchAgents(client);
	const lower = name.toLowerCase();
	const match = agents.find((a) => a.name.toLowerCase() === lower);
	if (match) return match.id;

	const lines = agents.map((a) => `  ${a.name}  ${a.handle}`).join("\n");
	throw new Error(
		agents.length > 0
			? `No agent named '${name}'. Available agents:\n${lines}`
			: `No agent named '${name}'. No active agents found.`,
	);
}

/**
 * Resolve which agent ID to use.
 * Priority: explicit --agent flag > --as global flag > auto-resolve (single-agent shortcut).
 * Accepts UUIDs, handles (e.g. "bot@org.rine.network"), or bare names (e.g. "kofi").
 */
export async function resolveAgent(
	client: HttpClient,
	explicit?: string,
	asFlag?: string,
): Promise<string> {
	if (explicit) {
		if (isBareAgentName(explicit)) return resolveBareName(client, explicit);
		return resolveToUuid(explicit);
	}
	if (asFlag) {
		if (isBareAgentName(asFlag)) return resolveBareName(client, asFlag);
		return resolveToUuid(asFlag);
	}

	const agents = await fetchAgents(client);

	if (agents.length === 1) {
		const agent = agents[0];
		if (agent) return agent.id;
	}

	if (agents.length === 0) {
		throw new Error(
			"No active agents. Create one with 'rine agent create --name <name>'",
		);
	}

	const lines = agents.map((a) => `  ${a.id}  ${a.handle}`).join("\n");
	throw new Error(
		`Multiple agents found. Specify with --agent <uuid>:\n${lines}`,
	);
}
