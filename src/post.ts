import * as fs from "node:fs";
import * as core from "@actions/core";

export async function run(): Promise<void> {
	const credentialsPath = process.env._SECURITY_CREDENTIALS_PATH;
	if (credentialsPath === undefined) {
		return;
	}

	const errorPath = `${credentialsPath}.error`;

	if (fs.existsSync(errorPath)) {
		core.warning(fs.readFileSync(errorPath, "utf8"));
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
