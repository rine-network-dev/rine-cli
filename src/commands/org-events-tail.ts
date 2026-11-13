import { fetchOrgEvents, type OrgEvent } from "@rine-network/core";
import type { Command } from "commander";
import { withClient } from "../action.js";
import { verifyEvent } from "./org-events-chain.js";
import { eventOutgoing } from "./tail-outgoing.js";
import { type TailOpts, addTailOptions, launchTail } from "./tail-command.js";
import type { Source } from "./tail-loop.js";
import { EVENTS_TAIL, tailText } from "./tail-text.js";

const eventSource = (
	fetchPage: (
		after: number,
		epoch: number | undefined,
	) => ReturnType<typeof fetchOrgEvents>,
): Source<OrgEvent> => ({
	fetchPage: async (after, epoch) => {
		const page = await fetchPage(after, epoch);
		return {
			items: page.events,
			epoch: page.chain_epoch,
			floor: page.retention_floor,
		};
	},
	step: verifyEvent,
	outgoing: eventOutgoing,
});

export function registerOrgEventsTail(org: Command, program: Command): void {
	const events = org
		.command("events")
		.description("The org's tamper-evident event log");
	addTailOptions(
		events
			.command("tail")
			.description(
				"Follow the event log as one JSON envelope per line, verifying its hash chain and checking a signed head every minute",
			),
		true,
	).action(
		withClient(program, async (ctx, opts: TailOpts) => {
			await launchTail(ctx, opts, {
				text: tailText(EVENTS_TAIL),
				withHead: true,
				source: eventSource((after, epoch) =>
					fetchOrgEvents(ctx.client, after, undefined, epoch),
				),
			});
		}),
	);
}
