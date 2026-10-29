import type { Command } from "commander";
import {
	type AgentRecovery,
	type GapMarker,
	type GroupReseat,
	type RecoveryReport,
	DEFAULT_PROFILE,
	describeEscrowGaps,
	performRecovery,
	resolveApiUrl,
	restoreOwnerFromPhrase,
} from "@rine-network/core";
import { resolveDirs, withErrorHandler } from "../action.js";
import { printFramedPhrase } from "../phrase-display.js";
import { printError, printJson, printTable } from "../output.js";
import { promptPassword } from "../prompt.js";

/** Read the phrase without ever letting it reach argv or an echoed prompt. */
async function readPhrase(): Promise<string> {
	if (process.stdin.isTTY !== true) {
		const chunks: Buffer[] = [];
		for await (const chunk of process.stdin) {
			chunks.push(Buffer.from(chunk as Buffer));
		}
		return Buffer.concat(chunks).toString("utf-8").trim();
	}
	return (await promptPassword("Recovery phrase: ")).trim();
}

function agentRow(agent: AgentRecovery): Record<string, unknown> {
	return {
		"Agent ID": agent.agent_id,
		Name: agent.name,
		Branch: agent.branch,
		"Key gen": agent.key_gen,
		Status: agent.status,
		Reason: agent.reason ?? "",
	};
}

function reseatRow(reseat: GroupReseat): Record<string, unknown> {
	return {
		"Agent ID": reseat.agent_id,
		"Group ID": reseat.group_id ?? "",
		Status: reseat.status,
		Reason: reseat.reason ?? "",
		"Escrow Pending": reseat.escrow_pending,
		"Escrow Gaps": reseat.escrow.gaps.length,
		"Escrow Gap Epochs": describeEscrowGaps(reseat.escrow.gaps),
		"Escrow Deferral": reseat.escrow.deferral ?? "",
		"Escrow Queued": reseat.escrow.queued,
		"Escrow Dropped": reseat.escrow.dropped,
		"Escrow Backlogged": reseat.escrow.backlogged,
	};
}

function markerRow(marker: GapMarker): Record<string, unknown> {
	return {
		"Agent ID": marker.agent_id,
		"Group ID": marker.group_id,
		Epoch: marker.epoch,
		Fork: marker.fork ?? "",
		Reason: marker.reason,
	};
}

function renderReport(report: RecoveryReport): void {
	console.log(`Org ${report.org_id}`);
	console.log(`Branches: ${report.branches.join(", ")}`);
	printTable(report.agents.map(agentRow));
	if (report.closed_groups.length > 0) {
		printTable(report.closed_groups.map(reseatRow));
	}
	if (report.gap_markers.length > 0) {
		console.log("Epochs with no escrow on this device:");
		printTable(report.gap_markers.map(markerRow));
	}
	for (const note of report.notes) console.log(note);
}

interface RecoverOpts {
	ownerOnly?: boolean;
}

/** `--owner-only`: the root and org profile in the owner dir, no request and no other write. */
async function restoreOwnerOnly(
	dirs: ReturnType<typeof resolveDirs>,
	profile: string,
	json: boolean | undefined,
): Promise<void> {
	const { orgId, orgWords } = restoreOwnerFromPhrase(dirs, profile, await readPhrase());
	if (json) {
		printJson({ org_id: orgId, org_words: orgWords });
		return;
	}
	console.log(`Org ${orgId}`);
	console.log(`Org verification words: ${orgWords}`);
}

export function registerOrgRecover(org: Command, program: Command): void {
	org
		.command("recover")
		.description("Rebuild this device from the 24-word recovery phrase")
		.option(
			"--owner-only",
			"Write only the org root and profile into the owner dir: no request, no leaf keys, no group reseat",
		)
		.action(
			withErrorHandler(program, async (gOpts, opts: RecoverOpts) => {
				const profile = gOpts.profile ?? DEFAULT_PROFILE;
				if (opts.ownerOnly) {
					await restoreOwnerOnly(resolveDirs(), profile, gOpts.json);
					return;
				}
				const phrase = await readPhrase();
				const report = await performRecovery(
					resolveApiUrl(),
					resolveDirs(),
					profile,
					phrase,
					(words) =>
						// Before any network call, for a human to compare; JSON stdout
						// stays one document.
						(gOpts.json ? console.error : console.log)(
							`Org verification words: ${words}`,
						),
				);
				if (gOpts.json) {
					printJson(report);
				} else {
					renderReport(report);
				}
				if (report.agents.some((agent) => agent.status === "mismatch")) {
					process.exitCode = 1;
				}
			}),
		);

	org
		.command("phrase")
		.description("Show the recovery phrase again (terminal only)")
		.action(
			withErrorHandler(program, () => {
				if (process.stdout.isTTY !== true) {
					printError(
						"rine org phrase shows the phrase on a terminal only; the phrase file is in the owner dir.",
					);
					process.exitCode = 2;
					return;
				}
				printFramedPhrase(resolveDirs().ownerDir, "Recovery phrase");
			}),
		);
}
