import * as fs from "node:fs";
import * as core from "@actions/core";
import { type IssuedCredentials, issueCredentials } from "./api";
import { confirmCredentials } from "./api";
import { writeProfile } from "./deploy";
import { getInputs } from "./inputs";

export async function run(): Promise<void> {
	const inputs = getInputs();

	const credentialsPath = process.env.CREDENTIALS_PATH;
	if (credentialsPath === undefined) {
		core.error("CREDENTIALS_PATH is not set");
		return;
	}

	let creds: IssuedCredentials;

	try {
		creds = await issueCredentials(
			inputs.apiToken,
			inputs.apiHost,
			inputs.customerId,
		);
	} catch (error) {
		core.error(
			`Issue credentials failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		return;
	}

	fs.writeFileSync(credentialsPath, JSON.stringify(creds));

	try {
		await writeProfile(inputs.profileName, inputs.region, creds);
	} catch (error) {
		core.error(
			`Write profile failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	try {
		await confirmCredentials(
			inputs.apiToken,
			inputs.apiHost,
			inputs.customerId,
			creds?.confirmationId ?? "",
		);
	} catch (error) {
		core.error(
			`Confirm credentials failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

if (require.main === module) {
	run().catch((error) => {
		core.setFailed(error instanceof Error ? error.message : String(error));
	});
}
