/**
 * Navigation maths for the reducer: where a keymap `move` or `jump` lands in the list or the
 * reader.
 */
import type { Action, JumpTarget, MoveUnit, Step } from "./keymap-table.js";

/** The one next/prev to +/- convention, shared with the reducer. */
export function signed(step: Step): 1 | -1;
export function signed(step: Step, amount: number): number;
export function signed(step: Step, amount = 1): number {
	return step === "next" ? amount : -amount;
}

function unitSize(unit: MoveUnit, height: number): number {
	return unit === "row"
		? 1
		: Math.max(1, unit === "halfPage" ? height >> 1 : height - 1);
}

/**
 * The row a `move` or `jump` lands on, or undefined for `centre` (which scrolls and does not
 * select).
 */
export function listTarget(
	action: Extract<Action, { kind: "move" | "jump" }>,
	index: number,
	rows: number,
	view: { top: number; height: number },
): number | undefined {
	if (action.kind === "move")
		return (
			index +
			signed(action.step, action.count * unitSize(action.unit, view.height))
		);
	const shown = Math.max(1, Math.min(view.height, rows - view.top));
	const targets: Record<JumpTarget, number | undefined> = {
		first: 0,
		last: rows - 1,
		screenTop: view.top,
		screenMiddle: view.top + ((shown - 1) >> 1),
		screenBottom: view.top + shown - 1,
		centre: undefined,
	};
	return targets[action.to];
}

/**
 * The reader's next scroll offset, unclamped (`last` is Infinity); the caller clamps to the body
 * length.
 */
export function scrollTarget(
	action: Extract<Action, { kind: "move" | "jump" }>,
	scroll: number,
	height: number,
): number {
	if (action.kind === "move")
		return (
			scroll + signed(action.step, action.count * unitSize(action.unit, height))
		);
	return action.to === "first"
		? 0
		: action.to === "last"
			? Number.POSITIVE_INFINITY
			: scroll;
}
