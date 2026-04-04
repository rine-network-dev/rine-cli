import type { Command } from "commander";
import { withClient } from "../action.js";
import {
	fetchAgents,
	loadCredentials,
	resolveAgent,
	saveCredentials,
} from "@rine-network/core";
import { printError, printJson, printMutationOk } from "../output.js";

export function registerPollToken(program: Command): void {
	program
		.command("poll-token")
		.description("Generate or revoke a poll token for inbox monitoring")
		.option("--agent <id>", "Agent ID (auto-resolved for single-agent orgs)")
		.option("--revoke", "Revoke the poll token")
		.action(
			withClient(
				program,
				async (
					{ client, gOpts, profileName, configDir, apiUrl },
					opts: { agent?: string; revoke?: boolean },
				) => {
					const agents = await fetchAgents(client);
					const agentId = await resolveAgent(apiUrl, agents, opts.agent, gOpts.as);

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
