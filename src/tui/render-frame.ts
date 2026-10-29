/** The rules between panes and the tees that join them to the outer frame. */
import { type GlyphName, glyph } from "./glyphs.js";
import type { Layout, Rect } from "./layout.js";
import type { Screen } from "./screen.js";
import { Role } from "./style.js";

export function rule(
	screen: Screen,
	rect: Rect,
	vertical: boolean,
	unicode: boolean,
): void {
	const mark = glyph(vertical ? "lineV" : "lineH", unicode);
	for (let i = 0; i < (vertical ? rect.h : rect.w); i++) {
		screen.put(rect.x + (vertical ? 0 : i), rect.y + (vertical ? i : 0), mark, {
			fg: Role.Dim,
		});
	}
}

/** Join the rules to the outer frame: a tee on each border where a rule meets it. */
export function junctions(
	screen: Screen,
	layout: Exclude<Layout, { tier: "tooSmall" }>,
	unicode: boolean,
): void {
	const tee = (x: number, y: number, name: GlyphName): void => {
		screen.putAnchored(x, y, glyph(name, unicode), { fg: Role.Accent });
	};
	if (layout.tier === "narrow") return;
	tee(layout.body.x + layout.body.w, layout.listRule.y, "teeRight");
	if (layout.tier === "medium") {
		tee(0, layout.listRule.y, "teeLeft");
		return;
	}
	tee(layout.railRule.x, 0, "teeTop");
	tee(layout.railRule.x, layout.listRule.y, "teeLeft");
}
