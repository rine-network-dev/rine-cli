import {
	KEY_NOT_CURRENT_MESSAGE,
	KeyPackageRotation,
	type RotationSettlement,
	SeatUpdateStatus,
	seatUpdateLine,
} from "@rine-network/core";
import { printJson, printMutationOk, printText } from "../output.js";

const KEY_PACKAGE_LINES: Record<KeyPackageRotation, string> = {
	[KeyPackageRotation.Republished]:
		"Published key packages now carry the new key.",
	[KeyPackageRotation.Current]:
		"Published key packages already carry the current key.",
	[KeyPackageRotation.Pending]:
		"Published key packages still carry the old key; the next MLS command on this device replaces them.",
	[KeyPackageRotation.KeyNotCurrent]: KEY_NOT_CURRENT_MESSAGE,
	[KeyPackageRotation.NotHeld]:
		"This device holds no MLS state for the agent, so its key packages and group seats move from a device that does.",
};

/**
 * What a rotation did to the agent's key packages and group seats.
 *
 * Text mode names the key-package outcome and every group whose leaf did not
 * move; a group that moved, or already carried the new key, is not worth a line.
 * `--json` carries the whole report.
 */
export function printRotationReport(
	agentId: string,
	report: RotationSettlement,
	json: boolean | undefined,
): void {
	if (json) {
		printJson({
			ok: true,
			key_packages: report.key_packages,
			group_seats: report.group_seats,
		});
		return;
	}
	printMutationOk(`E2EE keys rotated for agent ${agentId}`, false);
	printText(KEY_PACKAGE_LINES[report.key_packages]);
	for (const seat of report.group_seats) {
		if (
			seat.status === SeatUpdateStatus.Updated ||
			seat.status === SeatUpdateStatus.Current
		) {
			continue;
		}
		const where = seat.group_id === null ? "" : `Group ${seat.group_id}: `;
		printText(`${where}${seatUpdateLine(seat)}`);
	}
}
