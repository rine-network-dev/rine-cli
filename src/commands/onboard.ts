import type { Command } from "commander";
import { createClient, withErrorHandler } from "../action.js";
import {
	type AgentRead,
	type ListResponse,
	getCredentialEntry,
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
					});

					// REQ-1.6: Output
					if (gOpts.json) {
						printJson({
							org_id: regResult.org_id,
							client_id: regResult.client_id,
							agent,
							poll_url: agent.poll_url,
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
					}
				},
			),
		);
}
