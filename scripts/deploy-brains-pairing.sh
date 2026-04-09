#!/usr/bin/env bash
#
# deploy-brains-pairing.sh
#
# Safe upgrade deploy for the brains_pairing program on X1 mainnet.
#
# WHY THIS SCRIPT EXISTS:
#   The local target/deploy/brains_pairing-keypair.json does NOT match
#   the on-chain program ID (DNSefSAJ41Fm3ijmEug8tkDYJrHDwYGVtFtn8wwvbgJM).
#   It was regenerated during the Anchor 0.31 -> 0.32 upgrade and the
#   original keypair was never backed up.
#
#   This means `anchor deploy` will silently try to deploy to the WRONG
#   address (a ghost program) and burn rent for nothing.
#
#   This script bypasses anchor's deploy flow entirely and uses raw
#   `solana program deploy --program-id` with the on-chain upgrade
#   authority, which is the only thing that matters for upgrades.
#
# USAGE:
#   ./scripts/deploy-brains-pairing.sh           # interactive
#   ./scripts/deploy-brains-pairing.sh --yes     # skip confirmation
#   ./scripts/deploy-brains-pairing.sh --dry-run # checks only, no deploy
#
set -euo pipefail

# ---- Constants ---------------------------------------------------------------
PROGRAM_ID="DNSefSAJ41Fm3ijmEug8tkDYJrHDwYGVtFtn8wwvbgJM"
EXPECTED_AUTHORITY="CCcJuC3B7EwAq47VCPfgbvHvjf2xkuCj6wAKxNZ7vcY2"
RPC_URL="https://rpc.mainnet.x1.xyz"
KEYPAIR="${HOME}/.config/solana/id.json"
BINARY_PATH="target/deploy/brains_pairing.so"
MIN_BALANCE_XNT=5
LOG_FILE="DEPLOY_LOG.md"

# ---- Colors ------------------------------------------------------------------
RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
YELLOW=$'\033[0;33m'
BLUE=$'\033[0;34m'
BOLD=$'\033[1m'
NC=$'\033[0m'

ok()    { echo "${GREEN}✓${NC} $*"; }
warn()  { echo "${YELLOW}⚠${NC} $*"; }
fail()  { echo "${RED}✗${NC} $*" >&2; }
info()  { echo "${BLUE}ℹ${NC} $*"; }
die()   { fail "$*"; exit 1; }

# ---- Args --------------------------------------------------------------------
ASSUME_YES=0
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --yes|-y) ASSUME_YES=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --help|-h)
      sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "Unknown arg: $arg (try --help)" ;;
  esac
done

# ---- Locate project root -----------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$SCRIPT_DIR"
while [[ "$PROJECT_ROOT" != "/" && ! -f "$PROJECT_ROOT/Anchor.toml" ]]; do
  PROJECT_ROOT="$(dirname "$PROJECT_ROOT")"
done
[[ -f "$PROJECT_ROOT/Anchor.toml" ]] || die "Could not find Anchor.toml walking up from $SCRIPT_DIR"
cd "$PROJECT_ROOT"

echo
echo "${BOLD}=== brains_pairing safe deploy ===${NC}"
echo "Project root: $PROJECT_ROOT"
echo "Program ID:   $PROGRAM_ID"
echo "RPC:          $RPC_URL"
echo

# ---- Check 1: Required tools -------------------------------------------------
info "Checking required tools..."
command -v solana >/dev/null || die "solana CLI not found in PATH"
command -v solana-keygen >/dev/null || die "solana-keygen not found in PATH"
command -v git >/dev/null || die "git not found in PATH"
command -v md5sum >/dev/null || die "md5sum not found in PATH"
ok "Tools present"

# ---- Check 2: Binary exists and looks reasonable -----------------------------
info "Checking binary..."
[[ -f "$BINARY_PATH" ]] || die "Binary not found at $BINARY_PATH — run 'anchor build' first"

BINARY_SIZE=$(stat -c%s "$BINARY_PATH")
BINARY_MD5=$(md5sum "$BINARY_PATH" | awk '{print $1}')
BINARY_MTIME=$(stat -c%y "$BINARY_PATH")

[[ "$BINARY_SIZE" -gt 100000 ]] || die "Binary suspiciously small ($BINARY_SIZE bytes) — did the build fail?"
ok "Binary: $BINARY_PATH"
echo "    size:  $BINARY_SIZE bytes"
echo "    md5:   $BINARY_MD5"
echo "    mtime: $BINARY_MTIME"

# ---- Check 3: Git state ------------------------------------------------------
info "Checking git state..."
GIT_COMMIT=$(git rev-parse --short HEAD)
GIT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
GIT_DIRTY=""
if ! git diff-index --quiet HEAD -- 2>/dev/null; then
  GIT_DIRTY=" (dirty: uncommitted changes)"
  warn "Working tree has uncommitted changes"
fi
ok "Git: $GIT_BRANCH @ $GIT_COMMIT$GIT_DIRTY"

# ---- Check 4: solana CLI keypair matches expected upgrade authority ---------
info "Checking solana CLI keypair..."
[[ -f "$KEYPAIR" ]] || die "Keypair not found at $KEYPAIR"
LOCAL_AUTHORITY=$(solana address -k "$KEYPAIR")
if [[ "$LOCAL_AUTHORITY" != "$EXPECTED_AUTHORITY" ]]; then
  fail "Local keypair pubkey: $LOCAL_AUTHORITY"
  fail "Expected authority:   $EXPECTED_AUTHORITY"
  die "Local keypair does not match expected upgrade authority. Aborting."
fi
ok "Local keypair = $LOCAL_AUTHORITY (expected upgrade authority)"

# ---- Check 5: Wallet balance -------------------------------------------------
info "Checking wallet balance..."
BALANCE_RAW=$(solana balance "$LOCAL_AUTHORITY" --url "$RPC_URL" 2>/dev/null | awk '{print $1}')
BALANCE_INT=${BALANCE_RAW%.*}
if [[ -z "$BALANCE_INT" ]] || [[ "$BALANCE_INT" -lt "$MIN_BALANCE_XNT" ]]; then
  die "Wallet balance $BALANCE_RAW XNT is below minimum $MIN_BALANCE_XNT XNT"
fi
ok "Wallet balance: $BALANCE_RAW XNT"

# ---- Check 6: On-chain program state -----------------------------------------
info "Checking on-chain program state..."
PROGRAM_INFO=$(solana program show "$PROGRAM_ID" --url "$RPC_URL" 2>&1) || die "Failed to fetch program info: $PROGRAM_INFO"

ON_CHAIN_AUTHORITY=$(echo "$PROGRAM_INFO" | grep -i "^Authority:" | awk '{print $2}')
ON_CHAIN_SLOT=$(echo "$PROGRAM_INFO" | grep -i "Last Deployed In Slot:" | awk '{print $NF}')
ON_CHAIN_LEN=$(echo "$PROGRAM_INFO" | grep -i "Data Length:" | awk '{print $3}')

if [[ "$ON_CHAIN_AUTHORITY" != "$EXPECTED_AUTHORITY" ]]; then
  fail "On-chain authority: $ON_CHAIN_AUTHORITY"
  fail "Expected:           $EXPECTED_AUTHORITY"
  die "On-chain upgrade authority does not match expected value. Aborting."
fi
ok "On-chain authority: $ON_CHAIN_AUTHORITY"
echo "    last slot: $ON_CHAIN_SLOT"
echo "    data len:  $ON_CHAIN_LEN bytes (new will be $BINARY_SIZE)"

# ---- Deploy plan summary -----------------------------------------------------
echo
echo "${BOLD}=== Deploy plan ===${NC}"
echo "  Program:        $PROGRAM_ID"
echo "  Binary:         $BINARY_PATH"
echo "  Binary MD5:     $BINARY_MD5"
echo "  Binary size:    $BINARY_SIZE bytes (was $ON_CHAIN_LEN on chain)"
echo "  Authority:      $EXPECTED_AUTHORITY"
echo "  Git:            $GIT_BRANCH @ $GIT_COMMIT$GIT_DIRTY"
echo "  Current slot:   $ON_CHAIN_SLOT (will increase after deploy)"
echo

if [[ "$DRY_RUN" -eq 1 ]]; then
  ok "Dry run complete. All checks passed. Not deploying."
  exit 0
fi

# ---- Confirmation ------------------------------------------------------------
if [[ "$ASSUME_YES" -ne 1 ]]; then
  echo "${YELLOW}This will UPGRADE the program on X1 mainnet.${NC}"
  read -r -p "Type 'deploy' to continue: " CONFIRM
  if [[ "$CONFIRM" != "deploy" ]]; then
    die "Aborted by user"
  fi
fi

# ---- Deploy ------------------------------------------------------------------
info "Deploying... (this can take 1-3 minutes — DO NOT Ctrl+C)"
echo

DEPLOY_OUTPUT=$(solana program deploy \
  --program-id "$PROGRAM_ID" \
  --upgrade-authority "$KEYPAIR" \
  --url "$RPC_URL" \
  "$BINARY_PATH" 2>&1) || {
    echo "$DEPLOY_OUTPUT"
    die "Deploy failed. See output above. DO NOT retry blindly — check for buffer accounts to clean up."
  }

echo "$DEPLOY_OUTPUT"
echo

DEPLOY_SIG=$(echo "$DEPLOY_OUTPUT" | grep -i "^Signature:" | awk '{print $2}')
[[ -n "$DEPLOY_SIG" ]] || warn "Could not parse signature from deploy output"

ok "Deploy completed"

# ---- Post-deploy verification ------------------------------------------------
info "Verifying on-chain state..."
sleep 2
NEW_INFO=$(solana program show "$PROGRAM_ID" --url "$RPC_URL")
NEW_AUTHORITY=$(echo "$NEW_INFO" | grep -i "^Authority:" | awk '{print $2}')
NEW_SLOT=$(echo "$NEW_INFO" | grep -i "Last Deployed In Slot:" | awk '{print $NF}')
NEW_LEN=$(echo "$NEW_INFO" | grep -i "Data Length:" | awk '{print $3}')

[[ "$NEW_AUTHORITY" == "$EXPECTED_AUTHORITY" ]] || die "POST-DEPLOY: authority changed unexpectedly to $NEW_AUTHORITY"
[[ "$NEW_SLOT" -gt "$ON_CHAIN_SLOT" ]] || die "POST-DEPLOY: slot did not advance ($NEW_SLOT vs $ON_CHAIN_SLOT)"
[[ "$NEW_LEN" -eq "$BINARY_SIZE" ]] || warn "POST-DEPLOY: data length $NEW_LEN does not match binary size $BINARY_SIZE"

ok "Authority unchanged: $NEW_AUTHORITY"
ok "Slot advanced:       $ON_CHAIN_SLOT -> $NEW_SLOT"
ok "Data length:         $NEW_LEN bytes"

# ---- Append to deploy log ----------------------------------------------------
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
{
  echo ""
  echo "## $TIMESTAMP"
  echo ""
  echo "- **Program:**   \`$PROGRAM_ID\`"
  echo "- **Signature:** \`${DEPLOY_SIG:-unknown}\`"
  echo "- **Slot:**      $NEW_SLOT (was $ON_CHAIN_SLOT)"
  echo "- **Binary MD5:** \`$BINARY_MD5\`"
  echo "- **Binary size:** $BINARY_SIZE bytes (was $ON_CHAIN_LEN)"
  echo "- **Git:**       \`$GIT_BRANCH @ $GIT_COMMIT\`$GIT_DIRTY"
  echo "- **Authority:** \`$NEW_AUTHORITY\`"
} >> "$LOG_FILE"

ok "Appended entry to $LOG_FILE"

echo
echo "${GREEN}${BOLD}✓ Deploy complete.${NC}"
echo
echo "Next steps:"
echo "  1. Run smoke tests:    node verify5.js && node verify_state_compat.js"
echo "  2. Commit DEPLOY_LOG:  git add $LOG_FILE && git commit -m 'log: deploy $NEW_SLOT'"
echo "  3. Push:               git push origin $GIT_BRANCH"
echo
