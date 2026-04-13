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

import * as core from "@actions/core";
import { run } from "../post";

const originalEnv = process.env;
let tempDir = "";

describe("post step", () => {
	beforeEach(() => {
		tempDir = mkdtempSync(
			path.join(os.tmpdir(), "tracebit-github-action-post-test-"),
		);
		vi.resetAllMocks();
		process.env = { ...originalEnv };
	});

	afterEach(async () => {
		process.env = originalEnv;
		if (tempDir) {
			await rm(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	it("does nothing when credentials path is not set", async () => {
		process.env._SECURITY_CREDENTIALS_PATH = undefined;

		await expect(run()).resolves.toBeUndefined();
		expect(core.warning).not.toHaveBeenCalled();
	});

	it("does nothing when no error file exists", async () => {
		const credentialsPath = path.join(tempDir, "credentials.json");
		process.env._SECURITY_CREDENTIALS_PATH = credentialsPath;

		await expect(run()).resolves.toBeUndefined();
		expect(core.warning).not.toHaveBeenCalled();
	});

	it("reports error when error file exists", async () => {
		const credentialsPath = path.join(tempDir, "credentials.json");
		const errorPath = `${credentialsPath}.error`;
		writeFileSync(errorPath, "Issue credentials failed: something went wrong");
		process.env._SECURITY_CREDENTIALS_PATH = credentialsPath;

		await run();

		expect(core.warning).toHaveBeenCalledWith(
			"Issue credentials failed: something went wrong",
		);
	});
});
