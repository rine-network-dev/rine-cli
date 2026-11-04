import { raceDeadline } from "@rine-network/core";

const FLUSH_WAIT_MS = 5000;

/**
 * The stop state of one `rine stream` run: a single listener per signal that
 * ends the loop, cuts a backoff short and closes the open connection. SIGTERM
 * is how a supervisor stops the process and flushes what Ctrl-C does; a second
 * signal exits without the flush.
 */
export interface StreamStop {
	/** Fires on the first stop signal. */
	readonly signal: AbortSignal;
	readonly stopped: boolean;
	/** Register how to close the connection that is open right now. */
	onStop(close: (() => void) | undefined): void;
}

export function listenForStop(): StreamStop {
	let stopped = false;
	let closeConnection: (() => void) | undefined;
	const controller = new AbortController();
	const stop = () => {
		if (stopped) process.exit(0);
		stopped = true;
		controller.abort();
		process.exitCode = 0;
		closeConnection?.();
	};
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
	return {
		signal: controller.signal,
		get stopped() {
			return stopped;
		},
		onStop(close) {
			closeConnection = close;
		},
	};
}

/**
 * End the process with `code` once stdout and stderr have flushed. On a full
 * pipe Node queues writes and `process.exit` drops them, so a line whose row
 * was already acknowledged would never reach the reader. A reader stalled past
 * the wait does not hold the process open.
 */
export async function exitWhenFlushed(
	code: typeof process.exitCode,
	flushWaitMs = FLUSH_WAIT_MS,
): Promise<void> {
	const flushed = (out: NodeJS.WriteStream) =>
		new Promise<void>((resolve) => out.write("", () => resolve()));
	try {
		await raceDeadline(
			Promise.all([flushed(process.stdout), flushed(process.stderr)]),
			flushWaitMs,
		);
	} catch {
		/* the reader is stalled; what it has not read is lost */
	}
	process.exit(code);
}
