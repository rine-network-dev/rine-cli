/** `rine agent set-pricing` — the coarse pricing model and the x402 card terms. */

import * as fs from "node:fs";
import type { Command } from "commander";
import { withClient } from "../action.js";
import { printError, printMutationOk } from "../output.js";
import { setRineField, updateCard } from "./agent-card.js";

const VALID_PRICING = ["free", "per_request", "subscription", "negotiated"];

/**
 * Read the x402 card terms from a JSON string or a file (`-` = stdin). The
 * authoritative field shape (rail/schemes/networks/assets/mode/...) is validated
 * server-side on PUT; here we only enforce it is a JSON array so a malformed
 * value fails client-side before a needless round-trip.
 */
function readTerms(
	inline?: string,
	file?: string,
): { value: unknown[] } | { error: string } {
	if (inline !== undefined && file !== undefined) {
		return {
			error: "--x402-terms and --x402-terms-file are mutually exclusive",
		};
	}
	let raw: string;
	if (file !== undefined) {
		try {
			raw =
				file === "-"
					? fs.readFileSync(0, "utf-8")
					: fs.readFileSync(file, "utf-8");
		} catch (err) {
			return {
				error: `Cannot read terms file: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	} else {
		raw = inline as string;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { error: "x402 terms must be valid JSON" };
	}
	if (!Array.isArray(parsed)) {
		return { error: "x402 terms must be a JSON array (rail-keyed entries)" };
	}
	return { value: parsed };
}

/** Register `set-pricing` on the `agent` command group. */
export function addSetPricingCommand(agent: Command, program: Command): void {
	agent
		.command("set-pricing")
		.description(
			"Set agent pricing model and/or x402 payment terms (rine.x402.terms)",
		)
		.argument("<agent-id>", "Agent ID")
		.option("--model <model>", `Pricing model (${VALID_PRICING.join("|")})`)
		.option(
			"--x402-terms <json>",
			"x402 card terms as a JSON array; advisory only",
		)
		.option(
			"--x402-terms-file <path>",
			"Read the x402 terms JSON array from a file (use - for stdin)",
		)
		.action(
			withClient(
				program,
				async (
					{ client, gOpts },
					agentId: string,
					opts: {
						model?: string;
						x402Terms?: string;
						x402TermsFile?: string;
					},
				) => {
					if (
						opts.model === undefined &&
						opts.x402Terms === undefined &&
						opts.x402TermsFile === undefined
					) {
						printError(
							"Nothing to set. Provide --model and/or --x402-terms/--x402-terms-file.",
						);
						process.exitCode = 2;
						return;
					}
					if (opts.model !== undefined && !VALID_PRICING.includes(opts.model)) {
						printError(
							`Invalid pricing model '${opts.model}'. Valid: ${VALID_PRICING.join(", ")}`,
						);
						process.exitCode = 2;
						return;
					}

					let terms: unknown;
					if (
						opts.x402Terms !== undefined ||
						opts.x402TermsFile !== undefined
					) {
						const parsed = readTerms(opts.x402Terms, opts.x402TermsFile);
						if ("error" in parsed) {
							printError(parsed.error);
							process.exitCode = 2;
							return;
						}
						terms = parsed.value;
					}

					await updateCard(client, agentId, (card) => {
						let next = card;
						if (opts.model !== undefined) {
							next = setRineField(next, "pricing_model", opts.model);
						}
						if (terms !== undefined) {
							// The card sub-object is `rine.x402 = { terms: [...] }`
							// (server schema X402CardConfig). The pricing_model enum is
							// left untouched — the two coexist as coarse + fine signals.
							next = setRineField(next, "x402", { terms });
						}
						return next;
					});
					printMutationOk("Pricing updated", gOpts.json);
				},
			),
		);
}
