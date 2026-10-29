/** The title set into the top border: the brand mark, the wordmark and the org being read. */
import { clipToWidth, displayWidth } from "@rine-network/core";
import { BRAND_WORD, HEADER_ORG_FALLBACK, HEADER_ORG_MAX } from "./copy.js";
import { dotJoint, glyph } from "./glyphs.js";
import { wordmark } from "./motion-effects.js";
import type { OrgIdentity } from "./org-identity.js";
import { Role } from "./style.js";
import type { Run } from "./widgets/runs.js";

function orgName(org: OrgIdentity | null, unicode: boolean): string {
	if (org === null) return HEADER_ORG_FALLBACK;
	if (displayWidth(org.name) <= HEADER_ORG_MAX) return org.name;
	const mark = glyph("ellipsis", unicode);
	return clipToWidth(org.name, HEADER_ORG_MAX - displayWidth(mark)) + mark;
}

/** `◆ rine · <org>`; `revealMs` is how far into the wordmark's reveal the view is, null once settled. */
export function headerTitle(
	org: OrgIdentity | null,
	unicode: boolean,
	revealMs: number | null,
): Run[] {
	return [
		{ text: glyph("brand", unicode), style: { fg: Role.AccentHi } },
		{ text: " " },
		...wordmark(BRAND_WORD, revealMs),
		{ text: dotJoint(unicode), style: { fg: Role.Dim, bold: false } },
		{ text: orgName(org, unicode) },
	];
}
