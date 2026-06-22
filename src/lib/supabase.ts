import { createClient, SupabaseClient } from '@supabase/supabase-js';

// ─────────────────────────────────────────────
// SUPABASE CLIENTS
// ─────────────────────────────────────────────
const SUPABASE_URL      = import.meta.env.VITE_SUPABASE_URL      || '';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

const _hasSB = !!(SUPABASE_URL && SUPABASE_ANON_KEY);

/** Public client — read-only (used by all pages) */
export const supabase: SupabaseClient | null = _hasSB ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

/** Check if Supabase is configured */
export function isSupabaseReady(): boolean { return _hasSB; }

// ─────────────────────────────────────────────────────────────────
// ADMIN API — all write operations go through /api/admin (server-side).
// Auth: every request carries an Ed25519 signature over a structured
// message that commits to (action, payloadHash, ts, nonce). The server
// verifies the signature against ADMIN_WALLET, the timestamp freshness,
// and that payloadHash matches the actual request body. This is what
// replaces the old plaintext `x-admin-wallet` header check.
//
// The service role key lives on the server as SUPABASE_SERVICE_KEY (no
// VITE_ prefix) and is never exposed in the browser bundle.
// ─────────────────────────────────────────────────────────────────
import bs58 from 'bs58';

type SignMessageFn = (msg: Uint8Array) => Promise<Uint8Array>;

let _adminPubkey = '';
let _adminSign: SignMessageFn | null = null;

/**
 * Wire the connected wallet's pubkey + signMessage into the admin API.
 * Pass `null` on disconnect to clear. The signMessage function is the one
 * exposed by `@solana/wallet-adapter-react`'s useWallet().
 */
export function setAdminAuth(args: { pubkey: string; signMessage: SignMessageFn } | null): void {
  if (!args) {
    _adminPubkey = '';
    _adminSign = null;
    return;
  }
  _adminPubkey = args.pubkey;
  _adminSign = args.signMessage;
}

/** Back-compat shim: pubkey-only call clears the signer (legacy callers). */
export function setAdminWallet(w: string): void {
  _adminPubkey = w;
  if (!w) _adminSign = null;
}

async function sha256Hex(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

async function adminFetch(action: string, payload?: any): Promise<{ success: boolean; error?: string; data?: any }> {
  if (!_adminPubkey || !_adminSign) {
    return { success: false, error: 'Admin signer not configured. Connect wallet first.' };
  }
  try {
    const payloadJson = JSON.stringify(payload ?? null);
    const payloadHash = await sha256Hex(payloadJson);
    const message = JSON.stringify({
      action,
      payloadHash,
      ts: Date.now(),
      nonce: crypto.randomUUID(),
    });
    const sig = await _adminSign(new TextEncoder().encode(message));
    const r = await fetch('/api/admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action,
        payload,
        auth: {
          pubkey: _adminPubkey,
          message,
          signature: bs58.encode(sig),
        },
      }),
    });
    const text = await r.text();
    if (!text) {
      return {
        success: false,
        error: `Admin API returned an empty response (HTTP ${r.status}). ` +
          `The /api/admin function runs on Vercel — it isn't served by plain "vite dev". ` +
          `Test on the deployed site or run "vercel dev".`,
      };
    }
    try { return JSON.parse(text); }
    catch { return { success: false, error: `Admin API returned a non-JSON response (HTTP ${r.status}).` }; }
  } catch (e: any) {
    return { success: false, error: e?.message ?? 'Network error' };
  }
}

/** Legacy alias — supabaseAdmin now equals supabase (anon). All writes go via adminFetch. */
export const supabaseAdmin: SupabaseClient | null = supabase;

// helper
const ok = (e: any) => !e;
type Res = { success: boolean; error?: string };
function res(error: any): Res { return error ? { success: false, error: error.message } : { success: true }; }

// ═════════════════════════════════════════════
// 1. LABWORK BOOST POINTS (labwork_points)
// ═════════════════════════════════════════════
// Points earned by burning BRAINS/LB for marketplace boost placement (see
// V2BoostModal). The old `labwork_rewards` table (admin-awarded weekly-challenge
// "LB points") was retired with the weekly challenge — no longer read or written.

export async function getLabWorkMap(): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (!supabase) return map;
  try {
    const { data, error } = await supabase.from('labwork_points').select('wallet, points');
    if (error) { console.error('[SB] getLabWorkMap:', error.message); return map; }
    for (const r of data ?? [])
      map.set(r.wallet, (map.get(r.wallet) || 0) + (r.points ?? 0));
  } catch (e) { console.error('[SB] getLabWorkMap:', e); }
  return map;
}

export async function getLabWorkPtsForWallet(address: string): Promise<number> {
  if (!supabase) return 0;
  try {
    const { data } = await supabase.from('labwork_points').select('points').eq('wallet', address);
    return (data ?? []).reduce((s: number, r: any) => s + (r.points ?? 0), 0);
  } catch { return 0; }
}

// cache
let _lwCache: { map: Map<string, number>; ts: number } | null = null;
const LW_TTL = 30_000;
export async function getCachedLabWorkMap(): Promise<Map<string, number>> {
  if (_lwCache && Date.now() - _lwCache.ts < LW_TTL) return _lwCache.map;
  const map = await getLabWorkMap();
  _lwCache = { map, ts: Date.now() };
  return map;
}
export function invalidateLabWorkCache() { _lwCache = null; }

// Refresh signal — increment this to tell BurnedBrainsBar to re-fetch labwork pts
// Shared mutable so any module can trigger a refresh without prop drilling
export const labWorkSignal = { version: 0 };
export function triggerLabWorkRefresh() {
  _lwCache = null; // also bust the map cache
  labWorkSignal.version++;
}

// shared in-memory map (set by BurnLeaderboard, read by others)
let _sbLabWorkMap: Map<string, number> | null = null;
export function setSupabaseLabWorkMap(m: Map<string, number>) { _sbLabWorkMap = m; }
export function getSupabaseLabWorkMap(): Map<string, number> | null { return _sbLabWorkMap; }

// ═════════════════════════════════════════════
// 2. WEEKLY CONFIG — retired
// ═════════════════════════════════════════════
// The weekly challenge ("Rewards Season") was removed in v2. The `weekly_config`
// table is no longer read. Kept as a null stub so v1 carryover components compile.
export async function getCachedWeeklyConfig(): Promise<any | null> { return null; }

// ═════════════════════════════════════════════
// 3. CHALLENGE LOGS — retired
// ═════════════════════════════════════════════
// Completed-week archive for the removed weekly challenge. `challenge_logs` is no
// longer read. Kept as an empty stub so v1 carryover components compile.
export async function getCachedChallengeLogs(): Promise<any[]> { return []; }

// ═════════════════════════════════════════════
// 4. ANNOUNCEMENTS
// ═════════════════════════════════════════════
export async function getAnnouncements(): Promise<any[]> {
  if (!supabase) return [];
  try {
    const { data, error } = await supabase.from('announcements').select('*').order('created_at', { ascending: false });
    if (error) return [];
    return (data ?? []).map(d => ({
      id: d.id, title: d.title, message: d.body, type: d.category,
      pinned: d.pinned, date: d.created_at,
    }));
  } catch { return []; }
}

export async function addAnnouncement(ann: { title: string; message: string; type: string }): Promise<Res> {
  return adminFetch('add_announcement', ann);
}

export async function deleteAnnouncement(id: string): Promise<Res> {
  return adminFetch('delete_announcement', { id });
}

// cache
let _annCache: { data: any[]; ts: number } | null = null;
const ANN_TTL = 30_000;
export async function getCachedAnnouncements(): Promise<any[]> {
  if (_annCache && Date.now() - _annCache.ts < ANN_TTL) return _annCache.data;
  const d = await getAnnouncements();
  _annCache = { data: d, ts: Date.now() };
  return d;
}
export function invalidateAnnouncementsCache() { _annCache = null; }

// ═════════════════════════════════════════════
// 5. LABWORK SUBMISSIONS — retired
// ═════════════════════════════════════════════
// The submissions feature (public form + admin review panel) was removed in v2.
// `labwork_submissions` is no longer read or written from the app.


// ═════════════════════════════════════════════
// 6. BURN EVENTS — on-chain burn tx ledger
// Table: burn_events (sig TEXT PK, wallet TEXT, amount FLOAT8, block_time BIGINT)
// ═════════════════════════════════════════════
export interface BurnEventRow {
  sig:        string;
  wallet:     string;
  amount:     number;
  block_time: number;
}

/** Load all burn events from Supabase (public read) */
export async function getAllBurnEvents(): Promise<BurnEventRow[]> {
  if (!supabase) return [];
  try {
    const all: BurnEventRow[] = [];
    let from = 0;
    const PAGE = 1000;
    while (true) {
      const { data, error } = await supabase
        .from('burn_events')
        .select('sig, wallet, amount, block_time')
        .order('block_time', { ascending: false })
        .range(from, from + PAGE - 1);
      if (error || !data || data.length === 0) break;
      all.push(...data);
      if (data.length < PAGE) break;
      from += PAGE;
    }
    return all;
  } catch { return []; }
}

/** Load burn events for a single wallet */
export async function getBurnEventsForWallet(wallet: string): Promise<BurnEventRow[]> {
  if (!supabase) return [];
  try {
    const { data, error } = await supabase
      .from('burn_events')
      .select('sig, wallet, amount, block_time')
      .eq('wallet', wallet)
      .order('block_time', { ascending: false });
    if (error || !data) return [];
    return data;
  } catch { return []; }
}

/** Upsert new burn events — insert-or-ignore by sig PK */
export async function upsertBurnEvents(events: BurnEventRow[]): Promise<void> {
  if (!supabase || events.length === 0) return;
  try {
    await supabase
      .from('burn_events')
      .upsert(events, { onConflict: 'sig', ignoreDuplicates: true });
  } catch {}
}

/** Delete all cached burn events for a wallet then insert fresh ones.
 *  Used after a full rescan to replace stale/corrupt cache data. */
export async function replaceBurnEventsForWallet(wallet: string, events: BurnEventRow[]): Promise<void> {
  if (!supabase) return;
  try {
    await supabase.from('burn_events').delete().eq('wallet', wallet);
    if (events.length > 0) {
      await supabase.from('burn_events').upsert(events, { onConflict: 'sig', ignoreDuplicates: true });
    }
  } catch {}
}

/** Get the most recent block_time stored (resume point for RPC scan) */
export async function getLatestBurnBlockTime(): Promise<number> {
  if (!supabase) return 0;
  try {
    const { data, error } = await supabase
      .from('burn_events')
      .select('block_time')
      .order('block_time', { ascending: false })
      .limit(1)
      .single();
    if (error || !data) return 0;
    return data.block_time ?? 0;
  } catch { return 0; }
}

// ═════════════════════════════════════════════
// 7. PAGE VIEWS — visitor analytics
// Table: page_views (id BIGSERIAL PK, path TEXT, referrer TEXT, country TEXT,
//   city TEXT, region TEXT, device TEXT, browser TEXT, os TEXT,
//   session_id TEXT, visited_at TIMESTAMPTZ)
// ═════════════════════════════════════════════
export interface PageViewRow {
  path:       string;
  referrer:   string;
  country:    string;
  city:       string;
  region:     string;
  device:     string;
  browser:    string;
  os:         string;
  session_id: string;
  visited_at: string;
}

export async function upsertPageView(row: PageViewRow): Promise<void> {
  if (!supabase) return;
  try { await supabase.from('page_views').insert(row); } catch {}
}

export async function getAllPageViews(): Promise<any[]> {
  if (!supabase) return [];
  try {
    const all: any[] = [];
    let from = 0;
    const PAGE = 1000;
    while (true) {
      const { data, error } = await supabase
        .from('page_views')
        // select('*') so the optional `site` column (added by SUPABASE_ANALYTICS_SITE.sql)
        // is included when present but doesn't 400 the whole query when it isn't yet.
        .select('*')
        .order('visited_at', { ascending: false })
        .range(from, from + PAGE - 1);
      if (error || !data || data.length === 0) break;
      all.push(...data);
      if (data.length < PAGE) break;
      from += PAGE;
    }
    return all;
  } catch { return []; }
}

export async function getUniqueVisitorCount(): Promise<number> {
  if (!supabase) return 0;
  try {
    const { data } = await supabase.from('page_views').select('session_id');
    if (!data) return 0;
    return new Set(data.map((r: any) => r.session_id)).size;
  } catch { return 0; }
}

// ═════════════════════════════════════════════
// 7b. SITE EVENTS — custom interaction tracking
// Table: site_events (id BIGSERIAL PK, session_id TEXT, event_type TEXT,
//   category TEXT, label TEXT, value TEXT, path TEXT, fired_at TIMESTAMPTZ)
// event_type examples: tab_click, wallet_connect, wallet_disconnect,
//   burn_tx_view, scroll_depth, button_click
// ═════════════════════════════════════════════
export interface SiteEventRow {
  session_id:  string;
  event_type:  string;
  category:    string;
  label:       string;
  value?:      string;
  path:        string;
  fired_at:    string;
}

export async function insertSiteEvent(row: SiteEventRow): Promise<void> {
  if (!supabase) return;
  try { await supabase.from('site_events').insert(row); } catch {}
}

export async function getAllSiteEvents(): Promise<any[]> {
  if (!supabase) return [];
  try {
    const all: any[] = [];
    let from = 0;
    const PAGE = 1000;
    while (true) {
      const { data, error } = await supabase
        .from('site_events')
        .select('*')
        .order('fired_at', { ascending: false })
        .range(from, from + PAGE - 1);
      if (error || !data || data.length === 0) break;
      all.push(...data);
      if (data.length < PAGE) break;
      from += PAGE;
    }
    return all;
  } catch { return []; }
}

// ═════════════════════════════════════════════
// 8b. MARKETPLACE STATS — server-side cache of NFT sales volume
// Table: marketplace_stats (single row id='main'). Lets the landing load the
// number instantly + only re-scan the chain when a new platform-wallet sig
// appears. See SUPABASE_MARKET_STATS.sql.
// ═════════════════════════════════════════════
export interface MarketplaceStatsRow {
  volumeXnt:   number;
  salesCount:  number;
  biggestSale: { priceXnt: number; sig: string; timestamp: number } | null;
  lastSig:     string | null;
}

export async function getMarketplaceStats(): Promise<MarketplaceStatsRow | null> {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from('marketplace_stats')
      .select('volume_xnt, sales_count, biggest_sale, last_sig')
      .eq('id', 'main')
      .maybeSingle();
    if (error || !data) return null;
    return {
      volumeXnt:   Number(data.volume_xnt) || 0,
      salesCount:  Number(data.sales_count) || 0,
      biggestSale: data.biggest_sale ?? null,
      lastSig:     data.last_sig ?? null,
    };
  } catch { return null; }
}

export async function upsertMarketplaceStats(r: MarketplaceStatsRow): Promise<void> {
  if (!supabase) return;
  try {
    await supabase.from('marketplace_stats').upsert({
      id: 'main',
      volume_xnt:   r.volumeXnt,
      sales_count:  r.salesCount,
      biggest_sale: r.biggestSale,
      last_sig:     r.lastSig,
      updated_at:   new Date().toISOString(),
    }, { onConflict: 'id' });
  } catch {}
}

// ═════════════════════════════════════════════
// NFT METADATA CACHE — shared, app-level indexer (table: nft_metadata)
// First viewer to resolve an NFT's image/traits writes them here; every later
// visitor loads them INSTANTLY from Supabase instead of re-fetching the per-NFT
// metadata JSON through slow public CORS proxies. See SUPABASE_NFT_METADATA.sql.
// ═════════════════════════════════════════════
export interface NftMetaRow {
  mint:         string;
  name?:        string | null;
  symbol?:      string | null;
  image?:       string | null;
  description?: string | null;
  externalUrl?: string | null;
  collection?:  string | null;
  attributes?:  { trait_type: string; value: string }[] | null;
}

/** Batch-read cached metadata for many mints. Chunks the IN() list. */
export async function getNftMetadataBatch(mints: string[]): Promise<Map<string, NftMetaRow>> {
  const out = new Map<string, NftMetaRow>();
  if (!supabase || mints.length === 0) return out;
  const uniq = Array.from(new Set(mints));
  const CHUNK = 150;
  try {
    for (let i = 0; i < uniq.length; i += CHUNK) {
      const slice = uniq.slice(i, i + CHUNK);
      const { data } = await supabase
        .from('nft_metadata')
        .select('mint,name,symbol,image,description,external_url,collection,attributes')
        .in('mint', slice);
      if (data) for (const d of data as any[]) {
        out.set(d.mint, {
          mint: d.mint, name: d.name, symbol: d.symbol, image: d.image,
          description: d.description, externalUrl: d.external_url,
          collection: d.collection, attributes: d.attributes,
        });
      }
    }
  } catch {}
  return out;
}

/** Write-through cache. Only rows with a usable image OR attributes are worth storing. */
export async function upsertNftMetadata(rows: NftMetaRow[]): Promise<void> {
  if (!supabase || rows.length === 0) return;
  const payload = rows
    .filter(r => r.mint && (r.image || (r.attributes && r.attributes.length)))
    .map(r => ({
      mint: r.mint, name: r.name ?? null, symbol: r.symbol ?? null,
      image: r.image ?? null, description: r.description ?? null,
      external_url: r.externalUrl ?? null, collection: r.collection ?? null,
      attributes: r.attributes ?? null, updated_at: new Date().toISOString(),
    }));
  if (payload.length === 0) return;
  try { await supabase.from('nft_metadata').upsert(payload, { onConflict: 'mint' }); } catch {}
}

// ═════════════════════════════════════════════
// 9. SEND HISTORY — token send ledger per wallet
// Table: send_history (id UUID PK, from_wallet TEXT, to_wallet TEXT,
//   mint TEXT, symbol TEXT, amount FLOAT8, tx_sig TEXT, sent_at TIMESTAMPTZ)
// ═════════════════════════════════════════════
export interface SendHistoryRow {
  id:          string;
  from_wallet: string;
  to_wallet:   string;
  mint:        string;
  symbol:      string;
  amount:      number;
  tx_sig:      string;
  sent_at:     string;
}

export async function insertSendRecord(row: Omit<SendHistoryRow, 'id'>): Promise<void> {
  if (!supabase) return;
  try { await supabase.from('send_history').insert(row); } catch {}
}

export async function getSendHistory(fromWallet: string): Promise<SendHistoryRow[]> {
  if (!supabase) return [];
  try {
    const { data, error } = await supabase
      .from('send_history')
      .select('*')
      .eq('from_wallet', fromWallet)
      .order('sent_at', { ascending: false })
      .limit(100);
    if (error || !data) return [];
    return data;
  } catch { return []; }
}

// ═════════════════════════════════════════════
// 10. SAVED ADDRESSES — address book per wallet
// Table: saved_addresses (id UUID PK, owner_wallet TEXT,
//   saved_wallet TEXT, nickname TEXT, created_at TIMESTAMPTZ)
// ═════════════════════════════════════════════
export interface SavedAddressRow {
  id:           string;
  owner_wallet: string;
  saved_wallet: string;
  nickname:     string;
  created_at:   string;
}

export async function getSavedAddresses(ownerWallet: string): Promise<SavedAddressRow[]> {
  // READ via anon client — public read policy allows users to see their own addresses
  if (!supabase) return [];
  try {
    const { data, error } = await supabase
      .from('saved_addresses')
      .select('*')
      .eq('owner_wallet', ownerWallet)
      .order('created_at', { ascending: false });
    if (error || !data) return [];
    return data;
  } catch { return []; }
}

export async function insertSavedAddress(row: Omit<SavedAddressRow, 'id' | 'created_at'>): Promise<void> {
  // WRITE via admin API — anon key blocked from inserting
  try {
    await adminFetch('save_address', {
      owner_wallet: row.owner_wallet,
      saved_wallet: row.saved_wallet,
      nickname:     row.nickname,
    });
  } catch {}
}

export async function deleteSavedAddress(id: string): Promise<void> {
  // DELETE via admin API — anon key blocked from deleting
  try {
    await adminFetch('delete_address', { id });
  } catch {}
}

// ═════════════════════════════════════════════
// 11. PORTFOLIO SNAPSHOTS — daily balance history
// Table: portfolio_snapshots (id UUID PK, wallet TEXT,
//   snapshot_date DATE, total_usd FLOAT8,
//   token_breakdown JSONB, created_at TIMESTAMPTZ)
// ═════════════════════════════════════════════
export interface PortfolioSnapshot {
  id?:              string;
  wallet:           string;
  snapshot_date:    string;   // YYYY-MM-DD
  total_usd:        number;
  token_breakdown:  SnapshotToken[];
  created_at?:      string;
}

export interface SnapshotToken {
  mint:    string;
  symbol:  string;
  balance: number;
  usd:     number;
  price:   number;
  /** Token/NFT logo URL (or data URI) — rendered on the shareable card. */
  logo?:   string;
}

/** Upsert today's snapshot — always overwrites with the latest (most complete) data */
export async function upsertPortfolioSnapshot(snap: PortfolioSnapshot): Promise<void> {
  if (!supabase) return;
  try {
    // Always store the latest computed value for today (latest-write wins), so
    // the curve reflects the current portfolio rather than the day's peak.
    await supabase
      .from('portfolio_snapshots')
      .upsert(
        {
          wallet:          snap.wallet,
          snapshot_date:   snap.snapshot_date,
          total_usd:       snap.total_usd,
          token_breakdown: snap.token_breakdown,
        },
        { onConflict: 'wallet,snapshot_date', ignoreDuplicates: false }
      );
  } catch {}
}

/** Load all snapshots for a wallet, ordered oldest → newest */
export async function getPortfolioSnapshots(wallet: string): Promise<PortfolioSnapshot[]> {
  if (!supabase) return [];
  try {
    const { data, error } = await supabase
      .from('portfolio_snapshots')
      .select('wallet, snapshot_date, total_usd, token_breakdown, created_at')
      .eq('wallet', wallet)
      .order('snapshot_date', { ascending: true });
    if (error || !data) return [];
    return data as PortfolioSnapshot[];
  } catch { return []; }
}

// ═════════════════════════════════════════════
// 12. SPOTLIGHT IMAGES — admin-curated landing carousel promos
// ═════════════════════════════════════════════
export interface SpotlightImage {
  id:            string;
  image_url:     string;
  storage_path?: string;
  link_url?:     string | null;
  caption?:      string | null;
  sort_order:    number;
  active:        boolean;
  created_at?:   string;
}

/** Public read — active spotlight images for the landing carousel. */
export async function getSpotlightImages(): Promise<SpotlightImage[]> {
  if (!supabase) return [];
  try {
    const { data, error } = await supabase
      .from('spotlight_images')
      .select('id, image_url, link_url, caption, sort_order, active, created_at')
      .eq('active', true)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true });
    if (error || !data) return [];
    return data as SpotlightImage[];
  } catch { return []; }
}

/** Admin — full list including inactive rows. */
export async function adminListSpotlight(): Promise<SpotlightImage[]> {
  const r = await adminFetch('spotlight_list');
  return r.success && Array.isArray(r.data) ? r.data as SpotlightImage[] : [];
}

/** Admin — upload an image (base64 data URL) with optional link + caption. */
export async function uploadSpotlightImage(args: {
  dataUrl: string; filename: string; link?: string; caption?: string;
}) { return adminFetch('spotlight_upload', args); }

/** Admin — delete a spotlight image (DB row + storage file). */
export async function deleteSpotlightImage(id: string) {
  return adminFetch('spotlight_delete', { id });
}

/** Admin — toggle whether an image shows in the carousel. */
export async function setSpotlightActive(id: string, active: boolean) {
  return adminFetch('spotlight_set_active', { id, active });
}

// ═══════════════════════════════════════════════════════════════════════════
// BOT ADMIN — append these to your existing src/lib/supabase.ts
// ═══════════════════════════════════════════════════════════════════════════
//
// These functions wrap your existing adminFetch() helper to talk to the
// bot-management actions on /api/admin. The Telegram token is never
// exposed to the browser — only a masked preview comes back.
//
// Paste the block below at the bottom of your existing supabase.ts.

// ─── Types ───────────────────────────────────────────────────────────────────
export interface BotSettings {
  brains_buys: boolean;   brains_burns: boolean;   brains_lp: boolean;
  brains_stake: boolean;  brains_unstake: boolean; brains_claim: boolean;
  lb_buys: boolean;       lb_burns: boolean;       lb_lp: boolean;
  lb_stake: boolean;      lb_unstake: boolean;     lb_claim: boolean;
  min_buy_usd: number;    min_burn_tokens: number; min_lp_usd: number;
  min_stake_lp: number;   min_claim_usd: number;
  tier_big_usd: number;   tier_whale_usd: number;
}

export interface BotConnection {
  telegram_token_masked: string;
  chat_id: string;
  chat_title: string;
  vaults: {
    BRAINS: { vault_token: string; vault_quote: string };
    LB:     { vault_token: string; vault_quote: string };
  };
  mints: Record<string, { mint: string; pool: string }>;
  complete: boolean;
}

export interface BotChat {
  id: number | string;
  title: string;
  type: string;
  username?: string;
}

// ─── Settings ────────────────────────────────────────────────────────────────
export async function botGetSettings(): Promise<BotSettings | null> {
  const r = await adminFetch('bot_get_settings');
  return r.success ? (r.data as BotSettings) : null;
}

export async function botSaveSettings(updates: Partial<BotSettings>) {
  return adminFetch('bot_save_settings', updates);
}

// ─── Connection ──────────────────────────────────────────────────────────────
export async function botGetConnection(): Promise<BotConnection | null> {
  const r = await adminFetch('bot_get_connection');
  return r.success ? (r.data as BotConnection) : null;
}

export async function botSaveTelegramToken(token: string) {
  return adminFetch('bot_save_telegram_token', { token });
}

export async function botSaveChat(chat_id: string, chat_title: string) {
  return adminFetch('bot_save_chat', { chat_id, chat_title });
}

export async function botTestTelegram() {
  return adminFetch('bot_test_telegram');
}

export async function botDetectChats(): Promise<BotChat[]> {
  const r = await adminFetch('bot_detect_chats');
  return r.success ? (r.data?.chats ?? []) : [];
}

export async function botDetectVaults(token: 'BRAINS' | 'LB') {
  return adminFetch('bot_detect_vaults', { token });
}

export async function botSendTestMessage(token: 'BRAINS' | 'LB') {
  return adminFetch('bot_send_test_message', { token });
}

export async function botUploadBanner(token: 'BRAINS' | 'LB', file: File): Promise<{ success: boolean; error?: string; data?: { url: string } }> {
  // Convert file → data URL
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('file read failed'));
    reader.readAsDataURL(file);
  });
  return adminFetch('bot_upload_banner', { token, dataUrl, filename: file.name });
}

export async function botGetBannerUrl(token: 'BRAINS' | 'LB'): Promise<string | null> {
  const r = await adminFetch('bot_get_banner_url', { token });
  return r.success ? (r.data?.url ?? null) : null;
}
