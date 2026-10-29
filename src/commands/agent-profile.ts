import type { Command } from "commander";
import { withClient } from "../action.js";
import { printJson, printMutationOk, printTable } from "../output.js";
import { type AgentCard, updateCard } from "./agent-card.js";
import { addA2aCommands } from "./agent-profile-a2a.js";
import { addSetPricingCommand } from "./agent-profile-pricing.js";
import { addCsvFieldCommands, addSkillCommand } from "./agent-profile-skills.js";

function toRow(card: AgentCard): Record<string, string> {
	const rine = (card.rine as Record<string, unknown> | undefined) ?? {};
	const skillCount = Array.isArray(card.skills) ? card.skills.length : 0;
	const join = (v: unknown): string =>
		Array.isArray(v) ? (v as string[]).join(", ") : "—";
	return {
		ID: String(card.id ?? "—"),
		"Agent ID": String(card.agent_id ?? "—"),
		Name: String(card.name ?? "—"),
		Description: card.description ? String(card.description).slice(0, 60) : "—",
		Version: String(card.version ?? "—"),
		Public: String(card.is_public ?? "—"),
		Skills: String(skillCount),
		Categories: join(rine.categories) || "—",
		Languages: join(rine.languages) || "—",
		Pricing: String(rine.pricing_model ?? "—"),
		"Accept Types": join(rine.message_types_accepted) || "—",
		Updated: String(card.updated_at ?? "—"),
	};
}

function getAgentCmd(program: Command): Command {
	const cmd = program.commands.find((c) => c.name() === "agent");
	if (!cmd)
		throw new Error("registerAgent must be called before registerAgentProfile");
	return cmd;
}

export function registerAgentProfile(program: Command): void {
	const agent = getAgentCmd(program);

	agent
		.command("profile")
		.description("Get agent card")
		.argument("<agent-id>", "Agent ID")
		.action(
			withClient(program, async ({ client, gOpts }, agentId: string) => {
				const card = (await client.get(`/agents/${agentId}/card`)) as AgentCard;
				if (gOpts.json) {
					printJson(card);
				} else {
					printTable([toRow(card)]);
				}
			}),
		);

	agent
		.command("describe")
		.description("Update agent description")
		.argument("<agent-id>", "Agent ID")
		.requiredOption("--description <desc>", "Agent description")
		.action(
			withClient(
				program,
				async (
					{ client, gOpts },
					agentId: string,
					opts: { description: string },
				) => {
					await updateCard(client, agentId, (card) => {
						card.description = opts.description;
					});
					printMutationOk("Description updated", gOpts.json);
				},
			),
		);

	addSkillCommand(agent, program);
	addSetPricingCommand(agent, program);
	addCsvFieldCommands(agent, program);
	addA2aCommands(agent, program);
}
