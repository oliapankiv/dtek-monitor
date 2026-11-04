// DTEK Kyiv-region outage bot on Cloudflare Workers.
//
// - Telegram bot for many users: /start, /now, /queue, or just send a queue like "6.1".
// - Every 5 min: reads the DTEK schedule and tells users whose queue changed.
// - Every 2 min: asks Tuya whether the Smart Life plug at home is online and tells
//   users of PLUG_QUEUE when power goes off/on.
//
// Settings (Worker → Settings → Variables and Secrets):
//   BOT_TOKEN    secret  Telegram bot token from @BotFather
//   SECRET       secret  random string (letters/digits) protecting the webhook and admin URLs
//   STATE        KV binding
//   PLUG_QUEUE   text    queue of the house with the plug, e.g. 6.1 (optional)
//   TUYA_ID, TUYA_SECRET  secrets, TUYA_DEVICE text   Tuya cloud project + plug (optional)
//   TUYA_API     text    optional, default https://openapi.tuyaeu.com
//   GH_TOKEN secret, GH_REPO text   optional fallback if DTEK blocks Cloudflare (see README)
// Cron Triggers: "*/2 * * * *" (plug) and "*/5 * * * *" (schedule).
//
// URLs: /telegram (webhook), /setup?key=SECRET (one-time setup), /check?key=SECRET (status),
//       PUT /schedule (from the GitHub fallback, Authorization: Bearer SECRET).

const SITE_URL = "https://www.dtek-krem.com.ua/ua/shutdowns";
const QUEUES = [1, 2, 3, 4, 5, 6].flatMap((n) => [`${n}.1`, `${n}.2`]);
const KEYBOARD = {
  keyboard: [1, 2, 3, 4, 5, 6].map((n) => [{ text: `${n}.1` }, { text: `${n}.2` }]),
  resize_keyboard: true,
  one_time_keyboard: true,
};
const HIDE_KEYBOARD = { remove_keyboard: true };
const PLUG_CRON = "*/2 * * * *";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/telegram" && request.method === "POST") {
      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      await onUpdate(env, await request.json());
      return new Response("ok");
    }

    const authed = env.SECRET && (url.searchParams.get("key") === env.SECRET ||
      request.headers.get("Authorization") === `Bearer ${env.SECRET}`);
    if (!authed) return new Response("not found", { status: 404 });
    if (url.pathname === "/setup") return Response.json(await setup(env, url.origin));
    if (url.pathname === "/check") return Response.json(await check(env));
    if (url.pathname === "/schedule" && request.method === "PUT") {
      await saveSchedule(env, await request.json());
      return Response.json({ ok: true });
    }
    return new Response("not found", { status: 404 });
  },

  async scheduled(event, env) {
    if (event.cron === PLUG_CRON) await checkPlug(env);
    else await checkSchedule(env);
  },
};

// ---------- Telegram ----------

async function onUpdate(env, update) {
  // "Stop and block bot" (or the bot removed from a group): forget the user right away,
  // so after Restart /start asks for the queue again.
  const member = update.my_chat_member;
  if (member && ["kicked", "left"].includes(member.new_chat_member?.status)) {
    return env.STATE.delete(`user:${member.chat.id}`);
  }

  const msg = update.message;
  if (!msg?.text) return;
  const chat = msg.chat.id;
  const text = msg.text.trim();
  const queues = await getQueues(env, chat);

  if (text.startsWith("/start") || text.startsWith("/now")) {
    if (!queues) {
      return send(env, chat, "👋 Я надсилаю графік відключень ДТЕК (Київщина) і повідомляю, " +
        "коли він змінюється.\n\nОберіть свою чергу кнопкою або надішліть, напр. " +
        "<code>6.1</code> (кілька: <code>6.1, 3.2</code>).", KEYBOARD);
    }
    return send(env, chat, await statusText(env, queues));
  }
  if (text.startsWith("/queue")) {
    return send(env, chat, "Оберіть чергу кнопкою або надішліть, напр. <code>6.1</code> " +
      "(кілька: <code>6.1, 3.2</code>).", KEYBOARD);
  }
  const picked = parseQueues(text);
  if (!picked) {
    return send(env, chat, "Не зрозумів 🤔 Надішліть номер черги, напр. <code>6.1</code>, " +
      "або /queue.");
  }
  await env.STATE.put(`user:${chat}`, "1", { metadata: { q: picked } });
  return send(env, chat, `✅ Ваша черга: <b>${picked.join(", ")}</b>\n\n` +
    await statusText(env, picked), HIDE_KEYBOARD);
}

// "6.1", "GPV6.1", "6.1, 3.2" -> ["6.1", "3.2"]; anything else -> null
function parseQueues(text) {
  const out = [];
  for (const part of text.toUpperCase().replace(/GPV/g, "").split(/[\s,;]+/).filter(Boolean)) {
    if (!QUEUES.includes(part)) return null;
    if (!out.includes(part)) out.push(part);
  }
  return out.length ? out : null;
}

async function getQueues(env, chat) {
  const { metadata } = await env.STATE.getWithMetadata(`user:${chat}`);
  return metadata?.q || null;
}

async function* users(env) {
  let cursor;
  do {
    const page = await env.STATE.list({ prefix: "user:", cursor });
    for (const k of page.keys) yield { chat: k.name.slice(5), queues: k.metadata?.q || [] };
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
}

async function send(env, chat, text, markup) {
  const body = { chat_id: chat, text, parse_mode: "HTML", link_preview_options: { is_disabled: true } };
  if (markup) body.reply_markup = markup;
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (r.status === 403) await env.STATE.delete(`user:${chat}`); // user blocked the bot
  else if (!r.ok) console.log("sendMessage failed:", r.status, await r.text());
}

async function statusText(env, queues) {
  let schedule = await env.STATE.get("schedule", "json");
  if (!schedule) {
    schedule = await fetchSchedule();
    if (schedule) await env.STATE.put("schedule", JSON.stringify(schedule));
  }
  const parts = [];
  if (env.PLUG_QUEUE && queues.includes(env.PLUG_QUEUE)) {
    const plug = await env.STATE.get("plug", "json");
    if (plug) {
      parts.push(plug.online
        ? `🟢 Зараз світло є з ${kyivTime(plug.since)}${plugQueueLabel(env, queues)}`
        : `🔴 Зараз світла немає з ${kyivTime(plug.since)}, вже ${duration(plug.since)}` +
          plugQueueLabel(env, queues));
    }
  }
  parts.push(schedule ? scheduleText(schedule, queues)
    : "Графік ще не отримано від ДТЕК, спробуйте /now за кілька хвилин.");
  return parts.join("\n\n");
}

// ---------- DTEK schedule ----------

async function checkSchedule(env) {
  const schedule = await fetchSchedule();
  if (schedule) return saveSchedule(env, schedule);
  if (env.GH_TOKEN && env.GH_REPO) await startGithubFetch(env); // it PUTs /schedule back
}

// Stores a new schedule and tells users whose queues changed.
async function saveSchedule(env, schedule) {
  const old = await env.STATE.get("schedule", "json");
  const changed = QUEUES.filter((q) => Object.keys(schedule.fact.data).some((ts) =>
    JSON.stringify(schedule.fact.data[ts]?.[`GPV${q}`]) !==
    JSON.stringify(old?.fact.data[ts]?.[`GPV${q}`])));
  if (old && !changed.length && old.fact.update === schedule.fact.update) return;
  await env.STATE.put("schedule", JSON.stringify(schedule));
  if (!old) return; // first schedule ever: nothing to compare with

  for await (const u of users(env)) {
    if (u.queues.some((q) => changed.includes(q))) {
      await send(env, u.chat, scheduleText(schedule, u.queues, "Графік відключень змінено"));
    }
  }
}

// {fact, names} from the DTEK page, or null if the site didn't give it (anti-bot page).
async function fetchSchedule() {
  try {
    const r = await fetch(SITE_URL, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
        "Accept-Language": "uk-UA,uk;q=0.9",
      },
      signal: AbortSignal.timeout(15000),
    });
    const html = await r.text();
    const fact = extractJson(html, "fact");
    if (!fact?.data) return null;
    return { fact, names: extractJson(html, "preset")?.sch_names || {} };
  } catch (e) {
    console.log("DTEK fetch failed:", e.message);
    return null;
  }
}

// The JSON object after "DisconSchedule.<name> =" in the page.
function extractJson(html, name) {
  let i = html.indexOf(`DisconSchedule.${name}`);
  if (i < 0) return null;
  i = html.indexOf("{", html.indexOf("=", i));
  let depth = 0;
  let inString = false;
  for (let j = i; j < html.length; j++) {
    const c = html[j];
    if (inString) {
      if (c === "\\") j++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return JSON.parse(html.slice(i, j + 1));
  }
  return null;
}

async function startGithubFetch(env) {
  const r = await fetch(
    `https://api.github.com/repos/${env.GH_REPO}/actions/workflows/fetch.yml/dispatches`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GH_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "dtek-bot",
      },
      body: JSON.stringify({ ref: "main" }),
    });
  if (!r.ok) console.log("GitHub dispatch failed:", r.status, await r.text());
}

const OFF = { no: [1, 1], first: [1, 0], second: [0, 1] };
const MAYBE = { maybe: [1, 1], mfirst: [1, 0], msecond: [0, 1] };

// {"1": "no", ..., "24": "yes"} -> [[startMin, endMin], ...] for the given states
function intervals(hours, kinds) {
  const slots = [];
  for (let h = 1; h <= 24; h++) slots.push(...(kinds[hours[String(h)]] || [0, 0]));
  slots.push(0);
  const out = [];
  let start = null;
  slots.forEach((on, i) => {
    if (on && start === null) start = i;
    else if (!on && start !== null) {
      out.push([start * 30, i * 30]);
      start = null;
    }
  });
  return out;
}

function fmt(ranges) {
  const t = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return ranges.map(([a, b]) => `${t(a)}–${t(b)}`).join(", ");
}

function scheduleText({ fact, names }, queues, title = "Графік відключень") {
  const day = new Intl.DateTimeFormat("uk-UA",
    { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", year: "numeric" });
  const lines = [`⚡️ <b>${title}</b>`, `Оновлено на сайті ДТЕК: ${fact.update || "?"}`];
  for (const ts of Object.keys(fact.data).sort((a, b) => a - b)) {
    lines.push("", `📅 <b>${day.format(new Date(ts * 1000))}</b>`);
    for (const q of queues) {
      const hours = fact.data[ts][`GPV${q}`];
      if (!hours) continue;
      const off = intervals(hours, OFF);
      const maybe = intervals(hours, MAYBE);
      let text = off.length ? `🔴 ${fmt(off)}` : "🟢 без відключень";
      if (maybe.length) text += `  🟡 можливо: ${fmt(maybe)}`;
      lines.push(`${names?.[`GPV${q}`] || `Черга ${q}`}: ${text}`);
    }
  }
  return lines.join("\n");
}

// ---------- Smart Life (Tuya) plug ----------

async function checkPlug(env) {
  if (!env.TUYA_ID || !env.TUYA_DEVICE || !env.PLUG_QUEUE) return;
  let online;
  try {
    online = await plugOnline(env);
  } catch (e) {
    console.log(e.message); // unknown is not "off": change nothing
    return;
  }
  const old = await env.STATE.get("plug", "json");
  if (old?.online === online) return;
  const now = new Date().toISOString();
  await env.STATE.put("plug", JSON.stringify({ online, since: now }));
  if (!old) return; // first check: just remember

  for await (const u of users(env)) {
    if (!u.queues.includes(env.PLUG_QUEUE)) continue;
    const q = plugQueueLabel(env, u.queues);
    await send(env, u.chat, online
      ? `🟢 <b>Світло з'явилося</b> о ${kyivTime(now)}${q}, не було ${duration(old.since, now)}`
      : `🔴 <b>Світло зникло</b> о ${kyivTime(now)}${q}`);
  }
}

function plugQueueLabel(env, queues) {
  return queues.length > 1 ? ` (черга ${env.PLUG_QUEUE})` : "";
}

async function plugOnline(env) {
  const path = `/v1.0/devices/${env.TUYA_DEVICE}`;
  let res = await tuyaGet(env, path, await tuyaToken(env));
  if (!res.success && res.code === 1010) res = await tuyaGet(env, path, await tuyaToken(env, true));
  if (!res.success) throw new Error(`Tuya device: ${res.code} ${res.msg}`);
  return res.result.online;
}

async function tuyaToken(env, fresh = false) {
  if (!fresh) {
    const cached = await env.STATE.get("tuya_token");
    if (cached) return cached;
  }
  const res = await tuyaGet(env, "/v1.0/token?grant_type=1");
  if (!res.success) throw new Error(`Tuya token: ${res.code} ${res.msg}`);
  await env.STATE.put("tuya_token", res.result.access_token,
    { expirationTtl: Math.max(60, res.result.expire_time - 300) });
  return res.result.access_token;
}

// Signed GET (https://developer.tuya.com/en/docs/iot/new-singnature).
async function tuyaGet(env, path, token = "") {
  const t = String(Date.now());
  const emptyBodySha256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const sign = await hmacHex(env.TUYA_SECRET,
    env.TUYA_ID + token + t + `GET\n${emptyBodySha256}\n\n${path}`);
  const headers = { client_id: env.TUYA_ID, sign, t, sign_method: "HMAC-SHA256" };
  if (token) headers.access_token = token;
  const r = await fetch((env.TUYA_API || "https://openapi.tuyaeu.com") + path, { headers });
  return r.json();
}

async function hmacHex(secret, text) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

// ---------- helpers, setup, status ----------

function kyivTime(iso) {
  return new Date(iso).toLocaleTimeString("uk-UA",
    { timeZone: "Europe/Kyiv", hour: "2-digit", minute: "2-digit" });
}

function duration(fromIso, toIso = new Date().toISOString()) {
  const mins = Math.round((new Date(toIso) - new Date(fromIso)) / 60000);
  return `${Math.floor(mins / 60)} год ${mins % 60} хв`;
}

const telegram = (env, method, body) =>
  fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  }).then((r) => r.json());

// Open /setup?key=SECRET once after deploying: connects the bot to this Worker.
async function setup(env, origin) {
  return {
    webhook: await telegram(env, "setWebhook", {
      url: `${origin}/telegram`,
      secret_token: env.SECRET,
      allowed_updates: ["message", "my_chat_member"],
    }),
    commands: await telegram(env, "setMyCommands", {
      commands: [
        { command: "start", description: "Почати: графік і статус світла" },
        { command: "now", description: "Поточний графік і статус світла" },
        { command: "queue", description: "Змінити чергу" },
      ],
    }),
  };
}

async function check(env) {
  const out = {
    BOT_TOKEN: !!env.BOT_TOKEN,
    SECRET_valid: /^[A-Za-z0-9_-]{1,256}$/.test(env.SECRET || ""),
    STATE_kv: !!env.STATE?.get,
    PLUG_QUEUE: env.PLUG_QUEUE || null,
  };
  if (!out.STATE_kv) return out;
  let n = 0;
  for await (const _ of users(env)) n++;
  out.users = n;
  out.schedule_update = (await env.STATE.get("schedule", "json"))?.fact.update || null;
  out.dtek_readable_from_cloudflare = !!(await fetchSchedule());
  out.github_fallback = !!(env.GH_TOKEN && env.GH_REPO);
  out.plug_saved_state = await env.STATE.get("plug", "json");
  if (env.TUYA_ID && env.TUYA_SECRET && env.TUYA_DEVICE) {
    try {
      out.plug_online_now = await plugOnline(env);
    } catch (e) {
      out.plug_error = e.message;
    }
  }
  if (env.BOT_TOKEN) {
    const wh = await telegram(env, "getWebhookInfo");
    out.webhook_url = wh.result?.url || "(not set: open /setup)";
    out.webhook_last_error = wh.result?.last_error_message || null;
  }
  return out;
}
