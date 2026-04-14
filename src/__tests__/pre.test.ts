import { mkdtempSync } from "node:fs";
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

vi.mock("@actions/exec", () => ({
	exec: vi.fn(),
}));

const postMock = vi.hoisted(() => vi.fn());

vi.mock("@actions/http-client", () => ({
	HttpClient: class {
		post = postMock;
	},
}));

const githubContext = vi.hoisted(() => ({
	ref: "",
	repo: { owner: "", repo: "" },
	runId: undefined as number | undefined,
	sha: "",
	workflow: "",
	job: "",
}));

vi.mock("@actions/github", () => ({
	context: githubContext,
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

import { readFileSync, statSync } from "node:fs";
import * as core from "@actions/core";
import * as exec from "@actions/exec";
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

const sshPrivateKeyBase64 = Buffer.from("fake-ssh-private-key").toString(
	"base64",
);
const sshPublicKeyBase64 = Buffer.from("fake-ssh-public-key").toString(
	"base64",
);

const issuedCredentialsResponse = {
	message: { statusCode: 200 },
	readBody: async () =>
		JSON.stringify({
			aws: {
				awsConfirmationId: "confirm-id",
				awsAccessKeyId: "access-key",
				awsSecretAccessKey: "secret-key",
				awsSessionToken: "session-token",
			},
			ssh: {
				sshConfirmationId: "ssh-confirm-id",
				sshIp: "34.246.54.210",
				sshPrivateKey: sshPrivateKeyBase64,
				sshPublicKey: sshPublicKeyBase64,
				sshExpiration: "2026-05-10T14:45:14.7390578Z",
			},
		}),
};

const confirmResponse = {
	message: { statusCode: 200 },
	readBody: async () => "",
};

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
		vi.mocked(exec.exec).mockResolvedValue(0);
		postMock.mockReset();
		githubContext.ref = "";
		githubContext.repo = { owner: "", repo: "" };
		githubContext.runId = undefined;
		githubContext.sha = "";
		githubContext.workflow = "";
		githubContext.job = "";
	});

	afterEach(async () => {
		process.env = originalEnv;
		if (tempHomeDir) {
			await rm(tempHomeDir, { recursive: true, force: true });
			tempHomeDir = "";
		}
	});

	describe("sync mode", () => {
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

		it("includes GitHub labels in the issue payload", async () => {
			githubContext.ref = "refs/tags/v1.2.3";
			githubContext.repo = { owner: "org", repo: "repo" };
			githubContext.runId = 123;
			githubContext.sha = "deadbeef";
			githubContext.workflow = "workflow";
			githubContext.job = "job";

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
				"access-key",
			);
			expect(core.exportVariable).toHaveBeenCalledWith(
				"__AWS__SECRET_ACCESS_KEY",
				"secret-key",
			);
			expect(core.exportVariable).toHaveBeenCalledWith(
				"__AWS__SESSION_TOKEN",
				"session-token",
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
				'"ACCESS_KEY_ID_SECRET":{"value":"access-key","isSecret":true}',
			);
			expect(core.exportVariable).toHaveBeenCalledWith(
				"__AWS__SECRET_ACCESS_KEY_SECRET",
				'"SECRET_ACCESS_KEY_SECRET":{"value":"secret-key","isSecret":true}',
			);
			expect(core.exportVariable).toHaveBeenCalledWith(
				"__AWS__SESSION_TOKEN_SECRET",
				'"SESSION_TOKEN_SECRET":{"value":"session-token","isSecret":true}',
			);

			// setOutput: plain credentials
			expect(core.setOutput).toHaveBeenCalledWith(
				"aws-access-key-id",
				"access-key",
			);
			expect(core.setOutput).toHaveBeenCalledWith(
				"aws-secret-access-key",
				"secret-key",
			);
			expect(core.setOutput).toHaveBeenCalledWith(
				"aws-session-token",
				"session-token",
			);
			expect(core.setOutput).toHaveBeenCalledWith(
				"profile-name",
				"tracebit-profile",
			);

			// setOutput: JSON secret format
			expect(core.setOutput).toHaveBeenCalledWith(
				"aws-access-key-id-secret",
				'"ACCESS_KEY_ID_SECRET":{"value":"access-key","isSecret":true}',
			);
			expect(core.setOutput).toHaveBeenCalledWith(
				"aws-secret-access-key-secret",
				'"SECRET_ACCESS_KEY_SECRET":{"value":"secret-key","isSecret":true}',
			);
			expect(core.setOutput).toHaveBeenCalledWith(
				"aws-session-token-secret",
				'"SESSION_TOKEN_SECRET":{"value":"session-token","isSecret":true}',
			);

			// saveState: plain credentials
			expect(core.saveState).toHaveBeenCalledWith(
				"aws-access-key-id",
				"access-key",
			);
			expect(core.saveState).toHaveBeenCalledWith(
				"aws-secret-access-key",
				"secret-key",
			);
			expect(core.saveState).toHaveBeenCalledWith(
				"aws-session-token",
				"session-token",
			);
			expect(core.saveState).toHaveBeenCalledWith(
				"profile-name",
				"tracebit-profile",
			);

			// saveState: JSON secret format
			expect(core.saveState).toHaveBeenCalledWith(
				"aws-access-key-id-secret",
				'"ACCESS_KEY_ID_SECRET":{"value":"access-key","isSecret":true}',
			);
			expect(core.saveState).toHaveBeenCalledWith(
				"aws-secret-access-key-secret",
				'"SECRET_ACCESS_KEY_SECRET":{"value":"secret-key","isSecret":true}',
			);
			expect(core.saveState).toHaveBeenCalledWith(
				"aws-session-token-secret",
				'"SESSION_TOKEN_SECRET":{"value":"session-token","isSecret":true}',
			);

			// setSecret: plain credentials
			expect(core.setSecret).toHaveBeenCalledWith("access-key");
			expect(core.setSecret).toHaveBeenCalledWith("secret-key");
			expect(core.setSecret).toHaveBeenCalledWith("session-token");

			// setSecret: JSON secret format
			expect(core.setSecret).toHaveBeenCalledWith(
				'"ACCESS_KEY_ID_SECRET":{"value":"access-key","isSecret":true}',
			);
			expect(core.setSecret).toHaveBeenCalledWith(
				'"SECRET_ACCESS_KEY_SECRET":{"value":"secret-key","isSecret":true}',
			);
			expect(core.setSecret).toHaveBeenCalledWith(
				'"SESSION_TOKEN_SECRET":{"value":"session-token","isSecret":true}',
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

			expect(readFileSync(privateKeyPath, "utf8")).toBe("fake-ssh-private-key");
			expect(readFileSync(publicKeyPath, "utf8")).toBe("fake-ssh-public-key");

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
			expect(core.setSecret).toHaveBeenCalledWith("fake-ssh-private-key");
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
