import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@actions/core", () => ({
	getInput: vi.fn(),
	warning: vi.fn(),
}));

import * as core from "@actions/core";
import { getInputs, hasApiToken, isValidSshKeyName } from "../inputs";

const base = (name: string): string => {
	if (name === "api-token") return "token";
	if (name === "profile") return "tracebit-profile";
	if (name === "profile-region") return "us-east-1";
	return "";
};

describe("getInputs", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		for (const k of Object.keys(process.env)) {
			if (k.startsWith("INPUT_")) delete process.env[k];
		}
	});

	it("applies defaults", () => {
		vi.mocked(core.getInput).mockImplementation(base);
		const inputs = getInputs();
		expect(inputs.customerId).toBe("community");
		expect(inputs.apiHost).toBe("tracebit.com");
		expect(inputs.sshKeyName).toBe("prod_deploy");
		expect(inputs.runAsync).toBe(false);
		expect(inputs.envPrefix).toBe("__AWS__");
		expect(hasApiToken(inputs)).toBe(true);
	});

	it("falls back to INPUT_* environment variables (run-local)", () => {
		vi.mocked(core.getInput).mockReturnValue("");
		process.env.INPUT_API_TOKEN = "env-token";
		process.env.INPUT_PROFILE = "p";
		process.env.INPUT_PROFILE_REGION = "eu-west-2";
		process.env.INPUT_SSH_KEY_NAME = "canary_key";
		process.env.INPUT_ASYNC = "true";
		const inputs = getInputs();
		expect(inputs.apiToken).toBe("env-token");
		expect(inputs.sshKeyName).toBe("canary_key");
		expect(inputs.runAsync).toBe(true);
	});

	it("treats a missing or blank api-token as absent, not as an error", () => {
		vi.mocked(core.getInput).mockImplementation((n) =>
			n === "api-token" ? "" : base(n),
		);
		expect(hasApiToken(getInputs())).toBe(false);
		vi.mocked(core.getInput).mockImplementation((n) =>
			n === "api-token" ? "   " : base(n),
		);
		expect(hasApiToken(getInputs())).toBe(false);
	});

	it("still requires profile and region", () => {
		vi.mocked(core.getInput).mockImplementation((n) =>
			n === "profile" ? "" : base(n),
		);
		expect(() => getInputs()).toThrow(/profile/);
		vi.mocked(core.getInput).mockImplementation((n) =>
			n === "profile-region" ? "" : base(n),
		);
		expect(() => getInputs()).toThrow(/profile-region/);
	});

	it("rejects unsafe ssh-key-name, profile, customer-id and api-host", () => {
		for (const [name, value, re] of [
			["ssh-key-name", "../id_rsa", /ssh-key-name/],
			["ssh-key-name", "key name", /ssh-key-name/],
			["profile", "a]\n[b", /profile name/],
			["customer-id", "evil.com/", /customer-id/],
			["api-host", "-bad.example", /api-host/],
			["api-host", "a..b", /api-host/],
		] as const) {
			vi.mocked(core.getInput).mockImplementation((n) =>
				n === name ? value : base(n),
			);
			expect(() => getInputs(), `${name}=${value}`).toThrow(re);
		}
	});

	it("isValidSshKeyName refuses names OpenSSH reads as configuration or executes", () => {
		for (const reserved of [
			"config",
			"Config",
			"authorized_keys",
			"authorized_keys2",
			"known_hosts",
			"known_hosts2",
			"rc",
			"environment",
		]) {
			expect(isValidSshKeyName(reserved), reserved).toBe(false);
			vi.mocked(core.getInput).mockImplementation((n) =>
				n === "ssh-key-name" ? reserved : base(n),
			);
			expect(() => getInputs(), reserved).toThrow(/ssh-key-name/);
		}
	});

	it("isValidSshKeyName", () => {
		expect(isValidSshKeyName("prod_deploy")).toBe(true);
		expect(isValidSshKeyName("id-ed25519_2")).toBe(true);
		expect(isValidSshKeyName("")).toBe(false);
		expect(isValidSshKeyName("a.b")).toBe(false);
		expect(isValidSshKeyName("a/b")).toBe(false);
		expect(isValidSshKeyName("..")).toBe(false);
	});
});
