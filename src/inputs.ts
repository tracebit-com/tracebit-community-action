import * as core from "@actions/core";

const DEFAULT_API_HOST = "tracebit.com";
const DEFAULT_ENV_PREFIX = "__AWS__";

function getInputFallback(
	name: string,
	required: boolean,
	defaultValue = "",
): string {
	const value = core.getInput(name);
	if (value) {
		return value;
	}

	const normalized = name.replace(/[^A-Za-z0-9_]/g, "_").toUpperCase();
	const envValue = process.env[`INPUT_${normalized}`];

	if (envValue !== undefined) {
		return envValue;
	}

	if (required) {
		throw new Error(`Input required and not supplied: ${name}`);
	}

	return defaultValue;
}

export function isValidRegion(region: string): boolean {
	return /^[a-z]+-[a-z0-9-]+-\d+$/u.test(region);
}

export interface Inputs {
	customerId: string;
	apiHost: string;
	apiToken: string;
	profileName: string;
	region: string;
	envPrefix: string;
	runAsync: boolean;
}

export function getInputs(): Inputs {
	const customerId = getInputFallback("customer-id", false, "community");
	const apiHost = getInputFallback("api-host", false, DEFAULT_API_HOST);
	const apiToken = getInputFallback("api-token", true);
	const profileName = getInputFallback("profile", true);
	const region = getInputFallback("profile-region", true);
	const runAsync = getInputFallback("async", false) === "true";

	if (!isValidRegion(region)) {
		core.warning(
			`Region ${region} format doesn't pass validation, it might be wrong`,
		);
	}

	return {
		customerId,
		apiHost,
		apiToken,
		profileName,
		region,
		envPrefix: DEFAULT_ENV_PREFIX,
		runAsync,
	};
}
