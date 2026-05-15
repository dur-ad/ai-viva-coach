"use client";

import React, { useEffect, useState } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts";

interface Session {
  id: number;
  date: string;
  score: number;
  confidence: number;
  strengths: string[];
  weaknesses: string[];
}

interface DashboardProps {
  onStartExam: () => void;
}

export default function Dashboard({ onStartExam }: DashboardProps) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    fetch("http://localhost:8000/api/history")
      .then((res) => res.json())
      .then((data) => {
        if (data.sessions) setSessions(data.sessions);
        setIsLoading(false);
      })
      .catch((err) => {
        console.error("Failed to fetch history", err);
        setIsLoading(false);
      });
  }, []);

  // --- ANALYTICS CALCULATIONS ---
  const averageScore = sessions.length > 0 ? Math.round(sessions.reduce((acc, curr) => acc + curr.score, 0) / sessions.length) : 0;
  const averageConfidence = sessions.length > 0 ? Math.round(sessions.reduce((acc, curr) => acc + curr.confidence, 0) / sessions.length) : 0;
  
  // Calculate unique days practiced (Streak)
  const uniqueDays = new Set(sessions.map(s => s.date.split(" ")[0])).size;

  // Extract Most Common Mistakes (flatten weaknesses and get unique ones)
  const allWeaknesses = sessions.flatMap(s => s.weaknesses).filter(w => w.trim() !== "");
  const commonMistakes = Array.from(new Set(allWeaknesses)).slice(0, 4); // Take top 4 distinct mistakes

  // Prepare data for Recharts (reverse to show chronological order left-to-right)
  const chartData = [...sessions].reverse().map((s, index) => ({
    name: `Session ${index + 1}`,
    Score: s.score,
    Confidence: s.confidence,
    date: s.date.split(" ")[0]
  }));

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8 animate-fade-in">
      <div className="mb-8 overflow-hidden rounded-3xl border border-indigo-100 bg-gradient-to-r from-indigo-600 via-violet-600 to-fuchsia-600 p-6 text-white shadow-lg sm:p-8">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-indigo-100">Voxy Performance Hub</p>
            <h1 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">Student Analytics</h1>
            <p className="mt-2 max-w-xl text-sm text-indigo-100 sm:text-base">
              Review your score and confidence trends, then launch your next focused practice session.
            </p>
          </div>
          <button
            onClick={onStartExam}
            className="inline-flex items-center justify-center gap-2 rounded-2xl bg-white/95 px-6 py-3 text-sm font-semibold text-indigo-700 shadow-sm transition hover:bg-white"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5">
              <path fillRule="evenodd" d="M4.5 5.653c0-1.426 1.529-2.33 2.779-1.643l11.54 6.348c1.295.712 1.295 2.573 0 3.285L7.28 19.991c-1.25.687-2.779-.217-2.779-1.643V5.653z" clipRule="evenodd" />
            </svg>
            Start New Practice
          </button>
        </div>
      </div>

      <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.15em] text-slate-500">Total Sessions</p>
          <p className="mt-3 text-3xl font-extrabold text-slate-800">{sessions.length}</p>
        </div>
        <div className="rounded-2xl border border-emerald-100 bg-gradient-to-br from-emerald-50 to-white p-5 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.15em] text-emerald-700">Avg Exam Score</p>
          <p className="mt-3 text-3xl font-extrabold text-emerald-600">{averageScore}%</p>
        </div>
        <div className="rounded-2xl border border-amber-100 bg-gradient-to-br from-amber-50 to-white p-5 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.15em] text-amber-700">Avg AI Confidence</p>
          <p className="mt-3 text-3xl font-extrabold text-amber-500">{averageConfidence}%</p>
          <p className="mt-2 text-xs font-medium text-amber-700">Webcam-powered posture and eye-contact signal</p>
        </div>
        <div className="rounded-2xl border border-rose-100 bg-gradient-to-br from-rose-50 to-white p-5 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.15em] text-rose-700">Practice Streak</p>
          <p className="mt-3 text-3xl font-extrabold text-rose-500">{uniqueDays} days</p>
        </div>
      </div>

      {isLoading ? (
        <div className="rounded-2xl border border-slate-200 bg-white py-16 text-center text-slate-500 shadow-sm animate-pulse">
          Loading your analytics...
        </div>
      ) : sessions.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-indigo-200 bg-gradient-to-b from-indigo-50 to-white p-12 text-center shadow-sm">
          <p className="text-lg font-semibold text-slate-800">No practice sessions yet</p>
          <p className="mt-2 text-slate-500">Start your first session to unlock trend analytics and confidence tracking.</p>
          <button
            onClick={onStartExam}
            className="mt-6 rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-700"
          >
            Start First Practice
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
          <div className="xl:col-span-2 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="mb-5 flex items-start justify-between">
              <div>
                <h2 className="text-lg font-bold text-slate-800">Performance Trend</h2>
                <p className="mt-1 text-sm text-slate-500">Score and confidence progression across sessions</p>
              </div>
            </div>
            <div className="h-80 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 8, right: 14, bottom: 8, left: -8 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                  <XAxis dataKey="name" stroke="#64748b" fontSize={12} tickLine={false} axisLine={false} />
                  <YAxis yAxisId="left" stroke="#64748b" fontSize={12} tickLine={false} axisLine={false} domain={[0, 100]} />
                  <YAxis yAxisId="right" orientation="right" stroke="#64748b" fontSize={12} tickLine={false} axisLine={false} domain={[0, 100]} />
                  <Tooltip contentStyle={{ borderRadius: "12px", border: "1px solid #e2e8f0", boxShadow: "0 8px 24px rgb(15 23 42 / 0.10)" }} />
                  <Legend iconType="circle" wrapperStyle={{ paddingTop: "16px" }} />
                  <Line yAxisId="left" type="monotone" dataKey="Score" stroke="#10b981" strokeWidth={3} dot={{ r: 4 }} activeDot={{ r: 6 }} name="Knowledge Score %" />
                  <Line yAxisId="right" type="monotone" dataKey="Confidence" stroke="#f59e0b" strokeWidth={3} dot={{ r: 4 }} activeDot={{ r: 6 }} name="Webcam Confidence %" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="space-y-6">
            <div className="rounded-2xl border border-rose-100 bg-gradient-to-b from-rose-50 to-white p-6 shadow-sm">
              <h2 className="mb-4 text-lg font-bold text-rose-900">Frequent Mistakes</h2>
              <ul className="space-y-2.5">
                {commonMistakes.length > 0 ? (
                  commonMistakes.map((mistake, i) => (
                    <li key={i} className="rounded-lg border border-rose-100 bg-white px-3 py-2 text-sm text-rose-800">
                      {mistake}
                    </li>
                  ))
                ) : (
                  <li className="rounded-lg border border-emerald-100 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
                    Great consistency so far. No repeated weak concepts detected.
                  </li>
                )}
              </ul>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <h2 className="mb-4 text-lg font-bold text-slate-800">Recent Sessions</h2>
              <div className="max-h-72 space-y-3 overflow-y-auto pr-1">
                {sessions.slice(0, 6).map((session) => (
                  <div key={session.id} className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                    <div>
                      <p className="text-sm font-semibold text-slate-800">{session.date}</p>
                      <p className="text-xs text-slate-500">Session #{session.id}</p>
                    </div>
                    <div className="flex gap-4 text-right">
                      <div>
                        <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Score</p>
                        <p className="text-sm font-black text-emerald-600">{session.score}%</p>
                      </div>
                      <div>
                        <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Conf</p>
                        <p className="text-sm font-black text-amber-500">{session.confidence}%</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}