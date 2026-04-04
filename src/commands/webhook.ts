import type { Command } from "commander";
import { withClient } from "../action.js";
import {
	type ListResponse,
	type WebhookDeliveryRead,
	type WebhookRead,
	fetchAgents,
	resolveAgent,
} from "@rine-network/core";
import {
	printError,
	printJson,
	printMutationOk,
	printTable,
} from "../output.js";
import { promptConfirm } from "../prompt.js";

export function registerWebhook(program: Command): void {
	const webhook = program.command("webhook").description("Manage webhooks");

	webhook
		.command("create")
		.description("Create a new webhook")
		.option("--agent <id>", "Agent ID (defaults to your agent)")
		.requiredOption("--url <url>", "Webhook target URL (must be https://)")
		.action(
			withClient(
				program,
				async ({ client, gOpts, apiUrl }, opts: { agent?: string; url: string }) => {
					if (!opts.url.startsWith("https://")) {
						printError("Webhook URL must start with https://");
						process.exitCode = 2;
						return;
					}
					const agents = await fetchAgents(client);
					const agentId = await resolveAgent(apiUrl, agents, opts.agent, gOpts.as);
					const data = (await client.post("/webhooks", {
						agent_id: agentId,
						url: opts.url,
					})) as WebhookRead;
					if (gOpts.json) {
						printJson(data);
					} else {
						printTable([
							{
								ID: data.id,
								"Agent ID": data.agent_id,
								URL: data.url,
								Secret: data.secret,
								Active: data.active,
								Created: data.created_at,
							},
						]);
					}
				},
			),
		);

	webhook
		.command("list")
		.description("List webhooks")
		.option("--agent <id>", "Filter by agent ID")
		.option("--include-inactive", "Include inactive webhooks")
		.action(
			withClient(
				program,
				async (
					{ client, gOpts },
					opts: { agent?: string; includeInactive?: boolean },
				) => {
					const params: Record<string, string | number | boolean> = {};
					if (opts.agent) params.agent_id = opts.agent;
					if (opts.includeInactive) params.include_inactive = true;
					const data = (await client.get(
						"/webhooks",
						params,
					)) as ListResponse<WebhookRead>;
					if (gOpts.json) {
						printJson(data);
					} else {
						printTable(
							data.items.map((w) => ({
								ID: w.id,
								"Agent ID": w.agent_id,
								URL: w.url,
								Active: w.active,
								Created: w.created_at,
							})),
						);
					}
				},
			),
		);

	webhook
		.command("delete")
		.description("Delete a webhook")
		.argument("<webhook-id>", "Webhook ID")
		.option("--yes", "Skip confirmation prompt")
		.action(
			withClient(
				program,
				async (
					{ client, gOpts },
					webhookId: string,
					opts: { yes?: boolean },
				) => {
					if (!opts.yes && !gOpts.json) {
						const confirmed = await promptConfirm(
							`Delete webhook ${webhookId}?`,
						);
						if (!confirmed) return;
					}
					await client.delete(`/webhooks/${webhookId}`);
					printMutationOk("Webhook deleted", gOpts.json);
				},
			),
		);

	webhook
		.command("deactivate")
		.description("Deactivate a webhook")
		.argument("<webhook-id>", "Webhook ID")
		.action(
			withClient(program, async ({ client, gOpts }, webhookId: string) => {
				await client.patch(`/webhooks/${webhookId}`, { active: false });
				printMutationOk("Webhook deactivated", gOpts.json);
			}),
		);

	webhook
		.command("activate")
		.description("Activate a webhook")
		.argument("<webhook-id>", "Webhook ID")
		.action(
			withClient(program, async ({ client, gOpts }, webhookId: string) => {
				await client.patch(`/webhooks/${webhookId}`, { active: true });
				printMutationOk("Webhook activated", gOpts.json);
			}),
		);

	webhook
		.command("deliveries")
		.description("List deliveries for a webhook")
		.argument("<webhook-id>", "Webhook ID")
		.option("--status <status>", "Filter by delivery status")
		.option("--limit <n>", "Maximum number of deliveries")
		.action(
			withClient(
				program,
				async (
					{ client, gOpts },
					webhookId: string,
					opts: { status?: string; limit?: string },
				) => {
					const params: Record<string, string | number | boolean> = {};
					if (opts.status) params.status = opts.status;
					if (opts.limit) params.limit = opts.limit;
					const data = (await client.get(
						`/webhooks/${webhookId}/deliveries`,
						params,
					)) as ListResponse<WebhookDeliveryRead>;
					if (gOpts.json) {
						printJson(data);
					} else {
						printTable(
							data.items.map((d) => ({
								ID: d.id,
								"Message ID": d.message_id,
								Status: d.status,
								Attempts: d.attempts,
								"Last Error": d.last_error ?? "\u2014",
								Created: d.created_at,
							})),
						);
					}
				},
			),
		);
}
