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

import { existsSync, readFileSync } from "node:fs";
import * as core from "@actions/core";
import { run } from "../run-async";

const originalEnv = process.env;
let tempHomeDir = "";
let credentialsPath = "";
let errorPath = "";

const defaultInputs = (name: string): string => {
	if (name === "customer-id") return "customerx";
	if (name === "api-token") return "token";
	if (name === "profile") return "tracebit-profile";
	if (name === "profile-region") return "us-east-1";
	return "";
};

const awsCreds = {
	awsConfirmationId: "aws-confirm-id",
	awsAccessKeyId: "access-key",
	awsSecretAccessKey: "secret-key",
	awsSessionToken: "session-token",
};

const sshCreds = {
	sshConfirmationId: "ssh-confirm-id",
	sshIp: "34.246.54.210",
	sshPrivateKey: Buffer.from("fake-ssh-private-key").toString("base64"),
	sshPublicKey: Buffer.from("fake-ssh-public-key").toString("base64"),
	sshExpiration: "2026-05-10T14:45:14.7390578Z",
};

const _httpCreds = {
	npm: {
		confirmationId: "npm-confirm-id",
		browserDeploymentId: "npm-browser-deploy-id",
		hostNames: ["npm.example.com"],
		expiresAt: null,
		credentials: { strategy: "npm-token", token: "npm-auth-token" },
	},
};

const issuedResponse = (
	body: Record<string, unknown>,
	statusCode = 200,
): {
	message: { statusCode: number };
	readBody: () => Promise<string>;
} => ({
	message: { statusCode },
	readBody: async () => JSON.stringify(body),
});

const confirmOk = {
	message: { statusCode: 200 },
	readBody: async () => "",
};

const confirmFail = {
	message: { statusCode: 500 },
	readBody: async () => "confirm failed",
};

describe("run-async", () => {
	beforeEach(() => {
		tempHomeDir = mkdtempSync(
			path.join(os.tmpdir(), "tracebit-github-action-run-async-test-"),
		);
		credentialsPath = path.join(tempHomeDir, "credentials.json");
		errorPath = `${credentialsPath}.error`;

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
			CREDENTIALS_PATH: credentialsPath,
		};
		vi.mocked(os.homedir).mockReturnValue(tempHomeDir);
		vi.mocked(core.getInput).mockImplementation(defaultInputs);
		postMock.mockReset();
	});

	afterEach(async () => {
		process.env = originalEnv;
		if (tempHomeDir) {
			await rm(tempHomeDir, { recursive: true, force: true });
			tempHomeDir = "";
		}
	});

	it("does nothing when CREDENTIALS_PATH is not set", async () => {
		process.env.CREDENTIALS_PATH = undefined;

		await expect(run()).resolves.toBeUndefined();
		expect(core.warning).toHaveBeenCalledWith("CREDENTIALS_PATH is not set");
		expect(existsSync(errorPath)).toBe(false);
	});

	it("does not create an error file on full success", async () => {
		postMock
			.mockResolvedValueOnce(issuedResponse({ aws: awsCreds, ssh: sshCreds }))
			.mockResolvedValueOnce(confirmOk)
			.mockResolvedValueOnce(confirmOk);

		await run();

		expect(existsSync(credentialsPath)).toBe(true);
		expect(existsSync(errorPath)).toBe(false);
	});

	it("writes a single error entry when issuing credentials fails", async () => {
		postMock.mockResolvedValueOnce({
			message: { statusCode: 500 },
			readBody: async () => "issue failed",
		});

		await run();

		expect(existsSync(errorPath)).toBe(true);
		const contents = readFileSync(errorPath, "utf8");
		expect(contents).toMatch(/Issue credentials failed/);
		expect(contents.endsWith("\n")).toBe(true);
	});

	it("appends multiple error entries instead of overwriting", async () => {
		// Two confirmations fail → two appended entries
		postMock
			.mockResolvedValueOnce(issuedResponse({ aws: awsCreds, ssh: sshCreds }))
			.mockResolvedValueOnce(confirmFail)
			.mockResolvedValueOnce(confirmFail);

		await run();

		expect(existsSync(errorPath)).toBe(true);
		const contents = readFileSync(errorPath, "utf8");
		const entries = contents.split("\n").filter((line) => line.length > 0);
		expect(entries).toHaveLength(2);
		expect(entries[0]).toMatch(/Confirm credentials failed/);
		expect(entries[1]).toMatch(/Confirm credentials failed/);
	});

	it("accumulates errors across http instances rather than clobbering", async () => {
		// Two http instances, both with empty hostNames → both deploy() calls throw,
		// both should be persisted in errorPath
		const httpTwoBroken = {
			npm: {
				confirmationId: "npm-confirm-id-1",
				browserDeploymentId: "npm-browser-deploy-id-1",
				hostNames: [] as string[],
				expiresAt: null,
				credentials: { strategy: "npm-token", token: "t1" },
			},
			pypi: {
				confirmationId: "npm-confirm-id-2",
				browserDeploymentId: "npm-browser-deploy-id-2",
				hostNames: [] as string[],
				expiresAt: null,
				credentials: { strategy: "npm-token", token: "t2" },
			},
		};

		postMock
			.mockResolvedValueOnce(issuedResponse({ http: httpTwoBroken }))
			// 2 confirmation calls (one per http instance) — both succeed so they
			// don't add extra error entries
			.mockResolvedValueOnce(confirmOk)
			.mockResolvedValueOnce(confirmOk);

		await run();

		expect(existsSync(errorPath)).toBe(true);
		const contents = readFileSync(errorPath, "utf8");
		const entries = contents.split("\n").filter((line) => line.length > 0);
		expect(entries).toHaveLength(2);
		expect(entries[0]).toMatch(
			/Deploying HTTP credentials for instance npm failed/,
		);
		expect(entries[1]).toMatch(
			/Deploying HTTP credentials for instance pypi failed/,
		);
	});
});
