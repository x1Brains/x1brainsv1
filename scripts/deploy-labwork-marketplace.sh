#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════╗
# ║  Safe upgrade wrapper for labwork_marketplace.                           ║
# ║                                                                           ║
# ║  ⛔ NEVER run `anchor build && anchor deploy` for this program.           ║
# ║  Anchor regenerates target/deploy/labwork_marketplace-keypair.json when   ║
# ║  it does not find one, and that fresh keypair points at a DIFFERENT       ║
# ║  address. Verified 2026-11-14: the regenerated key is                     ║
# ║      XQ6RveXPscdp3E4EJxWLihcFmrUyfeDw9ewBmFMW7oQ                          ║
# ║  while the real program is                                                ║
# ║      CKZHwoUZTJEnGNK4piPxyysrhwLKnnrNoBmEHM9rLaD4                         ║
# ║  `anchor deploy` would publish a ghost program at the former, burn ~3-4   ║
# ║  XNT of rent, and leave the live marketplace untouched. This is the same  ║
# ║  trap DEPLOY.md documents for brains_pairing, which is why that program   ║
# ║  has a wrapper too. labwork never had one — this is it.                   ║
# ║                                                                           ║
# ║  An upgrade needs only the UPGRADE AUTHORITY signature, not the           ║
# ║  program-ID keypair, so the regenerated key is irrelevant here.           ║
# ╚══════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

PROGRAM_ID="CKZHwoUZTJEnGNK4piPxyysrhwLKnnrNoBmEHM9rLaD4"
AUTHORITY="${LABWORK_UPGRADE_KEY:-/mnt/d/X1_KEYS/lb_mint_upgrade.json}"
EXPECTED_AUTHORITY="E2JtCatV4dE2pLWvvtgQusNMf3HCKHieKhsyUz4r88DR"
RPC="${X1_RPC:-https://rpc.mainnet.x1.xyz}"
SO="target/deploy/labwork_marketplace.so"
LOG="DEPLOY_LOG_LABWORK.md"
DRY=0; YES=0
for a in "$@"; do case "$a" in --dry-run) DRY=1;; --yes) YES=1;; esac; done

say() { printf '  %s\n' "$*"; }
die() { printf '\n  ABORT: %s\n\n' "$*" >&2; exit 1; }

echo; echo "labwork_marketplace upgrade"; echo

# 1. artefacts
[ -f "$SO" ] || die "$SO not found — run: anchor build -p labwork_marketplace"
say "binary     $SO ($(stat -c%s "$SO") bytes, md5 $(md5sum "$SO" | cut -d' ' -f1))"

# 2. authority key present and correct
[ -f "$AUTHORITY" ] || die "upgrade authority keypair not found at $AUTHORITY (mount D: or set LABWORK_UPGRADE_KEY)"
AUTH_PK="$(solana-keygen pubkey "$AUTHORITY")"
[ "$AUTH_PK" = "$EXPECTED_AUTHORITY" ] || die "wrong authority: $AUTH_PK (expected $EXPECTED_AUTHORITY)"
say "authority  $AUTH_PK"

# 3. the chain agrees that key is the authority
ONCHAIN_AUTH="$(solana program show "$PROGRAM_ID" --url "$RPC" | awk '/Authority/{print $NF}')"
[ "$ONCHAIN_AUTH" = "$EXPECTED_AUTHORITY" ] || die "on-chain authority is $ONCHAIN_AUTH, not $EXPECTED_AUTHORITY"
say "on-chain   authority matches"

# 4. ⛔ the ghost-keypair guard
GHOST="target/deploy/labwork_marketplace-keypair.json"
if [ -f "$GHOST" ]; then
  GHOST_PK="$(solana-keygen pubkey "$GHOST")"
  [ "$GHOST_PK" = "$PROGRAM_ID" ] || say "note: local program keypair is $GHOST_PK (NOT the program) — ignored, upgrades do not use it"
fi

# 5. ⛔ allocated size must fit the new binary
#    An upgradeable program account is allocated once at first deploy and does
#    NOT grow on its own. Measured 2026-11-14: allocated 315152, and the
#    Elite-waiver build is 319640 — the upgrade fails until the account is
#    extended. This check turns that into a clear message instead of a
#    confusing mid-deploy failure.
ALLOC="$(solana program show "$PROGRAM_ID" --url "$RPC" | awk -F': *' '/Data Length/{print $2}' | awk '{print $1}')"
NEWSZ="$(stat -c%s "$SO")"
say "allocated  $ALLOC bytes   new binary $NEWSZ bytes"
if [ "$NEWSZ" -gt "$ALLOC" ]; then
  EXTRA=$(( NEWSZ - ALLOC + 4096 ))   # + headroom so the next upgrade fits too
  echo
  say "⛔ the program account is too small by $(( NEWSZ - ALLOC )) bytes."
  say "   Run this FIRST (costs a little rent, cannot be undone):"
  say "     solana program extend $PROGRAM_ID $EXTRA --url $RPC --keypair $AUTHORITY"
  die "extend the program account, then re-run this script"
fi

# 6. fee payer balance
PAYER_PK="$(solana-keygen pubkey "$AUTHORITY")"
BAL="$(solana balance "$PAYER_PK" --url "$RPC" | awk '{print $1}')"
say "balance    $BAL XNT"
awk -v b="$BAL" 'BEGIN{ if (b+0 < 3) exit 1 }' || die "need at least ~3 XNT for the upgrade"

# 7. current vs new
say "live md5   $(solana program dump "$PROGRAM_ID" /tmp/_lw_live.so --url "$RPC" >/dev/null 2>&1 && md5sum /tmp/_lw_live.so | cut -d' ' -f1)"

if [ "$DRY" = "1" ]; then echo; say "--dry-run: nothing deployed."; echo; exit 0; fi
if [ "$YES" != "1" ]; then
  echo; read -r -p "  Upgrade the LIVE marketplace? type UPGRADE: " c
  [ "$c" = "UPGRADE" ] || die "not confirmed"
fi

echo
solana program deploy "$SO" \
  --program-id "$PROGRAM_ID" \
  --upgrade-authority "$AUTHORITY" \
  --keypair "$AUTHORITY" \
  --url "$RPC"

# 8. verify what actually landed
#    ⛔ `solana program dump` returns the whole ALLOCATED account, zero-padded to
#    its size — 323736 bytes after the extend, not the 319640 we built. Comparing
#    md5 of the raw dump therefore always "differs" and would cry wolf on a
#    perfectly good deploy. Compare the first $NEWSZ bytes instead, which is the
#    executable itself.
solana program dump "$PROGRAM_ID" /tmp/_lw_after.so --url "$RPC" >/dev/null 2>&1
head -c "$NEWSZ" /tmp/_lw_after.so > /tmp/_lw_after_trim.so
NEW_LIVE="$(md5sum /tmp/_lw_after_trim.so | cut -d' ' -f1)"
BUILT="$(md5sum "$SO" | cut -d' ' -f1)"
DUMPSZ="$(stat -c%s /tmp/_lw_after.so)"
echo; say "dumped     $DUMPSZ bytes (allocated), comparing first $NEWSZ"
say "deployed md5 $NEW_LIVE"; say "built    md5 $BUILT"
if [ "$NEW_LIVE" = "$BUILT" ]; then
  say "VERIFIED: on-chain executable matches the local build byte for byte"
  TAILBYTES="$(tail -c +$(( NEWSZ + 1 )) /tmp/_lw_after.so | tr -d '\0' | wc -c)"
  [ "$TAILBYTES" = "0" ] && say "padding    clean (all zero)" || say "note: $TAILBYTES non-zero bytes past the executable"
else
  say "⚠ on-chain differs from the local build — investigate before announcing"
fi

{
  echo "- $(date -u +%Y-%m-%dT%H:%M:%SZ) | $PROGRAM_ID | md5 $NEW_LIVE | git $(git rev-parse --short HEAD 2>/dev/null)$(git diff --quiet 2>/dev/null || echo ' (dirty: uncommitted changes)')"
} >> "$LOG"
say "logged to $LOG"
echo
