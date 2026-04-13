import * as fs from "node:fs";
import * as core from "@actions/core";
import * as api from "./api";
import { populateGitHubVars } from "./deploy";
import type { Inputs } from "./inputs";
import { getInputs } from "./inputs";

function printLogs(): void {
	core.info("Configuring AWS credentials");
}

/* This function will wait until the creds are issued to deploy them or time out */
async function waitAndDeployCreds(inputs: Inputs): Promise<void> {
	const retryIntervalMs = 100;
	const deadline = Date.now() + api.requestTimeout;

	let credentialsPath = process.env._SECURITY_CREDENTIALS_PATH;
	while (credentialsPath === undefined || !fs.existsSync(credentialsPath)) {
		if (Date.now() >= deadline) {
			core.warning(
				`Credentials were not generated within ${api.requestTimeout}ms, path: ${credentialsPath ?? "not set"}. Please look at "Post Configure Credentials" step for the reason.`,
			);
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, retryIntervalMs));
		credentialsPath = process.env._SECURITY_CREDENTIALS_PATH;
	}

	const credentials = JSON.parse(
		fs.readFileSync(credentialsPath, "utf8"),
	) as api.IssuedCredentials;

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
		await waitAndDeployCreds(inputs);
	}

	printLogs();
}

if (require.main === module) {
	run().catch((error) => {
		core.setFailed(error instanceof Error ? error.message : String(error));
	});
}
