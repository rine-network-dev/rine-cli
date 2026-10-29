/** The JSON payload a `send` or `reply` carries, from `--payload` or `--payload-file`. */

import * as fs from "node:fs";

export function resolvePayload(
	payload?: string,
	payloadFile?: string,
): { parsed: unknown } | { error: string } {
	if (payload !== undefined && payloadFile !== undefined) {
		return { error: "--payload and --payload-file are mutually exclusive" };
	}
	if (payload === undefined && payloadFile === undefined) {
		return { error: "Provide --payload or --payload-file" };
	}

	let raw: string;
	if (payloadFile !== undefined) {
		try {
			raw =
				payloadFile === "-"
					? fs.readFileSync(0, "utf-8")
					: fs.readFileSync(payloadFile, "utf-8");
		} catch (err) {
			return {
				error: `Cannot read payload file: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	} else {
		raw = payload!;
	}

	try {
		return { parsed: JSON.parse(raw) };
	} catch {
		return { error: "Payload must be valid JSON" };
	}
}
