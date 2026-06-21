import React, { useState, useEffect } from "react";
import { 
  Phone, 
  MessageSquare, 
  Mic, 
  Settings, 
  UserPlus, 
  Users, 
  Cpu, 
  Database, 
  CheckCircle, 
  AlertCircle, 
  RefreshCw, 
  LogOut, 
  QrCode, 
  Volume2, 
  Bot, 
  Send, 
  ArrowRight,
  ShieldCheck,
  Terminal,
  Languages,
  PhoneOff,
  VolumeX,
  Pause,
  Play,
  Grid,
  Lock,
  Wifi,
  Radio
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

interface Contact {
  id?: string;
  name: string;
  phone: string;
  email?: string;
}

interface Extraction {
  action: "call" | "voice_message" | "text" | "";
  contactName: string;
  message: string;
  phone: string | null;
}

export default function App() {
  // WhatsApp States
  const [waStatus, setWaStatus] = useState<"disconnected" | "connecting" | "qr_ready" | "connected">("disconnected");
  const [waQrCode, setWaQrCode] = useState<string | null>(null);
  const [waUser, setWaUser] = useState<string | null>(null);
  
  // Supabase & Keys (Persistent on client side via localStorage)
  const [supabaseUrl, setSupabaseUrl] = useState<string>(() => localStorage.getItem("zoe_supabase_url") || "");
  const [supabaseKey, setSupabaseKey] = useState<string>(() => localStorage.getItem("zoe_supabase_key") || "");
  const [supabaseConnected, setSupabaseConnected] = useState<boolean>(false);
  const [checkingSupabase, setCheckingSupabase] = useState<boolean>(false);

  // Settings Credentials
  const [twilioSid, setTwilioSid] = useState<string>(() => localStorage.getItem("zoe_twilio_sid") || "");
  const [twilioToken, setTwilioToken] = useState<string>(() => localStorage.getItem("zoe_twilio_token") || "");
  const [twilioNumber, setTwilioNumber] = useState<string>(() => localStorage.getItem("zoe_twilio_number") || "");
  const [geminiApiKey, setGeminiApiKey] = useState<string>(() => localStorage.getItem("zoe_gemini_key") || "");
  
  // Custom Voice Settings (Zoe Voice engine settings)
  const [voiceEngine, setVoiceEngine] = useState<"gemini-tts" | "standard-tts">("gemini-tts");
  const [voiceName, setVoiceName] = useState<string>("Zephyr");
  const [languageMode, setLanguageMode] = useState<string>("Bilingual");

  // Zoe Interactive Voice Call States
  const [isVoiceCallActive, setIsVoiceCallActive] = useState<boolean>(false);
  const [voiceCallStatus, setVoiceCallStatus] = useState<"idle" | "listening" | "thinking" | "responding" | "executing" | "ringing" | "onhold">("idle");
  const [voiceTranscript, setVoiceTranscript] = useState<string>("");
  const [zoeSpeechResponse, setZoeSpeechResponse] = useState<string>("");
  const [speechRecognition, setSpeechRecognition] = useState<any>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [callDuration, setCallDuration] = useState<number>(0);
  const [isAudioMuted, setIsAudioMuted] = useState<boolean>(false);
  const [callOnHold, setCallOnHold] = useState<boolean>(false);
  const [showKeypad, setShowKeypad] = useState<boolean>(false);
  const [dialedDigits, setDialedDigits] = useState<string>("");

  // Contacts
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loadingContacts, setLoadingContacts] = useState<boolean>(false);
  const [newContact, setNewContact] = useState<Contact>({ name: "", phone: "", email: "" });
  const [showAddContact, setShowAddContact] = useState<boolean>(false);

  // Intent Parsing & Natural dispatch
  const [userInput, setUserInput] = useState<string>("");
  const [parsingIntent, setParsingIntent] = useState<boolean>(false);
  const [extractedIntent, setExtractedIntent] = useState<Extraction | null>(null);
  const [executingDispatch, setExecutingDispatch] = useState<boolean>(false);

  // Manual Trigger overrides
  const [manualAction, setManualAction] = useState<"call" | "voice_message" | "text">("text");
  const [manualPhone, setManualPhone] = useState<string>("");
  const [manualContactName, setManualContactName] = useState<string>("");
  const [manualMessage, setManualMessage] = useState<string>("");

  // Logs terminal
  const [logs, setLogs] = useState<string[]>([
    "🤖 Zoe unified subsystem booted.",
    "📱 Audio standard pipeline bound: Gemini Live (ws) + WhatsApp Voice (Opus).",
  ]);

  const addLog = (msg: string) => {
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    setLogs((prev) => [`[${time}] ${msg}`, ...prev].slice(0, 15));
  };

  // Poll WhatsApp Session state
  const fetchWhatsAppStatus = async () => {
    try {
      const res = await fetch("/api/whatsapp/status");
      if (!res.ok) {
        throw new Error(`Server status ${res.status}`);
      }
      const data = await res.json();
      setWaStatus(data.status);
      setWaQrCode(data.qrCodeUrl);
      setWaUser(data.pairedUser);
    } catch (err: any) {
      // Gracefully log a light warning without stacktrace spam during hot-reload/server boots
      console.warn("WhatsApp background status is temporarily unreached (server may be booting/connecting):", err?.message || err);
    }
  };

  // Fetch contacts
  const fetchContactsList = async () => {
    setLoadingContacts(true);
    try {
      const headers: Record<string, string> = {};
      if (supabaseUrl && supabaseKey) {
        headers["x-supabase-url"] = supabaseUrl;
        headers["x-supabase-key"] = supabaseKey;
      }

      const res = await fetch("/api/contacts/get", {
        method: "POST",
        headers,
      });
      const data = await res.json();
      if (data.success) {
        setContacts(data.contacts);
        if (data.source === "supabase") {
          setSupabaseConnected(true);
        }
      }
    } catch (err: any) {
      addLog(`⚠️ Contact fetch failure: ${err.message}`);
    } finally {
      setLoadingContacts(false);
    }
  };

  useEffect(() => {
    fetchWhatsAppStatus();
    
    // Auto sync state on mount if credentials present in localStorage
    if (supabaseUrl && supabaseKey) {
      setSupabaseConnected(true);
      fetchKeysAndCredentials();
    }
    fetchContactsList();

    // Setup polling for WhatsApp QR Status
    const statusInterval = setInterval(fetchWhatsAppStatus, 3000);
    return () => clearInterval(statusInterval);
  }, [supabaseUrl, supabaseKey]);

  // Handle live call duration increments
  useEffect(() => {
    let interval: any = null;
    if (isVoiceCallActive) {
      interval = setInterval(() => {
        setCallDuration((prev) => prev + 1);
      }, 1000);
    } else {
      setCallDuration(0);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [isVoiceCallActive]);

  // Connect WhatsApp Trigger
  const connectWhatsApp = async () => {
    try {
      addLog("⚡ Launching WhatsApp multi-device authentication request...");
      const res = await fetch("/api/whatsapp/connect", { method: "POST" });
      const data = await res.json();
      if (data.success) {
        setWaStatus(data.status);
      }
    } catch (err: any) {
      addLog(`❌ WhatsApp socket initialization failure: ${err.message}`);
    }
  };

  // Disconnect / Clear Session WhatsApp Trigger
  const disconnectWhatsApp = async () => {
    if (!confirm("Are you sure you want to log out/disconnect WhatsApp? Your persistent session will be cleared.")) return;
    try {
      addLog("🔌 Disconnecting and deleting local WhatsApp auth credentials...");
      const res = await fetch("/api/whatsapp/disconnect", { method: "POST" });
      const data = await res.json();
      if (data.success) {
        setWaStatus("disconnected");
        setWaQrCode(null);
        setWaUser(null);
        addLog("✅ Local WhatsApp credentials wiped clean.");
      }
    } catch (err: any) {
      addLog(`❌ Disconnect failed: ${err.message}`);
    }
  };

  // Verify Supabase Setup
  const verifySupabase = async () => {
    if (!supabaseUrl || !supabaseKey) {
      alert("Please provide both Supabase Project URL and Anon/Service Key.");
      return;
    }
    setCheckingSupabase(true);
    addLog(`🔍 Verifying Supabase connection to: ${supabaseUrl}`);
    try {
      const res = await fetch("/api/check-supabase", {
        method: "POST",
        headers: {
          "x-supabase-url": supabaseUrl,
          "x-supabase-key": supabaseKey,
        }
      });
      const data = await res.json();
      if (data.success) {
        setSupabaseConnected(true);
        localStorage.setItem("zoe_supabase_url", supabaseUrl);
        localStorage.setItem("zoe_supabase_key", supabaseKey);
        addLog("✅ Supabase configured and verified successfully!");
        
        // Fetch keys from Supabase tables
        fetchKeysAndCredentials();
        fetchContactsList();
      } else {
        setSupabaseConnected(false);
        addLog(`⚠️ Supabase connection failed: ${data.error || data.warning}`);
      }
    } catch (err: any) {
      setSupabaseConnected(false);
      addLog(`❌ Network error validating Supabase: ${err.message}`);
    } finally {
      setCheckingSupabase(false);
    }
  };

  // Load configured keys
  const fetchKeysAndCredentials = async () => {
    try {
      const res = await fetch("/api/get-keys", {
        method: "POST",
        headers: {
          "x-supabase-url": supabaseUrl,
          "x-supabase-key": supabaseKey,
        }
      });
      const data = await res.json();
      if (data.success && data.keys) {
        if (data.keys.twilio_sid) {
          setTwilioSid(data.keys.twilio_sid);
          localStorage.setItem("zoe_twilio_sid", data.keys.twilio_sid);
        }
        if (data.keys.twilio_token) {
          setTwilioToken(data.keys.twilio_token);
          localStorage.setItem("zoe_twilio_token", data.keys.twilio_token);
        }
        if (data.keys.twilio_whatsapp) {
          setTwilioNumber(data.keys.twilio_whatsapp);
          localStorage.setItem("zoe_twilio_number", data.keys.twilio_whatsapp);
        }
        if (data.keys.gemini) {
          setGeminiApiKey(data.keys.gemini);
          localStorage.setItem("zoe_gemini_key", data.keys.gemini);
          addLog("🔑 Active credentials downloaded from Supabase tables.");
        }
      }
    } catch (err) {
      console.error("Unable to sync keys from database", err);
    }
  };

  // Play cellular US standard ringback tone (440Hz + 480Hz) or ring sounds
  const playRingingTone = () => {
    if (!(window as any).AudioContext && !(window as any).webkitAudioContext) return;
    try {
      const ctx = new ((window as any).AudioContext || (window as any).webkitAudioContext)();
      
      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      const gainNode = ctx.createGain();

      osc1.frequency.value = 440;
      osc2.frequency.value = 480;

      osc1.connect(gainNode);
      osc2.connect(gainNode);
      gainNode.connect(ctx.destination);

      gainNode.gain.setValueAtTime(0, ctx.currentTime);
      gainNode.gain.linearRampToValueAtTime(0.12, ctx.currentTime + 0.1);
      gainNode.gain.setValueAtTime(0.12, ctx.currentTime + 1.8);
      gainNode.gain.linearRampToValueAtTime(0, ctx.currentTime + 2.0);

      osc1.start();
      osc2.start();

      setTimeout(() => {
        try {
          osc1.stop();
          osc2.stop();
          ctx.close();
        } catch (e) {}
      }, 2100);
    } catch (err) {
      console.warn("Audio Context init blocked or not supported:", err);
    }
  };

  // Play high-fidelity connect chime sounds
  const playConnectChime = () => {
    if (!(window as any).AudioContext && !(window as any).webkitAudioContext) return;
    try {
      const ctx = new ((window as any).AudioContext || (window as any).webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gainNode = ctx.createGain();

      osc.connect(gainNode);
      gainNode.connect(ctx.destination);

      osc.type = "sine";
      gainNode.gain.setValueAtTime(0, ctx.currentTime);
      gainNode.gain.linearRampToValueAtTime(0.08, ctx.currentTime + 0.05);
      gainNode.gain.setValueAtTime(0.08, ctx.currentTime + 0.15);
      gainNode.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.3);

      osc.frequency.setValueAtTime(523.25, ctx.currentTime); // C5
      osc.frequency.setValueAtTime(659.25, ctx.currentTime + 0.1); // E5

      osc.start();
      setTimeout(() => {
        try {
          osc.stop();
          ctx.close();
        } catch (e) {}
      }, 350);
    } catch (e) {}
  };

  // Play high-fidelity standard DTMF phone dial sounds
  const playDTMFTone = (key: string) => {
    if (!(window as any).AudioContext && !(window as any).webkitAudioContext) return;
    try {
      const dtmfFreqs: Record<string, [number, number]> = {
        '1': [697, 1209], '2': [697, 1336], '3': [697, 1477],
        '4': [770, 1209], '5': [770, 1336], '6': [770, 1477],
        '7': [852, 1209], '8': [852, 1336], '9': [852, 1477],
        '*': [941, 1209], '0': [941, 1336], '#': [941, 1477]
      };

      const freqs = dtmfFreqs[key];
      if (!freqs) return;

      const ctx = new ((window as any).AudioContext || (window as any).webkitAudioContext)();
      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      const gainNode = ctx.createGain();

      osc1.frequency.value = freqs[0];
      osc2.frequency.value = freqs[1];

      osc1.connect(gainNode);
      osc2.connect(gainNode);
      gainNode.connect(ctx.destination);

      gainNode.gain.setValueAtTime(0, ctx.currentTime);
      gainNode.gain.linearRampToValueAtTime(0.08, ctx.currentTime + 0.03);
      gainNode.gain.setValueAtTime(0.08, ctx.currentTime + 0.15);
      gainNode.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.2);

      osc1.start();
      osc2.start();

      setTimeout(() => {
        try {
          osc1.stop();
          osc2.stop();
          ctx.close();
        } catch (e) {}
      }, 250);
    } catch (e) {}
  };

  // Zoe Speech-to-Speech Portal Functions
  const stopAllSpeechAndCallState = () => {
    if (window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
    if (speechRecognition) {
      try {
        speechRecognition.abort();
      } catch (err) {}
    }
    setIsVoiceCallActive(false);
    setVoiceCallStatus("idle");
    setCountdown(null);
    setCallDuration(0);
    setDialedDigits("");
    addLog("🛑 Zoe Voice Session finished/disconnected.");
  };

  const speakWord = (text: string, onEndCallback?: () => void) => {
    if (!window.speechSynthesis) {
      if (onEndCallback) onEndCallback();
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.onend = () => {
      if (onEndCallback) onEndCallback();
    };
    utterance.onerror = () => {
      if (onEndCallback) onEndCallback();
    };
    
    const voices = window.speechSynthesis.getVoices();
    let chosenVoice = voices.find(v => v.name.includes(voiceName));
    if (!chosenVoice) {
      chosenVoice = voices.find(v => v.lang.startsWith("en-") && v.name.includes("Google"));
    }
    if (!chosenVoice) {
      chosenVoice = voices.find(v => v.lang.startsWith("en"));
    }
    if (chosenVoice) {
      utterance.voice = chosenVoice;
    }
    utterance.rate = 1.0;
    utterance.pitch = 1.02;
    window.speechSynthesis.speak(utterance);
  };

  const startZoeVoiceCall = () => {
    const SpeechRecognitionClass = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognitionClass) {
      alert("Your browser does not support Speech Recognition. Please try again on Google Chrome or Safari.");
      return;
    }

    if (window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }

    setIsVoiceCallActive(true);
    setVoiceCallStatus("ringing" as any); // Transition status indicating dialing simulated call
    setVoiceTranscript("Dialing Zoe's Brain...");
    setZoeSpeechResponse("");
    addLog("🔊 Starting dynamic AI calling tone sequence...");

    // Immediately play the ringing / feedback tone
    playRingingTone();

    // After 2.1 seconds, answer the call and initialize actual voice listening
    setTimeout(() => {
      playConnectChime();
      setVoiceCallStatus("listening");
      setVoiceTranscript("Active connection. Zoe is listening...");
      addLog("🟢 Call connected! Zoe is listening... Speak your query/WhatsApp instruction now.");

      const recognition = new SpeechRecognitionClass();
      recognition.continuous = false;
      recognition.interimResults = false;
      recognition.lang = "en-US";

      recognition.onstart = () => {
        setVoiceCallStatus("listening");
      };

      recognition.onresult = async (event: any) => {
        const transcriptText = event.results[0][0].transcript;
        setVoiceTranscript(transcriptText);
        setUserInput(transcriptText);
        addLog(`🗣️ Dictation recognized: "${transcriptText}"`);
        await processVoiceIntent(transcriptText);
      };

      recognition.onerror = (event: any) => {
        console.error("Speech Recognition Error", event);
        addLog(`⚠️ Speech Recognition error: ${event.error}`);
        stopAllSpeechAndCallState();
      };

      recognition.onend = () => {
        // recognition finished
      };

      recognition.start();
      setSpeechRecognition(recognition);
    }, 2200);
  };

  const processVoiceIntent = async (text: string) => {
    setVoiceCallStatus("thinking");
    addLog(`🧠 Speech-to-Intent translation via Gemini 3.5: "${text}"`);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (supabaseUrl && supabaseKey) {
        headers["x-supabase-url"] = supabaseUrl;
        headers["x-supabase-key"] = supabaseKey;
      }

      const res = await fetch("/api/extract-intent", {
        method: "POST",
        headers,
        body: JSON.stringify({
          userInput: text,
          contacts,
        }),
      });
      const data = await res.json();
      if (data.success) {
        const extraction = data.extraction as Extraction;
        setExtractedIntent(extraction);

        // Update manual override forms
        if (extraction.action) setManualAction(extraction.action as any);
        if (extraction.phone) setManualPhone(extraction.phone);
        if (extraction.contactName) setManualContactName(extraction.contactName);
        if (extraction.message) setManualMessage(extraction.message);

        let reply = "";
        if (extraction.action === "call" && extraction.phone) {
          reply = `I successfully found ${extraction.contactName} in your database. Initiating Twilio outbound call to ${extraction.phone} in three seconds.`;
        } else if (extraction.action === "voice_message" && extraction.phone) {
          reply = `Understood. Translating and sending a high fidelity Voice note to ${extraction.contactName} on WhatsApp.`;
        } else if (extraction.action === "text" && extraction.phone) {
          reply = `Alright. Dispatching a WhatsApp text message to ${extraction.contactName} now.`;
        } else {
          reply = `I heard: ${text}. I couldn't map that to an action. Please say something like: Call Zain, or Send text message to Zain.`;
        }

        setZoeSpeechResponse(reply);
        setVoiceCallStatus("responding");
        addLog(`🤖 Zoe respond: "${reply}"`);

        speakWord(reply, () => {
          if (extraction.action && extraction.phone) {
            setVoiceCallStatus("executing");
            let timer = 3;
            setCountdown(timer);
            const counter = setInterval(() => {
              timer--;
              setCountdown(timer);
              if (timer <= 0) {
                clearInterval(counter);
                setCountdown(null);
                executeVoiceDispatch(extraction);
              }
            }, 1000);
          } else {
            setIsVoiceCallActive(false);
            setVoiceCallStatus("idle");
          }
        });

      } else {
        const errReply = `Sorry, I encountered an error extracting details from your speech. Please type your request.`;
        setZoeSpeechResponse(errReply);
        setVoiceCallStatus("responding");
        speakWord(errReply, () => {
          setIsVoiceCallActive(false);
          setVoiceCallStatus("idle");
        });
      }
    } catch (err: any) {
      addLog(`❌ Voice Intent error: ${err.message}`);
      stopAllSpeechAndCallState();
    }
  };

  const executeVoiceDispatch = async (extraction: Extraction) => {
    addLog(`🚀 Direct Voice Dispatch: executing ${extraction.action.toUpperCase()}...`);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (supabaseUrl && supabaseKey) {
        headers["x-supabase-url"] = supabaseUrl;
        headers["x-supabase-key"] = supabaseKey;
      }

      let successMsg = "";

      if (extraction.action === "call") {
        const res = await fetch("/api/call/trigger", {
          method: "POST",
          headers,
          body: JSON.stringify({
            phone: extraction.phone,
            contactName: extraction.contactName || "Guest",
            message: extraction.message,
            twilioSid: twilioSid || null,
            twilioToken: twilioToken || null,
            twilioNumber: twilioNumber || null,
          }),
        });
        const data = await res.json();
        if (data.success) {
          successMsg = `Twilio call dialed successfully to ${extraction.contactName}!`;
          addLog(`✅ Outbound call generated! Twilio SID: ${data.callSid?.slice(0, 10)}...`);
        } else {
          throw new Error(data.error || "Twilio error");
        }
      } else if (extraction.action === "voice_message") {
        const res = await fetch("/api/whatsapp/send-voice", {
          method: "POST",
          headers,
          body: JSON.stringify({
            phoneNumber: extraction.phone,
            prompt: extraction.message,
            language: languageMode,
            voiceEngine,
            voiceName,
          }),
        });
        const data = await res.json();
        if (data.success) {
          successMsg = `WhatsApp voice note delivered to ${extraction.contactName}.`;
          addLog("✅ Voice note sent via WhatsApp Baileys.");
        } else {
          throw new Error(data.error || "WhatsApp voice send failed");
        }
      } else if (extraction.action === "text") {
        const res = await fetch("/api/whatsapp/send-text", {
          method: "POST",
          headers,
          body: JSON.stringify({
            phoneNumber: extraction.phone,
            message: extraction.message,
          }),
        });
        const data = await res.json();
        if (data.success) {
          successMsg = `WhatsApp text message delivered to ${extraction.contactName}.`;
          addLog("✅ WhatsApp text note sent.");
        } else {
          throw new Error(data.error || "WhatsApp text send failed");
        }
      }

      // Log action in database action_logs
      if (supabaseConnected && supabaseUrl && supabaseKey) {
        try {
          await fetch("/api/log-action", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...headers
            },
            body: JSON.stringify({
              action_type: extraction.action,
              target_name: extraction.contactName,
              target_value: extraction.phone,
              mode: extraction.action === "call" ? "Twilio Outbound" : "WhatsApp Dispatcher",
              message: extraction.message,
              result: { success: true }
            }),
          });
          addLog("📁 Executed action logged in 'action_logs' table.");
        } catch (dbErr) {
          console.error("Logger table save failed", dbErr);
        }
      }

      setZoeSpeechResponse(successMsg);
      speakWord(successMsg, () => {
        setIsVoiceCallActive(false);
        setVoiceCallStatus("idle");
      });

    } catch (err: any) {
      addLog(`❌ Voice Dispatch failed: ${err.message}`);
      const errReply = `Dispatch action failed: ${err.message}. Please verify your WhatsApp connection and credentials.`;
      setZoeSpeechResponse(errReply);
      speakWord(errReply, () => {
        setIsVoiceCallActive(false);
        setVoiceCallStatus("idle");
      });
    }
  };

  // Create new contact
  const handleAddContactSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newContact.name || !newContact.phone) {
      alert("Name and Phone Number are required.");
      return;
    }
    try {
      addLog(`Inserting new contact: "${newContact.name}" into database...`);
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (supabaseUrl && supabaseKey) {
        headers["x-supabase-url"] = supabaseUrl;
        headers["x-supabase-key"] = supabaseKey;
      }

      const res = await fetch("/api/contacts/add", {
        method: "POST",
        headers,
        body: JSON.stringify(newContact),
      });
      const data = await res.json();
      if (data.success) {
        addLog(`✅ Contact "${data.contact.name}" added successfully.`);
        setNewContact({ name: "", phone: "", email: "" });
        setShowAddContact(false);
        fetchContactsList();
      } else {
        addLog(`❌ Failed to save contact: ${data.error}`);
      }
    } catch (err: any) {
      addLog(`❌ Network failure creating contact: ${err.message}`);
    }
  };

  // Extract Speech/Text Intent via Gemini Intermediary
  const parseNaturalIntent = async () => {
    if (!userInput.trim()) {
      alert("Please enter a voice request description (e.g. \"call Sayyan and say hello\")");
      return;
    }
    setParsingIntent(true);
    setExtractedIntent(null);
    addLog(`🧠 Processing natural language command: "${userInput}"`);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (supabaseUrl && supabaseKey) {
        headers["x-supabase-url"] = supabaseUrl;
        headers["x-supabase-key"] = supabaseKey;
      }

      const res = await fetch("/api/extract-intent", {
        method: "POST",
        headers,
        body: JSON.stringify({
          userInput,
          contacts, // pass local cached list for fallback
        }),
      });
      const data = await res.json();
      if (data.success) {
        const extraction = data.extraction as Extraction;
        setExtractedIntent(extraction);
        
        // Auto prep manual triggers fields
        if (extraction.action) setManualAction(extraction.action as any);
        if (extraction.phone) setManualPhone(extraction.phone);
        if (extraction.contactName) setManualContactName(extraction.contactName);
        if (extraction.message) setManualMessage(extraction.message);

        addLog(`🎯 Intent Extracted: [Action: ${extraction.action.toUpperCase()}] [To: ${extraction.contactName || "Unknown"}]`);
      } else {
        addLog(`❌ Gemini extraction failed: ${data.error}`);
        alert(data.error);
      }
    } catch (err: any) {
      addLog(`❌ Query parser pipeline exception: ${err.message}`);
    } finally {
      setParsingIntent(false);
    }
  };

  // Real Dispatch Services Automation (Approve & Execute)
  const executeDispatch = async () => {
    if (!manualPhone) {
      alert("A valid target phone number is required.");
      return;
    }
    if (!manualMessage) {
      alert("A message or call directive context is required.");
      return;
    }

    setExecutingDispatch(true);
    addLog(`🚀 Dispatch active: Launching [${manualAction.toUpperCase()}] event to ${manualPhone}...`);

    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (supabaseUrl && supabaseKey) {
        headers["x-supabase-url"] = supabaseUrl;
        headers["x-supabase-key"] = supabaseKey;
      }

      if (manualAction === "call") {
        // Option 1: Trigger twilio Outbound call with ws streams
        addLog("☎️ Outbound dialing twilio stream callback...");
        const res = await fetch("/api/call/trigger", {
          method: "POST",
          headers,
          body: JSON.stringify({
            phone: manualPhone,
            contactName: manualContactName || "Guest",
            message: manualMessage,
            twilioSid: twilioSid || null,
            twilioToken: twilioToken || null,
            twilioNumber: twilioNumber || null,
          }),
        });
        const data = await res.json();
        if (data.success) {
          addLog(`📞 Twilio call triggered! Sid: ${data.callSid.slice(0, 12)}... State: ${data.status}`);
        } else {
          addLog(`❌ Twilio call trigger failed: ${data.error}`);
          alert(data.error);
        }

      } else if (manualAction === "voice_message") {
        // Option 2: Translate voice message TTS via WhatsApp
        if (waStatus !== "connected") {
          alert("WhatsApp is disconnected! Scan the QR code on the right panel first to synchronize your session.");
          setExecutingDispatch(false);
          return;
        }

        addLog(`🎙️ Synthesizing dynamic translation TTS [Lang: ${languageMode}, Voice: ${voiceName}]...`);
        const res = await fetch("/api/whatsapp/send-voice", {
          method: "POST",
          headers,
          body: JSON.stringify({
            phoneNumber: manualPhone,
            prompt: manualMessage,
            language: languageMode,
            voiceEngine,
            voiceName,
          }),
        });
        const data = await res.json();
        if (data.success) {
          addLog(`✅ WhatsApp Voice Message sent successfully! Text Spoken: "${data.text}"`);
        } else {
          addLog(`❌ WhatsApp voice sending failure: ${data.error}`);
          alert(data.error);
        }

      } else if (manualAction === "text") {
        // Option 3: Send persistent text message over BAILEYS session
        if (waStatus !== "connected") {
          alert("WhatsApp is disconnected! Scan the QR code on the right panel first.");
          setExecutingDispatch(false);
          return;
        }

        addLog(`💬 Sending plain text message dispatch over synchronized session...`);
        const res = await fetch("/api/whatsapp/send-text", {
          method: "POST",
          headers,
          body: JSON.stringify({
            phoneNumber: manualPhone,
            message: manualMessage,
          }),
        });
        const data = await res.json();
        if (data.success) {
          addLog(`✅ WhatsApp Regular Text message dispatched straight to ${manualPhone}!`);
        } else {
          addLog(`❌ WhatsApp text sending failure: ${data.error}`);
          alert(data.error);
        }
      }

    } catch (err: any) {
      addLog(`❌ Execution pipeline failure error: ${err.message}`);
    } finally {
      setExecutingDispatch(false);
    }
  };

  return (
    <div id="zoe-root-container" className="min-h-screen bg-neutral-950 text-neutral-100 font-sans p-4 sm:p-6 lg:p-8 selection:bg-teal-500 selection:text-white">
      
      {/* Dynamic Background subtle ambient blobs */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden max-w-full">
        <div className="absolute top-[-10%] left-[-10%] w-[350px] h-[350px] rounded-full bg-teal-950/20 blur-[100px] pointer-events-none" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[450px] h-[450px] rounded-full bg-indigo-950/20 blur-[100px] pointer-events-none" />
      </div>

      {/* Primary responsive grid frame */}
      <div className="relative max-w-7xl mx-auto space-y-6">

        {/* Dynamic header visual banner */}
        <header id="zoe-page-header" className="flex flex-col md:flex-row md:items-center justify-between gap-4 p-6 bg-neutral-900/60 border border-neutral-800 rounded-2xl backdrop-blur-md">
          <div className="flex items-center gap-4">
            <div className="relative p-3 bg-teal-500/10 rounded-xl border border-teal-500/30 text-teal-400">
              <Bot className="w-8 h-8 animate-pulse-slow" />
              <div className="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-emerald-500 border border-neutral-950" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-xl sm:text-2xl font-semibold tracking-tight font-display text-white">
                  Zoe Assistant
                </h1>
                <span className="text-[10px] uppercase font-mono px-2 py-0.5 rounded bg-teal-500/10 text-teal-400 border border-teal-500/20">
                  Dual WhatsApp + Voice Edition
                </span>
              </div>
              <p className="text-xs sm:text-sm text-neutral-400 mt-1">
                Combining Outbound Twilio Calls, Gemini Voice Live Streams, and Universal WhatsApp Dispatch.
              </p>
            </div>
          </div>
          
          <div className="flex items-center gap-2 self-start md:self-auto text-xs font-mono">
            <div className="px-3 py-1.5 rounded-lg bg-neutral-950 border border-neutral-800/80 flex items-center gap-2">
              <span className="text-neutral-500">WA Server:</span>
              <span className={`inline-block w-2 h-2 rounded-full ${waStatus === "connected" ? "bg-emerald-500" : "bg-amber-500"}`} />
              <span className={waStatus === "connected" ? "text-emerald-400" : "text-amber-400"}>
                {waStatus.toUpperCase()}
              </span>
            </div>
          </div>
        </header>

        {/* Database Credentials Connection drawer (collapsible for sleek workspace) */}
        <section id="credentials-setup" className="bg-neutral-900/30 border border-neutral-800/60 rounded-2xl p-5 backdrop-blur-sm">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-medium text-neutral-300">
              <Database className="w-4 h-4 text-teal-500" />
              <span>Connect Database & Sync Secrets (Supabase Optional Fallback)</span>
            </div>
            <div className="flex items-center gap-2">
              {supabaseConnected ? (
                <span className="text-xs inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/10">
                  <ShieldCheck className="w-3.5 h-3.5" /> Database Connected
                </span>
              ) : (
                <span className="text-xs px-2.5 py-1 rounded-full bg-neutral-800 text-neutral-400">
                  Fallback Demo Mode Enabled
                </span>
              )}
            </div>
          </div>

          <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="text-[11px] font-mono text-neutral-400 block mb-1.5 uppercase tracking-wider">
                Supabase URL Link
              </label>
              <input 
                type="text" 
                placeholder="https://your-project.supabase.co" 
                value={supabaseUrl}
                onChange={(e) => setSupabaseUrl(e.target.value)}
                className="w-full text-xs bg-neutral-950/80 border border-neutral-800 focus:border-teal-500/60 rounded-xl px-3 py-2 text-white placeholder-neutral-600 outline-none transition-all"
              />
            </div>
            <div>
              <label className="text-[11px] font-mono text-neutral-400 block mb-1.5 uppercase tracking-wider">
                Supabase Anon / Service Key
              </label>
              <input 
                type="password" 
                placeholder="eyJhY0ludGVydmFsSWQiOi..." 
                value={supabaseKey}
                onChange={(e) => setSupabaseKey(e.target.value)}
                className="w-full text-xs bg-neutral-950/80 border border-neutral-800 focus:border-teal-500/60 rounded-xl px-3 py-2 text-white placeholder-neutral-600 outline-none transition-all"
              />
            </div>
            <div className="flex items-end">
              <button 
                onClick={verifySupabase}
                disabled={checkingSupabase}
                className="w-full text-xs font-medium bg-neutral-800/80 hover:bg-neutral-800 hover:text-white text-neutral-200 border border-neutral-700/60 rounded-xl px-4 py-2 flex items-center justify-center gap-2 transition-all cursor-pointer disabled:opacity-55"
              >
                {checkingSupabase ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" /> Verifying Connection...
                  </>
                ) : (
                  <>
                    <CheckCircle className="w-3.5 h-3.5 text-teal-400" /> Apply & Verify State
                  </>
                )}
              </button>
            </div>
          </div>
        </section>

        {/* Primary Interactive Panel split screen layout */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

          {/* LEFT COLUMN: Main Voice Command extraction dispatch & Custom override Controls */}
          <div className="lg:col-span-2 space-y-6">

            {/* Zoe Voice Portal (Hear & Respond speech-to-intent engine) */}
            <div className={`relative overflow-hidden rounded-2xl border transition-all duration-300 ${
              isVoiceCallActive 
                ? "bg-neutral-950 border-teal-500/40 shadow-[0_0_25px_rgba(20,184,166,0.15)] p-6 sm:p-8" 
                : "bg-neutral-900/60 border-neutral-800 hover:border-teal-500/20 p-6"
            }`}>
              
              {/* Subtle background animated pulse grid inside portal */}
              {isVoiceCallActive && (
                <div className="absolute inset-0 opacity-[0.03] pointer-events-none bg-[linear-gradient(to_right,#14b8a6_1px,transparent_1px),linear-gradient(to_bottom,#14b8a6_1px,transparent_1px)] bg-[size:16px_16px] animate-[pulse_6s_infinite]" />
              )}

              {!isVoiceCallActive ? (
                // IDLE PORTAL BLOCK
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-6 relative z-10">
                  <div className="space-y-2 max-w-xl">
                    <div className="flex items-center gap-2">
                       <span className="relative flex h-2 w-2">
                         <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-teal-400 opacity-75"></span>
                         <span className="relative inline-flex rounded-full h-2 w-2 bg-teal-500"></span>
                       </span>
                      <span className="text-[10px] tracking-widest font-mono text-teal-400 font-bold uppercase">
                        Voice Assistant Module
                      </span>
                    </div>
                    <h3 className="text-base sm:text-lg font-semibold font-display text-white">
                      Zoe Active Speech-to-Intent Portal
                    </h3>
                    <p className="text-xs text-neutral-400 leading-relaxed font-sans">
                      Initialize a natural hands-free verbal conversation. Zoe gathers voice commands, identifies database contacts, speaks response summaries out loud, and automates dispatches instantly!
                    </p>
                  </div>
                  <button
                    onClick={startZoeVoiceCall}
                    className="w-full sm:w-auto px-5 py-3 rounded-xl bg-teal-500 hover:bg-teal-400 text-neutral-950 font-bold text-xs flex items-center justify-center gap-2 transition-all cursor-pointer shadow-lg hover:shadow-teal-500/10 hover:-translate-y-0.5 group shrink-0"
                  >
                    <Mic className="w-4 h-4 text-neutral-950 group-hover:scale-110 transition-transform" />
                    Start Live Voice Session
                  </button>
                </div>
              ) : (
                // ACTIVE INTEGRATED VOICE CALL CONTROL TERMINAL (PREMIUM MOBILE CALL ALIAS SIMULATION)
                <div className="space-y-6 relative z-10 w-full flex flex-col items-center">
                  
                  {/* Outbound Cellular HUD / Top Header metadata */}
                  <div className="w-full flex items-center justify-between border-b border-neutral-800 pb-3 font-mono text-[10px] text-neutral-500">
                    <div className="flex items-center gap-2">
                      <Radio className="w-3.5 h-3.5 text-teal-500 animate-pulse shrink-0" />
                      <span className="tracking-wider uppercase">Secure VoIP Connection Active</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Wifi className="w-3.5 h-3.5 text-emerald-400" />
                      <span className="text-neutral-300 font-bold">
                        {callOnHold ? "[ ON HOLD ]" : `[ ${Math.floor(callDuration / 60).toString().padStart(2, '0')}:${(callDuration % 60).toString().padStart(2, '0')} ]`}
                      </span>
                    </div>
                  </div>

                  {/* Main Calling Portrait & Avatar Wave Core */}
                  <div className="w-full bg-neutral-950/40 border border-neutral-800/80 rounded-2xl py-6 flex flex-col items-center justify-center relative overflow-hidden">
                    
                    {/* Ringing / Audio Wave Ambient background */}
                    <div className="absolute inset-x-0 bottom-0 top-1/2 bg-gradient-to-t from-teal-500/[0.02] to-transparent pointer-events-none" />
                    
                    <div className="relative mb-4">
                      {/* Concentric rotating glowing rings */}
                      <span className={`absolute -inset-4 rounded-full border border-dashed opacity-25 animate-[spin_10s_linear_infinite] ${
                        voiceCallStatus === "ringing" ? "border-amber-500" :
                        voiceCallStatus === "listening" ? "border-emerald-500" :
                        voiceCallStatus === "thinking" ? "border-indigo-500" :
                        voiceCallStatus === "responding" ? "border-cyan-500" : "border-teal-500"
                      }`} />
                      
                      <span className={`absolute -inset-8 rounded-full border opacity-10 animate-ping ${
                        voiceCallStatus === "ringing" ? "border-amber-400" :
                        voiceCallStatus === "listening" ? "border-emerald-400" :
                        voiceCallStatus === "thinking" ? "border-indigo-400" :
                        voiceCallStatus === "responding" ? "border-cyan-400" : "border-teal-400"
                      }`} />

                      {/* Zoe Glowing Circle Calling Avatar Head */}
                      <div className={`w-24 h-24 rounded-full flex items-center justify-center border-2 transition-all duration-500 select-none shadow-2xl ${
                        isAudioMuted ? "bg-red-950/20 border-red-500 text-red-400 shadow-red-500/10" :
                        callOnHold ? "bg-neutral-900 border-neutral-600 text-neutral-400" :
                        voiceCallStatus === "ringing" ? "bg-amber-500/10 border-amber-500 text-amber-400 shadow-amber-500/10 scale-105" :
                        voiceCallStatus === "listening" ? "bg-emerald-500/10 border-emerald-500 text-emerald-400 shadow-emerald-500/15 scale-110" :
                        voiceCallStatus === "thinking" ? "bg-indigo-500/10 border-indigo-500 text-indigo-400 shadow-indigo-500/15" :
                        voiceCallStatus === "responding" ? "bg-cyan-500/10 border-cyan-500 text-cyan-400 shadow-cyan-500/15 scale-110" :
                        "bg-teal-500/10 border-teal-500 text-teal-400 shadow-teal-500/15 scale-105"
                      }`}>
                        {isAudioMuted ? (
                          <VolumeX className="w-10 h-10" />
                        ) : callOnHold ? (
                          <Pause className="w-10 h-10" />
                        ) : voiceCallStatus === "ringing" ? (
                          <Phone className="w-10 h-10 animate-bounce" />
                        ) : voiceCallStatus === "listening" ? (
                          <Mic className="w-10 h-10 animate-pulse" />
                        ) : voiceCallStatus === "thinking" ? (
                          <RefreshCw className="w-10 h-10 animate-spin" />
                        ) : (
                          <Bot className="w-10 h-10" />
                        )}
                      </div>
                    </div>

                    {/* Calling Subtitles and Target information */}
                    <div className="text-center space-y-1 relative z-10 px-4">
                      <h4 className="text-sm font-bold text-white tracking-wide uppercase">
                        {callOnHold ? "Call on Hold" : "Zoe Voice Assistant"}
                      </h4>
                      <p className="text-[10px] font-mono tracking-widest text-[#14b8a6] uppercase font-bold">
                        {isAudioMuted ? "Muted Microphone" :
                         callOnHold ? "Waiting to resume..." :
                         voiceCallStatus === "ringing" ? "DIALING ZOE..." :
                         voiceCallStatus === "listening" ? "LINE OPEN - SPEAK NOW" :
                         voiceCallStatus === "thinking" ? "COGNITIVE SYNAPSE ENGAGED" :
                         voiceCallStatus === "responding" ? "ZOE RESPONDING OUT LOUD" : "COORDINATING OUTBOUND AUTOMATION"}
                      </p>

                      {/* Display targeted recipient if mapped */}
                      {extractedIntent && extractedIntent.contactName && (
                        <div className="mt-2 inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-teal-500/10 border border-teal-500/20 text-[10px] text-teal-400 font-mono">
                          <CheckCircle className="w-3 h-3 text-teal-500" />
                          <span>MAPPED CONTEXT: {extractedIntent.contactName.toUpperCase()} ({extractedIntent.phone})</span>
                        </div>
                      )}
                    </div>

                    {/* Animated sound equalizer bar metrics */}
                    {!callOnHold && !isAudioMuted && (voiceCallStatus === "listening" || voiceCallStatus === "responding") && (
                      <div className="mt-5 flex items-center justify-center gap-1 h-6">
                        {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((bar) => {
                          const randDelay = Math.random() * 0.5;
                          const randHeight = voiceCallStatus === "responding" 
                            ? [8, 22, 12, 24, 6][bar % 5] 
                            : [10, 16, 8, 12, 6][bar % 5];
                          return (
                            <span 
                              key={bar} 
                              style={{ 
                                height: `${randHeight}px`,
                                animationDelay: `${randDelay}s`,
                                animationDuration: `${0.4 + (bar % 3) * 0.15}s`
                              }}
                              className={`w-1 rounded-full bg-teal-500 animate-[pulse_0.8s_infinite] ${
                                voiceCallStatus === "responding" ? "bg-cyan-400" : "bg-emerald-400"
                              }`} 
                            />
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* Real-time speech Bubbles / Dialog Monitor */}
                  <div className="w-full bg-neutral-950 border border-neutral-800 rounded-xl p-4 font-mono text-xs space-y-3.5 shadow-inner">
                    <div className="flex items-center justify-between border-b border-neutral-900 pb-2">
                      <div className="flex items-center gap-1.5">
                        <span className="w-2 rounded-full h-2 bg-teal-400 animate-pulse" />
                        <span className="text-[9px] text-[#14b8a6] font-bold uppercase tracking-widest">
                          Simplex Audio Decoder
                        </span>
                      </div>
                      <span className="text-[10px] text-neutral-500 uppercase">
                        Buffer length: {voiceTranscript ? `${voiceTranscript.length} chars` : "0"}
                      </span>
                    </div>

                    <div className="space-y-3 max-h-40 overflow-y-auto pr-1">
                      {/* User input feed */}
                      <div className="flex items-start gap-2.5">
                        <span className="text-emerald-500 font-bold shrink-0 text-[10px] font-mono mt-1">USER:</span>
                        <div className="rounded-xl px-3 py-2 text-neutral-100 leading-relaxed bg-neutral-900 border border-neutral-800/80 w-full">
                          {voiceTranscript || <span className="italic text-neutral-600">Waiting for verbal prompt...</span>}
                        </div>
                      </div>

                      {/* Assistant speech answer feed */}
                      {zoeSpeechResponse && (
                        <div className="flex items-start gap-2.5 border-t border-neutral-900 pt-2 text-wrap">
                          <span className="text-cyan-400 font-bold shrink-0 text-[10px] font-mono mt-1">ZOE:</span>
                          <div className="rounded-xl px-3 py-2 text-neutral-200 leading-relaxed bg-teal-950/20 border border-teal-500/20 w-full text-balance">
                            {zoeSpeechResponse}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Keypad dial digits display screen */}
                  {showKeypad && (
                    <div className="w-full bg-neutral-950 border border-teal-500/20 rounded-xl p-3 text-center font-mono text-base font-bold text-teal-400 tracking-wider shadow-lg flex items-center justify-between">
                      <span className="text-[10px] text-neutral-500 uppercase font-bold pr-2 shrink-0">DTMF Dialed:</span>
                      <span className="truncate overflow-hidden w-full select-all text-right">{dialedDigits || "[ empty ]"}</span>
                    </div>
                  )}

                  {/* Collapse state Dial Keypad (Tactile classic double tone dial pad) */}
                  {showKeypad && (
                    <motion.div 
                      initial={{ opacity: 0, y: -10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="w-full grid grid-cols-3 gap-3 p-4 bg-neutral-950 rounded-2xl border border-neutral-800"
                    >
                      {['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'].map((digit) => (
                        <button
                          key={digit}
                          onClick={() => {
                            playDTMFTone(digit);
                            setDialedDigits(prev => prev + digit);
                          }}
                          className="py-3 rounded-xl bg-neutral-900 hover:bg-[#14b8a6]/20 active:bg-[#14b8a6]/30 text-white font-mono font-bold text-sm border border-neutral-800 hover:border-[#14b8a6]/40 transition-all flex flex-col items-center justify-center cursor-pointer active:scale-95"
                        >
                          <span>{digit}</span>
                          <span className="text-[7px] text-neutral-500">
                            {digit === '1' ? ' ' : 
                             digit === '2' ? 'abc' : 
                             digit === '3' ? 'def' :
                             digit === '4' ? 'ghi' : 
                             digit === '5' ? 'jkl' : 
                             digit === '6' ? 'mno' :
                             digit === '7' ? 'pqrs' : 
                             digit === '8' ? 'tuv' : 
                             digit === '9' ? 'wxyz' : ' '}
                          </span>
                        </button>
                      ))}
                    </motion.div>
                  )}

                  {/* Call Actions / Phone-Sized HUD interactive Control button grid */}
                  <div className="w-full grid grid-cols-4 gap-2">
                    <button
                      onClick={() => setIsAudioMuted(!isAudioMuted)}
                      className={`py-2 rounded-xl border flex flex-col items-center justify-center gap-1 transition-all cursor-pointer ${
                        isAudioMuted 
                          ? "bg-red-500/20 border-red-500 text-red-400" 
                          : "bg-neutral-900/60 border-neutral-800 hover:border-neutral-700 text-neutral-300"
                      }`}
                    >
                      {isAudioMuted ? <VolumeX className="w-4 h-4 text-red-400" /> : <Mic className="w-4 h-4 text-neutral-400" />}
                      <span className="text-[9px] font-mono">Mute</span>
                    </button>

                    <button
                      onClick={() => {
                        playConnectChime();
                        setShowKeypad(!showKeypad);
                      }}
                      className={`py-2 rounded-xl border flex flex-col items-center justify-center gap-1 transition-all cursor-pointer ${
                        showKeypad 
                          ? "bg-teal-500/20 border-teal-500 text-teal-400 shadow-[0_0_10px_rgba(20,184,166,0.1)]" 
                          : "bg-neutral-900/60 border-neutral-800 hover:border-neutral-700 text-neutral-300"
                      }`}
                    >
                      <Grid className="w-4 h-4 text-neutral-400" />
                      <span className="text-[9px] font-mono">Keypad</span>
                    </button>

                    <button
                      onClick={() => {
                        playConnectChime();
                        setCallOnHold(!callOnHold);
                      }}
                      className={`py-2 rounded-xl border flex flex-col items-center justify-center gap-1 transition-all cursor-pointer ${
                        callOnHold 
                          ? "bg-amber-500/20 border-amber-500 text-amber-400" 
                          : "bg-neutral-900/60 border-neutral-800 hover:border-neutral-700 text-neutral-300"
                      }`}
                    >
                      {callOnHold ? <Play className="w-4 h-4 text-amber-400" /> : <Pause className="w-4 h-4 text-neutral-400" />}
                      <span className="text-[9px] font-mono">{callOnHold ? "Resume" : "Hold"}</span>
                    </button>

                    <button
                      onClick={startZoeVoiceCall}
                      disabled={voiceCallStatus === "thinking" || voiceCallStatus === "executing"}
                      className="py-2 rounded-xl bg-neutral-900/60 border border-neutral-800 hover:border-neutral-700 text-neutral-300 disabled:opacity-40 flex flex-col items-center justify-center gap-1 cursor-pointer"
                    >
                      <Mic className="w-4 h-4 text-teal-400" />
                      <span className="text-[9px] font-mono">Speak</span>
                    </button>
                  </div>

                  {/* Red Hang Up button */}
                  <div className="w-full pt-2">
                    <button
                      onClick={stopAllSpeechAndCallState}
                      className="w-full py-3.5 rounded-2xl bg-red-600 hover:bg-red-500 text-white font-bold text-xs flex items-center justify-center gap-2.5 transition-all cursor-pointer shadow-lg hover:shadow-red-600/20 border border-red-500 hover:-translate-y-0.5 active:translate-y-0 font-display"
                    >
                      <PhoneOff className="w-4 h-4 text-white" />
                      Hang Up Session
                    </button>
                  </div>

                </div>
              )}

            </div>

            {/* AI Command Input Bar */}
            <div className="bg-neutral-900/60 border border-neutral-800 rounded-2xl p-6 backdrop-blur-md space-y-4">
              <div className="flex items-center justify-between">
                <div id="intent-extractor-title" className="flex items-center gap-2">
                  <span className="p-1.5 rounded-lg bg-teal-500/10 text-teal-400 border border-teal-500/20">
                    <Cpu className="w-4 h-4" />
                  </span>
                  <h2 className="text-base font-semibold text-white">Speak or Type to Zoe</h2>
                </div>
                <span className="text-[11px] text-neutral-400 font-mono">
                  Powered by Gemini 3.5 AI
                </span>
              </div>

              <p className="text-xs text-neutral-400">
                Type what you want to automate. Zoe will map the name to your contacts database, select the appropriate action protocol, and draft the dynamic message payload instantly!
              </p>

              <div id="ai-chat-prompt-actions" className="relative mt-2">
                <input 
                  type="text" 
                  placeholder='e.g., "call Sayyan training starts in 5 minutes" or "voice message to Zain saying hi!"'
                  value={userInput}
                  onChange={(e) => setUserInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && parseNaturalIntent()}
                  className="w-full text-sm bg-neutral-950 border border-neutral-800 focus:border-teal-500 rounded-xl pl-4 pr-12 py-3 text-white placeholder-neutral-500 outline-none transition-all"
                />
                <button 
                  onClick={parseNaturalIntent}
                  disabled={parsingIntent || !userInput.trim()}
                  className="absolute right-2 top-2 p-2 rounded-lg bg-teal-500 text-neutral-950 hover:bg-teal-400 transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                  title="Parse Intent"
                >
                  {parsingIntent ? (
                    <RefreshCw className="w-4 h-4 animate-spin text-neutral-950" />
                  ) : (
                    <ArrowRight className="w-4 h-4" />
                  )}
                </button>
              </div>

              {/* Sample commands cards to help user see format */}
              <div className="flex flex-wrap gap-2 pt-1">
                <span className="text-[10px] text-neutral-500 block">Sample Queries:</span>
                {[
                  'text Zain saying "Are you free today?"',
                  'voice message to Zain telling him the meeting has started',
                  'call Zain and say his Zoom link is ready'
                ].map((sample, idx) => (
                  <button 
                    key={idx}
                    onClick={() => setUserInput(sample)}
                    className="text-[10px] text-neutral-400 bg-neutral-950 hover:bg-neutral-800 hover:text-white px-2 py-0.5 rounded-md border border-neutral-800 transition-all font-mono text-left cursor-pointer"
                  >
                    "{sample}"
                  </button>
                ))}
              </div>
            </div>

            {/* Extracted Intent View, Voice Config & Dispatch Executive Panel */}
            <div className="bg-neutral-900/60 border border-neutral-800 rounded-2xl p-6 backdrop-blur-md space-y-6">
              <div className="flex items-center justify-between border-b border-neutral-800 pb-4">
                <div className="flex items-center gap-2">
                  <span className="p-1.5 rounded-lg bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                    <Send className="w-4 h-4" />
                  </span>
                  <h3 className="text-base font-semibold text-white">Execution & Dispatch Center</h3>
                </div>
                <div className="flex items-center gap-2">
                  <span className="flex items-center gap-1.5 text-xs text-teal-400 bg-teal-500/10 border border-teal-500/20 px-2 py-0.5 rounded-full">
                    <Bot className="w-3.5 h-3.5" /> High-Fidelity
                  </span>
                </div>
              </div>

              {/* Extracted preview alert card */}
              <AnimatePresence mode="wait">
                {extractedIntent && (
                  <motion.div 
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    className="p-4 bg-teal-950/20 border border-teal-500/20 rounded-xl space-y-3"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-mono font-medium text-teal-400 uppercase tracking-wide">
                        🎯 Extracted AI Intent Draft
                      </span>
                      <span className="text-[10px] font-mono text-neutral-400">
                        Accuracy score matches contacts database
                      </span>
                    </div>

                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs font-mono">
                      <div>
                        <span className="text-neutral-400 block text-[10px] uppercase">Action Protocol</span>
                        <span className="text-white font-medium capitalize mt-0.5 inline-block">
                          {extractedIntent.action === "call" ? "☎️ Twilio Outbound Voice" : 
                           extractedIntent.action === "voice_message" ? "🎙️ WhatsApp Voice Note" : 
                           extractedIntent.action === "text" ? "💬 WhatsApp Text" : "Pending query"}
                        </span>
                      </div>
                      <div>
                        <span className="text-neutral-400 block text-[10px] uppercase">Contact Name</span>
                        <span className="text-white font-medium mt-0.5 inline-block">
                          {extractedIntent.contactName || "Unmatched"}
                        </span>
                      </div>
                      <div>
                        <span className="text-neutral-400 block text-[10px] uppercase">Target Number</span>
                        <span className="text-white font-medium mt-0.5 inline-block text-teal-300">
                          {extractedIntent.phone || "Not found in DB"}
                        </span>
                      </div>
                      <div>
                        <span className="text-neutral-400 block text-[10px] uppercase">Extracted message context</span>
                        <span className="text-white font-medium mt-0.5 inline-block truncate max-w-full" title={extractedIntent.message}>
                          "{extractedIntent.message}"
                        </span>
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Live Dispatch Form configuration details (lets user verify details before dispatching) */}
              <div id="dispatch-form" className="space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-neutral-300">Review & Customize Parameters</span>
                  <span className="text-xs text-neutral-500">(Auto-updated by queries or editable)</span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  {/* Action Selection trigger */}
                  <div>
                    <label className="text-[10px] font-mono text-neutral-400 block mb-1 uppercase tracking-wider">
                      Select Action Protocol
                    </label>
                    <div className="grid grid-cols-3 gap-1 bg-neutral-950 p-1 rounded-xl border border-neutral-800">
                      {[
                        { val: "text", icon: MessageSquare, name: "Text" },
                        { val: "voice_message", icon: Volume2, name: "Voice Note" },
                        { val: "call", icon: Phone, name: "Phone Call" }
                      ].map((act) => {
                        const Icon = act.icon;
                        const isSel = manualAction === act.val;
                        return (
                          <button
                            key={act.val}
                            type="button"
                            onClick={() => setManualAction(act.val as any)}
                            className={`flex flex-col items-center justify-center py-1.5 rounded-lg text-[10px] font-medium transition-all cursor-pointer ${
                              isSel ? "bg-teal-500 text-neutral-950" : "bg-transparent text-neutral-400 hover:text-white"
                            }`}
                          >
                            <Icon className="w-3.5 h-3.5 mb-1" />
                            {act.name}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Manual Name */}
                  <div>
                    <label className="text-[10px] font-mono text-neutral-400 block mb-1 uppercase tracking-wider">
                      Contact Name
                    </label>
                    <input 
                      type="text" 
                      placeholder="e.g. Sayyan" 
                      value={manualContactName}
                      onChange={(e) => setManualContactName(e.target.value)}
                      className="w-full text-xs bg-neutral-950 border border-neutral-800 focus:border-teal-500 rounded-xl px-3 py-2.5 text-white outline-none transition-all"
                    />
                  </div>

                  {/* Respective Phone input */}
                  <div>
                    <label className="text-[10px] font-mono text-neutral-400 block mb-1 uppercase tracking-wider">
                      Target Phone Number
                    </label>
                    <input 
                      type="text" 
                      placeholder="e.g. +923001234567" 
                      value={manualPhone}
                      onChange={(e) => setManualPhone(e.target.value)}
                      className="w-full text-xs bg-neutral-950 border border-neutral-800 focus:border-teal-500 rounded-xl px-3 py-2.5 text-white outline-none transition-all"
                    />
                  </div>
                </div>

                {/* Respective Message content input area */}
                <div>
                  <label className="text-[10px] font-mono text-neutral-400 block mb-1 uppercase tracking-wider">
                    Call Context / Script / Message text
                  </label>
                  <textarea 
                    rows={3}
                    placeholder="Enter the actual message content details here..."
                    value={manualMessage}
                    onChange={(e) => setManualMessage(e.target.value)}
                    className="w-full text-xs bg-neutral-950 border border-neutral-800 focus:border-teal-500 rounded-xl px-3 py-2.5 text-white outline-none transition-all resize-none"
                  />
                </div>

                {/* Sub Voice Configuration choices (only shows if action requires TTS synthesis) */}
                <AnimatePresence>
                  {manualAction === "voice_message" && (
                    <motion.div 
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      exit={{ opacity: 0, height: 0 }}
                      className="grid grid-cols-1 md:grid-cols-3 gap-4 p-4 bg-indigo-950/10 border border-indigo-500/10 rounded-xl overflow-hidden"
                    >
                      {/* Language Constraint mode selection */}
                      <div>
                        <label className="text-[10px] font-mono text-indigo-300 block mb-1.5 uppercase gap-1 flex items-center">
                          <Languages className="w-3 h-3" /> Language Mode
                        </label>
                        <select 
                          value={languageMode}
                          onChange={(e) => setLanguageMode(e.target.value)}
                          className="w-full text-xs bg-neutral-950 border border-neutral-800 focus:border-indigo-500/60 rounded-lg px-2 py-1.5 text-white outline-none"
                        >
                          <option value="English">Pure English</option>
                          <option value="Urdu Script">Standard Urdu Script (اردو)</option>
                          <option value="Roman Urdu">Roman Urdu (English Alphabets)</option>
                          <option value="Bilingual">Bilingual (English + Roman Urdu Blend)</option>
                        </select>
                      </div>

                      {/* TTS Engine selection selector (Zoe Voice settings) */}
                      <div>
                        <label className="text-[10px] font-mono text-indigo-300 block mb-1.5 uppercase flex items-center gap-1">
                          <Cpu className="w-3 h-3" /> Voice Synthesizer
                        </label>
                        <select 
                          value={voiceEngine}
                          onChange={(e) => setVoiceEngine(e.target.value as any)}
                          className="w-full text-xs bg-neutral-950 border border-neutral-800 focus:border-indigo-500/60 rounded-lg px-2 py-1.5 text-white outline-none"
                        >
                          <option value="gemini-tts">Gemini 3.1 tts-preview</option>
                          <option value="standard-tts">Zoe standard Translation fallback</option>
                        </select>
                      </div>

                      {/* Prebuilt voices Selection criteria */}
                      <div>
                        <label className="text-[10px] font-mono text-indigo-300 block mb-1.5 uppercase flex items-center gap-1">
                          <Volume2 className="w-3 h-3" /> Prebuilt Voice Accent
                        </label>
                        <select 
                          value={voiceName}
                          disabled={voiceEngine !== "gemini-tts"}
                          onChange={(e) => setVoiceName(e.target.value)}
                          className="w-full text-xs bg-neutral-950 border border-neutral-800 focus:border-indigo-500/60 rounded-lg px-2 py-1.5 text-white outline-none disabled:opacity-40"
                        >
                          <option value="Zephyr">Zephyr (Warm & Expressive)</option>
                          <option value="Puck">Puck (Tech Mono Accent)</option>
                          <option value="Charon">Charon (Calm Male Deep Voice)</option>
                          <option value="Fenrir">Fenrir (Professional Tone)</option>
                          <option value="Kore">Kore (Clear Female Companion)</option>
                        </select>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* Primary Dispatch Action triggers */}
                <div className="pt-2">
                  <button
                    onClick={executeDispatch}
                    disabled={executingDispatch || !manualPhone || !manualMessage}
                    className="w-full py-3 bg-gradient-to-r from-teal-500 to-indigo-600 hover:from-teal-400 hover:to-indigo-500 transition-all font-medium text-xs sm:text-sm text-neutral-950 hover:scale-[1.01] rounded-xl flex items-center justify-center gap-2 cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed"
                  >
                    {executingDispatch ? (
                      <>
                        <RefreshCw className="w-4 h-4 animate-spin text-neutral-950" />
                        Executing assistant protocol... please do not close tab
                      </>
                    ) : (
                      <>
                        {manualAction === "call" ? <Phone className="w-4 h-4 text-neutral-950" /> :
                         manualAction === "voice_message" ? <Volume2 className="w-4 h-4 text-neutral-950" /> :
                         <MessageSquare className="w-4 h-4 text-neutral-950" />}
                        Approve & Execute [ {manualAction.toUpperCase()} ] Service Protocol Now
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>

            {/* JetBrains Logs activity Console */}
            <div className="bg-neutral-900/60 border border-neutral-800 rounded-2xl p-5 backdrop-blur-md">
              <div className="flex items-center justify-between border-b border-neutral-800 pb-3 mb-3">
                <div className="flex items-center gap-2 text-xs font-medium text-neutral-300">
                  <Terminal className="w-4 h-4 text-teal-400" />
                  <span>Real-time Subsystem Event Logs</span>
                </div>
                <button 
                  onClick={() => setLogs([])}
                  className="text-[10px] font-mono text-neutral-500 hover:text-neutral-300"
                >
                  Clear Console [x]
                </button>
              </div>

              <div className="bg-neutral-950 text-neutral-400 p-4 rounded-xl border border-neutral-800 font-mono text-[10px] sm:text-xs overflow-y-auto max-h-[220px] space-y-1.5 scrollbar-thin">
                {logs.length === 0 ? (
                  <div className="p-3 text-center text-neutral-600">
                    Console empty. Trigger an assistant dispatch to see traces!
                  </div>
                ) : (
                  logs.map((log, idx) => (
                    <div 
                      key={idx} 
                      className={`break-all leading-relaxed ${
                        log.includes("✅") ? "text-emerald-400" :
                        log.includes("❌") || log.includes("⚠️") ? "text-rose-400" :
                        log.includes("⚡") ? "text-teal-400" : "text-neutral-400"
                      }`}
                    >
                      {log}
                    </div>
                  ))
                )}
              </div>
            </div>

          </div>

          {/* RIGHT COLUMN: WhatsApp Multi-device Connector & Contacts database sidebar */}
          <div className="space-y-6">

            {/* Panel 1: WhatsApp scan connector container */}
            <div className="bg-neutral-900/60 border border-neutral-800 rounded-2xl p-6 backdrop-blur-md space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="p-1.5 rounded-lg bg-teal-500/10 text-teal-400 border border-teal-500/20">
                    <QrCode className="w-4 h-4" />
                  </span>
                  <h3 className="text-sm font-semibold text-white">Zoe WhatsApp Engine</h3>
                </div>
                <button 
                  onClick={fetchWhatsAppStatus} 
                  className="p-1.5 hover:bg-neutral-800 rounded-md text-neutral-400 hover:text-white"
                  title="Reload WhatsApp connection"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                </button>
              </div>

              <p className="text-xs text-neutral-400 leading-relaxed">
                Connect your personal or business WhatsApp to automate voice notes and dispatch text messages directly. Sessions are highly secure and persist natively inside our container!
              </p>

              {/* Connected view card status */}
              {waStatus === "connected" && (
                <div className="p-4 bg-emerald-500/10 border border-emerald-500/10 rounded-xl space-y-3">
                  <div className="flex items-center gap-2">
                    <div className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" />
                    <span className="text-xs font-mono font-semibold text-emerald-400">
                      CONNECTED TO WHATSAPP
                    </span>
                  </div>

                  <div className="text-xs space-y-1 font-mono text-neutral-400">
                    <div>
                      <span className="text-neutral-500">Paired User ID:</span>{" "}
                      <span className="text-neutral-200">{waUser || "Default session"}</span>
                    </div>
                    <div>
                      <span className="text-neutral-500">Service Type:</span>{" "}
                      <span className="text-neutral-200">Bilingual Voice & Text</span>
                    </div>
                  </div>

                  <button
                    onClick={disconnectWhatsApp}
                    className="w-full mt-1 py-1.5 text-xs font-medium bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/20 hover:text-rose-300 rounded-lg flex items-center justify-center gap-1.5 transition-all cursor-pointer"
                  >
                    <LogOut className="w-3.5 h-3.5" /> Stop WhatsApp Session
                  </button>
                </div>
              )}

              {/* Connecting loading / retry screen */}
              {waStatus === "connecting" && (
                <div className="p-4 bg-neutral-950 border border-neutral-800 rounded-xl flex flex-col items-center justify-center text-center space-y-3 py-8">
                  <RefreshCw className="w-8 h-8 animate-spin text-teal-400" />
                  <div>
                    <span className="text-xs font-semibold text-neutral-300">Spawning connection bridge...</span>
                    <p className="text-[10px] text-neutral-500 mt-1 max-w-[200px]">
                      Loading persistent container credentials. QR code will update automatically in a few seconds.
                    </p>
                  </div>
                </div>
              )}

              {/* QR Code login render */}
              {(waStatus === "qr_ready" && waQrCode) && (
                <div className="p-4 bg-white border border-neutral-800 rounded-xl flex flex-col items-center justify-center text-center space-y-3">
                  <img 
                    src={waQrCode} 
                    alt="WhatsApp QR Code Login" 
                    className="w-[180px] h-[180px] object-contain rounded"
                  />
                  <div>
                    <span className="text-xs font-semibold text-neutral-950">AUTHENTICATE DEVICE</span>
                    <p className="text-[10px] text-neutral-500 mt-1 max-w-[200px]">
                      Open WhatsApp link devices settings, click "Link Device" and scan the code.
                    </p>
                  </div>
                </div>
              )}

              {/* Disconnected triggers fallback */}
              {waStatus === "disconnected" && (
                <div className="p-4 bg-neutral-950 border border-neutral-800 rounded-xl text-center space-y-3 py-6">
                  <AlertCircle className="w-8 h-8 text-amber-500/80 mx-auto" />
                  <div>
                    <span className="text-xs font-semibold text-neutral-300">Authentication Required</span>
                    <p className="text-[10px] text-neutral-500 mt-1">
                      No active WhatsApp login session detected in this workspace.
                    </p>
                  </div>
                  <button
                    onClick={connectWhatsApp}
                    className="w-full py-2 bg-teal-500 hover:bg-teal-400 text-neutral-950 font-medium text-xs rounded-lg flex items-center justify-center gap-1.5 transition-all cursor-pointer"
                  >
                    <QrCode className="w-3.5 h-3.5" /> Initialize Whatsapp Session
                  </button>
                </div>
              )}
            </div>

            {/* Panel 2 Contacts manager database */}
            <div className="bg-neutral-900/60 border border-neutral-800 rounded-2xl p-6 backdrop-blur-md space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="p-1.5 rounded-lg bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                    <Users className="w-4 h-4" />
                  </span>
                  <h3 className="text-sm font-semibold text-white">Contacts Database</h3>
                </div>
                <button 
                  onClick={() => setShowAddContact(!showAddContact)}
                  className="p-1 bg-neutral-800 text-neutral-100 hover:bg-teal-500 hover:text-neutral-950 rounded-lg transition-all"
                  title="Create New Contact"
                >
                  <UserPlus className="w-4 h-4" />
                </button>
              </div>

              {/* New Contact interactive inline form */}
              <AnimatePresence>
                {showAddContact && (
                  <motion.form 
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    onSubmit={handleAddContactSubmit}
                    className="p-3 bg-neutral-950 border border-neutral-800 rounded-xl space-y-2.5 overflow-hidden"
                  >
                    <span className="text-[10px] font-mono text-neutral-400 block uppercase font-medium">
                      Create New Database Record
                    </span>
                    <input 
                      type="text" 
                      placeholder="Name (e.g. Zain)" 
                      value={newContact.name}
                      onChange={(e) => setNewContact({ ...newContact, name: e.target.value })}
                      className="w-full text-xs bg-neutral-900 border border-neutral-800 rounded px-2.5 py-1.5 text-white outline-none"
                    />
                    <input 
                      type="text" 
                      placeholder="Phone (e.g. +923339876543)" 
                      value={newContact.phone}
                      onChange={(e) => setNewContact({ ...newContact, phone: e.target.value })}
                      className="w-full text-xs bg-neutral-900 border border-neutral-800 rounded px-2.5 py-1.5 text-white outline-none"
                    />
                    <input 
                      type="email" 
                      placeholder="Email (optional)" 
                      value={newContact.email || ""}
                      onChange={(e) => setNewContact({ ...newContact, email: e.target.value })}
                      className="w-full text-xs bg-neutral-900 border border-neutral-800 rounded px-2.5 py-1.5 text-white outline-none"
                    />
                    <button 
                      type="submit"
                      className="w-full py-1.5 bg-teal-500 hover:bg-teal-400 text-neutral-950 font-bold text-xs rounded transition-all cursor-pointer"
                    >
                      Save to Database
                    </button>
                  </motion.form>
                )}
              </AnimatePresence>

              {/* Scrollable mapped contacts list */}
              <div className="space-y-2 h-[260px] overflow-y-auto pr-1">
                {loadingContacts ? (
                  <div className="p-8 text-center text-xs text-neutral-500">
                    Loading contact database mapping...
                  </div>
                ) : contacts.length === 0 ? (
                  <div className="p-8 text-center text-xs text-neutral-500 border border-neutral-800 border-dashed rounded-xl">
                    No contacts mapped. Use Add custom icon to populate your database!
                  </div>
                ) : (
                  contacts.map((contact, idx) => (
                    <button
                      key={idx}
                      onClick={() => {
                        // Select contact trigger updates
                        setManualPhone(contact.phone);
                        setManualContactName(contact.name);
                        addLog(`Selected contact: ${contact.name} (${contact.phone})`);
                      }}
                      className="w-full text-left p-3 rounded-xl bg-neutral-950 hover:bg-neutral-800 border border-neutral-800/80 hover:border-neutral-700 transition-all font-mono text-xs flex flex-row items-center gap-3 cursor-pointer group"
                    >
                      <div className="w-8 h-8 rounded-lg bg-neutral-900 group-hover:bg-neutral-950 flex items-center justify-center font-bold font-display text-white border border-neutral-800 text-xs">
                        {contact.name.charAt(0).toUpperCase()}
                      </div>
                      <div className="flex-1 min-w-0">
                        <span className="font-semibold text-neutral-200 block truncate font-sans">
                          {contact.name}
                        </span>
                        <span className="text-[10px] text-neutral-500 block group-hover:text-teal-400 transition-colors">
                          {contact.phone}
                        </span>
                      </div>
                    </button>
                  ))
                )}
              </div>
            </div>

          </div>

        </div>

      </div>
    </div>
  );
}
