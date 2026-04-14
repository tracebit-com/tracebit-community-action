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
		await vi.advanceTimersByTimeAsync(3000);
		await expect(promise).resolves.toBeUndefined();
		expect(core.warning).toHaveBeenCalled();
		vi.useRealTimers();
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
					awsConfirmationId: "confirm",
					awsAccessKeyId: "access",
					awsSecretAccessKey: "secret",
					awsSessionToken: "token",
				},
				ssh: {
					sshConfirmationId: "ssh-confirm",
					sshIp: "34.246.54.210",
					sshPrivateKey: Buffer.from("fake-private").toString("base64"),
					sshPublicKey: Buffer.from("fake-public").toString("base64"),
					sshExpiration: "2026-05-10T14:45:14.7390578Z",
				},
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
		await vi.advanceTimersByTimeAsync(3000);
		await expect(promise).resolves.toBeUndefined();
		expect(core.warning).toHaveBeenCalled();
		vi.useRealTimers();
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
