#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"

# Default output directory
OUTPUT_DIR="${1:-$repo_root/release}"
PACKAGE_NAME="tracebit-github-action"

echo "Packaging $PACKAGE_NAME..."

# Clean and create output directory
rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"

# Build the action first
echo "Building..."
cd "$repo_root"
bun run build

# Copy required files
echo "Copying files..."

# dist/ - compiled JavaScript (required)
cp -r "$repo_root/dist" "$OUTPUT_DIR/"

# src/ - source code (excluding tests)
mkdir -p "$OUTPUT_DIR/src"
find "$repo_root/src" -maxdepth 1 -name "*.ts" ! -name "*.test.ts" -exec cp {} "$OUTPUT_DIR/src/" \;

# action.yaml - GitHub Action manifest (required)
cp "$repo_root/action.yaml" "$OUTPUT_DIR/"

# package.json and lock file
cp "$repo_root/package.json" "$OUTPUT_DIR/"
cp "$repo_root/bun.lock" "$OUTPUT_DIR/"

# tsconfig.json
cp "$repo_root/tsconfig.json" "$OUTPUT_DIR/"

# Create a zip file
ZIPFILE="$repo_root/$PACKAGE_NAME.zip"
echo "Creating zip: $ZIPFILE"
cd "$OUTPUT_DIR"
zip -rq "$ZIPFILE" .

echo ""
echo "Package created successfully!"
echo ""
echo "Contents:"
ls -la "$OUTPUT_DIR"
echo ""
echo "Archive:"
ls -lh "$ZIPFILE"
