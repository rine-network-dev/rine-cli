/**
 * The interactive org view: wires the terminal, the keys, the reducer, the renderer and the poller
 * together. Everything that decides what is shown lives in the reducer and the widgets; this file
 * only moves messages.
 */
import { connectionFor, rowBridge, sameViewport } from "./app-data.js";
import { createMotion } from "./app-motion.js";
import { createOrgLoader } from "./app-org.js";
import { attachInput } from "./app-input.js";
import type { AppDeps } from "./app-deps.js";
import { detectCaps } from "./caps.js";
import { DUMB_TERMINAL } from "./copy.js";
import { Poller } from "./data.js";
import { diffScreens } from "./diff.js";
import { motionEnabled } from "./motion.js";
import { PageKind, TuiExit } from "./feed-schema.js";
import { IdentityKind, releaseIdentity } from "./identity.js";
import { render } from "./render.js";
import { Screen } from "./screen.js";
import { type Effect, type Msg, initialModel, update } from "./state.js";
import { createTerm } from "./term.js";

/** Runs the view until the person quits; resolves with the process exit code. */
export async function runApp(deps: AppDeps): Promise<number> {
	const { identity, stdin, stdout } = deps;
	const detected = detectCaps({
		env: deps.env,
		stream: stdout,
		ascii: deps.ascii,
	});
	if (!detected.ok) {
		deps.writeError(`${DUMB_TERMINAL}\n`);
		await releaseIdentity(identity);
		return TuiExit.NeedsTerminal;
	}
	const { caps } = detected;

	let model = initialModel;
	let prev: Screen | null = null;
	let drawTimer: ReturnType<typeof setImmediate> | undefined;
	let following = model.follow;
	let closing = false;
	let finish: (code: number) => void = () => undefined;
	let abort: (err: unknown) => void = () => undefined;
	const exited = new Promise<number>((resolve, reject) => {
		finish = resolve;
		abort = reject;
	});

	const draw = (): void => {
		drawTimer = undefined;
		const { cols, rows } = term.size();
		const screen = new Screen(cols, rows);
		const viewport = render(screen, model, {
			caps,
			motion: motion.frame(model),
			now: Date.now(),
			viewOf: bridge.viewOf,
		});
		const out = diffScreens(prev, screen, caps.color);
		if (out !== "") term.write(out);
		prev = screen;
		if (!sameViewport(viewport, model.viewport))
			dispatch({ type: "viewport", viewport });
		motion.arm(model);
	};
	const schedule = (): void => {
		if (!closing) drawTimer ??= setImmediate(draw);
	};
	const repaint = (): void => {
		prev = null;
		schedule();
	};
	const hooks = { onResize: repaint, onResume: repaint };
	const term =
		deps.makeTerm?.(hooks) ?? createTerm({ stdin, stdout, ...hooks });

	const motion = createMotion({
		enabled: motionEnabled(caps, deps.env, stdout.isTTY === true),
		now: Date.now,
		redraw: schedule,
	});
	const bridge = rowBridge(
		(msg) => dispatch(msg),
		() => model.connection.kind,
		deps.pollS,
		deps.host,
		motion.arrive,
	);
	const orgs =
		identity.kind === IdentityKind.Reader
			? createOrgLoader(identity.reader, (org) => {
					if (closing) return;
					bridge.setOwnSlug(org?.slug ?? null);
					dispatch({ type: "org", org });
					if (org !== null) term.setTitle(org.name);
				})
			: undefined;
	const poller =
		identity.kind === IdentityKind.Reader
			? new Poller({
					reader: identity.reader,
					bucket: identity.bucket,
					pollS: deps.pollS,
					emit: (event) => {
						bridge.onPoll(event);
						if (
							!closing &&
							event.type === "page" &&
							event.kind === PageKind.Poll
						)
							watch(orgs?.retry());
					},
				})
			: undefined;

	const shutdown = async (failed?: { err: unknown }): Promise<void> => {
		if (closing) return;
		closing = true;
		stopInput();
		clearImmediate(drawTimer);
		motion.stop();
		term.restore();
		await poller?.stop();
		await releaseIdentity(identity);
		if (failed) abort(failed.err);
		else finish(0);
	};
	/**
	 * A read that fails in a way the poller cannot wait out ends the view; the caller reports it.
	 */
	const watch = (read: Promise<unknown> | undefined): void => {
		read?.catch((err: unknown) => shutdown({ err }));
	};
	const run = (effect: Effect): void => {
		switch (effect.type) {
			case "quit":
				void shutdown();
				break;
			case "redraw":
				prev = null;
				break;
			case "suspend":
				term.suspend();
				break;
			case "loadOlder": {
				const cursor = bridge.olderCursor();
				if (cursor !== null) watch(poller?.older(cursor));
				break;
			}
			case "reread":
				bridge.expectReplace();
				watch(poller?.start());
				break;
			case "readFilter":
				bridge.expectFilter();
				watch(
					poller?.setFilter({
						agentId: effect.agentId,
						groupId: effect.groupId,
					}),
				);
				break;
		}
	};
	const dispatch = (msg: Msg): void => {
		const result = update(model, msg);
		motion.observe(model, result.model);
		model = result.model;
		for (const effect of result.effects) run(effect);
		if (model.follow !== following) {
			following = model.follow;
			poller?.setFollow(following);
		}
		schedule();
	};

	const stopInput = attachInput(term, {
		mode: () => (model.search.editing ? "search" : "normal"),
		action: (action) => dispatch({ type: "action", action }),
	});

	term.enter();
	if (identity.kind === IdentityKind.Reader) {
		void orgs
			?.load()
			.then(() => {
				if (!closing) watch(poller?.start());
			})
			.catch((err: unknown) => shutdown({ err }));
	} else
		dispatch({
			type: "connection",
			connection: connectionFor(identity.code, null, deps.host),
		});
	schedule();
	return exited;
}
