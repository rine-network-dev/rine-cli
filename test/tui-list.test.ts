import { describe, expect, it } from "vitest";
import { Screen } from "../src/tui/screen.js";
import { Role } from "../src/tui/style.js";
import { drawBox } from "../src/tui/widgets/box.js";
import { drawList, type ListItem, type ListView, scrollIntoView } from "../src/tui/widgets/list.js";
import { type ListParties, PartiesShape } from "../src/tui/widgets/parties.js";
import { drawScrollbar, thumbSpan } from "../src/tui/widgets/scrollbar.js";

function rowText(s: Screen, y: number): string {
	let line = "";
	for (let x = 0; x < s.cols; x++) line += s.cell(x, y).text;
	return line;
}

const group: ListParties = {
	shape: PartiesShape.GroupSender,
	lead: { text: "#mx-orgread-closed-874177@mx-ts-sdk-874177" },
	joint: { text: " · " },
	tail: { text: "salesteam-europe@fjord21735" },
};

function item(n: number, over: Partial<ListItem> = {}): ListItem {
	return {
		parties: {
			shape: PartiesShape.FromTo,
			lead: { text: `a${n}` },
			joint: { text: " → ", style: { fg: Role.Dim } },
			tail: { text: `b${n}` },
		},
		text: `message ${n}`,
		textStyle: {},
		date: "14:02",
		glyph: "✓",
		glyphRole: Role.Ok,
		...over,
	};
}

const view = (over: Partial<ListView> = {}): ListView => ({ total: 1000, top: 0, selected: 0, focused: true, unicode: true, ...over });

describe("scrollIntoView", () => {
	it("keeps the window when the selection is on screen", () => {
		expect(scrollIntoView(10, 14, 5, 100)).toBe(10);
	});
	it("moves as little as possible", () => {
		expect(scrollIntoView(10, 9, 5, 100)).toBe(9);
		expect(scrollIntoView(10, 15, 5, 100)).toBe(11);
	});
	it("never scrolls past the last full window", () => {
		expect(scrollIntoView(0, 99, 5, 100)).toBe(95);
		expect(scrollIntoView(50, 2, 10, 3)).toBe(0);
	});
});

describe("drawList", () => {
	it("asks for visible rows only, however many are loaded", () => {
		const s = new Screen(60, 5);
		const asked: number[] = [];
		drawList(s, { x: 0, y: 0, w: 60, h: 5 }, view({ top: 400, selected: 402 }), (i) => {
			asked.push(i);
			return item(i);
		});
		expect(asked).toEqual([400, 401, 402, 403, 404]);
		expect(rowText(s, 2)).toContain("message 402");
	});

	it("draws fewer rows when the list is shorter than the window", () => {
		const s = new Screen(60, 5);
		drawList(s, { x: 0, y: 0, w: 60, h: 5 }, view({ total: 2 }), (i) => item(i));
		expect(rowText(s, 1)).toContain("message 1");
		expect(rowText(s, 2).trim()).toBe("");
	});

	it("puts the glyph before the scrollbar column and anchors it", () => {
		const s = new Screen(40, 3);
		drawList(s, { x: 0, y: 0, w: 40, h: 3 }, view({ total: 3 }), (i) => item(i));
		expect(s.cell(38, 0).text).toBe("✓");
		expect(s.cell(38, 0).anchored).toBe(true);
		expect(s.cell(38, 0).style.fg).toBe(Role.Ok);
		expect(s.cell(39, 0).text).toBe(" ");
	});

	it("shows a gap sentence in warn in place of the snippet", () => {
		const s = new Screen(80, 1);
		const gap = item(0, {
			textStyle: { fg: Role.Warn },
			glyph: "!",
			glyphRole: Role.Warn,
			text: "No key copy for epoch 41",
		});
		drawList(s, { x: 0, y: 0, w: 80, h: 1 }, view({ total: 1 }), () => gap);
		expect(rowText(s, 0)).toContain("No key copy for epoch 41");
		expect(s.cell(27, 0).style.fg).toBe(Role.Warn);
	});

	it("marks the selected row with reverse video and no other row", () => {
		const s = new Screen(40, 3);
		drawList(s, { x: 0, y: 0, w: 40, h: 3 }, view({ total: 3, selected: 1 }), (i) => item(i));
		expect(s.cell(10, 1).style.reverse).toBe(true);
		expect(s.cell(10, 0).style.reverse).toBeFalsy();
	});

	it("puts an accent bar in column 0 of the selected row only", () => {
		const s = new Screen(40, 3);
		drawList(s, { x: 0, y: 0, w: 40, h: 3 }, view({ total: 3, selected: 1 }), (i) => item(i));
		expect(s.cell(0, 1).text).toBe("▌");
		expect(s.cell(0, 1).style.fg).toBe(Role.Accent);
		expect(s.cell(0, 1).style.reverse).toBeFalsy();
		expect(s.cell(0, 0).text).toBe(" ");
	});

	it("uses > for the selection bar in ASCII and dims it when the list lacks focus", () => {
		const s = new Screen(40, 1);
		drawList(s, { x: 0, y: 0, w: 40, h: 1 }, view({ total: 1, unicode: false, focused: false }), (i) => item(i));
		expect(s.cell(0, 0).text).toBe(">");
		expect(s.cell(0, 0).style.fg).toBe(Role.Dim);
	});

	it("right-aligns the date, dim, in a nine-cell column before the glyph", () => {
		const s = new Screen(60, 2);
		drawList(s, { x: 0, y: 0, w: 60, h: 2 }, view({ total: 2 }), (i) => item(i, { date: i === 0 ? "now" : "yesterday" }));
		expect(rowText(s, 0).slice(48, 57)).toBe("      now");
		expect(rowText(s, 1).slice(48, 57)).toBe("yesterday");
		expect(s.cell(55, 0).style.fg).toBe(Role.Dim);
		expect(s.cell(58, 0).text).toBe("✓");
	});

	it("keeps the arrow between the parties dim and the names plain", () => {
		const s = new Screen(60, 1);
		drawList(s, { x: 0, y: 0, w: 60, h: 1 }, view({ total: 1 }), (i) => item(i));
		expect(rowText(s, 0).slice(1, 9)).toBe("a0 → b0 ");
		expect(s.cell(4, 0).style.fg).toBe(Role.Dim);
		expect(s.cell(1, 0).style.fg).toBeUndefined();
	});

	it("cuts a bare party with an ellipsis before the snippet loses its place", () => {
		const s = new Screen(60, 1);
		const wide = item(0, { parties: { ...item(0).parties, lead: { text: "n".repeat(60) } } });
		drawList(s, { x: 0, y: 0, w: 60, h: 1 }, view({ total: 1 }), () => wide);
		expect(rowText(s, 0).slice(1, 19)).toBe(`${"n".repeat(12)}… → b0`);
		expect(rowText(s, 0)).toContain("message 0");
	});

	it("keeps the name of a remote party and clips its domain first", () => {
		const s = new Screen(80, 1);
		const remote = item(0, { parties: { ...item(0).parties, lead: { text: "me" }, tail: { text: "salesteam-europe@fjord21735" } } });
		drawList(s, { x: 0, y: 0, w: 80, h: 1 }, view({ total: 1 }), () => remote);
		expect(rowText(s, 0).slice(1, 25)).toBe("me → salesteam-europe@f…");
	});

	it("lets a group use the room a short sender leaves, its name before its @org", () => {
		const s = new Screen(100, 1);
		const parties = { ...group, tail: { text: "mx-cli" } };
		drawList(s, { x: 0, y: 0, w: 100, h: 1 }, view({ total: 1 }), () => item(0, { parties }));
		expect(rowText(s, 0).slice(1, 29)).toBe("#mx-orgrea…@mx-ts-… · mx-cli");
	});

	it("caps a group at 60 % of the column when the sender needs more", () => {
		const s = new Screen(100, 1);
		const parties = { ...group, lead: { text: "#ops-and-sales-team-europe" } };
		drawList(s, { x: 0, y: 0, w: 100, h: 1 }, view({ total: 1 }), () => item(0, { parties }));
		expect(rowText(s, 0).slice(1, 29)).toBe("#ops-and-sales… · sales…@fj…");
	});

	it("clips long text with an ellipsis, in ASCII too, and keeps the glyph column", () => {
		const s = new Screen(30, 1);
		const long = item(0, { text: "x".repeat(100), glyph: "+" });
		drawList(s, { x: 0, y: 0, w: 30, h: 1 }, view({ total: 1, unicode: false }), () => long);
		expect(rowText(s, 0)).toContain("~");
		expect(s.cell(28, 0).text).toBe("+");
	});

	it("draws a proportional scrollbar in the last column", () => {
		const s = new Screen(40, 10);
		drawList(s, { x: 0, y: 0, w: 40, h: 10 }, view({ total: 100 }), (i) => item(i));
		expect(s.cell(39, 0).text).toBe("█");
		expect(s.cell(39, 9).text).toBe("│");
	});
});

describe("scrollbar", () => {
	it("draws nothing when everything fits", () => {
		expect(thumbSpan(10, { total: 5, visible: 10, offset: 0 })).toBeNull();
	});
	it("sizes the thumb by the visible share and parks it at the ends", () => {
		expect(thumbSpan(10, { total: 100, visible: 20, offset: 0 })).toEqual({ start: 0, length: 2 });
		expect(thumbSpan(10, { total: 100, visible: 20, offset: 80 })).toEqual({ start: 8, length: 2 });
		expect(thumbSpan(10, { total: 100000, visible: 10, offset: 0 })?.length).toBe(1);
	});
	it("uses # and | in ASCII", () => {
		const s = new Screen(1, 4);
		drawScrollbar(s, 0, 0, 4, { total: 40, visible: 10, offset: 0 }, { unicode: false });
		expect([0, 1, 2, 3].map((y) => s.cell(0, y).text).join("")).toBe("#|||");
	});
});

describe("drawBox", () => {
	it("draws rounded borders with a title and a right-aligned badge, and returns the inside", () => {
		const s = new Screen(30, 4);
		const inner = drawBox(s, { x: 0, y: 0, w: 30, h: 4 }, { unicode: true, title: [{ text: "rine · acme" }], badge: "● live" });
		expect(rowText(s, 0)).toBe(`╭ rine · acme ${"─".repeat(7)} ● live ╮`);
		expect(rowText(s, 3)).toBe(`╰${"─".repeat(28)}╯`);
		expect(s.cell(29, 1).anchored).toBe(true);
		expect(inner).toEqual({ x: 1, y: 1, w: 28, h: 2 });
	});

	it("uses ASCII borders and clips a title that does not fit", () => {
		const s = new Screen(12, 3);
		drawBox(s, { x: 0, y: 0, w: 12, h: 3 }, { unicode: false, title: [{ text: "a very long title" }] });
		expect(rowText(s, 0).startsWith("+ a very")).toBe(true);
		expect(rowText(s, 0).endsWith("+")).toBe(true);
		expect(rowText(s, 1)).toBe(`|${" ".repeat(10)}|`);
	});

	it("never overlaps the title with the badge", () => {
		const s = new Screen(20, 3);
		drawBox(s, { x: 0, y: 0, w: 20, h: 3 }, { unicode: true, title: [{ text: "title" }], badge: "badge" });
		expect(rowText(s, 0)).toContain("title");
		expect(rowText(s, 0)).toContain("badge");
	});
});
