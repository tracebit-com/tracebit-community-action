import * as fs from "node:fs";
import * as core from "@actions/core";

function removeIfPresent(filePath: string): void {
	try {
		if (fs.lstatSync(filePath).isFile()) {
			fs.unlinkSync(filePath);
		}
	} catch {
		// missing or not ours to touch
	}
}

/* The canary credentials themselves are deliberately left in place: they are
 * inert bait, and the confirmation call has already closed the expected
 * activity window. Only the async hand-off files are removed, because they
 * hold the issued credentials in plain JSON. */
/* Best-effort: stop a background worker that is still running at the end of
 * the job so it cannot write anything after cleanup. Never fails the step. */
function killWorker(): void {
	const pidText = core.getState("async_pid");
	if (!pidText) {
		return;
	}
	const pid = Number.parseInt(pidText, 10);
	if (!Number.isInteger(pid) || pid <= 1) {
		return;
	}
	try {
		process.kill(pid, "SIGTERM");
		core.info(`Stopped background credential worker (pid ${pid})`);
	} catch {
		// already exited, or not ours: nothing to do
	}
}

export async function run(): Promise<void> {
	killWorker();

	const credentialsPath = process.env._SECURITY_CREDENTIALS_PATH;
	if (credentialsPath === undefined) {
		return;
	}

	const errorPath = `${credentialsPath}.error`;
	if (fs.existsSync(errorPath)) {
		core.warning(fs.readFileSync(errorPath, "utf8"));
	}

	for (const suffix of ["", ".tmp", ".error"]) {
		removeIfPresent(`${credentialsPath}${suffix}`);
	}

	core.info("Cleanup complete");
}

if (require.main === module) {
	run().catch((error) => {
		// Never fail the customer's workflow because of this action
		core.warning(
			`Cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	});
}
