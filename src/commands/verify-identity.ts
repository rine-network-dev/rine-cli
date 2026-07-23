// `rine verify-identity` proves control of a SPIFFE identity for an
// agent and elevates the org to trust tier 2. A thin Commander wrapper over the
// core `verifyIdentitySpiffe`: it only resolves which agent to use and renders
// the typed result. All the challenge → SVID → verify-svid orchestration lives in
// rine-core (shared with the `rine onboard --verify-identity` path).

import {
	type VerifyIdentityResult,
	fetchAgents,
	resolveAgent,
	verifyIdentitySpiffe,
} from "@rine-network/core";
import type { Command } from "commander";
import { withClient } from "../action.js";
import { printJson } from "../output.js";

function printResult(result: VerifyIdentityResult): void {
	console.log(`SPIFFE identity verified for agent ${result.agent_id}`);
	console.log(`  SPIFFE ID:    ${result.spiffe_id}`);
	console.log(`  Trust domain: ${result.trust_domain}`);
	console.log(`  Trust tier:   ${result.trust_tier}`);
	console.log(`  Verified at:  ${result.verified_at}`);
}

export function registerVerifyIdentity(program: Command): void {
	program
		.command("verify-identity")
		.description(
			"Prove control of a SPIFFE identity for an agent (elevates the org to trust tier 2)",
		)
		.option(
			"--agent <id>",
			"Agent UUID, handle, or name (defaults to the only agent)",
		)
		.option(
			"--svid <jwt>",
			"A SPIFFE JWT-SVID. Required unless a Workload API auto-fetch is available.",
		)
		.action(
			withClient(
				program,
				async (ctx, opts: { agent?: string; svid?: string }) => {
					const agents = await fetchAgents(ctx.client);
					const agentId = await resolveAgent(
						ctx.apiUrl,
						agents,
						opts.agent,
						ctx.gOpts.as,
					);

					const result = await verifyIdentitySpiffe(ctx.client, agentId, {
						svid: opts.svid,
					});

					if (ctx.gOpts.json) {
						printJson(result);
					} else {
						printResult(result);
					}
				},
			),
		);
}
