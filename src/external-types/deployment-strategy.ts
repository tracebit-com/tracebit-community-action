/** Defines the methods by which a credential may be deployed.
 * Each deployer implementation (e.g. the Tracebit CLI or Chrome Extension) may
 * implement any subset of these strategies.
 *
 * @see AnyDeploymentStrategy to use the first supported strategy to deploy the credential.
 * @see AllDeploymentStrategy to use multiple strategies to deploy the credential.
 */
export type DeploymentStrategy<UnknownStrategy = never> =
	| AnyDeploymentStrategy<UnknownStrategy>
	| AllDeploymentStrategy<UnknownStrategy>
	| WellKnownDeploymentStrategy
	| CustomDeploymentStrategy
	| CookieDeploymentStrategy
	| NpmTokenDeploymentStrategy
	| UsernamePasswordDeploymentStrategy
	| BrowserDeploymentStrategy
	| UnknownStrategy;

export type UnknownDeploymentStrategy = { strategy: string };

/** A {@link DeploymentStrategy} that tolerates unknown strategies from newer API versions. */
export type TolerantDeploymentStrategy =
	DeploymentStrategy<UnknownDeploymentStrategy>;

export type AnyDeploymentStrategy<UnknownStrategy = never> = {
	strategy: "any";
	strategies: DeploymentStrategy<UnknownStrategy>[];
};

export type AllDeploymentStrategy<UnknownStrategy = never> = {
	strategy: "all";
	strategies: DeploymentStrategy<UnknownStrategy>[];
};

export type CustomDeploymentStrategy = {
	strategy: "custom";
	config: JsonObject;
};

export type WellKnownDeploymentStrategy = {
	strategy: "well-known";
} & JsonObject;

export type CookieDeploymentStrategy = { strategy: "cookie"; cookie: Cookie };
export type Cookie = {
	name: string;
	value: string;
	path: string;
	secure: boolean;
	httpOnly: boolean;
	sameSite: "Strict" | "Lax" | "None";
	expirationDate: Date | undefined;
};

/** Deploys a canary credential as an npm registry bearer token, scoped to
 * the hostname of the canary instance. Deployers should write this as
 * an `_authToken` entry in `.npmrc` (or an equivalent MDM-managed config,
 * env var, or CI secret).
 * @see https://docs.npmjs.com/cli/configuring-npm/npmrc */
export type NpmTokenDeploymentStrategy = {
	strategy: "npm-token";
	token: string;
};

export type BrowserDeploymentStrategy = {
	strategy: "browser";
};

export type UsernamePasswordDeploymentStrategy = {
	strategy: "username-password";
};

// An object that can be serialized to JSON
export type JsonObject = { [key in string]: Json };
export type Json = string | number | boolean | null | Json[] | JsonObject;
