/** Fitting message text to a width: wrapped at spaces, or cut at the edge. */
import { clipToWidth, clusterWidth, displayWidth, graphemes } from "@rine-network/core";

/** Break one line (no newlines) into pieces of at most `width` columns, at the last space where there is one. */
function wrapLine(line: string, width: number): string[] {
	if (displayWidth(line) <= width) return [line];
	const out: string[] = [];
	let current: string[] = [];
	let used = 0;
	let lastSpace = -1;
	for (const cluster of graphemes(line)) {
		const w = clusterWidth(cluster);
		if (used + w > width && current.length > 0) {
			if (cluster === " ") {
				out.push(current.join(""));
				current = [];
				used = 0;
				lastSpace = -1;
				continue;
			}
			if (lastSpace >= 0) {
				out.push(current.slice(0, lastSpace).join(""));
				current = current.slice(lastSpace + 1);
				used = displayWidth(current.join(""));
			} else {
				out.push(current.join(""));
				current = [];
				used = 0;
			}
			lastSpace = -1;
			if (used + w > width && current.length > 0) {
				out.push(current.join(""));
				current = [];
				used = 0;
			}
		}
		if (cluster === " " && current.some((c) => c !== " ")) lastSpace = current.length;
		current.push(cluster);
		used += w;
	}
	out.push(current.join(""));
	return out;
}

/** The lines of `text` as drawn: split at newlines, then wrapped to `width` or, with `wrap` off, cut at it. */
export function bodyLines(text: string, width: number, wrap: boolean): string[] {
	if (width <= 0) return [];
	return text.split("\n").flatMap((line) => (wrap ? wrapLine(line, width) : [clipToWidth(line, width)]));
}
