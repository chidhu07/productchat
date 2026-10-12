// Vercel (or Next.js pages/api): save as api/productchat.js.
// Env: DATABASE_URL, and optionally TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_WEBHOOK_SECRET.
import { createProductChat } from "productchat/server";

export default createProductChat({
  siteName: "Acme",
  inboxUrl: "https://acme.com/support/inbox", // where you host inbox/index.html
}).vercel();
