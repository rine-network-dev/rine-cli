import type { Command } from "commander";
import { withClient } from "../action.js";
import {
	type AgentRead,
	type ListResponse,
	RineApiError,
	compareVerificationWordsForAgent,
	performAgentCreation,
	verificationWordsLines,
} from "@rine-network/core";
import { toAgentRow } from "../agent-format.js";
import { registerAgentVerify } from "./agent-verify.js";
import {
	printError,
	printJson,
	printMutationOk,
	printTable,
} from "../output.js";
import { promptConfirm, promptText } from "../prompt.js";

export function registerAgent(program: Command): void {
	const agent = program.command("agent").description("Agent management");

	agent
		.command("create")
		.description("Create a new agent")
		.option("--name <name>", "Agent name")
		.option("--[no-]human-oversight", "Require human oversight (default: true)")
		.option("--unlisted", "Mark agent as unlisted (not in public directory)")
		.action(
			withClient(
				program,
				async (
					{ client, gOpts, configDir },
					opts: { name?: string; humanOversight?: boolean; unlisted?: boolean },
				) => {
					let name = opts.name;
					if (!name) {
						name = await promptText("Agent name: ");
						if (!name) {
							printError("Agent name is required");
							process.exitCode = 2;
							return;
						}
					}

					const profile = gOpts.profile ?? "default";
					const data = await performAgentCreation(client, configDir, profile, {
						name,
						humanOversight: opts.humanOversight,
						unlisted: opts.unlisted,
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

	agent
		.command("list")
		.description("List all agents")
		.option("--include-revoked", "Include revoked agents")
		.action(
			withClient(
				program,
				async ({ client, gOpts }, opts: { includeRevoked?: boolean }) => {
					const params = opts.includeRevoked
						? { include_revoked: true }
						: undefined;
					const data = (await client.get(
						"/agents",
						params,
					)) as ListResponse<AgentRead>;
					if (gOpts.json) {
						printJson(data);
					} else {
						printTable(
							data.items.map((a) =>
								toAgentRow(a, { includeRevoked: opts.includeRevoked }),
							),
						);
					}
				},
			),
		);

	agent
		.command("get")
		.description("Get agent details")
		.argument("<agent-id>", "Agent ID")
		.action(
			withClient(program, async ({ client, gOpts }, agentId: string) => {
				const data = (await client.get(`/agents/${agentId}`)) as AgentRead;
				if (gOpts.json) {
					printJson(data);
				} else {
					const row = toAgentRow(data, { includeRevoked: true });
					const extended = {
						...row,
						"Incoming Policy": data.incoming_policy ?? "accept_all",
						"Outgoing Policy": data.outgoing_policy ?? "send_all",
					};
					printTable([extended]);
				}
			}),
		);

	agent
		.command("update")
		.description("Update agent details")
		.argument("<agent-id>", "Agent ID")
		.option("--name <name>", "Agent name")
		.option("--[no-]human-oversight", "Require human oversight")
		.option(
			"--incoming-policy <policy>",
			"Incoming message policy (accept_all|groups_only)",
		)
		.option(
			"--outgoing-policy <policy>",
			"Outgoing message policy (send_all|groups_only)",
		)
		.action(
			withClient(
				program,
				async (
					{ client, gOpts },
					agentId: string,
					opts: {
						name?: string;
						humanOversight?: boolean;
						incomingPolicy?: string;
						outgoingPolicy?: string;
					},
				) => {
					const body: Record<string, unknown> = {};
					if (opts.name) body.name = opts.name;
					if (opts.humanOversight !== undefined) {
						body.human_oversight = opts.humanOversight;
					}
					if (opts.incomingPolicy) body.incoming_policy = opts.incomingPolicy;
					if (opts.outgoingPolicy) body.outgoing_policy = opts.outgoingPolicy;
					if (Object.keys(body).length === 0) {
						printError(
							"At least one of --name, --human-oversight, --incoming-policy, --outgoing-policy is required",
						);
						process.exitCode = 2;
						return;
					}
					const data = (await client.patch(
						`/agents/${agentId}`,
						body,
					)) as AgentRead;
					if (gOpts.json) {
						printJson(data);
					} else {
						printMutationOk("Agent updated", gOpts.json);
						if (data.warnings && data.warnings.length > 0) {
							for (const w of data.warnings) {
								process.stderr.write(`Warning: ${w}\n`);
							}
						}
					}
				},
			),
		);

	agent
		.command("revoke")
		.description("Revoke an agent")
		.argument("<agent-id>", "Agent ID")
		.option("--yes", "Skip confirmation prompt")
		.action(
			withClient(
				program,
				async ({ client, gOpts }, agentId: string, opts: { yes?: boolean }) => {
					if (!opts.yes && !gOpts.json) {
						const confirmed = await promptConfirm(`Revoke agent ${agentId}?`);
						if (!confirmed) return;
					}
					try {
						await client.delete(`/agents/${agentId}`);
						printMutationOk("Agent revoked", gOpts.json);
					} catch (err) {
						if (err instanceof RineApiError && err.status === 409) {
							printError("Agent already revoked");
						} else {
							throw err;
						}
						process.exitCode = 1;
					}
				},
			),
		);

	registerAgentVerify(program, agent);
}
