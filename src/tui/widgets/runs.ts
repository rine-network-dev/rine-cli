/** A line made of differently styled pieces, and the width maths to clip and place it. */
import { clipToWidth, displayWidth } from "@rine-network/core";
import type { Screen } from "../screen.js";
import { PLAIN, type Style } from "../style.js";

export interface Run {
	readonly text: string;
	/** Laid over the style the whole line is drawn in. */
	readonly style?: Style;
}

export const runsWidth = (runs: readonly Run[]): number =>
	runs.reduce((sum, run) => sum + displayWidth(run.text), 0);

/** The runs cut at `width` columns. */
export function clipRuns(runs: readonly Run[], width: number): Run[] {
	const out: Run[] = [];
	let left = Math.max(0, width);
	for (const run of runs) {
		if (left <= 0) break;
		const text = clipToWidth(run.text, left);
		if (text === "") continue;
		out.push({ ...run, text });
		left -= displayWidth(text);
	}
	return out;
}

/**
 * The runs fitted to exactly `width` columns: cut with `ellipsis` in the style of the last run kept
 * when too wide, padded with spaces when too narrow.
 */
export function fitRuns(runs: readonly Run[], width: number, ellipsis: string): Run[] {
	if (width <= 0) return [];
	const room = runsWidth(runs);
	if (room <= width) return [...runs, { text: " ".repeat(width - room) }];
	const kept = clipRuns(runs, width - displayWidth(ellipsis));
	const last = kept[kept.length - 1];
	const pad = width - runsWidth(kept) - displayWidth(ellipsis);
	return [
		...kept,
		{ text: ellipsis + " ".repeat(Math.max(0, pad)), style: last?.style },
	];
}

/** Draw the runs from (x, y), each over `base`; returns the column after the last. */
export function putRuns(
	screen: Screen,
	x: number,
	y: number,
	runs: readonly Run[],
	base: Style = PLAIN,
): number {
	let col = x;
	for (const run of runs) col = screen.put(col, y, run.text, { ...base, ...run.style });
	return col;
}
