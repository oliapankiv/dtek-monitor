// Cloudflare Worker: answers the Telegram bot instantly from the last saved schedule.
//
// Bindings (Worker → Settings → Variables / Bindings):
//   BOT_TOKEN  (secret)  Telegram bot token
//   CHAT_ID    (secret)  your chat id; everyone else is ignored
//   SECRET     (secret)  any long random string, same as WORKER_SECRET in GitHub
//   STATE      (KV namespace) stores "queues" and "schedule"
// Optional, used when there is no schedule yet and DTEK blocks the Worker:
//   GH_TOKEN   (secret)  GitHub token with Actions: Read and write (same as for cron-job.org)
//   GH_REPO    (text)    e.g. oliapankiv/dtek-monitor
//
// Routes:
//   POST /telegram   Telegram webhook (checks X-Telegram-Bot-Api-Secret-Token)
//   GET  /queues     for monitor.py: the queues picked in the bot
//   PUT  /schedule   from monitor.py: latest {fact, names}
//   GET  /check      open in a browser to see what is missing in the setup

const SITE_URL = "https://www.dtek-krem.com.ua/ua/shutdowns";
const ALL_LABEL = "Усі черги";
const VALID = new Set([1, 2, 3, 4, 5, 6].flatMap((n) => [`${n}.1`, `${n}.2`]));
const KEYBOARD = {
  keyboard: [1, 2, 3, 4, 5, 6].map((n) => [{ text: `${n}.1` }, { text: `${n}.2` }])
    .concat([[{ text: ALL_LABEL }]]),
  resize_keyboard: true,
  one_time_keyboard: true,
};
const HIDE_KEYBOARD = { remove_keyboard: true };
const OFF = { no: [1, 1], first: [1, 0], second: [0, 1] };
const MAYBE = { maybe: [1, 1], mfirst: [1, 0], msecond: [0, 1] };

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    const auth = request.headers.get("Authorization") === `Bearer ${env.SECRET}`;

    if (path === "/telegram" && request.method === "POST") {
      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      await handleUpdate(await request.json(), env);
      return new Response("ok");
    }
    if (path === "/queues" && request.method === "GET" && auth) {
      return Response.json({
        queues: await env.STATE.get("queues", "json"),
        has_schedule: (await env.STATE.get("schedule")) !== null,
      });
    }
    if (path === "/schedule" && request.method === "PUT" && auth) {
      await env.STATE.put("schedule", await request.text());
      // Someone asked for the schedule while we had none: answer them now.
      if (await env.STATE.get("pending_now")) {
        await env.STATE.delete("pending_now");
        await sendMessage(env, await currentSchedule(env));
      }
      return Response.json({ ok: true });
    }
    if (path === "/check") {
      return Response.json(await check(env), { headers: { "Cache-Control": "no-store" } });
    }
    return new Response("not found", { status: 404 });
  },
};

async function handleUpdate(update, env) {
  const msg = update.message || {};
  const text = (msg.text || "").trim();
  if (String(msg.chat?.id) !== String(env.CHAT_ID) || !text) return; // ignore strangers

  const send = (t, markup) => sendMessage(env, t, markup);
  if (text.startsWith("/start") || text.startsWith("/queue")) {
    return send("Оберіть свою чергу кнопкою нижче (або надішліть, напр. <code>6.1</code> " +
      "чи <code>3.2, 6.1</code>).\n/now — поточний графік.", KEYBOARD);
  }
  if (text.startsWith("/now")) {
    return send(await currentSchedule(env));
  }
  const queues = parseQueues(text);
  if (queues === null) {
    return send("Не зрозумів 🤔 Надішліть номер черги, напр. <code>6.1</code> " +
      "або /queue, щоб обрати кнопкою.");
  }
  await env.STATE.put("queues", JSON.stringify(queues));
  const label = queues.map((q) => q.replace("GPV", "")).join(", ") || "усі";
  return send(`✅ Стежу за чергою: <b>${label}</b>\n\n` + await currentSchedule(env),
    HIDE_KEYBOARD);
}

async function currentSchedule(env) {
  let schedule = await env.STATE.get("schedule", "json");
  if (!schedule) {
    // Nothing saved yet: read the DTEK page ourselves and keep the result.
    schedule = await fetchFromSite();
    if (schedule) {
      await env.STATE.put("schedule", JSON.stringify(schedule));
    } else if (await startGithubCheck(env)) {
      await env.STATE.put("pending_now", "1", { expirationTtl: 1800 });
      return "⏳ Перевіряю сайт ДТЕК — графік прийде за кілька хвилин.";
    } else {
      return "Графіка ще немає — дочекайтеся першої перевірки сайту.";
    }
  }
  const queues = (await env.STATE.get("queues", "json")) || [];
  return buildMessage(schedule.fact, schedule.names || {}, queues);
}

// Returns {fact, names} from the DTEK page, or null if the site didn't give it to us
// (it sometimes shows an anti-bot page instead).
async function fetchFromSite() {
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

// Reads the JSON object after "DisconSchedule.<name> =" in the page.
function extractJson(html, name) {
  let i = html.indexOf(`DisconSchedule.${name}`);
  if (i < 0) return null;
  i = html.indexOf("{", html.indexOf("=", i));
  let depth = 0, inString = false;
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

// Starts the GitHub workflow; it sends the schedule to PUT /schedule when done.
async function startGithubCheck(env) {
  if (!env.GH_TOKEN || !env.GH_REPO) return false;
  const r = await fetch(
    `https://api.github.com/repos/${env.GH_REPO}/actions/workflows/monitor.yml/dispatches`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GH_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "dtek-bot-worker",
      },
      body: JSON.stringify({ ref: "main" }),
    });
  if (!r.ok) console.log("GitHub dispatch failed:", r.status, await r.text());
  return r.ok;
}

// --- same logic as monitor.py ---

function parseQueues(text) {
  if ([ALL_LABEL.toLowerCase(), "all", "усі", "всі"].includes(text.toLowerCase())) return [];
  const out = [];
  for (let q of text.replace(/,/g, " ").split(/\s+/).filter(Boolean)) {
    q = q.toUpperCase().replace(/^GPV/, "");
    if (!VALID.has(q)) return null;
    out.push(`GPV${q}`);
  }
  return out.length ? out : null;
}

function intervals(hours, kinds) {
  const slots = [];
  for (let h = 1; h <= 24; h++) slots.push(...(kinds[hours[String(h)]] || [0, 0]));
  slots.push(0);
  const out = [];
  let start = null;
  slots.forEach((on, i) => {
    if (on && start === null) start = i;
    else if (!on && start !== null) { out.push([start * 30, i * 30]); start = null; }
  });
  return out;
}

function fmt(ranges) {
  const t = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return ranges.map(([a, b]) => `${t(a)}–${t(b)}`).join(", ");
}

function buildMessage(fact, names, queues) {
  const lines = ["⚡️ <b>Поточний графік відключень</b>",
    `Оновлено на сайті: ${fact.update || "?"}`, ""];
  const day = new Intl.DateTimeFormat("uk-UA",
    { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", year: "numeric" });
  for (const ts of Object.keys(fact.data).sort((a, b) => a - b)) {
    const groups = fact.data[ts];
    lines.push(`📅 <b>${day.format(new Date(ts * 1000))}</b>`);
    for (const q of queues.length ? queues : Object.keys(groups).sort()) {
      if (!groups[q]) continue;
      const off = intervals(groups[q], OFF);
      const maybe = intervals(groups[q], MAYBE);
      let text = off.length ? `🔴 ${fmt(off)}` : "🟢 без відключень";
      if (maybe.length) text += `  🟡 можливо: ${fmt(maybe)}`;
      lines.push(`${names[q] || q}: ${text}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

async function sendMessage(env, text, markup) {
  const body = { chat_id: env.CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true };
  if (markup) body.reply_markup = markup;
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) console.log("sendMessage failed:", r.status, await r.text());
}

// Setup diagnostics. Shows only yes/no and Telegram's own status, never secret values.
async function check(env) {
  const out = {
    BOT_TOKEN: !!env.BOT_TOKEN,
    CHAT_ID: !!env.CHAT_ID,
    SECRET: !!env.SECRET,
    SECRET_valid_chars: /^[A-Za-z0-9_-]{1,256}$/.test(env.SECRET || ""),
    STATE_kv_bound: !!env.STATE?.get,
  };
  if (out.STATE_kv_bound) {
    out.schedule_received_from_github = !!(await env.STATE.get("schedule"));
    out.queues = await env.STATE.get("queues", "json");
  }
  out.dtek_site_readable_from_worker = !!(await fetchFromSite());
  out.github_fallback_configured = !!(env.GH_TOKEN && env.GH_REPO);
  if (env.BOT_TOKEN) {
    const tg = (m) => fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${m}`).then((r) => r.json());
    const me = await tg("getMe");
    out.bot = me.ok ? "@" + me.result.username : `token rejected: ${me.description}`;
    const wh = await tg("getWebhookInfo");
    if (wh.ok) {
      out.webhook_url = wh.result.url || "(not set)";
      out.webhook_pending_updates = wh.result.pending_update_count;
      out.webhook_last_error = wh.result.last_error_message || null;
    }
  }
  return out;
}
