import * as fs from "node:fs";
import * as core from "@actions/core";
import type { IssuedCredentials } from "./api";
import { exportEnvironment } from "./deploy";
import { getInputs } from "./inputs";
import type { Inputs } from "./inputs";

function printLogs(): void {
	core.info("Configuring AWS credentials");
	core.info("Writing AWS credentials to file");
	core.info("Exporting AWS credentials to environment variables");
	core.info("Successfully configured AWS credentials");
}

function runSync(inputs: Inputs) {
	const credentialsPath = process.env._SECURITY_CREDENTIALS_PATH;
	if (credentialsPath === undefined) {
		core.error("_SECURITY_CREDENTIALS_PATH is not set");
		return;
	}

	if (!fs.existsSync(credentialsPath)) {
		core.error(`Credentials file does not exist, path: ${credentialsPath}`);
		return;
	}

	const credentials = JSON.parse(
		fs.readFileSync(credentialsPath, "utf8"),
	) as IssuedCredentials;

	try {
		exportEnvironment(
			inputs.envPrefix,
			inputs.region,
			inputs.profileName,
			credentials,
		);
	} catch (error) {
		core.error(
			`Export env failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	core.setSecret(credentials.accessKeyId);
	core.setSecret(credentials.secretAccessKey);
	core.setSecret(credentials.sessionToken);

	core.setOutput("aws-access-key-id", credentials.accessKeyId);
	core.setOutput("aws-secret-access-key", credentials.secretAccessKey);
	core.setOutput("aws-session-token", credentials.sessionToken);
}

export async function run(): Promise<void> {
	let inputs: Inputs;
	try {
		inputs = getInputs();
	} catch (error) {
		core.setFailed(error instanceof Error ? error.message : String(error));
		return;
	}

	if (inputs.runAsync) {
		runSync(inputs);
	}

	printLogs();
}

if (require.main === module) {
	run().catch((error) => {
		core.setFailed(error instanceof Error ? error.message : String(error));
	});
}
