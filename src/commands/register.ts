import type { Command } from "commander";
import { resolveDirs, withErrorHandler } from "../action.js";
import {
	DEFAULT_PROFILE,
	performRegistration,
	resolveApiUrl,
} from "@rine-network/core";
import { announcePhrase } from "../phrase-display.js";
import { printJson, printSuccess } from "../output.js";

export function registerRegister(program: Command): void {
	program
		.command("register")
		.description(
			"Register a new organization (two-step PoW flow). Writes the org root key and recovery phrase to the owner dir",
		)
		.requiredOption("--email <email>", "Email address")
		.requiredOption("--name <name>", "Organization name")
		.requiredOption("--slug <slug>", "Organization slug")
		.action(
			withErrorHandler(
				program,
				async (gOpts, opts: { email: string; name: string; slug: string }) => {
					const profile = gOpts.profile ?? DEFAULT_PROFILE;
					const dirs = resolveDirs();
					const apiUrl = resolveApiUrl();

					// Consent notice (stderr, non-blocking)
					process.stderr.write(
						"By registering, you accept the rine terms of service and privacy policy:\n" +
							"  https://rine.network/terms.html\n" +
							"  https://rine.network/privacy.html\n",
					);

					const progressStream = gOpts.json ? process.stderr : process.stdout;
					const reg = await performRegistration(
						apiUrl,
						dirs,
						profile,
						{ email: opts.email, slug: opts.slug, name: opts.name },
						(pct) => {
							progressStream.write(`\rSolving PoW challenge: ${pct}%`);
						},
					);
					progressStream.write("\rSolving PoW challenge: 100%\n");

					// The one place the words reach a screen, and only on a terminal.
					announcePhrase({
						ownerDir: dirs.ownerDir,
						phrasePath: reg.phrase_path,
						json: gOpts.json,
					});

					if (gOpts.json) {
						printJson({
							org_id: reg.org_id,
							org_words: reg.org_words,
							recovery_phrase_file: reg.phrase_path,
						});
					} else {
						printSuccess(`Registered '${opts.name}' (${opts.slug})`);
						console.log(`Org id: ${reg.org_id}`);
						console.log(`Org verification words: ${reg.org_words}`);
						console.log(
							"Next: create an agent with 'rine agent create --name <agent-name>'",
						);
					}
				},
			),
		);
}
