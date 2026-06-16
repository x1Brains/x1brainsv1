import { useEffect, useMemo } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { setAdminAuth } from './supabase';

// The two admin wallets that unlock /admin. Both are equally privileged in v2.
//   COUNCIL  — multi-program governance wallet (citizenship admin, x1city)
//   V1_ADMIN — original x1brains.io admin wallet (rewards/announcements/bot)
export const COUNCIL_WALLET  = 'CnyGhzMuv5snBGxvShxsJMDnvHcXKwRtVVUpzGX3QAuG';
export const V1_ADMIN_WALLET = '2nVaSvCqrsdskcbtn47uquNDL7Q69To1k45FpYBvWnuC';

export const ADMIN_WALLETS = new Set<string>([COUNCIL_WALLET, V1_ADMIN_WALLET]);

export type AdminRole = 'council' | 'v1' | null;

export function roleFor(pubkey: string | null | undefined): AdminRole {
  if (!pubkey) return null;
  if (pubkey === COUNCIL_WALLET)  return 'council';
  if (pubkey === V1_ADMIN_WALLET) return 'v1';
  return null;
}

/**
 * One-stop hook for admin pages.
 *
 * Returns:
 *   isAdmin   — true when the connected wallet is in ADMIN_WALLETS
 *   role      — 'council' | 'v1' | null
 *   pubkey    — base58 of the connected wallet (or '')
 *   short     — shortened display address
 *
 * Side-effects:
 *   Wires the connected wallet's signMessage into the Ed25519 admin-auth flow
 *   (setAdminAuth) so adminFetch() can sign requests, and clears it on
 *   disconnect or when the wallet isn't an admin.
 */
export function useAdmin() {
  const { publicKey, signMessage, connected } = useWallet();
  const pk    = publicKey?.toBase58() ?? '';
  const role  = useMemo(() => roleFor(pk), [pk]);
  const isAdmin = role !== null;

  useEffect(() => {
    if (connected && isAdmin && publicKey && signMessage) {
      setAdminAuth({ pubkey: publicKey.toBase58(), signMessage });
    } else {
      setAdminAuth(null);
    }
    return () => { setAdminAuth(null); };
  }, [connected, isAdmin, publicKey, signMessage]);

  const short = pk ? `${pk.slice(0, 5)}…${pk.slice(-5)}` : '';

  return { isAdmin, role, pubkey: pk, short, connected };
}
