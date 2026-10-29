/**
 * The relay's lifecycle events: one `{event: "lifecycle", data}` JSON line on
 * stdout under `--json`, nothing otherwise. Events name states and never carry
 * a request body or the hook secret.
 */
export function emitLifecycle(
	json: boolean | undefined,
	data: Record<string, unknown>,
): void {
	if (json) console.log(JSON.stringify({ event: "lifecycle", data }));
}
