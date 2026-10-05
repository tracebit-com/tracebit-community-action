import {
	existsSync,
	mkdtempSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@actions/core", () => ({
	getInput: vi.fn(),
	getState: vi.fn(),
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

	it("removes the async hand-off files but nothing else", async () => {
		const credentialsPath = path.join(tempDir, "credentials.json");
		const canary = path.join(tempDir, ".npmrc");
		writeFileSync(canary, "//npm.example.com/:_authToken=x\n");
		writeFileSync(credentialsPath, "{}");
		writeFileSync(`${credentialsPath}.tmp`, "{");
		writeFileSync(`${credentialsPath}.error`, "Write SSH credentials failed");
		process.env._SECURITY_CREDENTIALS_PATH = credentialsPath;

		await run();

		expect(core.warning).toHaveBeenCalledWith("Write SSH credentials failed");
		expect(existsSync(credentialsPath)).toBe(false);
		expect(existsSync(`${credentialsPath}.tmp`)).toBe(false);
		expect(existsSync(`${credentialsPath}.error`)).toBe(false);
		expect(existsSync(canary)).toBe(true);
	});

	it("does not follow a symlink at the credentials path", async () => {
		const target = path.join(tempDir, "target");
		const credentialsPath = path.join(tempDir, "credentials.json");
		writeFileSync(target, "keep");
		symlinkSync(target, credentialsPath);
		process.env._SECURITY_CREDENTIALS_PATH = credentialsPath;

		await run();

		expect(readFileSync(target, "utf8")).toBe("keep");
	});

	it("kills the background worker recorded in state, tolerating a dead pid", async () => {
		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
		vi.mocked(core.getState).mockReturnValue("424242");

		await run();

		expect(killSpy).toHaveBeenCalledWith(424242, "SIGTERM");
		killSpy.mockRestore();

		// ESRCH or any other failure must not propagate
		const failing = vi.spyOn(process, "kill").mockImplementation(() => {
			throw new Error("ESRCH");
		});
		await expect(run()).resolves.toBeUndefined();
		failing.mockRestore();
	});

	it("ignores a missing or nonsensical pid", async () => {
		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
		for (const value of ["", "abc", "0", "1", "-5"]) {
			vi.mocked(core.getState).mockReturnValue(value);
			await run();
		}
		expect(killSpy).not.toHaveBeenCalled();
		killSpy.mockRestore();
	});
});
