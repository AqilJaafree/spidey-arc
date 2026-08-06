#!/usr/bin/env bash
#
# Finish the Base -> Arc return leg once Circle has attested it.
#
#   RTX=<returnHome tx hash> ./script/return-finish.sh
#
# Polls the sandbox attestation for the Base burn (source domain 6), then on
# Arc: receiveMessage (mints USDC to the vault) -> recordBridgeArrival (books
# the arrival as idle and clears venue 2's in-flight flag). That last call is
# the counterpart to a synchronous exit — an async venue's capital returns as a
# CCTP mint, so nothing calls recordReturn and the Router books it explicitly.
#
# Standard-finality returns (finality 2000) wait for Base Sepolia HARD finality,
# ~15-20 min. Re-run this until it completes; it is idempotent up to the point a
# step lands.

set -euo pipefail

AR="${ARC_RPC_URL:-https://rpc.testnet.arc.network}"
BR="${BASE_SEPOLIA_RPC_URL:-https://base-sepolia-rpc.publicnode.com}"
PW="${KEYSTORE_PASSWORD:-$(grep '^PASSWORD=' ../.env | cut -d= -f2)}"
RTX="${RTX:?set RTX to the returnHome tx hash}"

MT_ARC=0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275   # MessageTransmitterV2 on Arc
ROUTER=0x09Bb87E6Ca168D6eD85e0682A39b22431600c9A8
VAULT=0x93Cd367f8ABEF789e8F6Bb1ce79eB0AB0153122f
USDC_ARC=0x3600000000000000000000000000000000000000
VENUE=2

send_arc() { for i in 1 2 3 4 5; do out=$(cast send --rpc-url "$AR" --account spidey-deployer --password "$PW" "$@" --json 2>&1) && { echo "$out"; return 0; }; echo "  retry $i..." >&2; sleep 8; done; echo "FAILED: $out" >&2; return 1; }

echo "== poll Base->Arc attestation (domain 6) =="
for i in $(seq 1 40); do
  J=$(curl -s "https://iris-api-sandbox.circle.com/v2/messages/6?transactionHash=$RTX")
  ST=$(echo "$J" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["messages"][0]["status"] if d.get("messages") else "none")' 2>/dev/null || echo err)
  echo "  [$i] $ST"
  [ "$ST" = "complete" ] && break
  sleep 20
done
[ "$ST" = "complete" ] || { echo "not attested yet; re-run later"; exit 0; }

MSG=$(echo "$J" | python3 -c 'import json,sys;print(json.load(sys.stdin)["messages"][0]["message"])')
ATT=$(echo "$J" | python3 -c 'import json,sys;print(json.load(sys.stdin)["messages"][0]["attestation"])')

echo "== receiveMessage on Arc (mints to vault) =="
send_arc $MT_ARC "receiveMessage(bytes,bytes)" "$MSG" "$ATT" \
  | python3 -c 'import json,sys;print("  tx:",json.load(sys.stdin)["transactionHash"])'
sleep 3
UNACC=$(cast call $USDC_ARC "balanceOf(address)(uint256)" $VAULT --rpc-url "$AR")
echo "  vault USDC balance now: $UNACC"

echo "== recordBridgeArrival(venue 2, 1 USDC) =="
send_arc $ROUTER "recordBridgeArrival(uint16,uint256)" $VENUE 1000000 \
  | python3 -c 'import json,sys;print("  tx:",json.load(sys.stdin)["transactionHash"])'
sleep 3
echo -n "  vault idle/pend: "; cast call $VAULT "assets()(uint128,uint128)" --rpc-url "$AR" | tr '\n' ' '; echo
echo -n "  venue 2 book:    "; cast call $VAULT "venues(uint16)(uint128,uint64,uint32,uint16,uint8,uint8)" $VENUE --rpc-url "$AR" | head -1
echo -n "  venue 2 pending: "; cast call $VAULT "isVenuePending(uint16)(bool)" $VENUE --rpc-url "$AR"
echo
echo "Round trip complete: 1 USDC Arc -> Base relay -> Arc, booked as idle."
