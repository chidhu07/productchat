/* A complete productchat setup in one file, with no framework:
   the demo product page, the widget, the inbox and the API.

   DATABASE_URL=postgres://… node examples/node-server.mjs
   → http://localhost:3000            demo page with the chat bubble
   → http://localhost:3000/support/inbox
   Create an inbox link with: npx productchat inbox-link --url http://localhost:3000/support/inbox
*/
import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createProductChat } from "../server/index.js";

for (const f of [".env.local", ".env"]) { try { process.loadEnvFile?.(f); } catch { /* none */ } }

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const chat = createProductChat({
  siteName: "Acme Notes",
  inboxUrl: process.env.PRODUCTCHAT_INBOX_URL || `http://localhost:${PORT}/support/inbox`,
});
const api = chat.node();

const files = {
  "/": ["demo.html", "text/html"],
  "/productchat.js": ["../widget/productchat.js", "text/javascript"],
  "/support/inbox": ["../inbox/index.html", "text/html"],
};

http.createServer(async (req, res) => {
  const path = req.url.split("?")[0];
  if (path === "/api/productchat") return api(req, res);
  const f = files[path];
  if (!f) { res.statusCode = 404; return res.end("Not found"); }
  res.setHeader("Content-Type", f[1] + "; charset=utf-8");
  res.end(await readFile(here(f[0])));
}).listen(PORT, () => console.log(`productchat demo on http://localhost:${PORT}  (inbox: /support/inbox)`));
