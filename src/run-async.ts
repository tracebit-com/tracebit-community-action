import * as fs from "node:fs";
import * as core from "@actions/core";
import {
	confirmCredentials,
	type IssuedCredentials,
	issueCredentials,
} from "./api";
import { writeProfile } from "./deploy";
import { getInputs } from "./inputs";

export async function run(): Promise<void> {
	const inputs = getInputs();
	core.setSecret(inputs.apiToken);

	const credentialsPath = process.env.CREDENTIALS_PATH;
	if (credentialsPath === undefined) {
		core.warning("CREDENTIALS_PATH is not set");
		return;
	}

	const errorPath = `${credentialsPath}.error`;

	let creds: IssuedCredentials;

	try {
		creds = await issueCredentials(
			inputs.apiToken,
			inputs.apiHost,
			inputs.customerId,
		);
	} catch (error) {
		const message = `Issue credentials failed: ${error instanceof Error ? error.message : String(error)}`;
		fs.writeFileSync(errorPath, `[${new Date().toISOString()}] ${message}`);
		core.warning(message);
		return;
	}

	fs.writeFileSync(credentialsPath, JSON.stringify(creds));

	try {
		await writeProfile(inputs.profileName, inputs.region, creds);
	} catch (error) {
		const message = `Write profile failed: ${error instanceof Error ? error.message : String(error)}`;
		fs.writeFileSync(errorPath, `[${new Date().toISOString()}] ${message}`);
		core.warning(message);
	}

	try {
		await confirmCredentials(
			inputs.apiToken,
			inputs.apiHost,
			inputs.customerId,
			creds?.confirmationId ?? "",
		);
	} catch (error) {
		const message = `Confirm credentials failed: ${error instanceof Error ? error.message : String(error)}`;
		fs.writeFileSync(errorPath, `[${new Date().toISOString()}] ${message}`);
		core.warning(message);
	}
}

if (require.main === module) {
	run().catch((error) => {
		core.setFailed(error instanceof Error ? error.message : String(error));
	});
}
