#!/usr/bin/env sh
set -eu

REPO_URL="${1:-}"
TARGET_DIR="${2:-agent-status}"

if [ -n "$REPO_URL" ]; then
  if ! command -v git >/dev/null 2>&1; then
    echo "Error: git is not installed or not in PATH."
    exit 1
  fi

  if [ -e "$TARGET_DIR" ]; then
    echo "Error: target directory already exists: $TARGET_DIR"
    exit 1
  fi

  echo "[0/4] Cloning repository..."
  git clone "$REPO_URL" "$TARGET_DIR"
  cd "$TARGET_DIR"
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "Error: Bun is not installed or not in PATH."
  echo "Install Bun: https://bun.sh"
  exit 1
fi

echo "[1/4] Installing dependencies..."
bun install

echo "[2/4] Building standalone binary..."
bun run build

echo "[3/4] Linking CLI globally..."
bun link

echo "Installation complete. Run: agent-status"
