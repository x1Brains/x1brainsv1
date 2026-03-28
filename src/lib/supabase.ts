import { createClient, SupabaseClient } from '@supabase/supabase-js';

// ─────────────────────────────────────────────
// SUPABASE CLIENTS
// ─────────────────────────────────────────────
const SUPABASE_URL         = import.meta.env.VITE_SUPABASE_URL         || '';
const SUPABASE_ANON_KEY    = import.meta.env.VITE_SUPABASE_ANON_KEY    || '';
const SUPABASE_SERVICE_KEY = import.meta.env.VITE_SUPABASE_SERVICE_KEY || '';

const _hasSB = !!(SUPABASE_URL && SUPABASE_ANON_KEY);

/** Public client — read-only (used by all pages) */
export const supabase: SupabaseClient | null = _hasSB ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

/** Admin client — read/write (used only by AdminRewards) */
export const supabaseAdmin: SupabaseClient | null = _hasSB
  ? (SUPABASE_SERVICE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) : supabase)
  : null;

/** Check if Supabase is configured */
export function isSupabaseReady(): boolean { return _hasSB; }

// helper
const ok = (e: any) => !e;
type Res = { success: boolean; error?: string };
function res(error: any): Res { return error ? { success: false, error: error.message } : { success: true }; }

// ═════════════════════════════════════════════
// 1. LAB WORK REWARDS
// ═════════════════════════════════════════════
export interface LabWorkReward {
  id: string; address: string; lb_points: number; reason: string;
  category: string; awarded_by: string; week_id: string; created_at: string;
}

export async function getLabWorkMap(): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (!supabase) return map;
  try {
    // Fetch both sources in parallel
    const [rewardsRes, boostRes] = await Promise.all([
      supabase.from('labwork_rewards').select('address, lb_points'),
      supabase.from('labwork_points').select('wallet, points'),
    ]);
    if (rewardsRes.error) console.error('[SB] getLabWorkMap rewards:', rewardsRes.error.message);
    for (const r of rewardsRes.data ?? [])
      map.set(r.address, (map.get(r.address) || 0) + (r.lb_points ?? 0));
    // Boost burns from labwork_points (wallet column)
    for (const r of boostRes.data ?? [])
      map.set(r.wallet, (map.get(r.wallet) || 0) + (r.points ?? 0));
  } catch (e) { console.error('[SB] getLabWorkMap:', e); }
  return map;
}

export async function getLabWorkPtsForWallet(address: string): Promise<number> {
  if (!supabase) return 0;
  try {
    // Sum both sources in parallel:
    // 1. labwork_rewards — admin-awarded challenge/promo points
    // 2. labwork_points  — points earned from burning BRAINS for marketplace boosts (1.888 pts/BRAINS)
    const [rewardsRes, boostRes] = await Promise.all([
      supabase.from('labwork_rewards').select('lb_points').eq('address', address),
      supabase.from('labwork_points').select('points').eq('wallet', address),
    ]);
    const rewardPts = (rewardsRes.data ?? []).reduce((s: number, r: any) => s + (r.lb_points ?? 0), 0);
    const boostPts  = (boostRes.data  ?? []).reduce((s: number, r: any) => s + (r.points   ?? 0), 0);
    return rewardPts + boostPts;
  } catch { return 0; }
}

export async function getAllLabWorkRewards(): Promise<LabWorkReward[]> {
  if (!supabase) return [];
  try {
    const { data, error } = await supabase.from('labwork_rewards').select('*').order('created_at', { ascending: false });
    if (error) return [];
    return data ?? [];
  } catch { return []; }
}

export async function awardLabWorkPoints(address: string, lbPoints: number, reason: string, category?: string, weekId?: string): Promise<Res> {
  if (!supabaseAdmin) return { success: false, error: 'Supabase not configured' };
  try {
    const { error } = await supabaseAdmin.from('labwork_rewards').insert({
      address: address.trim(), lb_points: lbPoints, reason: reason.trim(),
      category: category || 'other', awarded_by: 'admin', week_id: weekId || '',
    });
    return res(error);
  } catch (e: any) { return { success: false, error: e.message }; }
}

export async function deleteLabWorkReward(id: string): Promise<Res> {
  if (!supabaseAdmin) return { success: false, error: 'Supabase not configured' };
  try { const { error } = await supabaseAdmin.from('labwork_rewards').delete().eq('id', id); return res(error); }
  catch (e: any) { return { success: false, error: e.message }; }
}

export async function clearAllLabWorkRewards(): Promise<Res> {
  if (!supabaseAdmin) return { success: false, error: 'Supabase not configured' };
  try { const { error } = await supabaseAdmin.from('labwork_rewards').delete().neq('id', '00000000-0000-0000-0000-000000000000'); return res(error); }
  catch (e: any) { return { success: false, error: e.message }; }
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

// shared in-memory map (set by BurnLeaderboard, read by others)
let _sbLabWorkMap: Map<string, number> | null = null;
export function setSupabaseLabWorkMap(m: Map<string, number>) { _sbLabWorkMap = m; }
export function getSupabaseLabWorkMap(): Map<string, number> | null { return _sbLabWorkMap; }

// ═════════════════════════════════════════════
// 2. WEEKLY CONFIG (active challenge)
// ═════════════════════════════════════════════
export async function getWeeklyConfig(): Promise<any | null> {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase.from('weekly_config').select('*').eq('id', 'current').single();
    if (error || !data) return null;
    return {
      weekId: data.week_id ?? '', status: data.status ?? 'upcoming',
      startDate: data.start_date ?? '', endDate: data.end_date ?? '',
      challenges: data.challenges ?? [], prizes: data.prizes ?? [[], [], []],
      winners: data.winners ?? [], sendReceipts: data.send_receipts ?? [],
      sectionConfirmed: data.section_confirmed ?? {},
    };
  } catch { return null; }
}

export async function saveWeeklyConfig(config: any): Promise<Res> {
  if (!supabaseAdmin) return { success: false, error: 'Supabase not configured' };
  try {
    const { error } = await supabaseAdmin.from('weekly_config').upsert({
      id: 'current',
      week_id: config.weekId ?? '', status: config.status ?? 'upcoming',
      start_date: config.startDate || null, end_date: config.endDate || null,
      challenges: config.challenges ?? [], prizes: config.prizes ?? [[], [], []],
      winners: config.winners ?? [], send_receipts: config.sendReceipts ?? [],
      section_confirmed: config.sectionConfirmed ?? {},
      updated_at: new Date().toISOString(),
    }, { onConflict: 'id' });
    return res(error);
  } catch (e: any) { return { success: false, error: e.message }; }
}

// cache
let _wcCache: { data: any; ts: number } | null = null;
const WC_TTL = 15_000;
export async function getCachedWeeklyConfig(): Promise<any | null> {
  if (_wcCache && Date.now() - _wcCache.ts < WC_TTL) return _wcCache.data;
  const d = await getWeeklyConfig();
  _wcCache = { data: d, ts: Date.now() };
  return d;
}
export function invalidateWeeklyConfigCache() { _wcCache = null; }

// ═════════════════════════════════════════════
// 3. CHALLENGE LOGS (completed weeks)
// ═════════════════════════════════════════════
export async function getChallengeLogs(): Promise<any[]> {
  if (!supabase) return [];
  try {
    const { data, error } = await supabase.from('challenge_logs').select('*').order('created_at', { ascending: false });
    if (error) return [];
    return (data ?? []).map(d => ({
      weekId: d.week_id, status: d.status,
      startDate: d.start_date, endDate: d.end_date, stoppedAt: d.stopped_at,
      challenges: d.challenges ?? [], prizes: d.prizes ?? [[], [], []],
      winners: d.winners ?? [], sendReceipts: d.send_receipts ?? [],
    }));
  } catch { return []; }
}

export async function addChallengeLog(log: any): Promise<Res> {
  if (!supabaseAdmin) return { success: false, error: 'Supabase not configured' };
  try {
    const { error } = await supabaseAdmin.from('challenge_logs').insert({
      week_id: log.weekId ?? '', status: log.status ?? 'ended',
      start_date: log.startDate || null, end_date: log.endDate || null,
      stopped_at: log.stoppedAt || new Date().toISOString(),
      challenges: log.challenges ?? [], prizes: log.prizes ?? [[], [], []],
      winners: log.winners ?? [], send_receipts: log.sendReceipts ?? [],
    });
    return res(error);
  } catch (e: any) { return { success: false, error: e.message }; }
}

export async function updateChallengeLog(weekId: string, updates: any): Promise<Res> {
  if (!supabaseAdmin) return { success: false, error: 'Supabase not configured' };
  try {
    const payload: any = {};
    if (updates.winners !== undefined) payload.winners = updates.winners;
    if (updates.sendReceipts !== undefined) payload.send_receipts = updates.sendReceipts;
    if (updates.status !== undefined) payload.status = updates.status;
    const { error } = await supabaseAdmin.from('challenge_logs').update(payload).eq('week_id', weekId);
    return res(error);
  } catch (e: any) { return { success: false, error: e.message }; }
}

export async function deleteChallengeLog(weekId: string): Promise<Res> {
  if (!supabaseAdmin) return { success: false, error: 'Supabase not configured' };
  try { const { error } = await supabaseAdmin.from('challenge_logs').delete().eq('week_id', weekId); return res(error); }
  catch (e: any) { return { success: false, error: e.message }; }
}

// cache
let _clCache: { data: any[]; ts: number } | null = null;
const CL_TTL = 30_000;
export async function getCachedChallengeLogs(): Promise<any[]> {
  if (_clCache && Date.now() - _clCache.ts < CL_TTL) return _clCache.data;
  const d = await getChallengeLogs();
  _clCache = { data: d, ts: Date.now() };
  return d;
}
export function invalidateChallengeLogsCache() { _clCache = null; }

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
  if (!supabaseAdmin) return { success: false, error: 'Supabase not configured' };
  try {
    const { error } = await supabaseAdmin.from('announcements').insert({
      title: ann.title, body: ann.message, category: ann.type, pinned: false,
    });
    return res(error);
  } catch (e: any) { return { success: false, error: e.message }; }
}

export async function deleteAnnouncement(id: string): Promise<Res> {
  if (!supabaseAdmin) return { success: false, error: 'Supabase not configured' };
  try { const { error } = await supabaseAdmin.from('announcements').delete().eq('id', id); return res(error); }
  catch (e: any) { return { success: false, error: e.message }; }
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
// 5. LAB WORK SUBMISSIONS
// ═════════════════════════════════════════════
export interface LabWorkSubmission {
  id: string; address: string; category: string; links: string[];
  description: string; status: string; review_note: string; created_at: string;
}

export async function getSubmissions(): Promise<LabWorkSubmission[]> {
  if (!supabase) return [];
  try {
    const { data, error } = await supabase.from('labwork_submissions').select('*').order('created_at', { ascending: false });
    if (error) return [];
    return (data ?? []).map(d => ({ ...d, links: d.links ?? [] }));
  } catch { return []; }
}

export async function addSubmission(sub: { address: string; category: string; links: string[]; description: string }): Promise<Res> {
  // Use admin client if available (admin panel), otherwise anon client (public page)
  const client = supabaseAdmin || supabase;
  if (!client) return { success: false, error: 'Supabase not configured' };
  try {
    const { error } = await client.from('labwork_submissions').insert({
      address: sub.address, category: sub.category, links: sub.links, description: sub.description, status: 'pending',
    });
    return res(error);
  } catch (e: any) { return { success: false, error: e.message }; }
}

export async function updateSubmissionStatus(id: string, status: string, reviewNote?: string): Promise<Res> {
  if (!supabaseAdmin) return { success: false, error: 'Supabase not configured' };
  try {
    const { error } = await supabaseAdmin.from('labwork_submissions').update({
      status, review_note: reviewNote || '',
    }).eq('id', id);
    return res(error);
  } catch (e: any) { return { success: false, error: e.message }; }
}

export async function deleteSubmission(id: string): Promise<Res> {
  if (!supabaseAdmin) return { success: false, error: 'Supabase not configured' };
  try { const { error } = await supabaseAdmin.from('labwork_submissions').delete().eq('id', id); return res(error); }
  catch (e: any) { return { success: false, error: e.message }; }
}

export async function clearAllSubmissions(): Promise<Res> {
  if (!supabaseAdmin) return { success: false, error: 'Supabase not configured' };
  try { const { error } = await supabaseAdmin.from('labwork_submissions').delete().neq('id', '00000000-0000-0000-0000-000000000000'); return res(error); }
  catch (e: any) { return { success: false, error: e.message }; }
}


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
        .select('path, referrer, country, city, region, device, browser, os, session_id, visited_at')
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
        .select('session_id, event_type, category, label, value, path, fired_at')
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
  if (!supabase) return;
  try { await supabase.from('saved_addresses').insert(row); } catch {}
}

export async function deleteSavedAddress(id: string): Promise<void> {
  if (!supabase) return;
  try { await supabase.from('saved_addresses').delete().eq('id', id); } catch {}
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
}

/** Upsert today's snapshot — always overwrites with the latest (most complete) data */
export async function upsertPortfolioSnapshot(snap: PortfolioSnapshot): Promise<void> {
  if (!supabase) return;
  try {
    // First check if we already have a snapshot for today
    const { data: existing } = await supabase
      .from('portfolio_snapshots')
      .select('total_usd')
      .eq('wallet', snap.wallet)
      .eq('snapshot_date', snap.snapshot_date)
      .single();

    // Only overwrite if new value is higher (more prices loaded) or no snapshot yet
    if (existing && snap.total_usd <= existing.total_usd) return;

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
// 8. MIGRATION — one-time import from localStorage
// ═════════════════════════════════════════════
export async function migrateAllToSupabase(): Promise<{ labwork: number; config: boolean; logs: number; announcements: number; submissions: number; errors: string[] }> {
  const errors: string[] = [];
  let labwork = 0, logs = 0, announcements = 0, submissions = 0;
  let config = false;

  // Lab Work Rewards
  try {
    const raw = localStorage.getItem('brains_labwork_rewards');
    if (raw) {
      const rewards = JSON.parse(raw);
      if (Array.isArray(rewards)) {
        for (const r of rewards) {
          const { error } = await supabaseAdmin.from('labwork_rewards').insert({
            address: r.address || '', lb_points: r.lbPoints || 0,
            reason: r.reason || 'Migrated', category: r.category || 'other',
            awarded_by: 'admin', week_id: r.weekId || '',
          });
          if (error) errors.push(`LW: ${error.message}`); else labwork++;
        }
      }
    }
  } catch (e: any) { errors.push(`LW parse: ${e.message}`); }

  // Weekly Config
  try {
    const raw = localStorage.getItem('brains_weekly_config');
    if (raw) {
      const cfg = JSON.parse(raw);
      const r = await saveWeeklyConfig(cfg);
      if (r.success) config = true; else if (r.error) errors.push(`WC: ${r.error}`);
    }
  } catch (e: any) { errors.push(`WC parse: ${e.message}`); }

  // Challenge Logs
  try {
    const raw = localStorage.getItem('brains_challenge_log');
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        for (const log of arr) {
          const r = await addChallengeLog(log);
          if (r.success) logs++; else if (r.error) errors.push(`CL: ${r.error}`);
        }
      }
    }
  } catch (e: any) { errors.push(`CL parse: ${e.message}`); }

  // Announcements
  try {
    const raw = localStorage.getItem('brains_announcements');
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        for (const a of arr) {
          const { error } = await supabaseAdmin.from('announcements').insert({
            title: a.title || '', body: a.message || '', category: a.type || 'info',
            pinned: a.pinned || false, created_at: a.date || new Date().toISOString(),
          });
          if (error) errors.push(`ANN: ${error.message}`); else announcements++;
        }
      }
    }
  } catch (e: any) { errors.push(`ANN parse: ${e.message}`); }

  // Submissions
  try {
    const raw = localStorage.getItem('brains_labwork_submissions');
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        for (const s of arr) {
          const { error } = await supabaseAdmin.from('labwork_submissions').insert({
            address: s.address || '', category: s.category || 'other',
            links: s.links || [], description: s.description || '',
            status: s.status || 'pending', created_at: s.date || new Date().toISOString(),
          });
          if (error) errors.push(`SUB: ${error.message}`); else submissions++;
        }
      }
    }
  } catch (e: any) { errors.push(`SUB parse: ${e.message}`); }

  return { labwork, config, logs, announcements, submissions, errors };
}