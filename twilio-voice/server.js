import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from "fs";
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
  PORT = 3001,
  ELEVENLABS_API_KEY,
  ELEVENLABS_VOICE_ID,
  PUBLIC_URL,
} = process.env;

if (!OPENAI_API_KEY || OPENAI_API_KEY === "your_openai_api_key_here") {
  console.error("\n  ✗ OPENAI_API_KEY is not set. Edit twilio-voice/.env and add your key.\n");
  process.exit(1);
}
if (!PUBLIC_URL) {
  console.error("\n  ✗ PUBLIC_URL is not set. Set it to your cloudflared tunnel URL (no trailing slash).\n");
  process.exit(1);
}

// ─── Audio directory ──────────────────────────────────────────────────────────
const AUDIO_DIR = join(__dir, "audio");
mkdirSync(AUDIO_DIR, { recursive: true });

// ─── MCP client ───────────────────────────────────────────────────────────────
let mcpClient;
let chatTools = [];

async function initMCP() {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: { "X-API-Key": EFFICY_API_KEY } },
  });
  mcpClient = new Client({ name: "michelle-twilio", version: "1.0.0" });
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
const SYSTEM_PROMPT = `You are Michelle, a sharp and proactive internal sales assistant for Vanhonsebrouck. You help sales reps manage the product assortment of their customers in Efficy via a phone call. Always speak Dutch (Belgian).

When the conversation starts, greet the user warmly and ask how you can help.

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
- Read context from the conversation. If the user already gave you a status or packaging preference earlier, use it. Do not ask for it again.
- Ask only one question at a time.

## Hard rules
- When mentioning a product name, always strip packaging dimensions (e.g. "24X33", "20 LT", "KEG", "BAK"). Keep only the brand name and alcohol percentage if present. Mention packaging separately. Example: instead of "KASTEEL ROUGE 20 LT KEG", say "Kasteel Rouge" with packaging "Vat".
- Internal beers require an introduction status. Competition beers do not.
- Match products specifically — packaging and variant matter. If multiple packaging variants exist and the user hasn't specified, ask once.
- Removal = status change only. Never hard delete.
- Never invent a product match or status. If genuinely uncertain, ask.
- If a tool returns an error, stop and report it. Do not retry.

## Tone and format
You are speaking on a phone call. Keep responses short and conversational — as if speaking to a colleague. No markdown, no bullet points, no numbered lists, no bold text. Speak naturally. When a task is done, briefly confirm and invite the next one. When the user says goodbye, close warmly.

When listing products, read them out one by one in plain speech. Keep it brief — name the product and its packaging, nothing more.

## Response tags
When you are asking the user to confirm a proposed change (add or update a product), start your reply with the exact token [CONFIRM] followed by your confirmation question. Do not use [CONFIRM] for any other type of response.`;

// ─── Agent loop ───────────────────────────────────────────────────────────────
async function runAgent(history) {
  let messages = [...history];
  for (let i = 0; i < 10; i++) {
    console.log(`  → gpt-4o call (turn ${i + 1}, ${messages.length} messages)`);
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

// ─── TTS ──────────────────────────────────────────────────────────────────────
function cleanPackaging(text) {
  return text
    .replace(/\b\d+[Xx]\d+(?:[,.]\d+)?\w*/gi, "")
    .replace(/\b\d+\s*(CL|ML|LT|L)\b/gi, "")
    .replace(/\bKEG\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

async function generateTTS(text) {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`, {
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
  const buffer = await res.arrayBuffer();
  const filename = `reply_${Date.now()}_${Math.random().toString(36).slice(2)}.mp3`;
  writeFileSync(join(AUDIO_DIR, filename), Buffer.from(buffer));
  setTimeout(() => { try { unlinkSync(join(AUDIO_DIR, filename)); } catch {} }, 5 * 60 * 1000);
  return `${PUBLIC_URL}/audio/${filename}`;
}

// ─── TwiML helpers ────────────────────────────────────────────────────────────
function twimlGather(audioUrl) {
  const play = audioUrl ? `<Play>${audioUrl}</Play>` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="/voice/gather" method="POST" language="nl-BE" timeout="5" speechTimeout="auto">
    ${play}
  </Gather>
  <Gather input="speech" action="/voice/gather" method="POST" language="nl-BE" timeout="5" speechTimeout="auto">
    <Say language="nl-BE">Ik luister nog. Spreek gerust.</Say>
  </Gather>
  <Hangup/>
</Response>`;
}

function twimlHangup(audioUrl) {
  const play = audioUrl ? `<Play>${audioUrl}</Play>` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${play}
  <Hangup/>
</Response>`;
}

// ─── Express ──────────────────────────────────────────────────────────────────
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use("/audio", express.static(AUDIO_DIR));

// ─── Sessions ─────────────────────────────────────────────────────────────────
const callSessions = new Map();
const pendingReplies = new Map();

// ─── Routes ───────────────────────────────────────────────────────────────────

// Incoming call — greet and start listening
app.post("/voice/incoming", async (req, res) => {
  const callSid = req.body.CallSid;
  const from = req.body.From;
  console.log(`\n  ↓ Incoming call: ${callSid} from ${from}`);

  const history = [{ role: "user", content: "Gesprek gestart." }];
  callSessions.set(callSid, history);

  try {
    const { reply, history: updated } = await runAgent(history);
    callSessions.set(callSid, updated);
    const cleanReply = reply.replace(/^\[CONFIRM\]\s*/, "");
    const audioUrl = await generateTTS(cleanReply);
    res.type("text/xml").send(twimlGather(audioUrl));
  } catch (err) {
    console.error("  ✗ Agent error on call start:", err.message);
    res.type("text/xml").send(twimlHangup());
  }
});

// Speech gathered — respond immediately, process in background
app.post("/voice/gather", async (req, res) => {
  const callSid = req.body.CallSid;
  const speechResult = req.body.SpeechResult?.trim();

  if (!speechResult) {
    console.log(`  ~ [${callSid}] no speech detected`);
    res.type("text/xml").send(twimlGather(null));
    return;
  }

  console.log(`  ↓ [${callSid}] speech: "${speechResult}"`);

  const history = callSessions.get(callSid) ?? [];
  history.push({ role: "user", content: speechResult });

  // Respond within Twilio's 15s timeout — processing happens in background
  pendingReplies.set(callSid, { done: false });
  res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="nl-BE">Één moment.</Say>
  <Redirect method="POST">/voice/process/${callSid}</Redirect>
</Response>`);

  // Background: agent + TTS
  runAgent(history)
    .then(async ({ reply, history: updated }) => {
      callSessions.set(callSid, updated);
      const cleanReply = reply.replace(/^\[CONFIRM\]\s*/, "");
      const audioUrl = await generateTTS(cleanReply);
      pendingReplies.set(callSid, { done: true, audioUrl });
    })
    .catch((err) => {
      console.error("  ✗ Agent error:", err.message);
      pendingReplies.set(callSid, { done: true, audioUrl: null });
    });
});

// Polling — Twilio polls here every 2s until processing is done
app.post("/voice/process/:callSid", (req, res) => {
  const callSid = req.params.callSid;
  const result = pendingReplies.get(callSid);

  if (result?.done) {
    pendingReplies.delete(callSid);
    res.type("text/xml").send(twimlGather(result.audioUrl));
  } else {
    res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Pause length="2"/>
  <Redirect method="POST">/voice/process/${callSid}</Redirect>
</Response>`);
  }
});

// Call status — clean up session on end
app.post("/voice/status", (req, res) => {
  const callSid = req.body.CallSid;
  const status = req.body.CallStatus;
  if (["completed", "failed", "no-answer", "canceled", "busy"].includes(status)) {
    callSessions.delete(callSid);
    console.log(`  ✓ Call ${callSid} ended (${status}) — session removed`);
  }
  res.sendStatus(200);
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
console.log("\n  Starting Michelle (Twilio voice)…");
initMCP()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`  ✓ Running at http://localhost:${PORT}`);
      console.log(`  ✓ Public URL: ${PUBLIC_URL}\n`);
    });
  })
  .catch((err) => {
    console.error("  ✗ MCP connect failed:", err.message);
    process.exit(1);
  });
