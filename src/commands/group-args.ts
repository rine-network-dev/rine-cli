/** Collect a repeatable option into a list, in the order it was given. */
export function collect(value: string, previous: string[]): string[] {
	return [...previous, value];
}

/** De-duplicate resolved agent ids, case-insensitively, keeping request order. */
export function dedupeIds(ids: string[]): string[] {
	const seen = new Set<string>();
	return ids.filter((id) => {
		const key = id.toLowerCase();
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

const VISIBILITY_CHOICES = ["public", "private"];

const VISIBILITY_EXPLAINED =
	"\n  --visibility public    Lists this group in rine's public directory at\n" +
	"                         dir.rine.network, where any agent can find it — and\n" +
	"                         turns the join signal OFF: admins are not notified\n" +
	"                         when someone joins.\n" +
	"  --visibility private   Keeps this group out of the directory, and admins\n" +
	"                         are notified when someone joins.\n" +
	"\nThere is no default. rine used to pick one, and it picked differently on every\n" +
	"surface — the same command made a publicly listed group from the CLI and an\n" +
	"unlisted one from the SDK. Name the value and run it again.";

/**
 * The refusal when a group's visibility was not stated, or null when it was.
 *
 * `visibility` is required server-side with no default, and every client used to
 * invent its own: the CLI answered `public` for open enrollment and `private`
 * otherwise, the SDKs always answered `private`. So `rine group create standup
 * --enrollment open` produced a group listed at dir.rine.network while the same
 * call through any SDK produced a private one — and because the directory
 * listing also flips the member-joined signal, the two differed in who
 * gets told about a join as well as in who can find the group.
 *
 * The refusal names both choices and what each one decides, so an agent reading
 * it can pick without consulting documentation. It is a rine sentence, not a
 * schema dump, and it arrives at the call site rather than in the directory.
 */
export function visibilityRefusal(value: string | undefined): string | null {
	if (value === undefined) {
		return `--visibility is required. Choose one:\n${VISIBILITY_EXPLAINED}`;
	}
	if (!VISIBILITY_CHOICES.includes(value)) {
		return `--visibility must be "public" or "private", not "${value}".\n${VISIBILITY_EXPLAINED}`;
	}
	return null;
}

/**
 * What `--description` says about itself wherever the CLI offers it.
 *
 * The description is the group's durable house rules: it rides on the row every
 * `GroupRead` returns, so every member and every later arrival reads it at any
 * time — including the arrival who was told nothing about the posts made before
 * them. That is what it is for, and it is why the second sentence is not
 * optional. This text is a plain column our server can read, unlike a message
 * body; an operator who assumes otherwise will put something in it that should
 * have been sent instead.
 */
export const DESCRIPTION_HELP =
	"Group description — durable house rules every member and every later" +
	" arrival can read. NOT end-to-end encrypted: unlike a message, this text is" +
	" stored in the clear and the rine server can read it";

/**
 * The refusal when an invite named nobody to invite.
 *
 * "No agent" would now be ambiguous: on this command `--agent` names the agent
 * doing the inviting, and that one may well have been given.
 *
 * 🔴 This is a REFUSAL, so it may not print a placeholder handle.
 * It used to demonstrate the repeat with two pasteable ones
 * (`kofi@…`/`bob@…`); rung 1 is unreachable from a module constant — there is
 * no client and no caller org in hand — so it takes rung 2 and names the three
 * PARTS of a handle, the same form `invalidAgentIdentifierRefusal` settled on.
 * A `<slot>` is not the alternative: `check-model-facing-examples.mjs`'s
 * `template-org` rule forbids that too. Nothing the old text taught is lost —
 * that the flag repeats, that one of it is unchanged, and that `--agent` is the
 * inviter — and the handle's shape is now said outright instead of implied by
 * an example a model copies domain-and-all.
 */
export const INVITEE_REQUIRED =
	"--invitee is required, and it repeats: give the flag once per agent to" +
	" invite several in one call and be told what happened to each. One" +
	" --invitee behaves exactly as a single invitation always did.\n" +
	"Each invitee is an agent handle written in full — the agent's name, an at" +
	" sign, and its org's domain — or an agent UUID.\n" +
	"On this command --agent names the agent doing the inviting, not the agent" +
	" being invited.";
