import * as child_process from "node:child_process";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import * as core from "@actions/core";
import {
	type IssuedCredentials,
	confirmCredentials,
	issueCredentials,
} from "./api";
import { exportEnvironment, writeProfile } from "./deploy";
import { type Inputs, getInputs } from "./inputs";

async function runSync(inputs: Inputs): Promise<void> {
	let creds: IssuedCredentials;

	try {
		creds = await issueCredentials(
			inputs.apiToken,
			inputs.apiHost,
			inputs.customerId,
		);

		core.setSecret(creds.accessKeyId);
		core.setSecret(creds.secretAccessKey);
		core.setSecret(creds.sessionToken);

		core.setOutput("aws-access-key-id", creds.accessKeyId);
		core.setOutput("aws-secret-access-key", creds.secretAccessKey);
		core.setOutput("aws-session-token", creds.sessionToken);
	} catch (error) {
		core.error(
			`Issue credentials failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		return;
	}

	try {
		await writeProfile(inputs.profileName, inputs.region, creds);
	} catch (error) {
		core.error(
			`Write profile failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	try {
		exportEnvironment(
			inputs.envPrefix,
			inputs.region,
			inputs.profileName,
			creds,
		);
	} catch (error) {
		core.error(
			`Export env failed: ${error instanceof Error ? error.message : String(error)}`,
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

async function runAsync(): Promise<void> {
	const credentialsPath = path.join(
		os.tmpdir(),
		`credentials-${randomUUID()}.json`,
	);

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
		core.error(
			`Failed to run the step asynchronously (exit code: ${child.exitCode})`,
		);
		return;
	}

	child.disconnect();
	child.unref();

	core.exportVariable("_SECURITY_CREDENTIALS_PATH", credentialsPath);
	core.saveState("async_pid", child.pid.toString());
}

export async function run(): Promise<void> {
	const inputs = getInputs();

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
