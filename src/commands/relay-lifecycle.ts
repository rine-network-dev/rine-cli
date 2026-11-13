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

/** How long a paused relay waits between attempts to re-bind. */
export const PAUSED_RETRY_MS = 30_000;

/** The sentence logged, and carried in the event, when the agent is held. */
export const PAUSED_MESSAGE = `tunnel paused: the agent is suspended; retrying every ${PAUSED_RETRY_MS / 1000} s`;
