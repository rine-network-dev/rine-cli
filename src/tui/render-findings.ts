/** The findings layer: the one-line bar under the panes and the overlay that lists them all. */
import {
	FINDINGS_TITLE,
	findingText,
	findingsBarText,
	findingsFooter,
} from "./copy.js";
import { glyph } from "./glyphs.js";
import { FINDINGS_BAR_ROWS } from "./layout.js";
import type { Screen } from "./screen.js";
import { groupHandle } from "./state-data.js";
import type { Model } from "./state-model.js";
import { Role } from "./style.js";
import { shortId } from "./view-model.js";
import { drawFindings } from "./widgets/findings.js";
import { fit } from "./widgets/list.js";

/** The handle (it carries its own `#`) when a loaded row of the group knows it, else a short id. */
const sentence = (model: Model, found: Model["findings"][number]): string =>
	findingText(
		groupHandle(model.rail, found.groupId) ?? shortId(found.groupId),
		found.gap,
		new Map(
			model.rail.flatMap((entry) =>
				entry.kind === "agent" ? [[entry.id, entry.label] as const] : [],
			),
		),
	);

/** Draws nothing while no finding has been seen; the panes keep their rows only then. */
export function drawFindingsLayer(
	screen: Screen,
	model: Model,
	unicode: boolean,
): void {
	const [newest] = model.findings;
	if (newest === undefined) return;
	const bar = findingsBarText(model.findings.length, sentence(model, newest), unicode);
	const y = screen.rows - 1 - FINDINGS_BAR_ROWS;
	const lead = screen.put(1, y, `${glyph("alert", unicode)} `, {
		fg: Role.Warn,
		bold: true,
	});
	const room = screen.cols - 1 - lead;
	screen.put(lead, y, fit(bar, room, glyph("ellipsis", unicode)), {
		fg: Role.Warn,
	});
	if (model.overlay !== "findings") return;
	drawFindings(
		screen,
		{ x: 0, y: 0, w: screen.cols, h: screen.rows },
		{
			title: FINDINGS_TITLE,
			footer: findingsFooter(unicode),
			top: model.findingsTop,
			findings: model.findings.map((found) => sentence(model, found)),
			unicode,
		},
	);
}
