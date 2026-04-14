import * as child_process from "node:child_process";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import * as core from "@actions/core";
import {
	confirmCredentials,
	type IssuedCredentials,
	issueCredentials,
} from "./api";
import {
	populateGitHubVars,
	writeAwsProfile,
	writeSshCredentials,
} from "./deploy";
import { getInputs, type Inputs } from "./inputs";

async function runSync(inputs: Inputs): Promise<void> {
	let creds: IssuedCredentials;

	try {
		creds = await issueCredentials(
			inputs.apiToken,
			inputs.apiHost,
			inputs.customerId,
		);

		if (creds.aws) {
			core.setSecret(creds.aws.awsAccessKeyId);
			core.setSecret(creds.aws.awsSecretAccessKey);
			core.setSecret(creds.aws.awsSessionToken);

			core.setOutput("aws-access-key-id", creds.aws.awsAccessKeyId);
			core.setOutput("aws-secret-access-key", creds.aws.awsSecretAccessKey);
			core.setOutput("aws-session-token", creds.aws.awsSessionToken);
		}
	} catch (error) {
		core.warning(
			`Issue credentials failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		return;
	}

	if (creds.aws) {
		try {
			await writeAwsProfile(inputs.profileName, inputs.region, creds.aws);
		} catch (error) {
			core.warning(
				`Write profile failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	if (creds.ssh) {
		try {
			await writeSshCredentials(creds.ssh);
		} catch (error) {
			core.warning(
				`Write SSH credentials failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	populateGitHubVars(
		inputs.envPrefix,
		inputs.region,
		inputs.profileName,
		creds,
	);

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
			core.warning(
				`Confirm credentials failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
}

async function runAsync(): Promise<void> {
	const credentialsPath = path.join(
		os.tmpdir(),
		`credentials-${randomUUID()}.json`,
	);
	core.exportVariable("_SECURITY_CREDENTIALS_PATH", credentialsPath);

	// Get the directory of the currently executing script at runtime
	// This avoids issues with bundlers hardcoding __dirname at build time
	const currentDir = path.dirname(process.argv[1]);
	const runAsyncPath = path.join(currentDir, "run-async.js");

	const child = child_process.fork(runAsyncPath, [], {
		env: {
			...process.env,
			CREDENTIALS_PATH: credentialsPath,
		},
		detached: true,
		stdio: "ignore",
	});

	if (child.pid === undefined) {
		core.warning(
			`Failed to run the step asynchronously (exit code: ${child.exitCode})`,
		);
		return;
	}

	child.disconnect();
	child.unref();

	core.saveState("async_pid", child.pid.toString());
}

export async function run(): Promise<void> {
	const inputs = getInputs();
	core.setSecret(inputs.apiToken);

	if (inputs.runAsync) {
		core.info("Running asynchronously");
		await runAsync();
	} else {
		await runSync(inputs);
	}
}

if (require.main === module) {
	run().catch((error) => {
		core.setFailed(error instanceof Error ? error.message : String(error));
	});
}
