#!/usr/bin/env bash
#
# Deploys Groth16Verifier + CourseGate to Sepolia and verifies the source on
# Etherscan. Run once; the addresses land in build/deployment-sepolia.json.
#
#   cp .env.example .env     # fill in PRIVATE_KEY (+ ETHERSCAN_API_KEY)
#   npm run deploy:sepolia
#
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env ] || { echo "no .env — run:  cp .env.example .env  and fill it in"; exit 1; }
set -a; source .env; set +a

: "${SEPOLIA_RPC_URL:?set SEPOLIA_RPC_URL in .env}"
: "${PRIVATE_KEY:?set PRIVATE_KEY in .env}"

say() { printf "\n\033[1m%s\033[0m\n%s\n" "$1" "────────────────────────────────────────────────────────────"; }
kv()  { printf "  %-24s %s\n" "$1" "$2"; }

# ---------------------------------------------------------------- preflight
say "0 · preflight"
[ -f build/root.json ] || { echo "  build/root.json missing — run 'npm run tree' first"; exit 1; }
[ -f build/agegate_final.zkey ] || { echo "  proving key missing — run 'npm run setup' first"; exit 1; }

ROOT=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("build/root.json")).root)')
DEPLOYER=$(cast wallet address --private-key "$PRIVATE_KEY")
CHAIN=$(cast chain-id --rpc-url "$SEPOLIA_RPC_URL")
BAL=$(cast balance "$DEPLOYER" --rpc-url "$SEPOLIA_RPC_URL")

kv "deployer" "$DEPLOYER"
kv "chain id" "$CHAIN"
kv "balance" "$(cast from-wei "$BAL") ETH"
kv "registry root" "${ROOT:0:24}…"

[ "$CHAIN" = "11155111" ] || { echo "  RPC is not Sepolia (chain $CHAIN)"; exit 1; }
if [ "$BAL" = "0" ]; then
  echo "  deployer has no Sepolia ETH — fund it at https://sepoliafaucet.com"; exit 1
fi

VERIFY_FLAGS=()
if [ -n "${ETHERSCAN_API_KEY:-}" ]; then
  VERIFY_FLAGS=(--verify --etherscan-api-key "$ETHERSCAN_API_KEY")
  kv "etherscan" "key present — source will be verified"
else
  kv "etherscan" "no key — deploying WITHOUT source verification"
fi

# ---------------------------------------------------------------- verifier
say "1 · Groth16Verifier  (the maths — generated from the .zkey)"
V_OUT=$(forge create contracts/src/Verifier.sol:Groth16Verifier \
  --rpc-url "$SEPOLIA_RPC_URL" --private-key "$PRIVATE_KEY" \
  --broadcast --json "${VERIFY_FLAGS[@]}")
VERIFIER=$(echo "$V_OUT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const m=s.match(/"deployedTo"\s*:\s*"(0x[0-9a-fA-F]{40})"/);console.log(m?m[1]:"")})')
[ -n "$VERIFIER" ] || { echo "  deployment failed:"; echo "$V_OUT"; exit 1; }
kv "deployed at" "$VERIFIER"
kv "etherscan" "https://sepolia.etherscan.io/address/$VERIFIER"

# ---------------------------------------------------------------- gate
say "2 · CourseGate  (the policy — root and threshold pinned here)"
kv "constructor arg 1" "$VERIFIER"
kv "constructor arg 2" "$ROOT"
G_OUT=$(forge create contracts/src/CourseGate.sol:CourseGate \
  --rpc-url "$SEPOLIA_RPC_URL" --private-key "$PRIVATE_KEY" \
  --broadcast --json "${VERIFY_FLAGS[@]}" \
  --constructor-args "$VERIFIER" "$ROOT")
GATE=$(echo "$G_OUT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const m=s.match(/"deployedTo"\s*:\s*"(0x[0-9a-fA-F]{40})"/);console.log(m?m[1]:"")})')
[ -n "$GATE" ] || { echo "  deployment failed:"; echo "$G_OUT"; exit 1; }
kv "deployed at" "$GATE"
kv "etherscan" "https://sepolia.etherscan.io/address/$GATE"

# ---------------------------------------------------------------- record
node -e "
const fs=require('fs');
fs.writeFileSync('build/deployment-sepolia.json', JSON.stringify({
  network:'sepolia', chainId:11155111,
  verifier:'$VERIFIER', courseGate:'$GATE',
  registryRoot:'$ROOT', deployer:'$DEPLOYER',
  deployedAt:new Date().toISOString()
},null,2)+'\n');
"

say "3 · on-chain sanity check"
kv "gate.registryRoot()" "$(cast call "$GATE" 'registryRoot()(uint256)' --rpc-url "$SEPOLIA_RPC_URL")"
kv "gate.AGE_THRESHOLD()" "$(cast call "$GATE" 'AGE_THRESHOLD()(uint256)' --rpc-url "$SEPOLIA_RPC_URL")"
kv "gate.verifier()" "$(cast call "$GATE" 'verifier()(address)' --rpc-url "$SEPOLIA_RPC_URL")"

say "done"
kv "saved to" "build/deployment-sepolia.json"
printf "\n  next:  npm run live -- 1      # enrol student 1 on Sepolia\n\n"

if [ -z "${ETHERSCAN_API_KEY:-}" ]; then
  printf "  to verify source later, add ETHERSCAN_API_KEY to .env then run:\n"
  printf "    forge verify-contract %s contracts/src/Verifier.sol:Groth16Verifier --chain sepolia\n" "$VERIFIER"
  printf "    forge verify-contract %s contracts/src/CourseGate.sol:CourseGate --chain sepolia \\\\\n" "$GATE"
  printf "      --constructor-args \$(cast abi-encode 'c(address,uint256)' %s %s)\n\n" "$VERIFIER" "$ROOT"
fi
