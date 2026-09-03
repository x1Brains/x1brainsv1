"""
THE EMOJI news notifier
=======================
The second bot in this process, and the opposite shape to the buy bot.

  buy bot   — watches the CHAIN, broadcasts to ONE group it was configured with
  this one  — watches the DESK, fans out to MANY chats that subscribed themselves

It runs as a second asyncio task inside the same Fly machine (see bot.py). No
extra host, no extra deploy, no inbound port: like the buy bot it is a pure
poller, and Telegram commands arrive over long-polling `getUpdates` rather than
a webhook. That matters — `fly.toml` has no `[[services]]` block, so the machine
has no listening socket to give a webhook, and adding one is what killed the
buy bot's first deploy.

⛔ ITS OWN TELEGRAM TOKEN, from `news_bot_connection`. Sharing the buy bot's
   token would mean the two fight over `getUpdates` (Telegram delivers each
   update once, to whoever asks first) and readers of the paper would be
   messaging a bot called X1 Brains.
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Optional

from telegram import Bot, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.constants import ParseMode
from telegram.error import Forbidden, RetryAfter, TelegramError

import newsstore

log = logging.getLogger("newsbot")

# ⛔ Telegram's documented ceiling is ~30 messages/second across all chats. This
#    sits under it with room for the buy bot sharing the same egress. A desk
#    with 500 subscribers takes ~25s to fan out one story, which is fine — the
#    alternative is a 429 storm and a queue that never drains.
SEND_DELAY = 0.05
UPDATE_TIMEOUT = 25          # long-poll seconds; must be < the HTTP read timeout
TOPICS = ("news", "projects", "builders")
LABELS = {"news": "📰 News", "projects": "🚀 Projects", "builders": "🛠 Builders"}
# Which topic switch governs which desk table.
TOPIC_OF = {"article": "news", "project": "projects", "builder": "builders"}
# The master switch in news_state.config that governs each desk table.
MASTER_OF = {
    "article": "announce_articles",
    "project": "announce_projects",
    "builder": "announce_builders",
}


# ═══════════════════════════════════════════════════════════════
# MESSAGES
# ═══════════════════════════════════════════════════════════════
def esc(s: str) -> str:
    """⛔ HTML parse mode, and every value below is desk-written prose. A stray
    `<` in a headline is not markup here, it is a parse error, and Telegram
    rejects the WHOLE message — the story silently never goes out. Markdown was
    the other option and is worse: an unpaired `*` or `_` in a title breaks it
    the same way, and headlines contain those far more often than angle
    brackets."""
    return (s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def build_post(kind: str, row: dict, site: str) -> str:
    """One link, and the card does the rest.

    ⭐ The site now serves real Open Graph tags per story (see `api/og.ts` in the
    lol repo), so Telegram unfurls this link into a card with the headline, the
    dek and the lead art by itself. That is why this sends a LINK and not a
    photo: no image fetch, no Supabase egress, no banner to keep in step, and
    the card stays correct when the desk edits the story."""
    if kind == "article":
        head = f"📰 <b>THE EMOJI</b>"
        tag = esc(row.get("tag") or "")
        if tag:
            head += f" · {tag}"
        body = f"<b>{esc(row.get('title'))}</b>"
        dek = esc(row.get("dek") or "")
        if dek:
            body += f"\n{dek}"
        url = f"{site}/article/{row['id']}"
    elif kind == "project":
        emo = row.get("emo") or "🚀"
        head = f"{emo} <b>ON THE BOARD</b> · {esc(row.get('status') or '')}"
        body = f"<b>{esc(row.get('name'))}</b>"
        blurb = esc(row.get("blurb") or "")
        if blurb:
            body += f"\n{blurb}"
        url = f"{site}/project/{row['id']}"
    else:
        head = f"🛠 <b>NEW BUILDER</b> · {esc(row.get('kind') or '')}"
        body = f"<b>{esc(row.get('name'))}</b>"
        line = esc(row.get("tagline") or "")
        if line:
            body += f"\n{line}"
        url = f"{site}/builder/{row['id']}"
    return f"{head}\n\n{body}\n\n{url}"


def settings_kb(topics: dict) -> InlineKeyboardMarkup:
    """⛔ The state is drawn INTO the button label. An inline keyboard has no
    checked appearance of its own, so a row that just says "News" tells a
    subscriber nothing about whether news is on — which is the entire question
    they opened this menu to answer."""
    rows = [
        [InlineKeyboardButton(
            f"{'✅' if topics.get(t, True) else '⬜️'}  {LABELS[t]}",
            callback_data=f"t:{t}",
        )]
        for t in TOPICS
    ]
    rows.append([InlineKeyboardButton("🔕  Stop everything", callback_data="stop")])
    return InlineKeyboardMarkup(rows)


WELCOME = (
    "😂 <b>THE EMOJI</b> — the desk, in your pocket.\n\n"
    "You'll get a message when the desk files a story, adds a project to the "
    "board, or puts up a builder profile.\n\n"
    "Pick what you want below. /settings to change it later, /stop to turn it "
    "all off."
)
HELP = (
    "😂 <b>THE EMOJI news bot</b>\n\n"
    "/start — subscribe\n"
    "/settings — choose news, projects, builders\n"
    "/stop — unsubscribe\n"
    "/help — this\n\n"
    'Add me to a group and I\'ll post there instead. Make sure I can send '
    "messages.\n\nhttps://www.theemoji.lol"
)


# ═══════════════════════════════════════════════════════════════
# INCOMING — commands and toggle taps
# ═══════════════════════════════════════════════════════════════
async def handle_update(bot: Bot, upd: Any) -> None:
    cb = getattr(upd, "callback_query", None)
    if cb is not None:
        await handle_callback(bot, cb)
        return

    msg = getattr(upd, "message", None) or getattr(upd, "channel_post", None)
    if msg is None or not (msg.text or ""):
        return
    chat = msg.chat
    chat_id = str(chat.id)
    # ⛔ Group commands arrive as "/start@TheEmojiBot" — split the mention off or
    #    every command in a group is unrecognised, which looks like the bot
    #    being dead in exactly the place it is most visible.
    cmd = (msg.text or "").strip().split()[0].split("@")[0].lower()
    title = chat.title or " ".join(filter(None, [chat.first_name, chat.last_name])) or chat_id

    if cmd in ("/start", "/subscribe"):
        sub = newsstore.subscribe(chat_id, chat.type, title)
        topics = sub.get("topics") or newsstore.DEFAULT_TOPICS
        await bot.send_message(chat_id, WELCOME, parse_mode=ParseMode.HTML,
                               reply_markup=settings_kb(topics),
                               disable_web_page_preview=True)
        log.info(f"➕ subscribed {chat_id} ({chat.type}) {title!r}")
    elif cmd in ("/settings", "/topics"):
        sub = newsstore.get_sub(chat_id)
        if not sub or not sub.get("active"):
            await bot.send_message(chat_id, "You're not subscribed yet — send /start.",
                                   parse_mode=ParseMode.HTML)
            return
        await bot.send_message(chat_id, "What do you want to hear about?",
                               reply_markup=settings_kb(sub.get("topics") or {}))
    elif cmd in ("/stop", "/unsubscribe"):
        newsstore.set_active(chat_id, False)
        await bot.send_message(chat_id, "🔕 Done — nothing more from me. /start any time.")
        log.info(f"➖ unsubscribed {chat_id}")
    elif cmd == "/help":
        await bot.send_message(chat_id, HELP, parse_mode=ParseMode.HTML,
                               disable_web_page_preview=True)


async def handle_callback(bot: Bot, cb: Any) -> None:
    chat_id = str(cb.message.chat.id)
    data = cb.data or ""
    sub = newsstore.get_sub(chat_id)
    if not sub:
        await cb.answer("Send /start first.", show_alert=True)
        return

    if data == "stop":
        newsstore.set_active(chat_id, False)
        await cb.answer("Unsubscribed.")
        await cb.edit_message_text("🔕 Off. /start any time.")
        return

    if data.startswith("t:"):
        t = data[2:]
        if t not in TOPICS:
            await cb.answer()
            return
        topics = dict(sub.get("topics") or newsstore.DEFAULT_TOPICS)
        topics[t] = not topics.get(t, True)
        newsstore.set_topics(chat_id, topics)
        # ⛔ answer() FIRST. Telegram spins a loading state on the button until
        #    the callback is answered, and the edit below is the slower call —
        #    answering after it makes every tap feel like it hung.
        await cb.answer(f"{LABELS[t]} {'on' if topics[t] else 'off'}")
        try:
            await cb.edit_message_reply_markup(reply_markup=settings_kb(topics))
        except TelegramError:
            # "message is not modified" and friends — the state is already saved,
            # so a failed redraw is cosmetic and must not surface as an error.
            pass


async def drain_updates(bot: Bot, offset: int) -> int:
    """Returns the new offset. ⛔ Long-poll, so an idle bot costs one held
    connection rather than a request every second."""
    try:
        updates = await bot.get_updates(
            offset=offset or None, timeout=UPDATE_TIMEOUT,
            allowed_updates=["message", "channel_post", "callback_query"],
        )
    except RetryAfter as e:
        await asyncio.sleep(float(e.retry_after) + 1)
        return offset
    except TelegramError as e:
        log.warning(f"getUpdates: {e}")
        await asyncio.sleep(5)
        return offset

    for upd in updates:
        try:
            await handle_update(bot, upd)
        except Forbidden:
            # They blocked the bot between sending a command and our reply.
            log.info("update from a chat that has blocked the bot — skipping")
        except Exception as e:
            log.warning(f"update {getattr(upd, 'update_id', '?')}: {e}", exc_info=True)
        # ⛔ ADVANCED PER UPDATE, NOT PER BATCH. One update that throws must not
        #    make the whole batch replay on the next poll — that is an infinite
        #    loop where the same bad message is retried forever and nothing
        #    behind it is ever processed.
        offset = max(offset, upd.update_id + 1)
    if updates:
        try:
            newsstore.save_offset(offset)
        except Exception as e:
            log.warning(f"save_offset: {e}")
    return offset


# ═══════════════════════════════════════════════════════════════
# OUTGOING — the desk poll and the fan-out
# ═══════════════════════════════════════════════════════════════
async def broadcast(bot: Bot, kind: str, text: str, subs: list[dict]) -> int:
    topic = TOPIC_OF[kind]
    sent = 0
    for sub in subs:
        if not (sub.get("topics") or {}).get(topic, True):
            continue
        chat_id = sub["chat_id"]
        try:
            await bot.send_message(chat_id, text, parse_mode=ParseMode.HTML)
            sent += 1
        except Forbidden:
            # ⛔ 403 = blocked by the user, or kicked from the group. Retrying
            #    forever is how a subscriber list rots into mostly-dead chats
            #    that eat the rate limit on every story.
            log.info(f"   {chat_id} blocked the bot — deactivating")
            try:
                newsstore.set_active(chat_id, False, blocked=True)
            except Exception:
                pass
        except RetryAfter as e:
            log.warning(f"   rate limited, sleeping {e.retry_after}s")
            await asyncio.sleep(float(e.retry_after) + 1)
            try:
                await bot.send_message(chat_id, text, parse_mode=ParseMode.HTML)
                sent += 1
            except TelegramError as e2:
                log.warning(f"   {chat_id}: {e2}")
        except TelegramError as e:
            log.warning(f"   {chat_id}: {e}")
        await asyncio.sleep(SEND_DELAY)
    return sent


async def poll_desk(bot: Bot, cfg: dict) -> None:
    site = (cfg.get("site_url") or "https://www.theemoji.lol").rstrip("/")
    subs: Optional[list[dict]] = None

    for kind in ("article", "project", "builder"):
        if not cfg.get(MASTER_OF[kind], True):
            continue
        try:
            rows = newsstore.desk_rows(kind)
            seen = newsstore.seen_ids(kind)
        except Exception as e:
            log.warning(f"desk read ({kind}): {e}")
            continue

        fresh = [r for r in rows if r["id"] not in seen]
        if not fresh:
            continue
        # Oldest first, so a burst of three stories arrives in the order the
        # desk filed them rather than newest-first.
        fresh.reverse()

        # ⛔ MARKED SEEN BEFORE A SINGLE MESSAGE GOES OUT — see the note on
        #    mark_seen. A crash mid-fan-out must lose an announcement, never
        #    repeat one to everybody.
        try:
            newsstore.mark_seen(kind, [r["id"] for r in fresh])
        except Exception as e:
            log.warning(f"mark_seen ({kind}) failed — NOT broadcasting: {e}")
            continue

        if subs is None:
            try:
                subs = newsstore.active_subs()
            except Exception as e:
                log.warning(f"active_subs: {e}")
                return
        if not subs:
            log.info(f"   {len(fresh)} new {kind}(s), no subscribers yet")
            continue

        for row in fresh:
            text = build_post(kind, row, site)
            n = await broadcast(bot, kind, text, subs)
            log.info(f"📣 {kind} {row['id']} → {n} chat(s)")


# ═══════════════════════════════════════════════════════════════
# THE LOOP
# ═══════════════════════════════════════════════════════════════
async def run() -> None:
    log.info("😂 THE EMOJI news notifier starting…")
    bot: Optional[Bot] = None
    last_token = ""
    offset = 0
    loaded_offset = False
    #  ⛔ A MONOTONIC CLOCK, NOT A COUNTER OF `UPDATE_TIMEOUT`. The long poll
    #  returns IMMEDIATELY when a command arrives, so adding the full timeout
    #  per cycle credits 25 seconds to a cycle that took 0.2 — and a busy bot
    #  would then hammer the desk tables many times a minute. That is precisely
    #  the uncached-polling pattern that burned this project's Supabase egress
    #  quota once already; `time.monotonic()` measures what actually elapsed.
    last_poll = 0.0

    while True:
        try:
            conn = newsstore.load_connection()
            #  ⛔⛔ ONLY THE TOKEN GATES THE WHOLE LOOP. `enabled` used to gate it
            #  too, which made the admin panel's own caption a lie — it says
            #  "paused: nothing goes out, subscriptions still work", and with the
            #  loop skipped there was no `getUpdates` at all, so a /start while
            #  paused was never even RECEIVED. Telegram holds it for 24h and
            #  replays it later, so the reader gets silence and assumes the bot
            #  is dead.
            #
            #  ⭐ Paused now means what the word means: still listening, still
            #  taking subscriptions and topic changes, just not announcing. The
            #  `enabled` check moved down to the desk poll, which is the only
            #  thing that should stop.
            if not conn["telegram_token"]:
                log.info("⏸  news notifier idle — no token yet; add one at /x9b7r41ns/bot")
                await asyncio.sleep(30)
                continue

            if conn["telegram_token"] != last_token:
                bot = Bot(token=conn["telegram_token"])
                last_token = conn["telegram_token"]
                log.info(f"   news bot ready → @{conn.get('bot_username') or '?'}")

            state = newsstore.load_state()
            cfg = state["config"] or {}
            if not loaded_offset:
                offset = state["update_offset"]
                loaded_offset = True
                log.info(f"   resuming update offset at {offset}")

            assert bot is not None
            # ⛔ The long poll IS the pacing. It parks for up to UPDATE_TIMEOUT
            #    seconds waiting for a command, so the desk poll below runs
            #    roughly every cycle and the `poll_seconds` check keeps it to
            #    the configured rate rather than once per 25s.
            offset = await drain_updates(bot, offset)

            now = time.monotonic()
            if now - last_poll >= float(cfg.get("poll_seconds", 90)):
                last_poll = now
                #  ⛔ THE PAUSE LIVES HERE, and it deliberately skips the poll
                #  ENTIRELY rather than polling and dropping the result. Marking
                #  rows seen while paused would mean everything published during
                #  the pause is silently swallowed the moment it is switched back
                #  on — the desk would think it had announced a week of stories
                #  that nobody ever received.
                if conn["enabled"]:
                    await poll_desk(bot, cfg)
                else:
                    log.info("⏸  paused — listening for commands, not announcing")

        except Exception as e:
            log.error(f"news loop error: {e}", exc_info=True)
            await asyncio.sleep(10)
