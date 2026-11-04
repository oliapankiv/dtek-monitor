# DTEK outage bot (Київщина)

A Telegram bot that runs entirely on a free **Cloudflare Worker** (`worker.js`):

- Anyone can use it: `/start`, `/now` (schedule + power status), `/queue`, or just
  send a queue like `6.1` (several: `6.1, 3.2`).
- Every 5 min it reads https://www.dtek-krem.com.ua/ua/shutdowns and messages
  the users whose queue changed.
- Every 2 min it asks Tuya whether the Smart Life plug at home is online, and on the
  first change tells users of `PLUG_QUEUE` (🔴 power off / 🟢 power back).
- Replies are instant (Telegram webhook). No server, no cron-job.org.

GitHub is needed **only** if DTEK blocks Cloudflare (step 7).

## 1. Telegram bot

In Telegram, message @BotFather → `/newbot` → copy the **token**.
(Reusing an existing bot is fine: use its token.)

## 2. Cloudflare Worker

1. https://dash.cloudflare.com → **Workers & Pages → Create → Start with Hello World!**
   → name e.g. `dtek-bot` → **Deploy**.
2. **Edit code** → replace everything with `worker.js` → **Deploy**.
   Your Worker URL looks like `https://dtek-bot.<you>.workers.dev`.
3. **Storage & Databases → KV → Create** a namespace `dtek`. Worker → **Settings →
   Bindings → Add → KV namespace**: variable name `STATE`, namespace `dtek`.
4. Worker → **Settings → Variables and Secrets → Add**:

   | Name | Type | Value |
   |---|---|---|
   | `BOT_TOKEN` | Secret | token from step 1 |
   | `SECRET` | Secret | 30+ random letters and digits only (no spaces or symbols) |
   | `PLUG_QUEUE` | Text | `6.1` (queue of the house with the plug) |

5. Worker → **Settings → Triggers → Cron Triggers → Add** two triggers:
   `*/2 * * * *` (plug) and `*/5 * * * *` (schedule). Deploy.
6. Open once in a browser: `https://dtek-bot.<you>.workers.dev/setup?key=<SECRET>`.
   Both `webhook` and `commands` should say `"ok": true`.
7. In Telegram send your bot `/start` and pick your queue.

## 3. Smart Life plug (Tuya)

Plug it into an outlet that is **not** on a UPS/inverter. (If only the internet
goes down, it will also look like a power cut.)

1. https://iot.tuya.com → **Cloud → Development → Create Cloud Project**:
   Development Method *Smart Home*, Data Center **Central Europe**. Authorize the
   suggested API services (IoT Core and Authorization Token Management are the ones used).
2. Project **Overview**: copy **Access ID** and **Access Secret**.
3. Project **Devices → Link App Account → Add App Account**: scan the QR code in
   Smart Life (Me → scan icon). In **All Devices** copy the plug's **Device ID**.
4. Worker → Variables and Secrets: `TUYA_ID` (Secret), `TUYA_SECRET` (Secret),
   `TUYA_DEVICE` (Text). Other data center? Add Text `TUYA_API`, e.g.
   `https://openapi-weaz.tuyaeu.com` (Western Europe).

The Tuya *IoT Core* trial is free but must be extended in the Tuya console from
time to time (Tuya emails you).

## 4. Check

Open `https://dtek-bot.<you>.workers.dev/check?key=<SECRET>`:

- `webhook_url` is your Worker and `webhook_last_error` is `null`.
- `plug_online_now: true`, and `plug_saved_state` appears after the first 2-min trigger.
- `schedule_update` shows a time after the first 5-min trigger.
- `dtek_readable_from_cloudflare: true` → done, you don't need GitHub.
  `false` → do step 5.

Errors also show in Worker → **Logs**.

## 5. Only if DTEK blocks Cloudflare: GitHub fallback

The Worker then starts a GitHub workflow that opens the page in a real browser
and sends the schedule back. Nothing runs on GitHub otherwise.

1. A **public** GitHub repo (unlimited free Actions minutes) with `fetch.py`,
   `requirements.txt` and `.github/workflows/fetch.yml` from this folder.
2. Repo → Settings → Secrets and variables → Actions → **Secrets**:
   `WORKER_URL` = `https://dtek-bot.<you>.workers.dev`, `WORKER_SECRET` = same `SECRET`.
3. GitHub → Settings → Developer settings → **Fine-grained tokens** → new token,
   only this repo, permission **Actions: Read and write**.
4. Worker → Variables and Secrets: `GH_TOKEN` (Secret) = that token,
   `GH_REPO` (Text) = `<you>/<repo>`.
