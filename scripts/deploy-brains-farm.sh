#!/usr/bin/env bash
#
# deploy-brains-farm.sh
#
# Safe deploy/upgrade for the brains_farm program on X1 mainnet.
#
# FIRST DEPLOY vs UPGRADE:
#   On first deploy, the program doesn't exist on-chain yet. This script
#   detects that and uses `anchor deploy` (safe here because the local
#   keypair at target/deploy/brains_farm-keypair.json matches declare_id!()
#   in lib.rs — we generated them together).
#
#   On subsequent upgrades, this script uses `solana program deploy
#   --program-id` with the on-chain upgrade authority. This is safer
#   because it doesn't rely on the keypair file (which could theoretically
#   drift from on-chain state, as happened with brains_pairing).
#
# USAGE:
#   ./scripts/deploy-brains-farm.sh            # interactive
#   ./scripts/deploy-brains-farm.sh --yes      # skip confirmation
#   ./scripts/deploy-brains-farm.sh --dry-run  # checks only, no deploy
#
set -euo pipefail

# ---- Constants ---------------------------------------------------------------
PROGRAM_ID="Ci1qDtdoSh8mCtJTVoX1tArbnLydQUZYu9RiqukRFJpg"
EXPECTED_AUTHORITY="CCcJuC3B7EwAq47VCPfgbvHvjf2xkuCj6wAKxNZ7vcY2"
RPC_URL="https://rpc.mainnet.x1.xyz"
KEYPAIR="${HOME}/.config/solana/id.json"
PROGRAM_KEYPAIR="target/deploy/brains_farm-keypair.json"
BINARY_PATH="target/deploy/brains_farm.so"
MIN_BALANCE_XNT=6  # first deploy needs rent headroom
LOG_FILE="DEPLOY_LOG_FARM.md"

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
      sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'
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
echo "${BOLD}=== brains_farm safe deploy ===${NC}"
echo "Project root: $PROJECT_ROOT"
echo "Program ID:   $PROGRAM_ID"
echo "RPC:          $RPC_URL"
echo

# ---- Check 1: Required tools -------------------------------------------------
info "Checking required tools..."
command -v solana >/dev/null || die "solana CLI not found in PATH"
command -v solana-keygen >/dev/null || die "solana-keygen not found in PATH"
command -v anchor >/dev/null || die "anchor CLI not found in PATH"
command -v git >/dev/null || die "git not found in PATH"
command -v md5sum >/dev/null || die "md5sum not found in PATH"
ok "Tools present"

# ---- Check 2: Binary exists and looks reasonable -----------------------------
info "Checking binary..."
[[ -f "$BINARY_PATH" ]] || die "Binary not found at $BINARY_PATH — run 'cargo build-sbf --manifest-path programs/brains_farm/Cargo.toml' first"

BINARY_SIZE=$(stat -c%s "$BINARY_PATH")
BINARY_MD5=$(md5sum "$BINARY_PATH" | awk '{print $1}')
BINARY_MTIME=$(stat -c%y "$BINARY_PATH")

[[ "$BINARY_SIZE" -gt 100000 ]] || die "Binary suspiciously small ($BINARY_SIZE bytes) — did the build fail?"
ok "Binary: $BINARY_PATH"
echo "    size:  $BINARY_SIZE bytes"
echo "    md5:   $BINARY_MD5"
echo "    mtime: $BINARY_MTIME"

# ---- Check 3: Program keypair exists and matches declare_id!() ---------------
info "Checking program keypair matches declare_id!()..."
[[ -f "$PROGRAM_KEYPAIR" ]] || die "Program keypair not found at $PROGRAM_KEYPAIR"
KEYPAIR_PUBKEY=$(solana-keygen pubkey "$PROGRAM_KEYPAIR")
if [[ "$KEYPAIR_PUBKEY" != "$PROGRAM_ID" ]]; then
  fail "Keypair file pubkey: $KEYPAIR_PUBKEY"
  fail "Expected program ID: $PROGRAM_ID"
  die "Program keypair does not match declare_id!(). Rebuild or fix lib.rs."
fi
ok "Program keypair matches: $KEYPAIR_PUBKEY"

# ---- Check 4: Git state ------------------------------------------------------
info "Checking git state..."
GIT_COMMIT=$(git rev-parse --short HEAD)
GIT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
GIT_DIRTY=""
if ! git diff-index --quiet HEAD -- 2>/dev/null; then
  GIT_DIRTY=" (dirty: uncommitted changes)"
  warn "Working tree has uncommitted changes"
fi
ok "Git: $GIT_BRANCH @ $GIT_COMMIT$GIT_DIRTY"

# ---- Check 5: solana CLI keypair matches expected upgrade authority ---------
info "Checking solana CLI wallet keypair..."
[[ -f "$KEYPAIR" ]] || die "Wallet keypair not found at $KEYPAIR"
LOCAL_AUTHORITY=$(solana address -k "$KEYPAIR")
if [[ "$LOCAL_AUTHORITY" != "$EXPECTED_AUTHORITY" ]]; then
  fail "Local keypair pubkey: $LOCAL_AUTHORITY"
  fail "Expected authority:   $EXPECTED_AUTHORITY"
  die "Local keypair does not match expected upgrade authority. Aborting."
fi
ok "Local wallet = $LOCAL_AUTHORITY (expected upgrade authority)"

# ---- Check 6: Wallet balance -------------------------------------------------
info "Checking wallet balance..."
BALANCE_RAW=$(solana balance "$LOCAL_AUTHORITY" --url "$RPC_URL" 2>/dev/null | awk '{print $1}')
BALANCE_INT=${BALANCE_RAW%.*}
if [[ -z "$BALANCE_INT" ]] || [[ "$BALANCE_INT" -lt "$MIN_BALANCE_XNT" ]]; then
  die "Wallet balance $BALANCE_RAW XNT is below minimum $MIN_BALANCE_XNT XNT"
fi
ok "Wallet balance: $BALANCE_RAW XNT"

# ---- Check 7: Detect first deploy vs upgrade ---------------------------------
info "Checking on-chain program state..."
IS_UPGRADE=0
ON_CHAIN_SLOT="N/A"
ON_CHAIN_LEN="N/A"

if solana program show "$PROGRAM_ID" --url "$RPC_URL" >/dev/null 2>&1; then
  IS_UPGRADE=1
  PROGRAM_INFO=$(solana program show "$PROGRAM_ID" --url "$RPC_URL")
  ON_CHAIN_AUTHORITY=$(echo "$PROGRAM_INFO" | grep -i "^Authority:" | awk '{print $2}')
  ON_CHAIN_SLOT=$(echo "$PROGRAM_INFO" | grep -i "Last Deployed In Slot:" | awk '{print $NF}')
  ON_CHAIN_LEN=$(echo "$PROGRAM_INFO" | grep -i "Data Length:" | awk '{print $3}')

  if [[ "$ON_CHAIN_AUTHORITY" != "$EXPECTED_AUTHORITY" ]]; then
    fail "On-chain authority: $ON_CHAIN_AUTHORITY"
    fail "Expected:           $EXPECTED_AUTHORITY"
    die "On-chain upgrade authority does not match expected value. Aborting."
  fi
  ok "Program exists on-chain (UPGRADE mode)"
  echo "    authority: $ON_CHAIN_AUTHORITY"
  echo "    last slot: $ON_CHAIN_SLOT"
  echo "    data len:  $ON_CHAIN_LEN bytes (new will be $BINARY_SIZE)"
else
  ok "Program does not exist on-chain (FIRST DEPLOY mode)"
fi

# ---- Deploy plan summary -----------------------------------------------------
echo
echo "${BOLD}=== Deploy plan ===${NC}"
if [[ "$IS_UPGRADE" -eq 1 ]]; then
  echo "  Mode:           ${YELLOW}UPGRADE${NC}"
else
  echo "  Mode:           ${GREEN}FIRST DEPLOY${NC}"
fi
echo "  Program:        $PROGRAM_ID"
echo "  Binary:         $BINARY_PATH"
echo "  Binary MD5:     $BINARY_MD5"
echo "  Binary size:    $BINARY_SIZE bytes (was $ON_CHAIN_LEN on chain)"
echo "  Authority:      $EXPECTED_AUTHORITY"
echo "  Wallet balance: $BALANCE_RAW XNT"
echo "  Git:            $GIT_BRANCH @ $GIT_COMMIT$GIT_DIRTY"
echo

if [[ "$DRY_RUN" -eq 1 ]]; then
  ok "Dry run complete. All checks passed. Not deploying."
  exit 0
fi

# ---- Confirmation ------------------------------------------------------------
if [[ "$ASSUME_YES" -ne 1 ]]; then
  if [[ "$IS_UPGRADE" -eq 1 ]]; then
    echo "${YELLOW}This will UPGRADE the brains_farm program on X1 mainnet.${NC}"
  else
    echo "${GREEN}This will DEPLOY brains_farm for the first time on X1 mainnet.${NC}"
    echo "${YELLOW}First deploy rent is unrefundable.${NC}"
  fi
  read -r -p "Type 'deploy' to continue: " CONFIRM
  if [[ "$CONFIRM" != "deploy" ]]; then
    die "Aborted by user"
  fi
fi

# ---- Deploy ------------------------------------------------------------------
info "Deploying... (this can take 1-3 minutes — DO NOT Ctrl+C)"
echo

if [[ "$IS_UPGRADE" -eq 1 ]]; then
  # UPGRADE path — use raw solana CLI for safety
  DEPLOY_OUTPUT=$(solana program deploy \
    --program-id "$PROGRAM_ID" \
    --upgrade-authority "$KEYPAIR" \
    --url "$RPC_URL" \
    "$BINARY_PATH" 2>&1) || {
      echo "$DEPLOY_OUTPUT"
      die "Deploy failed. See output above. Check for orphan buffer accounts to clean up with 'solana program show --buffers'."
    }
else
  # FIRST DEPLOY path — use solana program deploy with program keypair
  # (equivalent to anchor deploy but no IDL upload confusion)
  DEPLOY_OUTPUT=$(solana program deploy \
    --program-id "$PROGRAM_KEYPAIR" \
    --upgrade-authority "$KEYPAIR" \
    --url "$RPC_URL" \
    "$BINARY_PATH" 2>&1) || {
      echo "$DEPLOY_OUTPUT"
      die "First deploy failed. See output above. Check for orphan buffer accounts."
    }
fi

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

[[ "$NEW_AUTHORITY" == "$EXPECTED_AUTHORITY" ]] || die "POST-DEPLOY: authority mismatch: $NEW_AUTHORITY != $EXPECTED_AUTHORITY"
if [[ "$IS_UPGRADE" -eq 1 && "$ON_CHAIN_SLOT" != "N/A" ]]; then
  [[ "$NEW_SLOT" -gt "$ON_CHAIN_SLOT" ]] || die "POST-DEPLOY: slot did not advance"
fi
[[ "$NEW_LEN" -eq "$BINARY_SIZE" ]] || warn "POST-DEPLOY: data length $NEW_LEN does not match binary size $BINARY_SIZE"

ok "Authority: $NEW_AUTHORITY"
ok "Slot:      $NEW_SLOT (was $ON_CHAIN_SLOT)"
ok "Data len:  $NEW_LEN bytes"

# ---- Append to deploy log ----------------------------------------------------
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
MODE_LABEL=$([[ "$IS_UPGRADE" -eq 1 ]] && echo "upgrade" || echo "first deploy")
{
  if [[ ! -f "$LOG_FILE" ]]; then
    echo "# Brains Farm Deploy Log"
    echo ""
    echo "Append-only record of deploys for \`$PROGRAM_ID\` on X1 mainnet."
  fi
  echo ""
  echo "## $TIMESTAMP — $MODE_LABEL"
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
if [[ "$IS_UPGRADE" -eq 0 ]]; then
  echo "  1. Initialize the protocol:   node scripts/initialize-farm-global.js"
  echo "  2. Create the 2 farms:         node scripts/create-brains-farms.js"
  echo "  3. Fund vaults:                node scripts/fund-brains-farms.js"
fi
echo "  $(if [[ "$IS_UPGRADE" -eq 0 ]]; then echo "4"; else echo "1"; fi). Commit log:      git add $LOG_FILE && git commit -m 'log: farm deploy $NEW_SLOT'"
echo "  $(if [[ "$IS_UPGRADE" -eq 0 ]]; then echo "5"; else echo "2"; fi). Push:             git push origin $GIT_BRANCH"
echo
