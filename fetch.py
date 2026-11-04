"""Fallback for when DTEK blocks Cloudflare: open the page in a real browser and
send the schedule to the Worker. The Worker starts this workflow itself."""
import json
import os

import requests
from playwright.sync_api import Error as PlaywrightError, sync_playwright

URL = "https://www.dtek-krem.com.ua/ua/shutdowns"
USER_AGENT = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36")


def extract(html, name):
    i = html.index("=", html.index(f"DisconSchedule.{name}")) + 1
    while html[i].isspace():
        i += 1
    return json.JSONDecoder().raw_decode(html, i)[0]


def page_html():
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome",
                                    args=["--disable-blink-features=AutomationControlled"])
        page = browser.new_page(locale="uk-UA", user_agent=USER_AGENT)
        page.goto(URL, wait_until="domcontentloaded", timeout=90_000)
        # The anti-bot check shows its own page first and then reloads the real one.
        for _ in range(45):
            try:
                html = page.content()
            except PlaywrightError:  # page is reloading
                html = ""
            if "DisconSchedule.fact" in html:
                return html
            page.wait_for_timeout(2000)
    raise SystemExit("Schedule not found on the DTEK page")


html = page_html()
schedule = {"fact": extract(html, "fact"), "names": extract(html, "preset").get("sch_names", {})}
r = requests.put(f"{os.environ['WORKER_URL'].rstrip('/')}/schedule", json=schedule, timeout=30,
                 headers={"Authorization": f"Bearer {os.environ['WORKER_SECRET']}"})
r.raise_for_status()
print("Schedule sent, updated on site:", schedule["fact"].get("update"))
