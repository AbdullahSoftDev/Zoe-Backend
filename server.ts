import express from "express";
import path from "path";
import fs from "fs";
import { createServer } from "http";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import pino from "pino";
import qrcode from "qrcode";
import dotenv from "dotenv";
import { spawn } from "child_process";
import ffmpegPath from "ffmpeg-static";
import { createClient } from "@supabase/supabase-js";
import twilio from "twilio";
import { WebSocketServer, WebSocket } from "ws";

// ────────── CRITICAL CRASH PROTECTION SHIELDS ──────────
// Prevent deep stream socket failures in Baileys / live connections from crashing the Node/Express server
process.on("uncaughtException", (err) => {
  console.error("CRITICAL PROTECTION: Caught process uncaughtException:", err);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("CRITICAL PROTECTION: Caught process unhandledRejection at:", promise, "reason:", reason);
});

// Initialize environment variables
dotenv.config();

// Initialize standard server-side Gemini SDK instance
const apiKey = process.env.GEMINI_API_KEY;
const ai = new GoogleGenAI({
  apiKey: apiKey,
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    }
  }
});

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
})

const httpServer = createServer(app);


// ────────── SUPABASE UTILITIES ──────────
// Helper to initialize Supabase client dynamically or using env variables
function getSupabaseClient(req: express.Request) {
  const url = req.headers['x-supabase-url'] as string || process.env.SUPABASE_URL;
  const key = req.headers['x-supabase-key'] as string || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

// ────────── WHATSAPP MANAGER ──────────
// Custom dynamic import wrapper for Baileys to handle common ESM/CJS interop robustly.
let makeWASocket: any = null;
let useMultiFileAuthState: any = null;
let DisconnectReason: any = null;

async function loadBaileys() {
  if (!makeWASocket) {
    const baileysModule = await import("@whiskeysockets/baileys");
    // Handle potential default or named exports
    makeWASocket = baileysModule.default || baileysModule;
    useMultiFileAuthState = baileysModule.useMultiFileAuthState;
    DisconnectReason = baileysModule.DisconnectReason;
  }
}

// Session state storage path
const AUTH_DIR = path.join(process.cwd(), "whatsapp_auth_session");

class WhatsAppManager {
  public sock: any = null;
  public status: "disconnected" | "connecting" | "qr_ready" | "connected" = "disconnected";
  public qrCodeUrl: string | null = null;
  public pairedUser: string | null = null;
  public initPromise: Promise<void> | null = null;

  async init() {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._initInternal();
    return this.initPromise;
  }

  private async _initInternal() {
    try {
      await loadBaileys();
      this.status = "connecting";
      this.qrCodeUrl = null;

      // Ensure auth directory exists
      if (!fs.existsSync(AUTH_DIR)) {
        fs.mkdirSync(AUTH_DIR, { recursive: true });
      }

      const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

      this.sock = makeWASocket({
        auth: state,
        logger: pino({ level: "silent" }),
        printQRInTerminal: false,
        mobile: false,
      });

      this.sock.ev.on("creds.update", saveCreds);

      this.sock.ev.on("connection.update", async (update: any) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          this.status = "qr_ready";
          try {
            this.qrCodeUrl = await qrcode.toDataURL(qr);
          } catch (err) {
            console.error("Failed to generate QR Code Data URL:", err);
          }
        }

        if (connection === "connecting") {
          this.status = "connecting";
        }

        if (connection === "open") {
          this.status = "connected";
          this.qrCodeUrl = null;
          const userJid = this.sock.user?.id || "";
          this.pairedUser = userJid.split(":")[0] || userJid;
          console.log(`WhatsApp connected as: ${this.pairedUser}`);
        }

        if (connection === "close") {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const loggedOutCode = DisconnectReason?.loggedOut || 401;
          const shouldReconnect = statusCode !== loggedOutCode;
          
          console.log(`[WhatsApp] Connection event: close. Logic Code: ${statusCode || "unknown"}. Reconnect eligibility: ${shouldReconnect}`);
          
          // Thoroughly clean up current socket and listeners to prevent duplicated triggers
          try {
            if (this.sock) {
              this.sock.ev.removeAllListeners("connection.update");
              this.sock.ev.removeAllListeners("creds.update");
            }
          } catch (cleanupErr) {
            // Ignored
          }
          
          // Clear active session identifiers
          this.pairedUser = null;
          this.qrCodeUrl = null;
          this.sock = null;

          if (shouldReconnect) {
            this.status = "connecting";
            this.initPromise = null;
            console.log("[WhatsApp] Transient connection reset or stream error (such as code 515). Scheduling background reconnect in 5 seconds...");
            setTimeout(() => {
              // Ensure we don't double init
              if (!this.sock && this.status !== "connected") {
                this.init().catch(err => console.error("[WhatsApp] Error running deferred connection retry:", err));
              }
            }, 5000);
          } else {
            console.log("[WhatsApp] Permanently logged out or manually disconnected. Cleaning session directory.");
            this.status = "disconnected";
            this.initPromise = null;
            // Clear the auth session directories
            this.clearSession();
          }
        }
      });

    } catch (err) {
      console.error("Error in WhatsApp socket initialization", err);
      this.status = "disconnected";
      this.initPromise = null;
    }
  }

  clearSession() {
    try {
      if (fs.existsSync(AUTH_DIR)) {
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      }
    } catch (err) {
      console.error("Failed to delete auth directory", err);
    }
  }

  async disconnect() {
    this.status = "disconnected";
    this.pairedUser = null;
    this.qrCodeUrl = null;
    if (this.sock) {
      try {
        this.sock.logout();
      } catch (err) {
        // Ignored
      }
      this.sock = null;
    }
    this.clearSession();
    this.initPromise = null;
  }

  async sendVoiceMessage(phone: string, audioBuffer: Buffer) {
    if (this.status !== "connected" || !this.sock) {
      throw new Error("WhatsApp bot is not connected. Authenticate with the QR code first.");
    }

    // Sanitize phone number (strip whitespace, +, etc.)
    let sanitized = phone.replace(/[^\d]/g, "").trim();
    if (!sanitized) {
      throw new Error("Invalid phone number format provided.");
    }

    // Append standard WhatsApp JID suffix if not provided
    if (!sanitized.endsWith("@s.whatsapp.net")) {
      sanitized = `${sanitized}@s.whatsapp.net`;
    }

    console.log(`Converting audio source and sending voice note to: ${sanitized}`);

    // Convert underlying buffer (WAV/MP3) to high quality OGG Opus natively readable by all WhatsApp clients
    let oggOpusBuffer: Buffer;
    try {
      oggOpusBuffer = await convertToOggOpus(audioBuffer);
    } catch (err: any) {
      console.warn("WAV to Ogg Opus conversion failed, falling back to original buffer:", err);
      oggOpusBuffer = audioBuffer;
    }

    // Send audio buffer with PTT (Push To Talk / Voice Note) flags
    const result = await this.sock.sendMessage(sanitized, {
      audio: oggOpusBuffer,
      mimetype: "audio/ogg; codecs=opus", // Native voice note mime type
      ptt: true,
    });

    return result;
  }

  async sendTextMessage(phone: string, text: string) {
    if (this.status !== "connected" || !this.sock) {
      throw new Error("WhatsApp bot is not connected. Authenticate with the QR code first.");
    }

    let sanitized = phone.replace(/[^\d]/g, "").trim();
    if (!sanitized) {
      throw new Error("Invalid phone number format provided.");
    }

    if (!sanitized.endsWith("@s.whatsapp.net")) {
      sanitized = `${sanitized}@s.whatsapp.net`;
    }

    console.log(`Sending plain text message via Baileys to: ${sanitized}`);
    const result = await this.sock.sendMessage(sanitized, { text });
    return result;
  }
}

const waManager = new WhatsAppManager();

// Automatically attempt to start WA connection on bootstrap
waManager.init();


// ────────── WAVE / AUDIO HELPERS ──────────
/**
 * Converts any audio Buffer (WAV or MP3) into OGG format using Opus codec
 * with standard Voice Note parameters (mono, 16kHz sampling) so WhatsApp plays it natively.
 */
function convertToOggOpus(inputBuffer: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) {
      return reject(new Error("ffmpeg-static path not found."));
    }

    console.log("Converting audio format to OGG Opus via ffmpeg-static...");

    // Spawn ffmpeg to convert stdin stream to ogg with libopus encoding
    const ffmpeg = spawn(ffmpegPath, [
      "-i", "pipe:0",
      "-acodec", "libopus", // standard robust opus codec
      "-ab", "16k",         // ultra stable bitrate for voice notes
      "-ac", "1",           // strict mono
      "-ar", "16000",       // stable 16kHz sampling rate
      "-f", "ogg",          // enforce Ogg container
      "pipe:1"
    ]);

    const chunks: Buffer[] = [];
    const errorChunks: Buffer[] = [];

    ffmpeg.stdout.on("data", (chunk) => {
      chunks.push(chunk);
    });

    ffmpeg.stderr.on("data", (chunk) => {
      errorChunks.push(chunk);
    });

    ffmpeg.on("close", (code) => {
      if (code === 0) {
        const resultBuffer = Buffer.concat(chunks);
        console.log(`Successfully converted audio to OGG Opus. Size: ${resultBuffer.length} bytes`);
        resolve(resultBuffer);
      } else {
        const errorMsg = Buffer.concat(errorChunks).toString();
        console.error(`FFmpeg finished with non-zero exit code ${code}: ${errorMsg}`);
        reject(new Error(`FFmpeg error (code ${code}): ${errorMsg}`));
      }
    });

    ffmpeg.on("error", (err) => {
      console.error("Failed to execute FFmpeg child process:", err);
      reject(err);
    });

    // Write input audio buffer of any standard format and close stdin
    ffmpeg.stdin.write(inputBuffer);
    ffmpeg.stdin.end();
  });
}

/**
 * Prepends a 44-byte WAV header to 16-bit Mono raw PCM bytes.
 */
function pcmToWav(pcmBuffer: Buffer, sampleRate: number = 24000): Buffer {
  const header = Buffer.alloc(44);
  const dataLength = pcmBuffer.length;
  const fileLength = dataLength + 36;
  
  header.write("RIFF", 0);
  header.writeUInt32LE(fileLength, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // 1 = Short integer PCM
  header.writeUInt16LE(1, 22); // Mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byteRate = sampleRate * blockAlign
  header.writeUInt16LE(2, 32); // blockAlign = channels * bytesPerSample (1 * 2)
  header.writeUInt16LE(16, 34); // 16-bit
  header.write("data", 36);
  header.writeUInt32LE(dataLength, 40);

  return Buffer.concat([header, pcmBuffer]);
}

/**
 * Split text up to target maximum length for translation TTS compatibility.
 */
function splitTextForTts(text: string, maxLength: number = 180): string[] {
  const sentences = text.match(/[^.!?]+[.!?]*|.+/g) || [text];
  const chunks: string[] = [];
  let currentChunk = "";

  for (const sentence of sentences) {
    if ((currentChunk + sentence).length > maxLength) {
      if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
      }
      currentChunk = sentence;
    } else {
      currentChunk += sentence;
    }
  }
  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }
  return chunks;
}


// ────────── API ROUTE DECLARATIONS ──────────

// ── Supabase & System Configuration API ──
app.post('/api/check-supabase', async (req, res) => {
  try {
    const sb = getSupabaseClient(req);
    if (!sb) {
      return res.status(400).json({ success: false, error: 'Missing Supabase URL or Anon/Service Key' });
    }

    const { data, error } = await sb.from('users').select('count', { count: 'exact', head: true });
    if (error) {
      return res.json({ 
        success: true, 
        warning: 'Supabase connected, but default "users" table was not queried successfully: ' + error.message,
        tableError: error.code
      });
    }

    res.json({ success: true, count: data });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || 'Verification failed' });
  }
});

app.post('/api/get-keys', async (req, res) => {
  try {
    const sb = getSupabaseClient(req);
    if (!sb) return res.status(400).json({ error: 'Supabase not initialized' });

    // Fetch active api_keys
    const { data: apiKeys } = await sb
      .from('api_keys')
      .select('*')
      .eq('status', 'active');
    
    // Fetch twilio_auth
    const { data: twilioAuth } = await sb
      .from('twilio_auth')
      .select('*')
      .limit(1);

    const keysMap = {
      gemini: apiKeys?.find(k => k.provider === 'gemini')?.key_value || null,
      twilio_key: apiKeys?.find(k => k.provider === 'twilio')?.key_value || null,
      twilio_sid: twilioAuth?.[0]?.sid || null,
      twilio_token: twilioAuth?.[0]?.token || null,
      twilio_whatsapp: twilioAuth?.[0]?.whatsapp || null,
    };

    res.json({ success: true, keys: keysMap });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Contact Management APIs ──
app.post('/api/contacts/get', async (req, res) => {
  try {
    const sb = getSupabaseClient(req);
    const defaultContacts = [
      { id: '1', name: 'Sayyan', phone: '+923001234567', email: 'sayyan@zoom.com' },
      { id: '2', name: 'Zain', phone: '+923339876543', email: 'zain@zoeassistant.com' },
      { id: '3', name: 'Ayesha Khan', phone: '+14155552671', email: 'ayesha@clientreview.io' }
    ];

    if (!sb) {
      return res.json({ success: true, contacts: defaultContacts, source: 'fallback (no supabase)' });
    }

    const { data, error } = await sb.from('contacts').select('*');
    if (error || !data || data.length === 0) {
      return res.json({ 
        success: true, 
        contacts: defaultContacts, 
        source: 'default_mock', 
        info: error ? 'Table error: ' + error.message : 'Database was empty, returning standard demo contacts' 
      });
    }

    res.json({ success: true, contacts: data, source: 'supabase' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/contacts/add', async (req, res) => {
  try {
    const { name, phone, email } = req.body;
    const sb = getSupabaseClient(req);
    if (!sb) return res.status(400).json({ error: 'Supabase not connected' });

    const { data, error } = await sb.from('contacts').insert([{ name, phone, email }]).select();
    if (error) throw error;
    res.json({ success: true, contact: data[0] });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/log-action', async (req, res) => {
  try {
    const { action_type, target_name, target_value, mode, message, result } = req.body;
    const sb = getSupabaseClient(req);
    if (!sb) {
      return res.json({ success: true, logged: false, info: "Supabase not connected. Skipping DB entry." });
    }

    // Map action type to database constraints if needed
    let mappedType = action_type;
    if (action_type === 'voice_message' || action_type === 'text') {
      mappedType = 'whatsapp';
    }

    const { data, error } = await sb.from('action_logs').insert([{
      action_type: mappedType,
      target_name,
      target_value,
      mode,
      message,
      result: result || { success: true }
    }]).select();

    if (error) throw error;
    res.json({ success: true, logged: true, data: data[0] });
  } catch (err: any) {
    console.error("[Action Logger Error]:", err);
    res.status(500).json({ error: err.message });
  }
});


// ── Speech-to-Intent Dynamic Extractor ──
app.post('/api/extract-intent', async (req, res) => {
  try {
    const { userInput, contacts } = req.body;
    let geminiKey = process.env.GEMINI_API_KEY;
    let contactsList = contacts || [];
    
    try {
      const sb = getSupabaseClient(req);
      if (sb) {
        const { data } = await sb.from('api_keys').select('*').eq('provider', 'gemini').eq('status', 'active').limit(1);
        if (data && data[0]?.key_value) {
          geminiKey = data[0].key_value;
        }

        const { data: dbContacts, error: contactsError } = await sb.from('contacts').select('*');
        if (!contactsError && dbContacts && dbContacts.length > 0) {
          contactsList = dbContacts;
          console.log("[Intent Extractor] Successfully mapped contacts directly from database: ", dbContacts.length);
        }
      }
    } catch (e) {
      console.log("Could not look up dynamic credentials or contacts in Supabase, falling back");
    }

    if (!geminiKey || geminiKey === 'MY_GEMINI_API_KEY' || geminiKey === '') {
      return res.status(400).json({ error: 'No active Gemini API key found. Configure inside environment secrets or Supabase.' });
    }

    const aiInstance = new GoogleGenAI({
      apiKey: geminiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        }
      }
    });

    const contactsContext = JSON.stringify(contactsList);

    const systemPrompt = `You are the intent extractor for Zoe, an integrated and highly expressive AI voice/WhatsApp assistant.
Your task is to take a natural language user request, map it to the contacts list, and parse the action and target message parameters.

Available contacts:
${contactsContext}

Rules:
1. Examine the user query (e.g., "call Sayyan telling him that meeting has been delayed to 4pm", "voice message to Zain saying hi, how are you", "text Zain saying are you free?").
2. Extract:
   - "action": strictly one of:
     - "call" (for phone calls / Twilio dialing requests)
     - "voice_message" (for voice message requests on WhatsApp)
     - "text" (for text message requests on WhatsApp)
   - "contactName": name of the contact matched (match name accurately or intelligently)
   - "message": the actual message they want to convey (translated/cleaned to dry message format)
   - "phone": the resolved phone number of that contact. If not found in database, return null or extract phone from text if user dictated digits.
3. Return ONLY a well-formed JSON object formatted with double quoted keys, like:
{
  "action": "call",
  "contactName": "Sayyan",
  "message": "Your meeting is at 5pm through Zoom",
  "phone": "+923001234567"
}
Do NOT return backticks, markdown, block wrapping, or any other explanations.`;

    const response = await aiInstance.models.generateContent({
      model: 'models/gemini-2.0-flash',
      contents: userInput,
      config: {
        systemInstruction: systemPrompt,
        temperature: 0.2,
        responseMimeType: 'application/json'
      }
    });

    const text = response.text;
    if (!text) {
      throw new Error("Empty response from intent extractor");
    }

    console.log("[Intent Extractor Raw output]:", text);
    const parsed = JSON.parse(text.trim());
    res.json({ success: true, extraction: parsed });
  } catch (err: any) {
    console.error("[Intent Extractor Error]:", err);
    res.status(500).json({ error: `Intent extraction failed: ${err.message}` });
  }
});


// ── Twilio Call Triggering ──
app.post('/api/call/trigger', async (req, res) => {
  try {
    const { phone, contactName, message, twilioSid, twilioToken, twilioNumber } = req.body;
    
    if (!phone) {
      return res.status(400).json({ error: 'Missing phone number to dial' });
    }

    let sid = twilioSid || process.env.TWILIO_ACCOUNT_SID;
    let token = twilioToken || process.env.TWILIO_AUTH_TOKEN;
    let fromNum = twilioNumber || process.env.TWILIO_FROM_NUMBER;

    // Try fetching from Supabase if any is empty
    try {
      const sb = getSupabaseClient(req);
      if (sb) {
        const { data: auth } = await sb.from('twilio_auth').select('*').limit(1);
        if (auth && auth[0]) {
          if (!sid) sid = auth[0].sid;
          if (!token) token = auth[0].token;
          if (!fromNum) {
            fromNum = auth[0].whatsapp;
          }
        }
      }
    } catch (e) {
      console.log('Unable to fetch Twilio credentials from supabase');
    }

    if (!fromNum) {
      fromNum = '+12055550199';
    }

    if (!sid || !token) {
      return res.status(400).json({ 
        error: 'Missing Twilio credentials. Complete setup by entering Twilio account parameters in UI settings or Supabase twilio_auth table.' 
      });
    }

    const client = twilio(sid, token);
    
    const appUrl = process.env.APP_URL || `https://${req.headers.host}`;
    const cleanAppUrl = appUrl.replace(/\/$/, ''); // strip trailing slash
    
    const twimlUrl = `${cleanAppUrl}/api/twilio-twiml?contactName=${encodeURIComponent(contactName)}&message=${encodeURIComponent(message)}`;

    console.log(`[Twilio outbound] Initiating calling pipeline to: ${phone} from: ${fromNum} with TwiML: ${twimlUrl}`);

    const callInstance = await client.calls.create({
      to: phone,
      from: fromNum,
      url: twimlUrl
    });

    res.json({
      success: true,
      callSid: callInstance.sid,
      status: callInstance.status,
      twimlUrl
    });
  } catch (err: any) {
    console.error('[Twilio Trigger Error]:', err);
    res.status(500).json({ error: `Twilio call trigger failed: ${err.message}` });
  }
});

// Endpoint serving TwiML to connect the outbound call to our WebSockets stream!
app.post('/api/twilio-twiml', (req, res) => {
  const contactName = req.query.contactName as string || 'Guest';
  const targetMessage = req.query.message as string || 'You have an automated call update.';
  
  res.type('text/xml');
  
  const appUrl = process.env.APP_URL || `https://${req.headers.host}`;
  const wsHost = appUrl.replace(/^http/, 'ws'); // Convert https -> wss, http -> ws
  
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Kendra">Connecting you to Zoe Assistant... please hold.</Say>
  <Connect>
    <Stream url="${wsHost}/call-websocket">
      <Parameter name="contactName" value="${contactName}" />
      <Parameter name="targetMessage" value="${targetMessage}" />
    </Stream>
  </Connect>
</Response>`;

  console.log(`[TwiML webhook served]: contactName=${contactName}, message=${targetMessage}`);
  res.send(twiml);
});


// ── WhatsApp Actions API ──
app.get("/api/whatsapp/status", (req, res) => {
  res.json({
    status: waManager.status,
    qrCodeUrl: waManager.qrCodeUrl,
    pairedUser: waManager.pairedUser,
  });
});

app.post("/api/whatsapp/connect", async (req, res) => {
  try {
    waManager.init();
    res.json({ success: true, status: waManager.status });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/whatsapp/disconnect", async (req, res) => {
  try {
    await waManager.disconnect();
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/whatsapp/send-voice", async (req, res) => {
  const { phoneNumber, prompt, language, voiceEngine, voiceName } = req.body;

  if (!phoneNumber) {
    return res.status(400).json({ error: "Phone number is required." });
  }
  if (!prompt) {
    return res.status(400).json({ error: "Speech prompt/instructions are required." });
  }

  try {
    console.log(`Starting voice notes pipeline for: ${phoneNumber} using engine: ${voiceEngine}`);

    let geminiKey = process.env.GEMINI_API_KEY;
    try {
      const sb = getSupabaseClient(req);
      if (sb) {
        const { data } = await sb.from('api_keys').select('*').eq('provider', 'gemini').eq('status', 'active').limit(1);
        if (data && data[0]?.key_value) {
          geminiKey = data[0].key_value;
          console.log("[Voice Note Generation] Successfully mapped Gemini API Key from Supabase api_keys table.");
        }
      }
    } catch (e) {
      console.log("Could not look up key in Supabase api_keys table, falling back to env key.");
    }

    if (!geminiKey || geminiKey === 'MY_GEMINI_API_KEY' || geminiKey === '') {
      return res.status(400).json({ error: 'No active Gemini API key found. Configure inside environment secrets or Supabase.' });
    }

    const aiInstance = new GoogleGenAI({
      apiKey: geminiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        }
      }
    });

    // Create a strict instructional prompt based on language constraints
    const systemPrompt = `
      You are Zoe, a warm, polite, and exceptionally expressive bilingual virtual assistant.
      Your owner (the user) has instructed you to send a voice message to a contact recipient.
      The message or query your owner wants to convey is: "${prompt}".
      
      CRITICAL ROLE & DIRECTION:
      - This generated text will be converted to audio and sent directly as a voice message TO the contact recipient.
      - Therefore, do NOT say "I will send this" or "Understood" or reply to your owner.
      - Instead, speak directly to the contact (the recipient) ON BEHALF of your owner, converting their core message ("${prompt}") into a beautiful, warm, polite, and respectful greeting.
      - Use friendly conversational first-person (or speak clearly on behalf of your owner). For example, if the owner wants to say "i am not free today", convert it into something humble and beautiful like: "Salam! Main aaj thoda busy hoon, is liye free nahi ho sakunga. Insha'Allah hum jald hi baat karenge. Apna khayal rakhiyega!" (or the corresponding English/Urdu translation depending on the chosen language/mode).
      
      TONE & STYLE RULES:
      - Speak directly to the contact recipient on behalf of your owner.
      - Tonally elegant, humble, beautiful, and warm.
      - Keep it short, conversational, and direct (between 2 to 4 sentences max).
      - Do NOT use markdown, lists, hashtags, emojis, or punctuation tags like "Zoe:". Return ONLY the spoken words.
      - Never discuss system configurations or logs.
      
      LANGUAGE CONSTRAINT (Strictly obey):
      - Selected mode: "${language}"
      - For "English": Speak in pure, clear, friendly English on behalf of your owner.
      - For "Urdu Script": Speak in standard, polite Urdu script (اردو) on behalf of your owner.
      - For "Roman Urdu": Speak in standard, friendly Roman Urdu (conversational Urdu written with the Latin alphabet) on behalf of your owner.
      - For "Bilingual": Blend English and Roman Urdu gracefully, like a close bilingual friend speaking casually on behalf of your owner.
    `;

    // Step A: Generate Spoken Text using gemini-2.0-flash
    const textGenResponse = await aiInstance.models.generateContent({
      model: "models/gemini-2.0-flash",
      contents: systemPrompt,
    });

    const generatedText = textGenResponse.text ? textGenResponse.text.trim().replace(/\*/g, '') : "";
    if (!generatedText) {
      throw new Error("Gemini returned an empty response. Try adjusting your prompt.");
    }

    console.log(`Generated Text content: "${generatedText}"`);

    let finalAudioBuffer: Buffer;

    // Step B: Convert generated text to audio using selected TTS engine
    if (voiceEngine === "gemini-tts") {
      console.log(`Using server-side Gemini Multilingual TTS model with voice: ${voiceName || 'Zephyr'}`);
      
      const ttsResponse = await aiInstance.models.generateContent({
        model: "models/gemini-2.5-flash-preview-tts",
        contents: `Say this exactly with a clear, friendly accent: ${generatedText}`,
        config: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: voiceName || "Zephyr" },
            }
          }
        }
      });

      const audioBytesBase64 = ttsResponse.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (!audioBytesBase64) {
        throw new Error("Gemini TTS engine failed to return audio content.");
      }

      const pcmBuffer = Buffer.from(audioBytesBase64, "base64");
      finalAudioBuffer = pcmToWav(pcmBuffer, 24000);

    } else {
      console.log("Using Standard high-speed translation language TTS");
      
      let langCode = "en";
      if (language === "Urdu Script") {
        langCode = "ur";
      } else if (language === "Roman Urdu" || language === "Bilingual") {
        langCode = "ur"; 
      }

      const textChunks = splitTextForTts(generatedText, 180);
      const audioBufferChunks: Buffer[] = [];

      for (const chunk of textChunks) {
        const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&tl=${encodeURIComponent(langCode)}&client=tw-ob&q=${encodeURIComponent(chunk)}`;
        const ttsRes = await fetch(ttsUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36",
          },
        });

        if (!ttsRes.ok) {
          throw new Error("Translation TTS API returned a non-ok stream.");
        }

        const arrayBuf = await ttsRes.arrayBuffer();
        audioBufferChunks.push(Buffer.from(arrayBuf));
      }

      finalAudioBuffer = Buffer.concat(audioBufferChunks);
    }

    // Step C: Send native Voice Note (PTT) over WhatsApp
    await waManager.sendVoiceMessage(phoneNumber, finalAudioBuffer);

    res.json({
      success: true,
      text: generatedText,
      phoneNumber: phoneNumber,
    });

  } catch (err: any) {
    console.error("Pipeline failure: ", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/whatsapp/send-text", async (req, res) => {
  const { phoneNumber, message } = req.body;

  if (!phoneNumber) {
    return res.status(400).json({ error: "Phone number is required." });
  }
  if (!message) {
    return res.status(400).json({ error: "Message content is required." });
  }

  try {
    console.log(`Sending WhatsApp text message to ${phoneNumber}: "${message}"`);
    const result = await waManager.sendTextMessage(phoneNumber, message);
    res.json({ success: true, result });
  } catch (err: any) {
    console.error("WhatsApp text send failure:", err);
    res.status(500).json({ error: err.message });
  }
});


// ────────── WEBSOCKET AUDIO STREAMING SERVER FOR TWILIO (GEMINI LIVE API) ──────────
const wss = new WebSocketServer({ noServer: true });

wss.on('connection', async (ws: WebSocket) => {
  console.log('[WS] New websocket connection accepted for live Twilio audio streaming!');
  
  let streamSid = '';
  let contactName = 'Friend';
  let targetMessage = 'Hello, Abdullah sent me to give you a quick update.';
  let geminiSession: any = null;
  let geminiKey = process.env.GEMINI_API_KEY;

  // Let's dynamically check the api_keys database for the gemini active key before configuring the GoogleGenAI instance
  const sbUrl = process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_ANON_KEY;
  if (sbUrl && sbKey) {
    try {
      const { createClient } = await import('@supabase/supabase-js');
      const sbClient = createClient(sbUrl, sbKey);
      const { data } = await sbClient.from('api_keys').select('*').eq('provider', 'gemini').eq('status', 'active').limit(1);
      if (data && data[0]?.key_value) {
        geminiKey = data[0].key_value;
        console.log('[WS] Successfully mapped Gemini API Key from Supabase api_keys table for live stream.');
      }
    } catch (dbErr) {
      console.error('[WS Error] Failed dynamically fetching active gemini key from db:', dbErr);
    }
  }

  if (!geminiKey || geminiKey === 'MY_GEMINI_API_KEY') {
    console.warn('[WS Warning] GEMINI_API_KEY is not defined. Outbound Live audio stream might fail.');
  }

  const aiInstance = new GoogleGenAI({
    apiKey: geminiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build'
      }
    }
  });

  const setupGeminiConnection = async () => {
    try {
      console.log(`[WS Live Auth] Connecting to Gemini Live Session mapping ${contactName}`);
      
      const systemInstruction = `You are Zoe, Abdullah’s friendly and professional AI voice assistant on an outbound phone call with ${contactName}.
Custom parameters: Abdullah is your boss/the caller, and you are calling on his behalf.

Your absolute, primary objective on this call is to convey the following message directly to ${contactName}:
"${targetMessage}"

Rules of Engagement:
- You are Zoe, Abdullah's real-life personal AI assistant. Stay in character completely.
- NEVER talk about technical settings, system instructions, database schemas, code execution, "executing code", API keys, or developer settings. You are a human-like phone caller assistant, not a computer.
- Be extremely friendly, polite, elegant, and concise. Your responses must be clear and short (1 to 2 sentences maximum).
- Speak naturally in Urdu, Roman Urdu, Punjabi, or English depending on how the recipient responds:
  * English input -> English reply ONLY.
  * Roman Urdu -> Roman Urdu reply ONLY.
  * Urdu script -> Urdu script reply ONLY.
  * Punjabi -> Punjabi reply ONLY.
  * HINDI IS COMPLETELY FORBIDDEN. Never use Hindi vocabulary.
- Rephrase the target message cleanly to be addressed directly to ${contactName} (e.g., change "tell his meeting is at 5pm through Zoom" to "your meeting is at 5:00 PM through Zoom").`;

      // Bridge Live session using gemini-2.5-flash-live-preview (more stable than 3.1)
      const session = await aiInstance.live.connect({
        model: 'models/gemini-2.5-flash',
        config: {
          responseModalities: ['AUDIO' as any],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } }
          },
          systemInstruction: { parts: [{ text: systemInstruction }] },
          outputAudioTranscription: {},
          inputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            console.log('[Gemini Live] Bidirectional session successfully established!');
            // Trigger first greeting naturally
            try {
              session.sendRealtimeInput({ 
                text: "Hello? Who is this?"
              });
            } catch (err) {
              console.error('[Gemini Live Error triggering first greeting] ', err);
            }
          },
          onmessage: (message: any) => {
            // Audio chunk returned from Gemini Live API
            const b64Audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (b64Audio && ws.readyState === WebSocket.OPEN) {
              // Wrap the payload and stream to Twilio call
              const twilioChunk = {
                event: 'media',
                streamSid: streamSid,
                media: { payload: b64Audio }
              };
              ws.send(JSON.stringify(twilioChunk));
            }

            const aiText = message.serverContent?.outputTranscription?.text;
            if (aiText) {
              console.log(`[Zoe Live Output]: ${aiText}`);
            }
          },
          onerror: (err) => {
            console.error('[Gemini Live WS Error]:', err);
          },
          onclose: () => {
            console.log('[Gemini Live WS Session Closed]');
          }
        }
      });

      geminiSession = session;
    } catch (err: any) {
      console.error('[Error during linking Gemini Live voice system]:', err);
    }
  };

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      switch (msg.event) {
        case 'connected':
          console.log('[WS Twilio Event] Stream socket connected');
          break;
        case 'start':
          streamSid = msg.start.streamSid;
          if (msg.start.customParameters) {
            contactName = msg.start.customParameters.contactName || contactName;
            targetMessage = msg.start.customParameters.targetMessage || targetMessage;
          }
          console.log(`[WS Twilio Event] Started stream=${streamSid} with parameters mapping=${contactName}`);
          await setupGeminiConnection();
          break;
        case 'media':
          const rawAudioBase64 = msg.media.payload;
          if (geminiSession && rawAudioBase64) {
            geminiSession.sendRealtimeInput({
              audio: { 
                data: rawAudioBase64, 
                mimeType: 'audio/pcm;rate=8000' 
              }
            });
          }
          break;
        case 'stop':
          console.log('[WS Twilio Event] Stopped');
          if (geminiSession) {
            try { geminiSession.close(); } catch {}
          }
          break;
      }
    } catch (err) {
      console.error('[WS Message Payload Processing Error]:', err);
    }
  });

  ws.on('close', () => {
    console.log('[WS Twilio Connection terminated]');
    if (geminiSession) {
      try { geminiSession.close(); } catch {}
    }
  });
});

// Upgrade HTTP server to WebSockets for Twilio stream
httpServer.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url || '', `http://${request.headers.host}`).pathname;
  if (pathname === '/call-websocket') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});


// ────────── VITE & PUBLIC ASSETS INTEGRATION ──────────
const setupAndListen = async () => {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`[Unified Assistant Server] Running on http://localhost:${PORT}`);
    console.log(`[Unified Assistant Server] Live Audio Streaming ready on ws://localhost:${PORT}/call-websocket`);
  });
};

setupAndListen();
