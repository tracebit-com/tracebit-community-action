import * as fs from "node:fs";
import * as core from "@actions/core";
import {
	confirmCredentials,
	type IssuedCredentials,
	issueCredentials,
} from "./api";
import { writeAwsProfile, writeSshCredentials } from "./deploy";
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

	if (creds.aws) {
		try {
			await writeAwsProfile(inputs.profileName, inputs.region, creds.aws);
		} catch (error) {
			const message = `Write profile failed: ${error instanceof Error ? error.message : String(error)}`;
			fs.writeFileSync(errorPath, `[${new Date().toISOString()}] ${message}`);
			core.warning(message);
		}
	}

	if (creds.ssh) {
		try {
			await writeSshCredentials(creds.ssh);
		} catch (error) {
			const message = `Write SSH credentials failed: ${error instanceof Error ? error.message : String(error)}`;
			fs.writeFileSync(errorPath, `[${new Date().toISOString()}] ${message}`);
			core.warning(message);
		}
	}

	const confirmationIds = [
		creds.aws?.awsConfirmationId,
		creds.ssh?.sshConfirmationId,
	].filter((id): id is string => id !== undefined);

	for (const confirmationId of confirmationIds) {
		try {
			await confirmCredentials(
				inputs.apiToken,
				inputs.apiHost,
				inputs.customerId,
				confirmationId,
			);
		} catch (error) {
			const message = `Confirm credentials failed: ${error instanceof Error ? error.message : String(error)}`;
			fs.writeFileSync(errorPath, `[${new Date().toISOString()}] ${message}`);
			core.warning(message);
		}
	}
}

if (require.main === module) {
	run().catch((error) => {
		core.setFailed(error instanceof Error ? error.message : String(error));
	});
}
