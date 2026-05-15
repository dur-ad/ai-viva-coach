from fastapi import FastAPI, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import requests
import PyPDF2
import io
import json
from faster_whisper import WhisperModel
import tempfile
import os
import sqlite3
from datetime import datetime
from typing import List, Optional

app = FastAPI()

# --- DATABASE SETUP ---
def init_db():
    conn = sqlite3.connect('voxy.db')
    c = conn.cursor()
    c.execute('''CREATE TABLE IF NOT EXISTS sessions
                 (id INTEGER PRIMARY KEY AUTOINCREMENT, 
                  date TEXT, 
                  score INTEGER, 
                  confidence INTEGER,
                  strengths TEXT, 
                  weaknesses TEXT)''')
    conn.commit()
    conn.close()

# Run it once when the server starts
init_db()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class Message(BaseModel):
    role: str
    content: Optional[str] = ""
    confidence: Optional[int] = None
    feedback: Optional[str] = None

class ChatRequest(BaseModel):
    messages: list[Message]
    document_context: str = ""  # New field for the uploaded PDF text

# We make the system prompt dynamic by using a function
def get_system_prompt(document_context: str) -> str:
    base_prompt = """You are a strict academic oral examiner evaluating a student.
Your goal is to evaluate the student's answer and then ask a relevant follow-up question.
CRITICAL RULES:
1. The "feedback" field must be [1-2 sentences] evaluating the student's previous answer. 
   It must NEVER contain a question, request, or instruction. If you ask a question in "feedback", the exam will break.
2. ALL new questions MUST go in the "next_question" field.
3. NEVER repeat a question. If the student answers incorrectly, include the correct information in "feedback" and immediately move to a completely new, unrelated concept from the material.
4. If the student says "I don't know" or similar, provide the correct answer in "feedback" briefly, then ask a fresh question.
5. Keep the tone strict but fair.

CRITICAL INSTRUCTION: You MUST structure every single response exactly like this:

Feedback: [Write 1-2 sentences evaluating their correctness, clarity, and conceptual understanding. Do not give away the full answer immediately.]
Question: [Ask EXACTLY ONE new question. It can be a follow-up, or moving to the next topic.]

NEVER send a response that does not include the "Question:" section. If you do not ask a question, the exam breaks.

EXAMPLE 1 (Start of Exam with Notes):
Student: "Hello, I have uploaded my notes. Please ask me the first question based on the material."
Examiner: {
  "next_question": "Let's begin. What is the primary concept discussed in the first section of your notes?",
  "feedback": ""
}

EXAMPLE 2 (Start of General Exam):
Student: "Hello, I am ready to start my general oral exam. Please ask me the first question."
Examiner: {
  "next_question": "Let's begin. Can you explain the fundamental principles of your field of study?",
  "feedback": ""
}

EXAMPLE 3 (Middle of Exam):
Student: "Git is a version control system."
Examiner: {
  "next_question": "How do you initialize a new repository?",
  "feedback": "Correct. Git is a distributed version control system used for tracking changes."
}
"""

    if document_context:
        base_prompt += f"""
RULES 4: Base your questions STRICTLY on this material:
{document_context}
"""

    base_prompt += """
You MUST respond STRICTLY in JSON format. Do not include Markdown blocks.
"""
    return base_prompt

@app.post("/api/upload")
async def upload_document(file: UploadFile = File(...)):
    try:
        # Read the PDF file directly from memory
        content = await file.read()
        pdf_reader = PyPDF2.PdfReader(io.BytesIO(content))
        
        extracted_text = ""
        for page in pdf_reader.pages:
            extracted_text += page.extract_text() + "\n"
            
        # Truncate text to ~4000 characters to avoid overwhelming the local LLM memory limits
        extracted_text = extracted_text[:4000]
        
        return {"extracted_text": extracted_text}
    except Exception as e:
        return {"error": str(e)}

@app.post("/api/chat")
def chat_with_ai(request: ChatRequest):
    system_prompt = get_system_prompt(request.document_context)
    ollama_messages = [{"role": "system", "content": system_prompt}]
    
    for msg in request.messages:
        ollama_messages.append({"role": msg.role, "content": msg.content})

    ollama_url = "http://localhost:11434/api/chat"
    payload = {
        "model": "qwen2.5:7b",
        "messages": ollama_messages,
        "stream": False,
        "format": "json"
    }
    
    response = requests.post(ollama_url, json=payload)
    if response.status_code == 200:
        ai_message_text = response.json().get("message", {}).get("content", "")
        
        # --- BULLETPROOF HACKATHON GUARDRAILS ---
        try:
            ai_data = json.loads(ai_message_text)
            
            # Guardrail 1: If it's the very first message, force feedback to be empty
            if len(request.messages) <= 1:
                ai_data["feedback"] = ""
                
            # Guardrail 2: Aggressively strip any accidental questions from the feedback string
            feedback_str = ai_data.get("feedback", "")
            if feedback_str:
                # 1. Chop off text if it tries to ask a question without a question mark
                sneaky_phrases = ["Can you", "Could you", "How would", "What is", "Why do", "Now,", "Please explain"]
                for phrase in sneaky_phrases:
                    if phrase in feedback_str:
                        # Slice the string to keep only everything BEFORE the sneaky phrase
                        feedback_str = feedback_str.split(phrase)[0]
                
                # 2. Original question mark filter (just in case)
                if "?" in feedback_str:
                    sentences = [s for s in feedback_str.split("?") if len(s.strip()) > 0 and not s.strip().endswith("?")]
                    feedback_str = "".join(sentences)

                ai_data["feedback"] = feedback_str.strip()

            return {"response": json.dumps(ai_data)}
        except Exception as e:
            # Fallback if JSON parsing completely fails
            return {"response": ai_message_text}
            
    return {"error": "Failed to connect to AI"}

class SummaryRequest(BaseModel):
    messages: list[Message]

import json
import sqlite3
from datetime import datetime

@app.post("/api/summary")
async def generate_summary(request: SummaryRequest):
    # 1. Build Transcript with None-safety
    transcript = ""
    for msg in request.messages:
        role = "Student" if msg.role == "user" else "Examiner"
        # Fallback to empty string if content is None
        content = msg.content if msg.content else ""
        transcript += f"{role}: {content}\n"

    # 2. Refined SNIFFER 
    detected_topic = "the provided transcript" 
    for msg in request.messages:
        # Check if the assistant message mentions the subject/topic
        content_lower = str(msg.content).lower() if msg.content else ""
        if msg.role == "assistant" and ("subject" in content_lower or "topic" in content_lower):
            detected_topic = msg.content
            break

    # 3. THE DYNAMIC PROMPT
    summary_prompt = f"""You are a specialized Academic Reviewer. 
    The student just finished an oral exam. Based on your records, the topic is: {detected_topic}

    TASK:
    Analyze the provided transcript and generate a performance report.
    
    STRICT RULES:
    - ALL feedback, strengths, and weaknesses MUST be about the specific concepts discussed in the transcript.
    - The 7-day roadmap MUST be a study plan for the subject matter of the exam.
    - If the transcript is about Physics, DO NOT mention Computer Science or Hash Tables.
    - The transcript is: 
    ---
    {transcript}
    ---

    Return ONLY JSON:
    {{
        "overall_score": (0-100),
        "strengths": ["specific technical point from the transcript"],
        "weak_concepts": ["specific technical gap found in the transcript"],
        "feedback": "A short summary of their performance.",
        "roadmap": [
            "Day 1: [Task related to the weakest concept in the transcript]",
            "Day 2: [Build on Day 1]",
            "Day 3: [Address second weakest concept]",
            "Day 4: [Active recall/practice task]",
            "Day 5: [Advanced application task]",
            "Day 6: [Mock practice self-test]",
            "Day 7: [Final review of the topic]"
        ]
    }}
    Ensure the roadmap is highly actionable and subject-specific.
    DO NOT include any markdown formatting or extra text.
    """
    ollama_url = "http://localhost:11434/api/generate"
    payload = {
        "model": "qwen2.5:7b",
        "prompt": summary_prompt,
        "stream": False,
        "format": "json"
    }
    
    response = requests.post(ollama_url, json=payload)
    if response.status_code != 200:
        return {"error": "Failed to generate summary"}

    ai_response_text = response.json().get("response", "")
    
    try:
        summary_data = json.loads(ai_response_text)
    except json.JSONDecodeError:
        return {"error": "AI returned invalid JSON", "raw": ai_response_text}

    # --- CALCULATE AVERAGE CONFIDENCE ---
    # Extract confidence scores from user messages, ignoring empty/missing ones
    confidences = [
        msg.confidence for msg in request.messages
        if msg.role == "user" and msg.confidence is not None
    ]
    avg_confidence = int(sum(confidences) / len(confidences)) if confidences else 100

    # --- SAVE TO DATABASE ---
    try:
        conn = sqlite3.connect('voxy.db')
        c = conn.cursor()
        date_str = datetime.now().strftime("%Y-%m-%d %H:%M")
        c.execute(
            "INSERT INTO sessions (date, score, confidence, strengths, weaknesses) VALUES (?, ?, ?, ?, ?)",
            (
                date_str,
                summary_data.get('overall_score', 0),
                avg_confidence,
                ", ".join(summary_data.get('strengths', [])),
                ", ".join(summary_data.get('weak_concepts', []))
            )
        )
        conn.commit()
        conn.close()
    except Exception as e:
        print(f"Database Error: {e}")

    return {"summary": json.dumps(summary_data)}

# Initialize the Whisper model globally so it doesn't reload on every request
# "base" or "small" model is perfect for CPU/Hackathon speeds
print("Loading Whisper model...")
whisper_model = WhisperModel("base", device="cpu", compute_type="int8")

# Add this new endpoint below your other endpoints
@app.post("/api/transcribe")
async def transcribe_audio(file: UploadFile = File(...)):
    try:
        # Save the uploaded audio chunk to a temporary file
        with tempfile.NamedTemporaryFile(delete=False, suffix=".webm") as temp_audio:
            content = await file.read()
            temp_audio.write(content)
            temp_file_path = temp_audio.name

        # Transcribe the audio
        segments, info = whisper_model.transcribe(temp_file_path, beam_size=5)
        
        transcript = ""
        for segment in segments:
            transcript += segment.text + " "

        # Clean up the temp file
        os.remove(temp_file_path)

        return {"text": transcript.strip()}
    except Exception as e:
        return {"error": str(e)}

@app.get("/api/history")
def get_history():
    try:
        conn = sqlite3.connect('voxy.db')
        c = conn.cursor()
        # Added confidence to SELECT
        c.execute("SELECT id, date, score, confidence, strengths, weaknesses FROM sessions ORDER BY id DESC")
        rows = c.fetchall()
        conn.close()
        
        sessions = []
        for row in rows:
            sessions.append({
                "id": row[0],
                "date": row[1],
                "score": row[2],
                "confidence": row[3] or 0, # Return confidence!
                "strengths": row[4].split(", ") if row[4] else [],
                "weaknesses": row[5].split(", ") if row[5] else []
            })
        return {"sessions": sessions}
    except Exception as e:
        return {"error": str(e)}