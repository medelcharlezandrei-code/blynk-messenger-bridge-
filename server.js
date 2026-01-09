
// server.js
import express from "express";
import fetch from "node-fetch";          // npm i express node-fetch
import bodyParser from "body-parser";

const app = express();
app.use(bodyParser.json());

// Env vars
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN      = process.env.VERIFY_TOKEN;

// In-memory store of PSIDs
const PSID_SET = new Set();

// --- Request logger middleware ---
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  if (Object.keys(req.query || {}).length) {
    console.log("Query:", req.query);
  }
  if (req.method !== "GET") {
    console.log("Body:", JSON.stringify(req.body));
  }
  next();
});

// --- Health & status ---
app.get("/", (_req, res) => res.send("OK"));
app.get("/status", (_req, res) => {
  res.json({
    ok: true,
    hasPAGE_ACCESS_TOKEN: Boolean(PAGE_ACCESS_TOKEN),
    hasVERIFY_TOKEN: Boolean(VERIFY_TOKEN),
    psidCount: PSID_SET.size
  });
});

// --- Webhook verification (GET) ---
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verified successfully.");
    return res.status(200).send(challenge);
  }
  console.warn("Webhook verification failed.");
  return res.sendStatus(403);
});

// --- Webhook events (POST) ---
app.post("/webhook", async (req, res) => {
  const body = req.body;
  if (body.object === "page") {
    try {
      for (const entry of body.entry || []) {
        // Each entry may contain multiple messaging events
        for (const event of entry.messaging || []) {
          const sender = event?.sender?.id;
          const recipient = event?.recipient?.id;
          console.log("Event:", JSON.stringify(event));
          if (sender) {
            PSID_SET.add(sender);
            console.log("Captured PSID:", sender);
            // Optional: Auto-reply only within 24h window
            await sendText(sender, "Thanks! Alerts will be sent here when your sensor triggers.");
          } else {
            console.log("No sender ID found in event.");
          }
        }
      }
      return res.status(200).send("EVENT_RECEIVED");
    } catch (e) {
      console.error("Error handling webhook event:", e);
      return res.sendStatus(500);
    }
  }
  return res.sendStatus(404);
});

// --- Send API helper ---
async function sendText(psid, text, tag) {
  const payload = {
    recipient: { id: psid },
    message: { text },
    ...(tag ? { messaging_type: "MESSAGE_TAG", tag } : { messaging_type: "RESPONSE" })
  };
  const url = `https://graph.facebook.com/v21.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await resp.json();
  if (!resp.ok) {
    console.error("Send API error:", resp.status, data);
  }
  return data;
}

// --- ESP8266/Blynk trigger ---
// POST /notify  { "text":"...", "psid":"optional", "tag":"optional_tag" }
app.post("/notify", async (req, res) => {
  try {
    const { text, psid, tag } = req.body;
    if (!text) return res.status(400).json({ error: "text required" });

    const recipients = psid ? [psid] : Array.from(PSID_SET);
    if (recipients.length === 0) {
      return res.status(400).json({
        error: "No recipients stored. Please message the Page first to capture PSID."
      });
    }

    const results = [];
    for (const r of recipients) {
      const rSend = await sendText(r, text, tag);
      results.push({ psid: r, result: rSend });
    }
    return res.status(200).json({ ok: true, sent: results.length, results });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "internal_error" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));
