import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@actions/core", () => ({
	setOutput: vi.fn(),
	setSecret: vi.fn(),
	exportVariable: vi.fn(),
	saveState: vi.fn(),
	info: vi.fn(),
	warning: vi.fn(),
}));

vi.mock("node:os", async () => {
	const actual = await vi.importActual<typeof import("node:os")>("node:os");
	return { ...actual, homedir: vi.fn() };
});

import * as core from "@actions/core";
import {
	deployHttp,
	hasIniSection,
	iniHeaderName,
	removeIniSection,
	upsertSshHostBlock,
	writeAwsProfile,
	writeSshCredentials,
} from "../deploy";
import type { PythonIndexDeploymentStrategy } from "../external-types/deployment-strategy";

const originalEnv = process.env;
let home = "";

const aws = {
	awsConfirmationId: "11111111-1111-4111-8111-111111111111",
	awsAccessKeyId: "ASIAIOSFODNN7EXAMPLE",
	awsSecretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
	awsSessionToken:
		"FwoGZXIvYXdzEBYaDEXAMPLESESSIONTOKEN0123456789abcdefABCDEF+/=",
	awsExpiration: "2026-05-10T14:45:14Z",
};

describe("deploy writers re-validate at the write boundary", () => {
	beforeEach(() => {
		home = mkdtempSync(path.join(os.tmpdir(), "tracebit-deploy-test-"));
		process.env = {
			...originalEnv,
			AWS_CONFIG_FILE: path.join(home, ".aws", "config"),
			AWS_SHARED_CREDENTIALS_FILE: path.join(home, ".aws", "credentials"),
		};
		vi.mocked(os.homedir).mockReturnValue(home);
	});

	afterEach(async () => {
		process.env = originalEnv;
		await rm(home, { recursive: true, force: true });
	});

	it("writeAwsProfile refuses a session token with an injected section", async () => {
		await expect(
			writeAwsProfile("tracebit", "us-east-1", {
				...aws,
				awsSessionToken: `${aws.awsSessionToken}\n[default]\ncredential_process = /tmp/pwn`,
			}),
		).rejects.toThrow(/awsSessionToken/);
		expect(existsSync(path.join(home, ".aws", "credentials"))).toBe(false);
	});

	it("writeAwsProfile refuses a region that is not a single INI value", async () => {
		await expect(
			writeAwsProfile("tracebit", "us-east-1\ncredential_process = x", aws),
		).rejects.toThrow(/INI value/);
		expect(existsSync(path.join(home, ".aws", "config"))).toBe(false);
	});

	it("writeSshCredentials refuses binary key material", async () => {
		await expect(
			writeSshCredentials({
				sshConfirmationId: "33333333-3333-4333-8333-333333333333",
				sshIp: "10.0.0.1",
				sshPrivateKey: Buffer.from([0, 255, 1]).toString("base64"),
				sshPublicKey: Buffer.from(
					"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIElLjHVzr6AmSPysXjN7KWCzselCe0HixryRznbFyO7K ci@tracebit\n",
				).toString("base64"),
				sshExpiration: "2026-05-10T14:45:14Z",
			}),
		).rejects.toThrow(/PEM or OpenSSH private key/);
		expect(existsSync(path.join(home, ".ssh"))).toBe(false);
	});

	it("deployHttp refuses an npm hostname carrying a registry directive", async () => {
		await expect(
			deployHttp(
				"npm",
				"npm.example.com/:_authToken=x\nregistry=https://evil.example",
				{ strategy: "npm-token", token: "npm_abc" },
			),
		).rejects.toThrow(/hostname/);
		expect(existsSync(path.join(home, ".npmrc"))).toBe(false);
	});

	it("deployHttp refuses a python-index hostname carrying a netrc default entry", async () => {
		await expect(
			deployHttp("pypi", "pypi.example.com\ndefault login a password b", {
				strategy: "python-index",
				token: "pypi-abc",
				indexName: "internal",
			}),
		).rejects.toThrow(/hostname/);
		expect(existsSync(path.join(home, ".netrc"))).toBe(false);
	});

	it("deployHttp honours the python-index username in netrc", async () => {
		await deployHttp("pypi", "pypi.example.com", {
			strategy: "python-index",
			token: "pypi-abc",
			indexName: "",
			username: "deploy-bot",
		} as PythonIndexDeploymentStrategy);
		expect(readFileSync(path.join(home, ".netrc"), "utf8")).toBe(
			"machine pypi.example.com\nlogin deploy-bot\npassword pypi-abc\n",
		);
		// env export happens in populateGitHubVars, not in the writer
		expect(core.exportVariable).not.toHaveBeenCalled();
	});

	it("deployHttp refuses a public registry hostname", async () => {
		await expect(
			deployHttp("npm", "registry.npmjs.org", {
				strategy: "npm-token",
				token: "npm_abc",
			}),
		).rejects.toThrow(/hostname/);
	});
});

const ssh = {
	sshConfirmationId: "33333333-3333-4333-8333-333333333333",
	sshIp: "10.0.0.1",
	sshPrivateKey: Buffer.from(
		"-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\nQyNTUxOQAAACBJS4x1c6+gJkj8rF4zeylgs7HpQntB4sa8kc52xcjuyg==\n-----END OPENSSH PRIVATE KEY-----\n",
	).toString("base64"),
	sshPublicKey: Buffer.from(
		"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIElLjHVzr6AmSPysXjN7KWCzselCe0HixryRznbFyO7K ci@tracebit\n",
	).toString("base64"),
	sshExpiration: "2026-05-10T14:45:14Z",
};

describe("collision handling (F2 regression)", () => {
	beforeEach(() => {
		home = mkdtempSync(path.join(os.tmpdir(), "tracebit-deploy-test-"));
		process.env = {
			...originalEnv,
			AWS_CONFIG_FILE: path.join(home, ".aws", "config"),
			AWS_SHARED_CREDENTIALS_FILE: path.join(home, ".aws", "credentials"),
		};
		vi.mocked(os.homedir).mockReturnValue(home);
	});

	afterEach(async () => {
		process.env = originalEnv;
		await rm(home, { recursive: true, force: true });
	});

	it("writeAwsProfile appends distinct profiles to the same file", async () => {
		expect(await writeAwsProfile("tracebit", "us-east-1", aws)).toEqual({
			deployed: true,
		});
		expect(await writeAwsProfile("other", "us-east-1", aws)).toEqual({
			deployed: true,
		});
		const creds = readFileSync(path.join(home, ".aws", "credentials"), "utf8");
		expect(creds.match(/^\[/gmu)).toHaveLength(2);
	});

	it("writeAwsProfile adds the config section only when missing", async () => {
		const configPath = path.join(home, ".aws", "config");
		mkdirSync(path.dirname(configPath), { recursive: true });
		writeFileSync(configPath, "[profile other]\nregion = eu-west-1\n");

		await writeAwsProfile("tracebit", "us-east-1", aws);

		expect(readFileSync(configPath, "utf8")).toBe(
			"[profile other]\nregion = eu-west-1\n\n[profile tracebit]\nregion = us-east-1\n",
		);
	});

	it("writeAwsProfile replaces its own credentials section and never duplicates it", async () => {
		const credsPath = path.join(home, ".aws", "credentials");
		const configPath = path.join(home, ".aws", "config");
		mkdirSync(path.dirname(credsPath), { recursive: true });
		writeFileSync(
			credsPath,
			"[theirs]\naws_access_key_id = THEIRS\n\n[tracebit]\naws_access_key_id = STALE\naws_secret_access_key = STALE\n\n[after]\nk = v\n",
		);
		writeFileSync(
			configPath,
			"[profile tracebit]\nregion = eu-west-1\noutput = json\n",
		);

		const result = await writeAwsProfile("tracebit", "us-east-1", aws);

		expect(result).toEqual({ deployed: true });
		const creds = readFileSync(credsPath, "utf8");
		expect(creds).toBe(
			`[theirs]\naws_access_key_id = THEIRS\n\n[after]\nk = v\n\n[tracebit]\naws_access_key_id = ${aws.awsAccessKeyId}\naws_secret_access_key = ${aws.awsSecretAccessKey}\naws_session_token = ${aws.awsSessionToken}\n`,
		);
		expect(creds).not.toContain("STALE");
		expect(creds.match(/^\[tracebit\]/gmu)).toHaveLength(1);
		// config is the user's: kept exactly as it was, no duplicate added
		expect(readFileSync(configPath, "utf8")).toBe(
			"[profile tracebit]\nregion = eu-west-1\noutput = json\n",
		);

		// idempotent: running again changes nothing
		await writeAwsProfile("tracebit", "us-east-1", aws);
		expect(readFileSync(credsPath, "utf8")).toBe(creds);
	});

	it("writeAwsProfile refuses to write through a symlinked credentials file", async () => {
		const credsPath = path.join(home, ".aws", "credentials");
		const target = path.join(home, "elsewhere");
		mkdirSync(path.dirname(credsPath), { recursive: true });
		writeFileSync(target, "");
		symlinkSync(target, credsPath);

		await expect(writeAwsProfile("tracebit", "us-east-1", aws)).rejects.toThrow(
			/symlink/,
		);
		expect(readFileSync(target, "utf8")).toBe("");
	});

	it("writeSshCredentials overwrites an existing key and fixes its mode", async () => {
		const sshDir = path.join(home, ".ssh");
		mkdirSync(sshDir, { recursive: true });
		const keyPath = path.join(sshDir, "prod_deploy");
		writeFileSync(keyPath, "stale key", { mode: 0o644 });

		const result = await writeSshCredentials(ssh);

		expect(result).toEqual({ deployed: true });
		expect(readFileSync(keyPath, "utf8")).toContain(
			"-----BEGIN OPENSSH PRIVATE KEY-----",
		);
		expect(statSync(keyPath).mode & 0o777).toBe(0o600);
		expect(statSync(path.join(sshDir, "prod_deploy.pub")).mode & 0o777).toBe(
			0o644,
		);
	});

	it("writeSshCredentials refuses a symlink at the key path", async () => {
		const sshDir = path.join(home, ".ssh");
		mkdirSync(sshDir, { recursive: true });
		const target = path.join(home, "victim");
		writeFileSync(target, "keep");
		symlinkSync(target, path.join(sshDir, "prod_deploy"));

		await expect(writeSshCredentials(ssh)).rejects.toThrow(/symlink/);
		expect(readFileSync(target, "utf8")).toBe("keep");
	});

	it("writeSshCredentials honours the key name and adds a Host block with IdentitiesOnly", async () => {
		const sshDir = path.join(home, ".ssh");
		mkdirSync(sshDir, { recursive: true });
		const configPath = path.join(sshDir, "config");
		writeFileSync(configPath, "Host github.com\n    User git\n");

		await writeSshCredentials(ssh, "canary_key");
		await writeSshCredentials(ssh, "canary_key"); // idempotent

		expect(existsSync(path.join(sshDir, "canary_key"))).toBe(true);
		expect(existsSync(path.join(sshDir, "canary_key.pub"))).toBe(true);
		expect(existsSync(path.join(sshDir, "prod_deploy"))).toBe(false);
		expect(readFileSync(configPath, "utf8")).toBe(
			`Host github.com\n    User git\n\nHost 10.0.0.1\n    IdentityFile ${path.join(sshDir, "canary_key")}\n    IdentitiesOnly yes\n    PasswordAuthentication no\n    StrictHostKeyChecking no\n`,
		);
	});

	it("writeSshCredentials adds only an IdentityFile to an existing block for the IP", async () => {
		const sshDir = path.join(home, ".ssh");
		mkdirSync(sshDir, { recursive: true });
		const configPath = path.join(sshDir, "config");
		writeFileSync(
			configPath,
			"Host 10.0.0.1\n  User deploy\n  IdentityFile ~/.ssh/real_key\n  ForwardAgent yes\n\nHost github.com\n    User git\n",
		);

		await writeSshCredentials(ssh);

		expect(readFileSync(configPath, "utf8")).toBe(
			`Host 10.0.0.1\n  User deploy\n  IdentityFile ~/.ssh/real_key\n  IdentityFile ${path.join(sshDir, "prod_deploy")}\n  ForwardAgent yes\n\nHost github.com\n    User git\n`,
		);
	});

	it("writeSshCredentials rejects an unsafe key name", async () => {
		await expect(writeSshCredentials(ssh, "../id_rsa")).rejects.toThrow(
			/Invalid SSH key name/,
		);
		await expect(writeSshCredentials(ssh, "")).rejects.toThrow(
			/Invalid SSH key name/,
		);
	});

	it("npm: leaves an existing auth token for the host alone", async () => {
		const npmrc = path.join(home, ".npmrc");
		writeFileSync(npmrc, "//npm.example.com/:_authToken=theirs\n");

		const result = await deployHttp("npm", "npm.example.com", {
			strategy: "npm-token",
			token: "npm_mine",
		});

		expect(result).toEqual({ deployed: false });
		expect(readFileSync(npmrc, "utf8")).toBe(
			"//npm.example.com/:_authToken=theirs\n",
		);
	});

	it("netrc: leaves an existing machine entry alone", async () => {
		const netrc = path.join(home, ".netrc");
		const theirs = "machine pypi.example.com\nlogin a\npassword b\n";
		writeFileSync(netrc, theirs);

		const result = await deployHttp("pypi", "pypi.example.com", {
			strategy: "python-index",
			token: "pypi-mine",
			indexName: "",
		});

		expect(result).toEqual({ deployed: false });
		expect(readFileSync(netrc, "utf8")).toBe(theirs);
	});

	it("any: falls through unsupported strategies to the first one it can deploy", async () => {
		const result = await deployHttp("x", "npm.example.com", {
			strategy: "any",
			strategies: [
				{ strategy: "cookie" },
				{ strategy: "mcp" },
				{ strategy: "npm-token", token: "npm_mine" },
				{ strategy: "python-index", token: "pypi-never", indexName: "" },
			],
		});
		expect(result).toEqual({ deployed: true });
		expect(readFileSync(path.join(home, ".npmrc"), "utf8")).toBe(
			"//npm.example.com/:_authToken=npm_mine\n",
		);
		expect(existsSync(path.join(home, ".netrc"))).toBe(false);
	});

	it("any: throws when no strategy is deployable, so the instance is not confirmed", async () => {
		await expect(
			deployHttp("x", "npm.example.com", {
				strategy: "any",
				strategies: [{ strategy: "cookie" }, { strategy: "url" }],
			}),
		).rejects.toThrow(/Failed to apply any requested strategy/);
		await expect(
			deployHttp("x", "npm.example.com", { strategy: "any", strategies: [] }),
		).rejects.toThrow(/no strategies were provided/);
	});

	it("all: a failing part fails the whole instance", async () => {
		await expect(
			deployHttp("x", "npm.example.com", {
				strategy: "all",
				strategies: [
					{ strategy: "npm-token", token: "npm_mine" },
					{ strategy: "cookie" },
				],
			}),
		).rejects.toThrow(/Failed to apply a strategy in all strategy/);
		// the part that ran first is still on disk; caller just won't confirm
		expect(existsSync(path.join(home, ".npmrc"))).toBe(true);
	});

	it("writeSshCredentials refuses a symlinked ssh config", async () => {
		const sshDir = path.join(home, ".ssh");
		mkdirSync(sshDir, { recursive: true });
		const target = path.join(home, "victim-config");
		writeFileSync(target, "Host a\n");
		symlinkSync(target, path.join(sshDir, "config"));

		await expect(writeSshCredentials(ssh)).rejects.toThrow(/symlink/);
		expect(readFileSync(target, "utf8")).toBe("Host a\n");
	});

	it("writeSshCredentials handles an IPv6 canary host", async () => {
		await writeSshCredentials({ ...ssh, sshIp: "2001:db8::1" });
		expect(readFileSync(path.join(home, ".ssh", "config"), "utf8")).toMatch(
			/^Host 2001:db8::1\n/u,
		);
	});

	it("all: deployed when any part deployed", async () => {
		writeFileSync(
			path.join(home, ".npmrc"),
			"//npm.example.com/:_authToken=theirs\n",
		);
		const result = await deployHttp("x", "npm.example.com", {
			strategy: "all",
			strategies: [
				{ strategy: "npm-token", token: "npm_mine" },
				{ strategy: "python-index", token: "pypi-mine", indexName: "" },
			],
		});
		expect(result).toEqual({ deployed: true });
		expect(existsSync(path.join(home, ".netrc"))).toBe(true);
	});
});

describe("text helpers", () => {
	it("removeIniSection drops only the named section", () => {
		expect(
			removeIniSection("[a]\nk = 1\n\n[b]\nk = 2\n\n[c]\nk = 3\n", "b"),
		).toBe("[a]\nk = 1\n\n[c]\nk = 3\n");
		expect(removeIniSection("[b]\nk = 2\n\n[a]\nk = 1\n", "b")).toBe(
			"[a]\nk = 1\n",
		);
		expect(removeIniSection("[a]\nk = 1\n", "b")).toBe("[a]\nk = 1\n");
		expect(removeIniSection(" [ b ] \nk = 2\n", "b")).toBe(" [ b ] \nk = 2\n");
		expect(removeIniSection("[b]\nk = 2\n[b]\nk = 3\n[a]\nk = 1\n", "b")).toBe(
			"[a]\nk = 1\n",
		);
	});

	it("INI headers with trailing comments are recognised (AWS CLI accepts them)", () => {
		expect(iniHeaderName("[production] # deployment credentials")).toBe(
			"production",
		);
		expect(iniHeaderName("[tracebit]  ; canary")).toBe("tracebit");
		expect(iniHeaderName("  [profile x]\t")).toBe("profile x");
		expect(iniHeaderName("[a] b")).toBeNull();
		expect(iniHeaderName("key = [not a header]")).toBeNull();
		expect(iniHeaderName("# [commented out]")).toBeNull();

		// Removing the canary section must stop at a commented header that follows it.
		const text =
			"[tracebit]\naws_access_key_id = X\n\n[production] # deployment credentials\naws_access_key_id = PROD\n";
		expect(removeIniSection(text, "tracebit")).toBe(
			"[production] # deployment credentials\naws_access_key_id = PROD\n",
		);
		// A commented header on our own section is still ours to replace.
		expect(
			removeIniSection(
				"[tracebit] # canary\nk = 1\n\n[a]\nk = 2\n",
				"tracebit",
			),
		).toBe("[a]\nk = 2\n");
		expect(
			hasIniSection(
				"[profile tracebit] ; x\nregion = eu\n",
				"profile tracebit",
			),
		).toBe(true);
	});

	it("upsertSshHostBlock appends, extends, or leaves alone", () => {
		const block = "Host 1.2.3.4\n    IdentityFile /k\n    IdentitiesOnly yes";
		expect(upsertSshHostBlock("", "1.2.3.4", "/k", block)).toBe(`${block}\n`);
		expect(
			upsertSshHostBlock("Host a\n    User x\n", "1.2.3.4", "/k", block),
		).toBe(`Host a\n    User x\n\n${block}\n`);
		// existing block, no IdentityFile: added right after the Host line
		expect(
			upsertSshHostBlock("Host 1.2.3.4\n    User x\n", "1.2.3.4", "/k", block),
		).toBe("Host 1.2.3.4\n    IdentityFile /k\n    User x\n");
		// existing block already has our key: untouched
		const have = "Host 1.2.3.4\n    IdentityFile /k\n    User x\n";
		expect(upsertSshHostBlock(have, "1.2.3.4", "/k", block)).toBe(have);
		// alias list "Host 1.2.3.4 other" is not an exact match: new block appended
		const multi = "Host 1.2.3.4 other\n    User x\n";
		expect(upsertSshHostBlock(multi, "1.2.3.4", "/k", block)).toBe(
			`${multi}\n${block}\n`,
		);
	});
});
