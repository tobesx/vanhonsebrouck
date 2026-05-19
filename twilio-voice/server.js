import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
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
  PORT = 3001,
  PUBLIC_URL,
  OPENAI_REALTIME_MODEL = "gpt-realtime-1.5",
} = process.env;

if (!OPENAI_API_KEY || OPENAI_API_KEY === "your_openai_api_key_here") {
  console.error("\n  ✗ OPENAI_API_KEY is not set. Edit twilio-voice/.env and add your key.\n");
  process.exit(1);
}
if (!PUBLIC_URL) {
  console.error("\n  ✗ PUBLIC_URL is not set. Set it to your ngrok tunnel URL (no trailing slash).\n");
  process.exit(1);
}

// ─── MCP client ───────────────────────────────────────────────────────────────
let mcpClient;
let realtimeTools = [];

async function initMCP() {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: { "X-API-Key": EFFICY_API_KEY } },
  });
  mcpClient = new Client({ name: "michelle-twilio-realtime", version: "2.0.0" });
  await mcpClient.connect(transport);

  const { tools } = await mcpClient.listTools();
  realtimeTools = tools.map((t) => ({
    type: "function",
    name: t.name,
    description: t.description,
    parameters: t.inputSchema,
  }));

  console.log(`  ✓ MCP connected — tools: ${realtimeTools.map((t) => t.name).join(", ")}`);
}

// ─── System prompt ────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `Je bent Michelle, een interne verkoopsassistente voor Vanhonsebrouck. Je helpt vertegenwoordigers om het productassortiment van klanten te beheren in Efficy via een telefoongesprek. Spreek altijd Belgisch Nederlands.

Werk altijd op K_COMPANY = 32920. Vraag nooit welk bedrijf.

## Gesprekspatroon — volg dit altijd exact

1. BEGROETING
   Zeg exact: "Goeiedag, waar kan ik je mee van dienst zijn?"
   Geen variaties. Altijd dezelfde zin.

2. LUISTEREN
   Laat de beller volledig uitspreken. Onderbreek nooit.
   Wacht tot er een duidelijke stilte is voor je antwoordt.

3a. ALS JE BEGRIJPT WAT GEVRAAGD WORDT
   - Zoek de nodige data op (producten, statussen, assortiment).
   - Stel je voorstel voor in één zin. Voorbeeld: "Dan voeg ik Kasteel Rouge in bak flessen toe als presentatie product, is dat correct?"
   - Wacht op ja of nee.
   - Bij bevestiging ("ja", "doe maar", "klopt", "ga je gang", "dat is goed"): voer uit.
   - Bij weigering: vraag wat er anders moet.

3b. ALS JE IETS NIET GOED HEBT BEGREPEN
   Zeg exact: "Kan je dat nog eens herhalen?" of "Kan je dat verduidelijken?"
   Stel maar één vraag. Geen veronderstellingen.

4. AFSLUITING
   Na een uitgevoerde taak: "Dat is in orde. Nog iets anders?"
   Bij afscheid: "Goed, tot de volgende keer. Dag."

## Taalregels — nooit afwijken
- Geen variatie in begroeting of afsluiting. Altijd dezelfde zinnen.
- Geen lange uitleg. Eén zin per stap.
- Geen formele taal. Gewoon, direct, collegiaal.
- Geen opsommingen voorlezen tenzij gevraagd. Dan: naam + verpakking, één per keer.
- Productnamen altijd zonder verpakkingsdimensies (geen "24X33", "20 LT", "KEG", "BAK"). Enkel merknaam + alcoholpercentage indien van toepassing. Verpakking apart vermelden.

## Regels
- Interne bieren vereisen altijd een introductiestatus. Concurrentieproducten niet.
- Specifiek matchen — verpakking en variant tellen mee. Meerdere opties? Vraag eenmalig welke.
- Voor update_company_products uitvoeren: altijd voorstel bevestigd krijgen.
- Verwijdering = statuswijziging. Nooit hard deleten.
- Nooit een product of status verzinnen. Bij twijfel: vragen.
- Bij tool error: stoppen en melden. Niet opnieuw proberen.`;

// ─── Express + HTTP server ────────────────────────────────────────────────────
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/media-stream" });

// ─── Incoming call → stream TwiML ────────────────────────────────────────────
app.post("/voice/incoming", (req, res) => {
  const callSid = req.body.CallSid;
  const from = req.body.From;
  console.log(`\n  ↓ Incoming call: ${callSid} from ${from}`);

  const wsUrl = PUBLIC_URL.replace(/^https?:\/\//, "wss://") + "/media-stream";

  res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
</Response>`);
});

// ─── Call status ──────────────────────────────────────────────────────────────
app.post("/voice/status", (req, res) => {
  const { CallSid, CallStatus } = req.body;
  if (["completed", "failed", "no-answer", "canceled", "busy"].includes(CallStatus)) {
    console.log(`  ✓ Call ${CallSid} ended (${CallStatus})`);
  }
  res.sendStatus(200);
});

// ─── Media stream WebSocket ───────────────────────────────────────────────────
wss.on("connection", (twilioWs) => {
  console.log("  ↔ Twilio media stream connected");

  let streamSid = null;
  let responseActive = false;

  const openaiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${OPENAI_REALTIME_MODEL}`,
    {
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  // ── OpenAI events ────────────────────────────────────────────────────────
  openaiWs.on("open", () => {
    console.log("  ↔ OpenAI Realtime connected");

    openaiWs.send(JSON.stringify({
      type: "session.update",
      session: {
        turn_detection: {
          type: "server_vad",
          threshold: 0.8,
          prefix_padding_ms: 300,
          silence_duration_ms: 1200,
        },
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        voice: "shimmer",
        instructions: SYSTEM_PROMPT,
        tools: realtimeTools,
        tool_choice: "auto",
      },
    }));

    // Trigger initial greeting
    openaiWs.send(JSON.stringify({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Gesprek gestart." }],
      },
    }));
    openaiWs.send(JSON.stringify({ type: "response.create" }));
  });

  openaiWs.on("message", async (raw) => {
    let event;
    try { event = JSON.parse(raw); } catch { return; }

    switch (event.type) {
      case "response.audio.delta":
        if (streamSid && twilioWs.readyState === WebSocket.OPEN) {
          twilioWs.send(JSON.stringify({
            event: "media",
            streamSid,
            media: { payload: event.delta },
          }));
        }
        break;

      case "response.output_item.added":
        responseActive = true;
        break;

      case "response.done": {
        responseActive = false;
        const transcript = event.response?.output
          ?.flatMap(o => o.content ?? [])
          .filter(c => c.type === "audio" && c.transcript)
          .map(c => c.transcript.toLowerCase())
          .join(" ") ?? "";
        const isFarewell = /\b(dag|doei|tot ziens|tot later|tot de volgende keer|goeiedag)\b/.test(transcript);
        if (isFarewell) {
          console.log("  ↔ Farewell detected — closing call in 3s");
          setTimeout(() => openaiWs.close(), 3000);
        }
        break;
      }

      case "input_audio_buffer.speech_started":
        // User started speaking — clear buffered audio and cancel active response
        if (responseActive && streamSid && twilioWs.readyState === WebSocket.OPEN) {
          twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
          openaiWs.send(JSON.stringify({ type: "response.cancel" }));
          responseActive = false;
        }
        break;

      case "response.function_call_arguments.done": {
        const { call_id, name, arguments: argsStr } = event;
        let args;
        try { args = JSON.parse(argsStr || "{}"); } catch { args = {}; }

        console.log(`  ⚙ tool call: ${name}`, JSON.stringify(args));

        let output;
        try {
          const result = await mcpClient.callTool({ name, arguments: args });
          output = (result.content ?? []).filter(c => c.type === "text").map(c => c.text).join("\n");
          console.log(`  ✓ tool result: ${output.slice(0, 200)}${output.length > 200 ? "…" : ""}`);
        } catch (err) {
          console.error(`  ✗ tool error (${name}):`, err.message);
          output = `Error: ${err.message}`;
        }

        openaiWs.send(JSON.stringify({
          type: "conversation.item.create",
          item: { type: "function_call_output", call_id, output },
        }));
        openaiWs.send(JSON.stringify({ type: "response.create" }));
        break;
      }

      case "error":
        console.error("  ✗ OpenAI Realtime error:", JSON.stringify(event.error));
        break;
    }
  });

  openaiWs.on("close", () => console.log("  ↔ OpenAI Realtime disconnected"));
  openaiWs.on("error", (err) => console.error("  ✗ OpenAI WS error:", err.message));

  // ── Twilio events ────────────────────────────────────────────────────────
  twilioWs.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.event) {
      case "start":
        streamSid = msg.start.streamSid;
        console.log(`  ↔ Stream started: ${streamSid}`);
        break;

      case "media":
        if (openaiWs.readyState === WebSocket.OPEN) {
          openaiWs.send(JSON.stringify({
            type: "input_audio_buffer.append",
            audio: msg.media.payload,
          }));
        }
        break;

      case "stop":
        console.log("  ↔ Stream stopped");
        openaiWs.close();
        break;
    }
  });

  twilioWs.on("close", () => {
    console.log("  ↔ Twilio media stream disconnected");
    openaiWs.close();
  });

  twilioWs.on("error", (err) => console.error("  ✗ Twilio WS error:", err.message));
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
console.log("\n  Starting Michelle (Twilio Realtime voice)…");
initMCP()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`  ✓ Running at http://localhost:${PORT}`);
      console.log(`  ✓ Public URL: ${PUBLIC_URL}`);
      console.log(`  ✓ Model: ${OPENAI_REALTIME_MODEL}\n`);
    });
  })
  .catch((err) => {
    console.error("  ✗ MCP connect failed:", err.message);
    process.exit(1);
  });
