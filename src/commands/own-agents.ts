import type { AgentRead } from "@rine-network/core";

/**
 * This org's agent ids resolved to handles, for the one cell that prints them.
 *
 * ## The stated rule
 *
 * `member_agent_ids` is a list of UUIDs on the wire and stays one — the
 * resolution is a rendering step, done client-side against the org's own agent
 * list, and it depends on no field the deployed server does not already send.
 * Every surface renders the same three cases:
 *
 * 1. A seated id this org knows prints its **handle**, never its name. A name
 *    is not a value that can be handed back: `X-Rine-Agent` takes a UUID or a
 *    handle and refuses a bare name, so printing the name would trade a value
 *    the operator can paste for one they cannot.
 * 2. A seated id with no handle prints **the id** — an agent whose org has no
 *    slug yet has no handle to print, and a UUID is still actionable.
 * 3. An empty or absent list prints `NO_OWN_AGENTS` (`./group-rows.js`),
 *    unchanged.
 *
 * ## Why it never throws
 *
 * The group read has already succeeded by the time this runs. An org whose
 * agent list fails to load gets case 2 for every id — the older rendering —
 * and never a failed `rine group get`.
 */
export type AgentHandles = ReadonlyMap<string, string>;

/**
 * Index the agent list the actor ladder has already paid for.
 *
 * `ctx.agents()` is memoised per command invocation, so a command that also
 * resolves an acting agent (`group update`, `group create`) spends nothing
 * extra here; `group get`, which names no actor, spends one `GET /agents` — and
 * only on a group where a seat would actually be spelled, because the empty
 * cell reads the same whichever map it is handed. That call is the one cost
 * accepted in exchange for a cell an operator can read; its callers own
 * the seat check, since this function is handed the list and not the group.
 *
 * Ids are lowercased on both sides of the lookup because a UUID is
 * case-insensitive and the two lists come from different responses.
 */
export async function ownAgentHandles(
	agents: () => Promise<AgentRead[]>,
): Promise<AgentHandles> {
	try {
		const list = await agents();
		return new Map(
			list
				.filter((a): a is AgentRead & { handle: string } => a.handle !== null)
				.map((a) => [a.id.toLowerCase(), a.handle]),
		);
	} catch {
		return new Map();
	}
}
