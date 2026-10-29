/**
 * Motion: what is animating, when to draw next, and the frame each draw takes.
 *
 * The clock holds only what cannot be recomputed from the model: when the view started, which rows
 * arrived on a poll and when, and when the reader was opened. A `MotionFrame` is everything the
 * renderer needs from it for one instant. `RESTING` is the frame with nothing in motion, which is
 * what every frame is when motion is off and what the golden tests draw.
 */
import type { Caps } from "./caps.js";
import { DECODE_MS, REVEAL_MS, SCAN_PASS_MS, SHIMMER_MS, TICK_MS } from "./motion-effects.js";
import type { Connection, Model } from "./state-model.js";

const PULSE_MS = 350;
const SPIN_MS = 120;

/** Names the variable that turns motion off. */
const REDUCED_MOTION_ENV = "RINE_REDUCED_MOTION";

export interface MotionClock {
	readonly enabled: boolean;
	readonly startedAt: number;
	/** Rows that arrived on a poll page, by id, with the time they arrived. */
	readonly arrivals: ReadonlyMap<string, number>;
	readonly opened: { readonly id: string; readonly at: number } | null;
}

export interface MotionFrame {
	/** Spinner step. */
	readonly spin: number;
	/** Pulse step of the live dot. */
	readonly pulse: number;
	/** Milliseconds into the wordmark reveal; null once it has finished. */
	readonly revealMs: number | null;
	/** Where the scan segment is in its pass, 0 to 1; null when no scan runs. */
	readonly scan: number | null;
	/** Milliseconds into the cascade of each row still shimmering, by id. */
	readonly shimmer: ReadonlyMap<string, number>;
	/** Milliseconds into the reader's decode; null once it has finished. */
	readonly decodeMs: number | null;
}

export const RESTING: MotionFrame = {
	spin: 0,
	pulse: 0,
	revealMs: null,
	scan: null,
	shimmer: new Map(),
	decodeMs: null,
};

/**
 * Motion needs colour, unicode, a live terminal and no request for less. Off, every frame is the
 * resting one.
 */
export function motionEnabled(caps: Caps, env: NodeJS.ProcessEnv, isTty: boolean): boolean {
	return caps.color !== "none" && caps.unicode && isTty && !env[REDUCED_MOTION_ENV];
}

export const startClock = (enabled: boolean, now: number): MotionClock => ({
	enabled,
	startedAt: now,
	arrivals: new Map(),
	opened: null,
});

/** Rows that came in on a poll: they shimmer in. Arrivals whose cascade is over are forgotten. */
export function arrive(clock: MotionClock, ids: readonly string[], now: number): MotionClock {
	if (!clock.enabled || ids.length === 0) return clock;
	const live = [...clock.arrivals].filter(([, at]) => now - at < SHIMMER_MS);
	return { ...clock, arrivals: new Map([...live, ...ids.map((id): [string, number] => [id, now])]) };
}

/** The reader opening starts its decode. */
export function observe(
	clock: MotionClock,
	prev: Pick<Model, "focus">,
	next: Pick<Model, "focus" | "selectedId">,
	now: number,
): MotionClock {
	if (!clock.enabled || prev.focus === "reader" || next.focus !== "reader") return clock;
	return next.selectedId === null ? clock : { ...clock, opened: { id: next.selectedId, at: now } };
}

const within = (since: number, now: number, span: number): number | null =>
	now - since < span ? now - since : null;

/** The scan runs while the feed is down or paused and retrying. */
const SCANNING: ReadonlySet<Connection["kind"]> = new Set(["paused", "network", "failing"]);

export function motionFrame(clock: MotionClock, model: Model, now: number): MotionFrame {
	if (!clock.enabled) return RESTING;
	const shimmer = new Map<string, number>();
	for (const [id, at] of clock.arrivals) {
		const elapsed = within(at, now, SHIMMER_MS);
		if (elapsed !== null) shimmer.set(id, elapsed);
	}
	const { opened } = clock;
	const reading = opened !== null && model.focus === "reader" && model.selectedId === opened.id;
	return {
		spin: Math.floor(now / SPIN_MS),
		pulse: Math.floor(now / PULSE_MS),
		revealMs: within(clock.startedAt, now, REVEAL_MS),
		scan: SCANNING.has(model.connection.kind) ? (now % SCAN_PASS_MS) / SCAN_PASS_MS : null,
		shimmer,
		decodeMs: reading ? within(opened.at, now, DECODE_MS) : null,
	};
}

/**
 * Milliseconds until the next frame is worth drawing, or null when nothing is moving. The caller keeps
 * one timer and re-arms it from this after every draw.
 */
export function nextMotionMs(clock: MotionClock, model: Model, now: number): number | null {
	if (!clock.enabled) return null;
	const frame = motionFrame(clock, model, now);
	if (frame.revealMs !== null || frame.shimmer.size > 0 || frame.decodeMs !== null) return TICK_MS;
	if (frame.scan !== null) return TICK_MS;
	switch (model.connection.kind) {
		case "loading":
			return SPIN_MS;
		case "live":
			return PULSE_MS;
		default:
			return null;
	}
}
