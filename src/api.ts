import { randomUUID } from "node:crypto";
import * as core from "@actions/core";
import { context } from "@actions/github";
import { HttpClient } from "@actions/http-client";

const httpClient = new HttpClient("tracebit-github-action", [], {
	socketTimeout: 2_000, // Make sure the request doesn't take too long
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

function toNonEmptyLabels(
	labels: Array<{ name: string; value: string }>,
): Array<{ name: string; value: string }> {
	return labels.filter((label) => label.value.length > 0);
}

export interface IssuedCredentials {
	confirmationId: string;
	accessKeyId: string;
	secretAccessKey: string;
	sessionToken: string;
}

export async function issueCredentials(
	token: string,
	apiHost: string,
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

	core.info("Credentials issued");

	return {
		confirmationId,
		accessKeyId,
		secretAccessKey,
		sessionToken,
	};
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
