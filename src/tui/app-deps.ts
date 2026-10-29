/** What the interactive view is given: the identity, the terminal streams and the switches from the command line. */
import type { CapsInput } from "./caps.js";
import type { IdentityResult } from "./identity.js";
import type { Term, TermOptions } from "./term.js";

export interface AppDeps {
	readonly identity: IdentityResult;
	readonly host: string;
	readonly pollS: number;
	readonly ascii: boolean;
	readonly env: NodeJS.ProcessEnv;
	readonly stdin: TermOptions["stdin"];
	readonly stdout: TermOptions["stdout"] & CapsInput["stream"];
	readonly writeError: (text: string) => void;
	/** A terminal for tests; the real one is made from `stdin` and `stdout`. */
	readonly makeTerm?: (
		hooks: Pick<TermOptions, "onResize" | "onResume">,
	) => Term;
}
