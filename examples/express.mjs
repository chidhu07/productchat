// Express: npm i express productchat
import express from "express";
import { fileURLToPath } from "node:url";
import { createProductChat } from "productchat/server";

const app = express();
const chat = createProductChat({ siteName: "Acme", inboxUrl: "https://acme.com/support/inbox" });

app.post("/api/productchat", express.json(), chat.express());
app.get("/productchat.js", (req, res) => res.sendFile(fileURLToPath(import.meta.resolve("productchat/widget"))));
app.get("/support/inbox", (req, res) => res.sendFile(fileURLToPath(import.meta.resolve("productchat/inbox"))));

app.listen(3000);
