"""Watch the DTEK Kyiv-region shutdown schedule and notify via Telegram on change."""
import hashlib
import json
import os
import sys
from datetime import datetime
from zoneinfo import ZoneInfo

import requests
from playwright.sync_api import sync_playwright

URL = "https://www.dtek-krem.com.ua/ua/shutdowns"
STATE_FILE = os.environ.get("STATE_FILE", "state.json")
KYIV = ZoneInfo("Europe/Kyiv")

BOT_TOKEN = os.environ["TELEGRAM_BOT_TOKEN"]
CHAT_ID = os.environ["TELEGRAM_CHAT_ID"]
# Comma-separated queues, e.g. "6.1" or "GPV3.1,4.2". Empty = all queues.
QUEUES = [q if q.startswith("GPV") else f"GPV{q}"
          for q in (q.strip() for q in os.environ.get("QUEUES", "").split(",")) if q]

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


def build_message(fact, preset):
    names = preset.get("sch_names", {})
    lines = ["⚡️ <b>Графік відключень ДТЕК (Київщина) змінено</b>",
             f"Оновлено на сайті: {fact.get('update', '?')}", ""]
    for ts, groups in sorted(fact["data"].items(), key=lambda kv: int(kv[0])):
        day = datetime.fromtimestamp(int(ts), KYIV).strftime("%d.%m.%Y")
        lines.append(f"📅 <b>{day}</b>")
        for q in QUEUES or sorted(groups):
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


def relevant(fact):
    """The part of the data we compare (ignores the 'update' timestamp)."""
    return {ts: {q: g for q, g in groups.items() if not QUEUES or q in QUEUES}
            for ts, groups in fact["data"].items()}


def send(text):
    r = requests.post(f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage",
                      json={"chat_id": CHAT_ID, "text": text, "parse_mode": "HTML",
                            "disable_web_page_preview": True}, timeout=30)
    r.raise_for_status()


def main():
    # Optional: pass a saved HTML file for offline testing.
    if len(sys.argv) > 1:
        with open(sys.argv[1], encoding="utf-8") as f:
            html = f.read()
    else:
        html = fetch_html()
    fact, preset = extract(html, "fact"), extract(html, "preset")
    digest = hashlib.sha256(json.dumps(relevant(fact), sort_keys=True).encode()).hexdigest()

    try:
        with open(STATE_FILE) as f:
            old = json.load(f).get("digest")
    except FileNotFoundError:
        old = None

    if digest == old:
        print("No change.")
        return
    send(build_message(fact, preset))
    with open(STATE_FILE, "w") as f:
        json.dump({"digest": digest, "update": fact.get("update")}, f)
    print("Change detected, notification sent.")


if __name__ == "__main__":
    main()
