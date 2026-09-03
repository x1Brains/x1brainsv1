"""
Tests for THE EMOJI news notifier.

⛔⛔ WHY THESE ARE NOT OPTIONAL. Every interesting failure of this bot is one
that LOOKS like it worked: a story announced twice to five hundred people, the
whole back catalogue fired at a new subscriber, a headline with an ampersand in
it that Telegram silently rejects so the story never goes out at all. None of
those raise, and none of them are visible from `flyctl logs` until somebody
complains. So the real handlers are driven against a fake Telegram and a fake
Supabase, and the assertions are on what was SENT.

Run:  python3 test_newsbot.py     (needs python-telegram-bot installed)
"""
from __future__ import annotations
import asyncio, sys, types

# ── a fake newsstore, in memory ────────────────────────────────────────────
import newsstore

class FakeStore:
    def __init__(self):
        self.subs = {}
        self.seen = {"article": set(), "project": set(), "builder": set()}
        self.rows = {"article": [], "project": [], "builder": []}
        self.offset = 0
        self.mark_calls = []          # order matters — see the ordering test
        self.DEFAULT_TOPICS = {"news": True, "projects": True, "builders": True}
    def subscribe(self, chat_id, chat_type, chat_title):
        s = self.subs.get(chat_id)
        if s: s.update({"active": True, "chat_type": chat_type, "chat_title": chat_title})
        else: self.subs[chat_id] = {"chat_id": chat_id, "chat_type": chat_type,
                                    "chat_title": chat_title, "active": True,
                                    "topics": dict(self.DEFAULT_TOPICS)}
        return self.subs[chat_id]
    def get_sub(self, chat_id): return self.subs.get(chat_id)
    def set_active(self, chat_id, active, blocked=False):
        if chat_id in self.subs: self.subs[chat_id]["active"] = active
    def set_topics(self, chat_id, topics): self.subs[chat_id]["topics"] = topics
    def active_subs(self): return [s for s in self.subs.values() if s["active"]]
    def desk_rows(self, kind, limit=30): return list(self.rows[kind])
    def seen_ids(self, kind): return set(self.seen[kind])
    def mark_seen(self, kind, ids):
        self.mark_calls.append(("mark", kind, list(ids)))
        self.seen[kind] |= set(ids)
    def save_offset(self, o): self.offset = o

store = FakeStore()
for name in ("subscribe","get_sub","set_active","set_topics","active_subs",
             "desk_rows","seen_ids","mark_seen","save_offset"):
    setattr(newsstore, name, getattr(store, name))
newsstore.DEFAULT_TOPICS = store.DEFAULT_TOPICS

import newsbot
from telegram.error import Forbidden, TelegramError

# ── a fake Telegram ────────────────────────────────────────────────────────
class FakeBot:
    def __init__(self):
        self.sent = []; self.block = set()
        # user_id -> telegram member status. Anyone absent is a plain member.
        self.roles = {}
        self.member_lookups = 0
        self.lookup_raises = False
    async def send_message(self, chat_id, text, **kw):
        if str(chat_id) in self.block: raise Forbidden("blocked")
        self.sent.append((str(chat_id), text, kw)); store.mark_calls.append(("send", str(chat_id)))
        return types.SimpleNamespace(message_id=len(self.sent))
    async def get_chat_member(self, chat_id, user_id):
        self.member_lookups += 1
        if self.lookup_raises: raise TelegramError("chat not found")
        return types.SimpleNamespace(status=self.roles.get(user_id, "member"))

def chat(cid, ctype="private", title="Reader"):
    cid = int(cid) if str(cid).lstrip("-").isdigit() else cid
    return types.SimpleNamespace(id=cid, type=ctype, title=title if ctype!="private" else None,
                                 first_name="Reader" if ctype=="private" else None, last_name=None)
def msg_update(cid, text, ctype="private", uid=1, sender=7, sender_chat=None):
    return types.SimpleNamespace(update_id=uid, callback_query=None, channel_post=None,
                                 message=types.SimpleNamespace(
                                     text=text, chat=chat(cid, ctype),
                                     from_user=types.SimpleNamespace(id=sender) if sender else None,
                                     sender_chat=sender_chat))

class FakeCB:
    def __init__(self, cid, data, uid=1, ctype="private", sender=7):
        self.update_id = uid; self.data = data; self.answered = []; self.edited = []
        self.message = types.SimpleNamespace(chat=chat(cid, ctype), sender_chat=None)
        self.from_user = types.SimpleNamespace(id=sender)
        self.order = []
    async def answer(self, text=None, show_alert=False): self.answered.append(text); self.order.append("answer")
    async def edit_message_reply_markup(self, reply_markup=None): self.edited.append(reply_markup); self.order.append("edit")
    async def edit_message_text(self, t, **kw): self.edited.append(t); self.order.append("edit")
def cb_update(cb): return types.SimpleNamespace(update_id=cb.update_id, callback_query=cb, message=None, channel_post=None)

bad = 0
def check(name, ok, got=""):
    global bad
    if not ok: bad += 1
    print(f"{'✅' if ok else '❌'} {name}" + ("" if ok else f"\n      got: {str(got)[:200]}"))

async def main():
    bot = FakeBot()
    CFG = {"site_url": "https://www.theemoji.lol", "announce_articles": True,
           "announce_projects": True, "announce_builders": True}

    # ── 1. subscribing ────────────────────────────────────────────────────
    await newsbot.handle_update(bot, msg_update("100", "/start"))
    check("/start subscribes and replies", "100" in store.subs and len(bot.sent) == 1, store.subs)
    check("/start reply carries the toggle keyboard", bot.sent[0][2].get("reply_markup") is not None)

    # ⛔ a returning subscriber must keep the choices they made
    store.subs["100"]["topics"] = {"news": True, "projects": False, "builders": False}
    store.subs["100"]["active"] = False
    await newsbot.handle_update(bot, msg_update("100", "/start"))
    check("a second /start does NOT reset their topics",
          store.subs["100"]["topics"] == {"news": True, "projects": False, "builders": False}
          and store.subs["100"]["active"], store.subs["100"])

    # ⛔ in a group the command arrives with the bot's @mention glued on
    bot.roles = {42: "administrator"}
    await newsbot.handle_update(bot, msg_update("-500", "/start@TheEmojiNewsBot", "supergroup", sender=42))
    check("/start@BotName in a group is recognised", "-500" in store.subs, list(store.subs))

    # ── 2. the toggle buttons ─────────────────────────────────────────────
    cb = FakeCB("100", "t:projects")
    await newsbot.handle_update(bot, cb_update(cb))
    check("tapping a topic flips it", store.subs["100"]["topics"]["projects"] is True, store.subs["100"]["topics"])
    check("the tap is ACKNOWLEDGED before the redraw", cb.order[:2] == ["answer", "edit"], cb.order)

    # ── 3. the message itself ─────────────────────────────────────────────
    art = {"id": "vero-oracle", "title": 'Vero & the <oracle> "problem"', "dek": "A & B", "tag": "CHAIN TEA"}
    post = newsbot.build_post("article", art, "https://www.theemoji.lol")
    check("HTML is escaped in the headline", "&amp;" in post and "&lt;oracle&gt;" in post, post)
    check("the link is the PATH form, which is the one that unfurls",
          "https://www.theemoji.lol/article/vero-oracle" in post and "#/" not in post, post)

    # ── 4. the desk poll ──────────────────────────────────────────────────
    store.subs.clear(); bot.sent.clear(); store.mark_calls.clear()
    store.subs["1"] = {"chat_id": "1", "active": True, "topics": {"news": True,  "projects": True,  "builders": True}}
    store.subs["2"] = {"chat_id": "2", "active": True, "topics": {"news": False, "projects": True,  "builders": True}}
    store.subs["3"] = {"chat_id": "3", "active": False,"topics": {"news": True,  "projects": True,  "builders": True}}
    store.rows["article"] = [{"id": "new-two", "title": "Two", "dek": "", "tag": "TEA"},
                             {"id": "new-one", "title": "One", "dek": "", "tag": "TEA"},
                             {"id": "old-one", "title": "Old", "dek": "", "tag": "TEA"}]
    store.seen["article"] = {"old-one"}

    await newsbot.poll_desk(bot, CFG)
    got = [(c, t.split("\n")[2]) for c, t, _ in bot.sent]
    check("already-announced rows are NOT re-sent", all("Old" not in t for _, t in got), got)
    check("a subscriber with news OFF is skipped", {c for c, _ in got} == {"1"}, got)
    check("an inactive subscriber is skipped", "3" not in {c for c, _ in got}, got)
    check("a burst arrives oldest-first", [t for _, t in got] == ["<b>One</b>", "<b>Two</b>"], got)
    # ⛔⛔ the ordering that stops a mid-crash re-broadcast
    check("rows are marked seen BEFORE the first send",
          store.mark_calls[0][0] == "mark" and store.mark_calls[1][0] == "send", store.mark_calls[:3])

    # ── 5. running it again must be silent ────────────────────────────────
    bot.sent.clear()
    await newsbot.poll_desk(bot, CFG)
    check("a second poll with nothing new sends NOTHING", bot.sent == [], bot.sent)

    # ── 6. a blocked subscriber ───────────────────────────────────────────
    bot.sent.clear(); bot.block = {"1"}
    store.subs["4"] = {"chat_id": "4", "active": True, "topics": {"news": True, "projects": True, "builders": True}}
    store.rows["article"].insert(0, {"id": "new-three", "title": "Three", "dek": "", "tag": "TEA"})
    await newsbot.poll_desk(bot, CFG)
    check("a chat that blocked the bot is deactivated", store.subs["1"]["active"] is False, store.subs["1"])
    check("…and the fan-out CONTINUES past it", [c for c, _, _ in bot.sent] == ["4"], bot.sent)
    bot.block = set()

    # ── 7. the master switch ──────────────────────────────────────────────
    bot.sent.clear()
    store.rows["article"].insert(0, {"id": "new-four", "title": "Four", "dek": "", "tag": "TEA"})
    await newsbot.poll_desk(bot, {**CFG, "announce_articles": False})
    check("the master switch stops articles entirely", bot.sent == [], bot.sent)
    check("…and does NOT mark them seen, so flipping it back still announces",
          "new-four" not in store.seen["article"], store.seen["article"])

    # ── 8. /stop ──────────────────────────────────────────────────────────
    await newsbot.handle_update(bot, msg_update("4", "/stop"))
    check("/stop deactivates", store.subs["4"]["active"] is False)

    # ── 8b. ⛔ IN A GROUP, ONLY ADMINS MAY CHANGE ANYTHING ────────────────
    store.subs.clear(); bot.sent.clear(); bot.roles = {}
    G = "-1001234"
    # a plain member cannot subscribe the whole group
    await newsbot.handle_update(bot, msg_update(G, "/start", "supergroup", sender=99))
    check("a plain member CANNOT /start a group", G not in store.subs, store.subs)
    check("…and is told why", any("admins" in t.lower() for _, t, _ in bot.sent), bot.sent)

    # an admin can
    bot.sent.clear(); bot.roles = {42: "administrator"}
    await newsbot.handle_update(bot, msg_update(G, "/start", "supergroup", sender=42))
    check("an ADMIN can /start a group", G in store.subs, store.subs)

    # a plain member cannot stop it
    bot.sent.clear()
    await newsbot.handle_update(bot, msg_update(G, "/stop", "supergroup", sender=99))
    check("a plain member CANNOT /stop a group", store.subs[G]["active"] is True, store.subs[G])

    # ⛔ the BUTTONS need the same gate — they sit in the group where anyone taps
    cb = FakeCB(G, "t:news", ctype="supergroup", sender=99)
    before = dict(store.subs[G]["topics"])
    await newsbot.handle_update(bot, cb_update(cb))
    check("a plain member CANNOT tap the toggles", store.subs[G]["topics"] == before, store.subs[G]["topics"])
    check("…and gets an alert, not silence", any(a and "admins" in a.lower() for a in cb.answered), cb.answered)
    cb2 = FakeCB(G, "t:news", ctype="supergroup", sender=42)
    await newsbot.handle_update(bot, cb_update(cb2))
    check("an ADMIN can tap the toggles", store.subs[G]["topics"] != before, store.subs[G]["topics"])

    # ⛔ an anonymous admin posts AS THE GROUP — from_user is a bot, sender_chat is the group
    bot.sent.clear(); store.subs.pop(G, None)
    anon = types.SimpleNamespace(id=int(G))
    await newsbot.handle_update(bot, msg_update(G, "/start", "supergroup", sender=1087968824, sender_chat=anon))
    check("an ANONYMOUS admin is allowed", G in store.subs, store.subs)

    # ⛔ if the lookup fails we must FAIL CLOSED
    bot.sent.clear(); store.subs.pop(G, None); bot.lookup_raises = True
    await newsbot.handle_update(bot, msg_update(G, "/start", "supergroup", sender=99))
    check("a failed admin lookup DENIES rather than allows", G not in store.subs, store.subs)
    bot.lookup_raises = False

    # ⛔ a private chat must not pay for a member lookup on every command
    bot.member_lookups = 0
    await newsbot.handle_update(bot, msg_update("777", "/start"))
    check("a private chat is not gated (and costs no lookup)",
          "777" in store.subs and bot.member_lookups == 0, bot.member_lookups)

    # /help stays open to everyone
    bot.sent.clear()
    await newsbot.handle_update(bot, msg_update(G, "/help", "supergroup", sender=99))
    check("/help works for any member", any("news bot" in t.lower() for _, t, _ in bot.sent), bot.sent)

    # ── 9. ⭐ THE CONTROL. Every check above asserts something was suppressed.
    #        This proves the harness can still see a message get through — without
    #        it, a poll_desk that sent nothing at all would score a clean sweep.
    bot.sent.clear(); store.subs["9"] = {"chat_id": "9", "active": True,
                                         "topics": {"news": True, "projects": True, "builders": True}}
    store.rows["builder"] = [{"id": "someone", "name": "Someone", "kind": "BUILDER", "tagline": "Ships"}]
    await newsbot.poll_desk(bot, CFG)
    check("CONTROL: a genuinely new row DOES reach a live subscriber",
          any(c == "9" and "Someone" in t for c, t, _ in bot.sent), bot.sent)

    print("\n" + (f"❌ {bad} failed" if bad else "✅ all news-notifier checks passed"))
    return 1 if bad else 0

sys.exit(asyncio.run(main()))
