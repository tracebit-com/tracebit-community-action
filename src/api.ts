import { randomUUID } from "node:crypto";
import * as core from "@actions/core";
import { context } from "@actions/github";
import { HttpClient } from "@actions/http-client";
import pkg from "../package.json";
import type { TolerantDeploymentStrategy } from "./external-types/deployment-strategy";

export const requestTimeout = 5_000;

const httpClient = new HttpClient("tracebit-github-action", [], {
	socketTimeout: requestTimeout, // Make sure the request doesn't take too long
});

function getGithubContext() {
	return {
		ref: context.ref ?? "",
		repository: `${context.repo.owner}/${context.repo.repo}`,
		runId: context.runId?.toString() ?? "",
		sha: context.sha ?? "",
		workflow: context.workflow ?? "",
		job: context.job ?? "",
	};
}

function buildIssueUrl(apiHost: string, customerId: string): string {
	return `https://${customerId}.${apiHost}/api/v1/credentials/issue-credentials`;
}

function buildConfirmUrl(apiHost: string, customerId: string): string {
	return `https://${customerId}.${apiHost}/api/v1/credentials/confirm-credentials`;
}

function buildGetConfigUrl(apiHost: string, customerId: string): string {
	return `https://${customerId}.${apiHost}/api/_internal/v1/github/instances`;
}

function toNonEmptyLabels(
	labels: Array<{ name: string; value: string }>,
): Array<{ name: string; value: string }> {
	return labels.filter((label) => label.value.length > 0);
}

export interface IssuedAwsCredentials {
	awsConfirmationId: string;
	awsAccessKeyId: string;
	awsSecretAccessKey: string;
	awsSessionToken: string;
}

export interface IssuedSshCredentials {
	sshConfirmationId: string;
	sshIp: string;
	sshPrivateKey: string;
	sshPublicKey: string;
	sshExpiration: string;
}

export interface IssuedHttpCredentials {
	confirmationId: string;
	browserDeploymentId: string;
	hostNames: string[];
	expiresAt: string | null;
	credentials: TolerantDeploymentStrategy;
}

export interface IssuedCredentials {
	aws?: IssuedAwsCredentials;
	ssh?: IssuedSshCredentials;
	http?: Record<string, IssuedHttpCredentials>;
}

export interface Config {
	instances?: ConfigInstance[];
}

export interface ConfigInstance {
	key: string;
	instanceId: string;
}

export async function issueCredentials(
	token: string,
	apiHost: string,
	customerId: string,
	httpInstances: ConfigInstance[],
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
		{
			name: "github.action_ref",
			value: process.env.GITHUB_ACTION_REF ?? "none",
		},
		{ name: "action.version", value: pkg.version },
		{ name: "unique_id", value: uniqueId },
		{ name: "deployment_version", value: "2.0.0" },
	]);

	const typeConfigs = [
		{ typeName: "aws" },
		{ typeName: "ssh" },
		...httpInstances.map((i) => ({ ...i, typeName: "http" })),
	];

	const payload = {
		name: `${context.repository}@${context.workflow}`,
		source: "github",
		sourceType: "ci/cd",
		typeConfigs,
		labels,
	};

	const response = await httpClient.post(
		buildIssueUrl(apiHost, customerId),
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

	// TODO: add error catching to JSON parsing
	const json = JSON.parse(responseText) as IssuedCredentials;

	if (
		!json.aws &&
		!json.ssh &&
		(!json.http || Object.keys(json.http).length === 0)
	) {
		throw new Error(
			"No credentials were issued: neither AWS, SSH nor HTTP credentials were returned",
		);
	}

	core.info("Credentials issued");

	return json;
}

export async function confirmCredentials(
	token: string,
	apiHost: string,
	customerId: string,
	confirmationId: string,
): Promise<void> {
	const response = await httpClient.post(
		buildConfirmUrl(apiHost, customerId),
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

	core.info("Credentials confirmed");
}

export async function getConfig(
	token: string,
	apiHost: string,
	customerId: string,
): Promise<Config> {
	const response = await httpClient.get(
		buildGetConfigUrl(apiHost, customerId),
		{
			Authorization: `Bearer ${token}`,
		},
	);
	const statusCode = response.message.statusCode ?? 0;
	const responseText = await response.readBody();

	if (statusCode < 200 || statusCode >= 300) {
		throw new Error(`Failed to get config (${statusCode}): ${responseText}`);
	}

	return JSON.parse(responseText) as Config;
}
