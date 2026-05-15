"use client";
import { useState, useRef, useCallback } from "react";
import WebcamAnalyzer, { WebcamAnalyzerRef, AttentionStatus } from "./WebcamAnalyzer";
import Dashboard from "./Dashboard";

interface Message {
  role: "user" | "assistant";
  content: string;
  feedback?: string;
  confidence?: number;
}

interface SummaryData {
  overall_score: number;
  strengths: string[];
  weak_concepts: string[];
  roadmap: string[];
}

export default function Home() {
  const [appState, setAppState] = useState<"dashboard" | "setup" | "exam">("dashboard");
  const [examSettings, setExamSettings] = useState({
    subject: "Computer Science",
    type: "Mock Interview",
    difficulty: "Intermediate",
  });

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [documentContext, setDocumentContext] = useState<string>("");
  const [uploadStatus, setUploadStatus] = useState<string>("");
  const [summary, setSummary] = useState<SummaryData | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<BlobPart[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [useWebcam, setUseWebcam] = useState(true);
  const webcamAnalyzerRef = useRef<WebcamAnalyzerRef>(null);

  // ── Attention alert state ────────────────────────────────────────────────
  const [attentionStatus, setAttentionStatus] = useState<AttentionStatus>({
    lookingAway: false,
    noEyeContact: false,
  });

  // Stable callback so WebcamAnalyzer doesn't re-render on every parent render
  const handleAttentionChange = useCallback((status: AttentionStatus) => {
    setAttentionStatus(status);
  }, []);

  // Derive the single most relevant alert message
  const alertMessage = attentionStatus.lookingAway
    ? "Please face the screen"
    : attentionStatus.noEyeContact
    ? "Maintain eye contact"
    : null;

  // --- Speech Synthesis Helper ---
  const speakText = (text: string) => {
    if (!("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 0.95;
    utterance.pitch = 1.0;
    const voices = window.speechSynthesis.getVoices();
    const englishVoice = voices.find((v) => v.lang.includes("en") && v.name.includes("Female"));
    if (englishVoice) utterance.voice = englishVoice;
    window.speechSynthesis.speak(utterance);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadStatus("Extracting notes...");
    const formData = new FormData();
    formData.append("file", file);
    try {
      const res = await fetch("http://localhost:8000/api/upload", { method: "POST", body: formData });
      const data = await res.json();
      if (data.extracted_text) {
        setDocumentContext(data.extracted_text);
        setUploadStatus(`Success! Loaded ${file.name}`);
      } else {
        setUploadStatus("Error extracting text.");
      }
    } catch {
      setUploadStatus("Upload failed.");
    }
  };

  const startExam = async () => {
    setIsLoading(true);
    setSummary(null);
    setAppState("exam");
    try {
      const startMessage = documentContext
        ? `Hello, I have uploaded my notes. I am ready for my ${examSettings.difficulty} level ${examSettings.type} on the subject of ${examSettings.subject}. Please ask me the first question based on the material.`
        : `Hello, I am ready to start my ${examSettings.difficulty} level ${examSettings.type} on the subject of ${examSettings.subject}. Please ask me the first question.`;

      const res = await fetch("http://localhost:8000/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: startMessage }], document_context: documentContext }),
      });
      const data = await res.json();
      const aiData = JSON.parse(data.response);
      setMessages([{ role: "assistant", content: aiData.next_question, feedback: aiData.feedback }]);
      speakText(aiData.next_question);
    } catch (error) {
      console.error("Error starting exam:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const sendMessage = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!input.trim()) return;

    const hiddenConfInput = document.getElementById("hiddenConfidence") as HTMLInputElement;
    let confidenceScore: number | undefined;
    if (hiddenConfInput?.value) {
      const parsed = parseInt(hiddenConfInput.value);
      if (!isNaN(parsed)) confidenceScore = parsed;
      hiddenConfInput.value = "";
    }

    const userMsg: Message = { role: "user", content: input, confidence: confidenceScore };
    const newHistory = [...messages, userMsg];
    setMessages(newHistory);
    setInput("");
    setIsLoading(true);
    try {
      const res = await fetch("http://localhost:8000/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: newHistory.map((m) => ({
            role: m.role,
            content:
              m.role === "assistant"
                ? JSON.stringify({ feedback: m.feedback, next_question: m.content })
                : m.content,
          })),
          document_context: documentContext,
        }),
      });
      const data = await res.json();
      const aiData = JSON.parse(data.response);
      setMessages([...newHistory, { role: "assistant", content: aiData.next_question, feedback: aiData.feedback }]);
      speakText(aiData.next_question);
    } catch (error) {
      console.error("Error sending message:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const endExam = async () => {
    if (messages.length < 2) return;
    setIsLoading(true);
    speakText("Exam complete. Generating your feedback report now.");
    try {
      const res = await fetch("http://localhost:8000/api/summary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages }),
      });
      const data = await res.json();
      if (data.summary) {
        const parsedSummary = typeof data.summary === "string" ? JSON.parse(data.summary) : data.summary;
        setSummary(parsedSummary);
      } else {
        console.error("Backend missed the 'summary' key:", data);
        alert("The AI failed to format your exam summary. Check the console!");
      }
    } catch (error) {
      console.error("Error generating summary:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];
      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) audioChunksRef.current.push(event.data);
      };
      mediaRecorder.onstop = async () => {
        const finalConfidence = webcamAnalyzerRef.current?.stopTracking() || 100;
        const audioBlob = new Blob(audioChunksRef.current);
        await transcribeAudio(audioBlob, finalConfidence);
      };
      if (useWebcam) webcamAnalyzerRef.current?.startTracking();
      mediaRecorder.start();
      setIsRecording(true);
    } catch {
      alert("Could not access the microphone.");
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      mediaRecorderRef.current.stream.getTracks().forEach((t) => t.stop());
    }
  };

  const toggleRecording = () => (isRecording ? stopRecording() : startRecording());

  const transcribeAudio = async (audioBlob: Blob, confidence: number) => {
    setIsLoading(true);
    const formData = new FormData();
    formData.append("file", audioBlob);
    try {
      const res = await fetch("http://localhost:8000/api/transcribe", { method: "POST", body: formData });
      const data = await res.json();
      if (data.text) {
        setInput(data.text);
        (document.getElementById("hiddenConfidence") as HTMLInputElement).value = confidence.toString();
      }
    } catch (error) {
      console.error("Error transcribing audio:", error);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <main className="flex h-screen flex-col bg-slate-50 font-sans text-slate-800">
      {/* ─── Header ─────────────────────────────────────────────────────────── */}
      <header className="shrink-0 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex w-full max-w-7xl items-center justify-between px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-600 to-violet-600 text-lg font-bold text-white">V</div>
            <div>
              <h1 className="text-xl font-bold tracking-tight text-slate-900">Voxy</h1>
              <p className="text-xs text-slate-500">AI mock oral coach</p>
            </div>
          </div>
          {appState === "exam" && !summary && (
            <div className="flex items-center gap-3">
              <button
                onClick={() => { setAppState("dashboard"); setMessages([]); }}
                className="rounded-lg px-3 py-2 text-sm font-semibold text-slate-500 transition hover:bg-slate-100 hover:text-rose-600"
              >
                Abort
              </button>
              <button
                onClick={endExam}
                className="inline-flex items-center gap-1 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-700"
              >
                End & Get Score
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="h-4 w-4">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5 21 12m0 0-7.5 7.5M21 12H3" />
                </svg>
              </button>
            </div>
          )}
        </div>
      </header>

      {/* ─── Dashboard ───────────────────────────────────────────────────────── */}
      {appState === "dashboard" ? (
        <div className="flex-1 overflow-y-auto">
          <Dashboard onStartExam={() => setAppState("setup")} />
        </div>

      /* ─── Setup ──────────────────────────────────────────────────────────── */
      ) : appState === "setup" ? (
        <div className="flex flex-1 items-center justify-center p-4 sm:p-6">
          <div className="grid w-full max-w-4xl gap-5 lg:grid-cols-[1.25fr_0.9fr]">
            <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-indigo-600">Session Setup</p>
              <h2 className="mt-2 text-2xl font-bold text-slate-900 sm:text-3xl">Configure Your Exam</h2>
              <p className="mt-2 text-sm text-slate-500">Pick your topic and format. You can also upload notes to steer the examiner.</p>

              <div className="mt-6 space-y-5">
                <div>
                  <label className="mb-1 block text-sm font-semibold text-slate-700">Subject / Topic</label>
                  <input
                    type="text"
                    value={examSettings.subject}
                    onChange={(e) => setExamSettings({ ...examSettings, subject: e.target.value })}
                    placeholder="e.g., Data Structures, Biology"
                    className="w-full rounded-xl border border-slate-300 px-4 py-3 text-sm outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-200"
                  />
                </div>

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-sm font-semibold text-slate-700">Exam Type</label>
                    <select
                      value={examSettings.type}
                      onChange={(e) => setExamSettings({ ...examSettings, type: e.target.value })}
                      className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-200"
                    >
                      <option value="Mock Interview">Job Interview</option>
                      <option value="Academic Viva">Academic Viva</option>
                    </select>
                  </div>
                  <div>
                    <label className="mb-1 block text-sm font-semibold text-slate-700">Difficulty</label>
                    <select
                      value={examSettings.difficulty}
                      onChange={(e) => setExamSettings({ ...examSettings, difficulty: e.target.value })}
                      className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-200"
                    >
                      <option value="Beginner">Beginner</option>
                      <option value="Intermediate">Intermediate</option>
                      <option value="Advanced">Advanced</option>
                    </select>
                  </div>
                </div>

                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <label className="mb-2 block text-sm font-semibold text-slate-700">Study Material (Optional)</label>
                  <input type="file" accept="application/pdf" ref={fileInputRef} onChange={handleFileUpload} className="hidden" />
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className={`w-full rounded-xl border-2 border-dashed px-4 py-3 text-sm font-semibold transition ${
                      documentContext
                        ? "border-emerald-400 bg-emerald-50 text-emerald-700"
                        : "border-slate-300 bg-white text-slate-600 hover:border-indigo-400 hover:text-indigo-700"
                    }`}
                  >
                    {documentContext ? "Notes Loaded Successfully" : "Upload PDF Notes"}
                  </button>
                  {uploadStatus && <p className="mt-2 text-xs font-medium text-indigo-600">{uploadStatus}</p>}
                </div>

                <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3">
                  <input
                    type="checkbox"
                    checked={useWebcam}
                    onChange={(e) => setUseWebcam(e.target.checked)}
                    id="webcamToggle"
                    className="h-4 w-4 rounded text-indigo-600"
                  />
                  <label htmlFor="webcamToggle" className="cursor-pointer text-sm font-medium text-slate-700">
                    Enable Webcam Confidence Tracking
                  </label>
                </div>
              </div>

              <div className="mt-8 flex gap-3">
                <button
                  onClick={() => setAppState("dashboard")}
                  className="flex-1 rounded-xl bg-slate-100 px-4 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-200"
                >
                  Cancel
                </button>
                <button
                  onClick={startExam}
                  className="flex-1 rounded-xl bg-gradient-to-r from-indigo-600 to-violet-600 px-4 py-3 text-sm font-semibold text-white shadow-sm transition hover:opacity-95"
                >
                  Start Session
                </button>
              </div>
            </div>

            <div className="rounded-3xl border border-indigo-100 bg-gradient-to-b from-indigo-600 to-violet-600 p-6 text-white shadow-sm sm:p-7">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-indigo-100">Live Preview</p>
              <h3 className="mt-2 text-xl font-bold">Your next exam</h3>
              <div className="mt-5 space-y-4 text-sm">
                <div className="rounded-xl bg-white/10 p-3">
                  <p className="text-indigo-100">Subject</p>
                  <p className="mt-1 font-semibold">{examSettings.subject || "Not set"}</p>
                </div>
                <div className="rounded-xl bg-white/10 p-3">
                  <p className="text-indigo-100">Format</p>
                  <p className="mt-1 font-semibold">{examSettings.type} • {examSettings.difficulty}</p>
                </div>
                <div className="rounded-xl bg-white/10 p-3">
                  <p className="text-indigo-100">Material</p>
                  <p className="mt-1 font-semibold">{documentContext ? "PDF notes loaded" : "General knowledge mode"}</p>
                </div>
                <div className="rounded-xl bg-white/10 p-3">
                  <p className="text-indigo-100">Camera AI</p>
                  <p className="mt-1 font-semibold">{useWebcam ? "Enabled" : "Disabled"}</p>
                </div>
              </div>
            </div>
          </div>
        </div>

      /* ─── Exam ───────────────────────────────────────────────────────────── */
      ) : (
        <>
          {summary ? (
            /* ── Summary Report ── */
            <div className="flex-1 overflow-y-auto px-4 py-8 sm:px-6 lg:px-8">
              <div className="mx-auto max-w-6xl space-y-6">
                <div className="overflow-hidden rounded-3xl border border-indigo-100 bg-gradient-to-r from-indigo-600 via-violet-600 to-fuchsia-600 p-8 text-white shadow-lg">
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-indigo-100">Session Complete</p>
                  <div className="mt-2 flex flex-col gap-6 md:flex-row md:items-center md:justify-between">
                    <div>
                      <h2 className="text-3xl font-bold">Performance Report</h2>
                      <p className="mt-2 text-sm text-indigo-100">Review your strengths and target the key concepts that need reinforcement.</p>
                    </div>
                    <div className="rounded-2xl bg-white/95 px-8 py-5 text-center text-slate-900">
                      <p className="text-xs font-semibold uppercase tracking-[0.15em] text-slate-500">Overall Score</p>
                      <p className="mt-1 text-5xl font-black">{summary.overall_score}</p>
                      <p className="text-sm text-slate-500">out of 100</p>
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
                  <div className="rounded-2xl border border-emerald-100 bg-white p-6 shadow-sm">
                    <h3 className="mb-3 text-lg font-bold text-emerald-700">Strengths</h3>
                    <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">
                      {summary.strengths.map((s, i) => <li key={i}>{s}</li>)}
                    </ul>
                  </div>
                  <div className="rounded-2xl border border-rose-100 bg-white p-6 shadow-sm">
                    <h3 className="mb-3 text-lg font-bold text-rose-700">Needs Review</h3>
                    <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">
                      {summary.weak_concepts.map((w, i) => <li key={i}>{w}</li>)}
                    </ul>
                  </div>
                </div>

                {summary.roadmap?.length > 0 && (
                  <div className="rounded-2xl border border-indigo-100 bg-white p-6 shadow-sm">
                    <h3 className="mb-4 text-xl font-bold text-indigo-900">Personalized 7-Day Improvement Roadmap</h3>
                    <div className="grid gap-3">
                      {summary.roadmap.map((dayPlan, idx) => {
                        const s = String(dayPlan);
                        const parts = s.split(":");
                        const dayLabel = parts[0].includes("Day") ? parts[0] : `Day ${idx + 1}`;
                        const task = parts.length > 1 ? parts.slice(1).join(":").trim() : s;
                        return (
                          <div key={idx} className="flex items-start gap-4 rounded-xl border border-indigo-100 bg-indigo-50/50 p-4">
                            <div className="mt-0.5 shrink-0 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-bold text-white">{dayLabel}</div>
                            <div className="text-sm font-medium text-slate-700">{task}</div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                <div className="flex flex-wrap justify-center gap-3 pt-2">
                  <button
                    onClick={() => { setAppState("dashboard"); setSummary(null); setMessages([]); }}
                    className="rounded-xl bg-slate-800 px-6 py-3 text-sm font-semibold text-white transition hover:bg-slate-700"
                  >
                    Return to Dashboard
                  </button>
                  <button
                    onClick={() => { setMessages([]); setSummary(null); }}
                    className="rounded-xl bg-indigo-600 px-6 py-3 text-sm font-semibold text-white transition hover:bg-indigo-700"
                  >
                    Start New Session
                  </button>
                </div>
              </div>
            </div>
          ) : (
            /* ── Active Exam ── */
            <div className="flex flex-1 flex-col px-4 py-4 sm:px-6 lg:px-8">
              <div className="mx-auto flex w-full max-w-7xl flex-1 overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">

                {/* Chat panel */}
                <div className="relative flex-1 overflow-y-auto p-5 sm:p-6">
                  {messages.length === 0 ? (
                    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-white/90 text-slate-500">
                      <div className="mb-4 h-12 w-12 rounded-full border-4 border-indigo-100 border-t-indigo-600 animate-spin" />
                      <p className="font-semibold text-indigo-900">Preparing your {examSettings.type}...</p>
                      <p className="mt-1 text-sm">The examiner is reviewing your setup.</p>
                    </div>
                  ) : (
                    <div className="space-y-5">
                      {messages.map((msg, idx) => (
                        <div key={idx} className={`flex flex-col ${msg.role === "user" ? "items-end" : "items-start"}`}>
                          {msg.role === "assistant" && msg.feedback && (
                            <div className="mb-2 max-w-[85%] rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                              <span className="font-bold">Feedback: </span>{msg.feedback}
                            </div>
                          )}
                          <div className={`relative max-w-[85%] rounded-2xl px-4 py-3 text-sm shadow-sm ${
                            msg.role === "user"
                              ? "rounded-br-md bg-gradient-to-r from-indigo-600 to-violet-600 text-white"
                              : "rounded-bl-md border border-slate-200 bg-slate-50 text-slate-800"
                          }`}>
                            {msg.content}
                            {msg.role === "user" && msg.confidence !== undefined && !isNaN(msg.confidence) && (
                              <div className="absolute -left-2 -top-2 rounded-full border border-indigo-200 bg-white px-2 py-0.5 text-[10px] font-bold text-indigo-700">
                                {msg.confidence}% Conf.
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                      {isLoading && (
                        <div className="flex items-start">
                          <div className="rounded-xl border border-slate-200 bg-slate-100 px-4 py-3 text-sm text-slate-500 animate-pulse">
                            Processing...
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* ── Webcam sidebar ──────────────────────────────────────────── */}
                {messages.length > 0 && useWebcam && (
                  <div className="hidden w-80 shrink-0 border-l border-slate-200 bg-slate-50 p-4 lg:flex lg:flex-col lg:gap-4">

                    {/* Camera feed with live alert overlay */}
                    <div className="relative rounded-2xl overflow-hidden border-2 border-slate-200">
                      <WebcamAnalyzer
                        ref={webcamAnalyzerRef}
                        onAttentionChange={handleAttentionChange}
                      />

                      {/* ── Live Attention Overlay ── */}
                      {alertMessage && (
                        <div className="absolute inset-0 z-20 flex items-end justify-center pb-3 pointer-events-none">
                          <div
                            className="
                              flex items-center gap-2
                              bg-red-600/90 backdrop-blur-sm
                              text-white px-4 py-2 rounded-full shadow-xl
                              animate-pulse
                            "
                          >
                            {/* Pinging dot */}
                            <span className="relative flex h-2.5 w-2.5 shrink-0">
                              <span className="absolute inline-flex h-full w-full rounded-full bg-white opacity-75 animate-ping" />
                              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-white" />
                            </span>
                            <span className="text-xs font-bold uppercase tracking-wider">
                              {alertMessage}
                            </span>
                          </div>
                        </div>
                      )}

                      {/* ── Eye Contact Badge (top-right corner of camera) ── */}
                      <div className="absolute top-2 left-2 z-20">
                        <div className={`
                          px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider
                          transition-colors duration-500 shadow
                          ${attentionStatus.noEyeContact
                            ? "bg-slate-800/70 text-slate-300"
                            : "bg-emerald-500/80 text-white"}
                        `}>
                          {attentionStatus.noEyeContact ? "○ No Eye Contact" : "● Eye Contact"}
                        </div>
                      </div>
                    </div>

                    {/* Judge notes card */}
                    <div className="rounded-xl border border-slate-200 bg-white p-4">
                      <h4 className="mb-1 text-sm font-bold text-slate-800">Judge Notes</h4>
                      <p className="text-xs text-slate-600">
                        The AI proctor watches your posture, head orientation, and eye contact to estimate confidence.
                        Look straight at the camera and speak clearly for the best score.
                      </p>
                    </div>
                  </div>
                )}
              </div>

              {/* ── Input bar ───────────────────────────────────────────────── */}
              <div className="mx-auto mt-4 flex w-full max-w-7xl items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
                <input type="hidden" id="hiddenConfidence" />
                <input
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && sendMessage()}
                  placeholder={isRecording ? "Listening carefully..." : "Type your answer or speak..."}
                  disabled={isRecording}
                  className={`flex-1 bg-transparent px-2 py-2 text-sm text-slate-700 outline-none ${
                    isRecording ? "font-medium opacity-60 placeholder-red-400" : ""
                  }`}
                />

                <div className="relative flex h-12 w-12 shrink-0 items-center justify-center">
                  {isRecording && <span className="absolute inset-0 animate-ping rounded-full border-2 border-red-500 opacity-60" />}
                  <button
                    onClick={toggleRecording}
                    className={`relative z-10 rounded-full p-3 transition ${
                      isRecording
                        ? "bg-red-500 text-white hover:bg-red-600"
                        : "bg-slate-100 text-slate-600 hover:bg-slate-200 hover:text-indigo-600"
                    }`}
                    title={isRecording ? "Stop Recording" : "Use Microphone"}
                  >
                    {isRecording ? (
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5">
                        <path fillRule="evenodd" d="M4.5 7.5a3 3 0 013-3h9a3 3 0 013 3v9a3 3 0 01-3 3h-9a3 3 0 01-3-3v-9z" clipRule="evenodd" />
                      </svg>
                    ) : (
                      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="h-5 w-5">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
                      </svg>
                    )}
                  </button>
                </div>

                <button
                  onClick={sendMessage}
                  disabled={isRecording || !input.trim()}
                  className="shrink-0 rounded-xl bg-indigo-600 p-3 text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5">
                    <path d="M3.478 2.405a.75.75 0 00-.926.94l2.432 7.905H13.5a.75.75 0 010 1.5H4.984l-2.432 7.905a.75.75 0 00.926.94 60.519 60.519 0 0018.445-8.986.75.75 0 000-1.218A60.517 60.517 0 003.478 2.405z" />
                  </svg>
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </main>
  );
}