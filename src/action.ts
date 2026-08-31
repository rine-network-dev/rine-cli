import type { Command } from "commander";
import {
	type AgentRead,
	type CredentialEntry,
	type HttpClient,
	type TokenFn,
	HttpClient as HttpClientClass,
	formatError,
	getCredentialEntry,
	getOrRefreshToken,
	resolveApiUrl,
	resolveConfigDir,
} from "@rine-network/core";
import { actorLadder } from "./acting-agent.js";
import { commandOf, namedActor } from "./actor.js";
import { printError } from "./output.js";
import type { GlobalOpts } from "./types.js";

export type ActionContext = {
	client: HttpClient;
	gOpts: GlobalOpts;
	profileName: string;
	configDir: string;
	apiUrl: string;
	/**
	 * The client's own default headers, held by reference — writing one here
	 * puts it on every later request of this command. Deliberate.
	 */
	extraHeaders: Record<string, string>;
	/**
	 * The org's agents, fetched once and remembered.
	 *
	 * A command that has to name an agent — its handle in a table, its words in
	 * a comparison — asks here rather than fetching a second list that the
	 * ladder has already paid for.
	 */
	agents: () => Promise<AgentRead[]>;
	/**
	 * Which agent this command is acting as, resolved once and remembered.
	 *
	 * The ladder, in the one place the CLI climbs it: a flag, then
	 * `RINE_AGENT`, then the org's only agent, then a refusal naming them all.
	 * Resolving pins `X-Rine-Agent` for the rest of the command, so a command
	 * that needs the id and a command that only needs the header agree.
	 */
	actingAgent: () => Promise<string>;
};

/**
 * A check that can refuse a command before it costs anything.
 *
 * Returns the refusal, or `null` to proceed. It runs before the config dir is
 * read and before a client exists, so a caller who typed nothing usable is told
 * so instead of being asked which agent they are.
 */
// biome-ignore lint/suspicious/noExplicitAny: commander passes heterogeneous positional args
export type Precheck = (...args: any[]) => string | null;

// biome-ignore lint/suspicious/noExplicitAny: commander passes heterogeneous positional args
type ActionFn = (ctx: ActionContext, ...args: any[]) => Promise<void>;
// biome-ignore lint/suspicious/noExplicitAny: commander passes heterogeneous positional args
type WrappedFn = (...args: any[]) => Promise<void>;

async function createClient(
	configDir: string,
	apiUrl: string,
	profileFlag?: string,
	defaultHeaders?: Record<string, string>,
): Promise<{
	client: HttpClientClass;
	profileName: string;
	entry: CredentialEntry | undefined;
}> {
	const profileName = profileFlag ?? "default";
	const entry = getCredentialEntry(configDir, profileName);
	const envToken = process.env.RINE_TOKEN;
	const canRefresh = !envToken && entry !== undefined;
	const tokenFn: TokenFn = (force = false) =>
		getOrRefreshToken(configDir, apiUrl, entry, profileName, { force, envToken });
	const client = new HttpClientClass({ tokenFn, apiUrl, canRefresh, defaultHeaders });
	return { client, profileName, entry };
}

export { createClient };

export function withClient(
	program: Command,
	fn: ActionFn,
	precheck?: Precheck,
): WrappedFn {
	return async (...args) => {
		try {
			if (precheck) {
				const refusal = precheck(...args);
				if (refusal !== null) {
					printError(refusal);
					process.exitCode = 2;
					return;
				}
			}
			const gOpts = program.opts<GlobalOpts>();
			// Conflicting spellings first: two that disagree refuse before
			// either can reach a header, and before the call costs a round trip.
			const flagged = namedActor(commandOf(args), gOpts);
			const configDir = resolveConfigDir();
			const apiUrl = resolveApiUrl();
			const defaultHeaders: Record<string, string> = {};
			const { client, profileName } = await createClient(
				configDir,
				apiUrl,
				gOpts.profile,
				defaultHeaders,
			);

			const { named, agents, actingAgent } = actorLadder(
				flagged,
				client,
				defaultHeaders,
			);
			// A named actor is pinned up front, as `--as` always has been: the
			// caller said who is acting, so every request of this command says
			// it too, whether or not the command asks for the id. An unnamed one
			// stays lazy — resolving it eagerly would refuse in a multi-agent org
			// for commands that never needed an actor.
			//
			// 🔴 `named` is the *ladder's*, not the flag: exporting `RINE_AGENT`
			// names the acting agent just as plainly as typing `--agent`, and a
			// command that never asks for the id (`group join`, `group invites`)
			// would otherwise POST with the header still unset and be refused by
			// the server. One opinion, held in one place (`acting-agent.ts`).
			if (named !== undefined) await actingAgent();

			await fn(
				{
					client,
					gOpts,
					profileName,
					configDir,
					apiUrl,
					extraHeaders: defaultHeaders,
					agents,
					actingAgent,
				},
				...args,
			);
		} catch (err) {
			printError(formatError(err));
			process.exitCode = 1;
		}
	};
}

export function withErrorHandler(
	program: Command,
	// biome-ignore lint/suspicious/noExplicitAny: commander passes heterogeneous positional args
	fn: (gOpts: GlobalOpts, ...args: any[]) => Promise<void> | void,
): WrappedFn {
	return async (...args) => {
		try {
			const gOpts = program.opts<GlobalOpts>();
			await fn(gOpts, ...args);
		} catch (err) {
			printError(formatError(err));
			process.exitCode = 1;
		}
	};
}
