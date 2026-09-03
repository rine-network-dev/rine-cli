import {
	type GroupRead,
	ACTING_AGENT_HEADER,
	describeMlsRecovery,
	groupMlsInitInFlight,
	isMlsResyncUnavailable,
	mlsInitInFlightSync,
	recoverGroup,
} from "@rine-network/core";
import type { Command } from "commander";
import { type ActionContext, withClient } from "../action.js";
import { actorOption } from "../actor.js";
import { printError, printJson, printText } from "../output.js";
import { mlsFailureText } from "./group-mls.js";
import { CLI_UNFOUNDED_REPAIR } from "./group-rows.js";
import { GROUP_REFERENCE_HELP, groupTarget } from "./group-target.js";

// The recovery summary lives in `rine-core/src/mls-recovery-format.ts` and the
// branch in `rine-core/src/group-recovery.ts`: MCP's `rine_group_sync` says the
// same things, and one event described in two wordings is the defect a single
// shared formatter exists to stop.
//
// The `GET /groups/{id}` stays in front of the recovery and its row is what is
// handed on. It is what answers "does this group exist, and is this agent
// seated in it", in the server's own words, and it is what says which
// encryption the group runs — a mistyped id resolved from local state alone
// came back as "ask an admin to remove this agent and invite it again".

export function registerGroupSync(program: Command, group: Command): void {
	group
		.command("sync")
		.description(
			"Catch this agent's group encryption state up, and say what it cost",
		)
		.argument("<group-ref>", GROUP_REFERENCE_HELP)
		// Group encryption state is per AGENT — one ratchet-tree leaf, one local
		// store — so "catch this agent's state up" has to say which agent on a
		// multi-agent org. `recoverGroup` is handed the id below and the header
		// rides with it.
		.addOption(actorOption("which agent's group state is caught up"))
		.action(
			withClient(program, async (ctx: ActionContext, ref: string) => {
				// One read, not two: the ladder's UUID rung IS `GET /groups/{id}`.
				const { row: target } = await groupTarget(ctx, ref);
				// 🔴 Everything this command prints names the group the way the row
				// spells it, never the way the caller did — the same rule the
				// init-in-flight guard below already followed, now that a caller can
				// spell it three ways.
				const label = target.handle ?? target.id;
				// 🔴 Refused on the row this command already fetched, before any
				// work, and with exit 2 — the shape `rine group resume-admission`
				// uses for the same class of answer (`group-requests.ts`). A group
				// between its MLS init and the latch has neither recovery: there is
				// no epoch chain to catch up with and no sender keys to install, and
				// the server clears the state itself within minutes. Exit 2 across
				// this CLI means "the command declined to act", never "no retry
				// helps", and 2 is what `@rine-network/cli` published for this case.
				// `recoverGroup` keeps its own throw — that is the SDK-level
				// contract, and every other TypeScript surface still reads it.
				//
				// 🔴 `target.handle ?? target.id`, the identifier the throw this
				// guard bypasses formats (`group-recovery.ts`), and never the
				// raw argument: the Python twin formats the row's handle, so
				// echoing the UUID here is one event printing two sentences
				// depending on which SDK a surface wraps. Bypassing the throw
				// must not bypass what the throw said.
				if (groupMlsInitInFlight(target)) {
					printError(mlsInitInFlightSync(target.handle ?? target.id));
					process.exitCode = 2;
					return;
				}
				const actingId = await ctx.actingAgent();
				try {
					const result = await recoverGroup(
						ctx.configDir,
						actingId,
						target,
						ctx.client,
						{ [ACTING_AGENT_HEADER]: actingId },
						// This surface is the one that can act on the answer: a group
						// whose tree was never founded is founded by
						// `rine group resume-admission`, which branches to the init on an
						// unlatched group. Every other TypeScript surface names no verb,
						// because the nearest one it has refuses this state.
						CLI_UNFOUNDED_REPAIR,
					);
					if (ctx.gOpts.json) {
						printJson(result);
					} else {
						printText(describeMlsRecovery(label, result));
					}
				} catch (err) {
					printError(mlsFailureText(err, label));
					// A group this agent cannot recover from at all is a different
					// answer than a recovery that failed: the remedy is an admin's,
					// not a retry, so it gets its own exit code.
					process.exitCode = isMlsResyncUnavailable(err) ? 2 : 1;
				}
			}),
		);
}
