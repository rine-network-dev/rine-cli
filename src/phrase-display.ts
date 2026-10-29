import { PHRASE_FILE, PHRASE_INSTRUCTION, readOwnerPhrase } from "@rine-network/core";
import { join } from "node:path";

/** The one place the words reach a screen: framed, on a terminal. */
export function printFramedPhrase(ownerDir: string, heading: string): void {
	const rule = "=".repeat(72);
	console.log(
		[
			rule,
			heading,
			readOwnerPhrase(ownerDir),
			`Also saved to: ${join(ownerDir, PHRASE_FILE)}`,
			PHRASE_INSTRUCTION,
			rule,
		].join("\n"),
	);
}

/**
 * Tell the owner where the phrase is. On a terminal and outside `--json` the
 * words are shown once; anywhere else only the file path is printed, so the
 * phrase cannot reach a log, a pipe or a model context.
 */
export function announcePhrase(opts: {
	ownerDir: string;
	phrasePath: string;
	json: boolean | undefined;
}): void {
	if (process.stdout.isTTY === true && !opts.json) {
		printFramedPhrase(opts.ownerDir, "Recovery phrase (shown once)");
		return;
	}
	const stream = opts.json ? process.stderr : process.stdout;
	stream.write(
		`Recovery phrase file: ${opts.phrasePath}\n${PHRASE_INSTRUCTION}\n`,
	);
}
