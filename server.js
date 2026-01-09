
// server.js
import express from "express";
import fetch from "node-fetch";          // npm i express node-fetch
import bodyParser from "body-parser";

const app = express();
app.use(bodyParser.json());

// === Env variables ===
//  - PAGE_ACCESS_TOKEN: from Meta -> Messenger -> Generate Access Token
//  - VERIFY_TOKEN: your chosen string; must match Meta webhook config
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN      = process.env.VERIFY_TOKEN;

// In-memory PSID store for multiple recipients
// When users message your Page, their PSID is captured and stored.
// For production, persist to a DB.
const PSID_SET = new Set();

// --- 1) Webhook verification (GET) ---
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge); // Echo back to verify
  }
  return res.sendStatus(403);
});

// --- 2) Webhook events (POST): capture PSID, optional auto-reply ---
app.post("/webhook", async (req, res) => {
  const body = req.body;
  if (body.object === "page") {
    for (const entry of body.entry || []) {
      for (const event of entry.messaging || []) {
        const sender = event?.sender?.id;
        if (sender) {
          PSID_SET.add(sender);
          console.log("Captured PSID:", sender);

          // Optional auto-reply (only within 24h window)
          await sendText(sender, "Thanks! You will receive sensor alerts here.");
        }
      }
    }
    return res.status(200).send("EVENT_RECEIVED");
  }
  return res.sendStatus(404);
});

// --- Helper: Send API call ---
async function sendText(psid, text, tag) {
  const payload = {
    recipient: { id: psid },
    message: { text },
    // Within 24h: messaging_type "RESPONSE"
    // Outside 24h: use MESSAGE_TAG + a valid non-promotional tag (e.g., ACCOUNT_UPDATE)
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

// --- 3) Endpoint for ESP8266/Blynk: send alert to one or many PSIDs ---
/*
  POST /notify
  {
    "text": "Sensor alert: 800 ppm",
    "psid": "optional single psid",
    "tag": "optional_tag_if_outside_24h"  // e.g., "ACCOUNT_UPDATE"
  }
*/
app.post("/notify", async (req, res) => {
  try {
    const { text, psid, tag } = req.body;
    if (!text) return res.status(400).json({ error: "text required" });

    // Choose recipients: single PSID or everyone in PSID_SET
    const recipients = psid ? [psid] : Array.from(PSID_SET);

    if (recipients.length === 0) {
      return res.status(400).json({
        error: "No recipients. Ask user(s) to message the Page first to capture PSID."
      });
    }

    const results = [];
    for (const r of recipients) {
      const resSend = await sendText(r, text, tag);
      results.push({ psid: r, result: resSend });
    }

    return res.status(200).json({ ok: true, sent: results.length, results });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "internal_error" });
  }
});

// --- Health check ---
app.get("/", (_req, res) => res.send("OK"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));
