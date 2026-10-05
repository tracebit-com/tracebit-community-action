import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as ini from "ini";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@actions/core", () => ({
	getInput: vi.fn(),
	setOutput: vi.fn(),
	setSecret: vi.fn(),
	exportVariable: vi.fn(),
	saveState: vi.fn(),
	info: vi.fn(),
	warning: vi.fn(),
	error: vi.fn(),
	setFailed: vi.fn(),
}));

const postMock = vi.hoisted(() => vi.fn());
const getMock = vi.hoisted(() => vi.fn());

vi.mock("@actions/http-client", () => ({
	HttpClient: class {
		post = postMock;
		get = getMock;
	},
}));

vi.mock("node:os", async () => {
	const actual = await vi.importActual<typeof import("node:os")>("node:os");
	return {
		...actual,
		homedir: vi.fn(),
	};
});

const forkMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
	fork: forkMock,
}));

import {
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import * as core from "@actions/core";
import { run } from "../pre";

const originalEnv = process.env;
let tempHomeDir = "";

const defaultInputs = (name: string): string => {
	if (name === "customer-id") return "customerx";
	if (name === "api-token") return "token";
	if (name === "profile") return "tracebit-profile";
	if (name === "profile-region") return "us-east-1";
	return "";
};

const sshPrivateKeyText =
	"-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\nQyNTUxOQAAACBJS4x1c6+gJkj8rF4zeylgs7HpQntB4sa8kc52xcjuyg==\n-----END OPENSSH PRIVATE KEY-----\n";
const sshPublicKeyText =
	"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIElLjHVzr6AmSPysXjN7KWCzselCe0HixryRznbFyO7K ci@tracebit\n";
const sshPrivateKeyBase64 = Buffer.from(sshPrivateKeyText).toString("base64");
const sshPublicKeyBase64 = Buffer.from(sshPublicKeyText).toString("base64");

const issuedCredentialsResponse = {
	message: { statusCode: 200 },
	readBody: async () =>
		JSON.stringify({
			aws: {
				awsConfirmationId: "11111111-1111-4111-8111-111111111111",
				awsAccessKeyId: "ASIAIOSFODNN7EXAMPLE",
				awsSecretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
				awsSessionToken:
					"FwoGZXIvYXdzEBYaDEXAMPLESESSIONTOKEN0123456789abcdefABCDEF+/=",
				awsExpiration: "2026-05-10T14:45:14Z",
			},
			ssh: {
				sshConfirmationId: "33333333-3333-4333-8333-333333333333",
				sshIp: "34.246.54.210",
				sshPrivateKey: sshPrivateKeyBase64,
				sshPublicKey: sshPublicKeyBase64,
				sshExpiration: "2026-05-10T14:45:14.7390578Z",
			},
			http: {
				npm: {
					confirmationId: "44444444-4444-4444-8444-444444444444",
					browserDeploymentId: "55555555-5555-4555-8555-555555555555",
					hostNames: ["npm.example.com"],
					expiresAt: null,
					credentials: {
						strategy: "npm-token",
						token: "npm-auth-token",
					},
				},
			},
		}),
};

const confirmResponse = {
	message: { statusCode: 200 },
	readBody: async () => "",
};

const issuedResponse = (
	body: Record<string, unknown>,
): {
	message: { statusCode: number };
	readBody: () => Promise<string>;
} => ({
	message: { statusCode: 200 },
	readBody: async () => JSON.stringify(body),
});

const confirmedIds = (): string[] =>
	postMock.mock.calls
		.filter((call) => String(call[0]).includes("confirm-credentials"))
		.map((call) => (JSON.parse(String(call[1])) as { id: string }).id);

describe("pre step", () => {
	beforeEach(() => {
		tempHomeDir = mkdtempSync(
			path.join(os.tmpdir(), "tracebit-github-action-pre-test-"),
		);
		vi.resetAllMocks();
		process.env = {
			...originalEnv,
			HOME: tempHomeDir,
			USERPROFILE: tempHomeDir,
			AWS_CONFIG_FILE: path.join(tempHomeDir, ".aws", "config"),
			AWS_SHARED_CREDENTIALS_FILE: path.join(
				tempHomeDir,
				".aws",
				"credentials",
			),
		};
		vi.mocked(os.homedir).mockReturnValue(tempHomeDir);
		postMock.mockReset();
		getMock.mockReset();
		// Default: perimeter config endpoint returns no HTTP instances.
		getMock.mockResolvedValue({
			message: { statusCode: 200 },
			readBody: async () => "{}",
		});
		for (const name of [
			"GITHUB_REF",
			"GITHUB_REPOSITORY",
			"GITHUB_RUN_ID",
			"GITHUB_SHA",
			"GITHUB_WORKFLOW",
			"GITHUB_JOB",
		]) {
			delete process.env[name];
		}
	});

	afterEach(async () => {
		process.env = originalEnv;
		if (tempHomeDir) {
			await rm(tempHomeDir, { recursive: true, force: true });
			tempHomeDir = "";
		}
	});

	describe("sync mode", () => {
		it("warns and skips everything when the API token is missing (fork PRs)", async () => {
			vi.mocked(core.getInput).mockImplementation((name: string) =>
				name === "api-token" ? "" : defaultInputs(name),
			);

			await expect(run()).resolves.toBeUndefined();

			expect(postMock).not.toHaveBeenCalled();
			expect(core.setFailed).not.toHaveBeenCalled();
			expect(core.warning).toHaveBeenCalledWith(
				expect.stringContaining("No Tracebit API token"),
			);
			expect(existsSync(path.join(tempHomeDir, ".aws"))).toBe(false);
			expect(core.exportVariable).not.toHaveBeenCalled();
		});

		it("does not throw when issuing credentials fails", async () => {
			vi.mocked(core.getInput).mockImplementation(defaultInputs);
			postMock.mockResolvedValueOnce({
				message: { statusCode: 500 },
				readBody: async () => "issue failed",
			});

			await expect(run()).resolves.toBeUndefined();
			expect(core.warning).toHaveBeenCalled();
			expect(postMock).toHaveBeenCalledTimes(1);
		});

		it("does not throw when confirmation fails", async () => {
			vi.mocked(core.getInput).mockImplementation(defaultInputs);
			postMock
				.mockResolvedValueOnce(issuedCredentialsResponse)
				.mockResolvedValueOnce({
					message: { statusCode: 500 },
					readBody: async () => "confirm failed",
				})
				.mockResolvedValueOnce(confirmResponse);

			await expect(run()).resolves.toBeUndefined();
			expect(core.warning).toHaveBeenCalled();
		});

		describe("perimeter config", () => {
			it("requests http instances returned by the config endpoint", async () => {
				vi.mocked(core.getInput).mockImplementation(defaultInputs);
				getMock.mockResolvedValue({
					message: { statusCode: 200 },
					readBody: async () =>
						JSON.stringify({
							instances: [
								{ key: "npm", instanceId: "inst-npm" },
								{ key: "pypi", instanceId: "inst-pypi" },
							],
						}),
				});
				postMock
					.mockResolvedValueOnce(issuedCredentialsResponse)
					.mockResolvedValue(confirmResponse);

				await run();

				expect(getMock.mock.calls[0]?.[0]).toBe(
					"https://customerx.tracebit.com/api/_internal/v1/github/instances",
				);
				const body = JSON.parse(String(postMock.mock.calls[0]?.[1])) as {
					typeConfigs: Array<Record<string, string>>;
				};
				expect(body.typeConfigs).toEqual([
					{ typeName: "aws" },
					{ typeName: "ssh" },
					{ key: "npm", instanceId: "inst-npm", typeName: "http" },
					{ key: "pypi", instanceId: "inst-pypi", typeName: "http" },
				]);
				expect(core.warning).not.toHaveBeenCalledWith(
					expect.stringContaining("perimeter instances"),
				);
			});

			it("continues with aws and ssh only when the config endpoint fails", async () => {
				vi.mocked(core.getInput).mockImplementation(defaultInputs);
				getMock.mockResolvedValue({
					message: { statusCode: 500 },
					readBody: async () => "boom",
				});
				postMock
					.mockResolvedValueOnce(issuedCredentialsResponse)
					.mockResolvedValue(confirmResponse);

				await run();

				const body = JSON.parse(String(postMock.mock.calls[0]?.[1])) as {
					typeConfigs: Array<Record<string, string>>;
				};
				expect(body.typeConfigs).toEqual([
					{ typeName: "aws" },
					{ typeName: "ssh" },
				]);
				expect(core.warning).toHaveBeenCalledWith(
					expect.stringContaining("Failed to fetch perimeter instances"),
				);
				expect(confirmedIds().length).toBeGreaterThan(0);
			});

			it("rejects a config response whose instance ids could inject into the request", async () => {
				vi.mocked(core.getInput).mockImplementation(defaultInputs);
				getMock.mockResolvedValue({
					message: { statusCode: 200 },
					readBody: async () =>
						JSON.stringify({
							instances: [{ key: "npm", instanceId: "bad id\n" }],
						}),
				});
				postMock
					.mockResolvedValueOnce(issuedCredentialsResponse)
					.mockResolvedValue(confirmResponse);

				await run();

				const body = JSON.parse(String(postMock.mock.calls[0]?.[1])) as {
					typeConfigs: Array<Record<string, string>>;
				};
				expect(body.typeConfigs).toEqual([
					{ typeName: "aws" },
					{ typeName: "ssh" },
				]);
				expect(core.warning).toHaveBeenCalledWith(
					expect.stringContaining("instanceId"),
				);
			});
		});

		it("writes [default] rather than [profile default] to the AWS config", async () => {
			vi.mocked(core.getInput).mockImplementation((name: string) =>
				name === "profile" ? "default" : defaultInputs(name),
			);
			postMock
				.mockResolvedValueOnce(issuedCredentialsResponse)
				.mockResolvedValue(confirmResponse);

			await run();

			expect(
				readFileSync(path.join(tempHomeDir, ".aws", "config"), "utf8"),
			).toBe("[default]\nregion = us-east-1\n");
			expect(
				readFileSync(path.join(tempHomeDir, ".aws", "credentials"), "utf8"),
			).toMatch(/^\[default\]\n/u);
		});

		it("includes GitHub labels in the issue payload", async () => {
			process.env.GITHUB_REF = "refs/tags/v1.2.3";
			process.env.GITHUB_REPOSITORY = "org/repo";
			process.env.GITHUB_RUN_ID = "123";
			process.env.GITHUB_SHA = "deadbeef";
			process.env.GITHUB_WORKFLOW = "workflow";
			process.env.GITHUB_JOB = "job";

			vi.mocked(core.getInput).mockImplementation(defaultInputs);
			postMock
				.mockResolvedValueOnce(issuedCredentialsResponse)
				.mockResolvedValueOnce(confirmResponse)
				.mockResolvedValueOnce(confirmResponse);

			await run();

			expect(postMock.mock.calls[0]?.[0]).toBe(
				"https://customerx.tracebit.com/api/v1/credentials/issue-credentials",
			);
			const body = JSON.parse(String(postMock.mock.calls[0]?.[1] ?? "{}")) as {
				labels: Array<{ name: string; value: string }>;
			};
			const labelMap = new Map(
				body.labels.map((label) => [label.name, label.value]),
			);

			expect(labelMap.get("github.ref")).toBe("refs/tags/v1.2.3");
			expect(labelMap.get("github.repo")).toBe("org/repo");
			expect(labelMap.get("github.sha")).toBe("deadbeef");
		});

		it("sets credential outputs and exports environment on success", async () => {
			vi.mocked(core.getInput).mockImplementation(defaultInputs);
			postMock
				.mockResolvedValueOnce(issuedCredentialsResponse)
				.mockResolvedValueOnce(confirmResponse)
				.mockResolvedValueOnce(confirmResponse);

			await run();

			// exportVariable: plain credentials
			expect(core.exportVariable).toHaveBeenCalledWith(
				"__AWS__ACCESS_KEY_ID",
				"ASIAIOSFODNN7EXAMPLE",
			);
			expect(core.exportVariable).toHaveBeenCalledWith(
				"__AWS__SECRET_ACCESS_KEY",
				"wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
			);
			expect(core.exportVariable).toHaveBeenCalledWith(
				"__AWS__SESSION_TOKEN",
				"FwoGZXIvYXdzEBYaDEXAMPLESESSIONTOKEN0123456789abcdefABCDEF+/=",
			);
			expect(core.exportVariable).toHaveBeenCalledWith(
				"__AWS__REGION",
				"us-east-1",
			);
			expect(core.exportVariable).toHaveBeenCalledWith(
				"__AWS__DEFAULT_REGION",
				"us-east-1",
			);
			expect(core.exportVariable).toHaveBeenCalledWith(
				"__AWS__PROFILE",
				"tracebit-profile",
			);

			// exportVariable: JSON secret format
			expect(core.exportVariable).toHaveBeenCalledWith(
				"__AWS__ACCESS_KEY_ID_SECRET",
				'"ACCESS_KEY_ID_SECRET":{"value":"ASIAIOSFODNN7EXAMPLE","isSecret":true}',
			);
			expect(core.exportVariable).toHaveBeenCalledWith(
				"__AWS__SECRET_ACCESS_KEY_SECRET",
				'"SECRET_ACCESS_KEY_SECRET":{"value":"wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY","isSecret":true}',
			);
			expect(core.exportVariable).toHaveBeenCalledWith(
				"__AWS__SESSION_TOKEN_SECRET",
				'"SESSION_TOKEN_SECRET":{"value":"FwoGZXIvYXdzEBYaDEXAMPLESESSIONTOKEN0123456789abcdefABCDEF+/=","isSecret":true}',
			);

			// setOutput: plain credentials
			expect(core.setOutput).toHaveBeenCalledWith(
				"aws-access-key-id",
				"ASIAIOSFODNN7EXAMPLE",
			);
			expect(core.setOutput).toHaveBeenCalledWith(
				"aws-secret-access-key",
				"wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
			);
			expect(core.setOutput).toHaveBeenCalledWith(
				"aws-session-token",
				"FwoGZXIvYXdzEBYaDEXAMPLESESSIONTOKEN0123456789abcdefABCDEF+/=",
			);
			expect(core.setOutput).toHaveBeenCalledWith(
				"profile-name",
				"tracebit-profile",
			);

			// setOutput: JSON secret format
			expect(core.setOutput).toHaveBeenCalledWith(
				"aws-access-key-id-secret",
				'"ACCESS_KEY_ID_SECRET":{"value":"ASIAIOSFODNN7EXAMPLE","isSecret":true}',
			);
			expect(core.setOutput).toHaveBeenCalledWith(
				"aws-secret-access-key-secret",
				'"SECRET_ACCESS_KEY_SECRET":{"value":"wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY","isSecret":true}',
			);
			expect(core.setOutput).toHaveBeenCalledWith(
				"aws-session-token-secret",
				'"SESSION_TOKEN_SECRET":{"value":"FwoGZXIvYXdzEBYaDEXAMPLESESSIONTOKEN0123456789abcdefABCDEF+/=","isSecret":true}',
			);

			// saveState: plain credentials
			expect(core.saveState).toHaveBeenCalledWith(
				"aws-access-key-id",
				"ASIAIOSFODNN7EXAMPLE",
			);
			expect(core.saveState).toHaveBeenCalledWith(
				"aws-secret-access-key",
				"wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
			);
			expect(core.saveState).toHaveBeenCalledWith(
				"aws-session-token",
				"FwoGZXIvYXdzEBYaDEXAMPLESESSIONTOKEN0123456789abcdefABCDEF+/=",
			);
			expect(core.saveState).toHaveBeenCalledWith(
				"profile-name",
				"tracebit-profile",
			);

			// saveState: JSON secret format
			expect(core.saveState).toHaveBeenCalledWith(
				"aws-access-key-id-secret",
				'"ACCESS_KEY_ID_SECRET":{"value":"ASIAIOSFODNN7EXAMPLE","isSecret":true}',
			);
			expect(core.saveState).toHaveBeenCalledWith(
				"aws-secret-access-key-secret",
				'"SECRET_ACCESS_KEY_SECRET":{"value":"wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY","isSecret":true}',
			);
			expect(core.saveState).toHaveBeenCalledWith(
				"aws-session-token-secret",
				'"SESSION_TOKEN_SECRET":{"value":"FwoGZXIvYXdzEBYaDEXAMPLESESSIONTOKEN0123456789abcdefABCDEF+/=","isSecret":true}',
			);

			// setSecret: plain credentials
			expect(core.setSecret).toHaveBeenCalledWith("ASIAIOSFODNN7EXAMPLE");
			expect(core.setSecret).toHaveBeenCalledWith(
				"wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
			);
			expect(core.setSecret).toHaveBeenCalledWith(
				"FwoGZXIvYXdzEBYaDEXAMPLESESSIONTOKEN0123456789abcdefABCDEF+/=",
			);

			// setSecret: JSON secret format
			expect(core.setSecret).toHaveBeenCalledWith(
				'"ACCESS_KEY_ID_SECRET":{"value":"ASIAIOSFODNN7EXAMPLE","isSecret":true}',
			);
			expect(core.setSecret).toHaveBeenCalledWith(
				'"SECRET_ACCESS_KEY_SECRET":{"value":"wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY","isSecret":true}',
			);
			expect(core.setSecret).toHaveBeenCalledWith(
				'"SESSION_TOKEN_SECRET":{"value":"FwoGZXIvYXdzEBYaDEXAMPLESESSIONTOKEN0123456789abcdefABCDEF+/=","isSecret":true}',
			);
		});

		it("writes SSH credentials when SSH is in the response", async () => {
			vi.mocked(core.getInput).mockImplementation(defaultInputs);
			postMock
				.mockResolvedValueOnce(issuedCredentialsResponse)
				.mockResolvedValueOnce(confirmResponse)
				.mockResolvedValueOnce(confirmResponse);

			await run();

			const sshDir = path.join(tempHomeDir, ".ssh");
			const privateKeyPath = path.join(sshDir, "prod_deploy");
			const publicKeyPath = path.join(sshDir, "prod_deploy.pub");
			const configPath = path.join(sshDir, "config");

			expect(readFileSync(privateKeyPath, "utf8")).toBe(sshPrivateKeyText);
			expect(readFileSync(publicKeyPath, "utf8")).toBe(sshPublicKeyText);

			const config = readFileSync(configPath, "utf8");
			expect(config).toContain("Host 34.246.54.210");
			expect(config).toContain(`IdentityFile ${privateKeyPath}`);
			expect(config).toContain("PasswordAuthentication no");

			// private key file should have 0o600 permissions
			const privateKeyStat = statSync(privateKeyPath);
			expect(privateKeyStat.mode & 0o777).toBe(0o600);
		});

		it("marks SSH private key as secret", async () => {
			vi.mocked(core.getInput).mockImplementation(defaultInputs);
			postMock
				.mockResolvedValueOnce(issuedCredentialsResponse)
				.mockResolvedValueOnce(confirmResponse)
				.mockResolvedValueOnce(confirmResponse);

			await run();

			expect(core.setSecret).toHaveBeenCalledWith(sshPrivateKeyBase64);
			expect(core.setSecret).toHaveBeenCalledWith(sshPrivateKeyText);
		});

		const ST = "FwoGZXIvYXdzEBYaDEXAMPLESESSIONTOKEN0123456789abcdefABCDEF+/=";
		const body = (): Record<string, unknown> =>
			JSON.parse(
				JSON.stringify({
					aws: {
						awsConfirmationId: "11111111-1111-4111-8111-111111111111",
						awsAccessKeyId: "ASIAIOSFODNN7EXAMPLE",
						awsSecretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
						awsSessionToken: ST,
						awsExpiration: "2026-05-10T14:45:14Z",
					},
					http: {
						npm: {
							confirmationId: "44444444-4444-4444-8444-444444444444",
							browserDeploymentId: "55555555-5555-4555-8555-555555555555",
							hostNames: ["npm.example.com"],
							expiresAt: null,
							credentials: { strategy: "npm-token", token: "npm-auth-token" },
						},
					},
				}),
			);

		describe("response validation (F1 regression)", () => {
			it("skips AWS when the session token carries an INI section, but still deploys npm", async () => {
				vi.mocked(core.getInput).mockImplementation(defaultInputs);
				const b = body();
				(b.aws as Record<string, string>).awsSessionToken =
					`${ST}\n[default]\ncredential_process = /tmp/pwn`;
				postMock
					.mockResolvedValueOnce(issuedResponse(b))
					.mockResolvedValue(confirmResponse);

				await run();

				expect(existsSync(path.join(tempHomeDir, ".aws", "credentials"))).toBe(
					false,
				);
				expect(existsSync(path.join(tempHomeDir, ".npmrc"))).toBe(true);
				expect(core.exportVariable).not.toHaveBeenCalledWith(
					"__AWS__ACCESS_KEY_ID",
					expect.anything(),
				);
				expect(core.exportVariable).toHaveBeenCalledWith(
					"__NPM__TOKEN",
					"npm-auth-token",
				);
				expect(confirmedIds()).toEqual([
					"44444444-4444-4444-8444-444444444444",
				]);
				expect(core.warning).toHaveBeenCalledWith(
					expect.stringMatching(/Skipping AWS credentials: .*awsSessionToken/),
				);
			});

			it("skips the http instance whose hostname carries an npmrc directive, but still deploys AWS", async () => {
				vi.mocked(core.getInput).mockImplementation(defaultInputs);
				const b = body();
				(b.http as Record<string, { hostNames: string[] }>).npm.hostNames = [
					"npm.example.com/:_authToken=x\nregistry=https://evil.example",
				];
				postMock
					.mockResolvedValueOnce(issuedResponse(b))
					.mockResolvedValue(confirmResponse);

				await run();

				expect(existsSync(path.join(tempHomeDir, ".npmrc"))).toBe(false);
				expect(existsSync(path.join(tempHomeDir, ".aws", "credentials"))).toBe(
					true,
				);
				expect(confirmedIds()).toEqual([
					"11111111-1111-4111-8111-111111111111",
				]);
				expect(core.warning).toHaveBeenCalledWith(
					expect.stringMatching(
						/Skipping HTTP instance "npm": .*hostNames\[0\]/,
					),
				);
			});

			it("skips a python-index instance whose hostname carries a netrc default entry", async () => {
				vi.mocked(core.getInput).mockImplementation(defaultInputs);
				const b = body();
				(b.http as Record<string, unknown>).npm = {
					confirmationId: "66666666-6666-4666-8666-666666666666",
					browserDeploymentId: "77777777-7777-4777-8777-777777777777",
					hostNames: ["pypi.example.com\ndefault login a password b\nmachine"],
					expiresAt: null,
					credentials: {
						strategy: "python-index",
						token: "pypi-abc",
						indexName: "internal",
					},
				};
				postMock
					.mockResolvedValueOnce(issuedResponse(b))
					.mockResolvedValue(confirmResponse);

				await run();

				expect(existsSync(path.join(tempHomeDir, ".netrc"))).toBe(false);
				expect(confirmedIds()).toEqual([
					"11111111-1111-4111-8111-111111111111",
				]);
			});

			it("ignores a credential family this version does not know and deploys the rest", async () => {
				vi.mocked(core.getInput).mockImplementation(defaultInputs);
				const b = body();
				b.gcp = { serviceAccountKey: "x" };
				postMock
					.mockResolvedValueOnce(issuedResponse(b))
					.mockResolvedValue(confirmResponse);

				await run();

				expect(existsSync(path.join(tempHomeDir, ".aws", "credentials"))).toBe(
					true,
				);
				expect(confirmedIds().sort()).toEqual([
					"11111111-1111-4111-8111-111111111111",
					"44444444-4444-4444-8444-444444444444",
				]);
				expect(core.warning).toHaveBeenCalledWith(
					expect.stringContaining(
						'"gcp" credentials this action version does not support',
					),
				);
			});

			it("forward compatibility: extra fields, a new family and new strategies still deploy all four canaries", async () => {
				vi.mocked(core.getInput).mockImplementation(defaultInputs);
				// biome-ignore lint/suspicious/noExplicitAny: deliberately off-schema fixture
				const b = JSON.parse(await issuedCredentialsResponse.readBody()) as any;
				b.aws.awsAccountId = "123456789012";
				b.ssh.sshPort = 22;
				b.okta = { oktaToken: "y", oktaOrgUrl: "https://x" };
				b.issuedAt = "2026-10-05T00:00:00Z";
				b.http.npm.credentials = {
					strategy: "any",
					strategies: [
						{ strategy: "mcp", token: "jwt" },
						{ strategy: "npm-token", token: "npm-auth-token", scope: "@acme" },
					],
				};
				b.http.es = {
					confirmationId: "99999999-9999-4999-8999-999999999999",
					browserDeploymentId: "55555555-5555-4555-8555-555555555555",
					hostNames: ["es.example.com"],
					expiresAt: null,
					credentials: { strategy: "elasticsearch-api-key", encoded: "abc=" },
				};
				postMock
					.mockResolvedValueOnce(issuedResponse(b))
					.mockResolvedValue(confirmResponse);

				await run();

				// aws, ssh and npm deployed and confirmed; "es" is a strategy this
				// version cannot deploy, so it is warned about and not confirmed.
				expect(confirmedIds().sort()).toEqual([
					"11111111-1111-4111-8111-111111111111",
					"33333333-3333-4333-8333-333333333333",
					"44444444-4444-4444-8444-444444444444",
				]);
				expect(existsSync(path.join(tempHomeDir, ".aws", "credentials"))).toBe(
					true,
				);
				expect(existsSync(path.join(tempHomeDir, ".ssh", "prod_deploy"))).toBe(
					true,
				);
				expect(
					readFileSync(path.join(tempHomeDir, ".npmrc"), "utf8"),
				).toContain("npm-auth-token");
				expect(core.exportVariable).toHaveBeenCalledWith(
					"__NPM__TOKEN",
					"npm-auth-token",
				);
				expect(core.warning).toHaveBeenCalledWith(
					expect.stringContaining(
						'"okta" credentials this action version does not support',
					),
				);
				expect(core.warning).toHaveBeenCalledWith(
					expect.stringContaining(
						"Deploying HTTP credentials for instance es failed",
					),
				);
				expect(core.setFailed).not.toHaveBeenCalled();
			});

			it("warns and writes nothing when every part of the response is unusable", async () => {
				vi.mocked(core.getInput).mockImplementation(defaultInputs);
				postMock
					.mockResolvedValueOnce(issuedResponse({ gcp: { x: 1 } }))
					.mockResolvedValue(confirmResponse);

				await run();

				expect(existsSync(path.join(tempHomeDir, ".aws"))).toBe(false);
				expect(confirmedIds()).toEqual([]);
				expect(core.warning).toHaveBeenCalledWith(
					expect.stringContaining("No credentials were issued"),
				);
			});
		});

		it("writes NPM credentials when NPM token is in the response", async () => {
			vi.mocked(core.getInput).mockImplementation(defaultInputs);
			postMock
				.mockResolvedValueOnce(issuedCredentialsResponse)
				.mockResolvedValueOnce(confirmResponse)
				.mockResolvedValueOnce(confirmResponse);

			await run();

			const configPath = path.join(tempHomeDir, ".npmrc");

			const config = readFileSync(configPath, "utf8");
			// npm uses ini package to parse; replicate that behaviour
			const parsed = ini.parse(config);
			expect(parsed).toHaveProperty(
				`//npm.example.com/:_authToken`,
				"npm-auth-token",
			);

			const configStat = statSync(configPath);
			expect(configStat.mode & 0o777).toBe(0o600);

			// env vars use the __NPM__ prefix so a real NPM_TOKEN is never shadowed
			expect(core.exportVariable).toHaveBeenCalledWith(
				"__NPM__TOKEN",
				"npm-auth-token",
			);
			expect(core.exportVariable).toHaveBeenCalledWith(
				"__NPM__TOKEN_SECRET",
				'"NPM_TOKEN_SECRET":{"value":"npm-auth-token","isSecret":true}',
			);
			expect(core.exportVariable).not.toHaveBeenCalledWith(
				"NPM_TOKEN",
				expect.anything(),
			);
			expect(core.setOutput).toHaveBeenCalledWith(
				"npm-token",
				"npm-auth-token",
			);
		});

		describe("confirmation of planted credentials", () => {
			const awsCreds = {
				awsConfirmationId: "22222222-2222-4222-8222-222222222222",
				awsAccessKeyId: "ASIAIOSFODNN7EXAMPLE",
				awsSecretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
				awsSessionToken:
					"FwoGZXIvYXdzEBYaDEXAMPLESESSIONTOKEN0123456789abcdefABCDEF+/=",
				awsExpiration: "2026-05-10T14:45:14Z",
			};

			const sshCreds = {
				sshConfirmationId: "33333333-3333-4333-8333-333333333333",
				sshIp: "34.246.54.210",
				sshPrivateKey: sshPrivateKeyBase64,
				sshPublicKey: sshPublicKeyBase64,
				sshExpiration: "2026-05-10T14:45:14.7390578Z",
			};

			const httpCreds = {
				npm: {
					confirmationId: "44444444-4444-4444-8444-444444444444",
					browserDeploymentId: "55555555-5555-4555-8555-555555555555",
					hostNames: ["npm.example.com"],
					expiresAt: null,
					credentials: { strategy: "npm-token", token: "npm-auth-token" },
				},
			};

			beforeEach(() => {
				vi.mocked(core.getInput).mockImplementation(defaultInputs);
			});

			it("confirms all credentials when every deploy succeeds", async () => {
				postMock
					.mockResolvedValueOnce(
						issuedResponse({ aws: awsCreds, ssh: sshCreds, http: httpCreds }),
					)
					.mockResolvedValue(confirmResponse);

				await run();

				expect(confirmedIds().sort()).toEqual([
					"22222222-2222-4222-8222-222222222222",
					"33333333-3333-4333-8333-333333333333",
					"44444444-4444-4444-8444-444444444444",
				]);
			});

			it("skips malformed SSH credentials and still deploys and confirms AWS", async () => {
				postMock
					.mockResolvedValueOnce(
						issuedResponse({
							aws: awsCreds,
							ssh: { ...sshCreds, sshIp: "not-an-ip" },
						}),
					)
					.mockResolvedValue(confirmResponse);

				await run();

				expect(confirmedIds()).toEqual([
					"22222222-2222-4222-8222-222222222222",
				]);
				expect(existsSync(path.join(tempHomeDir, ".aws", "credentials"))).toBe(
					true,
				);
				expect(existsSync(path.join(tempHomeDir, ".ssh"))).toBe(false);
				expect(core.warning).toHaveBeenCalledWith(
					expect.stringMatching(/Skipping SSH credentials: .*sshIp/),
				);
			});

			it("does not confirm SSH credentials when the SSH deploy fails", async () => {
				// Occupy ~/.ssh with a regular file so mkdir fails
				writeFileSync(path.join(tempHomeDir, ".ssh"), "not a directory");

				postMock
					.mockResolvedValueOnce(
						issuedResponse({ aws: awsCreds, ssh: sshCreds }),
					)
					.mockResolvedValue(confirmResponse);

				await run();

				expect(confirmedIds()).toEqual([
					"22222222-2222-4222-8222-222222222222",
				]);
				expect(core.warning).toHaveBeenCalledWith(
					expect.stringContaining("Write SSH credentials failed"),
				);
			});

			it("replaces an existing AWS profile of the same name and confirms it", async () => {
				const credsPath = path.join(tempHomeDir, ".aws", "credentials");
				mkdirSync(path.dirname(credsPath), { recursive: true });
				writeFileSync(
					credsPath,
					"[other]\naws_access_key_id = THEIRS\n\n[tracebit-profile]\naws_access_key_id = STALE\n",
				);

				postMock
					.mockResolvedValueOnce(
						issuedResponse({ aws: awsCreds, ssh: sshCreds }),
					)
					.mockResolvedValue(confirmResponse);

				await run();

				expect(confirmedIds().sort()).toEqual([
					"22222222-2222-4222-8222-222222222222",
					"33333333-3333-4333-8333-333333333333",
				]);
				const creds = readFileSync(credsPath, "utf8");
				expect(creds).toContain("[other]\naws_access_key_id = THEIRS");
				expect(creds).not.toContain("STALE");
				expect(creds.match(/^\[tracebit-profile\]/gmu)).toHaveLength(1);
			});

			it("overwrites an existing SSH key under the configured name and confirms it", async () => {
				vi.mocked(core.getInput).mockImplementation((name: string) =>
					name === "ssh-key-name" ? "canary_key" : defaultInputs(name),
				);
				const sshDir = path.join(tempHomeDir, ".ssh");
				mkdirSync(sshDir, { recursive: true });
				writeFileSync(path.join(sshDir, "canary_key"), "stale", {
					mode: 0o644,
				});

				postMock
					.mockResolvedValueOnce(
						issuedResponse({ aws: awsCreds, ssh: sshCreds }),
					)
					.mockResolvedValue(confirmResponse);

				await run();

				expect(confirmedIds().sort()).toEqual([
					"22222222-2222-4222-8222-222222222222",
					"33333333-3333-4333-8333-333333333333",
				]);
				const keyPath = path.join(sshDir, "canary_key");
				expect(readFileSync(keyPath, "utf8")).toBe(sshPrivateKeyText);
				expect(statSync(keyPath).mode & 0o777).toBe(0o600);
				expect(existsSync(path.join(sshDir, "prod_deploy"))).toBe(false);
			});

			it("rejects an unsafe ssh-key-name", async () => {
				vi.mocked(core.getInput).mockImplementation((name: string) =>
					name === "ssh-key-name" ? "../id_rsa" : defaultInputs(name),
				);
				await expect(run()).rejects.toThrow(/Invalid ssh-key-name/);
				expect(postMock).not.toHaveBeenCalled();
			});

			it("does not confirm AWS credentials when writing the profile fails", async () => {
				// Point the credentials file at a directory so the write fails
				process.env.AWS_SHARED_CREDENTIALS_FILE = tempHomeDir;

				postMock
					.mockResolvedValueOnce(
						issuedResponse({ aws: awsCreds, ssh: sshCreds }),
					)
					.mockResolvedValue(confirmResponse);

				await run();

				expect(confirmedIds()).toEqual([
					"33333333-3333-4333-8333-333333333333",
				]);
				expect(core.warning).toHaveBeenCalledWith(
					expect.stringContaining("Write profile failed"),
				);
			});

			it("confirms only the http instances that deployed", async () => {
				const httpMixed = {
					...httpCreds,
					pypi: {
						confirmationId: "66666666-6666-4666-8666-666666666666",
						browserDeploymentId: "77777777-7777-4777-8777-777777777777",
						hostNames: [] as string[],
						expiresAt: null,
						credentials: { strategy: "npm-token", token: "t2" },
					},
				};

				postMock
					.mockResolvedValueOnce(issuedResponse({ http: httpMixed }))
					.mockResolvedValue(confirmResponse);

				await run();

				expect(confirmedIds()).toEqual([
					"44444444-4444-4444-8444-444444444444",
				]);
				expect(core.warning).toHaveBeenCalledWith(
					expect.stringContaining(
						"Deploying HTTP credentials for instance pypi failed",
					),
				);
			});

			it("confirms nothing when every deploy fails", async () => {
				process.env.AWS_SHARED_CREDENTIALS_FILE = tempHomeDir;

				postMock
					.mockResolvedValueOnce(
						issuedResponse({
							aws: awsCreds,
							ssh: { ...sshCreds, sshIp: "not-an-ip" },
						}),
					)
					.mockResolvedValue(confirmResponse);

				await run();

				expect(confirmedIds()).toEqual([]);
			});
		});
	});

	describe("async mode", () => {
		it("forks child process and exports credentials path", async () => {
			vi.mocked(core.getInput).mockImplementation((name) => {
				if (name === "async") return "true";
				return defaultInputs(name);
			});

			const mockChild = {
				pid: 12345,
				exitCode: null,
				disconnect: vi.fn(),
				unref: vi.fn(),
			};
			forkMock.mockReturnValue(mockChild);

			await run();

			expect(forkMock).toHaveBeenCalledOnce();
			expect(mockChild.disconnect).toHaveBeenCalled();
			expect(mockChild.unref).toHaveBeenCalled();
			expect(core.exportVariable).toHaveBeenCalledWith(
				"_SECURITY_CREDENTIALS_PATH",
				expect.any(String),
			);
			expect(core.saveState).toHaveBeenCalledWith("async_pid", "12345");
		});

		it("warns instead of failing when fork throws unexpectedly", async () => {
			vi.mocked(core.getInput).mockImplementation((name) => {
				if (name === "async") return "true";
				return defaultInputs(name);
			});

			forkMock.mockImplementation(() => {
				throw new Error("spawn EACCES");
			});

			await expect(run()).resolves.toBeUndefined();
			expect(core.setFailed).not.toHaveBeenCalled();
			expect(core.warning).toHaveBeenCalledWith(
				expect.stringContaining("spawn EACCES"),
			);
		});

		it("does not throw when fork fails", async () => {
			vi.mocked(core.getInput).mockImplementation((name) => {
				if (name === "async") return "true";
				return defaultInputs(name);
			});

			forkMock.mockReturnValue({ pid: undefined, exitCode: 1 });

			await expect(run()).resolves.toBeUndefined();
			expect(core.warning).toHaveBeenCalled();
			expect(core.exportVariable).toHaveBeenCalled();
		});
	});
});
