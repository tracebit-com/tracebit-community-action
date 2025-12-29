import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@actions/core", () => ({
	getInput: vi.fn(),
	setOutput: vi.fn(),
	setSecret: vi.fn(),
	exportVariable: vi.fn(),
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

import * as core from "@actions/core";
import * as exec from "@actions/exec";
import { run } from "../index";

const originalEnv = process.env;

describe("action run", () => {
	beforeEach(() => {
		process.env = { ...originalEnv };
		vi.resetAllMocks();
		vi.mocked(exec.exec).mockResolvedValue(0);
		postMock.mockReset();
		githubContext.ref = "";
		githubContext.repo = { owner: "", repo: "" };
		githubContext.runId = undefined;
		githubContext.sha = "";
		githubContext.workflow = "";
		githubContext.job = "";
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	it("does not throw when issuing credentials fails", async () => {
		vi.mocked(core.getInput).mockImplementation((name: string) => {
			if (name === "customer-id") return "customerx";
			if (name === "api-token") return "token";
			return "";
		});

		postMock.mockResolvedValueOnce({
			message: { statusCode: 500 },
			readBody: async () => "issue failed",
		});

		await expect(run()).resolves.toBeUndefined();
		expect(core.error).toHaveBeenCalled();
		expect(postMock).toHaveBeenCalledTimes(1);
	});

	it("includes GitHub labels in the issue payload", async () => {
		githubContext.ref = "refs/tags/v1.2.3";
		githubContext.repo = { owner: "org", repo: "repo" };
		githubContext.runId = 123;
		githubContext.sha = "deadbeef";
		githubContext.workflow = "workflow";
		githubContext.job = "job";

		vi.mocked(core.getInput).mockImplementation((name: string) => {
			if (name === "customer-id") return "customerx";
			if (name === "api-token") return "token";
			return "";
		});

		postMock
			.mockResolvedValueOnce({
				message: { statusCode: 200 },
				readBody: async () =>
					JSON.stringify({
						aws: {
							awsConfirmationId: "confirm",
							awsAccessKeyId: "access",
							awsSecretAccessKey: "secret",
							awsSessionToken: "token",
						},
					}),
			})
			.mockResolvedValueOnce({
				message: { statusCode: 200 },
				readBody: async () => "",
			});

		await run();

		expect(postMock.mock.calls[0]?.[0]).toBe(
			"https://customerx.stage.tracebit.com/api/v1/credentials/issue-credentials",
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
		expect(core.setOutput).toHaveBeenCalledWith(
			"profile-name",
			expect.stringMatching(/^administrator-[A-Za-z0-9]{7}$/),
		);
	});

	it("does not throw when confirmation fails", async () => {
		vi.mocked(core.getInput).mockImplementation((name: string) => {
			if (name === "customer-id") return "customerx";
			if (name === "api-token") return "token";
			return "";
		});

		postMock
			.mockResolvedValueOnce({
				message: { statusCode: 200 },
				readBody: async () =>
					JSON.stringify({
						aws: {
							awsConfirmationId: "confirm",
							awsAccessKeyId: "access",
							awsSecretAccessKey: "secret",
							awsSessionToken: "token",
						},
					}),
			})
			.mockResolvedValueOnce({
				message: { statusCode: 500 },
				readBody: async () => "confirm failed",
			});

		await expect(run()).resolves.toBeUndefined();
		expect(core.error).toHaveBeenCalled();
	});

	it("does not throw when required inputs are missing", async () => {
		vi.mocked(core.getInput).mockReturnValue("");

		await expect(run()).resolves.toBeUndefined();
		expect(core.warning).toHaveBeenCalled();
		expect(postMock).not.toHaveBeenCalled();
	});
});
