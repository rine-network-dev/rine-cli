/**
 * The standalone keymap as data: the action vocabulary and the one binding table (standalone
 * column).
 */

export type Step = "next" | "prev";
export type MoveUnit = "row" | "halfPage" | "page";
export type JumpTarget =
	| "first"
	| "last"
	| "screenTop"
	| "screenMiddle"
	| "screenBottom"
	| "centre";

export type Action =
	| { kind: "move"; unit: MoveUnit; step: Step; count: number }
	| { kind: "jump"; to: JumpTarget }
	| { kind: "focus"; step: Step }
	| { kind: "open" }
	/** Esc: close the reader or an overlay, and never quit. */
	| { kind: "close" }
	/** `q`: close the reader or an overlay, and from the list quit. */
	| { kind: "closeOrQuit" }
	| { kind: "quit" }
	| { kind: "searchStart" }
	| { kind: "searchStep"; step: Step }
	| { kind: "gap"; step: Step }
	| { kind: "cycleDirection" }
	| { kind: "toggleFollow" }
	| { kind: "refresh" }
	| { kind: "toggleWrap" }
	| { kind: "help" }
	| { kind: "findings" }
	| { kind: "redraw" }
	| { kind: "suspend" }
	| { kind: "searchInput"; text: string }
	| { kind: "searchBackspace" }
	| { kind: "searchRun" }
	| { kind: "searchCancel" };

/**
 * A bind pairs input sequences with an action. Inputs read `"j|down"`: alternatives split on `|`,
 * the keys of one sequence on a space (`"g g"`). A key is a character, `ctrl-<c>`, or `up down left
 * right tab shift-tab enter esc pageUp pageDown`. A `move` carries the typed count; for every other
 * action the count is ignored.
 */
export type Bind = readonly [inputs: string, action: Action];

export interface BindingRow {
	/** What the row does, as the help overlay words it. */
	label: string;
	/** The keys as shown in the help overlay; equals the standalone column of the binding table. */
	display: string;
	binds: readonly Bind[];
}

const mv = (unit: MoveUnit, step: Step): Action => ({
	kind: "move",
	unit,
	step,
	count: 1,
});

export const BINDINGS: readonly BindingRow[] = [
	{
		label: "next / previous row (or line in the reader)",
		display: "j/k, ↓/↑",
		binds: [
			["j|down", mv("row", "next")],
			["k|up", mv("row", "prev")],
		],
	},
	{
		label: "first / last loaded row",
		display: "gg / G",
		binds: [
			["g g", { kind: "jump", to: "first" }],
			["G", { kind: "jump", to: "last" }],
		],
	},
	{
		label: "half page / page",
		display: "ctrl-d/ctrl-u, ctrl-f/ctrl-b, PgDn/PgUp",
		binds: [
			["ctrl-d", mv("halfPage", "next")],
			["ctrl-u", mv("halfPage", "prev")],
			["ctrl-f|pageDown", mv("page", "next")],
			["ctrl-b|pageUp", mv("page", "prev")],
		],
	},
	{
		label: "top / middle / bottom of screen; centre",
		display: "H M L; zz",
		binds: [
			["H", { kind: "jump", to: "screenTop" }],
			["M", { kind: "jump", to: "screenMiddle" }],
			["L", { kind: "jump", to: "screenBottom" }],
			["z z", { kind: "jump", to: "centre" }],
		],
	},
	{
		label: "move focus rail / list / reader",
		display: "h/l, ←/→, Tab/shift-Tab",
		binds: [
			["h|left|shift-tab", { kind: "focus", step: "prev" }],
			["l|right|tab", { kind: "focus", step: "next" }],
		],
	},
	{
		label: "open in the reader / choose a rail entry",
		display: "Enter, o",
		binds: [["enter|o", { kind: "open" }]],
	},
	{
		label: "close the reader or overlay",
		display: "q, Esc",
		binds: [
			["q", { kind: "closeOrQuit" }],
			["esc", { kind: "close" }],
		],
	},
	{
		label: "quit",
		display: "q from the list, ctrl-c",
		binds: [["ctrl-c", { kind: "quit" }]],
	},
	{
		label: "search loaded rows; next / previous match",
		display: "/ (Enter runs, Esc cancels); n / N",
		binds: [
			["/", { kind: "searchStart" }],
			["n", { kind: "searchStep", step: "next" }],
			["N", { kind: "searchStep", step: "prev" }],
		],
	},
	{
		label: "next / previous gap or unverified row",
		display: "] / [",
		binds: [
			["]", { kind: "gap", step: "next" }],
			["[", { kind: "gap", step: "prev" }],
		],
	},
	{
		label: "cycle direction all, sent, received, internal",
		display: "D",
		binds: [["D", { kind: "cycleDirection" }]],
	},
	{
		label: "follow on/off",
		display: "F",
		binds: [["F", { kind: "toggleFollow" }]],
	},
	{
		label: "re-read from the newest page",
		display: "R",
		binds: [["R", { kind: "refresh" }]],
	},
	{
		label: "wrap long lines",
		display: "w",
		binds: [["w", { kind: "toggleWrap" }]],
	},
	{
		label: "list findings",
		display: "f",
		binds: [["f", { kind: "findings" }]],
	},
	{ label: "help", display: "?", binds: [["?", { kind: "help" }]] },
	{
		label: "redraw",
		display: "ctrl-l",
		binds: [["ctrl-l", { kind: "redraw" }]],
	},
	{
		label: "suspend",
		display: "ctrl-z",
		binds: [["ctrl-z", { kind: "suspend" }]],
	},
];
