import type { Command } from "commander";
import { withErrorHandler } from "../action.js";
import {
	cacheToken,
	getApiUrl,
	loadCredentials,
	saveCredentials,
} from "../config.js";
import { fetchOAuthToken } from "../http.js";
import { printError, printJson, printSuccess } from "../output.js";
import { solveTimeLockWithProgress } from "../timelock.js";

interface ChallengeResponse {
	challenge_id: string;
	prefix: string;
	modulus: string;
	difficulty: number;
	algorithm: string;
	expires_in: number;
}

interface RegisterSolveResponse {
	org_id: string;
	client_id: string;
	client_secret: string;
}

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
					const apiUrl = getApiUrl();

					// Step 1: POST /auth/register → get PoW challenge
					const challengeRes = await fetch(`${apiUrl}/auth/register`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ email: opts.email, org_slug: opts.slug }),
					});
					if (challengeRes.status === 409) {
						printError("Email or slug already registered");
						process.exitCode = 1;
						return;
					}
					if (challengeRes.status === 429) {
						printError("Rate limited — please wait before retrying");
						process.exitCode = 1;
						return;
					}
					if (!challengeRes.ok) {
						const body = (await challengeRes.json().catch(() => ({}))) as {
							detail?: string;
						};
						printError(
							`Registration failed: ${body.detail ?? challengeRes.statusText}`,
						);
						process.exitCode = 1;
						return;
					}
					const challenge = (await challengeRes.json()) as ChallengeResponse;

					// Step 2: Validate algorithm
					if (challenge.algorithm !== "rsa-timelock-v1") {
						printError(
							`Unsupported algorithm: ${challenge.algorithm}. Please upgrade rine-cli.`,
						);
						process.exitCode = 1;
						return;
					}

					// Consent notice (stderr, non-blocking)
					process.stderr.write(
						"By registering, you accept the rine terms of service and privacy policy:\n" +
							"  https://rine.network/terms.html\n" +
							"  https://rine.network/privacy.html\n",
					);

					// Step 3: Solve PoW
					const progressStream = gOpts.json ? process.stderr : process.stdout;
					const nonce = await solveTimeLockWithProgress(
						challenge.prefix,
						challenge.modulus,
						challenge.difficulty,
						(pct) => {
							progressStream.write(`\rSolving PoW challenge: ${pct}%`);
						},
					);
					progressStream.write("\rSolving PoW challenge: 100%\n");

					// Step 4: POST /auth/register/solve
					const solveRes = await fetch(`${apiUrl}/auth/register/solve`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							challenge_id: challenge.challenge_id,
							nonce,
							org_name: opts.name,
							org_slug: opts.slug,
							consent: true,
						}),
					});
					if (solveRes.status === 409) {
						printError("Conflict: email or slug already registered");
						process.exitCode = 1;
						return;
					}
					if (solveRes.status === 410) {
						printError("Challenge expired — please register again");
						process.exitCode = 1;
						return;
					}
					if (!solveRes.ok) {
						const body = (await solveRes.json().catch(() => ({}))) as {
							detail?: string;
						};
						printError(`Solve failed: ${body.detail ?? solveRes.statusText}`);
						process.exitCode = 1;
						return;
					}
					const data = (await solveRes.json()) as RegisterSolveResponse;

					// Step 5: Save credentials (flat format)
					const creds = loadCredentials();
					creds[profile] = {
						client_id: data.client_id,
						client_secret: data.client_secret,
					};
					saveCredentials(creds);

					// Step 6: Cache initial token (non-fatal)
					try {
						const tokenData = await fetchOAuthToken(
							data.client_id,
							data.client_secret,
						);
						cacheToken(profile, tokenData);
					} catch {
						process.stderr.write("Warning: initial token cache failed\n");
					}

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
