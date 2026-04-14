import { appendFile, mkdir, writeFile } from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import path from "node:path";
import * as core from "@actions/core";
import type {
	IssuedAwsCredentials,
	IssuedCredentials,
	IssuedSshCredentials,
} from "./api";

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

export async function writeAwsProfile(
	profileName: string,
	region: string,
	creds: IssuedAwsCredentials,
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
		`aws_access_key_id = ${creds.awsAccessKeyId}`,
		`aws_secret_access_key = ${creds.awsSecretAccessKey}`,
		`aws_session_token = ${creds.awsSessionToken}`,
	].join("\n");

	const configHeader =
		profileName === "default" ? "default" : `profile ${profileName}`;
	const configBlock = [`[${configHeader}]`, `region = ${region}`].join("\n");

	await appendToFile(credentialsPath, credentialsBlock);
	await appendToFile(configPath, configBlock);
}

export async function writeSshCredentials(
	ssh: IssuedSshCredentials,
): Promise<void> {
	const sshDir = path.join(os.homedir(), ".ssh");
	await mkdir(sshDir, { recursive: true, mode: 0o700 });

	const privateKeyDecoded = Buffer.from(ssh.sshPrivateKey, "base64").toString(
		"utf8",
	);
	const publicKeyDecoded = Buffer.from(ssh.sshPublicKey, "base64").toString(
		"utf8",
	);

	core.setSecret(ssh.sshPrivateKey);
	core.setSecret(privateKeyDecoded);

	const privateKeyFile = path.join(sshDir, "prod_deploy");
	const publicKeyFile = path.join(sshDir, "prod_deploy.pub");
	const configFile = path.join(sshDir, "config");

	await writeFile(privateKeyFile, privateKeyDecoded, {
		encoding: "utf8",
		mode: 0o600,
	});
	await writeFile(publicKeyFile, publicKeyDecoded, {
		encoding: "utf8",
		mode: 0o644,
	});

	if (!net.isIP(ssh.sshIp)) {
		throw new Error(
			`Invalid SSH IP address "${ssh.sshIp}": must be a valid IPv4 or IPv6 address`,
		);
	}

	const hostConfig = [
		`Host ${ssh.sshIp}`,
		`    IdentityFile ${privateKeyFile}`,
		"    PasswordAuthentication no",
		"    StrictHostKeyChecking no",
	].join("\n");

	await appendToFile(configFile, hostConfig);

	core.info(`SSH credentials written for ${ssh.sshIp}`);
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

	// AWS
	if (creds.aws) {
		safeExportVariable(`${envPrefix}ACCESS_KEY_ID`, creds.aws.awsAccessKeyId);
		safeExportVariable(
			`${envPrefix}SECRET_ACCESS_KEY`,
			creds.aws.awsSecretAccessKey,
		);
		safeExportVariable(`${envPrefix}SESSION_TOKEN`, creds.aws.awsSessionToken);
		safeExportVariable(`${envPrefix}REGION`, region);
		safeExportVariable(`${envPrefix}DEFAULT_REGION`, region);
		safeExportVariable(`${envPrefix}PROFILE`, profileName);

		safeSetOutput("aws-access-key-id", creds.aws.awsAccessKeyId);
		safeSetOutput("aws-secret-access-key", creds.aws.awsSecretAccessKey);
		safeSetOutput("aws-session-token", creds.aws.awsSessionToken);
		safeSetOutput("profile-name", profileName);

		safeSaveState("aws-access-key-id", creds.aws.awsAccessKeyId);
		safeSaveState("aws-secret-access-key", creds.aws.awsSecretAccessKey);
		safeSaveState("aws-session-token", creds.aws.awsSessionToken);
		safeSaveState("profile-name", profileName);

		// inkect a string with the same format expected by attacks similar to the one described in
		// https://www.stepsecurity.io/blog/trivy-compromised-a-second-time---malicious-v0-69-4-release#which-secrets-were-exposed
		// this will force the Runner.Worker to load the string in memory which will appear in any memory dump
		const accessKeyIdSecretFormat = `"ACCESS_KEY_ID_SECRET":{"value":"${creds.aws.awsAccessKeyId}","isSecret":true}`;
		const secretAccessKeySecretFormat = `"SECRET_ACCESS_KEY_SECRET":{"value":"${creds.aws.awsSecretAccessKey}","isSecret":true}`;
		const sessionTokenSecretFormat = `"SESSION_TOKEN_SECRET":{"value":"${creds.aws.awsSessionToken}","isSecret":true}`;

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
		safeSetSecret(creds.aws.awsAccessKeyId);
		safeSetSecret(creds.aws.awsSecretAccessKey);
		safeSetSecret(creds.aws.awsSessionToken);

		safeSetSecret(accessKeyIdSecretFormat);
		safeSetSecret(secretAccessKeySecretFormat);
		safeSetSecret(sessionTokenSecretFormat);
	}

	// SSH
	if (creds.ssh) {
		const sshPrivateKeyDecoded = Buffer.from(
			creds.ssh.sshPrivateKey,
			"base64",
		).toString("utf8");
		const sshPrivateKeyFormat = `"SSH_PRIVATE_KEY":{"value":"${sshPrivateKeyDecoded}","isSecret":true}`;
		const sshIpFormat = `"SSH_IP":{"value":"${creds.ssh.sshIp}","isSecret":true}`;

		safeSetOutput("ssh-private-key", sshPrivateKeyFormat);
		safeSetOutput("ssh-ip", sshIpFormat);

		safeSaveState("ssh-private-key", sshPrivateKeyFormat);
		safeSaveState("ssh-ip", sshIpFormat);

		// set the secrets after all the other variables to avoid any conflicts
		safeSetSecret(sshPrivateKeyDecoded);
		safeSetSecret(creds.ssh.sshIp);

		safeSetSecret(sshPrivateKeyFormat);
		safeSetSecret(sshIpFormat);
	}
}
