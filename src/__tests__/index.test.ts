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

import * as core from "@actions/core";
import * as exec from "@actions/exec";
import { run } from "../index";
import { isValidRegion } from "../inputs";

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

	it("does not throw when credentials path env var is not set", async () => {
		vi.mocked(core.getInput).mockImplementation((name: string) => {
			if (name === "customer-id") return "customerx";
			if (name === "api-token") return "token";
			if (name === "profile") return "tracebit-profile";
			if (name === "profile-region") return "us-east-1";
			if (name === "async") return "true";
			return "";
		});

		process.env._SECURITY_CREDENTIALS_PATH = undefined;

		await expect(run()).resolves.toBeUndefined();
		expect(core.error).toHaveBeenCalled();
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
				confirmationId: "confirm",
				accessKeyId: "access",
				secretAccessKey: "secret",
				sessionToken: "token",
			}),
		);
		process.env._SECURITY_CREDENTIALS_PATH = credentialsPath;

		await run();

		// exportVariable: plain credentials
		expect(core.exportVariable).toHaveBeenCalledWith(
			"__AWS__ACCESS_KEY_ID",
			"access",
		);
		expect(core.exportVariable).toHaveBeenCalledWith(
			"__AWS__SECRET_ACCESS_KEY",
			"secret",
		);
		expect(core.exportVariable).toHaveBeenCalledWith(
			"__AWS__SESSION_TOKEN",
			"token",
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
			'"ACCESS_KEY_ID_SECRET":{"value":"access","isSecret":true}',
		);
		expect(core.exportVariable).toHaveBeenCalledWith(
			"__AWS__SECRET_ACCESS_KEY_SECRET",
			'"SECRET_ACCESS_KEY_SECRET":{"value":"secret","isSecret":true}',
		);
		expect(core.exportVariable).toHaveBeenCalledWith(
			"__AWS__SESSION_TOKEN_SECRET",
			'"SESSION_TOKEN_SECRET":{"value":"token","isSecret":true}',
		);

		// setOutput: plain credentials
		expect(core.setOutput).toHaveBeenCalledWith("aws-access-key-id", "access");
		expect(core.setOutput).toHaveBeenCalledWith(
			"aws-secret-access-key",
			"secret",
		);
		expect(core.setOutput).toHaveBeenCalledWith("aws-session-token", "token");
		expect(core.setOutput).toHaveBeenCalledWith(
			"profile-name",
			"tracebit-profile",
		);

		// setOutput: JSON secret format
		expect(core.setOutput).toHaveBeenCalledWith(
			"aws-access-key-id-secret",
			'"ACCESS_KEY_ID_SECRET":{"value":"access","isSecret":true}',
		);
		expect(core.setOutput).toHaveBeenCalledWith(
			"aws-secret-access-key-secret",
			'"SECRET_ACCESS_KEY_SECRET":{"value":"secret","isSecret":true}',
		);
		expect(core.setOutput).toHaveBeenCalledWith(
			"aws-session-token-secret",
			'"SESSION_TOKEN_SECRET":{"value":"token","isSecret":true}',
		);

		// saveState: plain credentials
		expect(core.saveState).toHaveBeenCalledWith("aws-access-key-id", "access");
		expect(core.saveState).toHaveBeenCalledWith(
			"aws-secret-access-key",
			"secret",
		);
		expect(core.saveState).toHaveBeenCalledWith("aws-session-token", "token");
		expect(core.saveState).toHaveBeenCalledWith(
			"profile-name",
			"tracebit-profile",
		);

		// saveState: JSON secret format
		expect(core.saveState).toHaveBeenCalledWith(
			"aws-access-key-id-secret",
			'"ACCESS_KEY_ID_SECRET":{"value":"access","isSecret":true}',
		);
		expect(core.saveState).toHaveBeenCalledWith(
			"aws-secret-access-key-secret",
			'"SECRET_ACCESS_KEY_SECRET":{"value":"secret","isSecret":true}',
		);
		expect(core.saveState).toHaveBeenCalledWith(
			"aws-session-token-secret",
			'"SESSION_TOKEN_SECRET":{"value":"token","isSecret":true}',
		);

		// setSecret: plain credentials
		expect(core.setSecret).toHaveBeenCalledWith("access");
		expect(core.setSecret).toHaveBeenCalledWith("secret");
		expect(core.setSecret).toHaveBeenCalledWith("token");

		// setSecret: JSON secret format
		expect(core.setSecret).toHaveBeenCalledWith(
			'"ACCESS_KEY_ID_SECRET":{"value":"access","isSecret":true}',
		);
		expect(core.setSecret).toHaveBeenCalledWith(
			'"SECRET_ACCESS_KEY_SECRET":{"value":"secret","isSecret":true}',
		);
		expect(core.setSecret).toHaveBeenCalledWith(
			'"SESSION_TOKEN_SECRET":{"value":"token","isSecret":true}',
		);
	});

	it("does not throw when credentials file does not exist", async () => {
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

		await expect(run()).resolves.toBeUndefined();
		expect(core.error).toHaveBeenCalled();
	});

	it("does not throw when required inputs are missing", async () => {
		vi.mocked(core.getInput).mockReturnValue("");

		await expect(run()).resolves.toBeUndefined();
		expect(core.setFailed).toHaveBeenCalled();
		expect(postMock).not.toHaveBeenCalled();
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
