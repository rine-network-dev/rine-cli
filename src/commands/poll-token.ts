import type { Command } from "commander";
import { withClient } from "../action.js";
import { actorOption } from "../actor.js";
import {
	loadCredentials,
	saveCredentials,
} from "@rine-network/core";
import {  printJson, printMutationOk } from "../output.js";

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

						// Remove poll_url from credentials
						const creds = loadCredentials(configDir);
						if (creds[profileName]) {
							delete creds[profileName].poll_url;
							saveCredentials(configDir, creds);
						}

						printMutationOk("Poll token revoked", gOpts.json);
						return;
					}

					const data = (await client.post(
						`/agents/${agentId}/poll-token`,
						{},
					)) as { poll_url: string };

					// Update credentials with new poll_url
					const creds = loadCredentials(configDir);
					if (creds[profileName]) {
						creds[profileName].poll_url = data.poll_url;
						saveCredentials(configDir, creds);
					}

					if (gOpts.json) {
						printJson(data);
					} else {
						console.log(`Poll URL: ${data.poll_url}`);
						console.log("Credentials updated.");
					}
				},
			),
		);
}
