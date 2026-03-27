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
			expect(core.error).toHaveBeenCalled();
			expect(postMock).toHaveBeenCalledTimes(1);
		});

		it("does not throw when confirmation fails", async () => {
			vi.mocked(core.getInput).mockImplementation(defaultInputs);
			postMock
				.mockResolvedValueOnce(issuedCredentialsResponse)
				.mockResolvedValueOnce({
					message: { statusCode: 500 },
					readBody: async () => "confirm failed",
				});

			await expect(run()).resolves.toBeUndefined();
			expect(core.error).toHaveBeenCalled();
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
				.mockResolvedValueOnce(confirmResponse);

			await run();

			expect(core.setSecret).toHaveBeenCalledWith("access-key");
			expect(core.setSecret).toHaveBeenCalledWith("secret-key");
			expect(core.setSecret).toHaveBeenCalledWith("session-token");
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
			expect(core.exportVariable).toHaveBeenCalledWith(
				"__AWS__ACCESS_KEY_ID",
				"access-key",
			);
			expect(core.exportVariable).toHaveBeenCalledWith(
				"__AWS__REGION",
				"us-east-1",
			);
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
			expect(core.error).toHaveBeenCalled();
			expect(core.exportVariable).not.toHaveBeenCalled();
		});
	});
});
