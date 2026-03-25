import readline from "node:readline";

/** Prompt for a plain-text value on stdout/stdin. */
export async function promptText(question: string): Promise<string> {
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});
	return new Promise((resolve) => {
		rl.question(question, (answer) => {
			rl.close();
			resolve(answer.trim());
		});
	});
}

/** Prompt for a secret value with hidden input (raw mode). */
export async function promptPassword(question: string): Promise<string> {
	return new Promise((resolve) => {
		process.stdout.write(question);
		const isTTY = process.stdin.isTTY === true;
		if (isTTY) process.stdin.setRawMode(true);
		process.stdin.resume();
		process.stdin.setEncoding("utf8");
		let password = "";
		const handler = (data: string) => {
			if (data === "\r" || data === "\n" || data === "\u0004") {
				if (isTTY) process.stdin.setRawMode(false);
				process.stdin.pause();
				process.stdin.removeListener("data", handler);
				process.stdout.write("\n");
				resolve(password);
			} else if (data === "\u007f" || data === "\b") {
				password = password.slice(0, -1);
			} else if (data === "\u0003") {
				process.exitCode = 130;
				process.exit();
			} else {
				password += data;
			}
		};
		process.stdin.on("data", handler);
	});
}

/** Prompt for yes/no confirmation (defaults to No). Returns true if user types y/Y. */
export async function promptConfirm(question: string): Promise<boolean> {
	const answer = await promptText(`${question} [y/N] `);
	return answer.toLowerCase() === "y";
}
