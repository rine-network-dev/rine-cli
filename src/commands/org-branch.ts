import type { Command } from "commander";
import * as fs from "node:fs";
import {
	assertBranchName,
	createBranch,
	deriveBranch,
	loadOrgFromOwner,
	parseRecipientKey,
	recipientKeyWords,
	revokeBranch,
	sealBranchBundle,
	toBase64Url,
	writeAtomic,
} from "@rine-network/core";
import { withClient } from "../action.js";
import { printError, printJson } from "../output.js";
import { promptConfirm } from "../prompt.js";

const NO_ROOT =
	"Creating a branch needs this org's root key (root.key in the owner dir). A delegate cannot create branches.";

interface CreateOpts {
	to: string;
	out?: string;
	wordsConfirmed?: boolean;
}

interface RevokeOpts {
	confirm?: boolean;
}

export function registerOrgBranch(org: Command, program: Command): void {
	const branch = org
		.command("branch")
		.description(
			"Delegate a subtree of this org to a partner; branch names are public, never put a customer name or a secret in one",
		);

	branch
		.command("create <name>")
		.description("Create a branch and seal its bundle to a recipient key")
		.requiredOption("--to <recipient-key>", "The fleet's recipient key")
		.option("--out <file>", "Where to write the sealed bundle")
		.option("--words-confirmed", "Skip the interactive word comparison")
		.action(
			withClient(
				program,
				async ({ client, gOpts, ownerDir }, name: string, opts: CreateOpts) => {
					assertBranchName(name);
					const org = loadOrgFromOwner(ownerDir);
					if (org === undefined) {
						printError(NO_ROOT);
						process.exitCode = 2;
						return;
					}
					const key = parseRecipientKey(opts.to);
					const words = recipientKeyWords(key);
					// The words are for a human to compare; JSON stdout stays one document.
					(gOpts.json ? console.error : console.log)(
						`Recipient key verification words: ${words}`,
					);

					if (!opts.wordsConfirmed) {
						if (process.stdin.isTTY !== true) {
							printError(
								"Cannot confirm the recipient key words without a terminal; compare them with the dashboard, then re-run with --words-confirmed.",
							);
							process.exitCode = 2;
							return;
						}
						const ok = await promptConfirm(
							"Do these words match the ones shown in the dashboard?",
						);
						if (!ok) {
							printError("Aborted: the words did not match.");
							process.exitCode = 1;
							return;
						}
					}

					const derived = deriveBranch(org, name);
					const bundle = sealBranchBundle(key, org.orgId, derived);
					const path = opts.out ?? `rine-branch-${name}.sealed`;
					writeAtomic(path, `${toBase64Url(bundle)}\n`);

					try {
						await createBranch(client, org, derived);
					} catch (err) {
						fs.rmSync(path, { force: true });
						throw err;
					}

					if (gOpts.json) {
						printJson({
							branch: derived.name,
							org_id: org.orgId,
							sealed_bundle: path,
							recipient_key_words: words,
						});
						return;
					}
					console.log(`Branch '${name}' created in org ${org.orgId}.`);
					console.log(`Sealed bundle: ${path}`);
					console.log("Upload the bundle in the dashboard's connect step.");
				},
			),
		);

	branch
		.command("revoke <name>")
		.description("Revoke a branch")
		.option(
			"--confirm",
			"Revoke 'main' or the org's last live branch, which the server refuses without it",
		)
		.action(
			withClient(program, async ({ client, gOpts }, name: string, opts: RevokeOpts) => {
				await revokeBranch(client, name, opts.confirm === true);
				if (gOpts.json) {
					printJson({ branch: name, revoked: true });
					return;
				}
				console.log(`Branch '${name}' revoked.`);
				console.log("Its agents can no longer authenticate or be sealed to.");
				console.log(
					"Closed-group seats are not removed: a group admin must Remove its agents.",
				);
				console.log(
					"Revocation never revokes read: the branch holder still reads what it already saw.",
				);
			}),
		);
}
