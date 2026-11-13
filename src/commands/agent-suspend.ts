import {
	type AgentHoldView,
	type HttpClient,
	PrincipalKind,
	UUID_RE,
	getSuspension,
	listAgentStates,
	pickAgent,
	resumeAgent,
	suspendAgent,
} from "@rine-network/core";
import type { Command } from "commander";
import { type ActionContext, withClient } from "../action.js";
import { printJson, printText } from "../output.js";

/** A delegated key may not list agents, so it finds them through the org's state list. */
async function candidates(ctx: ActionContext) {
	if (ctx.auth?.signer.principal.kind === PrincipalKind.Delegate) {
		return (await listAgentStates(ctx.client)).map((s) => ({
			id: s.id,
			name: "",
			handle: s.handle,
		}));
	}
	return ctx.agents();
}

export async function resolveAgent(ctx: ActionContext, ref: string): Promise<string> {
	// A UUID names the agent already; fetching the roster would cost a request a delegate may not make.
	return pickAgent(UUID_RE.test(ref) ? [] : await candidates(ctx), ref);
}

function holdSentence(
	view: AgentHoldView,
	verb: "suspended" | "resumed",
): string {
	if (!view.changed) return `Agent ${view.agent_id} was already ${verb}.`;
	return `Agent ${view.agent_id} ${verb}.`;
}

async function change(
	ctx: ActionContext,
	ref: string,
	act: (client: HttpClient, id: string) => Promise<AgentHoldView>,
	verb: "suspended" | "resumed",
): Promise<void> {
	const view = await act(ctx.client, await resolveAgent(ctx, ref));
	if (ctx.gOpts.json) printJson(view);
	else printText(holdSentence(view, verb));
}

export function registerAgentSuspend(agent: Command, program: Command): void {
	agent
		.command("suspend <agent>")
		.description(
			"Stop an agent now; messages to it wait in its queue until it is resumed",
		)
		.action(
			withClient(program, (ctx, ref: string) =>
				change(ctx, ref, suspendAgent, "suspended"),
			),
		);

	agent
		.command("resume <agent>")
		.description("Resume an agent suspended by your side")
		.action(
			withClient(program, (ctx, ref: string) =>
				change(ctx, ref, resumeAgent, "resumed"),
			),
		);

	agent
		.command("suspension <agent>")
		.description(
			"Show whether an agent is held, and what waits behind the hold",
		)
		.action(
			withClient(program, async (ctx, ref: string) => {
				const view = await getSuspension(
					ctx.client,
					await resolveAgent(ctx, ref),
				);
				if (ctx.gOpts.json) {
					printJson(view);
					return;
				}
				printText(`Hold: ${view.hold ?? "none"}`);
				printText(`Messages waiting: ${view.queue_depth}`);
				if (view.oldest_queued_at)
					printText(`Oldest waiting since: ${view.oldest_queued_at}`);
				printText(`Webhook deliveries held: ${view.webhook_jobs_held}`);
				printText(
					`Keys rotated since the suspension: ${view.rotated_since_suspension ? "yes" : "no"}`,
				);
			}),
		);
}
