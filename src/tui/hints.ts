/**
 * The key hints on the status row. Which keys are worth showing depends on where the person is and on
 * what is on screen, so the row is drawn from this table: the hints that apply, as many as fit, most
 * important first. Every key here is bound in `keymap-table.ts` (a test holds the two together).
 */
import { dotJoint } from "./glyphs.js";
import type { Focus, Model } from "./state-model.js";
import { Role, type Style } from "./style.js";
import { type Run, runsWidth } from "./widgets/runs.js";

export const HintScope = {
	List: "list",
	Reader: "reader",
	Rail: "rail",
	Search: "search",
	Help: "help",
	Findings: "findings",
} as const satisfies Record<string, Focus | "search" | "help" | "findings">;
export type HintScope = (typeof HintScope)[keyof typeof HintScope];

/** What the hint table needs to know of the screen. */
export interface HintContext {
	readonly scope: HintScope;
	readonly searchActive: boolean;
	readonly findings: boolean;
	readonly directionFiltered: boolean;
	readonly followOff: boolean;
	/** Wrap is on, or a line of the open message is cut at the edge. */
	readonly wrapMatters: boolean;
}

interface Hint {
	readonly scope: HintScope;
	/** Input names as `BINDINGS` spells them; shown joined with `/`. */
	readonly keys: readonly string[];
	readonly label: string;
	/** Lower is kept first when the row is too narrow. */
	readonly priority: number;
	readonly when?: (context: HintContext) => boolean;
}

/** In display order. */
export const HINTS: readonly Hint[] = [
	{ scope: HintScope.List, keys: ["j", "k"], label: "move", priority: 0 },
	{ scope: HintScope.List, keys: ["enter"], label: "open", priority: 1 },
	{ scope: HintScope.List, keys: ["/"], label: "search", priority: 3 },
	{
		scope: HintScope.List,
		keys: ["n", "N"],
		label: "next match",
		priority: 4,
		when: (c) => c.searchActive,
	},
	{
		scope: HintScope.List,
		keys: ["f"],
		label: "findings",
		priority: 5,
		when: (c) => c.findings,
	},
	{
		scope: HintScope.List,
		keys: ["D"],
		label: "direction",
		priority: 6,
		when: (c) => c.directionFiltered,
	},
	{
		scope: HintScope.List,
		keys: ["F"],
		label: "follow",
		priority: 7,
		when: (c) => c.followOff,
	},
	{ scope: HintScope.List, keys: ["?"], label: "help", priority: 2 },
	{ scope: HintScope.Reader, keys: ["j", "k"], label: "scroll", priority: 0 },
	{ scope: HintScope.Reader, keys: ["q"], label: "back", priority: 1 },
	{
		scope: HintScope.Reader,
		keys: ["w"],
		label: "wrap",
		priority: 3,
		when: (c) => c.wrapMatters,
	},
	{ scope: HintScope.Reader, keys: ["?"], label: "help", priority: 2 },
	{ scope: HintScope.Rail, keys: ["j", "k"], label: "move", priority: 0 },
	{ scope: HintScope.Rail, keys: ["enter"], label: "choose", priority: 1 },
	{ scope: HintScope.Rail, keys: ["l"], label: "list", priority: 3 },
	{ scope: HintScope.Rail, keys: ["?"], label: "help", priority: 2 },
	{ scope: HintScope.Search, keys: ["enter"], label: "find", priority: 0 },
	{ scope: HintScope.Search, keys: ["esc"], label: "cancel", priority: 1 },
	{ scope: HintScope.Help, keys: ["?"], label: "close", priority: 0 },
	{ scope: HintScope.Findings, keys: ["j", "k"], label: "scroll", priority: 0 },
	{ scope: HintScope.Findings, keys: ["f"], label: "close", priority: 1 },
];

export function hintContext(model: Model, wrapMatters: boolean): HintContext {
	const scope = model.search.editing
		? HintScope.Search
		: model.overlay === "none"
			? model.focus
			: model.overlay === "help"
				? HintScope.Help
				: HintScope.Findings;
	return {
		scope,
		searchActive: model.search.matches.length > 0,
		findings: model.findings.length > 0,
		directionFiltered: model.filter.direction !== "all",
		followOff: !model.follow,
		wrapMatters,
	};
}

const KEY: Style = { fg: Role.Accent, bold: true };
const LABEL: Style = { fg: Role.Dim };
const keyText = (hint: Hint): string => hint.keys.join("/");

function runsOf(hints: readonly Hint[], unicode: boolean): Run[] {
	return hints.flatMap((hint, i) => [
		...(i === 0 ? [] : [{ text: dotJoint(unicode), style: LABEL }]),
		{ text: keyText(hint), style: KEY },
		{ text: ` ${hint.label}`, style: LABEL },
	]);
}

/**
 * The hints that apply to `context`, in display order, as many as fit in `width` columns when taken
 * most important first.
 */
export function hintRuns(context: HintContext, width: number, unicode: boolean): Run[] {
	const applicable = HINTS.filter(
		(hint) => hint.scope === context.scope && (hint.when?.(context) ?? true),
	);
	const kept: Hint[] = [];
	for (const hint of [...applicable].sort((a, b) => a.priority - b.priority)) {
		const next = applicable.filter((h) => h === hint || kept.includes(h));
		if (runsWidth(runsOf(next, unicode)) > width) break;
		kept.push(hint);
	}
	return runsOf(
		applicable.filter((hint) => kept.includes(hint)),
		unicode,
	);
}
