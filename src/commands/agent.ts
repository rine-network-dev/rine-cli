import type { Command } from "commander";
import { withClient } from "../action.js";
import type { AgentRead, ListResponse } from "../api-types.js";
import {
	encryptionPublicKeyToJWK,
	generateAgentKeys,
	saveAgentKeys,
	signingPublicKeyToJWK,
} from "../crypto/keys.js";
import { RineApiError } from "../errors.js";
import {
	printError,
	printJson,
	printMutationOk,
	printTable,
} from "../output.js";
import { promptConfirm, promptText } from "../prompt.js";

type AgentTableRow = {
	ID: string;
	Name: string;
	Handle: string;
	"Human Oversight": string;
	Created: string;
	Card?: string;
	Revoked?: string;
	"Verification Words"?: string;
};

function toAgentRow(
	a: AgentRead,
	opts: {
		includeCard?: boolean;
		includeRevoked?: boolean;
		includeVerificationWords?: boolean;
	} = {},
): AgentTableRow {
	const row: AgentTableRow = {
		ID: a.id,
		Name: a.name,
		Handle: a.handle,
		"Human Oversight": String(a.human_oversight),
		Created: a.created_at,
	};
	if (opts.includeVerificationWords && a.verification_words) {
		row["Verification Words"] = a.verification_words;
	}
	if (opts.includeCard) row.Card = a.unlisted ? "unlisted" : "public";
	if (opts.includeRevoked)
		row.Revoked = a.revoked_at ? String(a.revoked_at) : "\u2014";
	return row;
}

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
					{ client, gOpts },
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
					const agentKeys = generateAgentKeys();

					const body: Record<string, unknown> = {
						name,
						signing_public_key: signingPublicKeyToJWK(
							agentKeys.signing.publicKey,
						),
						encryption_public_key: encryptionPublicKeyToJWK(
							agentKeys.encryption.publicKey,
						),
					};
					if (opts.humanOversight !== undefined) {
						body.human_oversight = opts.humanOversight;
					}
					if (opts.unlisted) body.unlisted = true;
					const data = (await client.post("/agents", body)) as AgentRead;

					saveAgentKeys(data.id, agentKeys);

					if (gOpts.json) {
						printJson(data);
					} else {
						printTable([
							toAgentRow(data, {
								includeCard: true,
								includeVerificationWords: true,
							}),
						]);
						console.log(
							`\nAgent '${data.name}' created \u2014 reachable at ${data.handle}`,
						);
						console.log("E2EE keys generated and stored locally.");
						if (data.verification_words) {
							console.log(`Verification words: ${data.verification_words}`);
						}
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
}
