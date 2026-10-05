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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
	sshPrivateKey: Buffer.from(
		"-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\nQyNTUxOQAAACBJS4x1c6+gJkj8rF4zeylgs7HpQntB4sa8kc52xcjuyg==\n-----END OPENSSH PRIVATE KEY-----\n",
	).toString("base64"),
	sshPublicKey: Buffer.from(
		"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIElLjHVzr6AmSPysXjN7KWCzselCe0HixryRznbFyO7K ci@tracebit\n",
	).toString("base64"),
	sshExpiration: "2026-05-10T14:45:14.7390578Z",
};

const _httpCreds = {
	npm: {
		confirmationId: "44444444-4444-4444-8444-444444444444",
		browserDeploymentId: "55555555-5555-4555-8555-555555555555",
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

const confirmedIds = (): string[] =>
	postMock.mock.calls
		.filter((call) => String(call[0]).includes("confirm-credentials"))
		.map((call) => (JSON.parse(String(call[1])) as { id: string }).id);

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
		getMock.mockReset();
		getMock.mockResolvedValue({
			message: { statusCode: 200 },
			readBody: async () => "{}",
		});
	});

	afterEach(async () => {
		process.env = originalEnv;
		if (tempHomeDir) {
			await rm(tempHomeDir, { recursive: true, force: true });
			tempHomeDir = "";
		}
	});

	it("warns and writes nothing when the API token is missing", async () => {
		vi.mocked(core.getInput).mockImplementation((name: string) =>
			name === "api-token" ? "" : defaultInputs(name),
		);

		await run();

		expect(postMock).not.toHaveBeenCalled();
		expect(existsSync(credentialsPath)).toBe(false);
		expect(existsSync(errorPath)).toBe(false);
		expect(core.warning).toHaveBeenCalledWith(
			expect.stringContaining("No Tracebit API token"),
		);
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

	it("writes the hand-off file only after deploys and confirmations", async () => {
		// Observe the filesystem at the moment confirm-credentials is called:
		// the canary files must exist and the hand-off file must not yet.
		let seenAtConfirm: { aws: boolean; handoff: boolean } | undefined;
		postMock
			.mockResolvedValueOnce(issuedResponse({ aws: awsCreds }))
			.mockImplementationOnce(async () => {
				seenAtConfirm = {
					aws: existsSync(path.join(tempHomeDir, ".aws", "credentials")),
					handoff: existsSync(credentialsPath),
				};
				return confirmOk;
			});

		await run();

		expect(seenAtConfirm).toEqual({ aws: true, handoff: false });
		expect(existsSync(credentialsPath)).toBe(true);
	});

	it("still writes the hand-off file when a deploy fails", async () => {
		writeFileSync(path.join(tempHomeDir, ".ssh"), "not a directory");
		postMock
			.mockResolvedValueOnce(issuedResponse({ aws: awsCreds, ssh: sshCreds }))
			.mockResolvedValue(confirmOk);

		await run();

		expect(existsSync(credentialsPath)).toBe(true);
		expect(readFileSync(errorPath, "utf8")).toMatch(
			/Write SSH credentials failed/,
		);
	});

	it("does not export or mask anything itself; the main step does that", async () => {
		postMock
			.mockResolvedValueOnce(issuedResponse({ http: _httpCreds }))
			.mockResolvedValue(confirmOk);

		await run();

		expect(core.exportVariable).not.toHaveBeenCalled();
		expect(core.setOutput).not.toHaveBeenCalled();
	});

	it("writes credentials atomically and leaves no temp file behind", async () => {
		postMock
			.mockResolvedValueOnce(issuedResponse({ aws: awsCreds }))
			.mockResolvedValueOnce(confirmOk);

		await run();

		expect(existsSync(credentialsPath)).toBe(true);
		expect(existsSync(`${credentialsPath}.tmp`)).toBe(false);
		expect(JSON.parse(readFileSync(credentialsPath, "utf8"))).toEqual({
			aws: awsCreds,
		});
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
				confirmationId: "88888888-8888-4888-8888-888888888881",
				browserDeploymentId: "88888888-8888-4888-8888-888888888891",
				hostNames: [] as string[],
				expiresAt: null,
				credentials: { strategy: "npm-token", token: "t1" },
			},
			pypi: {
				confirmationId: "88888888-8888-4888-8888-888888888882",
				browserDeploymentId: "88888888-8888-4888-8888-888888888892",
				hostNames: [] as string[],
				expiresAt: null,
				credentials: { strategy: "npm-token", token: "t2" },
			},
		};

		postMock
			.mockResolvedValueOnce(issuedResponse({ http: httpTwoBroken }))
			.mockResolvedValue(confirmOk);

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

	describe("confirmation of planted credentials", () => {
		const httpCreds = {
			npm: {
				confirmationId: "44444444-4444-4444-8444-444444444444",
				browserDeploymentId: "55555555-5555-4555-8555-555555555555",
				hostNames: ["npm.example.com"],
				expiresAt: null,
				credentials: { strategy: "npm-token", token: "npm-auth-token" },
			},
		};

		it("confirms all credentials when every deploy succeeds", async () => {
			postMock
				.mockResolvedValueOnce(
					issuedResponse({ aws: awsCreds, ssh: sshCreds, http: httpCreds }),
				)
				.mockResolvedValue(confirmOk);

			await run();

			expect(confirmedIds().sort()).toEqual([
				"22222222-2222-4222-8222-222222222222",
				"33333333-3333-4333-8333-333333333333",
				"44444444-4444-4444-8444-444444444444",
			]);
			expect(existsSync(errorPath)).toBe(false);
		});

		it("skips malformed SSH credentials and still deploys and confirms AWS", async () => {
			postMock
				.mockResolvedValueOnce(
					issuedResponse({
						aws: awsCreds,
						ssh: { ...sshCreds, sshIp: "not-an-ip" },
					}),
				)
				.mockResolvedValue(confirmOk);

			await run();

			expect(confirmedIds()).toEqual(["22222222-2222-4222-8222-222222222222"]);
			expect(existsSync(credentialsPath)).toBe(true);
			expect(JSON.parse(readFileSync(credentialsPath, "utf8"))).toEqual({
				aws: awsCreds,
			});
			expect(existsSync(errorPath)).toBe(false);
			expect(core.warning).toHaveBeenCalledWith(
				expect.stringMatching(/Skipping SSH credentials: .*sshIp/),
			);
		});

		it("does not confirm SSH credentials when the SSH deploy fails", async () => {
			// Occupy ~/.ssh with a regular file so mkdir fails
			writeFileSync(path.join(tempHomeDir, ".ssh"), "not a directory");

			postMock
				.mockResolvedValueOnce(issuedResponse({ aws: awsCreds, ssh: sshCreds }))
				.mockResolvedValue(confirmOk);

			await run();

			expect(confirmedIds()).toEqual(["22222222-2222-4222-8222-222222222222"]);
			const contents = readFileSync(errorPath, "utf8");
			expect(contents).toMatch(/Write SSH credentials failed/);
		});

		it("overwrites an existing SSH key and confirms it", async () => {
			const sshDir = path.join(tempHomeDir, ".ssh");
			mkdirSync(sshDir, { recursive: true });
			writeFileSync(path.join(sshDir, "prod_deploy"), "stale");

			postMock
				.mockResolvedValueOnce(issuedResponse({ aws: awsCreds, ssh: sshCreds }))
				.mockResolvedValue(confirmOk);

			await run();

			expect(confirmedIds().sort()).toEqual([
				"22222222-2222-4222-8222-222222222222",
				"33333333-3333-4333-8333-333333333333",
			]);
			expect(readFileSync(path.join(sshDir, "prod_deploy"), "utf8")).not.toBe(
				"stale",
			);
			expect(existsSync(errorPath)).toBe(false);
		});

		it("does not confirm AWS credentials when writing the profile fails", async () => {
			// Point the credentials file at a directory so the write fails
			process.env.AWS_SHARED_CREDENTIALS_FILE = tempHomeDir;

			postMock
				.mockResolvedValueOnce(issuedResponse({ aws: awsCreds, ssh: sshCreds }))
				.mockResolvedValue(confirmOk);

			await run();

			expect(confirmedIds()).toEqual(["33333333-3333-4333-8333-333333333333"]);
			const contents = readFileSync(errorPath, "utf8");
			expect(contents).toMatch(/Write profile failed/);
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
				.mockResolvedValue(confirmOk);

			await run();

			expect(confirmedIds()).toEqual(["44444444-4444-4444-8444-444444444444"]);
			const contents = readFileSync(errorPath, "utf8");
			expect(contents).toMatch(
				/Deploying HTTP credentials for instance pypi failed/,
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
				.mockResolvedValue(confirmOk);

			await run();

			expect(confirmedIds()).toEqual([]);
		});
	});
});
