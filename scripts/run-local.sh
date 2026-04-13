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
: "${INPUT_ASYNC:?Set INPUT_ASYNC}"

# Use a temporary HOME so we never touch the real ~/.aws files
FAKE_HOME="$(mktemp -d)"
cleanup() {
  rm -rf "$FAKE_HOME"
}
trap cleanup EXIT

export HOME="$FAKE_HOME"
export AWS_CONFIG_FILE="$FAKE_HOME/.aws/config"
export AWS_SHARED_CREDENTIALS_FILE="$FAKE_HOME/.aws/credentials"

export GITHUB_REF="${GITHUB_REF:-refs/heads/main}"
export GITHUB_REPOSITORY="${GITHUB_REPOSITORY:-local/tracebit-action}"
export GITHUB_RUN_ID="${GITHUB_RUN_ID:-000000}"
export GITHUB_SHA="${GITHUB_SHA:-localsha}"
export GITHUB_WORKFLOW="${GITHUB_WORKFLOW:-local-test}"
export GITHUB_JOB="${GITHUB_JOB:-local-job}"

OUTPUT_FILE="$(mktemp)"
ENV_FILE="$(mktemp)"
STATE_FILE="$(mktemp)"

export GITHUB_OUTPUT="$OUTPUT_FILE"
export GITHUB_ENV="$ENV_FILE"
export GITHUB_STATE="$STATE_FILE"

# Helper function to parse GitHub Actions file format
# Format: KEY<<ghadelimiter_<uuid>\nVALUE\nghadelimiter_<uuid>
# Arguments:
#   $1 - file path to parse
#   $2 - prefix for exported variables (empty for GITHUB_ENV, "STATE_" for GITHUB_STATE)
source_github_file() {
  local file="$1"
  local prefix="${2:-}"

  if [ ! -s "$file" ]; then
    return
  fi

  local key=""
  local value=""
  local delimiter=""
  local in_value=false

  while IFS= read -r line || [ -n "$line" ]; do
    if [ "$in_value" = false ]; then
      # Look for KEY<<delimiter pattern
      if [[ "$line" =~ ^([^=]+)\<\<(.+)$ ]]; then
        key="${BASH_REMATCH[1]}"
        delimiter="${BASH_REMATCH[2]}"
        value=""
        in_value=true
      fi
    else
      # Check if this line is the closing delimiter
      if [ "$line" = "$delimiter" ]; then
        # Remove trailing newline from value if present
        value="${value%$'\n'}"
        export "${prefix}${key//-/_}=$value"
        in_value=false
        key=""
        value=""
        delimiter=""
      else
        # Append to value (with newline if not first line)
        if [ -n "$value" ]; then
          value="$value"$'\n'"$line"
        else
          value="$line"
        fi
      fi
    fi
  done < "$file"
}

# Helper functions for sourcing env and state files
source_github_env() {
  source_github_file "$GITHUB_ENV" ""
}

source_github_state() {
  source_github_file "$GITHUB_STATE" "STATE_"
}

echo -e "Running pre step...\n"
node dist/pre.js
source_github_env
# WARN: the state gets passed only to the post step by the runner, not to the main step

echo -e "\n--------------------------------\n"

echo -e "Running main step...\n"
node dist/index.js
source_github_env
source_github_state

echo -e "\n--------------------------------\n"

if [ "${INPUT_ASYNC}" = "true" ]; then
  echo -e "Running post step...\n"
  node dist/post.js
  source_github_env
fi

echo -e "\n--------------------------------\n"

echo -e "Outputs file: $GITHUB_OUTPUT\n"
cat "$GITHUB_OUTPUT"

echo -e "\n--------------------------------\n"

echo -e "Environment file: $GITHUB_ENV\n"
cat "$GITHUB_ENV"

echo -e "\n--------------------------------\n"

echo -e "State file: $GITHUB_STATE\n"
cat "$GITHUB_STATE"

echo -e "\n--------------------------------\n"

echo -e "AWS config ($AWS_CONFIG_FILE):\n"
cat "$AWS_CONFIG_FILE" 2>/dev/null || echo "(not created)"

echo -e "\n--------------------------------\n"

echo -e "AWS credentials ($AWS_SHARED_CREDENTIALS_FILE):\n"
cat "$AWS_SHARED_CREDENTIALS_FILE" 2>/dev/null || echo "(not created)"
