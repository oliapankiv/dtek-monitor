"""Watch the DTEK Kyiv-region shutdown schedule and notify via Telegram on change."""
import hashlib
import json
import os
import sys
from datetime import datetime
from zoneinfo import ZoneInfo

import requests
from playwright.sync_api import sync_playwright
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

URL = "https://www.dtek-krem.com.ua/ua/shutdowns"
STATE_FILE = os.environ.get("STATE_FILE", "state.json")
KYIV = ZoneInfo("Europe/Kyiv")

BOT_TOKEN = os.environ["TELEGRAM_BOT_TOKEN"]
CHAT_ID = os.environ["TELEGRAM_CHAT_ID"]
# Default queues until you pick some in the bot, e.g. "6.1" or "GPV3.1,4.2". Empty = all.
DEFAULT_QUEUES = os.environ.get("QUEUES", "")
API = f"https://api.telegram.org/bot{BOT_TOKEN}"

ALL_LABEL = "Усі черги"
# Queue picker shown on /start or /queue: 1.1 1.2 / ... / 6.1 6.2 / Усі черги.
# It hides itself after one tap.
KEYBOARD = {"keyboard": [[{"text": f"{n}.1"}, {"text": f"{n}.2"}] for n in range(1, 7)]
                        + [[{"text": ALL_LABEL}]],
            "resize_keyboard": True, "one_time_keyboard": True}
HIDE_KEYBOARD = {"remove_keyboard": True}

# GitHub runners sometimes get "connection reset" from Telegram; retry those.
HTTP = requests.Session()
HTTP.mount("https://", HTTPAdapter(max_retries=Retry(
    total=5, backoff_factor=2, allowed_methods=None,
    status_forcelist=[429, 500, 502, 503, 504])))

OFF = {"no": (True, True), "first": (True, False), "second": (False, True)}
MAYBE = {"maybe": (True, True), "mfirst": (True, False), "msecond": (False, True)}

USER_AGENT = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36")


def fetch_html():
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--disable-blink-features=AutomationControlled"])
        page = browser.new_page(locale="uk-UA", user_agent=USER_AGENT,
                                viewport={"width": 1366, "height": 768})
        page.goto(URL, wait_until="domcontentloaded", timeout=90_000)
        # The site may show an anti-bot interstitial first; wait until the
        # schedule script is in the HTML (DisconSchedule isn't a window global).
        html = ""
        for _ in range(45):
            html = page.content()
            if "DisconSchedule.fact" in html:
                break
            page.wait_for_timeout(2000)
        else:
            with open("debug.html", "w", encoding="utf-8") as f:
                f.write(html)
            page.screenshot(path="debug.png", full_page=True)
            raise RuntimeError(f"Schedule not found on page (title: {page.title()!r}); "
                               "saved debug.html and debug.png")
        browser.close()
    return html


def extract(html, name):
    marker = f"DisconSchedule.{name}"
    i = html.index(marker)
    i = html.index("=", i) + 1
    while html[i].isspace():
        i += 1
    return json.JSONDecoder().raw_decode(html, i)[0]


def intervals(hours, kinds):
    """Turn {"1": state, ..., "24": state} into [(start_min, end_min)] ranges."""
    slots = []
    for h in range(1, 25):
        first, second = kinds.get(hours.get(str(h)), (False, False))
        slots += [first, second]
    out, start = [], None
    for i, on in enumerate(slots + [False]):
        if on and start is None:
            start = i
        elif not on and start is not None:
            out.append((start * 30, i * 30))
            start = None
    return out


def fmt(rng):
    return ", ".join(f"{a // 60:02d}:{a % 60:02d}–{b // 60:02d}:{b % 60:02d}" for a, b in rng)


def parse_queues(text):
    """'6.1', 'GPV6.1', '6.1, 3.2' -> ['GPV6.1', ...]; 'all' -> []; invalid -> None."""
    text = text.strip()
    if text.lower() in (ALL_LABEL.lower(), "all", "усі", "всі"):
        return []
    out = []
    for q in text.replace(",", " ").split():
        q = q.upper().removeprefix("GPV")
        if q not in {f"{n}.{m}" for n in range(1, 7) for m in (1, 2)}:
            return None
        out.append(f"GPV{q}")
    return out or None


def build_message(fact, preset, queues, title="Графік відключень ДТЕК (Київщина) змінено"):
    names = preset.get("sch_names", {})
    lines = [f"⚡️ <b>{title}</b>",
             f"Оновлено на сайті: {fact.get('update', '?')}", ""]
    for ts, groups in sorted(fact["data"].items(), key=lambda kv: int(kv[0])):
        day = datetime.fromtimestamp(int(ts), KYIV).strftime("%d.%m.%Y")
        lines.append(f"📅 <b>{day}</b>")
        for q in queues or sorted(groups):
            if q not in groups:
                continue
            off = intervals(groups[q], OFF)
            maybe = intervals(groups[q], MAYBE)
            text = f"🔴 {fmt(off)}" if off else "🟢 без відключень"
            if maybe:
                text += f"  🟡 можливо: {fmt(maybe)}"
            lines.append(f"{names.get(q, q)}: {text}")
        lines.append("")
    lines.append(URL)
    return "\n".join(lines)


def relevant(fact, queues):
    """The part of the data we compare (ignores the 'update' timestamp)."""
    return {ts: {q: g for q, g in groups.items() if not queues or q in queues}
            for ts, groups in fact["data"].items()}


def send(text, markup=None):
    body = {"chat_id": CHAT_ID, "text": text, "parse_mode": "HTML",
            "disable_web_page_preview": True}
    if markup:
        body["reply_markup"] = markup
    r = HTTP.post(f"{API}/sendMessage", json=body, timeout=30)
    r.raise_for_status()


def reply(text, markup=None):
    """Like send(), but a failed reply to a command doesn't stop the run."""
    try:
        send(text, markup)
    except requests.RequestException as e:
        print(f"Could not send reply: {e}")


def handle_messages(state):
    """Read messages sent to the bot since the last run. Returns True if /now was asked."""
    r = HTTP.get(f"{API}/getUpdates",
                 params={"offset": state.get("offset", 0), "timeout": 0}, timeout=30)
    r.raise_for_status()
    want_now = False
    for upd in r.json()["result"]:
        state["offset"] = upd["update_id"] + 1
        msg = upd.get("message") or {}
        text = msg.get("text", "")
        if str(msg.get("chat", {}).get("id")) != str(CHAT_ID) or not text:
            continue  # ignore strangers who found the bot
        if text.startswith(("/start", "/queue")):
            reply("Оберіть свою чергу кнопкою нижче (або надішліть, напр. <code>6.1</code> "
                 "чи <code>3.2, 6.1</code>).\n/now — поточний графік.\n"
                 "Бот відповідає протягом ~10 хв.", KEYBOARD)
        elif text.startswith("/now"):
            want_now = True
        elif (queues := parse_queues(text)) is not None:
            state["queues"] = queues
            label = ", ".join(q.removeprefix("GPV") for q in queues) or "усі"
            reply(f"✅ Стежу за чергою: <b>{label}</b>", HIDE_KEYBOARD)
            want_now = True
        else:
            reply("Не зрозумів 🤔 Надішліть номер черги, напр. <code>6.1</code> "
                 "або /queue, щоб обрати кнопкою.")
    return want_now


def main():
    try:
        with open(STATE_FILE) as f:
            state = json.load(f)
    except FileNotFoundError:
        state = {}
    if "queues" not in state:
        state["queues"] = parse_queues(DEFAULT_QUEUES) or []

    try:
        want_now = handle_messages(state)
    except requests.RequestException as e:
        print(f"Could not read bot messages: {e}")  # still check the schedule
        want_now = False
    # Save right away so commands aren't re-processed if fetching the page fails.
    with open(STATE_FILE, "w") as f:
        json.dump(state, f)

    # Optional: pass a saved HTML file for offline testing.
    if len(sys.argv) > 1:
        with open(sys.argv[1], encoding="utf-8") as f:
            html = f.read()
    else:
        html = fetch_html()
    fact, preset = extract(html, "fact"), extract(html, "preset")
    queues = state["queues"]
    digest = hashlib.sha256(json.dumps(relevant(fact, queues), sort_keys=True).encode()).hexdigest()

    if want_now:
        send(build_message(fact, preset, queues, title="Поточний графік відключень"))
        print("Sent current schedule on request.")
    elif digest != state.get("digest"):
        send(build_message(fact, preset, queues))
        print("Change detected, notification sent.")
    else:
        print("No change.")
    state.update(digest=digest, update=fact.get("update"))
    with open(STATE_FILE, "w") as f:
        json.dump(state, f)


if __name__ == "__main__":
    main()
