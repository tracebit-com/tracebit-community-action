import { describe, expect, it } from "vitest";
import {
	formatIniSection,
	formatNetrcEntry,
	formatNpmrcAuthToken,
	hasNoCredentials,
	isAwsAccessKeyId,
	isAwsSecretAccessKey,
	isAwsSessionToken,
	isBase64,
	isCanaryHostname,
	isOpaqueToken,
	isSingleLine,
	isSshPrivateKeyText,
	isSshPublicKeyLine,
	isStrategyName,
	MAX_JSON_DEPTH,
	MAX_RESPONSE_LENGTH,
	MAX_STRATEGY_DEPTH,
	parseBoundedJson,
	parseConfig,
	parseIssuedCredentials,
	ValidationError,
	validateAwsCredentials,
	validateDeploymentStrategy,
	validateHttpCredentials,
	validateIssuedCredentials,
	validateSshCredentials,
} from "../validate";

const AK = "ASIAIOSFODNN7EXAMPLE";
const SK = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const ST = "FwoGZXIvYXdzEBYaDEXAMPLESESSIONTOKEN0123456789abcdefABCDEF+/=";

const aws = {
	awsConfirmationId: "22222222-2222-4222-8222-222222222222",
	awsAccessKeyId: AK,
	awsSecretAccessKey: SK,
	awsSessionToken: ST,
	awsExpiration: "2026-05-10T14:45:14Z",
};

const ssh = {
	sshConfirmationId: "33333333-3333-4333-8333-333333333333",
	sshIp: "34.246.54.210",
	sshPrivateKey: Buffer.from(
		"-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n",
	).toString("base64"),
	sshPublicKey: Buffer.from(
		"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIElLjHVzr6AmSPysXjN7KWCzselCe0HixryRznbFyO7K ci@tracebit\n",
	).toString("base64"),
	sshExpiration: "2026-05-10T14:45:14.7390578Z",
};

const npmInstance = {
	confirmationId: "44444444-4444-4444-8444-444444444444",
	browserDeploymentId: "55555555-5555-4555-8555-555555555555",
	hostNames: ["npm.example.com"],
	expiresAt: null,
	credentials: { strategy: "npm-token", token: "npm_abc123DEF456" },
};

const pypiInstance = {
	confirmationId: "66666666-6666-4666-8666-666666666666",
	browserDeploymentId: "77777777-7777-4777-8777-777777777777",
	hostNames: ["pypi.internal.example.com"],
	expiresAt: "2026-05-10T14:45:14Z",
	credentials: {
		strategy: "python-index",
		token: "pypi-AgEIcHlwaS5vcmc",
		indexName: "internal",
	},
};

// The three injections reproduced in the security review (F1).
const AWS_INI_INJECTION = `${ST}\n[default]\ncredential_process = /tmp/pwn`;
const NPMRC_INJECTION =
	"npm.example.com/:_authToken=x\nregistry=https://evil.example";
const NETRC_INJECTION = "pypi.example.com\ndefault login a password b\nmachine";

describe("character-class validators", () => {
	it("isSingleLine rejects every control and line-break code point", () => {
		expect(isSingleLine("plain text", 64)).toBe(true);
		expect(isSingleLine("", 64)).toBe(false);
		expect(isSingleLine("x".repeat(65), 64)).toBe(false);
		for (const cp of [
			0x00, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1b, 0x1f, 0x7f, 0x85, 0x9f, 0x2028,
			0x2029,
		]) {
			expect(isSingleLine(`a${String.fromCodePoint(cp)}b`, 64)).toBe(false);
		}
	});

	it("isOpaqueToken accepts common token shapes", () => {
		expect(isOpaqueToken("npm_abc123DEF456")).toBe(true);
		expect(isOpaqueToken("pypi-AgEIcHlwaS5vcmc")).toBe(true);
		expect(isOpaqueToken("8c1b3a3e-0a4f-4b2e-9c3a-5f2b1d8e7a6c")).toBe(true);
		expect(isOpaqueToken("eyJhbGci.eyJzdWIi.SflKxw==")).toBe(true);
		expect(isOpaqueToken("__token__")).toBe(true);
	});

	it("isOpaqueToken rejects anything with INI, npmrc or netrc meaning", () => {
		for (const bad of [
			"",
			"a b",
			"a\nb",
			"a\rb",
			"a\tb",
			'a"b',
			"a'b",
			"a#b",
			"a;b",
			"a[b]",
			"a\\b",
			"a,b",
			"x".repeat(513),
		]) {
			expect(isOpaqueToken(bad)).toBe(false);
		}
	});

	it("validates AWS access key IDs", () => {
		expect(isAwsAccessKeyId("AKIAIOSFODNN7EXAMPLE")).toBe(true);
		expect(isAwsAccessKeyId("ASIAIOSFODNN7EXAMPLE")).toBe(true);
		expect(isAwsAccessKeyId("AKIAIOSFODNN7EXAMPL")).toBe(false);
		expect(isAwsAccessKeyId("akiaiosfodnn7example")).toBe(false);
		expect(isAwsAccessKeyId("AROAIOSFODNN7EXAMPLE")).toBe(false);
		expect(isAwsAccessKeyId("access-key")).toBe(false);
	});

	it("validates AWS secret access keys", () => {
		expect(isAwsSecretAccessKey(SK)).toBe(true);
		expect(isAwsSecretAccessKey(SK.slice(1))).toBe(false);
		expect(isAwsSecretAccessKey(`${SK}=`)).toBe(false);
		expect(isAwsSecretAccessKey(SK.replace("/", " "))).toBe(false);
	});

	it("validates AWS session tokens", () => {
		expect(isAwsSessionToken(ST)).toBe(true);
		expect(isAwsSessionToken("short")).toBe(false);
		expect(isAwsSessionToken("A".repeat(4097))).toBe(false);
		expect(isAwsSessionToken(AWS_INI_INJECTION)).toBe(false);
		expect(isAwsSessionToken(`${ST} `)).toBe(false);
		expect(isAwsSessionToken(`${ST}#comment`)).toBe(false);
	});

	it("validates base64", () => {
		expect(isBase64("YWJj", 16)).toBe(true);
		expect(isBase64("YWJjZA==", 16)).toBe(true);
		expect(isBase64("YWJj_-", 16)).toBe(true);
		expect(isBase64("", 16)).toBe(false);
		expect(isBase64("YWJj\n", 16)).toBe(false);
		expect(isBase64("YWJj===", 16)).toBe(false);
		expect(isBase64("Y".repeat(17), 16)).toBe(false);
	});

	it("isCanaryHostname accepts RFC 1123 canary hostnames", () => {
		expect(isCanaryHostname("npm.example.com")).toBe(true);
		expect(isCanaryHostname("a-b.c-d.tracebit.com")).toBe(true);
		expect(isCanaryHostname("x1.io")).toBe(true);
	});

	it("isCanaryHostname rejects anything that is not a bare hostname", () => {
		for (const bad of [
			"",
			"localhost",
			"example",
			"Example.COM",
			"-bad.example.com",
			"bad-.example.com",
			"bad..example.com",
			".example.com",
			"example.com.",
			"example.c0m",
			"example.c",
			"10.0.0.1",
			"[::1]",
			"npm.example.com:8080",
			"npm.example.com/path",
			"https://npm.example.com",
			"user@npm.example.com",
			"npm.example.com?x=1",
			"npm.example.com#x",
			"npm example.com",
			"npm.example.com\n",
			NPMRC_INJECTION,
			NETRC_INJECTION,
			`${"a".repeat(64)}.example.com`,
			`${"a.".repeat(127)}com`,
		]) {
			expect(isCanaryHostname(bad), bad).toBe(false);
		}
	});

	it("isCanaryHostname refuses well-known public registries", () => {
		for (const host of [
			"registry.npmjs.org",
			"registry.yarnpkg.com",
			"npm.pkg.github.com",
			"pypi.org",
			"upload.pypi.org",
			"files.pythonhosted.org",
		]) {
			expect(isCanaryHostname(host), host).toBe(false);
		}
	});

	it("isSshPrivateKeyText accepts PEM/OpenSSH blocks and nothing else", () => {
		const good =
			"-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\nQyNTUxOQAAACBJS4x1c6+gJkj8rF4zeylgs7HpQntB4sa8kc52xcjuyg==\n-----END OPENSSH PRIVATE KEY-----\n";
		expect(isSshPrivateKeyText(good)).toBe(true);
		expect(isSshPrivateKeyText(good.trimEnd())).toBe(true);
		expect(isSshPrivateKeyText(good.replace(/\n/gu, "\r\n"))).toBe(true);
		expect(
			isSshPrivateKeyText(
				"-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----\n",
			),
		).toBe(true);
		for (const bad of [
			"",
			'Match exec "touch /tmp/pwned"\n',
			"Host *\n    ProxyCommand evil\n",
			`Match exec "touch /tmp/pwned"\n${good}`,
			`${good}Match exec "touch /tmp/pwned"\n`,
			good.replace("-----END OPENSSH", "-----END RSA"),
			good.replace(
				"b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW",
				"Match exec touch",
			),
			"-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n",
			"-----BEGIN OPENSSH PRIVATE KEY-----\n-----END OPENSSH PRIVATE KEY-----\n",
			`-----BEGIN OPENSSH PRIVATE KEY-----\n${"A".repeat(77)}\n-----END OPENSSH PRIVATE KEY-----\n`,
		]) {
			expect(isSshPrivateKeyText(bad), JSON.stringify(bad.slice(0, 40))).toBe(
				false,
			);
		}
	});

	it("isSshPublicKeyLine accepts one authorized_keys-style line", () => {
		expect(
			isSshPublicKeyLine(
				"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIElLjHVzr6AmSPysXjN7KWCzselCe0HixryRznbFyO7K\n",
			),
		).toBe(true);
		expect(
			isSshPublicKeyLine(
				"ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQ== ci@tracebit",
			),
		).toBe(true);
		expect(
			isSshPublicKeyLine(
				"ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTY=",
			),
		).toBe(true);
		expect(
			isSshPublicKeyLine(
				"sk-ssh-ed25519@openssh.com AAAAGnNrLXNzaC1lZDI1NTE5QG9wZW5zc2guY29t",
			),
		).toBe(true);
		for (const bad of [
			"",
			"ssh-ed25519",
			"ssh-ed25519 not base64!",
			"ssh-ed25519 AAAAC3NzaC1yc2E=", // blob says ssh-rsa, line says ed25519
			"ssh-ed25519 bm90IGEga2V5",
			'Match exec "touch /tmp/pwned"',
			"ssh-ed25519 AAAA\nMatch exec touch",
			"ssh-ed25519 AAAA\n\n",
			"unknown-type AAAA",
			"ssh-ed25519 AAAA comment\twith\ttab",
		]) {
			expect(isSshPublicKeyLine(bad), JSON.stringify(bad)).toBe(false);
		}
	});

	it("validates strategy names", () => {
		expect(isStrategyName("npm-token")).toBe(true);
		expect(isStrategyName("any")).toBe(true);
		expect(isStrategyName("")).toBe(false);
		expect(isStrategyName("Npm")).toBe(false);
		expect(isStrategyName("npm token")).toBe(false);
		expect(isStrategyName("1npm")).toBe(false);
		expect(isStrategyName("a".repeat(65))).toBe(false);
	});
});

describe("parseBoundedJson", () => {
	it("parses ordinary JSON", () => {
		expect(parseBoundedJson('{"a":[1,2]}', "x")).toEqual({ a: [1, 2] });
	});

	it("rejects malformed JSON with a ValidationError", () => {
		expect(() => parseBoundedJson("{", "x")).toThrow(ValidationError);
		expect(() => parseBoundedJson("", "x")).toThrow(/not valid JSON/);
	});

	it("rejects oversized documents", () => {
		const big = `"${"a".repeat(MAX_RESPONSE_LENGTH)}"`;
		expect(() => parseBoundedJson(big, "x")).toThrow(/too large/);
	});

	it("rejects over-nested documents", () => {
		const ok = `${"[".repeat(MAX_JSON_DEPTH)}${"]".repeat(MAX_JSON_DEPTH)}`;
		expect(() => parseBoundedJson(ok, "x")).not.toThrow();
		const deep = `${"[".repeat(MAX_JSON_DEPTH + 1)}${"]".repeat(MAX_JSON_DEPTH + 1)}`;
		expect(() => parseBoundedJson(deep, "x")).toThrow(/nested deeper/);
		const deepObj = `${'{"a":'.repeat(MAX_JSON_DEPTH + 1)}1${"}".repeat(MAX_JSON_DEPTH + 1)}`;
		expect(() => parseBoundedJson(deepObj, "x")).toThrow(/nested deeper/);
	});
});

describe("validateAwsCredentials", () => {
	it("accepts well-formed credentials and returns only known fields", () => {
		expect(validateAwsCredentials(aws)).toEqual(aws);
	});

	it("rejects the credential_process injection via the session token", () => {
		expect(() =>
			validateAwsCredentials({ ...aws, awsSessionToken: AWS_INI_INJECTION }),
		).toThrow(/awsSessionToken/);
	});

	it("rejects injection via any other field", () => {
		expect(() =>
			validateAwsCredentials({
				...aws,
				awsAccessKeyId: `${AK}\n[default]`,
			}),
		).toThrow(/awsAccessKeyId/);
		expect(() =>
			validateAwsCredentials({
				...aws,
				awsSecretAccessKey: `${SK}\ncredential_process = x`,
			}),
		).toThrow(/awsSecretAccessKey/);
		expect(() =>
			validateAwsCredentials({ ...aws, awsConfirmationId: "a b" }),
		).toThrow(/awsConfirmationId/);
	});

	it("drops unknown fields instead of passing them through", () => {
		expect(validateAwsCredentials({ ...aws, extra: "x" })).toEqual(aws);
	});

	it("requires awsExpiration and UUID confirmation ids, per the API spec", () => {
		const { awsExpiration: _, ...noExpiry } = aws;
		expect(() => validateAwsCredentials(noExpiry)).toThrow(/awsExpiration/);
		expect(() =>
			validateAwsCredentials({ ...aws, awsConfirmationId: "confirm-id" }),
		).toThrow(/awsConfirmationId is not a UUID/);
	});

	it("rejects wrong shapes", () => {
		expect(() => validateAwsCredentials(null)).toThrow(/must be an object/);
		expect(() => validateAwsCredentials([])).toThrow(/must be an object/);
		expect(() => validateAwsCredentials({ ...aws, awsAccessKeyId: 1 })).toThrow(
			/must be a string/,
		);
		expect(() =>
			validateAwsCredentials({ ...aws, awsExpiration: "a\nb" }),
		).toThrow(/awsExpiration/);
		const { awsSessionToken: _, ...missing } = aws;
		expect(() => validateAwsCredentials(missing)).toThrow(/awsSessionToken/);
	});
});

describe("validateSshCredentials", () => {
	it("accepts well-formed credentials", () => {
		expect(validateSshCredentials(ssh)).toEqual(ssh);
		expect(() =>
			validateSshCredentials({ ...ssh, sshIp: "2001:db8::1" }),
		).not.toThrow();
	});

	it("rejects bad IPs, non-base64 keys and binary key material", () => {
		expect(() =>
			validateSshCredentials({ ...ssh, sshIp: "not-an-ip" }),
		).toThrow(/sshIp/);
		expect(() =>
			validateSshCredentials({ ...ssh, sshIp: "example.com" }),
		).toThrow(/sshIp/);
		expect(() =>
			validateSshCredentials({ ...ssh, sshPrivateKey: "not base64!" }),
		).toThrow(/sshPrivateKey/);
		expect(() =>
			validateSshCredentials({
				...ssh,
				sshPrivateKey: Buffer.from([0x00, 0xff, 0x01]).toString("base64"),
			}),
		).toThrow(/PEM or OpenSSH private key/);
		// R2: ssh_config text in place of a key is rejected before any write
		expect(() =>
			validateSshCredentials({
				...ssh,
				sshPrivateKey: Buffer.from(
					'Match exec "touch /tmp/pwned"\nHost *\n  ProxyCommand nc evil 22\n',
				).toString("base64"),
			}),
		).toThrow(/PEM or OpenSSH private key/);
		expect(() =>
			validateSshCredentials({
				...ssh,
				sshPublicKey: Buffer.from('Match exec "touch /tmp/pwned"').toString(
					"base64",
				),
			}),
		).toThrow(/OpenSSH public key line/);
		expect(() => validateSshCredentials({ ...ssh, sshPublicKey: "" })).toThrow(
			/sshPublicKey/,
		);
	});

	it("rejects multiline expirations and drops unknown fields", () => {
		expect(() =>
			validateSshCredentials({ ...ssh, sshExpiration: "a\nb" }),
		).toThrow(/sshExpiration/);
		expect(validateSshCredentials({ ...ssh, port: 22 })).toEqual(ssh);
	});
});

describe("validateDeploymentStrategy", () => {
	it("python-index: validated output round-trips through JSON", () => {
		// indexName "" is what the validator itself emits for a root index, so
		// it must be accepted again when main re-validates the hand-off file.
		const once = validateDeploymentStrategy({
			strategy: "python-index",
			token: "pypi-abc",
			indexName: null,
		});
		expect(
			validateDeploymentStrategy(JSON.parse(JSON.stringify(once))),
		).toEqual(once);
		const full = { http: { pypi: pypiInstance } };
		const parsed = parseIssuedCredentials(JSON.stringify(full));
		expect(parseIssuedCredentials(JSON.stringify(parsed))).toEqual(parsed);
	});

	it("python-index: indexName and username are nullable per the API spec", () => {
		expect(
			validateDeploymentStrategy({
				strategy: "python-index",
				token: "pypi-abc",
			}),
		).toEqual({ strategy: "python-index", token: "pypi-abc", indexName: "" });
		expect(
			validateDeploymentStrategy({
				strategy: "python-index",
				token: "pypi-abc",
				indexName: null,
				username: null,
			}),
		).toEqual({ strategy: "python-index", token: "pypi-abc", indexName: "" });
		expect(
			validateDeploymentStrategy({
				strategy: "python-index",
				token: "pypi-abc",
				username: "deploy-bot",
			}),
		).toEqual({
			strategy: "python-index",
			token: "pypi-abc",
			indexName: "",
			username: "deploy-bot",
		});
		expect(() =>
			validateDeploymentStrategy({
				strategy: "python-index",
				token: "pypi-abc",
				username: "a b\ndefault",
			}),
		).toThrow(/username/);
	});

	it("reduces every spec strategy this action cannot deploy to its name", () => {
		for (const strategy of [
			"cookie",
			"mcp",
			"username-password",
			"elasticsearch-api-key",
			"url",
		]) {
			expect(
				validateDeploymentStrategy({
					strategy,
					token: "x",
					encoded: "y",
					path: "/p\n",
					cookie: { name: "c" },
				}),
			).toEqual({ strategy });
		}
	});

	it("accepts npm-token and python-index", () => {
		expect(validateDeploymentStrategy(npmInstance.credentials)).toEqual(
			npmInstance.credentials,
		);
		expect(validateDeploymentStrategy(pypiInstance.credentials)).toEqual(
			pypiInstance.credentials,
		);
	});

	it("rejects multiline or quoted tokens", () => {
		expect(() =>
			validateDeploymentStrategy({
				strategy: "npm-token",
				token: "x\nregistry=https://evil.example",
			}),
		).toThrow(/token/);
		expect(() =>
			validateDeploymentStrategy({ strategy: "npm-token", token: 'a"b' }),
		).toThrow(/token/);
		expect(() =>
			validateDeploymentStrategy({
				strategy: "python-index",
				token: "a b",
				indexName: "x",
			}),
		).toThrow(/token/);
		expect(() =>
			validateDeploymentStrategy({
				strategy: "python-index",
				token: "ok",
				indexName: "a\nb",
			}),
		).toThrow(/indexName/);
	});

	it("drops unexpected fields on known strategies", () => {
		expect(
			validateDeploymentStrategy({
				strategy: "npm-token",
				token: "ok",
				registry: "https://evil.example",
			}),
		).toEqual({ strategy: "npm-token", token: "ok" });
	});

	it("reduces unknown strategies to their name only", () => {
		expect(
			validateDeploymentStrategy({
				strategy: "cookie",
				cookie: { name: "x" },
			}),
		).toEqual({ strategy: "cookie" });
		expect(() => validateDeploymentStrategy({ strategy: "Bad Name" })).toThrow(
			/strategy/,
		);
		expect(() => validateDeploymentStrategy({})).toThrow(/strategy/);
		expect(() => validateDeploymentStrategy("npm-token")).toThrow(
			/must be an object/,
		);
	});

	it("validates nested any/all groups and bounds their depth", () => {
		const nested = {
			strategy: "any",
			strategies: [
				{ strategy: "all", strategies: [npmInstance.credentials] },
				{ strategy: "browser" },
			],
		};
		expect(validateDeploymentStrategy(nested)).toEqual(nested);

		expect(() =>
			validateDeploymentStrategy({ strategy: "any", strategies: "x" }),
		).toThrow(/strategies must be an array/);
		// A bad candidate inside a group is dropped and reported, not fatal.
		const problems: string[] = [];
		expect(
			validateDeploymentStrategy(
				{
					strategy: "all",
					strategies: [
						{ strategy: "npm-token", token: "a\nb" },
						{ strategy: "python-index", token: "pypi-ok", indexName: "" },
					],
				},
				0,
				"credentials",
				(m) => problems.push(m),
			),
		).toEqual({
			strategy: "all",
			strategies: [
				{ strategy: "python-index", token: "pypi-ok", indexName: "" },
			],
		});
		expect(problems).toEqual([expect.stringMatching(/strategies\[0\]\.token/)]);

		// Depth is still bounded: levels beyond the limit are dropped and
		// reported, so the leaf never gets through.
		let deep: unknown = npmInstance.credentials;
		for (let i = 0; i <= MAX_STRATEGY_DEPTH; i++) {
			deep = { strategy: "any", strategies: [deep] };
		}
		const deepProblems: string[] = [];
		const bounded = JSON.stringify(
			validateDeploymentStrategy(deep, 0, "credentials", (m) =>
				deepProblems.push(m),
			),
		);
		expect(bounded).not.toContain("npm-token");
		expect(deepProblems).toEqual([expect.stringMatching(/nests strategies/)]);

		expect(() =>
			validateDeploymentStrategy({
				strategy: "all",
				strategies: new Array(17).fill({ strategy: "browser" }),
			}),
		).toThrow(/more than 16/);
	});
});

describe("validateHttpCredentials", () => {
	it("accepts well-formed instances", () => {
		expect(validateHttpCredentials(npmInstance)).toEqual(npmInstance);
		expect(validateHttpCredentials(pypiInstance)).toEqual(pypiInstance);
	});

	it("rejects the npmrc registry injection via hostname", () => {
		expect(() =>
			validateHttpCredentials({ ...npmInstance, hostNames: [NPMRC_INJECTION] }),
		).toThrow(/hostNames\[0\]/);
	});

	it("rejects the netrc default-entry injection via hostname", () => {
		expect(() =>
			validateHttpCredentials({
				...pypiInstance,
				hostNames: [NETRC_INJECTION],
			}),
		).toThrow(/hostNames\[0\]/);
	});

	it("rejects public registry hostnames and bad shapes", () => {
		expect(() =>
			validateHttpCredentials({
				...npmInstance,
				hostNames: ["registry.npmjs.org"],
			}),
		).toThrow(/hostNames\[0\]/);
		expect(() =>
			validateHttpCredentials({ ...npmInstance, hostNames: "npm.example.com" }),
		).toThrow(/hostNames must be an array/);
		expect(() =>
			validateHttpCredentials({
				...npmInstance,
				hostNames: new Array(17).fill("npm.example.com"),
			}),
		).toThrow(/more than 16/);
		expect(() =>
			validateHttpCredentials({ ...npmInstance, expiresAt: "a\nb" }),
		).toThrow(/expiresAt/);
		expect(() =>
			validateHttpCredentials({ ...npmInstance, confirmationId: null }),
		).toThrow(/confirmationId/);
		expect(() =>
			validateHttpCredentials({ ...npmInstance, browserDeploymentId: "abc" }),
		).toThrow(/browserDeploymentId is not a UUID/);
		expect(validateHttpCredentials({ ...npmInstance, registry: "x" })).toEqual(
			npmInstance,
		);
	});

	it("allows an empty hostNames list (deployment fails later, not here)", () => {
		expect(
			validateHttpCredentials({ ...npmInstance, hostNames: [] }).hostNames,
		).toEqual([]);
	});
});

describe("validateIssuedCredentials / parseIssuedCredentials", () => {
	it("accepts a full response", () => {
		const full = { aws, ssh, http: { npm: npmInstance, pypi: pypiInstance } };
		expect(parseIssuedCredentials(JSON.stringify(full))).toEqual(full);
	});

	it("treats null families as absent", () => {
		expect(validateIssuedCredentials({ aws, ssh: null, http: null })).toEqual({
			aws,
		});
	});

	it("forward compatibility: a response from a newer backend deploys everything this version knows", () => {
		// Every kind of addition at once: new top-level family, extra fields on
		// every object, a new strategy as an any-candidate, a new strategy as a
		// whole instance, extra fields on strategies. Nothing is allowed to break.
		const future = {
			aws: { ...aws, awsAccountId: "123456789012", awsRegionHint: "eu-west-1" },
			ssh: { ...ssh, sshPort: 22, sshFingerprint: "SHA256:abc" },
			awsLongTermAccessKey: {
				awsLongTermAccessKeyConfirmationId:
					"88888888-8888-4888-8888-888888888888",
				awsLongTermAccessKeyId: "AKIAIOSFODNN7EXAMPLE",
				awsLongTermSecretAccessKey: SK,
			},
			okta: {
				oktaConfirmationId: "x",
				oktaToken: "y",
				oktaOrgUrl: "https://x",
			},
			http: {
				npm: {
					...npmInstance,
					instanceLabel: "primary",
					credentials: {
						strategy: "any",
						priority: 1,
						strategies: [
							{ strategy: "mcp", token: "eyJ.jwt" },
							{ ...npmInstance.credentials, scope: "@acme" },
						],
					},
				},
				pypi: {
					...pypiInstance,
					credentials: { ...pypiInstance.credentials, extra: true },
				},
				es: {
					...pypiInstance,
					confirmationId: "99999999-9999-4999-8999-999999999999",
					hostNames: ["es.example.com"],
					credentials: { strategy: "elasticsearch-api-key", encoded: "abc=" },
				},
			},
			issuedAt: "2026-10-05T00:00:00Z",
			deploymentVersion: "3.0.0",
		};
		const problems: string[] = [];
		const result = validateIssuedCredentials(future, (m) => problems.push(m));

		expect(result).toEqual({
			aws,
			ssh,
			http: {
				npm: {
					...npmInstance,
					credentials: {
						strategy: "any",
						strategies: [{ strategy: "mcp" }, npmInstance.credentials],
					},
				},
				pypi: pypiInstance,
				es: {
					...pypiInstance,
					confirmationId: "99999999-9999-4999-8999-999999999999",
					hostNames: ["es.example.com"],
					credentials: { strategy: "elasticsearch-api-key" },
				},
			},
		});
		// Only the unknown families are reported; extra fields are silently dropped.
		expect(problems).toEqual([
			expect.stringContaining('"awsLongTermAccessKey"'),
			expect.stringContaining('"okta"'),
			expect.stringContaining('"issuedAt"'),
			expect.stringContaining('"deploymentVersion"'),
		]);
		// And it survives the async hand-off round trip unchanged.
		expect(parseIssuedCredentials(JSON.stringify(result))).toEqual(result);
	});

	it("an empty response validates to nothing usable; the caller decides", () => {
		expect(validateIssuedCredentials({})).toEqual({});
		expect(hasNoCredentials(validateIssuedCredentials({}))).toBe(true);
		expect(hasNoCredentials(validateIssuedCredentials({ http: {} }))).toBe(
			true,
		);
		expect(hasNoCredentials(validateIssuedCredentials({ aws }))).toBe(false);
	});

	it("ignores families this version does not know, keeping the ones it does", () => {
		expect(
			validateIssuedCredentials({
				aws,
				okta: null,
				azure: null,
				awsLongTermAccessKey: null,
			}),
		).toEqual({ aws });

		// A new family from a newer backend must not stop aws/ssh/http deploying.
		const problems: string[] = [];
		expect(
			validateIssuedCredentials(
				{ aws, okta: { oktaToken: "x", oktaOrgUrl: "https://x" }, gcp: {} },
				(m) => problems.push(m),
			),
		).toEqual({ aws });
		expect(problems).toEqual([
			expect.stringContaining(
				'"okta" credentials this action version does not support',
			),
			expect.stringContaining(
				'"gcp" credentials this action version does not support',
			),
		]);
	});

	it("drops a malformed family or instance and keeps the rest", () => {
		let problems: string[] = [];
		const report = (m: string) => problems.push(m);

		// injected AWS token: aws dropped, ssh kept
		expect(
			validateIssuedCredentials(
				{ aws: { ...aws, awsSessionToken: AWS_INI_INJECTION }, ssh },
				report,
			),
		).toEqual({ ssh });
		expect(problems).toEqual([
			expect.stringMatching(/Skipping AWS credentials: .*awsSessionToken/),
		]);

		// injected hostname on one http instance: that instance dropped, aws and
		// the other instance kept
		problems = [];
		expect(
			validateIssuedCredentials(
				{
					aws,
					http: {
						npm: { ...npmInstance, hostNames: [NPMRC_INJECTION] },
						pypi: pypiInstance,
					},
				},
				report,
			),
		).toEqual({ aws, http: { pypi: pypiInstance } });
		expect(problems).toEqual([
			expect.stringMatching(/Skipping HTTP instance "npm": .*hostNames\[0\]/),
		]);

		// malformed ssh: ssh dropped, aws kept
		problems = [];
		expect(
			validateIssuedCredentials(
				{ aws, ssh: { ...ssh, sshIp: "nope" } },
				report,
			),
		).toEqual({ aws });
		expect(problems).toEqual([
			expect.stringMatching(/Skipping SSH credentials: .*sshIp/),
		]);

		// without a reporter, problems are silently dropped but nothing throws
		expect(
			validateIssuedCredentials({
				aws: { ...aws, awsSessionToken: AWS_INI_INJECTION },
			}),
		).toEqual({});
	});

	it("skips ill-formed http instance ids, non-object http, and excess instances", () => {
		let problems: string[] = [];
		const report = (m: string) => problems.push(m);

		expect(
			validateIssuedCredentials(
				{ http: { "bad id\n": npmInstance, good: npmInstance } },
				report,
			),
		).toEqual({ http: { good: npmInstance } });
		expect(problems).toEqual([expect.stringContaining("ill-formed id")]);

		problems = [];
		expect(validateIssuedCredentials({ aws, http: [] }, report)).toEqual({
			aws,
		});
		expect(problems).toEqual([
			expect.stringMatching(
				/Skipping HTTP credentials: http must be an object/,
			),
		]);

		problems = [];
		const many: Record<string, unknown> = {};
		for (let i = 0; i < 33; i++) many[`i${i}`] = npmInstance;
		const result = validateIssuedCredentials({ http: many }, report);
		expect(Object.keys(result.http ?? {})).toHaveLength(32);
		expect(problems).toEqual([
			expect.stringContaining("more than 32 instances"),
		]);
	});

	it("rejects non-object and malformed JSON bodies", () => {
		expect(() => parseIssuedCredentials("[]")).toThrow(/must be an object/);
		expect(() => parseIssuedCredentials("null")).toThrow(/must be an object/);
		expect(() => parseIssuedCredentials("not json")).toThrow(ValidationError);
	});
});

describe("parseConfig", () => {
	it("accepts instances and tolerates a missing list", () => {
		expect(parseConfig("{}")).toEqual({});
		expect(parseConfig('{"instances":null}')).toEqual({});
		expect(
			parseConfig('{"instances":[{"key":"npm","instanceId":"inst-1"}]}'),
		).toEqual({ instances: [{ key: "npm", instanceId: "inst-1" }] });
	});

	it("skips malformed instances and keeps the rest", () => {
		expect(() => parseConfig('{"instances":{}}')).toThrow(/must be an array/);
		const problems: string[] = [];
		expect(
			parseConfig(
				'{"instances":[{"key":"npm"},{"key":"a b","instanceId":"x"},{"key":"ok","instanceId":"inst-1"}]}',
				(m) => problems.push(m),
			),
		).toEqual({ instances: [{ key: "ok", instanceId: "inst-1" }] });
		expect(problems).toEqual([
			expect.stringMatching(/Skipping perimeter instance: .*instanceId/),
			expect.stringMatching(/Skipping perimeter instance: .*key/),
		]);
		const many = JSON.stringify({
			instances: new Array(65).fill({ key: "k", instanceId: "i" }),
		});
		expect(() => parseConfig(many)).toThrow(/more than 64/);
	});
});

describe("serializers", () => {
	it("formatIniSection emits exactly one section", () => {
		expect(
			formatIniSection("tracebit", [
				["aws_access_key_id", AK],
				["aws_session_token", ST],
			]),
		).toBe(`[tracebit]\naws_access_key_id = ${AK}\naws_session_token = ${ST}`);
		expect(
			formatIniSection("profile tracebit", [["region", "us-east-1"]]),
		).toBe("[profile tracebit]\nregion = us-east-1");
	});

	it("formatIniSection refuses anything that could add a directive", () => {
		expect(() => formatIniSection("a]\n[b", [])).toThrow(/section name/);
		expect(() => formatIniSection("profile a b", [])).toThrow(/section name/);
		expect(() => formatIniSection("", [])).toThrow(/section name/);
		expect(() => formatIniSection("p", [["Key", "v"]])).toThrow(/INI key/);
		expect(() => formatIniSection("p", [["key\n", "v"]])).toThrow(/INI key/);
		expect(() =>
			formatIniSection("p", [["aws_session_token", AWS_INI_INJECTION]]),
		).toThrow(/INI value/);
		for (const bad of ["", "a b", "a#b", "a;b", "[x]", 'a"b', "a'b", "a\tb"]) {
			expect(() => formatIniSection("p", [["k", bad]]), bad).toThrow(
				/INI value/,
			);
		}
	});

	it("formatNpmrcAuthToken emits one key and quotes tokens containing '='", () => {
		expect(formatNpmrcAuthToken("npm.example.com", "npm_abc")).toBe(
			"//npm.example.com/:_authToken=npm_abc",
		);
		expect(formatNpmrcAuthToken("npm.example.com", "abc==")).toBe(
			'//npm.example.com/:_authToken="abc=="',
		);
	});

	it("formatNpmrcAuthToken refuses the registry injection", () => {
		expect(() => formatNpmrcAuthToken(NPMRC_INJECTION, "npm_abc")).toThrow(
			/hostname/,
		);
		expect(() =>
			formatNpmrcAuthToken("npm.example.com", "x\nregistry=https://evil"),
		).toThrow(/auth token/);
		expect(() => formatNpmrcAuthToken("registry.npmjs.org", "npm_abc")).toThrow(
			/hostname/,
		);
	});

	it("formatNetrcEntry emits one machine entry", () => {
		expect(formatNetrcEntry("pypi.example.com", "__token__", "pypi-abc")).toBe(
			"machine pypi.example.com\nlogin __token__\npassword pypi-abc",
		);
	});

	it("formatNetrcEntry refuses the default-entry injection", () => {
		expect(() =>
			formatNetrcEntry(NETRC_INJECTION, "__token__", "pypi-abc"),
		).toThrow(/hostname/);
		expect(() =>
			formatNetrcEntry("pypi.example.com", "a b", "pypi-abc"),
		).toThrow(/login/);
		expect(() =>
			formatNetrcEntry("pypi.example.com", "__token__", "a\ndefault"),
		).toThrow(/password/);
		expect(() =>
			formatNetrcEntry("pypi.example.com", "__token__", "a b"),
		).toThrow(/password/);
	});
});
