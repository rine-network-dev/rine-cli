/** The app's one motion timer: the clock, the frame for each draw, and the re-arming after it. */
import {
	type MotionClock,
	type MotionFrame,
	arrive,
	motionFrame,
	nextMotionMs,
	observe,
	startClock,
} from "./motion.js";
import type { Model } from "./state-model.js";

export interface AppMotion {
	frame(model: Model): MotionFrame;
	/** The model changed from `prev` to `next`. */
	observe(prev: Model, next: Model): void;
	/** Rows came in on a poll page. */
	arrive(ids: readonly string[]): void;
	/** Arm the timer for the next frame worth drawing, or leave it off when nothing moves. */
	arm(model: Model): void;
	stop(): void;
}

export function createMotion(deps: {
	enabled: boolean;
	now: () => number;
	redraw: () => void;
}): AppMotion {
	const { now, redraw } = deps;
	let clock: MotionClock = startClock(deps.enabled, now());
	let timer: ReturnType<typeof setTimeout> | undefined;
	return {
		frame: (model) => motionFrame(clock, model, now()),
		observe(prev, next) {
			clock = observe(clock, prev, next, now());
		},
		arrive(ids) {
			clock = arrive(clock, ids, now());
		},
		arm(model) {
			clearTimeout(timer);
			const ms = nextMotionMs(clock, model, now());
			timer = ms === null ? undefined : setTimeout(redraw, ms);
		},
		stop() {
			clearTimeout(timer);
			timer = undefined;
		},
	};
}
