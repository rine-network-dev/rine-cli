/** `rine agent enable-a2a` / `disable-a2a` — the card's A2A bridge switch. */

import type { Command } from "commander";
import { withClient } from "../action.js";
import { printJson, printMutationOk, printSuccess } from "../output.js";
import { setRineField, updateCard } from "./agent-card.js";

/** Register `enable-a2a` and `disable-a2a` on the `agent` command group. */
export function addA2aCommands(agent: Command, program: Command): void {
	agent
		.command("enable-a2a")
		.description("Enable A2A protocol bridge for this agent")
		.argument("<agent-id>", "Agent ID")
		.action(
			withClient(program, async ({ client, gOpts }, agentId: string) => {
				const result = await updateCard(client, agentId, (card) =>
					setRineField(card, "a2a_enabled", true),
				);
				if (gOpts.json) {
					printJson(result);
					return;
				}
				const rine = (result.rine as Record<string, unknown> | undefined) ?? {};
				const endpoint = rine.a2a_endpoint;
				if (endpoint) {
					printSuccess(`A2A enabled. Endpoint: ${endpoint}`);
				} else {
					printSuccess("A2A enabled (endpoint not yet set by server)");
				}
			}),
		);

	agent
		.command("disable-a2a")
		.description("Disable A2A protocol bridge for this agent")
		.argument("<agent-id>", "Agent ID")
		.action(
			withClient(program, async ({ client, gOpts }, agentId: string) => {
				await updateCard(client, agentId, (card) =>
					setRineField(card, "a2a_enabled", false),
				);
				printMutationOk("A2A disabled", gOpts.json);
			}),
		);
}
