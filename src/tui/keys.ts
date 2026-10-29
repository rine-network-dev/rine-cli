/** Pure terminal input parser: a chunk of stdin text becomes keys; an incomplete sequence is carried in the state. */

export type NamedKey =
	| "up"
	| "down"
	| "left"
	| "right"
	| "home"
	| "end"
	| "pageUp"
	| "pageDown"
	| "insert"
	| "delete"
	| "enter"
	| "tab"
	| "backtab"
	| "backspace"
	| "escape";

export type Key =
	| { kind: "char"; char: string; ctrl: boolean; alt: boolean }
	| {
			kind: "named";
			name: NamedKey;
			ctrl: boolean;
			shift: boolean;
			alt: boolean;
	  }
	| { kind: "paste"; text: string };

export interface KeyState {
	/** An incomplete escape sequence waiting for its next chunk. A lone ESC stays here until `flushEscape`. */
	pending: string;
	/** Text collected since the bracketed-paste start marker, or null outside a paste. */
	paste: string | null;
}

export const initialKeyState: KeyState = { pending: "", paste: null };

const ESC = "\x1b";
const PASTE_END = `${ESC}[201~`;
const MAX_PENDING = 64;
const MAX_PASTE = 1 << 20;

const CSI_FINAL: Record<string, NamedKey> = {
	A: "up",
	B: "down",
	C: "right",
	D: "left",
	H: "home",
	F: "end",
	Z: "backtab",
};

const TILDE_CODE: Record<number, NamedKey> = {
	1: "home",
	2: "insert",
	3: "delete",
	4: "end",
	5: "pageUp",
	6: "pageDown",
	7: "home",
	8: "end",
};

const named = (name: NamedKey, mod = 1, alt = false): Key => ({
	kind: "named",
	name,
	shift: name === "backtab" || ((mod - 1) & 1) === 1,
	alt: alt || ((mod - 1) & 2) === 2,
	ctrl: ((mod - 1) & 4) === 4,
});

const char = (c: string, ctrl = false, alt = false): Key => ({
	kind: "char",
	char: c,
	ctrl,
	alt,
});

type Step = { key?: Key; next: number } | "incomplete";

/** Parse the sequence that starts with ESC at `i`. */
function parseEscape(s: string, i: number): Step {
	const intro = s[i + 1];
	if (intro === undefined) return "incomplete";
	if (intro === "[") {
		let j = i + 2;
		while (j < s.length && s.charCodeAt(j) >= 0x20 && s.charCodeAt(j) <= 0x3f)
			j++;
		if (j >= s.length) return "incomplete";
		const final = s[j] as string;
		const params = s.slice(i + 2, j);
		const [first, second] = params
			.split(";")
			.map((p) => Number.parseInt(p, 10));
		const mod = second !== undefined && second > 0 ? second : 1;
		if (final === "~") {
			const name = first === undefined ? undefined : TILDE_CODE[first];
			return { key: name && named(name, mod), next: j + 1 };
		}
		const name = CSI_FINAL[final];
		return { key: name && named(name, mod), next: j + 1 };
	}
	if (intro === "O") {
		const final = s[i + 2];
		if (final === undefined) return "incomplete";
		const name = CSI_FINAL[final];
		return { key: name && named(name), next: i + 3 };
	}
	const cp = s.codePointAt(i + 1) as number;
	const width = cp > 0xffff ? 2 : 1;
	if (intro === ESC) return { key: named("escape"), next: i + 1 };
	if (cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp < 0xa0)) {
		return { next: i + 1 + width };
	}
	return {
		key: char(String.fromCodePoint(cp), false, true),
		next: i + 1 + width,
	};
}

function parseByte(c: string, cp: number): Key | undefined {
	if (cp === 0x0d || cp === 0x0a) return named("enter");
	if (cp === 0x09) return named("tab");
	if (cp === 0x7f || cp === 0x08) return named("backspace");
	if (cp >= 0x01 && cp <= 0x1a)
		return char(String.fromCharCode(cp + 0x60), true);
	if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return undefined;
	return char(c);
}

export function parseKeys(
	chunk: string,
	state: KeyState = initialKeyState,
): { keys: Key[]; state: KeyState } {
	const keys: Key[] = [];
	let paste = state.paste;
	const s = state.pending + chunk;
	let pending = "";
	let i = 0;
	while (i < s.length) {
		if (paste !== null) {
			const end = s.indexOf(PASTE_END, i);
			if (end === -1) {
				const keep = s.lastIndexOf(ESC);
				const tail =
					keep >= i && PASTE_END.startsWith(s.slice(keep)) ? keep : s.length;
				paste = (paste + s.slice(i, tail)).slice(0, MAX_PASTE);
				pending = s.slice(tail);
				i = s.length;
			} else {
				keys.push({
					kind: "paste",
					text: (paste + s.slice(i, end)).slice(0, MAX_PASTE),
				});
				paste = null;
				i = end + PASTE_END.length;
			}
			continue;
		}
		if (s[i] === ESC) {
			if (s.startsWith(`${ESC}[200~`, i)) {
				paste = "";
				i += 6;
				continue;
			}
			const step = parseEscape(s, i);
			if (step === "incomplete") {
				pending = s.slice(i);
				if (pending.length > MAX_PENDING) pending = "";
				break;
			}
			if (step.key) keys.push(step.key);
			i = step.next;
			continue;
		}
		const cp = s.codePointAt(i) as number;
		const c = String.fromCodePoint(cp);
		const key = parseByte(c, cp);
		if (key) keys.push(key);
		i += c.length;
	}
	return { keys, state: { pending, paste } };
}

/**
 * Resolve what is still pending once the app's 30 ms timer fires: a lone ESC is the Escape key, an unfinished
 * sequence is dropped.
 */
export function flushEscape(state: KeyState): { keys: Key[]; state: KeyState } {
	const keys =
		state.pending === ESC && state.paste === null ? [named("escape")] : [];
	return { keys, state: { pending: "", paste: state.paste } };
}
