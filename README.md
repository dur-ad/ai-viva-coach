# Voxy: AI Viva Coach

Voxy is an AI-powered mock oral examiner. Practise a job interview or an academic viva out loud, get instant spoken and written feedback from a local LLM, and have your eye contact and head pose tracked by your webcam. At the end of each session you get a score, a list of strengths and weak concepts, and a personalised 7-day study roadmap.

Everything runs locally: the LLM (Ollama), speech-to-text (Whisper), and face tracking (MediaPipe in the browser). No cloud API keys are needed.

## Features

- **Two exam formats**: Job Interview or Academic Viva, each at Beginner, Intermediate or Advanced difficulty.
- **Any subject**: type a topic, or upload a PDF of your notes and the examiner will question you strictly on that material.
- **Voice or text answers**: record your answer with the microphone (transcribed locally by Whisper) or just type it.
- **Spoken questions**: the examiner reads each question aloud using the browser's speech synthesis.
- **Per-answer feedback**: every reply includes 1–2 sentences evaluating your last answer, followed by exactly one new question.
- **Webcam confidence tracking**: MediaPipe Face Landmarker estimates a confidence score for each spoken answer from gaze and head movement.
- **Live attention alerts**: on-screen warnings such as "Please face the screen" and "Maintain eye contact", plus an eye-contact badge on the camera feed.
- **Performance report**: overall score out of 100, strengths, areas needing review, and a 7-day improvement roadmap.
- **Progress dashboard**: total sessions, average score, average confidence, days practised, common weak areas, and a score and confidence trend chart across sessions.

## How it works

```
┌──────────────────────────┐        ┌───────────────────────────┐
│  Next.js frontend :3000  │  HTTP  │   FastAPI backend :8000   │
│                          │ ─────▶ │                           │
│  • Dashboard / Setup /   │        │  /api/upload     PyPDF2   │
│    Exam UI               │        │  /api/transcribe Whisper  │
│  • MediaPipe face        │        │  /api/chat       ─┐       │
│    tracking (in browser) │        │  /api/summary    ─┤       │
│  • Web Speech synthesis  │        │  /api/history    SQLite   │
└──────────────────────────┘        └───────────────────┼───────┘
                                                        ▼
                                          Ollama :11434 (qwen2.5:7b)
```

1. **Setup**: choose subject, exam type and difficulty. Optionally upload a PDF; the backend extracts its text (first ~4,000 characters) and passes it to the examiner as context.
2. **Exam**: the LLM replies in a strict JSON shape (`feedback` + `next_question`). The backend applies guardrails so that feedback never contains a question and the first turn has no feedback.
3. **Answering**: when you record, the webcam analyser scores your confidence frame by frame, and the audio is transcribed by `faster-whisper` (`base` model, CPU, int8). The averaged confidence is attached to your answer.
4. **Report**: ending the exam sends the transcript to the LLM, which returns a score, strengths, weak concepts and a roadmap. The session is saved to a local SQLite database (`voxy.db`) and shown on the dashboard.

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 16, React 19, TypeScript, Tailwind CSS 4, Recharts |
| Vision | MediaPipe Tasks Vision (Face Landmarker), `react-webcam` |
| Backend | FastAPI, Pydantic, SQLite |
| LLM | [Ollama](https://ollama.com) running `qwen2.5:7b` |
| Speech-to-text | `faster-whisper` (`base` model) |
| PDF parsing | PyPDF2 |

## Project structure

```
ai-viva-coach/
├── backend/
│   ├── main.py              # FastAPI app: chat, summary, upload, transcribe, history
│   └── voxy.db              # SQLite database of past sessions
└── frontend/
    ├── app/
    │   ├── page.tsx         # App flow: dashboard → setup → exam → report
    │   ├── Dashboard.tsx    # Analytics and trend chart
    │   ├── WebcamAnalyzer.tsx  # MediaPipe face tracking, confidence + attention alerts
    │   ├── layout.tsx
    │   └── globals.css
    └── package.json
```

## Prerequisites

- **Node.js** 18.18 or newer (required by Next.js 16)
- **Python** 3.10 or newer
- **Ollama**, installed and running ([ollama.com/download](https://ollama.com/download))
- **FFmpeg** is recommended so Whisper can decode browser-recorded `.webm` audio
- A working **microphone** and **webcam**, and a modern browser (Chrome or Edge recommended for speech synthesis and MediaRecorder support)
- An internet connection on first load: the MediaPipe WASM files and face model are fetched from a CDN, and Whisper downloads its model on first run

## Getting started

### 1. Pull the language model

```bash
ollama pull qwen2.5:7b
ollama serve   # skip if Ollama is already running as a service
```

### 2. Start the backend

```bash
cd backend
python -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install fastapi "uvicorn[standard]" requests PyPDF2 faster-whisper python-multipart
uvicorn main:app --reload --port 8000
```

The first start downloads the Whisper `base` model, which can take a minute.

### 3. Start the frontend

```bash
cd frontend
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), allow microphone and camera access when prompted, and click **Start New Practice**.

## API reference

All endpoints are served from `http://localhost:8000`.

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/upload` | Upload a PDF (`multipart/form-data`, field `file`). Returns `{ extracted_text }`. |
| `POST` | `/api/chat` | Send `{ messages, document_context }`. Returns `{ response }`, a JSON string with `feedback` and `next_question`. |
| `POST` | `/api/transcribe` | Upload an audio blob (field `file`). Returns `{ text }`. |
| `POST` | `/api/summary` | Send `{ messages }`. Returns `{ summary }` with `overall_score`, `strengths`, `weak_concepts`, `feedback` and `roadmap`. Also saves the session. |
| `GET` | `/api/history` | Returns `{ sessions }`: past sessions with score, confidence, strengths and weaknesses. |

## Configuration

Settings are currently hard-coded and can be changed in the source:

| Setting | Location | Default |
|---|---|---|
| LLM model | `backend/main.py` | `qwen2.5:7b` |
| Ollama URL | `backend/main.py` | `http://localhost:11434` |
| Whisper model size | `backend/main.py` | `base` (CPU, int8) |
| PDF context limit | `backend/main.py` | 4,000 characters |
| Allowed CORS origin | `backend/main.py` | `http://localhost:3000` |
| Backend URL used by the UI | `frontend/app/*.tsx` | `http://localhost:8000` |
| Attention strike threshold | `frontend/app/WebcamAnalyzer.tsx` | 2 consecutive 1-second checks |

## Limitations and notes

- **Local only**: CORS and API URLs point at `localhost`, so the app needs adjusting before any deployment.
- **PDF input only**: notes must be text-based PDFs (scanned images won't extract), and only the first ~4,000 characters are used.
- **Single-user data**: sessions are stored in a local SQLite file with no authentication or per-user separation.
- **Confidence score is a heuristic**: it is derived from gaze direction and head movement, and is an estimate rather than a measure of answer quality.
- **LLM quality varies**: scoring and feedback come from a 7B local model and may be inconsistent. The backend includes guardrails, but results aren't a substitute for a real examiner.
- **Privacy**: webcam video is analysed in the browser and is not sent to the backend. Only your transcribed text and confidence score are stored.

## Roadmap ideas

- Add a `requirements.txt` and environment-variable configuration
- Support more document types (DOCX, slides) and OCR for scanned notes
- Per-user accounts and session history
- Streaming LLM responses for lower latency
- Exportable PDF reports

## License

No license has been specified yet. Add one (for example MIT) before sharing or accepting contributions.
