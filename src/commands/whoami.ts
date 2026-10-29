import type { Command } from "commander";
import { resolveDirs } from "../action.js";
import { actorLadder } from "../acting-agent.js";
import { namedActor } from "../actor.js";
import {
	DEFAULT_PROFILE,
	type WhoAmIRead,
	HttpClient,
	RineApiError,
	agentKeysExist,
	formatError,
	getOrRefreshToken,
	ownIdentityFor,
	principalString,
	resolveApiUrl,
	resolveAuth,
} from "@rine-network/core";
import { printError, printJson, printTable } from "../output.js";
import type { GlobalOpts } from "../types.js";

/**
 * Where this agent's keys are. The server serves the keys of every agent it
 * knows, so `serverKnows` is false only on a 404, which means the agent is not
 * found (unknown, or its org erased). It is undefined when the read failed for
 * any other reason: a network failure or a 5xx is reported as unknown.
 */
function keysLabel(hasLocal: boolean, serverKnows: boolean | undefined): string {
	if (serverKnows === undefined) {
		return hasLocal ? "local; server could not check" : "could not check";
	}
	if (!serverKnows) {
		return hasLocal
			? "local; server: agent not found"
			: "server: agent not found";
	}
	return hasLocal ? "local + server" : "server only";
}

export function registerWhoami(program: Command): void {
	program
		.command("whoami")
		.description("Show current identity and status")
		.action(async () => {
			const gOpts = program.opts<GlobalOpts>();
			const profile = gOpts.profile ?? DEFAULT_PROFILE;
			const dirs = resolveDirs();
			const apiUrl = resolveApiUrl();

			const auth = resolveAuth(dirs, gOpts.profile);
			if (!auth) {
				if (gOpts.json) {
					printJson({ logged_in: false });
				} else {
					printTable([{ Field: "Status", Value: "not logged in" }]);
				}
				return;
			}

			try {
				const token = await getOrRefreshToken(
					auth.cacheDir,
					apiUrl,
					auth.signer,
					{},
				);
				const defaultHeaders: Record<string, string> = {};
				const client = new HttpClient({
					tokenFn: () => Promise.resolve(token),
					apiUrl,
					canRefresh: false,
					defaultHeaders,
					ownIdentity: ownIdentityFor(dirs.configDir, auth),
				});
				const { agents, actingAgent } = actorLadder(
					namedActor(undefined, gOpts),
					client,
					defaultHeaders,
				);

				const { org } = (await client.get("/whoami")) as WhoAmIRead;

				// Try to resolve agent
				let agentHandle: string | undefined;
				let agentId: string | undefined;
				let keys: string | undefined;

				try {
					agentId = await actingAgent();
					const agent = (await agents()).find((a) => a.id === agentId);
					agentHandle = agent?.handle ?? undefined;

					const hasLocal = agentKeysExist(dirs.configDir, agentId);
					let serverKnows: boolean | undefined;
					try {
						await client.get(`/agents/${agentId}/keys`);
						serverKnows = true;
					} catch (err) {
						if (err instanceof RineApiError && err.status === 404) {
							serverKnows = false;
						}
					}
					keys = keysLabel(hasLocal, serverKnows);
				} catch {
					// no agent resolvable — omit agent fields
				}

				const principal = principalString(auth.signer.principal);

				if (gOpts.json) {
					printJson({
						profile,
						api: apiUrl,
						principal,
						org: { name: org.name, slug: org.slug },
						trust_tier: org.trust_tier,
						...(agentId
							? {
									agent: agentHandle ?? null,
									agent_id: agentId,
									keys,
								}
							: {}),
					});
				} else {
					const rows = [
						{ Field: "Profile", Value: profile },
						{ Field: "API", Value: apiUrl },
						{ Field: "Principal", Value: principal },
						{ Field: "Org", Value: `${org.name} (${org.slug})` },
						{ Field: "Trust Tier", Value: String(org.trust_tier) },
					];
					if (agentId) {
						rows.push({ Field: "Agent", Value: agentHandle ?? "-" });
						rows.push({ Field: "Agent ID", Value: agentId });
						rows.push({ Field: "Keys", Value: keys ?? "none" });
					}
					printTable(rows);
				}
			} catch (err) {
				printError(formatError(err));
				process.exitCode = 1;
			}
		});
}
