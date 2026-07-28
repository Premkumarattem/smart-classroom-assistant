"""
Smart Classroom Assistant — Backend
------------------------------------
Three kinds of accounts: student, teacher, college (institution admin).

Core flow:
  1. Teacher clicks "Start Class" -> POST /api/classes/start (subject, college)
  2. Teacher's browser streams transcript chunks -> POST /api/classes/{id}/transcript
  3. Students poll that same class -> GET /api/classes/{id} for live captions
  4. Student raises hand / sends chat -> teacher's screen polls and sees it
  5. Teacher clicks "Stop Class" -> POST /api/classes/{id}/stop
     -> uploads the audio recording, and Claude generates "smart notes"
        from the full transcript, all stored in the database
  6. Anyone can look up past classes by date / subject / teacher
     -> GET /api/classes?subject=...&teacher=...&date=...

Run:
    pip install -r requirements.txt
    export ANTHROPIC_API_KEY=sk-ant-...      (Windows: set ANTHROPIC_API_KEY=...)
    uvicorn app:app --reload --port 8000

Note: auth here is intentionally minimal (SQLite + salted hash, no real
sessions/JWT) — built to demo an accessibility-aware classroom for a
hackathon, not to be production-grade auth. Say so if a judge asks.
Recording captures both audio and video from the teacher's device camera
and microphone, uploaded as one file after class ends.
"""

import os
import sqlite3
import hashlib
import secrets
import json
import base64
from datetime import datetime
from typing import List, Optional
from fastapi import FastAPI, HTTPException, UploadFile, File, Header, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

app = FastAPI(title="Smart Classroom Assistant API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------
# AI provider — Anthropic (Claude) or Groq (free, OpenAI-compatible).
# Switch with one environment variable, no code changes needed:
#   export MODEL_PROVIDER=groq        (free tier, no card, 30 req/min)
#   export MODEL_PROVIDER=anthropic   (paid after the $5 trial credit)
# Defaults to groq so this runs free out of the box.
#
# Groq's hosted model lineup changes more often than Anthropic's, and
# they've deprecated several models in 2026 (old Llama 3.x chat models,
# llama-4-scout for vision). GROQ_TEXT_MODEL below is Groq's current
# recommended flagship as of this writing. If it ever 404s, check
# https://console.groq.com/docs/models and update the env var below —
# no code change needed there either.
# ---------------------------------------------------------------
MODEL_PROVIDER = os.environ.get("MODEL_PROVIDER", "groq").lower()
ANTHROPIC_MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-5")
GROQ_TEXT_MODEL = os.environ.get("GROQ_TEXT_MODEL", "openai/gpt-oss-120b")
# Groq's vision-capable models are explicitly labeled "preview" and change
# frequently — this is the current one as of writing. OCR falls back to a
# clear error (not a crash) if this model has been retired since.
GROQ_VISION_MODEL = os.environ.get("GROQ_VISION_MODEL", "qwen/qwen3.6-27b")

_anthropic_client = None
_groq_client = None


def get_anthropic_client():
    global _anthropic_client
    if _anthropic_client is None:
        from anthropic import Anthropic
        _anthropic_client = Anthropic()  # reads ANTHROPIC_API_KEY from the environment
    return _anthropic_client


def get_groq_client():
    global _groq_client
    if _groq_client is None:
        from groq import Groq
        _groq_client = Groq()  # reads GROQ_API_KEY from the environment
    return _groq_client


def call_llm(system: str, user_message: str, max_tokens: int = 500) -> str:
    """
    One function every text-generation endpoint calls, regardless of
    provider. Anthropic keeps system prompts separate from the message
    list; Groq (OpenAI-shaped) puts the system prompt inside the messages
    array instead — that's the one real structural difference between them.
    """
    if MODEL_PROVIDER == "groq":
        client = get_groq_client()
        response = client.chat.completions.create(
            model=GROQ_TEXT_MODEL,
            max_tokens=max_tokens,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user_message},
            ],
        )
        return response.choices[0].message.content
    else:
        client = get_anthropic_client()
        response = client.messages.create(
            model=ANTHROPIC_MODEL,
            max_tokens=max_tokens,
            system=system,
            messages=[{"role": "user", "content": user_message}],
        )
        return "".join(b.text for b in response.content if b.type == "text")


def call_llm_vision(system: str, user_message: str, image_b64: str, media_type: str, max_tokens: int = 900) -> str:
    """Same idea as call_llm, but with an image attached — used only by OCR."""
    if MODEL_PROVIDER == "groq":
        client = get_groq_client()
        try:
            response = client.chat.completions.create(
                model=GROQ_VISION_MODEL,
                max_tokens=max_tokens,
                messages=[
                    {"role": "system", "content": system},
                    {"role": "user", "content": [
                        {"type": "text", "text": user_message},
                        {"type": "image_url", "image_url": {"url": f"data:{media_type};base64,{image_b64}"}},
                    ]},
                ],
            )
            return response.choices[0].message.content
        except Exception as e:
            raise HTTPException(
                status_code=502,
                detail=(
                    "Groq's vision model may have changed or been retired since this was built "
                    f"(current model: {GROQ_VISION_MODEL}). Check https://console.groq.com/docs/models "
                    f"and update GROQ_VISION_MODEL. Original error: {e}"
                ),
            )
    else:
        client = get_anthropic_client()
        response = client.messages.create(
            model=ANTHROPIC_MODEL,
            max_tokens=max_tokens,
            system=system,
            messages=[{
                "role": "user",
                "content": [
                    {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": image_b64}},
                    {"type": "text", "text": user_message},
                ],
            }],
        )
        return "".join(b.text for b in response.content if b.type == "text")


# Storage
# ---------------------------------------------------------------
DB_PATH = os.path.join(os.path.dirname(__file__), "app.db")
RECORDINGS_DIR = os.path.join(os.path.dirname(__file__), "recordings")
os.makedirs(RECORDINGS_DIR, exist_ok=True)
app.mount("/recordings", StaticFiles(directory=RECORDINGS_DIR), name="recordings")

# Accessibility needs a student can select at registration. "speech" covers
# students who can't speak (mute/non-verbal) — separate from "hearing" (deaf)
# so deaf, mute, and deaf+mute (both) are all representable as combinations.
VALID_DISABILITIES = {"vision", "hearing", "speech", "dyslexia", "adhd", "motor", "none"}
VALID_ROLES = {"student", "teacher", "college"}
VALID_LANGUAGES = {"english", "telugu", "hindi"}

LANGUAGE_NAMES = {"english": "English", "telugu": "Telugu", "hindi": "Hindi"}


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_db()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            salt TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            disabilities TEXT NOT NULL DEFAULT '[]',
            role TEXT NOT NULL DEFAULT 'student',
            college_name TEXT NOT NULL DEFAULT '',
            language TEXT NOT NULL DEFAULT 'english',
            token TEXT,
            settings TEXT NOT NULL DEFAULT '{}'
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS class_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            teacher_id INTEGER,
            teacher_name TEXT NOT NULL,
            college_name TEXT NOT NULL DEFAULT '',
            subject TEXT NOT NULL,
            session_date TEXT NOT NULL,
            start_time TEXT NOT NULL,
            end_time TEXT,
            transcript TEXT NOT NULL DEFAULT '',
            ai_notes TEXT,
            recording_path TEXT,
            status TEXT NOT NULL DEFAULT 'active'
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS hand_raises (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id INTEGER NOT NULL,
            student_name TEXT NOT NULL,
            raised_at TEXT NOT NULL,
            urgent INTEGER NOT NULL DEFAULT 0,
            resolved INTEGER NOT NULL DEFAULT 0
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS chat_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id INTEGER NOT NULL,
            sender_name TEXT NOT NULL,
            sender_role TEXT NOT NULL,  -- 'student' or 'teacher'
            message TEXT NOT NULL,
            sent_at TEXT NOT NULL
        )
        """
    )
    conn.commit()
    conn.close()


init_db()


def now_iso() -> str:
    return datetime.now().isoformat()


def today_str() -> str:
    return datetime.now().strftime("%Y-%m-%d")


def hash_password(password: str, salt: str) -> str:
    return hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 100_000).hex()


# ---------------------------------------------------------------
# Accounts — student / teacher / college, each with their own login
# ---------------------------------------------------------------
class RegisterRequest(BaseModel):
    name: str
    email: str
    password: str
    role: str = "student"          # "student" | "teacher" | "college"
    college_name: str = ""
    disabilities: List[str] = []   # only meaningful for students
    language: str = "english"


class LoginRequest(BaseModel):
    email: str
    password: str


def user_to_dict(row) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "email": row["email"],
        "disabilities": json.loads(row["disabilities"]),
        "role": row["role"],
        "college_name": row["college_name"],
        "language": row["language"],
        "token": row["token"],
        "settings": json.loads(row["settings"] or "{}"),
    }


def require_user(authorization: Optional[str]) -> sqlite3.Row:
    """
    Very lightweight token check: the client sends 'Bearer <token>' in the
    Authorization header (issued at register/login). This stops a random
    client from starting/stopping classes or raising hands as someone else
    just by guessing IDs — it is NOT hardened production auth (no
    expiry/rotation), and that's stated plainly in the README.
    """
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid Authorization header.")
    token = authorization.removeprefix("Bearer ").strip()
    conn = get_db()
    row = conn.execute("SELECT * FROM users WHERE token = ?", (token,)).fetchone()
    conn.close()
    if not row:
        raise HTTPException(status_code=401, detail="Invalid or expired session token.")
    return row


@app.post("/api/register")
def register(req: RegisterRequest):
    name = req.name.strip()
    email = req.email.strip().lower()
    if not name or not email or len(req.password) < 4:
        raise HTTPException(status_code=400, detail="Name, email, and a password (4+ chars) are required.")

    role = req.role if req.role in VALID_ROLES else "student"
    language = req.language if req.language in VALID_LANGUAGES else "english"
    disabilities = [d for d in req.disabilities if d in VALID_DISABILITIES] or ["none"]

    conn = get_db()
    existing = conn.execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone()
    if existing:
        conn.close()
        raise HTTPException(status_code=409, detail="An account with this email already exists.")

    salt = secrets.token_hex(16)
    pw_hash = hash_password(req.password, salt)
    token = secrets.token_hex(24)
    conn.execute(
        """INSERT INTO users (name, email, salt, password_hash, disabilities, role, college_name, language, token, settings)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '{}')""",
        (name, email, salt, pw_hash, json.dumps(disabilities), role, req.college_name.strip(), language, token),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
    conn.close()
    return {"user": user_to_dict(row)}


@app.post("/api/login")
def login(req: LoginRequest):
    email = req.email.strip().lower()
    conn = get_db()
    row = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
    if not row or hash_password(req.password, row["salt"]) != row["password_hash"]:
        conn.close()
        raise HTTPException(status_code=401, detail="Invalid email or password.")
    # Issue a fresh token on every login (old ones simply stop matching).
    token = secrets.token_hex(24)
    conn.execute("UPDATE users SET token = ? WHERE id = ?", (token, row["id"]))
    conn.commit()
    row = conn.execute("SELECT * FROM users WHERE id = ?", (row["id"],)).fetchone()
    conn.close()
    return {"user": user_to_dict(row)}


class SettingsRequest(BaseModel):
    settings: dict


@app.put("/api/settings")
def save_settings(req: SettingsRequest, authorization: Optional[str] = Header(None)):
    user = require_user(authorization)
    conn = get_db()
    conn.execute("UPDATE users SET settings = ? WHERE id = ?", (json.dumps(req.settings), user["id"]))
    conn.commit()
    row = conn.execute("SELECT * FROM users WHERE id = ?", (user["id"],)).fetchone()
    conn.close()
    return {"user": user_to_dict(row)}


# ---------------------------------------------------------------
# WebSockets — real-time push for transcript / hand-raise / chat,
# replacing polling for anyone connected to a specific class session.
# Discovery of "is a class live right now" still uses a REST GET,
# since a student doesn't have a session_id to connect to yet.
#
# This same channel also carries WebRTC *signaling* for live video —
# the offer/answer/ICE-candidate handshake browsers need before they can
# open a direct peer-to-peer video connection to each other. The actual
# video/audio never touches this server; only the small setup messages
# do. That's why this stays lightweight even with video involved.
# ---------------------------------------------------------------
class ConnectionManager:
    def __init__(self):
        # session_id -> list of {"ws", "role", "client_id", "name"}
        self.active: dict = {}

    async def connect(self, session_id: int, ws: WebSocket, role: str, client_id: str, name: str):
        await ws.accept()
        self.active.setdefault(session_id, []).append(
            {"ws": ws, "role": role, "client_id": client_id, "name": name}
        )

    def disconnect(self, session_id: int, ws: WebSocket):
        conns = self.active.get(session_id, [])
        self.active[session_id] = [c for c in conns if c["ws"] is not ws]

    async def broadcast(self, session_id: int, message: dict):
        for c in list(self.active.get(session_id, [])):
            try:
                await c["ws"].send_json(message)
            except Exception:
                self.disconnect(session_id, c["ws"])

    async def send_to_role(self, session_id: int, role: str, message: dict):
        """Used for signaling aimed at 'whichever connection is the teacher'."""
        for c in list(self.active.get(session_id, [])):
            if c["role"] == role:
                try:
                    await c["ws"].send_json(message)
                except Exception:
                    self.disconnect(session_id, c["ws"])

    async def send_to_client(self, session_id: int, client_id: str, message: dict):
        """Used for signaling aimed at one specific student (by their client_id)."""
        for c in list(self.active.get(session_id, [])):
            if c["client_id"] == client_id:
                try:
                    await c["ws"].send_json(message)
                except Exception:
                    self.disconnect(session_id, c["ws"])


manager = ConnectionManager()

# Message types relayed as WebRTC signaling — routed to a specific peer,
# never broadcast to everyone (unlike transcript/hand_raise/chat above).
SIGNALING_TYPES = {"video_join", "webrtc_offer", "webrtc_answer", "webrtc_ice"}


@app.websocket("/ws/class/{session_id}")
async def class_websocket(
    websocket: WebSocket,
    session_id: int,
    role: str = "student",
    client_id: str = "",
    name: str = "",
):
    await manager.connect(session_id, websocket, role, client_id, name)
    try:
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if msg.get("type") not in SIGNALING_TYPES:
                continue  # this connection doesn't send anything else meaningful

            if msg.get("type") == "video_join":
                # A student is ready to receive video — tell the teacher who,
                # so the teacher can open a peer connection aimed at them.
                await manager.send_to_role(session_id, "teacher", msg)
            else:
                # offer/answer/ICE — relay to whichever side it's addressed to.
                target = msg.get("target")
                if target == "teacher":
                    await manager.send_to_role(session_id, "teacher", msg)
                elif target:
                    await manager.send_to_client(session_id, target, msg)
    except WebSocketDisconnect:
        manager.disconnect(session_id, websocket)


# ---------------------------------------------------------------
# Class sessions — start / live transcript / stop / lookup
# ---------------------------------------------------------------
class StartClassRequest(BaseModel):
    teacher_id: Optional[int] = None
    teacher_name: str
    college_name: str = ""
    subject: str


@app.post("/api/classes/start")
def start_class(req: StartClassRequest, authorization: Optional[str] = Header(None)):
    user = require_user(authorization)
    if user["role"] != "teacher":
        raise HTTPException(status_code=403, detail="Only teacher accounts can start a class.")
    conn = get_db()
    conn.execute(
        """INSERT INTO class_sessions
           (teacher_id, teacher_name, college_name, subject, session_date, start_time, status)
           VALUES (?, ?, ?, ?, ?, ?, 'active')""",
        (req.teacher_id, req.teacher_name, req.college_name, req.subject, today_str(), now_iso()),
    )
    conn.commit()
    session_id = conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
    conn.close()
    return {"session_id": session_id, "date": today_str()}


class TranscriptChunkRequest(BaseModel):
    chunk: str


@app.post("/api/classes/{session_id}/transcript")
async def append_transcript(session_id: int, req: TranscriptChunkRequest, authorization: Optional[str] = Header(None)):
    require_user(authorization)
    conn = get_db()
    row = conn.execute("SELECT transcript FROM class_sessions WHERE id = ?", (session_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Class session not found.")
    new_transcript = (row["transcript"] + " " + req.chunk).strip()
    conn.execute("UPDATE class_sessions SET transcript = ? WHERE id = ?", (new_transcript, session_id))
    conn.commit()
    conn.close()
    await manager.broadcast(session_id, {"type": "transcript", "chunk": req.chunk})
    return {"ok": True}


@app.post("/api/classes/{session_id}/recording")
async def upload_recording(session_id: int, file: UploadFile = File(...), authorization: Optional[str] = Header(None)):
    require_user(authorization)
    conn = get_db()
    row = conn.execute("SELECT id FROM class_sessions WHERE id = ?", (session_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Class session not found.")
    ext = os.path.splitext(file.filename or "")[1] or ".webm"
    filename = f"class_{session_id}{ext}"
    path = os.path.join(RECORDINGS_DIR, filename)
    with open(path, "wb") as f:
        f.write(await file.read())
    conn.execute("UPDATE class_sessions SET recording_path = ? WHERE id = ?", (f"/recordings/{filename}", session_id))
    conn.commit()
    conn.close()
    return {"ok": True, "recording_path": f"/recordings/{filename}"}


def try_convert_to_mp4(recording_path: Optional[str]) -> Optional[str]:
    """
    Best-effort WebM -> MP4 conversion using ffmpeg, if it's installed on
    this machine. Browsers only record WebM natively, so this is what
    makes the saved file an actual .mp4. If ffmpeg isn't available, the
    original WebM is kept — WebM still plays fine in every modern browser,
    so nothing breaks either way.
    """
    if not recording_path or not recording_path.endswith(".webm"):
        return recording_path
    import subprocess
    import shutil as _shutil
    if not _shutil.which("ffmpeg"):
        return recording_path
    src = os.path.join(RECORDINGS_DIR, os.path.basename(recording_path))
    mp4_name = os.path.splitext(os.path.basename(src))[0] + ".mp4"
    dst = os.path.join(RECORDINGS_DIR, mp4_name)
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-i", src, "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", dst],
            check=True, capture_output=True, timeout=180,
        )
        os.remove(src)
        return f"/recordings/{mp4_name}"
    except Exception:
        return recording_path


@app.post("/api/classes/{session_id}/stop")
def stop_class(session_id: int, authorization: Optional[str] = Header(None)):
    require_user(authorization)
    conn = get_db()
    row = conn.execute("SELECT * FROM class_sessions WHERE id = ?", (session_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Class session not found.")

    transcript = row["transcript"] or ""
    ai_notes = "No transcript was captured for this class."
    if transcript.strip():
        try:
            ai_notes = call_llm(
                system=(
                    "You are analyzing a full classroom lecture transcript after class has ended. "
                    "Produce a well-organized 'smart summary' with: (1) the main topics covered, "
                    "as a short bullet list, (2) any parts that seem likely to confuse students, "
                    "(3) 2-3 suggested review questions. Be concise and use plain language."
                ),
                user_message=transcript,
                max_tokens=700,
            )
        except Exception as e:
            ai_notes = f"(AI summary failed: {e})"

    final_recording_path = try_convert_to_mp4(row["recording_path"])

    conn.execute(
        "UPDATE class_sessions SET end_time = ?, ai_notes = ?, status = 'ended', recording_path = ? WHERE id = ?",
        (now_iso(), ai_notes, final_recording_path, session_id),
    )
    conn.commit()
    conn.close()
    return {"ok": True, "ai_notes": ai_notes, "recording_path": final_recording_path}


@app.get("/api/classes/{session_id}")
def get_class(session_id: int):
    conn = get_db()
    row = conn.execute("SELECT * FROM class_sessions WHERE id = ?", (session_id,)).fetchone()
    conn.close()
    if not row:
        raise HTTPException(status_code=404, detail="Class session not found.")
    return {"session": dict(row)}


@app.get("/api/classes")
def list_classes(
    subject: Optional[str] = None,
    teacher_name: Optional[str] = None,
    date: Optional[str] = None,
    college_name: Optional[str] = None,
    status: Optional[str] = None,
):
    query = "SELECT id, teacher_name, college_name, subject, session_date, start_time, end_time, status, recording_path FROM class_sessions WHERE 1=1"
    params = []
    if subject:
        query += " AND subject LIKE ?"
        params.append(f"%{subject}%")
    if teacher_name:
        query += " AND teacher_name LIKE ?"
        params.append(f"%{teacher_name}%")
    if date:
        query += " AND session_date = ?"
        params.append(date)
    if college_name:
        query += " AND college_name LIKE ?"
        params.append(f"%{college_name}%")
    if status:
        query += " AND status = ?"
        params.append(status)
    query += " ORDER BY id DESC"

    conn = get_db()
    rows = conn.execute(query, params).fetchall()
    conn.close()
    return {"classes": [dict(r) for r in rows]}


# ---------------------------------------------------------------
# Hand-raise — student taps it, teacher's screen sees it
# ---------------------------------------------------------------
class HandRaiseRequest(BaseModel):
    session_id: int
    student_name: str
    urgent: bool = False


@app.post("/api/hand-raise")
async def raise_hand(req: HandRaiseRequest, authorization: Optional[str] = Header(None)):
    require_user(authorization)
    conn = get_db()
    conn.execute(
        "INSERT INTO hand_raises (session_id, student_name, raised_at, urgent, resolved) VALUES (?, ?, ?, ?, 0)",
        (req.session_id, req.student_name, now_iso(), int(req.urgent)),
    )
    conn.commit()
    conn.close()
    await manager.broadcast(req.session_id, {"type": "hand_raise", "student_name": req.student_name, "urgent": req.urgent})
    return {"ok": True}


@app.get("/api/hand-raise")
def list_hand_raises(session_id: int):
    conn = get_db()
    rows = conn.execute(
        "SELECT id, student_name, raised_at, urgent FROM hand_raises WHERE session_id = ? AND resolved = 0 "
        "ORDER BY urgent DESC, raised_at",
        (session_id,),
    ).fetchall()
    conn.close()
    return {"raised": [dict(r) for r in rows]}


@app.post("/api/hand-raise/{raise_id}/resolve")
def resolve_hand_raise(raise_id: int, authorization: Optional[str] = Header(None)):
    require_user(authorization)
    conn = get_db()
    conn.execute("UPDATE hand_raises SET resolved = 1 WHERE id = ?", (raise_id,))
    conn.commit()
    conn.close()
    return {"ok": True}


# ---------------------------------------------------------------
# Chat — for students who can't speak, a direct text line to the teacher
# ---------------------------------------------------------------
class ChatMessageRequest(BaseModel):
    session_id: int
    sender_name: str
    sender_role: str  # "student" or "teacher"
    message: str


@app.post("/api/chat")
async def send_chat(req: ChatMessageRequest, authorization: Optional[str] = Header(None)):
    require_user(authorization)
    conn = get_db()
    conn.execute(
        "INSERT INTO chat_messages (session_id, sender_name, sender_role, message, sent_at) VALUES (?, ?, ?, ?, ?)",
        (req.session_id, req.sender_name, req.sender_role, req.message, now_iso()),
    )
    conn.commit()
    conn.close()
    await manager.broadcast(req.session_id, {
        "type": "chat", "sender_name": req.sender_name, "sender_role": req.sender_role, "message": req.message,
    })
    return {"ok": True}


@app.get("/api/chat")
def get_chat(session_id: int, since_id: int = 0):
    conn = get_db()
    rows = conn.execute(
        "SELECT id, sender_name, sender_role, message, sent_at FROM chat_messages "
        "WHERE session_id = ? AND id > ? ORDER BY id",
        (session_id, since_id),
    ).fetchall()
    conn.close()
    return {"messages": [dict(r) for r in rows]}


# ---------------------------------------------------------------
# Accessibility dashboard — lets a teacher see, in aggregate, what kind
# of support the students at their college need. No individual student
# is singled out in the UI — just totals.
# ---------------------------------------------------------------
@app.get("/api/accessibility-stats")
def accessibility_stats(college_name: str):
    conn = get_db()
    rows = conn.execute(
        "SELECT disabilities FROM users WHERE role = 'student' AND college_name = ?",
        (college_name,),
    ).fetchall()
    conn.close()
    counts = {k: 0 for k in VALID_DISABILITIES if k != "none"}
    total_students = len(rows)
    for row in rows:
        for d in json.loads(row["disabilities"]):
            if d in counts:
                counts[d] += 1
    return {"total_students": total_students, "counts": counts}


# ---------------------------------------------------------------
# AI Flashcard Generator — turns the transcript into revision Q&A cards
# ---------------------------------------------------------------
class FlashcardsRequest(BaseModel):
    transcript: str
    language: str = "english"


@app.post("/api/flashcards")
def generate_flashcards(req: FlashcardsRequest):
    if not req.transcript.strip():
        return {"flashcards": []}
    try:
        text = call_llm(
            system=(
                "Create 5-8 revision flashcards from this lecture transcript. "
                "Respond with ONLY a JSON array, no other text, no markdown fences. "
                "Each item: {\"question\": \"...\", \"answer\": \"...\"}. "
                "Questions should test understanding, not just recall of exact wording. "
                "Keep answers under 30 words each."
                + language_instruction(req.language)
            ),
            user_message=req.transcript,
            max_tokens=600,
        )
        text = text.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
        cards = json.loads(text)
        return {"flashcards": cards}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------
# AI Mind Map — a simple topic -> subtopics outline from the transcript
# ---------------------------------------------------------------
class MindMapRequest(BaseModel):
    transcript: str
    language: str = "english"


@app.post("/api/mindmap")
def generate_mindmap(req: MindMapRequest):
    if not req.transcript.strip():
        return {"mindmap": None}
    try:
        text = call_llm(
            system=(
                "Turn this lecture transcript into a mind map structure. "
                "Respond with ONLY JSON, no other text, no markdown fences: "
                "{\"topic\": \"central topic\", \"branches\": ["
                "{\"title\": \"subtopic\", \"points\": [\"short point\", \"short point\"]}"
                "]}. Use 3-5 branches, 2-4 points each, keep every string short."
                + language_instruction(req.language)
            ),
            user_message=req.transcript,
            max_tokens=500,
        )
        text = text.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
        mindmap = json.loads(text)
        return {"mindmap": mindmap}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------
# OCR + Read Aloud — photograph a textbook page, get it read back
# ---------------------------------------------------------------
@app.post("/api/ocr-read")
async def ocr_read(file: UploadFile = File(...), disabilities: str = "", language: str = "english"):
    image_bytes = await file.read()
    if len(image_bytes) > 8_000_000:
        raise HTTPException(status_code=400, detail="Image too large (max 8MB).")
    b64 = base64.b64encode(image_bytes).decode()
    media_type = file.content_type or "image/jpeg"
    try:
        parsed_disabilities = json.loads(disabilities) if disabilities else []
    except json.JSONDecodeError:
        parsed_disabilities = []

    try:
        text = call_llm_vision(
            system=(
                "Read the text visible in this photo of a page exactly as written. "
                "Then, on a new line starting with 'SUMMARY:', give a 1-2 sentence plain-language "
                "summary of what it says. Keep the transcription and summary clearly separated."
                + accessibility_instructions(parsed_disabilities)
                + language_instruction(language)
            ),
            user_message="Please read this page for a student who can't easily read it themselves.",
            image_b64=b64,
            media_type=media_type,
            max_tokens=900,
        )
        return {"text": text}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------
# Accessibility + language -> extra system-prompt guidance
# ---------------------------------------------------------------
def accessibility_instructions(disabilities: List[str]) -> str:
    notes = []
    if "simple" in disabilities:
        notes.append("Rewrite this in very simple, everyday language, as if for someone new to the topic.")
    if "dyslexia" in disabilities:
        notes.append("Use short sentences and plain, common words — this reader has dyslexia.")
    if "adhd" in disabilities:
        notes.append("Be extremely concise. Lead with the single most important point first.")
    if "vision" in disabilities:
        notes.append(
            "This reader may have this read aloud by a screen reader — avoid relying on "
            "visual formatting like tables; write in plain flowing sentences."
        )
    if "hearing" in disabilities:
        notes.append("This reader relies entirely on text, not audio — be fully self-contained and clear.")
    if "speech" in disabilities:
        notes.append("This reader communicates by typing, not speaking — keep replies easy to act on via text.")
    return " ".join(notes)


def language_instruction(language: str) -> str:
    lang = LANGUAGE_NAMES.get(language, "English")
    if lang == "English":
        return ""
    return f" Write your entire response in {lang}, not English."


class SummarizeRequest(BaseModel):
    transcript: str
    disabilities: List[str] = []
    language: str = "english"


class AskRequest(BaseModel):
    transcript: str
    question: str
    disabilities: List[str] = []
    language: str = "english"


class ExplainRequest(BaseModel):
    transcript: str
    disabilities: List[str] = []
    language: str = "english"


@app.post("/api/explain")
def explain(req: ExplainRequest):
    """
    "I didn't understand that" button. Re-explains the MOST RECENT part of
    the lecture in the simplest possible way, tuned to the student's
    accessibility profile and preferred language.
    """
    if not req.transcript.strip():
        return {
            "explanation": "Nothing's been captured yet — once the lecture starts, "
            "this button will re-explain whatever the teacher just said."
        }

    recent_chunk = req.transcript[-900:]

    try:
        explanation = call_llm(
            system=(
                "A student didn't understand what the teacher just said in class. "
                "Re-explain ONLY the most recent idea below in the simplest possible way: "
                "use an everyday analogy, short sentences, no jargon. Don't just repeat or "
                "summarize the transcript — genuinely re-teach the idea more simply, as if "
                "to someone hearing it for the first time. Keep it under 100 words. "
                + accessibility_instructions(req.disabilities)
                + language_instruction(req.language)
                + "\n\n--- WHAT THE TEACHER JUST SAID ---\n"
                + recent_chunk
                + "\n--- END ---"
            ),
            user_message="I didn't understand that. Can you explain it more simply?",
            max_tokens=350,
        )
        return {"explanation": explanation}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.post("/api/summarize")
def summarize(req: SummarizeRequest):
    if not req.transcript.strip():
        return {"summary": "No lecture audio captured yet."}

    try:
        summary = call_llm(
            system=(
                "You are a note-taking assistant for a live classroom. "
                "Turn the raw lecture transcript into concise bullet-point notes. "
                "Only include points actually said in the transcript. "
                "Keep it to 5-8 bullets max. No preamble, just bullets. "
                + accessibility_instructions(req.disabilities)
                + language_instruction(req.language)
            ),
            user_message=req.transcript,
            max_tokens=400,
        )
        return {"summary": summary}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/ask")
def ask(req: AskRequest):
    if not req.transcript.strip():
        return {"answer": "The lecture hasn't started yet, so there's nothing to answer from."}

    try:
        answer = call_llm(
            system=(
                "You are a classroom doubt-solving assistant. Answer the student's "
                "question using ONLY the lecture transcript provided below as context. "
                "If the transcript doesn't cover the question, say so honestly instead "
                "of guessing, and suggest the student ask the teacher directly. "
                "Keep answers short, clear, and student-friendly. "
                + accessibility_instructions(req.disabilities)
                + language_instruction(req.language)
                + "\n\n"
                f"--- LECTURE TRANSCRIPT SO FAR ---\n{req.transcript}\n--- END TRANSCRIPT ---"
            ),
            user_message=req.question,
            max_tokens=500,
        )
        return {"answer": answer}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------
# Serve the frontend from this same backend — this is what makes a
# single-service deployment possible (one URL, no CORS setup, no second
# host to manage). Mounted at "/" and placed at the very end of the file
# on purpose: FastAPI matches routes in the order they're registered, so
# every /api/... and /recordings/... route above always wins over this
# catch-all for static files. If the frontend/ folder isn't present next
# to backend/ (e.g. you only deployed the backend folder by itself), this
# is skipped instead of crashing.
# ---------------------------------------------------------------
FRONTEND_DIR = os.path.join(os.path.dirname(__file__), "..", "frontend")
if os.path.isdir(FRONTEND_DIR):
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
