import { resolveApiUrl } from "@rine-network/core";
import { type Command, Option } from "commander";
import { runApp } from "../tui/app.js";
import { NEEDS_TERMINAL } from "../tui/copy.js";
import { DEFAULT_POLL_S } from "../tui/data.js";
import { FeedExit, TuiExit } from "../tui/feed-schema.js";
import { runFeed } from "../tui/feed.js";
import { resolveIdentity } from "../tui/identity.js";
import { fatalLine } from "../tui/term.js";
import type { GlobalOpts } from "../types.js";

const POLL_MAX_S = 120;

interface TuiOpts {
	ascii?: boolean;
	feed?: boolean;
	once?: boolean;
	before?: string;
	agent?: string;
	group?: string;
	poll?: string;
}

/** The poll cadence in seconds: 5 to 120, and 5 when absent or not a number. */
const pollSeconds = (value: string | undefined): number => {
	const seconds = Number(value);
	return Number.isFinite(seconds) && value !== undefined
		? Math.min(POLL_MAX_S, Math.max(DEFAULT_POLL_S, Math.round(seconds)))
		: DEFAULT_POLL_S;
};

async function runTui(
	opts: TuiOpts,
	profile: string | undefined,
): Promise<number> {
	const writeError = (text: string): void => {
		process.stderr.write(text);
	};
	if (!opts.feed && !(process.stdout.isTTY && process.stdin.isTTY)) {
		writeError(`${NEEDS_TERMINAL}\n`);
		return TuiExit.NeedsTerminal;
	}
	try {
		const identity = resolveIdentity({ profile });
		const host = new URL(resolveApiUrl()).host;
		const pollS = pollSeconds(opts.poll);
		if (!opts.feed) {
			return await runApp({
				identity,
				host,
				pollS,
				ascii: opts.ascii === true,
				env: process.env,
				stdin: process.stdin,
				stdout: process.stdout,
				writeError,
			});
		}
		return await runFeed(
			{
				agent: opts.agent ?? null,
				group: opts.group ?? null,
				pollS,
				once: opts.once === true,
				before: opts.before ?? null,
				host,
			},
			{ identity, writeError, write: (line) => process.stdout.write(line) },
		);
	} catch (err) {
		writeError(fatalLine(err));
		return opts.feed ? FeedExit.Failed : TuiExit.Failed;
	}
}

export function registerTui(program: Command): void {
	program
		.command("tui")
		.description(
			"Read the messages of every agent in your org in a terminal view (needs the org key)",
		)
		.option("--ascii", "draw with plain ASCII characters")
		// The plugin's line feed: not documented, because running it is the same as holding the
		// org read key.
		.addOption(new Option("--feed", "NDJSON feed of the same rows").hideHelp())
		.addOption(
			new Option("--once", "feed: emit the first page and exit").hideHelp(),
		)
		.addOption(
			new Option(
				"--before <cursor>",
				"feed: start from an older page",
			).hideHelp(),
		)
		.addOption(
			new Option("--agent <id>", "feed: only this agent's messages").hideHelp(),
		)
		.addOption(
			new Option("--group <id>", "feed: only this group's messages").hideHelp(),
		)
		.addOption(
			new Option(
				"--poll <seconds>",
				"feed: seconds between reads (5 to 120)",
			).hideHelp(),
		)
		.action(async (opts: TuiOpts) => {
			process.exitCode = await runTui(opts, program.opts<GlobalOpts>().profile);
		});
}
