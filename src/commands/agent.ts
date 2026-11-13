import type { Command } from "commander";
import { withClient } from "../action.js";
import {
	type AgentRead,
	type ListResponse,
	RineApiError,
} from "@rine-network/core";
import { toAgentRow } from "../agent-format.js";
import { registerAgentCreate } from "./agent-create.js";
import { registerAgentExposure } from "./agent-exposure.js";
import { registerAgentSuspend } from "./agent-suspend.js";
import { registerAgentVerify } from "./agent-verify.js";
import {
	printError,
	printJson,
	printMutationOk,
	printTable,
} from "../output.js";
import { promptConfirm } from "../prompt.js";

export function registerAgent(program: Command): void {
	const agent = program.command("agent").description("Agent management");

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
		.option("--[no-]human-oversight", "Require human oversight")
		.option("--unlisted", "Hide the agent from the directory")
		.option("--no-unlisted", "List the agent in the directory again")
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
						humanOversight?: boolean;
						unlisted?: boolean;
						incomingPolicy?: string;
						outgoingPolicy?: string;
					},
				) => {
					const body: Record<string, unknown> = {};
					if (opts.humanOversight !== undefined) {
						body.human_oversight = opts.humanOversight;
					}
					if (opts.incomingPolicy) body.incoming_policy = opts.incomingPolicy;
					if (opts.outgoingPolicy) body.outgoing_policy = opts.outgoingPolicy;
					if (opts.unlisted !== undefined) body.unlisted = opts.unlisted;
					if (Object.keys(body).length === 0) {
						printError(
							"At least one of --incoming-policy, --outgoing-policy, --human-oversight, --no-human-oversight, --unlisted or --no-unlisted is required",
						);
						process.exitCode = 2;
						return;
					}
					const data = (await client.patch(`/agents/${agentId}`, body)) as AgentRead;
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
	registerAgentCreate(agent, program);
	registerAgentSuspend(agent, program);
	registerAgentExposure(agent, program);
}
