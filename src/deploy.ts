import { appendFile, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as core from "@actions/core";
import * as exec from "@actions/exec";
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
		await writeFile(filePath, normalizedContent, "utf8");
	}
}

export async function writeProfile(
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

export function exportEnvironment(
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
