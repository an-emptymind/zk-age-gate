#!/usr/bin/env bash
# Downloads the pinned circom compiler into ./bin. Run once after cloning.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="v2.2.3"
case "$(uname -s)" in
  Darwin) ASSET="circom-macos-amd64" ;;   # runs on Apple Silicon via Rosetta
  Linux)  ASSET="circom-linux-amd64" ;;
  *)      echo "unsupported platform: $(uname -s)"; exit 1 ;;
esac
mkdir -p bin
echo "  downloading circom ${VERSION} (${ASSET})…"
curl -sL -o bin/circom "https://github.com/iden3/circom/releases/download/${VERSION}/${ASSET}"
chmod +x bin/circom
echo "  $(./bin/circom --version)"
