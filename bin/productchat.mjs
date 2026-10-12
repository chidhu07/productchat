#!/usr/bin/env node
/* productchat CLI. Reads DATABASE_URL / TELEGRAM_* from the environment,
   or from .env.local / .env in the current folder.

   npx productchat inbox-link [--url https://you.com/support/inbox] [--revoke]
   npx productchat telegram-test
   npx productchat telegram-webhook https://you.com/api/productchat
   npx productchat schema
*/
import { createInboxKey, revokeInboxKeys, schemaSql, setTelegramWebhook, createProductChat } from "../server/index.js";
import { randomBytes } from "node:crypto";

for (const f of [".env.local", ".env"]) {
  try { process.loadEnvFile?.(f); } catch { /* no such file */ }
}

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name) => { const i = rest.indexOf(name); return i === -1 ? undefined : (rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[i + 1] : true); };
const die = (msg) => { console.error(msg); process.exit(1); };

async function pool() {
  const url = process.env.DATABASE_URL;
  if (!url) die("Set DATABASE_URL (Postgres) first, e.g. in .env.local");
  const { default: pg } = await import("pg");
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  return new pg.Pool({ connectionString: url, ssl: local ? false : { rejectUnauthorized: false } });
}

if (cmd === "inbox-link") {
  const db = await pool();
  try {
    if (flag("--revoke")) console.log(`Revoked ${await revokeInboxKeys(db)} link(s).`);
    const key = await createInboxKey(db);
    const url = flag("--url") || process.env.PRODUCTCHAT_INBOX_URL;
    console.log(url && url !== true ? `${url}#t=${key}` : `Inbox key: ${key}\n(open your inbox page and paste it, or add #t=${key} to its address)`);
  } finally { await db.end(); }
} else if (cmd === "telegram-test") {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) die("Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID first.");
  const chat = createProductChat({ siteName: "productchat" });
  const ok = await chat.notify("✅ productchat alerts are working. New chats will show up here.");
  console.log(ok ? "Sent. Check Telegram." : "Telegram refused it: check the token, and press Start in a chat with your bot.");
  process.exit(ok ? 0 : 1);
} else if (cmd === "telegram-webhook") {
  const url = rest[0];
  if (!url || !/^https:\/\//.test(url)) die("Usage: productchat telegram-webhook https://your-site.com/api/productchat");
  if (!process.env.TELEGRAM_BOT_TOKEN) die("Set TELEGRAM_BOT_TOKEN first.");
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET || randomBytes(24).toString("hex");
  const target = url + (url.includes("?") ? "&" : "?") + "action=telegram";
  const r = await setTelegramWebhook({ botToken: process.env.TELEGRAM_BOT_TOKEN, url: target, secret });
  if (!r.ok) die(`Telegram said: ${r.description}`);
  console.log(`Webhook set to ${target}`);
  if (!process.env.TELEGRAM_WEBHOOK_SECRET) console.log(`\nAdd this to your server's environment, then redeploy:\nTELEGRAM_WEBHOOK_SECRET=${secret}`);
} else if (cmd === "schema") {
  console.log(schemaSql().map((s) => s.replace(/\n {4}/g, "\n  ") + ";").join("\n\n"));
} else {
  console.log(`productchat: support chat with an FAQ bot, an inbox and Telegram.

  productchat inbox-link [--url <inbox page url>] [--revoke]   create a private inbox link
  productchat telegram-test                                    send a test alert
  productchat telegram-webhook <api url>                       let Telegram replies reach visitors
  productchat schema                                           print the SQL tables

  Docs: https://github.com/chidhu07/productchat`);
}
