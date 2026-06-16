// XT0 chat client — talks to the shared x1city cf-worker (api.x1.city/chat).
// Auth is an Ed25519 wallet signature over `x1city.chat.auth:<wallet>:<signed_at>`
// (see INTEGRATION-FROM-X1CITY.md). The signature is cached in sessionStorage
// and proactively refreshed before the 6h server TTL.

const XT0_ENDPOINT = 'https://api.x1.city/chat';
const AUTH_REFRESH_MS = 5 * 60 * 60 * 1000; // resign after 5h (server TTL is 6h)

export interface ChatAuth {
  wallet: string;
  signature: string;   // base64 of the raw 64-byte Ed25519 sig
  signed_at: string;   // ISO-8601
}

export type SignMessageFn = (msg: Uint8Array) => Promise<Uint8Array>;

function authKey(wallet: string) { return `xt0_auth_${wallet}`; }

/** Get a (cached or freshly-signed) auth blob. Prompts the wallet to sign only
 *  when there's no valid cached signature for this wallet. */
export async function getChatAuth(wallet: string, signMessage: SignMessageFn): Promise<ChatAuth> {
  try {
    const raw = sessionStorage.getItem(authKey(wallet));
    if (raw) {
      const cached = JSON.parse(raw) as ChatAuth;
      const age = Date.now() - new Date(cached.signed_at).getTime();
      if (cached.wallet === wallet && age >= 0 && age < AUTH_REFRESH_MS) return cached;
    }
  } catch { /* ignore */ }

  const signed_at = new Date().toISOString();
  const msg = new TextEncoder().encode(`x1city.chat.auth:${wallet}:${signed_at}`);
  const sigBytes = await signMessage(msg);
  let bin = '';
  for (const b of sigBytes) bin += String.fromCharCode(b);
  const auth: ChatAuth = { wallet, signature: btoa(bin), signed_at };
  try { sessionStorage.setItem(authKey(wallet), JSON.stringify(auth)); } catch { /* ignore */ }
  return auth;
}

export interface ApiMessage { role: 'user' | 'assistant'; content: string; }

export interface StreamHandlers {
  onDelta: (text: string) => void;
  onDone: () => void;
  /** status 0 = network/abort; 401 = bad sig; 429 = rate cap; else server error. */
  onError: (status: number, body: string) => void;
}

/** POST the conversation to XT0 and stream the Anthropic-format SSE reply. */
export async function streamXt0Chat(
  auth: ChatAuth,
  messages: ApiMessage[],
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(XT0_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identity: 'XT0', citizen_context: auth, messages }),
      signal,
    });
  } catch (e: unknown) {
    handlers.onError(0, e instanceof Error ? e.message : 'network error');
    return;
  }

  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => '');
    handlers.onError(res.status, body);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let gotDone = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const events = buf.split('\n\n');
    buf = events.pop() ?? '';
    for (const ev of events) {
      for (const line of ev.split('\n')) {
        const m = line.match(/^data:\s?(.*)$/);
        if (!m) continue;
        const data = m[1];
        if (data === '[DONE]') { gotDone = true; continue; }
        try {
          const json = JSON.parse(data);
          if (json?.type === 'content_block_delta' && typeof json?.delta?.text === 'string') {
            handlers.onDelta(json.delta.text);
          }
        } catch { /* keepalive / non-JSON line — ignore */ }
      }
    }
  }
  handlers.onDone();
  void gotDone;
}

// ── Daily message cap (client-side, per wallet, UTC day) ────────────────────
// XT0 free tier in x1brainsv2: 17 messages / wallet / 24h. Past that we point
// the citizen at the premium X1B terminal (its own LB/BRAINS-burn credit system).
export const XT0_DAILY_CAP = 17;
export const X1B_PREMIUM_URL = 'https://x1city.io/agent';

function countKey(wallet: string) {
  const day = new Date().toISOString().slice(0, 10); // UTC YYYY-MM-DD
  return `xt0_count_${wallet}_${day}`;
}
export function getDailyCount(wallet: string): number {
  try { return parseInt(localStorage.getItem(countKey(wallet)) || '0', 10) || 0; } catch { return 0; }
}
export function bumpDailyCount(wallet: string): number {
  const n = getDailyCount(wallet) + 1;
  try { localStorage.setItem(countKey(wallet), String(n)); } catch { /* ignore */ }
  return n;
}
