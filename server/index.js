/* productchat server: one handler for the widget, the inbox and Telegram.

   import { createProductChat } from "productchat/server";
   const chat = createProductChat({ databaseUrl: process.env.DATABASE_URL, ... });
   export default chat.vercel();            // Vercel / Next.js API route
   app.post("/api/productchat", chat.express()); // Express
   http.createServer(chat.node())           // plain Node

   Every call is a POST to <endpoint>?action=<name> with a JSON body:

   Visitor (the FAQ bot runs in the browser; only handoffs reach the server)
     start   {email, name?, message, transcript?, page?, lang?} → {id, token}
     send    {id, token, message}                              → {message}
     poll    {id, token, after?}                               → {messages, status}
   Owner (the inbox page; `admin` is an inbox key from createInboxKey)
     admin_list    {admin, status?}       → {conversations, unread}
     admin_thread  {admin, id}            → {conversation, messages}
     admin_reply   {admin, id, message}   → {message}
     admin_status  {admin, id, status}    → {ok}
   Telegram (the bot's webhook; see setTelegramWebhook)
     telegram      <Telegram update>      → {ok}

   Conversation tokens and inbox keys are random secrets stored as SHA-256
   hashes; they travel in request bodies, never in URLs a server logs. */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE = /^[0-9a-f-]{36}$/i;
const IDENT_RE = /^[a-z_][a-z0-9_]{0,62}$/;

export const sha256 = (value) => createHash("sha256").update(String(value)).digest("hex");
const clean = (value, max) => String(value ?? "").replace(/\r\n/g, "\n").trim().slice(0, max);

const DEFAULT_TABLES = {
  conversations: "productchat_conversations",
  messages: "productchat_messages",
  inboxKeys: "productchat_inbox_keys",
  telegram: "productchat_telegram_messages",
};

export function resolveTables(tables = {}) {
  const t = { ...DEFAULT_TABLES, ...tables };
  for (const [k, v] of Object.entries(t)) if (!IDENT_RE.test(v)) throw new Error(`productchat: bad table name for ${k}: ${v}`);
  return t;
}

export function schemaSql(tables) {
  const t = resolveTables(tables);
  return [
    `CREATE TABLE IF NOT EXISTS ${t.conversations} (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      token_hash text NOT NULL,
      email text NOT NULL,
      name text,
      page text,
      lang text,
      ip_hash text,
      status text NOT NULL DEFAULT 'open',
      admin_unread integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS ${t.messages} (
      id bigserial PRIMARY KEY,
      conversation_id uuid NOT NULL REFERENCES ${t.conversations}(id) ON DELETE CASCADE,
      sender text NOT NULL CHECK (sender IN ('visitor', 'bot', 'agent')),
      body text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS ${t.inboxKeys} (
      token_hash text PRIMARY KEY,
      label text,
      created_at timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS ${t.telegram} (
      chat_id text NOT NULL,
      message_id bigint NOT NULL,
      conversation_id uuid NOT NULL REFERENCES ${t.conversations}(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (chat_id, message_id)
    )`,
    `CREATE INDEX IF NOT EXISTS ${t.messages}_conv_idx ON ${t.messages}(conversation_id, id)`,
    `CREATE INDEX IF NOT EXISTS ${t.conversations}_status_idx ON ${t.conversations}(status, updated_at DESC)`,
    `CREATE INDEX IF NOT EXISTS ${t.conversations}_ip_idx ON ${t.conversations}(ip_hash, created_at)`,
    // The server connects as the table owner, so row-level security only shuts
    // out other roles (on Supabase: the public REST API).
    ...[t.conversations, t.messages, t.inboxKeys, t.telegram].map((x) => `ALTER TABLE ${x} ENABLE ROW LEVEL SECURITY`),
  ];
}

async function makePool(databaseUrl) {
  const { default: pg } = await import("pg");
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(databaseUrl);
  return new pg.Pool({ connectionString: databaseUrl, ssl: local ? false : { rejectUnauthorized: false }, max: 3 });
}

/** Create an inbox key; store only its hash. Returns the key (show it once). */
export async function createInboxKey(db, { tables, label } = {}) {
  const t = resolveTables(tables);
  for (const sql of schemaSql(tables)) await db.query(sql);
  const key = randomBytes(24).toString("base64url");
  await db.query(`INSERT INTO ${t.inboxKeys} (token_hash, label) VALUES ($1, $2)`, [sha256(key), label || `issued ${new Date().toISOString().slice(0, 10)}`]);
  return key;
}

/** Revoke every inbox key. */
export async function revokeInboxKeys(db, { tables } = {}) {
  const t = resolveTables(tables);
  const { rowCount } = await db.query(`DELETE FROM ${t.inboxKeys}`);
  return rowCount;
}

/** Point a Telegram bot's webhook at your endpoint so replies to alerts reach visitors. */
export async function setTelegramWebhook({ botToken, url, secret }) {
  const r = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, secret_token: secret, allowed_updates: ["message"], drop_pending_updates: false }),
  });
  return r.json();
}

export function createProductChat(options = {}) {
  const opts = {
    siteName: "Support",
    inboxUrl: "",
    tables: undefined,
    limits: {},
    telegram: {},
    cors: false,
    ...options,
  };
  const t = resolveTables(opts.tables);
  const limits = { startsPerIpHour: 5, messagesPerConversationHour: 30, maxMessage: 2000, maxReply: 4000, transcript: 12, ...opts.limits };
  const tg = {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
    webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET,
    ...opts.telegram,
  };
  let poolPromise = opts.pool ? Promise.resolve(opts.pool) : null;
  let schemaReady = false;

  function getPool() {
    if (!poolPromise) {
      const url = opts.databaseUrl || process.env.DATABASE_URL;
      if (!url) throw new Error("productchat: pass `pool` or `databaseUrl` (or set DATABASE_URL)");
      poolPromise = makePool(url);
    }
    return poolPromise;
  }

  async function ensureSchema(db) {
    if (schemaReady) return;
    // One round trip on a cold start once the tables exist.
    const { rows } = await db.query(
      `SELECT ${[t.conversations, t.messages, t.inboxKeys, t.telegram].map((x) => `to_regclass('${x}') IS NOT NULL`).join(" AND ")} AS ok`
    );
    if (!rows[0].ok) for (const sql of schemaSql(opts.tables)) await db.query(sql);
    schemaReady = true;
  }

  /* ---------- Telegram ---------- */

  async function telegramCall(method, payload) {
    if (!tg.botToken) return null;
    try {
      const r = await fetch(`https://api.telegram.org/bot${tg.botToken}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(2500),
      });
      const j = await r.json().catch(() => null);
      return j && j.ok ? j.result : null;
    } catch {
      return null;
    }
  }

  // Best effort: a Telegram outage never fails the visitor's message. Awaited
  // (briefly) because serverless platforms may freeze after the response.
  async function notify(db, text, conversationId) {
    if (!tg.botToken || !tg.chatId) return false;
    const url = opts.inboxUrl ? (conversationId ? `${opts.inboxUrl}#c=${conversationId}` : opts.inboxUrl) : "";
    const sent = await telegramCall("sendMessage", {
      chat_id: tg.chatId,
      text: text.slice(0, 3500),
      disable_web_page_preview: true,
      ...(url ? { reply_markup: { inline_keyboard: [[{ text: "Open conversation", url }]] } } : {}),
    });
    if (sent && conversationId) {
      // Remember which conversation this alert belongs to, so a reply to it can be routed.
      await db.query(
        `INSERT INTO ${t.telegram} (chat_id, message_id, conversation_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [String(sent.chat.id), sent.message_id, conversationId]
      ).catch(() => {});
    }
    return !!sent;
  }

  async function telegramUpdate(db, update, headers) {
    if (!tg.botToken || !tg.chatId) return { status: 404, body: { error: "telegram not configured" } };
    const given = String(headers?.["x-telegram-bot-api-secret-token"] || "");
    if (!tg.webhookSecret || given.length !== tg.webhookSecret.length ||
        !timingSafeEqual(Buffer.from(given), Buffer.from(tg.webhookSecret))) {
      return { status: 401, body: { error: "bad secret" } };
    }
    const msg = update?.message;
    // Only the owner's chat may answer; everything else is ignored quietly.
    if (!msg || String(msg.chat?.id) !== String(tg.chatId) || typeof msg.text !== "string") return { status: 200, body: { ok: true } };
    const text = msg.text.trim();
    const replyTo = msg.reply_to_message?.message_id;
    const say = (s) => telegramCall("sendMessage", { chat_id: tg.chatId, text: s, reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true } });

    if (!replyTo) {
      if (/^\/(start|help)\b/.test(text)) await say("Reply to a chat alert to answer that visitor. Reply /resolve to close it, /reopen to open it again.");
      return { status: 200, body: { ok: true } };
    }
    const { rows } = await db.query(
      `SELECT c.id, c.email FROM ${t.telegram} m JOIN ${t.conversations} c ON c.id = m.conversation_id WHERE m.chat_id = $1 AND m.message_id = $2`,
      [String(tg.chatId), replyTo]
    );
    if (!rows.length) {
      await say("That message isn't linked to a chat. Reply to a 💬 alert instead.");
      return { status: 200, body: { ok: true } };
    }
    const conv = rows[0];
    if (/^\/(resolve|close)\b/i.test(text)) {
      await db.query(`UPDATE ${t.conversations} SET status = 'closed', admin_unread = 0 WHERE id = $1`, [conv.id]);
      await say(`✓ Resolved: ${conv.email}`);
    } else if (/^\/reopen\b/i.test(text)) {
      await db.query(`UPDATE ${t.conversations} SET status = 'open' WHERE id = $1`, [conv.id]);
      await say(`↺ Reopened: ${conv.email}`);
    } else {
      await addAgentReply(db, conv.id, clean(text, limits.maxReply));
      const sent = await say(`✓ Sent to ${conv.email}`);
      // Replies to the confirmation also go to the same visitor.
      if (sent) await db.query(`INSERT INTO ${t.telegram} (chat_id, message_id, conversation_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [String(tg.chatId), sent.message_id, conv.id]).catch(() => {});
    }
    return { status: 200, body: { ok: true } };
  }

  /* ---------- visitor ---------- */

  async function conversationFor(db, body) {
    const id = clean(body.id, 64);
    if (!UUID_RE.test(id) || !body.token) return null;
    const { rows } = await db.query(`SELECT id, status, email FROM ${t.conversations} WHERE id = $1 AND token_hash = $2`, [id, sha256(clean(body.token, 200))]);
    return rows[0] || null;
  }

  async function start(db, body, ctx) {
    if (body.website) return { status: 200, body: { id: "", token: "" } }; // honeypot
    const email = clean(body.email, 200).toLowerCase();
    const message = clean(body.message, limits.maxMessage);
    if (!EMAIL_RE.test(email)) return { status: 400, body: { error: "Please enter a valid email so we can reach you." } };
    if (message.length < 2) return { status: 400, body: { error: "Please type your question." } };

    const ipHash = sha256(ctx.ip || "unknown");
    const { rows: recent } = await db.query(
      `SELECT COUNT(*)::int AS n FROM ${t.conversations} WHERE ip_hash = $1 AND created_at > now() - interval '1 hour'`,
      [ipHash]
    );
    if (recent[0].n >= limits.startsPerIpHour) return { status: 429, body: { error: "Too many chats from this network. Please try again later." } };

    const token = randomBytes(24).toString("base64url");
    const page = clean(body.page, 300), lang = clean(body.lang, 10);
    const client = db.connect ? await db.connect() : db;
    let id;
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `INSERT INTO ${t.conversations} (token_hash, email, name, page, lang, ip_hash, admin_unread)
         VALUES ($1, $2, $3, $4, $5, $6, 1) RETURNING id`,
        [sha256(token), email, clean(body.name, 100) || null, page || null, lang || null, ipHash]
      );
      id = rows[0].id;
      // What the visitor asked the bot before handing off, so the owner has context.
      const batch = (Array.isArray(body.transcript) ? body.transcript.slice(-limits.transcript) : [])
        .map((m) => [m?.from === "bot" ? "bot" : "visitor", clean(m?.text, limits.maxMessage)])
        .filter(([, text]) => text)
        .concat([["visitor", message]]);
      const params = [id], values = [];
      batch.forEach(([sender, text], i) => { params.push(sender, text); values.push(`($1, $${2 * i + 2}, $${2 * i + 3})`); });
      // One round trip for the whole transcript; ids follow VALUES order.
      await client.query(`INSERT INTO ${t.messages} (conversation_id, sender, body) VALUES ${values.join(", ")}`, params);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      if (client !== db) client.release();
    }
    await notify(db, `💬 New chat · ${opts.siteName}\nFrom: ${email}\nPage: ${page || "/"}${lang ? ` (${lang})` : ""}\n\n${message}${tg.webhookSecret ? "\n\n↩ Reply to this message to answer." : ""}`, id);
    return { status: 200, body: { id, token } };
  }

  async function send(db, body) {
    const conv = await conversationFor(db, body);
    if (!conv) return { status: 404, body: { error: "This conversation has ended. Start a new one." } };
    const message = clean(body.message, limits.maxMessage);
    if (!message) return { status: 400, body: { error: "Please type a message." } };
    const { rows: recent } = await db.query(
      `SELECT COUNT(*)::int AS n FROM ${t.messages} WHERE conversation_id = $1 AND sender = 'visitor' AND created_at > now() - interval '1 hour'`,
      [conv.id]
    );
    if (recent[0].n >= limits.messagesPerConversationHour) return { status: 429, body: { error: "You're sending messages too quickly. Please wait a little." } };
    const { rows } = await db.query(
      `INSERT INTO ${t.messages} (conversation_id, sender, body) VALUES ($1, 'visitor', $2) RETURNING id, sender, body, created_at`,
      [conv.id, message]
    );
    await db.query(`UPDATE ${t.conversations} SET admin_unread = admin_unread + 1, status = 'open', updated_at = now() WHERE id = $1`, [conv.id]);
    await notify(db, `💬 ${conv.email} wrote again\n\n${message}`, conv.id);
    return { status: 200, body: { message: rows[0] } };
  }

  async function poll(db, body) {
    const conv = await conversationFor(db, body);
    if (!conv) return { status: 404, body: { error: "not found" } };
    const after = Number.parseInt(body.after, 10) || 0;
    const { rows } = await db.query(
      `SELECT id, sender, body, created_at FROM ${t.messages} WHERE conversation_id = $1 AND id > $2 ORDER BY id LIMIT 200`,
      [conv.id, after]
    );
    return { status: 200, body: { messages: rows, status: conv.status } };
  }

  /* ---------- owner ---------- */

  async function addAgentReply(db, id, message) {
    const { rowCount } = await db.query(`UPDATE ${t.conversations} SET updated_at = now(), admin_unread = 0 WHERE id = $1`, [id]);
    if (!rowCount) return null;
    const { rows } = await db.query(
      `INSERT INTO ${t.messages} (conversation_id, sender, body) VALUES ($1, 'agent', $2) RETURNING id, sender, body, created_at`,
      [id, message]
    );
    return rows[0];
  }

  async function admin(action, db, body) {
    const { rows: ok } = await db.query(`SELECT 1 FROM ${t.inboxKeys} WHERE token_hash = $1`, [sha256(clean(body.admin, 200))]);
    if (!body.admin || !ok.length) return { status: 403, body: { error: "This inbox link is not valid." } };
    const id = clean(body.id, 64);

    if (action === "admin_list") {
      const status = body.status === "closed" ? "closed" : "open";
      const { rows } = await db.query(
        `SELECT c.id, c.email, c.name, c.page, c.lang, c.status, c.admin_unread, c.created_at, c.updated_at,
                (SELECT m.body FROM ${t.messages} m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_body,
                (SELECT m.sender FROM ${t.messages} m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_sender
           FROM ${t.conversations} c WHERE c.status = $1 ORDER BY c.updated_at DESC LIMIT 200`,
        [status]
      );
      const { rows: unread } = await db.query(`SELECT COALESCE(SUM(admin_unread), 0)::int AS n FROM ${t.conversations} WHERE status = 'open'`);
      return { status: 200, body: { conversations: rows, unread: unread[0].n } };
    }
    if (!UUID_RE.test(id)) return { status: 400, body: { error: "bad id" } };

    if (action === "admin_thread") {
      const { rows: conv } = await db.query(
        `UPDATE ${t.conversations} SET admin_unread = 0 WHERE id = $1 RETURNING id, email, name, page, lang, status, created_at, updated_at`,
        [id]
      );
      if (!conv.length) return { status: 404, body: { error: "not found" } };
      const { rows } = await db.query(`SELECT id, sender, body, created_at FROM ${t.messages} WHERE conversation_id = $1 ORDER BY id`, [id]);
      return { status: 200, body: { conversation: conv[0], messages: rows } };
    }
    if (action === "admin_reply") {
      const message = clean(body.message, limits.maxReply);
      if (!message) return { status: 400, body: { error: "Type a reply first." } };
      const row = await addAgentReply(db, id, message);
      return row ? { status: 200, body: { message: row } } : { status: 404, body: { error: "not found" } };
    }
    if (action === "admin_status") {
      const status = body.status === "closed" ? "closed" : "open";
      await db.query(`UPDATE ${t.conversations} SET status = $2, admin_unread = 0 WHERE id = $1`, [id, status]);
      return { status: 200, body: { ok: true } };
    }
    return { status: 400, body: { error: "unknown action" } };
  }

  /* ---------- entry points ---------- */

  /** Framework-free core: handle(action, body, { ip, headers }) → { status, body }. */
  async function handle(action, body = {}, ctx = {}) {
    try {
      const db = await getPool();
      await ensureSchema(db);
      if (action === "start") return await start(db, body, ctx);
      if (action === "send") return await send(db, body);
      if (action === "poll") return await poll(db, body);
      if (action === "telegram") return await telegramUpdate(db, body, ctx.headers);
      if (String(action).startsWith("admin_")) return await admin(action, db, body);
      return { status: 400, body: { error: "unknown action" } };
    } catch (err) {
      if (opts.onError) opts.onError(err);
      return { status: 500, body: { error: "Something went wrong. Please try again." } };
    }
  }

  function ipOf(req) {
    const h = req.headers || {};
    return String(h["cf-connecting-ip"] || h["x-forwarded-for"] || h["x-real-ip"] || req.socket?.remoteAddress || "").split(",")[0].trim();
  }

  function actionOf(req) {
    if (req.query?.action) return String(req.query.action);
    try { return new URL(req.url, "http://x").searchParams.get("action") || ""; } catch { return ""; }
  }

  async function readJson(req) {
    if (req.body && typeof req.body === "object") return req.body;
    if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch { return {}; } }
    let raw = "";
    for await (const chunk of req) { raw += chunk; if (raw.length > 100000) break; }
    try { return JSON.parse(raw || "{}"); } catch { return {}; }
  }

  function send_(res, status, payload) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    if (opts.cors) {
      res.setHeader("Access-Control-Allow-Origin", opts.cors === true ? "*" : opts.cors);
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    }
    res.end(JSON.stringify(payload));
  }

  /** (req, res) handler for Node http, Vercel functions and Express. */
  function node() {
    return async (req, res) => {
      if (req.method === "OPTIONS") return send_(res, 204, {});
      if (req.method !== "POST") return send_(res, 405, { error: "Use POST" });
      const out = await handle(actionOf(req), await readJson(req), { ip: ipOf(req), headers: req.headers });
      return send_(res, out.status, out.body);
    };
  }

  return { handle, node, vercel: node, express: node, notify: (text, id) => getPool().then((db) => notify(db, text, id)), tables: t };
}
