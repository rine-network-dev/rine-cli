import {
	ACTING_AGENT_ENV,
	ACTING_AGENT_HEADER,
	type AgentRead,
	type HttpClient,
	type ResolvedActor,
	UUID_RE,
	actorFromEnv,
	fetchAgents,
	resolveAgent,
} from "@rine-network/core";
import { printError } from "./output.js";

/**
 * The acting-agent ladder, in the one place the CLI climbs it.
 *
 * Rung 1 — what the caller typed — is settled before this module sees it, by
 * `actor.ts`, because two spellings that disagree have to refuse before the
 * call costs a round trip. What is left is the environment, the org's only
 * agent, and the refusal that names them all.
 */

/**
 * One line of provenance, on stderr, and only when it disambiguates.
 *
 * A single-agent org has nothing to disambiguate and hears nothing; a caller
 * who typed the actor already knows. stdout — and therefore `--json` — is
 * untouched either way.
 */
function announceEnvActor(agents: readonly AgentRead[], agentId: string): void {
	if (agents.length < 2) return;
	const agent = agents.find((a) => a.id === agentId);
	printError(`acting as ${agent?.name ?? agentId} (from ${ACTING_AGENT_ENV})`);
}

/**
 * The other half of that provenance: say so when the environment's choice is
 * what *failed*.
 *
 * A caller who exported `RINE_AGENT` months ago and then renamed the agent
 * reads "No agent named 'ops'" and looks for where they typed `ops` — and in a
 * single-agent org, where the server used to pick the only agent regardless,
 * they have no reason at all to suspect an environment variable. Naming the
 * rung costs one clause and turns an unfalsifiable error into a one-step fix.
 *
 * ⚠️ Multi-agent orgs only, now: a one-agent org resolves a stale `RINE_AGENT`
 * to its only agent and warns, so there is no throw here to decorate. The
 * warning carries that case, and names `RINE_AGENT` itself when the value came
 * off that rung (see `resolve()` below).
 */
function blameEnvActor(err: unknown): never {
	const message = err instanceof Error ? err.message : String(err);
	throw new Error(`${message}\n(the acting agent came from ${ACTING_AGENT_ENV}.)`);
}

/** The org's agents and its acting agent, each fetched at most once. */
export interface ActorLadder {
	/**
	 * The actor a rung above the org's agent list named — the flag, or
	 * `RINE_AGENT` — before any round trip resolves it.
	 *
	 * 🔴 The pin decision reads this, never the flag alone. A caller who
	 * exported `RINE_AGENT` said which agent acts just as plainly as one who
	 * typed `--agent`, and a command that never asks for the id (`group join`,
	 * `group invites`) would otherwise POST bare and be refused by the server
	 * with the header still unset.
	 */
	named: string | undefined;
	agents: () => Promise<AgentRead[]>;
	/**
	 * The acting agent's id — and, as a side effect, the client's
	 * `X-Rine-Agent` header from here on.
	 *
	 * 🔴 Call it BEFORE any read whose delivery mark should be this agent's. The
	 * header is what tells the server which agent is reading, and the server
	 * marks that agent's row and no sibling's — so a GET issued before this
	 * resolves fetches the message and marks nothing, leaving it unread for
	 * everyone. Resolving it afterwards cannot retroactively name the reader.
	 * Every command that reads a message relies on this ordering.
	 */
	actingAgent: () => Promise<string>;
}

/**
 * Rungs 3, 4 and 5 of the ladder, over a rung-1 value that is already settled.
 *
 * `headers`, when given, is the client's own default header object: resolving
 * writes `X-Rine-Agent` into it, so the rest of the command acts as the agent
 * it just named. A command that scopes by agent in the path (`stream`, `relay`)
 * passes nothing and only wants the id.
 *
 * Takes no `apiUrl`: every rung below reads the org's own agent list, and the
 * one spelling that needs no lookup needs no network either. The ladder cannot
 * reach WebFinger, which is the point — that resolver answers who owns a handle
 * *elsewhere*, and an acting agent is always one of this org's own.
 */
export function actorLadder(
	flagged: string | undefined,
	client: HttpClient,
	headers?: Record<string, string>,
): ActorLadder {
	let agentList: Promise<AgentRead[]> | undefined;
	const agents = (): Promise<AgentRead[]> => {
		agentList ??= fetchAgents(client);
		return agentList;
	};

	// Rungs 1 and 3, settled here and nowhere else, so no caller can hold a
	// different opinion about whether this invocation names an actor.
	const fromEnv = flagged === undefined ? actorFromEnv() : undefined;
	const named = flagged ?? fromEnv;

	// Deliberately not `resolveActor`: it fetches its own agent list, and the
	// CLI already needs one here: rung 4 resolves against it, and the provenance
	// line reads its length to know whether there is anything to disambiguate.
	// The rungs themselves are core's, not a second copy of them.
	const resolve = async (): Promise<string> => {
		// A named actor costs no list at all when it is already a UUID — the one
		// spelling the wire takes as written. Every other spelling, handle
		// included, is looked up in the org's own agents: an acting agent must be
		// an agent this caller owns, so a handle is a lookup here and never a
		// WebFinger question about somebody else's org.
		if (named !== undefined && UUID_RE.test(named)) return named;
		const list = await agents();
		let resolved: ResolvedActor;
		try {
			resolved = await resolveAgent(
				list,
				named,
				undefined,
				undefined,
				fromEnv === undefined ? "argument" : "environment",
			);
		} catch (err) {
			if (fromEnv !== undefined) blameEnvActor(err);
			throw err;
		}
		// 🔴 Ungated by the agent count, unlike the provenance line above: a
		// one-agent org is precisely where this fires, and it is the surface's
		// only channel for it. `blameEnvActor` cannot reach it either — there is
		// no throw to decorate — so on a one-agent org a stale `RINE_AGENT` is
		// now reported here and by nothing else. Which is why the rung is passed
		// down: the sentence has to name `RINE_AGENT` when that is where the
		// value came from, or it tells this caller to omit a flag they never
		// typed.
		if (resolved.warning !== undefined) printError(resolved.warning);
		if (fromEnv !== undefined) announceEnvActor(list, resolved.agentId);
		return resolved.agentId;
	};

	let pending: Promise<string> | undefined;
	const actingAgent = (): Promise<string> => {
		pending ??= resolve().then((id) => {
			if (headers) headers[ACTING_AGENT_HEADER] = id;
			return id;
		});
		return pending;
	};
	return { named, agents, actingAgent };
}
