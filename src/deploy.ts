import type { Mode } from "node:fs";
import {
	chmod,
	lstat,
	mkdir,
	open,
	readFile,
	writeFile,
} from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import * as core from "@actions/core";
import type {
	IssuedAwsCredentials,
	IssuedCredentials,
	IssuedSshCredentials,
} from "./api";
import type {
	AllDeploymentStrategy,
	AnyDeploymentStrategy,
	DeploymentStrategy,
	NpmTokenDeploymentStrategy,
	PythonIndexDeploymentStrategy,
	TolerantDeploymentStrategy,
} from "./external-types/deployment-strategy.js";
import { isValidSshKeyName } from "./inputs";
import {
	formatIniSection,
	formatNetrcEntry,
	formatNpmrcAuthToken,
	type ValidatedPythonIndexStrategy,
	validateAwsCredentials,
	validateSshCredentials,
} from "./validate";

/** Whether a writer planted the credential, or left an existing one alone. */
export interface DeployResult {
	deployed: boolean;
}

const skipped: DeployResult = { deployed: false };
const planted: DeployResult = { deployed: true };

async function lstatOrNull(filePath: string) {
	try {
		return await lstat(filePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return null;
		}
		throw error;
	}
}

async function rejectSymlink(filePath: string): Promise<void> {
	const stat = await lstatOrNull(filePath);
	if (stat?.isSymbolicLink()) {
		throw new Error(`Refusing to write through symlink ${filePath}`);
	}
}

/** Reads a file's text, or "" when it does not exist. Never follows symlinks. */
async function readTextIfExists(filePath: string): Promise<string> {
	await rejectSymlink(filePath);
	try {
		return await readFile(filePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return "";
		}
		throw error;
	}
}

// A section header, optionally followed by a `#` or `;` comment, which the
// AWS CLI accepts: `[production] # deployment credentials`.
const INI_HEADER_LINE = /^\s*\[([^\]]*)\]\s*(?:[#;].*)?$/u;

/** The section name of an INI header line, or null if the line is not one. */
export function iniHeaderName(line: string): string | null {
	const match = INI_HEADER_LINE.exec(line);
	return match ? (match[1] ?? "") : null;
}

/**
 * Returns `text` with every `[header]` section removed, so the caller can
 * append a fresh one without the AWS CLI ever seeing a duplicate.
 */
export function removeIniSection(text: string, header: string): string {
	const kept: string[] = [];
	let dropping = false;
	for (const line of text.split(/\r?\n/u)) {
		const name = iniHeaderName(line);
		if (name !== null) {
			dropping = name === header;
		}
		if (!dropping) {
			kept.push(line);
		}
	}
	return kept
		.join("\n")
		.replace(/\n{3,}/gu, "\n\n")
		.replace(/^\n+/u, "");
}

/** Splits ssh_config text into blocks starting at each Host/Match line. */
function splitSshBlocks(text: string): string[][] {
	const blocks: string[][] = [];
	let current: string[] = [];
	for (const line of text.split(/\r?\n/u)) {
		if (/^\s*(?:Host|Match)\b/u.test(line) && current.length > 0) {
			blocks.push(current);
			current = [];
		}
		current.push(line);
	}
	blocks.push(current);
	return blocks;
}

/**
 * Returns ssh_config `text` with our key wired up for `hostAlias`:
 *  - no block for that host yet: `newBlock` is appended;
 *  - a block exists and already lists `identityFile`: text is unchanged;
 *  - a block exists with other keys: one `IdentityFile identityFile` line is
 *    added to it, after its last IdentityFile, and nothing else is touched.
 */
export function upsertSshHostBlock(
	text: string,
	hostAlias: string,
	identityFile: string,
	newBlock: string,
): string {
	const blocks = splitSshBlocks(text);
	const index = blocks.findIndex((block) =>
		block.some((line) => line.trim() === `Host ${hostAlias}`),
	);
	if (index === -1) {
		return `${text}${iniSeparator(text)}${newBlock}\n`;
	}
	const block = blocks[index];
	const identityLine = `IdentityFile ${identityFile}`;
	if (block.some((line) => line.trim() === identityLine)) {
		return text;
	}
	let insertAt = block.findIndex((line) => line.trim().startsWith("Host "));
	let indent = "    ";
	block.forEach((line, i) => {
		if (/^\s*IdentityFile\b/u.test(line)) {
			insertAt = i;
			indent = line.match(/^\s*/u)?.[0] ?? indent;
		}
	});
	block.splice(insertAt + 1, 0, `${indent}${identityLine}`);
	return blocks.map((b) => b.join("\n")).join("\n");
}

/** True when `text` contains an INI section with this header. */
export function hasIniSection(text: string, header: string): boolean {
	return text.split(/\r?\n/u).some((line) => iniHeaderName(line) === header);
}

/** Blank-line separator needed before appending a block to `text`. */
function iniSeparator(text: string): string {
	if (text.length === 0 || text.endsWith("\n\n")) return "";
	return text.endsWith("\n") ? "\n" : "\n\n";
}

/** Replaces a file's text in place, keeping its mode; creates it if missing. */
async function rewriteFile(
	filePath: string,
	text: string,
	mode: Mode,
): Promise<void> {
	await rejectSymlink(filePath);
	await writeFile(filePath, text, { encoding: "utf8", mode });
}

/** Overwrites (or creates) a file and forces its mode even if it existed. */
async function overwriteFile(
	filePath: string,
	content: string,
	mode: Mode,
): Promise<void> {
	await rejectSymlink(filePath);
	await writeFile(filePath, content, { encoding: "utf8", mode });
	await chmod(filePath, mode);
}

/** True when any line of `text` equals `line` exactly (after trimming). */
function hasLine(text: string, line: string): boolean {
	const wanted = line.trim();
	return text.split(/\r?\n/u).some((l) => l.trim() === wanted);
}

/** Appends a block to a file, creating it if needed. Never follows symlinks. */
async function appendToFile(
	filePath: string,
	content: string,
	mode?: Mode,
): Promise<void> {
	const normalizedContent = content.endsWith("\n") ? content : `${content}\n`;
	await rejectSymlink(filePath);
	// Open with 'a' (append, create if missing) so the requested mode is
	// honored when the file is created. Existing files keep their mode.
	const handle = await open(filePath, "a", mode ?? 0o640);
	try {
		const stat = await handle.stat();
		const prefix = stat.size === 0 ? "" : "\n";
		await handle.writeFile(`${prefix}${normalizedContent}`, "utf8");
	} finally {
		await handle.close();
	}
}

export async function writeAwsProfile(
	profileName: string,
	region: string,
	creds: IssuedAwsCredentials,
): Promise<DeployResult> {
	const defaultAwsDir = path.join(os.homedir(), ".aws");
	const credentialsPath =
		process.env.AWS_SHARED_CREDENTIALS_FILE ??
		path.join(defaultAwsDir, "credentials");
	const configPath =
		process.env.AWS_CONFIG_FILE ?? path.join(defaultAwsDir, "config");

	await mkdir(path.dirname(credentialsPath), { recursive: true, mode: 0o740 });
	await mkdir(path.dirname(configPath), { recursive: true, mode: 0o740 });

	// Re-validate at the write boundary so this function is safe to call with
	// anything, not only values that already passed the API response check.
	const checked = validateAwsCredentials(creds);

	const credentialsBlock = formatIniSection(profileName, [
		["aws_access_key_id", checked.awsAccessKeyId],
		["aws_secret_access_key", checked.awsSecretAccessKey],
		["aws_session_token", checked.awsSessionToken],
	]);

	const configHeader =
		profileName === "default" ? "default" : `profile ${profileName}`;
	const configBlock = formatIniSection(configHeader, [["region", region]]);

	// The profile named on the action is ours to own in the credentials file:
	// replace any existing section of that name rather than stacking a
	// duplicate, which the AWS CLI rejects outright. Other profiles are left
	// untouched. The config file is only ever added to: an existing section
	// for this profile (region and any other settings) is kept as-is.
	const existingCreds = await readTextIfExists(credentialsPath);
	if (existingCreds === "") {
		await appendToFile(credentialsPath, credentialsBlock);
	} else {
		const without = removeIniSection(existingCreds, profileName);
		if (without !== existingCreds) {
			core.info(
				`Replacing existing AWS profile "${profileName}" in ${credentialsPath}`,
			);
		}
		await rewriteFile(
			credentialsPath,
			`${without}${iniSeparator(without)}${credentialsBlock}\n`,
			0o640,
		);
	}

	if (hasIniSection(await readTextIfExists(configPath), configHeader)) {
		core.info(
			`AWS profile "${profileName}" already configured in ${configPath}; keeping it`,
		);
	} else {
		await appendToFile(configPath, configBlock);
	}
	return planted;
}

export async function writeSshCredentials(
	ssh: IssuedSshCredentials,
	keyName = "prod_deploy",
): Promise<DeployResult> {
	ssh = validateSshCredentials(ssh);

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

	if (!isValidSshKeyName(keyName)) {
		throw new Error(
			`Invalid SSH key name "${keyName}": must contain only alphanumeric characters, hyphens, and underscores, and must not be a file OpenSSH reads as configuration`,
		);
	}
	const privateKeyFile = path.join(sshDir, keyName);
	const publicKeyFile = path.join(sshDir, `${keyName}.pub`);
	const configFile = path.join(sshDir, "config");

	// The key name configured on the action is ours to own: overwrite it and
	// force the modes, so a stale or world-readable leftover never survives.
	// A symlink at that path is refused rather than followed.
	await overwriteFile(privateKeyFile, privateKeyDecoded, 0o600);
	await overwriteFile(publicKeyFile, publicKeyDecoded, 0o644);

	const hostConfig = [
		`Host ${ssh.sshIp}`,
		`    IdentityFile ${privateKeyFile}`,
		"    IdentitiesOnly yes",
		"    PasswordAuthentication no",
		"    StrictHostKeyChecking no",
	].join("\n");

	// Add our block if the host is new; if the user already has a block for
	// this IP, only add our IdentityFile to it. Nothing else is rewritten.
	const existing = await readTextIfExists(configFile);
	if (existing === "") {
		await appendToFile(configFile, hostConfig);
	} else {
		const updated = upsertSshHostBlock(
			existing,
			ssh.sshIp,
			privateKeyFile,
			hostConfig,
		);
		if (updated !== existing) {
			await rewriteFile(configFile, updated, 0o640);
		}
	}
	return planted;
}

// All strategies known to this action version.
// A strategy must be included here to be implemented, but inclusion in this list
// does not mean the strategy must be implemented.
const knownStrategies: ReadonlySet<string> = new Set<
	DeploymentStrategy["strategy"]
>(["any", "all", "npm-token", "python-index"]);

function isKnownDeploymentStrategy(
	strategy: TolerantDeploymentStrategy,
): strategy is DeploymentStrategy {
	return knownStrategies.has(strategy.strategy);
}

export async function deployHttp(
	instanceId: string,
	hostname: string,
	strategy: TolerantDeploymentStrategy,
): Promise<DeployResult> {
	// Unknown strategies are defined as {strategy:string}, so filter out first to
	// allow TS to infer types unambiguously in the switch expression
	if (!isKnownDeploymentStrategy(strategy)) {
		throw new Error(
			`Deployment strategy "${strategy.strategy}" is not supported by this version of the Tracebit action`,
		);
	}
	switch (strategy.strategy) {
		case "all":
			return deployAll(instanceId, hostname, strategy);
		case "any":
			return deployAny(instanceId, hostname, strategy);
		case "npm-token":
			return writeNpmToken(instanceId, hostname, strategy);
		case "python-index":
			return writePythonIndex(instanceId, hostname, strategy);
		default:
			throw new Error(
				`Deployment strategy "${strategy.strategy}" is not supported by this version of the Tracebit action`,
			);
	}
}

async function deployAny(
	instanceId: string,
	hostname: string,
	any: AnyDeploymentStrategy,
): Promise<DeployResult> {
	if (any.strategies.length === 0) {
		throw new Error(
			"Any strategy was requested, but no strategies were provided",
		);
	}

	for (const strategy of any.strategies) {
		try {
			return await deployHttp(instanceId, hostname, strategy);
		} catch (e) {
			core.info(
				`Could not use preferred strategy(s) in any strategy: ${e instanceof Error ? e.message : String(e)}`,
			);
		}
	}

	throw new Error("Failed to apply any requested strategy");
}

async function deployAll(
	instanceId: string,
	hostname: string,
	all: AllDeploymentStrategy,
): Promise<DeployResult> {
	let deployed = false;
	for (const strategy of all.strategies) {
		try {
			const part = await deployHttp(instanceId, hostname, strategy);
			deployed = deployed || part.deployed;
		} catch (e) {
			throw new Error(
				`Failed to apply a strategy in all strategy: ${e instanceof Error ? e.message : String(e)}`,
			);
		}
	}
	return { deployed };
}

async function writeNpmToken(
	_instanceId: string,
	hostname: string,
	npmToken: NpmTokenDeploymentStrategy,
): Promise<DeployResult> {
	try {
		const { token } = npmToken;
		core.setSecret(token);
		const line = formatNpmrcAuthToken(hostname, token);

		const npmrcPath = path.join(os.homedir(), ".npmrc");
		const key = line.slice(0, line.indexOf("=") + 1);
		const existing = await readTextIfExists(npmrcPath);
		if (existing.split(/\r?\n/u).some((l) => l.trim().startsWith(key))) {
			core.info(
				`npm auth token for ${hostname} already exists in ${npmrcPath}; leaving it alone`,
			);
			return skipped;
		}
		await appendToFile(npmrcPath, line, 0o600);
		return planted;
	} catch (e) {
		throw new Error(
			`Failed to write NPM token: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
}

async function writePythonIndex(
	_instanceId: string,
	hostname: string,
	pythonIndex: PythonIndexDeploymentStrategy,
): Promise<DeployResult> {
	try {
		const { token } = pythonIndex;
		core.setSecret(token);

		const login =
			(pythonIndex as ValidatedPythonIndexStrategy).username ?? "__token__";
		const netrcBlock = formatNetrcEntry(hostname, login, token);

		const netrcPath = path.join(os.homedir(), ".netrc");
		if (hasLine(await readTextIfExists(netrcPath), `machine ${hostname}`)) {
			core.info(
				`netrc entry for ${hostname} already exists in ${netrcPath}; leaving it alone`,
			);
			return skipped;
		}
		await appendToFile(netrcPath, netrcBlock, 0o600);
		return planted;
	} catch (e) {
		throw new Error(
			`Failed to write PyPI credentials: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
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

	// HTTP (npm, PyPI). Exported and masked for every token in the response,
	// whether or not its file write succeeded, so nothing can leak unmasked.
	if (creds.http) {
		for (const instance of Object.values(creds.http)) {
			for (const strategy of flattenStrategies(instance.credentials)) {
				if (strategy.strategy === "npm-token") {
					populateTokenVars(
						"NPM",
						"npm",
						(strategy as NpmTokenDeploymentStrategy).token,
					);
				} else if (strategy.strategy === "python-index") {
					populateTokenVars(
						"PYPI",
						"pypi",
						(strategy as PythonIndexDeploymentStrategy).token,
					);
				}
			}
		}
	}
}

/** Leaf strategies of a (possibly nested any/all) deployment strategy. */
function flattenStrategies(
	strategy: TolerantDeploymentStrategy,
): TolerantDeploymentStrategy[] {
	if (strategy.strategy === "any" || strategy.strategy === "all") {
		return (
			strategy as AnyDeploymentStrategy | AllDeploymentStrategy
		).strategies.flatMap((s) =>
			flattenStrategies(s as TolerantDeploymentStrategy),
		);
	}
	return [strategy];
}

// Exports a token credential to all the locations GitHub Actions provides,
// mirroring the AWS/SSH handling in populateGitHubVars. Called from the
// foreground phase only: in async mode the worker's stdio and command files
// never reach the runner, so it must not do this itself.
function populateTokenVars(
	envName: string,
	outputName: string,
	token: string,
): void {
	// Same __NAME__ prefix convention as the AWS variables, so a real
	// NPM_TOKEN / PYPI_TOKEN already in the job environment is never shadowed.
	const envPrefix = `__${envName}__`;
	safeExportVariable(`${envPrefix}TOKEN`, token);
	safeSetOutput(`${outputName}-token`, token);
	safeSaveState(`${outputName}-token`, token);

	// inject a string with the same format expected by attacks similar to the
	// one described in
	// https://www.stepsecurity.io/blog/trivy-compromised-a-second-time---malicious-v0-69-4-release#which-secrets-were-exposed
	// this will force the Runner.Worker to load the string in memory which will
	// appear in any memory dump
	const tokenSecretFormat = `"${envName}_TOKEN_SECRET":{"value":"${token}","isSecret":true}`;

	safeExportVariable(`${envPrefix}TOKEN_SECRET`, tokenSecretFormat);
	safeSetOutput(`${outputName}-token-secret`, tokenSecretFormat);
	safeSaveState(`${outputName}-token-secret`, tokenSecretFormat);

	// set the secrets after all the other variables to avoid any conflicts
	safeSetSecret(token);
	safeSetSecret(tokenSecretFormat);
}
