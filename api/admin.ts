// api/admin.ts
// ─────────────────────────────────────────────────────────────────────────────
// Vercel serverless route — proxies Supabase admin (write) operations.
// The service role key lives here as SUPABASE_SERVICE_KEY (no VITE_ prefix)
// so it is NEVER bundled into client-side JS.
//
// Auth: every request must include x-admin-wallet header matching ADMIN_WALLET.
// This is a simple shared-secret style check — the wallet address is not
// truly secret, but it prevents casual abuse. For stronger auth, require a
// signed message from the wallet (future upgrade).
//
// Allowed actions (POST /api/admin):
//   { action: 'award_lbp',          payload: { address, lb_points, reason, category, week_id } }
//   { action: 'delete_lbp',         payload: { id } }
//   { action: 'clear_all_lbp' }
//   { action: 'save_weekly_config', payload: { ...config } }
//   { action: 'add_challenge_log',  payload: { ...log } }
//   { action: 'update_challenge_log', payload: { week_id, updates: {...} } }
//   { action: 'delete_challenge_log', payload: { week_id } }
//   { action: 'add_announcement',   payload: { title, message, type } }
//   { action: 'delete_announcement', payload: { id } }
//   { action: 'update_submission',  payload: { id, status, review_note } }
//   { action: 'delete_submission',  payload: { id } }
//   { action: 'clear_all_submissions' }
//   { action: 'insert_submission',  payload: { address, category, links, description } }
//   { action: 'insert_burn_event',  payload: { sig, wallet, amount, block_time } }
//   { action: 'insert_announcement', payload: { title, body, category, pinned, created_at } }
//   { action: 'insert_lbp_reward',  payload: { address, lb_points, reason, category, awarded_by, week_id } }
//   { action: 'save_address',       payload: { owner_wallet, saved_wallet, nickname } }
//   { action: 'delete_address',     payload: { id } }
//   { action: 'get_addresses',      payload: { owner_wallet } }
// ─────────────────────────────────────────────────────────────────────────────

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { handleBotAction, isBotAction } from './_bot-actions';

const SUPABASE_URL      = process.env.SUPABASE_URL      || '';
const SUPABASE_SERVICE  = process.env.SUPABASE_SERVICE_KEY || '';
const ADMIN_WALLET      = process.env.ADMIN_WALLET || '2nVaSvCqrsdskcbtn47uquNDL7Q69To1k45FpYBvWnuC';

function ok(res: VercelResponse, data?: any) {
  return res.status(200).json({ success: true, data: data ?? null });
}
function err(res: VercelResponse, msg: string, status = 400) {
  return res.status(status).json({ success: false, error: msg });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS — only allow from x1brains.io
  res.setHeader('Access-Control-Allow-Origin', 'https://x1brains.io');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-wallet');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return err(res, 'Method not allowed', 405);

  // Auth check
  const wallet = req.headers['x-admin-wallet'] as string;
  if (!wallet || wallet !== ADMIN_WALLET) {
    return err(res, 'Unauthorized', 403);
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE) {
    return err(res, 'Supabase not configured on server', 500);
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE);
  const { action, payload } = req.body as { action: string; payload?: any };

  // ── Bot actions (delegated to _bot-actions.ts) ──────────────
  if (isBotAction(action)) {
    const result = await handleBotAction(action, payload, wallet);
    return res.status(result.success ? 200 : 400).json(result);
  }

  try {
    switch (action) {

      // ── Lab Work Points ──────────────────────────────────────────
      case 'award_lbp': {
        const { address, lb_points, reason, category, week_id } = payload;
        const { error } = await sb.from('labwork_rewards').insert({
          address: address.trim(), lb_points, reason: reason.trim(),
          category: category || 'other', awarded_by: 'admin', week_id: week_id || '',
        });
        if (error) return err(res, error.message);
        return ok(res);
      }

      case 'delete_lbp': {
        const { error } = await sb.from('labwork_rewards').delete().eq('id', payload.id);
        if (error) return err(res, error.message);
        return ok(res);
      }

      case 'clear_all_lbp': {
        const { error } = await sb.from('labwork_rewards')
          .delete().neq('id', '00000000-0000-0000-0000-000000000000');
        if (error) return err(res, error.message);
        return ok(res);
      }

      // ── Weekly Config ────────────────────────────────────────────
      case 'save_weekly_config': {
        const config = payload;
        const { error } = await sb.from('weekly_config').upsert({
          id: 'current',
          week_id: config.weekId ?? '', status: config.status ?? 'upcoming',
          start_date: config.startDate || null, end_date: config.endDate || null,
          challenges: config.challenges ?? [], prizes: config.prizes ?? [[], [], []],
          winners: config.winners ?? [], send_receipts: config.sendReceipts ?? [],
          section_confirmed: config.sectionConfirmed ?? {},
          updated_at: new Date().toISOString(),
        }, { onConflict: 'id' });
        if (error) return err(res, error.message);
        return ok(res);
      }

      // ── Challenge Logs ───────────────────────────────────────────
      case 'add_challenge_log': {
        const log = payload;
        const { error } = await sb.from('challenge_logs').insert({
          week_id: log.weekId ?? '', status: log.status ?? 'ended',
          start_date: log.startDate || null, end_date: log.endDate || null,
          stopped_at: log.stoppedAt || new Date().toISOString(),
          challenges: log.challenges ?? [], prizes: log.prizes ?? [[], [], []],
          winners: log.winners ?? [], send_receipts: log.sendReceipts ?? [],
        });
        if (error) return err(res, error.message);
        return ok(res);
      }

      case 'update_challenge_log': {
        const { week_id, updates } = payload;
        const p: any = {};
        if (updates.winners      !== undefined) p.winners       = updates.winners;
        if (updates.sendReceipts !== undefined) p.send_receipts = updates.sendReceipts;
        if (updates.status       !== undefined) p.status        = updates.status;
        const { error } = await sb.from('challenge_logs').update(p).eq('week_id', week_id);
        if (error) return err(res, error.message);
        return ok(res);
      }

      case 'delete_challenge_log': {
        const { error } = await sb.from('challenge_logs').delete().eq('week_id', payload.week_id);
        if (error) return err(res, error.message);
        return ok(res);
      }

      // ── Announcements ────────────────────────────────────────────
      case 'add_announcement': {
        const { title, message, type } = payload;
        const { error } = await sb.from('announcements').insert({
          title, body: message, category: type, pinned: false,
        });
        if (error) return err(res, error.message);
        return ok(res);
      }

      case 'insert_announcement': {
        const { error } = await sb.from('announcements').insert(payload);
        if (error) return err(res, error.message);
        return ok(res);
      }

      case 'delete_announcement': {
        const { error } = await sb.from('announcements').delete().eq('id', payload.id);
        if (error) return err(res, error.message);
        return ok(res);
      }

      // ── Submissions ──────────────────────────────────────────────
      case 'update_submission': {
        const { id, status, review_note } = payload;
        const { error } = await sb.from('labwork_submissions').update({
          status, review_note: review_note || '',
        }).eq('id', id);
        if (error) return err(res, error.message);
        return ok(res);
      }

      case 'delete_submission': {
        const { error } = await sb.from('labwork_submissions').delete().eq('id', payload.id);
        if (error) return err(res, error.message);
        return ok(res);
      }

      case 'clear_all_submissions': {
        const { error } = await sb.from('labwork_submissions')
          .delete().neq('id', '00000000-0000-0000-0000-000000000000');
        if (error) return err(res, error.message);
        return ok(res);
      }

      case 'insert_submission': {
        const { address, category, links, description } = payload;
        const { error } = await sb.from('labwork_submissions').insert({
          address, category, links, description, status: 'pending',
        });
        if (error) return err(res, error.message);
        return ok(res);
      }

      // ── Misc inserts (migration / burn events) ───────────────────
      case 'insert_burn_event': {
        const { error } = await sb.from('burn_events')
          .upsert(payload, { onConflict: 'sig', ignoreDuplicates: true });
        if (error) return err(res, error.message);
        return ok(res);
      }

      case 'insert_lbp_reward': {
        const { error } = await sb.from('labwork_rewards').insert(payload);
        if (error) return err(res, error.message);
        return ok(res);
      }

      // ── Saved Addresses ──────────────────────────────────────────
      case 'save_address': {
        const { owner_wallet, saved_wallet, nickname } = payload;
        if (!owner_wallet || owner_wallet.length < 32 || owner_wallet.length > 44)
          return err(res, 'Invalid owner_wallet');
        if (!saved_wallet || saved_wallet.length < 32 || saved_wallet.length > 44)
          return err(res, 'Invalid saved_wallet');
        if (!nickname || nickname.length > 50)
          return err(res, 'Invalid nickname');
        const { error } = await sb.from('saved_addresses').insert({
          owner_wallet: owner_wallet.trim(),
          saved_wallet: saved_wallet.trim(),
          nickname:     nickname.trim(),
        });
        if (error) return err(res, error.message);
        return ok(res);
      }

      case 'delete_address': {
        const { id } = payload;
        if (!id) return err(res, 'Missing id');
        const { error } = await sb.from('saved_addresses').delete().eq('id', id);
        if (error) return err(res, error.message);
        return ok(res);
      }

      case 'get_addresses': {
        const { owner_wallet } = payload;
        if (!owner_wallet) return err(res, 'Missing owner_wallet');
        const { data, error } = await sb
          .from('saved_addresses')
          .select('*')
          .eq('owner_wallet', owner_wallet)
          .order('created_at', { ascending: false });
        if (error) return err(res, error.message);
        return ok(res, data);
      }

      default:
        return err(res, `Unknown action: ${action}`, 400);
    }
  } catch (e: any) {
    return err(res, e?.message ?? 'Internal error', 500);
  }
}