/**
 * What keeps `rine tui --feed` alive and what ends it: the parent watch, the heartbeat tick and the
 * process events.
 */

export const HEARTBEAT_MS = 15_000;
export const PARENT_CHECK_MS = 5_000;

/**
 * The process events the feed listens to: two ways to be asked to stop, two ways to have failed.
 */
export type FeedProcEvent =
	| "SIGTERM"
	| "SIGINT"
	| "uncaughtException"
	| "unhandledRejection";

export interface FeedProc {
	readonly ppid: number;
	on(event: FeedProcEvent, handler: (arg: unknown) => void): unknown;
	off(event: FeedProcEvent, handler: (arg: unknown) => void): unknown;
}

export interface LifecycleHandlers {
	/** The parent process is gone or a stop signal arrived. */
	readonly onStop: () => void;
	/** An error nothing caught. */
	readonly onCrash: (err: unknown) => void;
	readonly onHeartbeat: () => void;
}

/** Starts the timers and listeners; the returned function removes them all. */
export function startLifecycle(
	proc: FeedProc,
	handlers: LifecycleHandlers,
): () => void {
	const detach: Array<() => void> = [];
	const every = (ms: number, tick: () => void): void => {
		const timer = setInterval(tick, ms);
		detach.push(() => clearInterval(timer));
	};
	const listen = (
		event: FeedProcEvent,
		handler: (arg: unknown) => void,
	): void => {
		proc.on(event, handler);
		detach.push(() => proc.off(event, handler));
	};
	const parent = proc.ppid;
	every(PARENT_CHECK_MS, () => {
		if (proc.ppid !== parent) handlers.onStop();
	});
	every(HEARTBEAT_MS, handlers.onHeartbeat);
	listen("SIGTERM", handlers.onStop);
	listen("SIGINT", handlers.onStop);
	listen("uncaughtException", handlers.onCrash);
	listen("unhandledRejection", handlers.onCrash);
	return () => {
		for (const off of detach) off();
	};
}
