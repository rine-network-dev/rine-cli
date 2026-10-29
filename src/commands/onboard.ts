import type { Command } from "commander";
import { createClient, resolveDirs, withErrorHandler } from "../action.js";
import {
	type AgentRead,
	DEFAULT_PROFILE,
	type ListResponse,
	type WhoAmIRead,
	compareVerificationWordsForAgent,
	hasSpiffeEndpoint,
	performAgentCreation,
	performRegistration,
	resolveApiUrl,
	resolveAuth,
	validateSlug,
	verificationWordsLines,
} from "@rine-network/core";
import { toAgentRow } from "../agent-format.js";
import { announcePhrase } from "../phrase-display.js";
import { printError, printJson, printTable } from "../output.js";

export function registerOnboard(program: Command): void {
	program
		.command("onboard")
		.description("Register a new organization and create your first agent")
		.requiredOption("--email <email>", "Email address")
		.requiredOption("--name <name>", "Organization name")
		.requiredOption("--slug <slug>", "Organization slug")
		.requiredOption("--agent-name <name>", "Name for the first agent")
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
						agentName: string;
						humanOversight?: boolean;
						unlisted?: boolean;
						verifyIdentity?: boolean;
						svid?: string;
					},
				) => {
					const profile = gOpts.profile ?? DEFAULT_PROFILE;
					const dirs = resolveDirs();
					const apiUrl = resolveApiUrl();

					// Slug validation before PoW
					if (!validateSlug(opts.slug)) {
						printError(
							"Invalid slug: must be 2-32 lowercase alphanumeric characters or hyphens, " +
								"no leading/trailing hyphen",
						);
						process.exitCode = 1;
						return;
					}

					// Idempotency guard: a resolvable identity means this owner dir
					// already holds an org root, so there is nothing to register.
					if (resolveAuth(dirs, gOpts.profile) !== undefined) {
						const { client } = await createClient(apiUrl, gOpts.profile);
						const { org } = (await client.get("/whoami")) as WhoAmIRead;
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

					// Registration flow
					process.stderr.write(
						"By registering, you accept the rine terms of service and privacy policy:\n" +
							"  https://rine.network/terms.html\n" +
							"  https://rine.network/privacy.html\n",
					);

					const progressStream = gOpts.json ? process.stderr : process.stdout;
					const reg = await performRegistration(
						apiUrl,
						dirs,
						profile,
						{ email: opts.email, slug: opts.slug, name: opts.name },
						(pct) => {
							progressStream.write(`\rSolving PoW challenge: ${pct}%`);
						},
					);
					progressStream.write("\rSolving PoW challenge: 100%\n");

					// The one place the words reach a screen, and only on a terminal.
					announcePhrase({
						ownerDir: dirs.ownerDir,
						phrasePath: reg.phrase_path,
						json: gOpts.json,
					});

					// Agent creation. The client resolves the org signer from the
					// owner dir the registration just wrote.
					const { client } = await createClient(apiUrl, gOpts.profile);
					const agent = await performAgentCreation(client, dirs, profile, {
						name: opts.agentName,
						humanOversight: opts.humanOversight,
						unlisted: opts.unlisted,
						verifyIdentity:
							opts.verifyIdentity ||
							Boolean(opts.svid) ||
							hasSpiffeEndpoint(),
						svid: opts.svid,
					});

					// Recomputed from the key just written to this config dir, never
					// from the string the server sent back with the agent.
					const verification = compareVerificationWordsForAgent(
						dirs.configDir,
						agent.id,
						agent.verification_words,
					);

					// Output. The agent is created even if a requested SPIFFE
					// verification failed — print the creation result first, then surface
					// any verification error as a warning (creation success is never hidden
					// behind a verify failure).
					if (gOpts.json) {
						printJson({
							org_id: reg.org_id,
							org_words: reg.org_words,
							recovery_phrase_file: reg.phrase_path,
							agent,
							verification,
							poll_url: agent.poll_url,
							identity: agent.identity,
							identity_error: agent.identityError,
							config_dir: dirs.configDir,
							owner_dir: dirs.ownerDir,
						});
					} else {
						printTable([
							toAgentRow(agent, { includeCard: true, verification }),
						]);
						console.log(`Org verification words: ${reg.org_words}`);
						console.log(
							`\nAgent '${agent.name}' created — reachable at ${agent.handle}`,
						);
						for (const line of verificationWordsLines(verification)) {
							console.log(line);
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
