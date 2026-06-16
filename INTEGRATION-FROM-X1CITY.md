# x1brainsv2 ← x1city integration notes

Handoff doc from the agent working on `~/bt/x1city-react` to whoever's
building x1brainsv2. Two separate integrations live here:

1. **XT0 guide widget** — a corner chat that helps visitors navigate
   x1brains.io. Owned 50/50: I (x1city-react agent) own the brain
   (system prompt, model, scrubbing, rate limit, cost). You (v2 agent)
   own the widget (React component, UX, when it opens, where it sits).
2. **`x1tx()` confirmation modal pattern** — for any future signed
   write surface in x1brainsv2 (mints, claims, settings). Not urgent
   today, but flagging now so v2 doesn't paint itself into a corner.

---

## Part 1 — XT0 guide widget on x1brainsv2

### What XT0 is (current state)

- Free info / how-to guide tier of X1.City PROTOCOL Network
- Distinct model identity from X1B (premium credit-gated agent)
- Lives at `cf-worker/src/index.ts:XT0_IDENTITY_PROMPT` (~line 382 in
  the x1city-react repo); deployed at `https://api.x1.city/chat`
- Routes directly to DeepSeek (no OpenClaw, no per-citizen credit
  decrement, no agent wallet vault) → cheap to operate, low complexity
- Scoped to 5 "safe markers" only: `[TIME]`, `[CALC]`, `[IMAGE]`,
  `[NETSTATUS]`, `[SEARCH:...]` — no chain reads, no balance lookups,
  no agent writes. Pure chitchat + ecosystem guidance.
- Per the X1B-launch-positioning brand lockdown (2026-05-31), XT0 is
  intentionally narrower than X1B; you can't accidentally upsell it
  into doing X1B's job.

### Ownership / boundary (READ THIS FIRST)

| Surface | Owner | Repo |
|---|---|---|
| XT0 system prompt + behavior tuning | **x1city-react agent (me)** | `~/bt/x1city-react/cf-worker/src/index.ts` |
| XT0 identity scrubber, model routing, SSE format | me | same |
| Rate limiting + cost guardrails | me (cf-worker side) | same |
| Endpoint URL stability, response shape | me | same |
| **v2 widget** — React component, UX, styling, when it opens | **v2 agent (you)** | `~/bt/x1brainsv2/src/` |
| **v2 origin allowlist requests** (more domains, new features) | you ask me | flag back |

**Don't edit anything under `~/bt/x1city-react/cf-worker/`.** If XT0
needs a behavior change (new instruction, new marker, less friendly,
more friendly), file a request back to the x1city-react agent — they
own that prompt.

### Endpoint contract (SHIPPED 2026-06-06)

```
POST https://api.x1.city/chat
Content-Type: application/json

{
  "identity": "XT0",
  "citizen_context": {
    "wallet": "<pubkey base58>",
    "signature": "<base64 64-byte Ed25519 signature>",
    "signed_at": "<ISO-8601 timestamp>"
  },
  "messages": [
    { "role": "user", "content": "what's x1.city?" }
  ]
}
```

Response: **SSE stream** in Anthropic-format event blocks
(`message_start`, `content_block_delta`, `content_block_stop`,
`message_delta`, `message_stop`, `[DONE]`). Plain text deltas live in
`content_block_delta.delta.text`.

### Auth — SHIPPED (Option 1, x1city-react §97/§98.2)

The original menu had three options (anonymous + IP RL, wallet
presence only, hybrid). Operator picked **Option 1 — full wallet+sig
identical to X1B**. Shipped to prod on `api.x1.city/chat` on
2026-06-06. Both X1B and XT0 now require the same Ed25519 wallet
signature over the message:

```
x1city.chat.auth:<wallet_base58>:<signed_at_iso8601>
```

- `signature` field = the base64-encoded 64-byte raw Ed25519 sig
- `signed_at` field = ISO-8601 timestamp; cf-worker rejects ages
  > 6h (`CHAT_AUTH_TTL_MS`) and timestamps > 60s in the future
- Without a valid sig the worker returns HTTP 401 BEFORE any
  DeepSeek call — the pre-§97 exposure (anonymous burn of upstream
  tokens) is fully closed.

**v2 widget MUST**: connect a wallet, prompt the citizen to sign the
challenge message once per session, cache the sig in
`sessionStorage`, and resign every 5h proactively (so a stale sig
doesn't surprise the citizen with an unprompted re-sign mid-chat).

**Why Option 1 won over the anon path**: per-IP buckets without sig
verification are security theater (citizen can fake the wallet, NAT
collisions are real). The operator framed it: "most web3 sites you
have to connect to interact with the app anyways." Wallet+sig also
unlocks per-wallet rate limit buckets that are actually meaningful.

### Rate limit — SHIPPED 50/wallet/24h, Durable Object backed

Every XT0 request decrements a counter keyed by `(wallet × dayKey UTC)`.
At 50 the worker returns HTTP 429 with an upgrade nudge to X1B
(credit-gated, no cap). The counter resets each day via DO alarm.

- **Storage**: Cloudflare Durable Object (`Xt0RateLimitDO` in
  `cf-worker/src/index.ts`). One DO instance per (wallet × dayKey),
  strongly consistent. Was originally KV-backed; KV's eventual
  consistency (up to 60s read lag) let serial bursts walk straight
  past the cap. Swapped to DO 2026-06-06.
- **Failure mode**: fail-open if the binding is missing or DO call
  throws (logged warn). XT0 outage on a marketing site is worse than
  a one-day cost overage.
- **429 response shape**: `{"error": "XT0 daily cap reached (50
  messages per wallet per 24h). Upgrade to X1B for credit-gated
  messaging without the cap, or try again tomorrow. Topup at
  https://x1.city/citizenship/credential."}`. Widget should show
  that body verbatim or a paraphrased "you've hit the daily cap"
  with a link to upgrade.
- **No per-IP bucket**, no NAT collision concern, no origin
  allowlist needed (sig is the load-bearing defense).
- **Test harness**: `~/bt/x1city-react/scripts/test-xt0-auth.mjs` —
  9 cases, all green. Re-run with `node scripts/test-xt0-auth.mjs`
  (negatives + positives) or `RATE_LIMIT_BURST=1 node ...` to verify
  the cap fires at turn 51 exactly.

### Signing the auth challenge — reference

The cf-worker verifies via `crypto.subtle.verify('Ed25519', ...)`.
The browser side uses the wallet adapter's `signMessage`. Minimal
example pattern (TypeScript):

```ts
import { useWallet } from '@solana/wallet-adapter-react';

async function getChatAuth(wallet: ReturnType<typeof useWallet>) {
  if (!wallet.publicKey || !wallet.signMessage) {
    throw new Error('wallet not connected or does not support signMessage');
  }
  const signedAt = new Date().toISOString();
  const msg = new TextEncoder().encode(
    `x1city.chat.auth:${wallet.publicKey.toBase58()}:${signedAt}`,
  );
  const sigBytes = await wallet.signMessage(msg);
  return {
    wallet: wallet.publicKey.toBase58(),
    signature: btoa(String.fromCharCode(...sigBytes)),
    signed_at: signedAt,
  };
}
```

Cache the result in `sessionStorage` keyed by wallet pubkey. Refresh
proactively after 5h (sig TTL is 6h server-side). Pass the cached
object verbatim as `citizen_context` in every chat POST.

### The widget design (your deliverable)

A floating bottom-right corner button that opens a vertical chat
panel. Dismissable. Persists open/closed state in `localStorage`.
Streams responses. Should feel like a navigation aid, not a customer
support widget — XT0's job is "explain X1.City and x1brains" not
"file a ticket".

Suggested component shape:

```
src/components/Xt0GuideWidget.tsx        // the floating button + panel
src/lib/xt0Client.ts                     // fetch + SSE parser
```

Behavior notes:

- **Compact** — 360×480px when open, ~56px circular button when
  closed
- **Greeting** — first-open shows "Hi, I'm XT0 — I can walk you
  through X1Brains. Ask me anything." Don't render any user message
  before the citizen types
- **Streaming** — paint deltas as they arrive (use the SSE
  `content_block_delta.delta.text` field), don't wait for full reply
- **Suggested-prompt chips** — 3-4 prompts under the input on first
  open: "What's LB?", "How do I stake?", "What's a BRAINS pair?",
  "Show me top farms". These are pure prefills, not magic — clicking
  one populates the input
- **Session memory** — persist the message log to `sessionStorage`
  (NOT localStorage) so a reload clears it. Keeps the prompt window
  small + cheap
- **Cap input** — refuse to submit messages > 4000 chars client-side
  with "too long, split it up". The cf-worker enforces 32K but
  catching earlier is friendlier
- **Show the rate-limit response gracefully** when 429 comes back
  (see above) — don't crash, don't keep retrying
- **Don't render markdown chrome** (no code blocks, no tables) —
  XT0's prompt is constrained to plain text + the 5 safe markers.
  If the widget renders a code block, the marker prose looks weird
- **Match the rest of the brand** — pick your accent color, use a
  monospace title font (matches the X1.City aesthetic). The cyber
  vocabulary (corner brackets, scan lines, neon) is documented in
  `~/bt/x1city-react/src/utils/globalStyles.ts` if you want to lift
  visual primitives

UX traps to avoid:

- Don't auto-open the widget on first visit. Annoying.
- Don't show typing dots after every user message — only when
  actually waiting on the SSE stream
- Don't preserve scroll-to-bottom across reload-with-cleared-session

### Integration checklist

- [x] **DONE (my side):** cf-worker enforces wallet+sig auth + 50/wallet/24h DO cap on every XT0 request. Live on `api.x1.city/chat` since 2026-06-06.
- [ ] You build `Xt0GuideWidget.tsx` + `xt0Client.ts` in
      `~/bt/x1brainsv2/src/`
- [ ] You add a wallet connect button (uses
      `@solana/wallet-adapter-react-ui` like x1city does — same
      adapter set is fine: Backpack, Phantom, Solflare)
- [ ] You implement the `getChatAuth()` pattern from the reference
      above + cache the sig in `sessionStorage`
- [ ] You handle the 429 response gracefully (show the message body
      verbatim or paraphrase + link to https://x1.city/citizenship/credential)
- [ ] We turn the widget on with feature-flag `VITE_XT0_WIDGET=1` —
      easy rollback if anything weird happens
- [ ] Watch the cf-worker observability log for the first 24h to
      confirm wallet-sig adoption + 429 rate

---

## Part 2 — `x1tx()` confirmation modal pattern

This is **not urgent** for v2 today — flagging only because the
moment v2 grows any signed write surface (mint, stake, claim, change
settings on-chain), the same trust pattern will matter.

### The pattern (in x1city)

Every signed write in x1city ends with one of these two UX surfaces:

1. **Custom UI that includes the explorer link inline** — used when
   the write has a celebration screen or a status panel that's
   already showing. Example: the Genesis mint reveal has a "VIEW ON
   EXPLORER ↗" button on the celebration card. No popup needed.
2. **`x1tx()` popup** — used when the write has no other surface.
   Pops a small modal with the truncated signature, a "COPY SIG"
   button, and an "OPEN ON EXPLORER ↗" button. Source:
   `~/bt/x1city-react/src/components/X1Modal.tsx` exports
   `x1tx({title, message, signature})`.

Rule we converged on after a UX bug (the popup was stomping the
celebration animation): **either custom UI or x1tx, never both for
the same write**. If a write already has a status surface showing
the explorer link inline, skip the popup. If it doesn't, the popup
IS the confirmation.

### Why this matters for v2

The default UX trap: every write either (a) silently succeeds with
no tx receipt shown, leaving the user wondering "did it land?", or
(b) pops a modal at a moment that breaks the celebration flow. Both
have happened in x1city; the pattern above is what we landed on
after iterating.

When v2 adds any signed write, just:
- Capture the signature from the lib helper return value
- Either render the explorer link in your custom UI for that flow,
  OR call `await x1tx({title, message, signature})` after success
- Don't do both
- Explorer base URL constant: `https://explorer.mainnet.x1.xyz`
  (lives at `~/bt/x1city-react/src/constants.ts:EXPLORER_BASE`)

You can lift the entire `X1Modal.tsx` file as-is if you want a
matching component for v2 — it's ~400 lines of self-contained CSS +
modal store. Or build your own; the rule above is the load-bearing
bit, not the specific implementation.

---

## Questions / things to flag back

Anything not covered here, file back to the x1city-react agent. Most
likely flag-backs:

- **More origins to allowlist** — if x1brainsv2 ships under a new
  domain, tell me, I'll add it
- **Different daily cap** — if 50 is too tight or too loose at real
  traffic, tell me the number you want
- **XT0 prompt change** — if you want XT0 to know about something
  v2-specific (e.g., new LP pair, new feature on x1brains), file the
  text and I'll add it to `XT0_IDENTITY_PROMPT`
- **Suggested-prompt chip copy** — if you want the chips to point at
  v2-specific things ("walk me through staking" etc.), I can echo
  those phrases into the prompt's "common questions" hint section
  so XT0 has better default answers

Don't:

- Edit `cf-worker/`, the system prompts, the OpenClaw plugin, the
  agent vault, or any wallet-adapter wiring under x1city. That's all
  on the x1city-react agent's side.
- Stand up a separate XT0 endpoint in x1brainsv2. There's exactly
  one cf-worker, one identity-scrubbed pipe. Both sites use it.
