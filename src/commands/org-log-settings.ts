import { fetchLogSettings, putLogSettings } from "@rine-network/core";
import type { Command } from "commander";
import { withClient } from "../action.js";
import { printJson, printText } from "../output.js";

const kept = (days: number) =>
	`Events are now kept for ${days} days. Events already older are removed within a day.`;

export function registerOrgLogSettings(org: Command, program: Command): void {
	const settings = org
		.command("log-settings")
		.description("How long the org's event log keeps its events");

	settings
		.command("get")
		.description("Show the event retention period")
		.action(
			withClient(program, async ({ client, gOpts }) => {
				const current = await fetchLogSettings(client);
				if (gOpts.json) printJson(current);
				else printText(`Event retention: ${current.event_retention_days} days`);
			}),
		);

	settings
		.command("set <days>")
		.description("Set the event retention period (the organisation owner only)")
		.action(
			withClient(program, async ({ client, gOpts }, raw: string) => {
				const days = Number(raw);
				if (!Number.isSafeInteger(days) || days < 1)
					throw new Error("days must be a whole number of at least 1");
				const saved = await putLogSettings(client, days);
				if (gOpts.json) printJson(saved);
				else printText(kept(saved.event_retention_days));
			}),
		);
}
