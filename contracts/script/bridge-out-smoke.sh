#!/usr/bin/env bash
#
# One real dollar out of Arc, through the whole stack.
#
#   deposit -> postScores -> deployIdle
#
# the smallest sequence that exercises every on-chain gate the hub has: the
# deposit cap, the score proof, the APY bound, the venue registry, the executor
# lookup, and `isSynchronous()` flagging the capital as in flight. The CCTP burn
# is the last thing `deployIdle` does.
#
#   ./script/bridge-out-smoke.sh            # $1 USDC
#   AMOUNT=2000000 ./script/bridge-out-smoke.sh
#
# ---------------------------------------------------------------------------
# Why this is a shell script and not a `forge script`
# ---------------------------------------------------------------------------
#
# `forge script` executes the script body locally against a fork before it
# broadcasts anything. Arc's USDC (0x36..00, delegating to 0xC6AD66..) calls
# `isBlocklisted` on a precompile at 0x1800000000000000000000000000000000000001
# for every transfer. That precompile is implemented by the node, not in EVM
# bytecode — `cast code` returns nothing to fork, while `cast call` against a
# live RPC answers `false` correctly.
#
# So the local fork has an address with no code where the token expects a
# contract, and every Arc USDC movement dies in simulation:
#
#   0x1800..01::isBlocklisted(..) -> [StackUnderflow] EvmError: StackUnderflow
#
# No `forge script` can move USDC on Arc, and neither can a fork test.
# `cast send` submits straight to the node, which has the precompile. Each call
# below prompts for the keystore password; add `--password-file <path>` if four
# prompts is three too many.

set -euo pipefail

RPC="${ARC_RPC_URL:-https://rpc.testnet.arc.network}"
ACCOUNT="${ACCOUNT:-spidey-deployer}"
AMOUNT="${AMOUNT:-1000000}" # 1 USDC, 6dp

USDC=0x3600000000000000000000000000000000000000
VAULT=0x93Cd367f8ABEF789e8F6Bb1ce79eB0AB0153122f
ORACLE=0xb7DB9Ee5Ee46EB608d9a3A4DCc843230dD63b621
ROUTER=0x09Bb87E6Ca168D6eD85e0682A39b22431600c9A8
ME=0x9e5fdE1f7484096A9beCDBb956A05834eC581195

VENUE=2        # Base Sepolia, registered with chainDomain 6
SCORE_BPS=5000
NET_APY_BPS=900

# Standard transfer (2000), not fast (1000). Standard is free on CCTP v2, so a
# zero fee cap is the honest bound rather than a hopeful one — and §7.5's
# payback rule already prices the extra wait.
ENTER_DATA=$(cast abi-encode "f(uint256,uint32)" 0 2000)

# Interactive by default (one password prompt per tx). Set KEYSTORE_PASSWORD to
# run unattended — e.g. `KEYSTORE_PASSWORD=$(grep '^PASSWORD=' ../.env | cut -d= -f2)`.
PW="${KEYSTORE_PASSWORD:-}"
send() {
  if [ -n "$PW" ]; then
    cast send --rpc-url "$RPC" --account "$ACCOUNT" --password "$PW" "$@"
  else
    cast send --rpc-url "$RPC" --account "$ACCOUNT" "$@"
  fi
}

echo "== before =="
cast call $USDC "balanceOf(address)(uint256)" $ME --rpc-url "$RPC"

echo "== 1/4 approve =="
send $USDC "approve(address,uint256)" $VAULT "$AMOUNT" >/dev/null

echo "== 2/4 deposit =="
send $VAULT "deposit(uint256,address)" "$AMOUNT" $ME >/dev/null

# A single-leaf Merkle tree, so root == leaf and the proof is empty. That is
# legitimate rather than a shortcut: `MerkleProof.verify` with an empty proof is
# exactly the one-venue case, and this deployment ranks one venue.
ASOF=$(cast block latest --field timestamp --rpc-url "$RPC")
LEAF=$(cast call $ORACLE "leafHash(uint16,uint32,uint32,uint64)(bytes32)" \
  $VENUE $SCORE_BPS $NET_APY_BPS "$ASOF" --rpc-url "$RPC")

echo "== 3/4 postScores (asOf $ASOF, root $LEAF) =="
send $ORACLE "postScores(bytes32,uint64,string)" "$LEAF" "$ASOF" "ipfs://smoke" >/dev/null

echo "== 4/4 deployIdle -> CCTP burn toward domain 6 =="
BURN_TX=$(send $ROUTER \
  "deployIdle(uint16,uint256,uint32,uint32,bytes32[],bytes)" \
  $VENUE "$AMOUNT" $NET_APY_BPS $SCORE_BPS "[]" "$ENTER_DATA" \
  --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["transactionHash"])')

echo
echo "== after =="
echo "burn tx:        $BURN_TX"
echo -n "vault idle/pend: "; cast call $VAULT "assets()(uint128,uint128)" --rpc-url "$RPC" | tr '\n' ' '
echo
echo -n "venue 2 book:    "; cast call $VAULT "venues(uint16)(uint128,uint64,uint32,uint16,uint8,uint8)" $VENUE --rpc-url "$RPC" | head -1
echo -n "venue 2 pending: "; cast call $VAULT "isVenuePending(uint16)(bool)" $VENUE --rpc-url "$RPC"
echo
echo "Attestation (testnet is the SANDBOX host; production 404s these):"
echo "  curl -s 'https://iris-api-sandbox.circle.com/v2/messages/26?transactionHash=$BURN_TX' | jq"
echo
echo "The mint lands at the Base relay 0x280aD956FFFd3ABba3db59397BE7c4d4d04D32D4,"
echo "whose only exit is back to Arc via relay.returnHome()."
