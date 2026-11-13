import { type MessageMetadata, fetchOrgMetadata } from "@rine-network/core";
import type { Command } from "commander";
import { withClient } from "../action.js";
import {
	ChainBreak,
	ChainFault,
	type ChainPosition,
	type ChainStep,
} from "./org-events-chain.js";
import { type TailOpts, addTailOptions, launchTail } from "./tail-command.js";
import type { Source } from "./tail-loop.js";
import { metadataOutgoing } from "./tail-outgoing.js";
import { METADATA_TAIL, tailText } from "./tail-text.js";

/** Metadata rows carry no hash and may skip numbers; they must only keep moving forward. */
export function metadataStep(
	row: MessageMetadata,
	previous: ChainPosition | undefined,
	afterSeq: number,
): ChainStep {
	if (row.seq <= (previous?.seq ?? afterSeq))
		throw new ChainBreak(ChainFault.Break, row.seq);
	return { position: { seq: row.seq, hash: "" } };
}

export function registerOrgMetadataTail(org: Command, program: Command): void {
	const metadata = org
		.command("metadata")
		.description("Facts about the messages the org's agents sent and received");
	addTailOptions(
		metadata
			.command("tail")
			.description(
				"Follow message metadata (never content) as one JSON row per line",
			),
		false,
	).action(
		withClient(program, async (ctx, opts: TailOpts) => {
			const orgId = ctx.auth?.orgId;
			const source: Source<MessageMetadata> = {
				fetchPage: async (after, epoch) => {
					const page = await fetchOrgMetadata(
						ctx.client,
						after,
						undefined,
						epoch,
					);
					return { items: page.rows, epoch: page.chain_epoch };
				},
				step: metadataStep,
				outgoing: (row) => metadataOutgoing(row, orgId),
			};
			await launchTail(ctx, opts, {
				text: tailText(METADATA_TAIL),
				withHead: false,
				source,
			});
		}),
	);
}
