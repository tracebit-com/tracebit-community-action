import { randomUUID } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as core from "@actions/core";
import { context } from "@actions/github";
import { HttpClient } from "@actions/http-client";

const DEFAULT_ENV_PREFIX = "__AWS__";
const BASE_URL = "tracebit.com";
const httpClient = new HttpClient("tracebit-github-action", [], {
	socketTimeout: 750, // Make sure the request doesn't take too long
});

function getInputFallback(name: string, required: boolean): string {
	const value = core.getInput(name);
	if (value) {
		return value;
	}
	const normalized = name.replace(/[^A-Za-z0-9_]/g, "_").toUpperCase();
	const envValue = process.env[`INPUT_${normalized}`] ?? "";
	if (envValue) {
		return envValue;
	}
	if (required) {
		throw new Error(`Input required and not supplied: ${name}`);
	}
	return "";
}

export function isValidRegion(region: string): boolean {
	return /^[a-z]+-[a-z0-9-]+-\d+$/u.test(region);
}

export function buildIssueUrl(customerId: string): string {
	return `https://${customerId}.${BASE_URL}/api/v1/credentials/issue-credentials`;
}

export function buildConfirmUrl(customerId: string): string {
	return `https://${customerId}.${BASE_URL}/api/v1/credentials/confirm-credentials`;
}

export type IssuedCredentials = {
	confirmationId: string;
	accessKeyId: string;
	secretAccessKey: string;
	sessionToken: string;
};

async function appendToFile(filePath: string, content: string): Promise<void> {
	const normalizedContent = content.endsWith("\n") ? content : `${content}\n`;
	try {
		await appendFile(filePath, `\n${normalizedContent}`, "utf8");
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code !== "ENOENT") {
			throw err;
		}
		await writeFile(filePath, normalizedContent, "utf8");
	}
}

export function toNonEmptyLabels(
	labels: Array<{ name: string; value: string }>,
): Array<{ name: string; value: string }> {
	return labels.filter((label) => label.value.length > 0);
}

export function getGithubContext() {
	return {
		ref: context.ref ?? "",
		repository: `${context.repo.owner}/${context.repo.repo}`,
		runId: context.runId?.toString() ?? "",
		sha: context.sha ?? "",
		workflow: context.workflow ?? "",
		job: context.job ?? "",
	};
}

export async function issueCredentials(
	token: string,
	customerId: string,
): Promise<IssuedCredentials> {
	const context = getGithubContext();
	const uniqueId = randomUUID();
	core.info(`Issuing credential with unique_id ${uniqueId}`);

	const labels = toNonEmptyLabels([
		{ name: "github.ref", value: context.ref },
		{ name: "github.repo", value: context.repository },
		{ name: "github.run_id", value: context.runId },
		{ name: "github.sha", value: context.sha },
		{ name: "github.workflow", value: context.workflow },
		{ name: "github.job", value: context.job },
		{ name: "unique_id", value: uniqueId },
		{ name: "deployment_version", value: "2.0.0" },
	]);

	const payload = {
		name: `${context.repository}@${context.workflow}`,
		source: "github",
		sourceType: "ci/cd",
		types: ["aws"],
		labels,
	};

	const response = await httpClient.post(
		buildIssueUrl(customerId),
		JSON.stringify(payload),
		{
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
		},
	);
	const statusCode = response.message.statusCode ?? 0;
	const responseText = await response.readBody();

	if (statusCode < 200 || statusCode >= 300) {
		throw new Error(
			`Failed to issue credentials (${statusCode}): ${responseText}`,
		);
	}

	const json = JSON.parse(responseText) as {
		aws?: {
			awsConfirmationId?: string;
			awsAccessKeyId?: string;
			awsSecretAccessKey?: string;
			awsSessionToken?: string;
		};
	};

	const confirmationId = json.aws?.awsConfirmationId ?? "";
	const accessKeyId = json.aws?.awsAccessKeyId ?? "";
	const secretAccessKey = json.aws?.awsSecretAccessKey ?? "";
	const sessionToken = json.aws?.awsSessionToken ?? "";

	if (!confirmationId || !accessKeyId || !secretAccessKey || !sessionToken) {
		throw new Error(
			"Issued credentials response is missing required AWS fields.",
		);
	}

	core.setSecret(accessKeyId);
	core.setSecret(secretAccessKey);
	core.setSecret(sessionToken);

	core.setOutput("aws-access-key-id", accessKeyId);
	core.setOutput("aws-secret-access-key", secretAccessKey);
	core.setOutput("aws-session-token", sessionToken);

	return {
		confirmationId,
		accessKeyId,
		secretAccessKey,
		sessionToken,
	};
}

async function writeProfile(
	profileName: string,
	region: string,
	creds: IssuedCredentials,
): Promise<void> {
	const awsDir = path.join(os.homedir(), ".aws");
	await mkdir(awsDir, { recursive: true });

	const credentialsPath = path.join(awsDir, "credentials");
	const configPath = path.join(awsDir, "config");

	const credentialsBlock = [
		`[${profileName}]`,
		`aws_access_key_id = ${creds.accessKeyId}`,
		`aws_secret_access_key = ${creds.secretAccessKey}`,
		`aws_session_token = ${creds.sessionToken}`,
	].join("\n");

	const configHeader =
		profileName === "default" ? "default" : `profile ${profileName}`;
	const configBlock = [`[${configHeader}]`, `region = ${region}`].join("\n");

	await appendToFile(credentialsPath, credentialsBlock);
	await appendToFile(configPath, configBlock);
}

function exportEnvironment(
	prefix: string,
	region: string,
	profileName: string,
	creds: IssuedCredentials,
): void {
	core.exportVariable(`${prefix}ACCESS_KEY_ID`, creds.accessKeyId);
	core.exportVariable(`${prefix}SECRET_ACCESS_KEY`, creds.secretAccessKey);
	core.exportVariable(`${prefix}SESSION_TOKEN`, creds.sessionToken);
	core.exportVariable(`${prefix}REGION`, region);
	core.exportVariable(`${prefix}DEFAULT_REGION`, region);
	core.exportVariable(`${prefix}PROFILE`, profileName);
}

export async function confirmCredentials(
	token: string,
	customerId: string,
	confirmationId: string,
): Promise<void> {
	const response = await httpClient.post(
		buildConfirmUrl(customerId),
		JSON.stringify({ id: confirmationId }),
		{
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
		},
	);
	const statusCode = response.message.statusCode ?? 0;
	const responseText = await response.readBody();

	if (statusCode < 200 || statusCode >= 300) {
		throw new Error(
			`Failed to confirm credentials (${statusCode}): ${responseText}`,
		);
	}

	core.info("Credentials issued");
}

export async function run(): Promise<void> {
	let customerId = "";
	let token = "";
	let profileName = "";
	let region = "";
	try {
		customerId = getInputFallback("customer-id", true);
		token = getInputFallback("api-token", true);
		profileName = getInputFallback("profile", true);
		region = getInputFallback("profile-region", true);
		if (!isValidRegion(region)) {
			core.warning(
				`Region ${region} format doesn't pass validation, it might be wrong`,
			);
		}
	} catch (error) {
		core.warning(
			`Input resolution failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		return;
	}
	const envPrefix = DEFAULT_ENV_PREFIX;

	core.setOutput("profile-name", profileName);

	let creds: IssuedCredentials | null = null;

	try {
		creds = await issueCredentials(token, customerId);
	} catch (error) {
		core.error(
			`Issue credentials failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		return;
	}

	try {
		await writeProfile(profileName, region, creds);
	} catch (error) {
		core.error(
			`Write profile failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	try {
		exportEnvironment(envPrefix, region, profileName, creds);
	} catch (error) {
		core.error(
			`Export env failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	try {
		await confirmCredentials(token, customerId, creds.confirmationId);
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
