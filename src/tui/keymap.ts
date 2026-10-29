/**
 * Keys to actions for the standalone TUI: vi motions with count prefixes, the two-key sequences
 * `gg` and `zz`, and search entry. The interpreter and the help overlay both read `BINDINGS`.
 */

import { type Action, BINDINGS } from "./keymap-table.js";
import type { Key } from "./keys.js";

export { BINDINGS } from "./keymap-table.js";
export type {
	Action,
	BindingRow,
	JumpTarget,
	MoveUnit,
	Step,
} from "./keymap-table.js";

export type Mode = "normal" | "search";

export interface KeymapState {
	/** The count typed so far (`5` of `5j`), or null. */
	count: number | null;
	/** Tokens of an unfinished multi-key sequence (`g` of `gg`). */
	prefix: readonly string[];
}

export const initialKeymapState: KeymapState = { count: null, prefix: [] };

const MAX_COUNT = 9999;

/**
 * Sequence (tokens joined by a space) to its action, and every proper prefix of a multi-key
 * sequence.
 */
const SEQUENCES = new Map<string, Action>();
const PREFIXES = new Set<string>();
for (const [inputs, action] of BINDINGS.flatMap((row) => row.binds)) {
	for (const input of inputs.split("|")) {
		SEQUENCES.set(input, action);
		const tokens = input.split(" ");
		for (let n = 1; n < tokens.length; n++)
			PREFIXES.add(tokens.slice(0, n).join(" "));
	}
}

/**
 * The token for a key, or null for one the keymap never uses (alt chords, pastes, other named
 * keys).
 */
function tokenOf(key: Key): string | null {
	if (key.kind === "paste" || key.alt) return null;
	if (key.kind === "char") return key.ctrl ? `ctrl-${key.char}` : key.char;
	if (key.name === "tab") return key.shift ? "shift-tab" : "tab";
	if (key.name === "backtab") return "shift-tab";
	if (key.name === "escape") return "esc";
	return key.name;
}

export interface Interpreted {
	action: Action | null;
	state: KeymapState;
}

const none = (state: KeymapState): Interpreted => ({ action: null, state });

function interpretSearch(key: Key): Action | null {
	if (key.kind === "paste") return { kind: "searchInput", text: key.text };
	if (key.kind === "char") {
		if (key.alt) return null;
		if (key.ctrl) return key.char === "c" ? { kind: "quit" } : null;
		return { kind: "searchInput", text: key.char };
	}
	if (key.name === "enter") return { kind: "searchRun" };
	if (key.name === "escape") return { kind: "searchCancel" };
	if (key.name === "backspace") return { kind: "searchBackspace" };
	return null;
}

/**
 * Feed one key. In `search` mode (typing after `/`) every character is text. In `normal` mode
 * digits build a count (`0` only extends one), `gg` and `zz` wait for their second key, Esc clears
 * a pending count or prefix, and an unknown key clears both and is ignored. ctrl-c always quits.
 */
export function interpret(
	state: KeymapState,
	key: Key,
	mode: Mode = "normal",
): Interpreted {
	if (mode === "search") return { action: interpretSearch(key), state };
	const token = tokenOf(key);
	if (token === null) return none(initialKeymapState);
	if (token === "ctrl-c")
		return { action: { kind: "quit" }, state: initialKeymapState };
	const pending = state.count !== null || state.prefix.length > 0;
	if (token === "esc" && pending) return none(initialKeymapState);
	const isDigit = token.length === 1 && token >= "0" && token <= "9";
	if (
		isDigit &&
		state.prefix.length === 0 &&
		(token !== "0" || state.count !== null)
	) {
		return none({
			count: Math.min((state.count ?? 0) * 10 + Number(token), MAX_COUNT),
			prefix: [],
		});
	}
	const path = [...state.prefix, token].join(" ");
	const action = SEQUENCES.get(path);
	if (action) {
		const counted =
			action.kind === "move" ? { ...action, count: state.count ?? 1 } : action;
		return { action: counted, state: initialKeymapState };
	}
	if (PREFIXES.has(path))
		return none({ count: state.count, prefix: path.split(" ") });
	return none(initialKeymapState);
}
