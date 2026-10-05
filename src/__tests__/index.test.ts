import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
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

vi.mock("@actions/http-client", () => ({
	HttpClient: class {
		post = postMock;
	},
}));

vi.mock("node:os", async () => {
	const actual = await vi.importActual<typeof import("node:os")>("node:os");
	return {
		...actual,
		homedir: vi.fn(),
	};
});

import * as core from "@actions/core";
import { run } from "../index";
import {
	isValidApiHost,
	isValidCustomerId,
	isValidProfileName,
	isValidRegion,
} from "../inputs";

const originalEnv = process.env;
let tempHomeDir = "";

describe("action run", () => {
	beforeEach(() => {
		tempHomeDir = mkdtempSync(
			path.join(os.tmpdir(), "tracebit-github-action-test-"),
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

	it("does not throw when credentials path env var is not set", async () => {
		vi.useFakeTimers();
		vi.mocked(core.getInput).mockImplementation((name: string) => {
			if (name === "customer-id") return "customerx";
			if (name === "api-token") return "token";
			if (name === "profile") return "tracebit-profile";
			if (name === "profile-region") return "us-east-1";
			if (name === "async") return "true";
			return "";
		});

		process.env._SECURITY_CREDENTIALS_PATH = undefined;

		const promise = run();
		await vi.advanceTimersByTimeAsync(6000);
		await expect(promise).resolves.toBeUndefined();
		expect(core.warning).toHaveBeenCalled();
		vi.useRealTimers();
	});

	it("exports and masks HTTP tokens from the credentials file in async mode", async () => {
		vi.mocked(core.getInput).mockImplementation((name: string) => {
			if (name === "customer-id") return "customerx";
			if (name === "api-token") return "token";
			if (name === "profile") return "tracebit-profile";
			if (name === "profile-region") return "us-east-1";
			if (name === "async") return "true";
			return "";
		});
		const credentialsPath = path.join(tempHomeDir, "credentials.json");
		writeFileSync(
			credentialsPath,
			JSON.stringify({
				http: {
					npm: {
						confirmationId: "44444444-4444-4444-8444-444444444444",
						browserDeploymentId: "55555555-5555-4555-8555-555555555555",
						hostNames: ["npm.example.com"],
						expiresAt: null,
						credentials: {
							strategy: "any",
							strategies: [
								{ strategy: "npm-token", token: "npm-auth-token" },
								{ strategy: "browser" },
							],
						},
					},
					pypi: {
						confirmationId: "66666666-6666-4666-8666-666666666666",
						browserDeploymentId: "77777777-7777-4777-8777-777777777777",
						hostNames: ["pypi.example.com"],
						expiresAt: null,
						credentials: {
							strategy: "python-index",
							token: "pypi-abc",
							indexName: "",
						},
					},
				},
			}),
		);
		process.env._SECURITY_CREDENTIALS_PATH = credentialsPath;

		await run();

		expect(core.exportVariable).toHaveBeenCalledWith(
			"__NPM__TOKEN",
			"npm-auth-token",
		);
		expect(core.exportVariable).toHaveBeenCalledWith(
			"__PYPI__TOKEN",
			"pypi-abc",
		);
		expect(core.setOutput).toHaveBeenCalledWith("npm-token", "npm-auth-token");
		expect(core.setOutput).toHaveBeenCalledWith("pypi-token", "pypi-abc");
		expect(core.setSecret).toHaveBeenCalledWith("npm-auth-token");
		expect(core.setSecret).toHaveBeenCalledWith("pypi-abc");
	});

	it("exports credentials when credentials file exists", async () => {
		vi.mocked(core.getInput).mockImplementation((name: string) => {
			if (name === "customer-id") return "customerx";
			if (name === "api-token") return "token";
			if (name === "profile") return "tracebit-profile";
			if (name === "profile-region") return "us-east-1";
			if (name === "async") return "true";
			return "";
		});

		const credentialsPath = path.join(tempHomeDir, "credentials.json");
		writeFileSync(
			credentialsPath,
			JSON.stringify({
				aws: {
					awsConfirmationId: "22222222-2222-4222-8222-222222222222",
					awsAccessKeyId: "ASIAIOSFODNN7EXAMPLE",
					awsSecretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
					awsSessionToken:
						"FwoGZXIvYXdzEBYaDEXAMPLESESSIONTOKEN0123456789abcdefABCDEF+/=",
					awsExpiration: "2026-05-10T14:45:14Z",
				},
				ssh: {
					sshConfirmationId: "33333333-3333-4333-8333-333333333333",
					sshIp: "34.246.54.210",
					sshPrivateKey: Buffer.from(
						"-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\nQyNTUxOQAAACBJS4x1c6+gJkj8rF4zeylgs7HpQntB4sa8kc52xcjuyg==\n-----END OPENSSH PRIVATE KEY-----\n",
					).toString("base64"),
					sshPublicKey: Buffer.from(
						"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIElLjHVzr6AmSPysXjN7KWCzselCe0HixryRznbFyO7K ci@tracebit\n",
					).toString("base64"),
					sshExpiration: "2026-05-10T14:45:14.7390578Z",
				},
			}),
		);
		process.env._SECURITY_CREDENTIALS_PATH = credentialsPath;

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

	it("does not throw when credentials file does not exist", async () => {
		vi.useFakeTimers();
		vi.mocked(core.getInput).mockImplementation((name: string) => {
			if (name === "customer-id") return "customerx";
			if (name === "api-token") return "token";
			if (name === "profile") return "tracebit-profile";
			if (name === "profile-region") return "us-east-1";
			if (name === "async") return "true";
			return "";
		});

		process.env._SECURITY_CREDENTIALS_PATH = path.join(
			tempHomeDir,
			"nonexistent.json",
		);

		const promise = run();
		await vi.advanceTimersByTimeAsync(6000);
		await expect(promise).resolves.toBeUndefined();
		expect(core.warning).toHaveBeenCalled();
		vi.useRealTimers();
	});

	it("keeps polling when credentials file is present but not yet fully written", async () => {
		vi.useFakeTimers();
		vi.mocked(core.getInput).mockImplementation((name: string) => {
			if (name === "customer-id") return "customerx";
			if (name === "api-token") return "token";
			if (name === "profile") return "tracebit-profile";
			if (name === "profile-region") return "us-east-1";
			if (name === "async") return "true";
			return "";
		});

		const credentialsPath = path.join(tempHomeDir, "partial.json");
		process.env._SECURITY_CREDENTIALS_PATH = credentialsPath;
		// Simulate the child having created the file but not written it yet
		writeFileSync(credentialsPath, "");

		const promise = run();
		await vi.advanceTimersByTimeAsync(250);
		expect(core.exportVariable).not.toHaveBeenCalled();

		writeFileSync(
			credentialsPath,
			JSON.stringify({
				aws: {
					awsConfirmationId: "22222222-2222-4222-8222-222222222222",
					awsAccessKeyId: "ASIAIOSFODNN7EXAMPLE",
					awsSecretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
					awsSessionToken:
						"FwoGZXIvYXdzEBYaDEXAMPLESESSIONTOKEN0123456789abcdefABCDEF+/=",
					awsExpiration: "2026-05-10T14:45:14Z",
				},
			}),
		);
		await vi.advanceTimersByTimeAsync(250);

		await expect(promise).resolves.toBeUndefined();
		expect(core.setFailed).not.toHaveBeenCalled();
		expect(core.exportVariable).toHaveBeenCalledWith(
			"__AWS__ACCESS_KEY_ID",
			"ASIAIOSFODNN7EXAMPLE",
		);
		vi.useRealTimers();
	});

	it("warns instead of failing when credentials file stays malformed", async () => {
		vi.useFakeTimers();
		vi.mocked(core.getInput).mockImplementation((name: string) => {
			if (name === "customer-id") return "customerx";
			if (name === "api-token") return "token";
			if (name === "profile") return "tracebit-profile";
			if (name === "profile-region") return "us-east-1";
			if (name === "async") return "true";
			return "";
		});

		const credentialsPath = path.join(tempHomeDir, "broken.json");
		process.env._SECURITY_CREDENTIALS_PATH = credentialsPath;
		writeFileSync(credentialsPath, "{not json");

		const promise = run();
		await vi.advanceTimersByTimeAsync(6000);
		await expect(promise).resolves.toBeUndefined();
		expect(core.setFailed).not.toHaveBeenCalled();
		expect(core.warning).toHaveBeenCalled();
		vi.useRealTimers();
	});

	it("stops immediately, without waiting out the timeout, when the hand-off file has nothing usable", async () => {
		vi.useFakeTimers();
		vi.mocked(core.getInput).mockImplementation((name: string) => {
			if (name === "customer-id") return "customerx";
			if (name === "api-token") return "token";
			if (name === "profile") return "tracebit-profile";
			if (name === "profile-region") return "us-east-1";
			if (name === "async") return "true";
			return "";
		});
		const credentialsPath = path.join(tempHomeDir, "bad.json");
		process.env._SECURITY_CREDENTIALS_PATH = credentialsPath;
		writeFileSync(
			credentialsPath,
			JSON.stringify({
				aws: {
					awsConfirmationId: "22222222-2222-4222-8222-222222222222",
					awsAccessKeyId: "ASIAIOSFODNN7EXAMPLE",
					awsSecretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
					awsSessionToken:
						"FwoGZXIvYXdzEBYaDEXAMPLE\n[default]\ncredential_process = x",
					awsExpiration: "2026-05-10T14:45:14Z",
				},
			}),
		);

		const promise = run();
		await vi.advanceTimersByTimeAsync(0);
		await expect(promise).resolves.toBeUndefined();

		expect(core.warning).toHaveBeenCalledWith(
			expect.stringMatching(/Skipping AWS credentials: .*awsSessionToken/),
		);
		expect(core.warning).toHaveBeenCalledWith(
			expect.stringContaining(
				"issued no credentials this action version can use",
			),
		);
		expect(core.exportVariable).not.toHaveBeenCalled();
		expect(core.setSecret).not.toHaveBeenCalled();
		vi.useRealTimers();
	});

	it("fails when profile or region inputs are missing", async () => {
		vi.mocked(core.getInput).mockReturnValue("");

		await expect(run()).resolves.toBeUndefined();
		expect(core.setFailed).toHaveBeenCalled();
		expect(postMock).not.toHaveBeenCalled();
	});

	it("warns instead of failing when the API token is missing (fork PRs)", async () => {
		vi.mocked(core.getInput).mockImplementation((name: string) => {
			if (name === "customer-id") return "customerx";
			if (name === "profile") return "tracebit-profile";
			if (name === "profile-region") return "us-east-1";
			if (name === "async") return "true";
			return "";
		});
		process.env._SECURITY_CREDENTIALS_PATH = path.join(
			tempHomeDir,
			"never-written.json",
		);

		await expect(run()).resolves.toBeUndefined();
		expect(core.setFailed).not.toHaveBeenCalled();
		expect(core.warning).toHaveBeenCalledWith(
			expect.stringContaining("No Tracebit API token"),
		);
		expect(core.exportVariable).not.toHaveBeenCalled();
	});

	it("shows warning when region is invalid", async () => {
		vi.mocked(core.getInput).mockImplementation((name: string) => {
			if (name === "customer-id") return "customerx";
			if (name === "api-token") return "token";
			if (name === "profile") return "tracebit-profile";
			if (name === "profile-region") return "not-a-region";
			return "";
		});

		await expect(run()).resolves.toBeUndefined();
		expect(core.warning).toHaveBeenCalled();
	});

	it("doesn't show warning when region is correct", async () => {
		vi.mocked(core.getInput).mockImplementation((name: string) => {
			if (name === "customer-id") return "customerx";
			if (name === "api-token") return "token";
			if (name === "profile") return "tracebit-profile";
			if (name === "profile-region") return "eu-west-2";
			return "";
		});

		await expect(run()).resolves.toBeUndefined();
		expect(core.warning).not.toHaveBeenCalled();
	});
});

describe("isValidRegion", () => {
	it("accepts common AWS region formats", () => {
		expect(isValidRegion("us-east-1")).toBe(true);
		expect(isValidRegion("eu-west-1")).toBe(true);
		expect(isValidRegion("us-gov-west-1")).toBe(true); // Test GovCloud
		expect(isValidRegion("eusc-de-east-1")).toBe(true); // Test European Sovereign Cloud
	});

	it("rejects invalid region formats", () => {
		expect(isValidRegion("us_east_1")).toBe(false);
		expect(isValidRegion("us-east")).toBe(false);
	});
});

describe("isValidProfileName", () => {
	it("accepts valid profile names", () => {
		expect(isValidProfileName("default")).toBe(true);
		expect(isValidProfileName("administrator")).toBe(true);
		expect(isValidProfileName("my-profile")).toBe(true);
		expect(isValidProfileName("my_profile")).toBe(true);
		expect(isValidProfileName("Profile123")).toBe(true);
	});

	it("rejects profile names with INI injection characters", () => {
		expect(isValidProfileName("profile]\naws_access_key_id=AKIA")).toBe(false);
		expect(isValidProfileName("[injected")).toBe(false);
		expect(isValidProfileName("profile name")).toBe(false);
		expect(isValidProfileName("profile/name")).toBe(false);
		expect(isValidProfileName("")).toBe(false);
	});
});

describe("isValidCustomerId", () => {
	it("accepts valid customer IDs", () => {
		expect(isValidCustomerId("community")).toBe(true);
		expect(isValidCustomerId("my-org")).toBe(true);
		expect(isValidCustomerId("abc123")).toBe(true);
	});

	it("rejects customer IDs that could cause SSRF", () => {
		expect(isValidCustomerId("evil.com/x?")).toBe(false);
		expect(isValidCustomerId("evil.com")).toBe(false);
		expect(isValidCustomerId("foo@bar")).toBe(false);
		expect(isValidCustomerId("foo/bar")).toBe(false);
		expect(isValidCustomerId("UPPERCASE")).toBe(false);
		expect(isValidCustomerId("")).toBe(false);
	});
});

describe("isValidApiHost", () => {
	it("accepts valid hostnames", () => {
		expect(isValidApiHost("tracebit.com")).toBe(true);
		expect(isValidApiHost("api.tracebit.com")).toBe(true);
		expect(isValidApiHost("staging.tracebit.io")).toBe(true);
		expect(isValidApiHost("localhost")).toBe(true);
	});

	it("rejects hostnames with path traversal or injection", () => {
		expect(isValidApiHost("evil.com/path")).toBe(false);
		expect(isValidApiHost("evil.com:8080")).toBe(false);
		expect(isValidApiHost("evil.com@tracebit.com")).toBe(false);
		expect(isValidApiHost("-evil.com")).toBe(false);
		expect(isValidApiHost("evil..com")).toBe(false);
		expect(isValidApiHost("")).toBe(false);
	});
});
