# Tracebit GitHub Action (Node)

This repository contains a Node.js GitHub Action that issues Tracebit AWS credentials and optionally writes an AWS profile + exports environment variables. The action is bundled with Bun and committed to `dist/` so it can run directly in other repositories.

## Inputs

- `customer-id` (required): Tracebit customer id.
- `api-token` (required): Tracebit API token.
- `profile` (required): AWS profile name to write.
- `profile-region` (required): AWS region to configure for the profile.
- `async` (optional): Run the action in the background without making the other steps wait for it to finish. Using this option creates a race condition where env variables might not be expored in time. We recommend you insert this action. We recommend inserting this action before any risky step in your workflow to reduce the risk of this happening.

## Outputs

- `aws-access-key-id`
- `aws-secret-access-key`
- `aws-session-token`
- `profile-name`

## Use in other repositories

Reference this action by repo and ref (tag/branch/sha):

```yaml
- name: Issue credentials
  uses: tracebit-com/tracebit-github-action@main
  continue-on-error: true
  with:
    customer-id: ${{ vars.SECURITY_CUSTOMER_ID }}
    api-token: ${{ secrets.SECURITY_API_TOKEN }}
    profile: administrator
    profile-region: us-east-1
    async: true
```

## Enable in organization settings

If the action lives in a private repository, make sure it is allowed for use across the organization:

1. Go to the organization settings.
2. Open Actions > General.
3. Under "Access", allow the repository containing this action to be used by other repositories in your organization.
4. Ensure the target repository is permitted to use private actions.

## [Install Bun](https://bun.com/docs/installation)

You need Bun 1.3.8 to build the bundle locally.

```bash
curl -fsSL https://bun.com/install | bash -s "bun-v1.3.8"
```

Then restart your shell and verify it's using the correct version:

```bash
bun --version
```

## Local run

The bundled action can be run locally by using the provided script. It loads `.env` from the repo root if present.

```bash
# .env (not committed)
INPUT_CUSTOMER_ID=your-customer-id
INPUT_API_TOKEN=your-api-token
INPUT_PROFILE=administrator
INPUT_PROFILE_REGION=us-east-1
INPUT_ASYNC=true

npm run run:local
# or
bun run run:local
```

Notes:

- Requires Node 24+.
- The script uses the AWS CLI when writing the profile.
- It makes real HTTP requests to the Tracebit API endpoints.

## Build and commit

Whenever you change `src/index.ts`, rebuild the bundle and commit the output:

```bash
bun run build
# commit src/index.ts + dist/index.js together
```

The action entry point is `dist/index.js` as specified in `action.yaml`.
