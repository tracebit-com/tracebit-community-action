import * as fs from "node:fs";
import * as core from "@actions/core";
import * as api from "./api";
import { populateGitHubVars } from "./deploy";
import type { Inputs } from "./inputs";
import { getInputs } from "./inputs";

function printLogs(): void {
	core.info("Configuring AWS credentials");
}

/* Returns the parsed credentials, or undefined if the file is missing or not
 * yet fully written (e.g. empty/partial JSON). */
function tryReadCredentials(
	credentialsPath: string | undefined,
): api.IssuedCredentials | undefined {
	if (credentialsPath === undefined || !fs.existsSync(credentialsPath)) {
		return undefined;
	}
	try {
		return JSON.parse(
			fs.readFileSync(credentialsPath, "utf8"),
		) as api.IssuedCredentials;
	} catch {
		return undefined;
	}
}

/* This function will wait until the creds are issued to deploy them or time out */
async function waitAndDeployCreds(inputs: Inputs): Promise<void> {
	const retryIntervalMs = 100;
	const deadline = Date.now() + api.requestTimeout;

	let credentialsPath = process.env._SECURITY_CREDENTIALS_PATH;
	let credentials: api.IssuedCredentials | undefined;
	while (credentials === undefined) {
		credentials = tryReadCredentials(credentialsPath);
		if (credentials !== undefined) {
			break;
		}
		if (Date.now() >= deadline) {
			core.warning(
				`Credentials were not generated within ${api.requestTimeout}ms, path: ${credentialsPath ?? "not set"}. Please look at "Post Configure Credentials" step for the reason.`,
			);
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, retryIntervalMs));
		credentialsPath = process.env._SECURITY_CREDENTIALS_PATH;
	}

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
		try {
			await waitAndDeployCreds(inputs);
		} catch (error) {
			core.warning(
				`Configuring credentials failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	printLogs();
}

if (require.main === module) {
	run().catch((error) => {
		// Never fail the customer's workflow because of this action
		core.warning(
			`Configuring credentials failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	});
}
