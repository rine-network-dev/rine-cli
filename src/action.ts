import type { Command } from "commander";
import { formatError } from "./errors.js";
import { type HttpClient, createClient } from "./http.js";
import { printError } from "./output.js";
import { resolveToUuid } from "./resolve-agent.js";
import type { GlobalOpts } from "./types.js";

export type ActionContext = {
	client: HttpClient;
	gOpts: GlobalOpts;
	profileName: string;
	/** Extra headers injected on every request (e.g. X-Rine-Agent from --as). */
	extraHeaders: Record<string, string>;
};

// biome-ignore lint/suspicious/noExplicitAny: commander passes heterogeneous positional args
type ActionFn = (ctx: ActionContext, ...args: any[]) => Promise<void>;
// biome-ignore lint/suspicious/noExplicitAny: commander passes heterogeneous positional args
type WrappedFn = (...args: any[]) => Promise<void>;

/**
 * Wraps a command action with automatic client creation and error handling.
 * Commander calls action(fn) with positional args first, then the options object.
 * This wrapper forwards all arguments to the inner function.
 */
export function withClient(program: Command, fn: ActionFn): WrappedFn {
	return async (...args) => {
		try {
			const gOpts = program.opts<GlobalOpts>();
			const defaultHeaders: Record<string, string> = {};
			if (gOpts.as) {
				defaultHeaders["X-Rine-Agent"] = await resolveToUuid(gOpts.as);
			}
			const { client, profileName } = await createClient(
				gOpts.profile,
				defaultHeaders,
			);
			await fn(
				{ client, gOpts, profileName, extraHeaders: defaultHeaders },
				...args,
			);
		} catch (err) {
			printError(formatError(err));
			process.exitCode = 1;
		}
	};
}

/**
 * Wraps a command action with error handling only (no client creation).
 * For commands like logout that don't need authentication.
 */
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
