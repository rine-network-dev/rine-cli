/**
 * Keys from the terminal to reducer actions: the byte parser, the keymap, and the timer that tells
 * a lone ESC from a sequence.
 */
import {
	type Action,
	type KeymapState,
	type Mode,
	initialKeymapState,
	interpret,
} from "./keymap.js";
import {
	type Key,
	type KeyState,
	flushEscape,
	initialKeyState,
	parseKeys,
} from "./keys.js";
import type { Term } from "./term.js";

const ESC = "\x1b";
/** A lone ESC is the Escape key unless the rest of a sequence arrives within this long. */
export const ESCAPE_MS = 30;

export interface InputSink {
	/** `search` while the `/` prompt takes text, else `normal`. */
	mode(): Mode;
	action(action: Action): void;
}

/** Starts reading keys; the returned function stops the escape timer. */
export function attachInput(
	term: Pick<Term, "onData">,
	sink: InputSink,
): () => void {
	let keyState: KeyState = initialKeyState;
	let keymap: KeymapState = initialKeymapState;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const press = (pressed: readonly Key[]): void => {
		for (const key of pressed) {
			const step = interpret(keymap, key, sink.mode());
			keymap = step.state;
			if (step.action !== null) sink.action(step.action);
		}
	};
	term.onData((chunk) => {
		clearTimeout(timer);
		const parsed = parseKeys(chunk, keyState);
		keyState = parsed.state;
		press(parsed.keys);
		if (keyState.pending !== ESC) return;
		timer = setTimeout(() => {
			const flushed = flushEscape(keyState);
			keyState = flushed.state;
			press(flushed.keys);
		}, ESCAPE_MS);
	});
	return () => clearTimeout(timer);
}
