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
    const { data, error } = await supabase.from('labwork_rewards').select('address, lb_points');
    if (error) { console.error('[SB] getLabWorkMap:', error.message); return map; }
    for (const r of data ?? []) map.set(r.address, (map.get(r.address) || 0) + r.lb_points);
  } catch (e) { console.error('[SB] getLabWorkMap:', e); }
  return map;
}

export async function getLabWorkPtsForWallet(address: string): Promise<number> {
  if (!supabase) return 0;
  try {
    const { data, error } = await supabase.from('labwork_rewards').select('lb_points').eq('address', address);
    if (error) return 0;
    return (data ?? []).reduce((s, r) => s + r.lb_points, 0);
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
// 6. MIGRATION — one-time import from localStorage
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