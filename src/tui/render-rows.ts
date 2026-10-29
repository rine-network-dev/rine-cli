/** What the list and the reader draw for one row: the row view in the widgets' terms. */
import { humanTime } from "@rine-network/core";
import {
	GAP_MEANING,
	READER_RULE_GAP,
	READER_RULE_MESSAGE,
	hiddenCharsSentence,
} from "./copy.js";
import { Glyph } from "./feed-schema.js";
import { dotJoint, glyph } from "./glyphs.js";
import { Role, type Style } from "./style.js";
import { type RowView, SnippetKind, glyphMark } from "./view-model.js";
import type { ListItem } from "./widgets/list.js";
import { type ListParties, PartiesShape, type ReaderParties } from "./widgets/parties.js";
import type { ReaderItem } from "./widgets/reader.js";

const DIM: Style = { fg: Role.Dim };
const NAME: Style = { bold: true };

const SNIPPET_STYLE: Record<SnippetKind, Style> = {
	[SnippetKind.Text]: {},
	[SnippetKind.Gap]: { fg: Role.Warn },
	[SnippetKind.Verdict]: DIM,
};

/** `sender → recipient`, or `#group · sender` for a group post, the joint dim. */
function listParties(row: RowView, unicode: boolean): ListParties {
	if (row.groupLabel !== null) {
		return {
			shape: PartiesShape.GroupSender,
			lead: { text: row.groupLabel, style: { fg: Role.Info } },
			joint: { text: dotJoint(unicode), style: DIM },
			tail: { text: row.from },
		};
	}
	return {
		shape: PartiesShape.FromTo,
		lead: { text: row.from },
		joint: { text: ` ${glyph("arrow", unicode)} `, style: DIM },
		tail: { text: row.to ?? "?" },
	};
}

/** Both parties, names bold and short agent ids dim; a group is named without an id. */
function readerParties(row: RowView, unicode: boolean): ReaderParties {
	const to = row.groupLabel === null ? { text: row.to ?? "?", style: NAME } : { text: row.groupLabel, style: NAME };
	return {
		lead: { text: row.from, style: NAME },
		leadId: { text: ` ${row.fromShort}`, style: DIM },
		joint: { text: `  ${glyph("arrow", unicode)}  `, style: DIM },
		tail: to,
		tailId: row.groupLabel === null ? { text: ` ${row.toShort}`, style: DIM } : null,
	};
}

export function listItem(row: RowView, unicode: boolean, now: number): ListItem {
	const mark = glyphMark(row.verdict, unicode);
	return {
		parties: listParties(row, unicode),
		text: row.snippet,
		textStyle: SNIPPET_STYLE[row.snippetKind],
		date: humanTime(row.sentAt, now),
		glyph: mark.text,
		glyphRole: mark.role,
	};
}

export function readerItem(row: RowView, unicode: boolean): ReaderItem {
	const mark = glyphMark(row.verdict, unicode);
	const gap = row.gapSentence;
	return {
		parties: readerParties(row, unicode),
		when: row.when,
		kind: row.kind,
		glyph: mark.text,
		glyphRole: mark.role,
		verdict: row.verdictLabel,
		equivocation:
			row.equivocationSentence === null
				? null
				: {
						glyph: glyphMark(Glyph.Equivocation, unicode).text,
						sentence: row.equivocationSentence,
					},
		hidden: row.hiddenChars > 0 ? hiddenCharsSentence(row.hiddenChars) : null,
		ruleTitle: gap === null ? READER_RULE_MESSAGE : READER_RULE_GAP,
		gap: gap === null ? null : { sentence: gap, meaning: GAP_MEANING },
		body: row.body,
	};
}
