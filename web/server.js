import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dir = dirname(fileURLToPath(import.meta.url));

try {
  const env = readFileSync(join(__dir, ".env"), "utf8");
  for (const line of env.split("\n")) {
    const [k, ...rest] = line.split("=");
    if (k && rest.length && !process.env[k.trim()]) {
      process.env[k.trim()] = rest.join("=").trim();
    }
  }
} catch {}

const {
  OPENAI_API_KEY,
  EFFICY_API_KEY,
  MCP_URL = "https://efficy-mcp.simon-damiaens.workers.dev/mcp",
  PORT = 3000,
  WHATSAPP_TOKEN,
  WHATSAPP_PHONE_NUMBER_ID,
  WHATSAPP_VERIFY_TOKEN = "michelle-webhook-2026",
  ELEVENLABS_API_KEY,
  ELEVENLABS_VOICE_ID,
} = process.env;

if (!OPENAI_API_KEY || OPENAI_API_KEY === "your_openai_api_key_here") {
  console.error("\n  ✗ OPENAI_API_KEY is not set. Edit web/.env and add your key.\n");
  process.exit(1);
}

// ─── MCP client ───────────────────────────────────────────────────────────────
let mcpClient;
let chatTools = [];

async function initMCP() {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: { "X-API-Key": EFFICY_API_KEY } },
  });
  mcpClient = new Client({ name: "michelle", version: "1.0.0" });
  await mcpClient.connect(transport);

  const { tools } = await mcpClient.listTools();
  chatTools = tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));

  console.log(`  ✓ MCP connected — tools: ${chatTools.map((t) => t.function.name).join(", ")}`);
}

// ─── System prompt ────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are Michelle, a sharp and proactive internal sales assistant for Vanhonsebrouck. You help sales reps manage the product assortment of their customers in Efficy via natural voice conversation. Always speak Dutch (Belgian).

When the conversation starts, greet the user warmly and ask how you can help. Do not wait for the user to speak first.

Always work on K_COMPANY = 32920. Never ask which company to use.

## What you can do
- Look up products in the catalog
- Check the current assortment of the company
- Look up valid introduction statuses
- Add or update products in the company assortment

## How to behave

You are proactive and action-oriented. When the user gives you enough context, you act — you do not wait to be asked again.

- When a user mentions a product and a clear intent (add, update, present), immediately fetch the data you need and move toward a proposal. Do not ask "shall I look that up?" — just do it.
- When you have all the info needed (product match, status if required), state your proposal clearly and concisely. One sentence. Then ask for a yes.
- When the user confirms — with "ja", "doe maar", "klopt", "ga je gang", "voer uit", "dat is goed", or any clear affirmation — immediately call update_company_products. Do not ask again.
- Read context from the conversation. If the user already gave you a status or packaging preference earlier in the conversation, use it. Do not ask for it again.
- Ask only one question at a time. If multiple things are unclear, pick the most important one first.

## Hard rules
- When mentioning a product name, always strip packaging dimensions from it (e.g. "24X33", "20 LT", "KEG", "BAK"). Keep only the brand name and alcohol percentage if present. Mention packaging separately using the packaging field. Example: instead of "KASTEEL ROUGE 20 LT KEG", say "Kasteel Rouge" with packaging "Vat".
- Internal beers require an introduction status. Competition beers do not.
- Match products specifically — packaging and variant matter. If multiple packaging variants exist and the user hasn't specified, ask once.
- Removal = status change only. Never hard delete.
- Never invent a product match or status. If genuinely uncertain, ask.
- If a tool returns an error, stop and report it. Do not retry.

## Tone
Sound like a knowledgeable colleague who knows the catalog well and gets things done. Warm, concise, no corporate filler. When a task is done, briefly confirm and invite the next one. When the user says goodbye, close warmly.

## Response format
When your response contains an assortment overview (a list of products), always start your reply with the exact token [TEKST] followed by your message.

When you are asking the user to confirm a proposed change (add or update a product), always start your reply with the exact token [CONFIRM] followed by your confirmation question. Do not use [CONFIRM] for any other type of response — only when you need a yes/no confirmation before writing to Efficy.

Format the assortment as a list where each product takes two lines: the product name in bold on the first line, the packaging indented on the second line. Separate each product with a blank line.

Group the list: internal (own) products first, competition products at the bottom. Add a blank line between the two groups. Do not label or mention which group is which — no headers, no labels.

Example:

1. BACCHUS FRAMBOISE 20X37,5
    └ Bak flessen

2. BRIGAND 24X33
    └ Bak flessen

3. COMPETITOR PRODUCT
    └ Fles

Keep product names as-is from the data.`;

// ─── Express ──────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// ─── WhatsApp ─────────────────────────────────────────────────────────────────

// Session store: phone number → message history
const waSessions = new Map();

async function transcribeWhatsAppAudio(mediaId) {
  // 1. Get media URL
  const metaRes = await fetch(`https://graph.facebook.com/v19.0/${mediaId}`, {
    headers: { "Authorization": `Bearer ${WHATSAPP_TOKEN}` },
  });
  const { url } = await metaRes.json();

  // 2. Download audio
  const audioRes = await fetch(url, {
    headers: { "Authorization": `Bearer ${WHATSAPP_TOKEN}` },
  });
  const audioBuffer = await audioRes.arrayBuffer();

  // 3. Send to Whisper
  const form = new FormData();
  form.append("file", new Blob([audioBuffer], { type: "audio/ogg" }), "audio.ogg");
  form.append("model", "whisper-1");
  form.append("language", "nl");

  const whisperRes = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${OPENAI_API_KEY}` },
    body: form,
  });
  const { text } = await whisperRes.json();
  return text;
}

function cleanPackaging(text) {
  return text
    .replace(/\b\d+[Xx]\d+(?:[,.]\d+)?\w*/gi, "") // 24X33, 24X33CL, 20X37,5
    .replace(/\b\d+\s*(CL|ML|LT|L)\b/gi, "")      // 33CL, 330ML, 20 LT
    .replace(/\bKEG\b/gi, "")                      // KEG
    .replace(/\s{2,}/g, " ")                       // dubbele spaties opruimen
    .trim();
}

async function sendWhatsAppVoice(to, text) {
  // 1. Generate TTS audio via ElevenLabs
  const ttsRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVENLABS_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text: cleanPackaging(text),
      model_id: "eleven_multilingual_v2",
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
  });
  const audioBuffer = await ttsRes.arrayBuffer();

  // 2. Upload to WhatsApp
  const uploadForm = new FormData();
  uploadForm.append("messaging_product", "whatsapp");
  uploadForm.append("type", "audio/mpeg");
  uploadForm.append("file", new Blob([audioBuffer], { type: "audio/mpeg" }), "reply.mp3");

  const uploadRes = await fetch(`https://graph.facebook.com/v19.0/${WHATSAPP_PHONE_NUMBER_ID}/media`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${WHATSAPP_TOKEN}` },
    body: uploadForm,
  });
  const { id: mediaId } = await uploadRes.json();

  // 3. Send audio message
  await fetch(`https://graph.facebook.com/v19.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "audio",
      audio: { id: mediaId },
    }),
  });
}

async function sendWhatsAppMessage(to, text) {
  await fetch(`https://graph.facebook.com/v19.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    }),
  });
}

async function sendWhatsAppInteractive(to, text) {
  await fetch(`https://graph.facebook.com/v19.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text },
        action: {
          buttons: [
            { type: "reply", reply: { id: "confirm_yes", title: "✓ Ja" } },
            { type: "reply", reply: { id: "confirm_no",  title: "✗ Nee" } },
          ],
        },
      },
    }),
  });
}

async function runAgent(history) {
  let messages = [...history];
  for (let i = 0; i < 10; i++) {
    console.log(`  → gpt-4o call (turn ${i + 1}, ${messages.length} messages in history)`);
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
        tools: chatTools,
        tool_choice: "auto",
      }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    const msg = data.choices[0].message;
    messages.push(msg);

    if (msg.tool_calls?.length) {
      const toolResults = [];
      for (const tc of msg.tool_calls) {
        const args = JSON.parse(tc.function?.arguments || "{}");
        console.log(`  ⚙ tool call: ${tc.function.name}`, JSON.stringify(args));
        try {
          const result = await mcpClient.callTool({ name: tc.function.name, arguments: args });
          const text = (result.content ?? []).filter(c => c.type === "text").map(c => c.text).join("\n");
          console.log(`  ✓ tool result: ${text.slice(0, 200)}${text.length > 200 ? "…" : ""}`);
          toolResults.push({ role: "tool", tool_call_id: tc.id, content: text || JSON.stringify(result) });
        } catch (err) {
          console.error(`  ✗ tool error (${tc.function.name}):`, err.message);
          toolResults.push({ role: "tool", tool_call_id: tc.id, content: `Error: ${err.message}` });
        }
      }
      messages.push(...toolResults);
      continue;
    }

    console.log(`  ← Michelle: ${msg.content?.slice(0, 200)}${(msg.content?.length ?? 0) > 200 ? "…" : ""}`);
    return { reply: msg.content, history: messages };
  }
  return { reply: "Er is iets misgegaan. Probeer opnieuw.", history: messages };
}

// Webhook verification
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === WHATSAPP_VERIFY_TOKEN) {
    console.log("  ✓ WhatsApp webhook verified");
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// Incoming WhatsApp messages + calls
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // acknowledge immediately

  const entry = req.body?.entry?.[0];
  const change = entry?.changes?.[0];

const message = change?.value?.messages?.[0];
  if (!message || !["text", "audio", "interactive"].includes(message.type)) return;

  const from = message.from;
  const isVoice = message.type === "audio";
  let text;

  if (message.type === "interactive" && message.interactive?.type === "button_reply") {
    const btn = message.interactive.button_reply;
    text = btn.id === "confirm_yes" ? "ja" : "nee";
    console.log(`\n  ↓ [${from}] button reply: "${text}"`);
    if (!waSessions.has(from)) waSessions.set(from, []);
    const history = waSessions.get(from);
    history.push({ role: "user", content: text });
    try {
      const { reply, history: updated } = await runAgent(history);
      waSessions.set(from, updated);
      if (reply) {
        const isConfirm = reply.startsWith("[CONFIRM]");
        const cleanReply = reply.replace(/^\[(TEKST|CONFIRM)\]\s*/, "");
        if (isConfirm) {
          console.log(`  ↑ [${from}] confirm buttons verzonden`);
          await sendWhatsAppInteractive(from, cleanReply);
        } else {
          console.log(`  ↑ [${from}] tekst antwoord verzonden`);
          await sendWhatsAppMessage(from, cleanReply);
        }
      }
    } catch (err) {
      console.error("WhatsApp agent error:", err.message);
      await sendWhatsAppMessage(from, "Er is een fout opgetreden. Probeer opnieuw.");
    }
    return;
  }

  if (isVoice) {
    console.log(`\n  ↓ [${from}] voice memo ontvangen — transcriberen…`);
    try {
      text = await transcribeWhatsAppAudio(message.audio.id);
      if (!text?.trim()) return;
      console.log(`  ✓ Whisper: "${text}"`);
    } catch (err) {
      console.error("  ✗ Whisper error:", err.message);
      await sendWhatsAppMessage(from, "Kon je voice memo niet verwerken. Probeer als tekst.");
      return;
    }
  } else {
    text = message.text.body;
    console.log(`\n  ↓ [${from}] tekst: "${text}"`);
  }

  if (!waSessions.has(from)) waSessions.set(from, []);
  const history = waSessions.get(from);
  history.push({ role: "user", content: text });

  try {
    const { reply, history: updated } = await runAgent(history);
    waSessions.set(from, updated);
    if (reply) {
      const forceText = reply.startsWith("[TEKST]");
      const isConfirm = reply.startsWith("[CONFIRM]");
      const cleanReply = reply.replace(/^\[(TEKST|CONFIRM)\]\s*/, "");
      if (isConfirm) {
        if (isVoice) {
          console.log(`  ↑ [${from}] voice memo voorstel verzenden…`);
          await sendWhatsAppVoice(from, cleanReply);
        }
        console.log(`  ↑ [${from}] confirm buttons verzonden`);
        await sendWhatsAppInteractive(from, cleanReply);
      } else if (isVoice && !forceText) {
        console.log(`  ↑ [${from}] voice memo antwoord verzenden…`);
        await sendWhatsAppVoice(from, cleanReply);
      } else {
        console.log(`  ↑ [${from}] tekst antwoord verzonden`);
        await sendWhatsAppMessage(from, cleanReply);
      }
    }
  } catch (err) {
    console.error("WhatsApp agent error:", err.message);
    await sendWhatsAppMessage(from, "Er is een fout opgetreden. Probeer opnieuw.");
  }
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
console.log("\n  Starting Michelle…");
initMCP()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`  ✓ Running at http://localhost:${PORT}\n`);
    });
  })
  .catch((err) => {
    console.error("  ✗ MCP connect failed:", err.message);
    process.exit(1);
  });
