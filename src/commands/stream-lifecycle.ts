import type { GlobalOpts } from "../types.js";

/** One lifecycle event, on stdout (JSON mode) or stderr (`--monitor`, so stdout stays messages only). */
export function emitLifecycle(
	gOpts: GlobalOpts,
	monitor: boolean | undefined,
	data: Record<string, unknown>,
): void {
	if (gOpts.json) {
		const line = JSON.stringify({ event: "lifecycle", data });
		if (monitor) {
			process.stderr.write(`${line}\n`);
		} else {
			console.log(line);
		}
	}
}
