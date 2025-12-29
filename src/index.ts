import { randomUUID } from "node:crypto";
import * as core from "@actions/core";
import * as exec from "@actions/exec";
import { context } from "@actions/github";
import { HttpClient } from "@actions/http-client";

const PROFILE_NAME_PREFIX = "administrator-";
const DEFAULT_ENV_PREFIX = "__AWS__";
const DEFAULT_REGIONS = [
	"eu-west-1",
	"us-east-1",
	"us-west-2",
	"eu-central-1",
	"ap-southeast-1",
];
// TODO: change to production URL when ready
const BASE_URL = "stage.tracebit.com";
const httpClient = new HttpClient("tracebit-github-action");

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

function pickRandomRegion(): string {
	const index = Math.floor(Math.random() * DEFAULT_REGIONS.length);
	return DEFAULT_REGIONS[index] ?? DEFAULT_REGIONS[0];
}

function pickDefaultProfileName(): string {
	const alphabet =
		"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
	let suffix = "";
	for (let i = 0; i < 7; i += 1) {
		const idx = Math.floor(Math.random() * alphabet.length);
		suffix += alphabet[idx] ?? "A";
	}
	return `${PROFILE_NAME_PREFIX}${suffix}`;
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

function sleep(ms: number): Promise<void> {
	if (process.env.NODE_ENV === "test") {
		return Promise.resolve();
	}
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureCommandExists(command: string): Promise<void> {
	const locator = core.platform.isWindows ? "where" : "which";
	try {
		const exitCode = await exec.exec(locator, [command], {
			ignoreReturnCode: true,
			silent: true,
		});
		if (exitCode !== 0) {
			throw new Error(`Required tool ${command} could not be found.`);
		}
	} catch {
		throw new Error(`Required tool ${command} could not be found.`);
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

	const delayMs =
		Math.floor(Math.random() * 5000) + Math.floor(Math.random() * 100);
	await sleep(delayMs);

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
	await ensureCommandExists("aws");
	await exec.exec(
		"aws",
		[
			"configure",
			"set",
			"--profile",
			profileName,
			"aws_access_key_id",
			creds.accessKeyId,
		],
		{},
	);
	await exec.exec(
		"aws",
		[
			"configure",
			"set",
			"--profile",
			profileName,
			"aws_secret_access_key",
			creds.secretAccessKey,
		],
		{},
	);
	await exec.exec(
		"aws",
		[
			"configure",
			"set",
			"--profile",
			profileName,
			"aws_session_token",
			creds.sessionToken,
		],
		{},
	);
	await exec.exec(
		"aws",
		["configure", "set", "--profile", profileName, "region", region],
		{},
	);
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
	try {
		customerId = getInputFallback("customer-id", true);
		token = getInputFallback("api-token", true);
	} catch (error) {
		core.warning(
			`Input resolution failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		return;
	}
	const profileName = pickDefaultProfileName();
	const envPrefix = DEFAULT_ENV_PREFIX;
	const region = pickRandomRegion();

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
