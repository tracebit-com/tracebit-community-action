/**
 * Runtime validation for everything the Tracebit API returns before any of it
 * is written to credential files, exported to the environment, or sent back.
 *
 * The API is authenticated and served over TLS, but a compromised or
 * misconfigured backend must not be able to turn an inert canary into
 * executable configuration (e.g. an `aws_session_token` that contains a
 * newline followed by `[default]\ncredential_process = ...`). Every value is
 * therefore checked against the grammar of the place it will be written to,
 * and the serializers below refuse anything that could add a directive.
 *
 * No third-party dependencies: small, explicit, individually tested functions.
 */
import * as net from "node:net";
import type {
	Config,
	ConfigInstance,
	IssuedAwsCredentials,
	IssuedCredentials,
	IssuedHttpCredentials,
	IssuedSshCredentials,
} from "./api";
import type {
	AllDeploymentStrategy,
	AnyDeploymentStrategy,
	NpmTokenDeploymentStrategy,
	PythonIndexDeploymentStrategy,
	TolerantDeploymentStrategy,
} from "./external-types/deployment-strategy";

/** python-index as the API actually sends it: the synced type lacks `username`. */
export type ValidatedPythonIndexStrategy = PythonIndexDeploymentStrategy & {
	username?: string;
};

export class ValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ValidationError";
	}
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** Maximum accepted size of any API response body, in UTF-16 code units. */
export const MAX_RESPONSE_LENGTH = 256 * 1024;
/** Maximum JSON nesting depth we are willing to walk. */
export const MAX_JSON_DEPTH = 16;
/** Maximum nesting of any/all deployment strategies. */
export const MAX_STRATEGY_DEPTH = 4;
export const MAX_STRATEGIES_PER_GROUP = 16;
export const MAX_HTTP_INSTANCES = 32;
export const MAX_HOSTNAMES_PER_INSTANCE = 16;
export const MAX_CONFIG_INSTANCES = 64;

const MAX_OPAQUE_TOKEN_LENGTH = 512;
const MAX_AWS_SESSION_TOKEN_LENGTH = 4096;
const MAX_SSH_KEY_BASE64_LENGTH = 32 * 1024;
const MAX_TIMESTAMP_LENGTH = 64;

const CREDENTIAL_FAMILIES = ["aws", "ssh", "http"] as const;

// ---------------------------------------------------------------------------
// Character-class validators
// ---------------------------------------------------------------------------

/**
 * True when the code point is a C0/C1 control, DEL, or a Unicode line or
 * paragraph separator. Any of these can terminate a line or confuse a
 * line-oriented parser such as INI, .npmrc or .netrc.
 */
function isControlOrLineBreak(codePoint: number): boolean {
	return (
		codePoint < 0x20 ||
		(codePoint >= 0x7f && codePoint <= 0x9f) ||
		codePoint === 0x2028 ||
		codePoint === 0x2029
	);
}

/** True when `value` is a non-empty single line of printable text. */
export function isSingleLine(value: string, maxLength: number): boolean {
	if (value.length === 0 || value.length > maxLength) {
		return false;
	}
	for (const ch of value) {
		if (isControlOrLineBreak(ch.codePointAt(0) ?? 0)) {
			return false;
		}
	}
	return true;
}

// Conservative token alphabet: covers npm (`npm_...`), PyPI (`pypi-...`),
// UUIDs, base64 and base64url, JWT-style dotted tokens. Deliberately excludes
// whitespace, quotes, `#`, `;`, `[`, `]`, `\` and anything else that has a
// meaning in INI, .npmrc or .netrc.
const OPAQUE_TOKEN = /^[A-Za-z0-9._~+/=:-]+$/u;

/** A secret or identifier that is written as a single INI/netrc field. */
export function isOpaqueToken(
	value: string,
	maxLength = MAX_OPAQUE_TOKEN_LENGTH,
): boolean {
	return value.length <= maxLength && OPAQUE_TOKEN.test(value);
}

/** RFC 4122 UUID in canonical hyphenated form (the spec's `format: uuid`). */
export function isUuid(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
		value,
	);
}

/** AWS access key IDs are 20 upper-case alphanumerics with a known prefix. */
export function isAwsAccessKeyId(value: string): boolean {
	return /^(?:AKIA|ASIA)[A-Z0-9]{16}$/u.test(value);
}

/** AWS secret access keys are 40 characters of base64 (no padding). */
export function isAwsSecretAccessKey(value: string): boolean {
	return /^[A-Za-z0-9/+]{40}$/u.test(value);
}

/** STS session tokens are base64; length varies, so only bound it. */
export function isAwsSessionToken(value: string): boolean {
	return (
		value.length >= 16 &&
		value.length <= MAX_AWS_SESSION_TOKEN_LENGTH &&
		/^[A-Za-z0-9/+=]+$/u.test(value)
	);
}

/** Standard or URL-safe base64, optional padding, bounded. */
export function isBase64(value: string, maxLength: number): boolean {
	return (
		value.length > 0 &&
		value.length <= maxLength &&
		/^[A-Za-z0-9+/_-]+={0,2}$/u.test(value)
	);
}

const PUBLIC_REGISTRY_HOSTS: ReadonlySet<string> = new Set([
	"registry.npmjs.org",
	"registry.npmjs.com",
	"registry.yarnpkg.com",
	"npm.pkg.github.com",
	"pypi.org",
	"upload.pypi.org",
	"test.pypi.org",
	"files.pythonhosted.org",
	"pypi.python.org",
]);

/**
 * A canary HTTP hostname: RFC 1123 labels, at least two of them, an alphabetic
 * TLD, no scheme/port/path/userinfo, and never a well-known public registry
 * (credentials written for those would redirect or leak real traffic).
 */
export function isCanaryHostname(value: string): boolean {
	if (value.length === 0 || value.length > 253) {
		return false;
	}
	if (value !== value.toLowerCase()) {
		return false;
	}
	const labels = value.split(".");
	if (labels.length < 2) {
		return false;
	}
	for (const label of labels) {
		if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label)) {
			return false;
		}
	}
	const tld = labels[labels.length - 1];
	if (!/^[a-z]{2,63}$/u.test(tld)) {
		return false;
	}
	if (net.isIP(value) !== 0) {
		return false;
	}
	return !PUBLIC_REGISTRY_HOSTS.has(value);
}

const PEM_LABEL = /^[A-Z0-9 ]+ PRIVATE KEY$/u;
const BASE64_LINE = /^[A-Za-z0-9+/]{1,76}={0,2}$/u;

/**
 * True when `text` is a PEM-framed private key as OpenSSH writes it: a BEGIN
 * line, base64 body lines, a matching END line, optional trailing newline.
 * No PEM headers, no blank lines, nothing before or after the block.
 *
 * This is a format check, not a cryptographic one. On GitHub-hosted runners
 * `ssh-keygen -y -P "" -f <file>` could additionally prove the key parses
 * and matches the public key; we deliberately avoid spawning a subprocess
 * here and rely on the format being unusable as anything but a key.
 */
export function isSshPrivateKeyText(text: string): boolean {
	if (text.length === 0 || text.length > 16 * 1024) {
		return false;
	}
	const lines = text.replace(/\r\n/gu, "\n").replace(/\n$/u, "").split("\n");
	if (lines.length < 3) {
		return false;
	}
	const begin = /^-----BEGIN ([A-Z0-9 ]+)-----$/u.exec(lines[0] ?? "");
	const end = /^-----END ([A-Z0-9 ]+)-----$/u.exec(
		lines[lines.length - 1] ?? "",
	);
	if (
		!begin ||
		!end ||
		begin[1] !== end[1] ||
		!PEM_LABEL.test(begin[1] ?? "")
	) {
		return false;
	}
	return lines.slice(1, -1).every((line) => BASE64_LINE.test(line));
}

const SSH_PUBLIC_KEY_TYPE =
	/^(?:ssh-(?:ed25519|rsa|dss)|ecdsa-sha2-[a-z0-9-]+|sk-[a-z0-9@.-]+)$/u;

/**
 * True when `text` is a single OpenSSH public key line:
 * `<type> <base64> [comment]`, optional trailing newline.
 */
export function isSshPublicKeyLine(text: string): boolean {
	if (text.length === 0 || text.length > 16 * 1024) {
		return false;
	}
	const line = text.replace(/\r?\n$/u, "");
	if (/[\r\n]/u.test(line)) {
		return false;
	}
	const parts = line.split(" ");
	if (parts.length < 2) {
		return false;
	}
	const [type, body, ...comment] = parts;
	if (
		!SSH_PUBLIC_KEY_TYPE.test(type ?? "") ||
		!/^[A-Za-z0-9+/]+={0,2}$/u.test(body ?? "") ||
		!comment.every((c) => c === "" || isSingleLine(c, 256))
	) {
		return false;
	}
	// The blob is RFC 4253 encoded: a uint32 length followed by the key type
	// string, which must equal the declared type. This ties the base64 to a
	// real key structure rather than any base64-looking word.
	const blob = Buffer.from(body ?? "", "base64");
	if (blob.length < 4) {
		return false;
	}
	const typeLength = blob.readUInt32BE(0);
	if (
		typeLength !== Buffer.byteLength(type ?? "") ||
		blob.length < 4 + typeLength
	) {
		return false;
	}
	return blob.subarray(4, 4 + typeLength).toString("utf8") === type;
}

/** Deployment strategy discriminators are lower-case kebab-case words. */
export function isStrategyName(value: string): boolean {
	return /^[a-z][a-z0-9-]{0,63}$/u.test(value);
}

// ---------------------------------------------------------------------------
// JSON parsing with bounds
// ---------------------------------------------------------------------------

function jsonDepth(value: unknown, depth: number): number {
	if (depth > MAX_JSON_DEPTH) {
		return depth;
	}
	if (Array.isArray(value)) {
		let max = depth + 1;
		for (const item of value) {
			max = Math.max(max, jsonDepth(item, depth + 1));
			if (max > MAX_JSON_DEPTH) break;
		}
		return max;
	}
	if (value !== null && typeof value === "object") {
		let max = depth + 1;
		for (const item of Object.values(value as Record<string, unknown>)) {
			max = Math.max(max, jsonDepth(item, depth + 1));
			if (max > MAX_JSON_DEPTH) break;
		}
		return max;
	}
	return depth;
}

/** Parses JSON, rejecting oversized or over-nested documents. */
export function parseBoundedJson(text: string, what: string): unknown {
	if (text.length > MAX_RESPONSE_LENGTH) {
		throw new ValidationError(
			`${what} is too large (${text.length} > ${MAX_RESPONSE_LENGTH} characters)`,
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (e) {
		throw new ValidationError(
			`${what} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
	if (jsonDepth(parsed, 0) > MAX_JSON_DEPTH) {
		throw new ValidationError(
			`${what} is nested deeper than ${MAX_JSON_DEPTH} levels`,
		);
	}
	return parsed;
}

// ---------------------------------------------------------------------------
// Structural helpers
// ---------------------------------------------------------------------------

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown, what: string): JsonRecord {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new ValidationError(`${what} must be an object`);
	}
	return value as JsonRecord;
}

function requireString(record: JsonRecord, key: string, what: string): string {
	const value = record[key];
	if (typeof value !== "string") {
		throw new ValidationError(`${what}.${key} must be a string`);
	}
	return value;
}

function requireOpaqueToken(
	record: JsonRecord,
	key: string,
	what: string,
): string {
	const value = requireString(record, key, what);
	if (!isOpaqueToken(value)) {
		throw new ValidationError(`${what}.${key} is not a well-formed token`);
	}
	return value;
}

function requireUuid(record: JsonRecord, key: string, what: string): string {
	const value = requireString(record, key, what);
	if (!isUuid(value)) {
		throw new ValidationError(`${what}.${key} is not a UUID`);
	}
	return value;
}

/** Optional nullable single-line string; undefined when absent, null or "". */
function optionalSingleLine(
	record: JsonRecord,
	key: string,
	what: string,
	maxLength: number,
): string | undefined {
	const value = record[key];
	if (value === undefined || value === null || value === "") {
		return undefined;
	}
	if (typeof value !== "string" || !isSingleLine(value, maxLength)) {
		throw new ValidationError(`${what}.${key} must be a single-line string`);
	}
	return value;
}

function requireTimestamp(
	record: JsonRecord,
	key: string,
	what: string,
): string {
	const value = requireString(record, key, what);
	if (!isSingleLine(value, MAX_TIMESTAMP_LENGTH)) {
		throw new ValidationError(`${what}.${key} is not a well-formed timestamp`);
	}
	return value;
}

// ---------------------------------------------------------------------------
// Credential validators
//
// Each validator rebuilds its result from known, checked fields only. Extra
// fields the API may add in future are dropped, never passed through.
// ---------------------------------------------------------------------------

export function validateAwsCredentials(value: unknown): IssuedAwsCredentials {
	const what = "aws";
	const record = asRecord(value, what);
	const awsConfirmationId = requireUuid(record, "awsConfirmationId", what);
	const awsAccessKeyId = requireString(record, "awsAccessKeyId", what);
	if (!isAwsAccessKeyId(awsAccessKeyId)) {
		throw new ValidationError(
			`${what}.awsAccessKeyId is not a well-formed AWS access key ID`,
		);
	}
	const awsSecretAccessKey = requireString(record, "awsSecretAccessKey", what);
	if (!isAwsSecretAccessKey(awsSecretAccessKey)) {
		throw new ValidationError(
			`${what}.awsSecretAccessKey is not a well-formed AWS secret access key`,
		);
	}
	const awsSessionToken = requireString(record, "awsSessionToken", what);
	if (!isAwsSessionToken(awsSessionToken)) {
		throw new ValidationError(
			`${what}.awsSessionToken is not a well-formed AWS session token`,
		);
	}
	const awsExpiration = requireTimestamp(record, "awsExpiration", what);
	return {
		awsConfirmationId,
		awsAccessKeyId,
		awsSecretAccessKey,
		awsSessionToken,
		awsExpiration,
	};
}

export function validateSshCredentials(value: unknown): IssuedSshCredentials {
	const what = "ssh";
	const record = asRecord(value, what);
	const sshConfirmationId = requireUuid(record, "sshConfirmationId", what);
	const sshIp = requireString(record, "sshIp", what);
	if (net.isIP(sshIp) === 0) {
		throw new ValidationError(
			`${what}.sshIp must be a valid IPv4 or IPv6 address`,
		);
	}
	const sshPrivateKey = requireString(record, "sshPrivateKey", what);
	if (!isBase64(sshPrivateKey, MAX_SSH_KEY_BASE64_LENGTH)) {
		throw new ValidationError(`${what}.sshPrivateKey must be base64`);
	}
	const sshPublicKey = requireString(record, "sshPublicKey", what);
	if (!isBase64(sshPublicKey, MAX_SSH_KEY_BASE64_LENGTH)) {
		throw new ValidationError(`${what}.sshPublicKey must be base64`);
	}
	// The decoded keys are written verbatim into ~/.ssh. They must look like
	// keys, not merely like text: a PEM/OpenSSH block and a one-line public
	// key are both rejected outright by OpenSSH's ssh_config parser, so even
	// if they were written to a file ssh reads as configuration they could
	// not carry directives such as "Match exec".
	const privateKeyText = Buffer.from(sshPrivateKey, "base64").toString("utf8");
	if (!isSshPrivateKeyText(privateKeyText)) {
		throw new ValidationError(
			`${what}.sshPrivateKey does not decode to a PEM or OpenSSH private key`,
		);
	}
	const publicKeyText = Buffer.from(sshPublicKey, "base64").toString("utf8");
	if (!isSshPublicKeyLine(publicKeyText)) {
		throw new ValidationError(
			`${what}.sshPublicKey does not decode to an OpenSSH public key line`,
		);
	}
	const sshExpiration = requireTimestamp(record, "sshExpiration", what);
	return {
		sshConfirmationId,
		sshIp,
		sshPrivateKey,
		sshPublicKey,
		sshExpiration,
	};
}

function validateStrategyGroup(
	record: JsonRecord,
	depth: number,
	what: string,
	onProblem: ProblemReporter,
): TolerantDeploymentStrategy[] {
	if (depth >= MAX_STRATEGY_DEPTH) {
		throw new ValidationError(
			`${what} nests strategies deeper than ${MAX_STRATEGY_DEPTH} levels`,
		);
	}
	const strategies = record.strategies;
	if (!Array.isArray(strategies)) {
		throw new ValidationError(`${what}.strategies must be an array`);
	}
	if (strategies.length > MAX_STRATEGIES_PER_GROUP) {
		throw new ValidationError(
			`${what}.strategies has more than ${MAX_STRATEGIES_PER_GROUP} entries`,
		);
	}
	const valid: TolerantDeploymentStrategy[] = [];
	strategies.forEach((candidate, i) => {
		try {
			valid.push(
				validateDeploymentStrategy(
					candidate,
					depth + 1,
					`${what}.strategies[${i}]`,
					onProblem,
				),
			);
		} catch (error) {
			// One bad candidate must not take the others down with it.
			onProblem(describe(error));
		}
	});
	return valid;
}

/** Callback for problems that were skipped rather than thrown. */
export type ProblemReporter = (message: string) => void;
const ignoreProblems: ProblemReporter = () => {};

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Validates a deployment strategy. Known strategies are checked field by
 * field and rebuilt from those fields only; unknown ones are reduced to
 * `{ strategy }`. Either way nothing unchecked can ride along. Inside an
 * any/all group an invalid candidate is dropped (reported via `onProblem`)
 * rather than failing the group.
 */
export function validateDeploymentStrategy(
	value: unknown,
	depth = 0,
	what = "credentials",
	onProblem: ProblemReporter = ignoreProblems,
): TolerantDeploymentStrategy {
	const record = asRecord(value, what);
	const strategy = requireString(record, "strategy", what);
	if (!isStrategyName(strategy)) {
		throw new ValidationError(`${what}.strategy is not a well-formed name`);
	}
	switch (strategy) {
		case "any": {
			const strategies = validateStrategyGroup(record, depth, what, onProblem);
			return { strategy, strategies } as AnyDeploymentStrategy<{
				strategy: string;
			}>;
		}
		case "all": {
			const strategies = validateStrategyGroup(record, depth, what, onProblem);
			return { strategy, strategies } as AllDeploymentStrategy<{
				strategy: string;
			}>;
		}
		case "npm-token": {
			const token = requireOpaqueToken(record, "token", what);
			return { strategy, token } satisfies NpmTokenDeploymentStrategy;
		}
		case "python-index": {
			const token = requireOpaqueToken(record, "token", what);
			// Spec: indexName and username are nullable; empty index name means
			// the index served at the domain root, username defaults to the
			// PyPI/devpi token convention.
			const indexName =
				optionalSingleLine(record, "indexName", what, 128) ?? "";
			const username = record.username;
			let result: ValidatedPythonIndexStrategy = { strategy, token, indexName };
			if (username !== undefined && username !== null) {
				if (typeof username !== "string" || !isOpaqueToken(username, 128)) {
					throw new ValidationError(
						`${what}.username is not a well-formed netrc login`,
					);
				}
				result = { ...result, username };
			}
			return result;
		}
		default:
			return { strategy };
	}
}

export function validateHttpCredentials(
	value: unknown,
	what = "http",
	onProblem: ProblemReporter = ignoreProblems,
): IssuedHttpCredentials {
	const record = asRecord(value, what);
	const confirmationId = requireUuid(record, "confirmationId", what);
	const browserDeploymentId = requireUuid(record, "browserDeploymentId", what);
	const hostNamesRaw = record.hostNames;
	if (!Array.isArray(hostNamesRaw)) {
		throw new ValidationError(`${what}.hostNames must be an array`);
	}
	if (hostNamesRaw.length > MAX_HOSTNAMES_PER_INSTANCE) {
		throw new ValidationError(
			`${what}.hostNames has more than ${MAX_HOSTNAMES_PER_INSTANCE} entries`,
		);
	}
	const hostNames = hostNamesRaw.map((h, i) => {
		if (typeof h !== "string" || !isCanaryHostname(h)) {
			throw new ValidationError(
				`${what}.hostNames[${i}] is not an acceptable canary hostname`,
			);
		}
		return h;
	});
	let expiresAt: string | null = null;
	if (record.expiresAt !== null && record.expiresAt !== undefined) {
		expiresAt = requireTimestamp(record, "expiresAt", what);
	}
	const credentials = validateDeploymentStrategy(
		record.credentials,
		0,
		`${what}.credentials`,
		onProblem,
	);
	return {
		confirmationId,
		browserDeploymentId,
		hostNames,
		expiresAt,
		credentials,
	};
}

/**
 * Validates the whole issue-credentials response.
 *
 * Validation is per part, never all-or-nothing: the API may start returning
 * new families, instances or strategies to pinned action versions, and a
 * malformed part must not stop the valid ones from being deployed. Anything
 * unknown or invalid is dropped and reported through `onProblem`; only a
 * body that is not an object at all is an error. The caller decides what to
 * do when nothing usable is left.
 */
export function validateIssuedCredentials(
	value: unknown,
	onProblem: ProblemReporter = ignoreProblems,
): IssuedCredentials {
	const what = "credentials response";
	const record = asRecord(value, what);
	for (const key of Object.keys(record)) {
		if (
			!(CREDENTIAL_FAMILIES as readonly string[]).includes(key) &&
			record[key] !== null
		) {
			onProblem(
				`${what} contains "${key}" credentials this action version does not support; ignoring them`,
			);
		}
	}

	const result: IssuedCredentials = {};
	if (record.aws !== undefined && record.aws !== null) {
		try {
			result.aws = validateAwsCredentials(record.aws);
		} catch (error) {
			onProblem(`Skipping AWS credentials: ${describe(error)}`);
		}
	}
	if (record.ssh !== undefined && record.ssh !== null) {
		try {
			result.ssh = validateSshCredentials(record.ssh);
		} catch (error) {
			onProblem(`Skipping SSH credentials: ${describe(error)}`);
		}
	}
	if (record.http !== undefined && record.http !== null) {
		const http = validateHttpInstances(record.http, onProblem);
		if (Object.keys(http).length > 0) {
			result.http = http;
		}
	}
	return result;
}

function validateHttpInstances(
	value: unknown,
	onProblem: ProblemReporter,
): Record<string, IssuedHttpCredentials> {
	const http: Record<string, IssuedHttpCredentials> = {};
	let entries: Array<[string, unknown]>;
	try {
		entries = Object.entries(asRecord(value, "http"));
	} catch (error) {
		onProblem(`Skipping HTTP credentials: ${describe(error)}`);
		return http;
	}
	if (entries.length > MAX_HTTP_INSTANCES) {
		onProblem(
			`http has more than ${MAX_HTTP_INSTANCES} instances; only the first ${MAX_HTTP_INSTANCES} are considered`,
		);
		entries = entries.slice(0, MAX_HTTP_INSTANCES);
	}
	for (const [instanceId, instance] of entries) {
		if (!isOpaqueToken(instanceId, 128)) {
			onProblem(
				`Skipping HTTP instance with an ill-formed id ${JSON.stringify(instanceId)}`,
			);
			continue;
		}
		try {
			http[instanceId] = validateHttpCredentials(
				instance,
				`http.${instanceId}`,
				onProblem,
			);
		} catch (error) {
			onProblem(`Skipping HTTP instance "${instanceId}": ${describe(error)}`);
		}
	}
	return http;
}

/** True when a validated response carries nothing this action can deploy. */
export function hasNoCredentials(creds: IssuedCredentials): boolean {
	return (
		!creds.aws &&
		!creds.ssh &&
		(!creds.http || Object.keys(creds.http).length === 0)
	);
}

export function parseIssuedCredentials(
	text: string,
	onProblem: ProblemReporter = ignoreProblems,
): IssuedCredentials {
	return validateIssuedCredentials(
		parseBoundedJson(text, "credentials response"),
		onProblem,
	);
}

// ---------------------------------------------------------------------------
// Config validators
// ---------------------------------------------------------------------------

export function validateConfig(
	value: unknown,
	onProblem: ProblemReporter = ignoreProblems,
): Config {
	const what = "config response";
	const record = asRecord(value, what);
	if (record.instances === undefined || record.instances === null) {
		return {};
	}
	if (!Array.isArray(record.instances)) {
		throw new ValidationError(`${what}.instances must be an array`);
	}
	if (record.instances.length > MAX_CONFIG_INSTANCES) {
		throw new ValidationError(
			`${what}.instances has more than ${MAX_CONFIG_INSTANCES} entries`,
		);
	}
	const instances: ConfigInstance[] = [];
	record.instances.forEach((item, i) => {
		const itemWhat = `${what}.instances[${i}]`;
		try {
			const instance = asRecord(item, itemWhat);
			instances.push({
				key: requireOpaqueToken(instance, "key", itemWhat),
				instanceId: requireOpaqueToken(instance, "instanceId", itemWhat),
			});
		} catch (error) {
			onProblem(`Skipping perimeter instance: ${describe(error)}`);
		}
	});
	return { instances };
}

export function parseConfig(
	text: string,
	onProblem: ProblemReporter = ignoreProblems,
): Config {
	return validateConfig(parseBoundedJson(text, "config response"), onProblem);
}

// ---------------------------------------------------------------------------
// Serializers. Each one re-validates its inputs so that a caller can never
// produce an extra section, key or directive, whatever it passes in.
// ---------------------------------------------------------------------------

const INI_SECTION_NAME = /^[A-Za-z0-9_-]+(?: [A-Za-z0-9_-]+)?$/u;
const INI_KEY = /^[a-z][a-z0-9_]*$/u;

/** Formats one INI section (`[header]` plus `key = value` lines). */
export function formatIniSection(
	header: string,
	entries: ReadonlyArray<readonly [string, string]>,
): string {
	if (!INI_SECTION_NAME.test(header)) {
		throw new ValidationError(`Invalid INI section name "${header}"`);
	}
	const lines = [`[${header}]`];
	for (const [key, value] of entries) {
		if (!INI_KEY.test(key)) {
			throw new ValidationError(`Invalid INI key "${key}"`);
		}
		if (
			!isSingleLine(value, MAX_AWS_SESSION_TOKEN_LENGTH) ||
			/\s/u.test(value) ||
			/[#;[\]"']/u.test(value)
		) {
			throw new ValidationError(`Invalid INI value for key "${key}"`);
		}
		lines.push(`${key} = ${value}`);
	}
	return lines.join("\n");
}

/** Formats a `//host/:_authToken=...` line for `.npmrc`. */
export function formatNpmrcAuthToken(hostname: string, token: string): string {
	if (!isCanaryHostname(hostname)) {
		throw new ValidationError(`Invalid npm registry hostname "${hostname}"`);
	}
	if (!isOpaqueToken(token)) {
		throw new ValidationError("Invalid npm auth token");
	}
	// Values containing equals signs must be wrapped in quotes.
	const value = token.includes("=") ? `"${token}"` : token;
	return `//${hostname}/:_authToken=${value}`;
}

/** Formats a `machine ... login ... password ...` entry for `.netrc`. */
export function formatNetrcEntry(
	hostname: string,
	login: string,
	password: string,
): string {
	if (!isCanaryHostname(hostname)) {
		throw new ValidationError(`Invalid netrc machine hostname "${hostname}"`);
	}
	if (!isOpaqueToken(login, 128)) {
		throw new ValidationError("Invalid netrc login");
	}
	if (!isOpaqueToken(password)) {
		throw new ValidationError("Invalid netrc password");
	}
	return [`machine ${hostname}`, `login ${login}`, `password ${password}`].join(
		"\n",
	);
}
