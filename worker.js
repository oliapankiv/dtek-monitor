// Cloudflare Worker: answers the Telegram bot instantly from the last saved schedule.
//
// Bindings (Worker → Settings → Variables / Bindings):
//   BOT_TOKEN  (secret)  Telegram bot token
//   CHAT_ID    (secret)  your chat id; everyone else is ignored
//   SECRET     (secret)  any long random string, same as WORKER_SECRET in GitHub
//   STATE      (KV namespace) stores "queues" and "schedule"
//
// Routes:
//   POST /telegram   Telegram webhook (checks X-Telegram-Bot-Api-Secret-Token)
//   GET  /queues     for monitor.py: the queues picked in the bot
//   PUT  /schedule   from monitor.py: latest {fact, names}

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
      return Response.json({ queues: await env.STATE.get("queues", "json") });
    }
    if (path === "/schedule" && request.method === "PUT" && auth) {
      await env.STATE.put("schedule", await request.text());
      return Response.json({ ok: true });
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
  const schedule = await env.STATE.get("schedule", "json");
  if (!schedule) return "Графіка ще немає — дочекайтеся першої перевірки сайту.";
  const queues = (await env.STATE.get("queues", "json")) || [];
  return buildMessage(schedule.fact, schedule.names || {}, queues);
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
  await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
