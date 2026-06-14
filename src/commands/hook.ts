// REQ-CLI-01..05 — the `rine hook` CRUD command group for the inbound webhook
// funnel. Structured on the existing `rine webhook` group (webhook.ts): every
// sub-command runs through `withClient`, resolves the agent the same way, and
// reuses the shared output helpers — no reimplemented CRUD or output logic.
//
// FROZEN-CONTRACT: the HMAC secret is generated CLIENT-SIDE and NEVER sent to
// rine — the create POST body carries ONLY {hook_name}. The secret is persisted
// 0600 BEFORE anything prints, deleted if the allocation POST fails (no orphan),
// printed exactly ONCE on create, and NEVER shown by `list`.

import {
	type HookCreated,
	type HookListResponse,
	RineApiError,
	deleteHookSecret,
	fetchAgents,
	generateHookSecret,
	isValidHookName,
	resolveAgent,
	saveHookSecret,
} from "@rine-network/core";
import type { Command } from "commander";
import { withClient } from "../action.js";
import {
	printError,
	printJson,
	printMutationOk,
	printTable,
} from "../output.js";
import { promptConfirm } from "../prompt.js";

const SIGNATURE_HEADER = "X-Hub-Signature-256";
const CONTENT_TYPE = "application/json";

export function registerHook(program: Command): void {
	const hook = program
		.command("hook")
		.description("Manage inbound webhook funnel hooks");

	hook
		.command("create")
		.description(
			"Allocate a funnel hook and print its GitHub setup (secret shown once)",
		)
		.option("--agent <id>", "Agent ID (defaults to your agent)")
		.option("--name <name>", "Hook name (default: default)", "default")
		.action(
			withClient(
				program,
				async (
					{ client, gOpts, apiUrl, configDir },
					opts: { agent?: string; name: string },
				) => {
					if (!isValidHookName(opts.name)) {
						printError(
							`Invalid hook name '${opts.name}': use lowercase letters, digits and hyphens (max 32).`,
						);
						process.exitCode = 2;
						return;
					}
					const agents = await fetchAgents(client);
					const agentId = await resolveAgent(
						apiUrl,
						agents,
						opts.agent,
						gOpts.as,
					);

					// Generate + persist the secret BEFORE the POST (the allocation is
					// non-idempotent): on a POST failure we delete it so no orphan secret
					// survives an unallocated hook.
					const secret = generateHookSecret();
					saveHookSecret(configDir, agentId, opts.name, secret);
					let created: HookCreated;
					try {
						created = (await client.post(`/agents/${agentId}/funnel/hooks`, {
							hook_name: opts.name,
						})) as HookCreated;
					} catch (err) {
						deleteHookSecret(configDir, agentId, opts.name);
						throw err;
					}

					printCreated(created, opts.name, secret, gOpts.json);
				},
			),
		);

	hook
		.command("list")
		.description("List your agent's funnel hooks")
		.option("--agent <id>", "Agent ID (defaults to your agent)")
		.action(
			withClient(
				program,
				async ({ client, gOpts, apiUrl }, opts: { agent?: string }) => {
					const agents = await fetchAgents(client);
					const agentId = await resolveAgent(
						apiUrl,
						agents,
						opts.agent,
						gOpts.as,
					);
					const data = (await client.get(
						`/agents/${agentId}/funnel/hooks`,
						{},
					)) as HookListResponse;
					if (gOpts.json) {
						printJson(data);
					} else {
						printTable(
							data.items.map((h) => ({
								Name: h.hook_name,
								Hostname: h.hostname,
								Active: h.active,
								Created: h.created_at,
							})),
						);
					}
				},
			),
		);

	hook
		.command("delete")
		.description("Delete a funnel hook and purge its local secret")
		.option("--agent <id>", "Agent ID (defaults to your agent)")
		.requiredOption("--name <name>", "Hook name to delete")
		.option("--yes", "Skip confirmation prompt")
		.action(
			withClient(
				program,
				async (
					{ client, gOpts, apiUrl, configDir },
					opts: { agent?: string; name: string; yes?: boolean },
				) => {
					const agents = await fetchAgents(client);
					const agentId = await resolveAgent(
						apiUrl,
						agents,
						opts.agent,
						gOpts.as,
					);
					if (!opts.yes && !gOpts.json) {
						const confirmed = await promptConfirm(
							`Delete funnel hook '${opts.name}'?`,
						);
						if (!confirmed) return;
					}
					try {
						await client.delete(`/agents/${agentId}/funnel/hooks/${opts.name}`);
					} catch (err) {
						// REQ-CLI-05: an unknown hook is success-idempotent ONLY under
						// --yes — purge any stale local secret and report it absent. Without
						// --yes the 404 surfaces so an explicit delete of a typo'd name fails
						// loudly rather than silently "succeeding".
						if (opts.yes && err instanceof RineApiError && err.status === 404) {
							deleteHookSecret(configDir, agentId, opts.name);
							printMutationOk("Funnel hook already absent", gOpts.json);
							return;
						}
						throw err;
					}
					deleteHookSecret(configDir, agentId, opts.name);
					printMutationOk("Funnel hook deleted", gOpts.json);
				},
			),
		);
}

/** Print the print-once GitHub setup block (the secret is shown exactly once). */
function printCreated(
	created: HookCreated,
	name: string,
	secret: string,
	json?: boolean,
): void {
	const publicUrl = `https://${created.hostname}/${name}`;
	if (json) {
		printJson({
			hook: {
				name: created.hook_name,
				hostname: created.hostname,
				agent_id: created.agent_id,
			},
			public_url: publicUrl,
			secret,
			signature_header: SIGNATURE_HEADER,
			content_type: CONTENT_TYPE,
		});
		return;
	}
	printTable([
		{ Field: "Hook", Value: created.hook_name },
		{ Field: "Hostname", Value: created.hostname },
		{ Field: "Payload URL", Value: publicUrl },
		{ Field: "Content type", Value: CONTENT_TYPE },
		{ Field: "Signature header", Value: SIGNATURE_HEADER },
		{ Field: "Secret", Value: secret },
	]);
	console.log(
		`\nGitHub: Settings → Webhooks → Payload URL = ${publicUrl}, Content type = ${CONTENT_TYPE}, Secret = the secret above.`,
	);
	console.log(
		"Save this secret now — it is not stored on rine and cannot be retrieved.",
	);
}
