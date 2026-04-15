"use client";

/**
 * AI Phil — voice + chat widget.
 *
 * Designed to render inside an iframe on /embed/ai-phil (so it can be
 * dropped into any site via /public/ai-phil-embed.js). Also usable
 * directly inside SAGE.
 *
 * Aesthetic: AiAi Mastermind coaching studio.
 *   Deep navy backdrop · coral accent · gold "Phil" signature
 *   Big central mic · pulse rings · real-time waveform bars (Hume FFT)
 */

import { forwardRef, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Mic, MicOff, Phone, PhoneOff, Send, MessageSquare, Waves, Loader2 } from "lucide-react";
import { VoiceProvider, useVoice } from "@humeai/voice-react";
import { cn } from "@/lib/cn";

type WidgetContext = "member" | "discovery" | "implementation" | "new-member";
type Mode = "voice" | "chat";

interface AIPhilWidgetProps {
  context?: WidgetContext;
  apiBase?: string;
  /** When true, renders in compact floating form; otherwise full iframe layout */
  floating?: boolean;
  /** Start in "voice" (default) or "chat" only mode. Users can toggle either way. */
  startMode?: Mode;
}

interface AccessTokenPayload {
  accessToken: string;
  configId: string;
  context: "new-member" | "implementation" | "discovery";
  error?: string;
}

// ────────────────────────────────────────────────────────────────────────────

export function AIPhilWidget({ context = "member", apiBase = "", floating = false, startMode = "voice" }: AIPhilWidgetProps) {
  const [auth, setAuth] = useState<AccessTokenPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Allow ?mode=chat URL override (also used by the embed loader)
  const resolvedStartMode: Mode = (() => {
    if (typeof window === "undefined") return startMode;
    const m = new URLSearchParams(window.location.search).get("mode");
    if (m === "chat" || m === "voice") return m;
    return startMode;
  })();

  useEffect(() => {
    void fetchToken();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function fetchToken() {
    setLoading(true);
    setError(null);
    try {
      const body: Record<string, string> = {};
      // Pass through any non-"member" context so the API knows which public
      // config to serve (discovery / implementation / new-member)
      if (context !== "member") body.context = context;
      // Support ?persona=new-member|implementation override (testing aid)
      let url = `${apiBase}/api/hume/access-token`;
      if (typeof window !== "undefined") {
        const persona = new URLSearchParams(window.location.search).get("persona");
        if (persona === "new-member" || persona === "implementation") {
          url += `?persona=${persona}`;
        }
      }
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data: AccessTokenPayload = await res.json();
      if (!res.ok || !data.accessToken) throw new Error(data.error || "Could not connect");
      setAuth(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  if (loading) return <StageFrame><LoadingState /></StageFrame>;
  if (error || !auth) return <StageFrame><ErrorState message={error || "Unknown error"} onRetry={fetchToken} /></StageFrame>;

  return (
    <VoiceProvider>
      <Stage auth={auth} apiBase={apiBase} floating={floating} startMode={resolvedStartMode} />
    </VoiceProvider>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Stage (post-auth container)
// ────────────────────────────────────────────────────────────────────────────

function Stage({ auth, apiBase, floating, startMode }: { auth: AccessTokenPayload; apiBase: string; floating: boolean; startMode: Mode }) {
  const voice = useVoice();
  const [mode, setMode] = useState<Mode>(startMode);
  const [chatInput, setChatInput] = useState("");
  const [duration, setDuration] = useState(0);
  const [isThinking, setIsThinking] = useState(false);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const audioContextRef = useRef<AudioContext | null>(null);

  // Connect on mount
  useEffect(() => {
    void voice.connect({
      auth: { type: "accessToken", value: auth.accessToken },
      configId: auth.configId,
    });
    return () => {
      void voice.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Chat-only mode: mute mic + AI audio output so it's truly text-only.
  // Voice mode: unmute both.
  useEffect(() => {
    if (voice.status.value !== "connected") return;
    if (mode === "chat") {
      voice.mute();
      voice.muteAudio();
    } else {
      voice.unmute();
      voice.unmuteAudio();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, voice.status.value]);

  // Soft chime to cover the silent tool-call window.
  // Two-note upward ping — subtle, studio-appropriate, won't jar the user.
  function playThinkingChime() {
    try {
      if (!audioContextRef.current) {
        const Ctx = window.AudioContext || (window as any).webkitAudioContext;
        if (!Ctx) return;
        audioContextRef.current = new Ctx();
      }
      const ctx = audioContextRef.current;
      if (!ctx) return;

      const now = ctx.currentTime;
      const makeNote = (freq: number, start: number, dur: number, peakGain: number) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(freq, now + start);
        gain.gain.setValueAtTime(0, now + start);
        gain.gain.linearRampToValueAtTime(peakGain, now + start + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + start + dur);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + start);
        osc.stop(now + start + dur + 0.05);
      };
      // G5 → D6 lift, 90ms apart
      makeNote(783.99, 0, 0.18, 0.06);
      makeNote(1174.66, 0.09, 0.22, 0.05);
    } catch {
      /* silent if audio context unavailable */
    }
  }

  // Tool call handler — tracks thinking state + plays audio cue
  useEffect(() => {
    const last = voice.messages[voice.messages.length - 1];
    if (!last || last.type !== "tool_call") return;

    setIsThinking(true);
    playThinkingChime();

    (async () => {
      try {
        const endpoint =
          last.name === "search_knowledge_base"
            ? "/api/hume/search-kb"
            : last.name === "book_discovery_call"
              ? "/api/hume/book-discovery-call"
              : null;
        if (!endpoint) throw new Error(`Unknown tool: ${last.name}`);
        const params = JSON.parse(last.parameters);
        const res = await fetch(`${apiBase}${endpoint}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(params),
        });
        const data = await res.json();
        voice.sendToolMessage({
          type: "tool_response",
          toolCallId: last.toolCallId,
          content: JSON.stringify(data),
        });
      } catch (err) {
        voice.sendToolMessage({
          type: "tool_error",
          toolCallId: last.toolCallId,
          error: err instanceof Error ? err.message : "Tool failed",
          content: "Sorry, I had trouble pulling that. Let me answer with what I have.",
        });
      } finally {
        setIsThinking(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice.messages]);

  // Auto-scroll chat
  useEffect(() => {
    chatScrollRef.current?.scrollTo({ top: chatScrollRef.current.scrollHeight, behavior: "smooth" });
  }, [voice.messages]);

  // Duration timer (seconds since first connect)
  useEffect(() => {
    if (voice.status.value !== "connected") return;
    const id = setInterval(() => setDuration((d) => d + 1), 1000);
    return () => clearInterval(id);
  }, [voice.status.value]);

  const isConnected = voice.status.value === "connected";
  const isConnecting = voice.status.value === "connecting";
  const isErrored = voice.status.value === "error";
  const isMuted = voice.isMuted;
  const isSpeaking = voice.isPlaying;

  const state: VoiceState = (() => {
    if (isErrored) return "error";
    if (isConnecting) return "connecting";
    if (!isConnected) return "idle";
    // Thinking beats Speaking because the tool response may arrive
    // after Hume has already queued a spoken bridge phrase
    if (isThinking) return "thinking";
    if (isSpeaking) return "speaking";
    if (isMuted) return "muted";
    return "listening";
  })();

  const visibleMessages = voice.messages.filter(
    (m) => m.type === "user_message" || m.type === "assistant_message"
  );

  function sendText(t: string) {
    const text = t.trim();
    if (!text) return;
    voice.sendUserInput(text);
    setChatInput("");
  }

  function endCall() {
    void voice.disconnect();
    // If inside iframe, tell parent to close; otherwise navigate away
    if (typeof window !== "undefined") {
      if (window.parent !== window) {
        window.parent.postMessage({ type: "ai-phil:close" }, "*");
      }
    }
  }

  return (
    <StageFrame floating={floating}>
      <Header state={state} contextLabel={contextLabelFor(auth.context)} mode={mode} onModeChange={setMode} onClose={endCall} />
      <div className="flex-1 min-h-0 flex flex-col">
        {mode === "voice" ? (
          <VoiceStage
            state={state}
            micFft={voice.micFft}
            speakerFft={voice.fft}
            duration={duration}
          />
        ) : (
          <ChatStage ref={chatScrollRef} messages={visibleMessages} state={state} />
        )}
        <TranscriptRail messages={visibleMessages} mode={mode} />
      </div>
      <Controls
        mode={mode}
        state={state}
        chatInput={chatInput}
        onChatInputChange={setChatInput}
        onChatSubmit={() => sendText(chatInput)}
        onMuteToggle={() => (isMuted ? voice.unmute() : voice.mute())}
        onEnd={endCall}
      />
    </StageFrame>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Frame — AiAi navy backdrop
// ────────────────────────────────────────────────────────────────────────────

function StageFrame({ children, floating }: { children: React.ReactNode; floating?: boolean }) {
  return (
    <div
      className={cn(
        "relative flex flex-col overflow-hidden text-[#f5f0e6] font-sans",
        floating ? "w-[380px] h-[600px] rounded-2xl shadow-2xl" : "w-full h-screen",
        "bg-[#1d3855]"
      )}
      style={{
        backgroundImage:
          "radial-gradient(ellipse 80% 60% at 50% 22%, rgba(255,255,255,0.04), transparent 60%), radial-gradient(ellipse 70% 50% at 50% 90%, rgba(231,76,60,0.08), transparent 60%)",
      }}
    >
      <AmbientParticles />
      <div className="relative z-10 flex flex-col flex-1 min-h-0">{children}</div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Header
// ────────────────────────────────────────────────────────────────────────────

type VoiceState = "idle" | "connecting" | "listening" | "thinking" | "speaking" | "muted" | "error";

function Header({
  state,
  contextLabel,
  mode,
  onModeChange,
  onClose,
}: {
  state: VoiceState;
  contextLabel: string;
  mode: Mode;
  onModeChange: (m: Mode) => void;
  onClose: () => void;
}) {
  return (
    <header className="flex items-center justify-between px-5 py-4 border-b border-white/5">
      <div className="flex items-center gap-3">
        <div className="relative">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/ai-phil-avatar.jpg"
            alt="AI Phil"
            className="w-10 h-10 rounded-full object-cover ring-2 ring-white/10"
          />
          <span className={cn(
            "absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-[#1d3855]",
            state === "listening" && "bg-emerald-400",
            state === "speaking" && "bg-[#e74c3c]",
            state === "thinking" && "bg-violet-400",
            state === "connecting" && "bg-amber-400",
            state === "muted" && "bg-gray-500",
            state === "idle" && "bg-gray-600",
            state === "error" && "bg-red-500"
          )} />
        </div>
        <div className="leading-tight">
          <div className="text-[15px] font-medium">AI <em className="not-italic font-serif italic text-[#fdd043]" style={{ fontFamily: '"Iowan Old Style", Palatino, Georgia, serif' }}>Phil</em></div>
          <div className="text-[10px] tracking-[0.15em] uppercase text-white/40">{contextLabel}</div>
        </div>
      </div>

      <div className="flex items-center gap-1.5">
        <div className="flex items-center rounded-full border border-white/10 bg-white/5 p-0.5">
          <ModeTab active={mode === "voice"} onClick={() => onModeChange("voice")}>
            <Waves className="w-3.5 h-3.5" />
            <span>Voice</span>
          </ModeTab>
          <ModeTab active={mode === "chat"} onClick={() => onModeChange("chat")}>
            <MessageSquare className="w-3.5 h-3.5" />
            <span>Chat</span>
          </ModeTab>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="End call"
          className="ml-1 h-8 w-8 rounded-full text-white/60 hover:text-white hover:bg-white/10 flex items-center justify-center transition"
        >
          <PhoneOff className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
}

function ModeTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition",
        active
          ? "bg-[#e74c3c] text-white shadow"
          : "text-white/60 hover:text-white"
      )}
    >
      {children}
    </button>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Voice Stage — central mic + pulse rings + waveform
// ────────────────────────────────────────────────────────────────────────────

function VoiceStage({
  state,
  micFft,
  speakerFft,
  duration,
}: {
  state: VoiceState;
  micFft: number[];
  speakerFft: number[];
  duration: number;
}) {
  // Use mic FFT when user is talking/listening; speaker FFT when AI is speaking
  const fft = state === "speaking" ? speakerFft : micFft;
  const bars = useFftBars(fft, 32);

  return (
    <div className="flex-1 flex flex-col items-center justify-center px-6 py-8 relative min-h-0">
      {/* Ambient glow behind orb */}
      <motion.div
        aria-hidden
        className="absolute pointer-events-none rounded-full blur-3xl"
        style={{ width: 340, height: 340 }}
        animate={{
          background:
            state === "speaking"
              ? "radial-gradient(circle, rgba(231,76,60,0.22), rgba(231,76,60,0) 70%)"
              : state === "thinking"
                ? "radial-gradient(circle, rgba(167,139,250,0.20), rgba(167,139,250,0) 70%)"
                : state === "listening"
                  ? "radial-gradient(circle, rgba(231,76,60,0.22), rgba(231,76,60,0) 70%)"
                  : "radial-gradient(circle, rgba(231,76,60,0.06), rgba(231,76,60,0) 70%)",
          scale: state === "listening" || state === "speaking" || state === "thinking" ? [1, 1.08, 1] : 1,
        }}
        transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
      />

      <MicOrb state={state} />

      <StatusLine state={state} duration={duration} />

      {/* Waveform */}
      <div className="mt-4 flex items-center justify-center gap-[3px] h-12">
        {bars.map((h, i) => (
          <motion.div
            key={i}
            className={cn(
              "w-[3px] rounded-full",
              state === "speaking"
                ? "bg-[#e74c3c]"
                : state === "thinking"
                  ? "bg-violet-400"
                  : state === "listening"
                    ? "bg-[#e74c3c]"
                    : "bg-white/20"
            )}
            animate={{
              // In "thinking" state the mic is gated, so bars breathe softly instead of reacting to FFT
              height: state === "thinking"
                ? `${10 + Math.sin((Date.now() + i * 120) / 220) * 6 + 8}px`
                : `${Math.max(4, h * 44)}px`,
              opacity: state === "listening" || state === "speaking" || state === "thinking" ? 1 : 0.35,
            }}
            transition={{ duration: 0.08, ease: "easeOut" }}
          />
        ))}
      </div>
    </div>
  );
}

function MicOrb({ state }: { state: VoiceState }) {
  return (
    <div className="relative flex items-center justify-center" style={{ width: 180, height: 180 }}>
      {/* Pulse rings when active */}
      <AnimatePresence>
        {(state === "listening" || state === "speaking" || state === "thinking") && (
          <>
            <motion.span
              key="ring1"
              className={cn(
                "absolute inset-0 rounded-full border-2",
                state === "speaking" && "border-[#e74c3c]/30",
                state === "thinking" && "border-violet-400/30",
                state === "listening" && "border-[#e74c3c]/30"
              )}
              initial={{ scale: 1, opacity: 0.7 }}
              animate={{ scale: 1.6, opacity: 0 }}
              transition={{ duration: state === "thinking" ? 1.2 : 1.8, repeat: Infinity, ease: "easeOut" }}
            />
            <motion.span
              key="ring2"
              className={cn(
                "absolute inset-0 rounded-full border-2",
                state === "speaking" && "border-[#e74c3c]/20",
                state === "thinking" && "border-violet-400/20",
                state === "listening" && "border-[#e74c3c]/20"
              )}
              initial={{ scale: 1, opacity: 0.5 }}
              animate={{ scale: 2.1, opacity: 0 }}
              transition={{ duration: state === "thinking" ? 1.2 : 1.8, repeat: Infinity, ease: "easeOut", delay: 0.5 }}
            />
          </>
        )}
      </AnimatePresence>

      {/* Central disc with icon */}
      <motion.div
        className={cn(
          "relative w-32 h-32 rounded-full flex items-center justify-center",
          "border-2",
          state === "speaking" && "border-[#e74c3c] shadow-[0_0_40px_rgba(231,76,60,0.35)]",
          state === "thinking" && "border-violet-400 shadow-[0_0_40px_rgba(167,139,250,0.30)]",
          state === "listening" && "border-[#e74c3c] shadow-[0_0_40px_rgba(231,76,60,0.35)]",
          state === "connecting" && "border-amber-400 shadow-[0_0_20px_rgba(251,191,36,0.25)]",
          state === "muted" && "border-white/20",
          state === "idle" && "border-white/15",
          state === "error" && "border-red-500/60",
        )}
        style={{
          background:
            state === "speaking"
              ? "radial-gradient(circle at 35% 32%, rgba(255,180,150,0.30), rgba(231,76,60,0.18) 55%, rgba(180,40,30,0.08) 100%)"
              : state === "thinking"
                ? "radial-gradient(circle at 35% 32%, rgba(224,215,255,0.32), rgba(167,139,250,0.18) 55%, rgba(109,85,201,0.08) 100%)"
                : state === "listening"
                  ? "radial-gradient(circle at 35% 32%, rgba(255,180,150,0.30), rgba(231,76,60,0.18) 55%, rgba(180,40,30,0.08) 100%)"
                  : "radial-gradient(circle at 35% 32%, rgba(245,240,230,0.12), rgba(245,240,230,0.05) 55%, rgba(0,0,0,0) 100%)",
        }}
        animate={
          state === "listening"
            ? { boxShadow: ["0 0 0 0 rgba(231,76,60,0.40)", "0 0 0 24px rgba(231,76,60,0)"] }
            : state === "speaking"
              ? { boxShadow: ["0 0 0 0 rgba(231,76,60,0.40)", "0 0 0 24px rgba(231,76,60,0)"] }
              : state === "thinking"
                ? { boxShadow: ["0 0 0 0 rgba(167,139,250,0.35)", "0 0 0 20px rgba(167,139,250,0)"] }
                : undefined
        }
        transition={{ duration: state === "thinking" ? 1.2 : 1.6, repeat: Infinity }}
      >
        <AnimatePresence mode="wait">
          {state === "connecting" && (
            <motion.div key="c" initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}>
              <Loader2 className="w-11 h-11 text-amber-400 animate-spin" />
            </motion.div>
          )}
          {state === "thinking" && (
            <motion.div key="t" initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}>
              <Loader2 className="w-11 h-11 text-violet-400 animate-spin" />
            </motion.div>
          )}
          {state === "muted" && (
            <motion.div key="m" initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}>
              <MicOff className="w-11 h-11 text-white/40" />
            </motion.div>
          )}
          {(state === "listening" || state === "idle") && (
            <motion.div key="l" initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}>
              <Mic className={cn("w-11 h-11", state === "listening" ? "text-[#e74c3c]" : "text-white/30")} />
            </motion.div>
          )}
          {state === "speaking" && (
            <motion.div key="s" initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}>
              <Waves className="w-11 h-11 text-[#e74c3c]" />
            </motion.div>
          )}
          {state === "error" && (
            <motion.div key="e" initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}>
              <PhoneOff className="w-11 h-11 text-red-500" />
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}

function StatusLine({ state, duration }: { state: VoiceState; duration: number }) {
  const label = (() => {
    if (state === "connecting") return "Connecting…";
    if (state === "listening") return "Listening";
    if (state === "thinking") return "Checking the knowledge base…";
    if (state === "speaking") return "AI Phil is speaking";
    if (state === "muted") return "Muted";
    if (state === "error") return "Connection lost";
    return "Paused";
  })();
  const color =
    state === "listening" ? "text-emerald-400" :
    state === "speaking" ? "text-[#e74c3c]" :
    state === "thinking" ? "text-violet-300" :
    state === "connecting" ? "text-amber-400" :
    state === "error" ? "text-red-400" :
    "text-white/50";

  return (
    <div className="flex flex-col items-center gap-1 mt-6">
      <motion.div
        className={cn("text-sm font-medium", color)}
        animate={{ opacity: state === "listening" || state === "speaking" || state === "thinking" ? [1, 0.7, 1] : 1 }}
        transition={{ duration: state === "thinking" ? 1.4 : 2, repeat: Infinity, ease: "easeInOut" }}
      >
        {label}
      </motion.div>
      <div className="font-mono text-[11px] text-white/35 tabular-nums">{formatTime(duration)}</div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Chat Stage
// ────────────────────────────────────────────────────────────────────────────

type Msg = { type: "user_message" | "assistant_message"; message?: { content?: string } };

const ChatStage = forwardRef<HTMLDivElement, { messages: Msg[]; state: VoiceState }>(
  function ChatStage({ messages, state }, ref) {
    return (
      <div ref={ref} className="flex-1 overflow-y-auto px-4 py-4 space-y-2.5 scrollbar-thin">
        {messages.length === 0 && (
          <div className="h-full flex items-center justify-center text-center text-white/40 text-sm px-6">
            {state === "connecting"
              ? "Hooking up…"
              : "Type or switch back to voice. AI Phil hears both."}
          </div>
        )}
        {messages.map((m, i) => {
          const isUser = m.type === "user_message";
          const content = m.message?.content?.trim();
          if (!content) return null;
          return (
            <motion.div
              key={i}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.18 }}
              className={cn("flex gap-2 items-end", isUser ? "justify-end" : "justify-start")}
            >
              {!isUser && <MiniAvatar />}
              <div
                className={cn(
                  "max-w-[78%] px-3.5 py-2 rounded-2xl text-sm leading-snug",
                  isUser
                    ? "bg-[#e74c3c] text-white rounded-br-sm shadow"
                    : "bg-white/5 text-white/90 border border-white/5 rounded-bl-sm"
                )}
              >
                {content}
              </div>
            </motion.div>
          );
        })}
      </div>
    );
  }
);

function MiniAvatar() {
  return (
    /* eslint-disable-next-line @next/next/no-img-element */
    <img
      src="/ai-phil-avatar.jpg"
      alt="AI Phil"
      className="w-6 h-6 rounded-full object-cover shrink-0 mb-0.5 ring-1 ring-white/10"
    />
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Transcript rail — last turn at a glance while in voice mode
// ────────────────────────────────────────────────────────────────────────────

function TranscriptRail({ messages, mode }: { messages: Msg[]; mode: Mode }) {
  const latest = messages[messages.length - 1];
  if (mode !== "voice" || !latest || !latest.message?.content) return null;
  const isUser = latest.type === "user_message";
  return (
    <div className="border-t border-white/5 px-5 py-3">
      <div className="flex items-baseline gap-2 text-[13px]">
        <span className={cn(
          "text-[10px] tracking-[0.12em] uppercase shrink-0 w-[38px]",
          isUser ? "text-white/40" : "text-[#fdd043]/80"
        )}>
          {isUser ? "You" : "Phil"}
        </span>
        <span className={cn("leading-snug line-clamp-2", isUser ? "text-white" : "text-white/70")}>
          {latest.message.content}
        </span>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Controls
// ────────────────────────────────────────────────────────────────────────────

function Controls({
  mode,
  state,
  chatInput,
  onChatInputChange,
  onChatSubmit,
  onMuteToggle,
  onEnd,
}: {
  mode: Mode;
  state: VoiceState;
  chatInput: string;
  onChatInputChange: (v: string) => void;
  onChatSubmit: () => void;
  onMuteToggle: () => void;
  onEnd: () => void;
}) {
  const canAct = state !== "connecting" && state !== "error" && state !== "idle";
  return (
    <div className="border-t border-white/5 bg-black/20 px-4 py-3">
      {mode === "voice" ? (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onMuteToggle}
            disabled={!canAct}
            className={cn(
              "flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-full text-sm font-medium transition",
              state === "muted"
                ? "bg-[#e74c3c]/15 text-[#e74c3c] hover:bg-[#e74c3c]/25"
                : "bg-[#e74c3c] text-white hover:bg-[#cf3a2e]",
              !canAct && "opacity-40 cursor-not-allowed"
            )}
          >
            {state === "muted" ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
            <span>{state === "muted" ? "Unmute" : "Mute"}</span>
          </button>
          <button
            type="button"
            onClick={onEnd}
            className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-full text-sm font-medium text-white/70 border border-white/10 hover:bg-white/5 hover:text-white transition"
          >
            <Phone className="w-4 h-4 rotate-[135deg]" />
            <span>End</span>
          </button>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onChatSubmit();
          }}
          className="flex items-center gap-2"
        >
          <input
            type="text"
            value={chatInput}
            onChange={(e) => onChatInputChange(e.target.value)}
            placeholder="Type your question…"
            disabled={!canAct}
            className={cn(
              "flex-1 rounded-full px-4 py-2.5 text-sm outline-none transition",
              "bg-white/5 border border-white/10 text-white placeholder:text-white/35",
              "focus:border-[#e74c3c]/50 focus:bg-white/10",
              !canAct && "opacity-40"
            )}
          />
          <button
            type="submit"
            disabled={!canAct || !chatInput.trim()}
            className="shrink-0 h-10 w-10 rounded-full bg-[#e74c3c] text-white hover:bg-[#cf3a2e] disabled:opacity-40 flex items-center justify-center transition"
          >
            <Send className="w-4 h-4" />
          </button>
        </form>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Loading / error states
// ────────────────────────────────────────────────────────────────────────────

function LoadingState() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-4">
      <Loader2 className="w-7 h-7 text-[#e74c3c] animate-spin" />
      <div className="text-sm text-white/60">Calling AI Phil…</div>
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="text-sm text-red-400">{message}</div>
      <button
        type="button"
        onClick={onRetry}
        className="px-4 py-2 rounded-full bg-[#e74c3c] text-white text-sm font-medium hover:bg-[#cf3a2e] transition"
      >
        Try again
      </button>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Ambient particles (subtle drift in backdrop)
// ────────────────────────────────────────────────────────────────────────────

function AmbientParticles() {
  const particles = useMemo(
    () =>
      Array.from({ length: 14 }, (_, i) => ({
        id: i,
        x: Math.random() * 100,
        y: Math.random() * 100,
        size: 1 + Math.random() * 2,
        delay: Math.random() * 6,
        duration: 8 + Math.random() * 6,
      })),
    []
  );
  return (
    <div aria-hidden className="absolute inset-0 pointer-events-none overflow-hidden">
      {particles.map((p) => (
        <motion.span
          key={p.id}
          className="absolute rounded-full bg-[#e74c3c]/15"
          style={{ left: `${p.x}%`, top: `${p.y}%`, width: p.size, height: p.size }}
          animate={{ y: [0, -20, 0], opacity: [0.12, 0.35, 0.12] }}
          transition={{ duration: p.duration, delay: p.delay, repeat: Infinity, ease: "easeInOut" }}
        />
      ))}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function useFftBars(fft: number[], n: number): number[] {
  const ref = useRef<number[]>(new Array(n).fill(0));
  if (!fft || fft.length === 0) return ref.current;
  const next: number[] = [];
  const chunk = Math.max(1, Math.floor(fft.length / n));
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = 0; j < chunk; j++) sum += fft[i * chunk + j] || 0;
    const avg = sum / chunk / 255;
    const prev = ref.current[i] ?? 0;
    next.push(prev * 0.55 + avg * 0.45);
  }
  ref.current = next;
  return next;
}

function formatTime(s: number): string {
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m.toString().padStart(2, "0")}:${r.toString().padStart(2, "0")}`;
}

function contextLabelFor(c: AccessTokenPayload["context"]): string {
  if (c === "new-member") return "Onboarding";
  if (c === "implementation") return "Implementation Coach";
  return "Discovery";
}
