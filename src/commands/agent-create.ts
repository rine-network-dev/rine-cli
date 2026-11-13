import {
	DEFAULT_PROFILE,
	compareVerificationWordsForAgent,
	performAgentCreation,
	verificationWordsLines,
} from "@rine-network/core";
import type { Command } from "commander";
import { withClient } from "../action.js";
import { toAgentRow } from "../agent-format.js";
import { printError, printJson, printTable } from "../output.js";
import { promptText } from "../prompt.js";
import {
	EXPOSURE_OPTION_HELP,
	announceExposure,
	exposurePreset,
} from "./agent-exposure-create.js";

export function registerAgentCreate(agent: Command, program: Command): void {
	agent
		.command("create")
		.description("Create a new agent")
		.option("--name <name>", "Agent name")
		.option("--[no-]human-oversight", "Require human oversight (default: true)")
		.option("--unlisted", "Mark agent as unlisted (not in public directory)")
		.option("--exposure <preset>", EXPOSURE_OPTION_HELP)
		.action(
			withClient(
				program,
				async (
					{ client, gOpts, configDir, ownerDir },
					opts: {
						name?: string;
						humanOversight?: boolean;
						unlisted?: boolean;
						exposure?: string;
					},
				) => {
					const exposure = exposurePreset(opts.exposure);
					let name = opts.name;
					if (!name) {
						name = await promptText("Agent name: ");
						if (!name) {
							printError("Agent name is required");
							process.exitCode = 2;
							return;
						}
					}

					const profile = gOpts.profile ?? DEFAULT_PROFILE;
					const data = await performAgentCreation(client, { configDir, ownerDir }, profile, {
						name,
						humanOversight: opts.humanOversight,
						unlisted: opts.unlisted,
						exposure,
					});

					// Recomputed from the key just written to this config dir, never from
					// the string the server sent back with the agent.
					const verification = compareVerificationWordsForAgent(
						configDir,
						data.id,
						data.verification_words,
					);

					if (gOpts.json) {
						printJson({ ...data, verification });
					} else {
						printTable([toAgentRow(data, { includeCard: true, verification })]);
						console.log(
							`\nAgent '${data.name}' created \u2014 reachable at ${data.handle}`,
						);
						announceExposure(data, exposure);
						console.log("E2EE keys generated and stored locally.");
						for (const line of verificationWordsLines(verification)) {
							console.log(line);
						}
						if (data.poll_url) {
							console.log(`Poll URL: ${data.poll_url}`);
						}
						if (data.identity) {
							console.log(
								`SPIFFE identity verified: ${data.identity.spiffe_id} ` +
									`(trust tier ${data.identity.trust_tier})`,
							);
						}
					}
					if (data.identityError) {
						printError(
							`Agent created, but SPIFFE identity verification failed: ${data.identityError}\n` +
								`Retry with: rine verify-identity --agent ${data.id} --svid <jwt>`,
						);
						process.exitCode = 1;
					}
				},
			),
		);
}
