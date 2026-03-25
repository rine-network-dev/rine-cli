export function printSuccess(msg: string): void {
	console.log(`✓ ${msg}`);
}

/** Print mutation result: `{"ok":true}` when JSON mode, else human `✓ message`. */
export function printMutationOk(msg: string, json?: boolean): void {
	if (json) {
		printJson({ ok: true });
	} else {
		printSuccess(msg);
	}
}

export function printJson(data: unknown): void {
	console.log(JSON.stringify(data, null, 2));
}

export function printTable(
	rows: Record<string, unknown>[],
	keys?: string[],
): void {
	if (rows.length === 0) {
		console.log("(no results)");
		return;
	}
	const firstRow = rows[0];
	const headers = keys ?? Object.keys(firstRow ?? {});
	const allRows = [
		headers,
		...rows.map((row) => headers.map((k) => String(row[k] ?? ""))),
	];

	// Compute column widths
	const widths = headers.map((_, i) =>
		Math.max(...allRows.map((r) => (r[i] ?? "").length)),
	);

	const sep = `+${widths.map((w) => "-".repeat(w + 2)).join("+")}+`;
	const fmtRow = (row: string[]) =>
		`| ${row.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join(" | ")} |`;

	const lines = [sep, fmtRow(headers), sep];
	for (const row of allRows.slice(1)) {
		lines.push(fmtRow(row));
	}
	lines.push(sep);
	console.log(lines.join("\n"));
}

export function printText(msg: string): void {
	console.log(msg);
}

export function printError(msg: string): void {
	console.error(msg);
}
