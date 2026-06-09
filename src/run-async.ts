import * as fs from "node:fs";
import * as core from "@actions/core";
import {
	type Config,
	confirmCredentials,
	getConfig,
	type IssuedCredentials,
	issueCredentials,
} from "./api";
import { deployHttp, writeAwsProfile, writeSshCredentials } from "./deploy";
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

	let config: Config | null = null;
	let creds: IssuedCredentials;

	try {
		config = await getConfig(
			inputs.apiToken,
			inputs.apiHost,
			inputs.customerId,
		);
	} catch {
		core.warning(
			"Failed to fetch perimeter instances configuration. Continuing with static types only.",
		);
	}

	try {
		creds = await issueCredentials(
			inputs.apiToken,
			inputs.apiHost,
			inputs.customerId,
			config?.instances ?? [],
		);
	} catch (error) {
		const message = `Issue credentials failed: ${error instanceof Error ? error.message : String(error)}`;
		fs.appendFileSync(errorPath, `[${new Date().toISOString()}] ${message}\n`);
		core.warning(message);
		return;
	}

	fs.writeFileSync(credentialsPath, JSON.stringify(creds));

	if (creds.aws) {
		try {
			await writeAwsProfile(inputs.profileName, inputs.region, creds.aws);
		} catch (error) {
			const message = `Write profile failed: ${error instanceof Error ? error.message : String(error)}`;
			fs.appendFileSync(
				errorPath,
				`[${new Date().toISOString()}] ${message}\n`,
			);
			core.warning(message);
		}
	}

	if (creds.ssh) {
		try {
			await writeSshCredentials(creds.ssh);
		} catch (error) {
			const message = `Write SSH credentials failed: ${error instanceof Error ? error.message : String(error)}`;
			fs.appendFileSync(
				errorPath,
				`[${new Date().toISOString()}] ${message}\n`,
			);
			core.warning(message);
		}
	}

	if (creds.http) {
		for (const [instanceId, instance] of Object.entries(creds.http)) {
			try {
				const { hostNames, credentials } = instance;
				if (hostNames.length === 0) {
					throw new Error("No hostnames are defined");
				}
				const hostname = hostNames[0];

				await deployHttp(instanceId, hostname, credentials);
			} catch (error) {
				const message = `Deploying HTTP credentials for instance ${instanceId} failed: ${error instanceof Error ? error.message : String(error)}`;
				fs.appendFileSync(
					errorPath,
					`[${new Date().toISOString()}] ${message}\n`,
				);
				core.warning(message);
			}
		}
	}

	const confirmationIds = [
		creds.aws?.awsConfirmationId,
		creds.ssh?.sshConfirmationId,
	]
		.filter((id): id is string => id !== undefined)
		.concat(Object.values(creds.http ?? {}).map((c) => c.confirmationId));

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
			fs.appendFileSync(
				errorPath,
				`[${new Date().toISOString()}] ${message}\n`,
			);
			core.warning(message);
		}
	}
}

if (require.main === module) {
	run().catch((error) => {
		core.setFailed(error instanceof Error ? error.message : String(error));
	});
}
