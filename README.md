# Tracebit GitHub Action

This Action safely and automatically injects AWS canary credentials (honeytokens) into your build pipelines to detect supply chain attacks. Using [Tracebit](https://tracebit.com) you can quickly pinpoint the exact workflow involved in the credential compromise.

## Why use this action?

CI/CD pipelines are a high-value target. Attackers who compromise a workflow - through a malicious dependency, a poisoned runner, or a stolen repository secret - will look for credentials they can exfiltrate and use elsewhere.

This action plants AWS canary credentials directly into every workflow run. The credentials are real AWS keys and any attempt to use them triggers an alert in Tracebit. You get immediate, high-confidence signal that something has gone wrong - no tuning, no false positives.

## What attacks does it catch?

- **Supply chain attacks**:
  - **Compromised packages**: a malicious npm/pip/etc. package that exfiltrates environment variables or AWS credential files during `npm install` or a build step
  - **Compromised GitHub Actions** - a third-party action in your workflow that leaks credentials it finds on the runner
- **CI/CD secret theft** - an attacker who has obtained your runner's environment and is probing for usable credentials
  
- **Credential exfiltration via log injection** - credentials that leak into build logs and are harvested
- **Insider threats** - a developer or bot token that copies CI/CD secrets for use outside the pipeline

Because the canary credentials are unique per run and tagged with the repo, workflow, job, SHA, and run ID, Tracebit can tell you exactly which pipeline run was compromised and when.

## Real-world attacks this would have caught

| Attack | Date | Vector | How credentials were stolen | How Tracebit canaries would have detected it |
|--------|------|--------|----------------------------|----------------------------------------------|
| **tj-actions/changed-files** (CVE-2025-30066) | Mar 2025 | Compromised GitHub Action; all version tags re-pointed to malicious commit | Dumped runner memory to harvest GitHub secrets, printed base64-encoded secrets to workflow logs | Canary AWS creds in runner memory would be captured by the memory dump. Any attempt to use the exfiltrated canary keys triggers an immediate Tracebit alert, even if they were only dumped to logs and later harvested. |
| **Trivy + trivy-action + setup-trivy** (TeamPCP) | Mar 19, 2026 | Compromised Aqua `aqua-bot` service account; 75+ action tags force-pushed to malicious versions | Three-stage payload: read `/proc/<pid>/mem` for secrets, swept `~/.aws/` and 50+ credential file paths, exfiltrated encrypted bundle to typosquatted C2 domain | On GitHub-hosted Linux runners, the payload scraped `Runner.Worker` process memory via `/proc/<pid>/mem` for GitHub secrets. On all other environments, it targeted `~/.aws/credentials` and 50+ credential file paths on. Tracebit canary keys would be collected in either case. |
| **Checkmarx KICS GitHub Action** (TeamPCP) | Mar 23, 2026 | Compromised `cx-plugins-releases` service account; all 35 action tags re-pointed | Harvested env vars, SSH keys, cloud creds; dumped `Runner.Worker` process memory via `/proc/<pid>/mem`; queried AWS IMDS for cloud credentials | Same credential harvesting as Trivy attack: canary AWS keys in `~/.aws/credentials` and process memory would all be collected. |
| **LiteLLM PyPI package** (TeamPCP) | Mar 24, 2026 | Trojanized PyPI versions 1.82.7 & 1.82.8; triggered on import or via `.pth` file on every Python invocation | Swept `~/.aws/`, env vars, Kubernetes configs; **actively called AWS Secrets Manager and SSM Parameter Store** using harvested creds; exfiltrated to `models.litellm.cloud` | The malware didn't just steal credentials, it **actively called AWS APIs** (ListSecrets, GetSecretValue, DescribeParameters) with any AWS keys it found. Tracebit canary keys in `~/.aws/credentials` or env vars would be used in these API calls, generating an high-confidence alert the moment the malware attempts to authenticate. |

1. https://www.wiz.io/blog/trivy-compromised-teampcp-supply-chain-attack
2. https://www.wiz.io/blog/teampcp-attack-kics-github-action
3. https://www.stepsecurity.io/blog/litellm-credential-stealer-hidden-in-pypi-wheel
4. https://www.stepsecurity.io/blog/harden-runner-detection-tj-actions-changed-files-action-is-compromised

## How it works

1. At the start of your workflow, the action calls the Tracebit API to issue a short-lived set of canary AWS credentials.
2. The credentials are written to `~/.aws/credentials`, exported as environment variables, and held in the runner process's memory - covering every common exfiltration surface: credential files, environment variable dumps, and process memory scraping.
3. Tracebit monitors for any use of those credentials. If they are used, you get an alert with full context.
4. At the end of the workflow run, the action confirms to Tracebit that the run completed normally. This closes the expected activity window and means any future use of those credentials is immediately flagged as suspicious.

The action runs blocking by default. Use (`async: true`) if you have strict latency requirements for your pipelines.

## Prerequisites: Tracebit Community Edition

You need a Tracebit account to use this action. Sign up for **Tracebit Community Edition** (free forever) - to get your `api-token`:

**[Register for Tracebit Community Edition →](https://community.tracebit.com/join)**

Once registered, the Tracebit dashboard shows you:
- Which repositories and workflows have canary coverage
- A real-time alert feed if any canary credential is used
- The full context of each alert: repo, workflow, job, commit SHA, and run ID

## Quickstart

### 1. Store your credentials as GitHub secrets

After registering, add the following to your repository or organization:

| Type | Name | Value |
|------|------|-------|
| Secret | `SECURITY_API_TOKEN` | Your Tracebit API token |

### 2. Add the action to your workflow

Insert the action **before** any step that runs untrusted code (dependency installs, build scripts, test runners):

```yaml
- name: Issue credentials
  uses: tracebit-com/tracebit-community-action@main
  continue-on-error: true
  with:
    api-token: ${{ secrets.SECURITY_API_TOKEN }}
    profile: administrator
    profile-region: us-east-1
    async: true
```

`continue-on-error: true` ensures a Tracebit outage never blocks your pipeline but should not be necessary.

### Full workflow example

```yaml
name: CI

on:
  push:
  pull_request:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6

      - name: Issue credentials
        uses: tracebit-com/tracebit-community-action@main
        continue-on-error: true
        with:
          api-token: ${{ secrets.SECURITY_API_TOKEN }}
          profile: administrator
          profile-region: us-east-1
          async: true

      # Your normal build steps follow - the canary credentials are now live
      - run: npm ci
      - run: npm test
```

## Enabling across your GitHub organization

To roll out canary coverage to every repository in your organization without updating each workflow individually, you can use the Tracebit Community Edition's GitHub integration which lets you monitor your coverage and open Pull Requests across all of your repositories, that would add this action at the appropriate place.

To configure the credentials once for the whole organization:

1. Go to your organization's **Settings → Secrets and variables → Actions**.
2. Add `SECURITY_API_TOKEN` as an **organization secret**, scoped to the repositories you want to protect.

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `customer-id` | No | `community` | Your Tracebit customer ID |
| `api-token` | Yes | - | Your Tracebit API token |
| `profile` | Yes | - | AWS profile name to write to `~/.aws/credentials` |
| `profile-region` | Yes | - | AWS region to configure for the profile |
| `async` | No | `false` | Run the credential issuance in the background so subsequent steps are not delayed. Recommended. |

## Outputs

| Output | Description |
|--------|-------------|
| `aws-access-key-id` | The canary access key ID |
| `aws-secret-access-key` | The canary secret access key |
| `aws-session-token` | The canary session token |
| `profile-name` | The AWS profile name that was written |

## Contributing

### Build

You need [Bun](https://bun.sh) 1.3.8:

```bash
curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.8"
```

Build the bundle:

```bash
bun run build
# commit src/index.ts + dist/index.js together
```

### Local run

Create a `.env` file at the repo root:

```bash
INPUT_API_TOKEN=your-api-token
INPUT_PROFILE=administrator
INPUT_PROFILE_REGION=us-east-1
INPUT_ASYNC=true
```

Then run:

```bash
npm run run:local
```

Requires Node 24+.
