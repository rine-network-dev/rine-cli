import type { Command } from "commander";
import { createClient, withErrorHandler } from "../action.js";
import {
	type AgentRead,
	type ListResponse,
	getCredentialEntry,
	hasSpiffeEndpoint,
	performAgentCreation,
	performRegistration,
	resolveApiUrl,
	resolveConfigDir,
	validateSlug,
} from "@rine-network/core";
import { toAgentRow } from "../agent-format.js";
import { printError, printJson, printTable } from "../output.js";

export function registerOnboard(program: Command): void {
	program
		.command("onboard")
		.description("Register a new organization and create your first agent")
		.requiredOption("--email <email>", "Email address")
		.requiredOption("--name <name>", "Organization name")
		.requiredOption("--slug <slug>", "Organization slug")
		.requiredOption("--agent <agent-name>", "Name for the first agent")
		.option(
			"--[no-]human-oversight",
			"Require human oversight (default: true)",
		)
		.option("--unlisted", "Mark agent as unlisted (not in public directory)")
		.option(
			"--verify-identity",
			"After creating the agent, prove a SPIFFE identity (auto-runs when SPIFFE_ENDPOINT_SOCKET is set)",
		)
		.option(
			"--svid <jwt>",
			"SPIFFE JWT-SVID to use for --verify-identity (when no Workload API auto-fetch is available)",
		)
		.action(
			withErrorHandler(
				program,
				async (
					gOpts,
					opts: {
						email: string;
						name: string;
						slug: string;
						agent: string;
						humanOversight?: boolean;
						unlisted?: boolean;
						verifyIdentity?: boolean;
						svid?: string;
					},
				) => {
					const profile = gOpts.profile ?? "default";
					const configDir = resolveConfigDir();
					const apiUrl = resolveApiUrl();

					// REQ-1.2: Slug validation before PoW
					if (!validateSlug(opts.slug)) {
						printError(
							"Invalid slug: must be 2-32 lowercase alphanumeric characters or hyphens, " +
								"no leading/trailing hyphen",
						);
						process.exitCode = 1;
						return;
					}

					// REQ-1.3: Idempotency guard
					const existing = getCredentialEntry(configDir, profile);
					if (existing) {
						const { client } = await createClient(
							configDir,
							apiUrl,
							gOpts.profile,
						);
						const org = (await client.get("/org")) as {
							id: string;
							slug: string;
							name: string;
						};
						const agents = (await client.get("/agents")) as ListResponse<AgentRead>;

						if (gOpts.json) {
							printJson({ status: "already_registered", org, agents });
						} else {
							console.log(`Already registered as '${org.name}' (${org.slug})`);
							if (agents.items.length > 0) {
								printTable(
									agents.items.map((a) => ({
										ID: a.id,
										Name: a.name,
										Handle: a.handle,
									})),
								);
							}
						}
						return;
					}

					// REQ-1.4: Registration flow
					process.stderr.write(
						"By registering, you accept the rine terms of service and privacy policy:\n" +
							"  https://rine.network/terms.html\n" +
							"  https://rine.network/privacy.html\n",
					);

					const progressStream = gOpts.json
						? process.stderr
						: process.stdout;
					const regResult = await performRegistration(
						apiUrl,
						configDir,
						profile,
						{ email: opts.email, slug: opts.slug, name: opts.name },
						(pct) => {
							progressStream.write(
								`\rSolving PoW challenge: ${pct}%`,
							);
						},
					);
					progressStream.write("\rSolving PoW challenge: 100%\n");

					// REQ-1.5: Agent creation
					const { client } = await createClient(
						configDir,
						apiUrl,
						gOpts.profile,
					);
					const agent = await performAgentCreation(client, configDir, profile, {
						name: opts.agent,
						humanOversight: opts.humanOversight,
						unlisted: opts.unlisted,
						verifyIdentity:
							opts.verifyIdentity ||
							Boolean(opts.svid) ||
							hasSpiffeEndpoint(),
						svid: opts.svid,
					});

					// REQ-1.6: Output. The agent is created even if a requested SPIFFE
					// verification failed — print the creation result first, then surface
					// any verification error as a warning (creation success is never hidden
					// behind a verify failure).
					if (gOpts.json) {
						printJson({
							org_id: regResult.org_id,
							client_id: regResult.client_id,
							agent,
							poll_url: agent.poll_url,
							identity: agent.identity,
							identity_error: agent.identityError,
							config_dir: configDir,
						});
					} else {
						printTable([
							toAgentRow(agent, {
								includeCard: true,
								includeVerificationWords: true,
							}),
						]);
						console.log(
							`\nAgent '${agent.name}' created — reachable at ${agent.handle}`,
						);
						if (agent.verification_words) {
							console.log(
								`Verification words: ${agent.verification_words}`,
							);
						}
						if (agent.poll_url) {
							console.log(`Poll URL: ${agent.poll_url}`);
						}
						if (agent.identity) {
							console.log(
								`SPIFFE identity verified: ${agent.identity.spiffe_id} ` +
									`(trust tier ${agent.identity.trust_tier})`,
							);
						}
					}
					if (agent.identityError) {
						printError(
							`Agent created, but SPIFFE identity verification failed: ${agent.identityError}\n` +
								`Retry with: rine verify-identity --agent ${agent.id} --svid <jwt>`,
						);
						process.exitCode = 1;
					}
				},
			),
		);
}
