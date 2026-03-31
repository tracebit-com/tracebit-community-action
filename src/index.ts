import * as fs from "node:fs";
import * as core from "@actions/core";
import type { IssuedCredentials } from "./api";
import { populateGitHubVars } from "./deploy";
import { getInputs } from "./inputs";
import type { Inputs } from "./inputs";

function printLogs(): void {
	core.info("Configuring AWS credentials");
	core.info("Writing AWS credentials to file");
	core.info("Exporting AWS credentials to environment variables");
	core.info("Successfully configured AWS credentials");
}

/* This function will wait until the creds are issued to deploy them or time out */
async function populateGithubVars(inputs: Inputs): Promise<void> {
	const timeoutMs = 2_000;
	const retryIntervalMs = 100;
	const deadline = Date.now() + timeoutMs;

	let credentialsPath = process.env._SECURITY_CREDENTIALS_PATH;
	while (credentialsPath === undefined) {
		if (Date.now() >= deadline) {
			core.error(
				`_SECURITY_CREDENTIALS_PATH was not set within ${timeoutMs}ms`,
			);
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, retryIntervalMs));
		credentialsPath = process.env._SECURITY_CREDENTIALS_PATH;
	}

	while (!fs.existsSync(credentialsPath)) {
		if (Date.now() >= deadline) {
			core.error(
				`Credentials file did not appear within ${timeoutMs}ms, path: ${credentialsPath}`,
			);
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, retryIntervalMs));
	}

	const credentials = JSON.parse(
		fs.readFileSync(credentialsPath, "utf8"),
	) as IssuedCredentials;

	populateGitHubVars(
		inputs.envPrefix,
		inputs.region,
		inputs.profileName,
		credentials,
	);
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
		await populateGithubVars(inputs);
	}

	printLogs();
}

if (require.main === module) {
	run().catch((error) => {
		core.setFailed(error instanceof Error ? error.message : String(error));
	});
}
