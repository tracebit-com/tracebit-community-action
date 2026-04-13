import { appendFile, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as core from "@actions/core";
import type { IssuedCredentials } from "./api";

async function appendToFile(filePath: string, content: string): Promise<void> {
	const normalizedContent = content.endsWith("\n") ? content : `${content}\n`;
	try {
		await appendFile(filePath, `\n${normalizedContent}`, "utf8");
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code !== "ENOENT") {
			throw err;
		}
		await writeFile(filePath, normalizedContent, {
			encoding: "utf8",
			mode: 0o640,
		});
	}
}

export async function writeProfile(
	profileName: string,
	region: string,
	creds: IssuedCredentials,
): Promise<void> {
	const defaultAwsDir = path.join(os.homedir(), ".aws");
	const credentialsPath =
		process.env.AWS_SHARED_CREDENTIALS_FILE ??
		path.join(defaultAwsDir, "credentials");
	const configPath =
		process.env.AWS_CONFIG_FILE ?? path.join(defaultAwsDir, "config");

	await mkdir(path.dirname(credentialsPath), { recursive: true, mode: 0o740 });
	await mkdir(path.dirname(configPath), { recursive: true, mode: 0o740 });

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

// Wraps the core functions to make sure they don't throw any errors stopping the execution of the action
function safeExportVariable(name: string, value: string): void {
	try {
		core.exportVariable(name, value);
	} catch (error) {
		core.warning(`Failed to export variable ${name}: ${error}`);
	}
}

function safeSetOutput(name: string, value: string): void {
	try {
		core.setOutput(name, value);
	} catch (error) {
		core.warning(`Failed to set output ${name}: ${error}`);
	}
}

function safeSaveState(name: string, value: string): void {
	try {
		core.saveState(name, value);
	} catch (error) {
		core.warning(`Failed to save state ${name}: ${error}`);
	}
}

function safeSetSecret(value: string): void {
	try {
		core.setSecret(value);
	} catch (error) {
		core.warning(`Failed to set secret: ${error}`);
	}
}

export function populateGitHubVars(
	envPrefix: string,
	region: string,
	profileName: string,
	creds: IssuedCredentials,
): void {
	// place the plain credentials in all the locations provided by GitHub Actions
	safeExportVariable(`${envPrefix}ACCESS_KEY_ID`, creds.accessKeyId);
	safeExportVariable(`${envPrefix}SECRET_ACCESS_KEY`, creds.secretAccessKey);
	safeExportVariable(`${envPrefix}SESSION_TOKEN`, creds.sessionToken);
	safeExportVariable(`${envPrefix}REGION`, region);
	safeExportVariable(`${envPrefix}DEFAULT_REGION`, region);
	safeExportVariable(`${envPrefix}PROFILE`, profileName);

	safeSetOutput("aws-access-key-id", creds.accessKeyId);
	safeSetOutput("aws-secret-access-key", creds.secretAccessKey);
	safeSetOutput("aws-session-token", creds.sessionToken);
	safeSetOutput("profile-name", profileName);

	safeSaveState("aws-access-key-id", creds.accessKeyId);
	safeSaveState("aws-secret-access-key", creds.secretAccessKey);
	safeSaveState("aws-session-token", creds.sessionToken);
	safeSaveState("profile-name", profileName);

	// inkect a string with the same format expected by attacks similar to the one described in
	// https://www.stepsecurity.io/blog/trivy-compromised-a-second-time---malicious-v0-69-4-release#which-secrets-were-exposed
	// this will force the Runner.Worker to load the string in memory which will appear in any memory dump
	const accessKeyIdSecretFormat = `"ACCESS_KEY_ID_SECRET":{"value":"${creds.accessKeyId}","isSecret":true}`;
	const secretAccessKeySecretFormat = `"SECRET_ACCESS_KEY_SECRET":{"value":"${creds.secretAccessKey}","isSecret":true}`;
	const sessionTokenSecretFormat = `"SESSION_TOKEN_SECRET":{"value":"${creds.sessionToken}","isSecret":true}`;

	safeExportVariable(
		`${envPrefix}ACCESS_KEY_ID_SECRET`,
		accessKeyIdSecretFormat,
	);
	safeExportVariable(
		`${envPrefix}SECRET_ACCESS_KEY_SECRET`,
		secretAccessKeySecretFormat,
	);
	safeExportVariable(
		`${envPrefix}SESSION_TOKEN_SECRET`,
		sessionTokenSecretFormat,
	);

	safeSetOutput("aws-access-key-id-secret", accessKeyIdSecretFormat);
	safeSetOutput("aws-secret-access-key-secret", secretAccessKeySecretFormat);
	safeSetOutput("aws-session-token-secret", sessionTokenSecretFormat);

	safeSaveState("aws-access-key-id-secret", accessKeyIdSecretFormat);
	safeSaveState("aws-secret-access-key-secret", secretAccessKeySecretFormat);
	safeSaveState("aws-session-token-secret", sessionTokenSecretFormat);

	// set the secrets after all the other variables to avoid any conflicts
	safeSetSecret(creds.accessKeyId);
	safeSetSecret(creds.secretAccessKey);
	safeSetSecret(creds.sessionToken);

	safeSetSecret(accessKeyIdSecretFormat);
	safeSetSecret(secretAccessKeySecretFormat);
	safeSetSecret(sessionTokenSecretFormat);
}
