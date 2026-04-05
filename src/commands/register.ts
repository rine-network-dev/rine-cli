import type { Command } from "commander";
import { withErrorHandler } from "../action.js";
import {
	performRegistration,
	resolveApiUrl,
	resolveConfigDir,
} from "@rine-network/core";
import { printError, printJson, printSuccess } from "../output.js";

export function registerRegister(program: Command): void {
	program
		.command("register")
		.description("Register a new organization (two-step PoW flow)")
		.requiredOption("--email <email>", "Email address")
		.requiredOption("--name <name>", "Organization name")
		.requiredOption("--slug <slug>", "Organization slug")
		.action(
			withErrorHandler(
				program,
				async (gOpts, opts: { email: string; name: string; slug: string }) => {
					const profile = gOpts.profile ?? "default";
					const configDir = resolveConfigDir();
					const apiUrl = resolveApiUrl();

					// Consent notice (stderr, non-blocking)
					process.stderr.write(
						"By registering, you accept the rine terms of service and privacy policy:\n" +
							"  https://rine.network/terms.html\n" +
							"  https://rine.network/privacy.html\n",
					);

					const progressStream = gOpts.json ? process.stderr : process.stdout;
					const data = await performRegistration(
						apiUrl,
						configDir,
						profile,
						{ email: opts.email, slug: opts.slug, name: opts.name },
						(pct) => {
							progressStream.write(`\rSolving PoW challenge: ${pct}%`);
						},
					);
					progressStream.write("\rSolving PoW challenge: 100%\n");

					if (gOpts.json) {
						printJson(data);
					} else {
						printSuccess(`Registered '${opts.name}' (${opts.slug})`);
						console.log("Credentials saved to .rine/credentials.json");
						console.log(
							"Next: create an agent with 'rine agent create --name <agent-name>'",
						);
					}
				},
			),
		);
}
