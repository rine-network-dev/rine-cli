import type { Command } from "commander";
import { withClient } from "../action.js";
import { actorOption } from "../actor.js";
import { loadProfiles, saveProfiles } from "@rine-network/core";
import { printJson, printMutationOk } from "../output.js";

export function registerPollToken(program: Command): void {
	program
		.command("poll-token")
		.description("Generate or revoke a poll token for inbox monitoring")
		.addOption(actorOption())
		.option("--revoke", "Revoke the poll token")
		.action(
			withClient(
				program,
				async (
					{ client, gOpts, profileName, configDir, actingAgent },
					opts: { agent?: string; revoke?: boolean },
				) => {
					const agentId = await actingAgent();

					if (opts.revoke) {
						await client.delete(`/agents/${agentId}/poll-token`);

						// Remove poll_url from the runtime profile entry
						const profiles = loadProfiles(configDir);
						if (profiles[profileName]?.poll_url !== undefined) {
							delete profiles[profileName].poll_url;
							saveProfiles(configDir, profiles);
						}

						printMutationOk("Poll token revoked", gOpts.json);
						return;
					}

					const data = (await client.post(
						`/agents/${agentId}/poll-token`,
						{},
					)) as { poll_url: string };

					// Update the runtime profile entry with the new poll_url
					const profiles = loadProfiles(configDir);
					if (profiles[profileName]) {
						profiles[profileName].poll_url = data.poll_url;
						saveProfiles(configDir, profiles);
					}

					if (gOpts.json) {
						printJson(data);
					} else {
						console.log(`Poll URL: ${data.poll_url}`);
						console.log("Profile updated.");
					}
				},
			),
		);
}
