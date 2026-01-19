#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"

if [ -f "$repo_root/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$repo_root/.env"
  set +a
fi

: "${INPUT_CUSTOMER_ID:?Set INPUT_CUSTOMER_ID}"
: "${INPUT_API_TOKEN:?Set INPUT_API_TOKEN}"
: "${INPUT_PROFILE:?Set INPUT_PROFILE}"
: "${INPUT_PROFILE_REGION:?Set INPUT_PROFILE_REGION}"

export GITHUB_REF="${GITHUB_REF:-refs/heads/main}"
export GITHUB_REPOSITORY="${GITHUB_REPOSITORY:-local/tracebit-action}"
export GITHUB_RUN_ID="${GITHUB_RUN_ID:-000000}"
export GITHUB_SHA="${GITHUB_SHA:-localsha}"
export GITHUB_WORKFLOW="${GITHUB_WORKFLOW:-local-test}"
export GITHUB_JOB="${GITHUB_JOB:-local-job}"

OUTPUT_FILE="$(mktemp)"
ENV_FILE="$(mktemp)"

export GITHUB_OUTPUT="$OUTPUT_FILE"
export GITHUB_ENV="$ENV_FILE"

echo "Running..."
node dist/index.js

echo "Outputs file: $GITHUB_OUTPUT"
cat "$GITHUB_OUTPUT"
