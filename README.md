# Smart Classroom Assistant

**We built an Inclusive Smart Classroom that enables hearing-impaired,
visually-impaired, speech-impaired, dyslexic, and multilingual students to
learn in the same classroom without barriers.**

Three logins — **Student**, **Teacher**, **College** — one shared classroom.
The teacher starts a class and it's recorded and captioned live; students get
live captions, one-tap simple re-explanations, a hand-raise button, and a
chat channel for anyone who can't speak — all in **English, Telugu, or
Hindi**. Every class is saved to a database, searchable by date, subject,
and teacher.

## The core five — lead your demo with these

If you only have time to show five things, show these. They're the direct
answer to "what's your core innovation?":

1. **Live captions** for hearing-impaired students
2. **Real-time translation** (English / Telugu / Hindi)
3. **AI-generated notes** from the lecture
4. **Adjustable font size + high-contrast themes**
5. **Emergency assistance button**

Everything past this point is real and working, but secondary — use it to
answer follow-up questions, not to open your pitch.

## What changed from the earlier version

The camera-based face-recognition attendance feature has been **removed
entirely** — it added real maintenance cost for a hackathon demo without
being the core value. Everything below replaces it with a more complete,
easier-to-explain flow.

## The three logins

| Role | What they do |
|---|---|
| **Teacher** | Starts/stops a class (records audio + live transcript), sees raised hands and student chat live, gets AI "smart notes" the moment class ends |
| **Student** | Sees live captions, taps "explain simply" when lost, asks grounded questions, raises a hand, or chats instead of speaking |
| **College** | Looks up every class ever held at their institution — by date, subject, or teacher |

Accessibility needs (only asked of students) now include a dedicated
**"can't speak" (mute)** option separate from "deaf / hard of hearing" —
so deaf, mute, and deaf-and-mute students are all representable, alone or
combined, just by selecting more than one checkbox.

## How a class actually flows

1. **Teacher** logs in, types a subject, hits **▶ Start Class**.
   - Browser mic starts recording audio (`MediaRecorder`)
   - Web Speech API transcribes live; each sentence is pushed to the backend
     as it's recognized
2. **Student** logs in — the dashboard polls every few seconds for a live
   class at their college. Once one starts, live captions stream in
   automatically.
3. Student taps **🤔 explain simply** any time they get lost — re-explains
   just the last thing said, in their chosen language.
4. Student too shy/unable to interrupt out loud → **🖐 Raise Hand**. It shows
   up instantly on the teacher's screen with a name and timestamp.
5. Student who can't speak at all → the **chat box** goes directly to the
   teacher's screen, two-way.
6. **Teacher** hits **■ Stop Class** — the audio recording uploads, and
   Claude reads the full transcript to generate "smart notes": main topics,
   likely confusing parts, and suggested review questions. Everything is
   saved.
7. **College admin** can search all of this afterward by date, subject, or
   teacher name.

## Extra features added on top of the core flow

- **🚨 Emergency Help** — an urgent version of hand-raise. Shows first in
  the teacher's list, highlighted red and pulsing.
- **Theme picker** — Default, Black & White, Yellow & Black, Blue & White,
  for different visual needs.
- **Font size presets** — S / M / L / XL, one click each.
- **Magnifier mode** — a zoom lens follows your cursor over the screen.
- **Simple Language Mode** — a manual toggle (separate from the disability
  profile) that forces notes/answers/explanations into plain, everyday
  language for anyone who wants it.
- **Voice commands** — say "explain that," "raise hand," "ask a question,"
  "flashcards," or "mind map" instead of clicking, when enabled.
- **🎴 AI Flashcards** — generates revision Q&A cards from the live
  transcript; click a card to flip it.
- **🧠 AI Mind Map** — generates a topic → subtopic → key-points outline
  from the transcript.
- **📖 OCR + Read Aloud** — photograph any textbook page; Claude reads the
  text back and gives a plain-language summary, spoken aloud automatically.
- **🤟 Sign Language Glossary (prototype)** — see the honest note below;
  this is a real, working feature, just scoped honestly.
- **🏅 Achievement badges** — lightweight, session-based: Curious Mind,
  Quick Learner, Accessibility Explorer, Consistent Learner.
- **Accessibility Dashboard (teacher)** — an aggregate snapshot of how many
  students at their college need vision/hearing/dyslexia/ADHD/motor/speech
  support. No individual student is singled out.

## About the Sign Language Glossary — say this plainly if asked

**What it is:** a small set of common classroom phrases (yes, no, question,
wait, thank you, hello, repeat, understood) shown as reference cards. When
one of those words is heard in the live transcript, its card highlights.

**What it is NOT:** real-time AI translation of arbitrary speech into sign
language. That would need either a trained sign-generation model or a large
library of filmed clips from a certified signer — both genuinely multi-week
efforts, not something any hackathon team ships honestly in a weekend.

If a judge asks "does this actually do sign language," the accurate answer
is: *"This is a working prototype of the concept — a curated phrase glossary
that reacts live to the lecture. A production version would replace the
icon cards with filmed clips from a certified ASL/ISL signer."* That's a
stronger answer than overclaiming, and judges tend to respect the honesty.

## What's deliberately NOT included (and why)

A few ideas were left out on purpose rather than half-built:

- **Full AI sign-language generation** — see above; the glossary prototype
  replaces this honestly.
- **Emotion/confusion detection via webcam** — this needs continuous
  camera analysis of student faces, which is exactly the
  maintenance-heavy camera complexity that was deliberately removed
  earlier. Mention it as roadmap, not something to fake.
- **Offline mode** — needs a service worker + local caching layer; low
  demo value since you'll have internet at the venue anyway.
- **Quiz engine / exam predictor / study planner** — each needs its own
  data model (question banks, schedules) that doesn't exist yet. Good
  "what's next" bullets for your pitch, not something to fake tonight.

## Project structure

```
smart-classroom-assistant/
├── backend/
│   ├── app.py            FastAPI: auth (3 roles) + class sessions +
│   │                      hand-raise + chat + AI notes/Q&A/explain
│   ├── requirements.txt
│   ├── .env.example
│   ├── app.db             created automatically (SQLite)
│   └── recordings/        created automatically — uploaded class audio
├── frontend/
│   ├── index.html        Auth (3 role tabs) + teacher/student/college views
│   ├── style.css
│   └── app.js
└── README.md
```

## 1. Backend

```bash
cd backend
python -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate
pip install -r requirements.txt
```

Pick an AI provider — **Groq is free** (no card, 30 requests/min), **Anthropic** costs money after its one-time trial credit but is generally higher quality:

```bash
# Free option (default if you don't set anything):
export MODEL_PROVIDER=groq
export GROQ_API_KEY=gsk_...          # get one free at console.groq.com

# OR, paid option:
export MODEL_PROVIDER=anthropic
export ANTHROPIC_API_KEY=sk-ant-...  # get one at console.anthropic.com
```

Then start the server:

```bash
uvicorn app:app --reload --port 8000
```

Check http://localhost:8000/api/health → `{"status":"ok"}`.

**A heads-up about Groq specifically:** Groq's hosted model lineup changes more often than Anthropic's — they deprecated several models in 2026 already. If an AI feature suddenly starts erroring, check
[console.groq.com/docs/models](https://console.groq.com/docs/models) and
update `GROQ_TEXT_MODEL` / `GROQ_VISION_MODEL` as environment variables
(no code changes needed) — see `.env.example` for the exact variable names.

## 2. Frontend

```bash
cd frontend
python -m http.server 5500
```

Open **http://localhost:5500** in **Google Chrome** (Web Speech API is
Chrome-only). Grant mic permission when a teacher starts a class.

## Deploying — getting a real URL

The backend now serves the frontend itself (see `app.mount("/", ...)` at
the bottom of `app.py`), so **the whole app is one service** — one URL, no
separate frontend host, no CORS setup. `frontend/app.js` auto-detects
this and switches from `localhost:8000` to relative paths automatically.

Two files at the project root exist specifically to make Option B below
easy: **`.gitignore`** (keeps your database, recordings, and `venv/` out
of git) and **`render.yaml`** (a Render Blueprint — lets Render configure
the service automatically instead of you clicking through dashboard
settings by hand).

### Option A — Quick tunnel for tomorrow's demo (5 minutes, no signup)

If you just need a URL judges can open on their own phones/laptops during
your presentation, and you're fine running it from your own laptop at the
venue:

```bash
# Terminal 1 — run the backend as usual (it now serves the frontend too)
cd backend
uvicorn app:app --host 0.0.0.0 --port 8000

# Terminal 2 — expose it publicly
npx localtunnel --port 8000
# or, if you have ngrok installed:
ngrok http 8000
```

Either one prints a public `https://...` URL. Share that link — anyone
can open it and use the full app, live, running on your machine. Close the
tunnel when you're done; nothing is left running afterward.

**Trade-off:** it only works while your laptop is on, connected, and the
terminal stays open. Fine for a hackathon demo, not for anything longer.

### Option B — Real hosting on Render.com (a URL that stays up)

This repo includes a `render.yaml` at the root, so Render can configure
almost everything automatically — you mostly just connect the repo and
paste in your API key.

#### Step 1 — Get an API key ready

This project defaults to **Groq** — free, no credit card, 30 requests/min.
Go to [console.groq.com](https://console.groq.com), sign in, create an API
key. Copy it somewhere — you'll paste it into Render in Step 4, never into
any file that gets committed to git.

*(Prefer Claude's quality and don't mind paying after the trial credit?
Get a key at [console.anthropic.com](https://console.anthropic.com)
instead, and set `MODEL_PROVIDER=anthropic` in Step 4.)*

#### Step 2 — Push this project to GitHub

If you've never used git/GitHub before, this is the whole process:

1. Create a new empty repository on [github.com](https://github.com) —
   click the **+** in the top right → **New repository**. Give it a name
   (e.g. `smart-classroom-assistant`), leave it public or private, don't
   add a README (you already have one), click **Create repository**.
2. On your computer, open a terminal **in the project folder** (the one
   containing `backend/`, `frontend/`, `render.yaml`) and run:

   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/YOUR-REPO-NAME.git
   git push -u origin main
   ```

   Replace the URL in `git remote add origin` with the one GitHub shows
   you right after creating the repo (green **Code** button → copy the
   HTTPS URL).
3. Refresh the GitHub page — you should see all your files there. The
   `.gitignore` already included means your database, recordings, and any
   `venv/` folder won't be uploaded — only the actual code.

#### Step 3 — Create the Render service

1. Go to [render.com](https://render.com) and sign up/log in (GitHub
   login is the fastest option here since it can see your repos directly).
2. Click **New +** → **Blueprint**.
3. Connect your GitHub account if asked, then select the repo you just
   pushed.
4. Render reads `render.yaml` automatically and shows you a preview of
   the service it's about to create (name: `smart-classroom-assistant`,
   free plan, Python). Click **Apply**.

#### Step 4 — Add your API key

1. Once the service exists, open it in the Render dashboard.
2. Go to the **Environment** tab.
3. `render.yaml` already set `MODEL_PROVIDER` to `groq` for you (the free
   option). You'll see `GROQ_API_KEY` and `ANTHROPIC_API_KEY` listed but
   empty — that's on purpose (`sync: false` keeps them out of git). Click
   into `GROQ_API_KEY`, paste your real key from
   [console.groq.com](https://console.groq.com) (free, no card), and Save.
   *(Only fill in `ANTHROPIC_API_KEY` too if you set `MODEL_PROVIDER` to
   `anthropic` instead.)*
4. This triggers a redeploy automatically. Watch the **Logs** tab — you're
   looking for a line like `Uvicorn running on http://0.0.0.0:10000` and
   `Application startup complete`.

#### Step 5 — Open it

Render shows your live URL at the top of the service page, something like:

```
https://smart-classroom-assistant.onrender.com
```

Open that in Chrome — you should see the same login screen as local dev.
Register a teacher and student account and run through the demo exactly
like you did locally, just on a real public URL now.

#### About data persisting (read this before your actual event)

The free plan Render creates from `render.yaml` does **not** include a
persistent disk — every time the service restarts or you push new code,
`app.db` and any recorded videos reset to empty. For a hackathon demo
that's usually fine (you'll just re-register test accounts), but if you
want it to survive for longer:

1. In the Render dashboard, go to your service → **Settings** →
   **Instance Type**, and upgrade off the free plan (a persistent disk
   requires a paid instance — Render's cheapest paid tier works fine here).
2. Go to the **Disks** tab → **Add Disk**. Set:
   - **Mount Path:** `/opt/render/project/src/backend`
   - **Size:** 1 GB is plenty to start.
3. Save — Render redeploys with the disk attached, and from then on
   `app.db` and `recordings/` survive restarts and redeploys.

**Railway.app** and **Fly.io** work the same way in spirit if you'd
rather use one of those instead — connect the repo, same build/start
commands (`pip install -r requirements.txt` / `uvicorn app:app --host
0.0.0.0 --port $PORT`), set `ANTHROPIC_API_KEY`, attach a volume for the
`backend/` folder if you want persistence.

### Why not a fully serverless platform (Vercel/Netlify functions, etc.)?

This app needs a **long-running process** (WebSockets stay open) and a
**persistent disk** (SQLite database + recorded videos). Serverless
functions are designed to spin up per-request and not keep files between
calls — recordings and the database would vanish. Render/Railway/Fly (or
any plain VM) are the right shape for this app; serverless isn't, and
that's a real architectural reason, not just unfamiliarity.

## 3. Demo script

1. **Register a teacher** — name, email, password, college name (e.g. "ABC
   College"). Log in, type a subject, hit **Start Class** — grant camera
   *and* mic permission. Watch your own camera preview appear, and say
   something out loud to see the transcript fill in.
2. **Open a second browser tab/window**, register a **student** at the
   *same* college name, with "Deaf / hard of hearing" *and* "Can't speak"
   both checked, language set to Telugu. Within a few seconds their
   dashboard should pick up the live class and start showing captions.
3. On the student tab, tap **🤔 explain simply** — the explanation is in
   Telugu, since that's their profile. Say a sentence out loud that includes
   a glossary word (e.g. "does everyone understand? — good, thank you") and
   watch the matching **🤟 Sign Language Glossary** cards light up.
3b. Open the ⚙ accessibility toolbar — flip through the theme swatches,
   bump the font size, try **Magnifier mode**. Tap **🎴 Generate Flashcards**
   and **🧠 Generate Mind Map** in the Study Tools panel — both build from
   the live transcript. Try **📖 Reading Helper** — photograph any page of
   text nearby and watch it get read aloud and summarized. Watch the badge
   row light up as you use things.
4. Tap **🖐 Raise Hand**, then **🚨 Emergency Help** — switch to the teacher
   tab, watch both appear live, with the emergency one pulsing red at the
   top of the list.
5. Type into the student's **chat box** instead of speaking — switch to the
   teacher tab, watch the message arrive, reply from the teacher side.
6. Back on the teacher tab, hit **Stop Class** — watch the AI smart notes
   appear, plus the recorded video playing back right there. Notice the
   **accessibility snapshot** at the top of the teacher's panel too.
7. **Register a college admin** account (same college name), log in,
   search by subject/teacher/date — find the class you just ran, and click
   **🎥 Watch recording**.

## What got upgraded this round — real-time, security, and personalization

- **WebSockets, not just polling** — `/ws/class/{id}` pushes transcript
  chunks, hand-raises, and chat messages to everyone connected to that
  class the instant they happen. Polling still runs quietly in the
  background every 8s as a safety net (so a dropped socket doesn't lose
  anything), but the live feel now comes from real push, not refresh
  intervals.
- **Session tokens, not trust-the-client IDs** — register/login now issue
  a token. Starting/stopping a class, pushing transcript, uploading a
  recording, raising a hand, and sending chat all require
  `Authorization: Bearer <token>` — a student token literally cannot start
  a class (tested: returns `403`). Logging in again issues a fresh token
  and invalidates the old one.
- **Personalized Accessibility Profile that persists** — theme, font size,
  dyslexia font, focus mode, auto-read, simple language, magnifier, and
  voice commands are saved to the account (`PUT /api/settings`) and
  auto-applied on every future login — not just defaulted from the
  disability checkboxes at signup, but genuinely remembered per user.
- **MP4 recordings, when possible** — after a class ends, the backend
  tries to convert the browser's native WebM recording to MP4 using
  `ffmpeg`, *if it's installed on that machine*. If it's not, the WebM is
  kept — it still plays fine in any modern browser, so nothing breaks
  either way. This was tested end-to-end with a real video file.
- **Screen reader support** — a skip-to-content link, `aria-live` regions
  on captions and Q&A, `aria-expanded`/`aria-controls` on the accessibility
  menu, and visible keyboard focus rings throughout. Full NVDA/JAWS/VoiceOver
  certification is a bigger effort than a hackathon allows, but the
  fundamentals (landmarks, labels, keyboard reachability) are genuinely in
  place, not just claimed.

## Why SQLite is enough here — no separate "large data" database needed

Video and audio recordings are **never** stored inside SQLite — they're
saved as ordinary files in `backend/recordings/`, and the database only
holds the *file path* as a short text string. That's the same pattern any
production system uses (SQLite, Postgres, or otherwise) — databases store
references to media, not the media itself. So "SQLite can't handle large
files" isn't actually a risk here; there was nothing to fix.

## Honest scope notes for judges

- Auth is a lightweight SQLite + salted-hash + bearer-token setup — real
  and functional, but not hardened production auth (no token expiry/
  rotation, no rate limiting). Say so plainly if asked.
- **Encryption:** passwords are salted + hashed (not reversible) and never
  stored in plain text. Data in transit isn't encrypted in this local demo
  (that's what HTTPS/TLS would add in a real deployment — trivial to add
  behind any standard hosting provider, just not meaningful to fake on
  `localhost`). Recordings on disk aren't separately encrypted; a real
  deployment would use disk-level or cloud-provider encryption at rest.
- Recordings are saved as `.webm` or `.mp4` files on local disk — fine for
  a demo, would move to cloud storage (S3 etc.) for real deployment at
  scale, for the same reasons described above (not because SQLite is
  the wrong tool).

## If something breaks on stage

- **Student dashboard doesn't pick up the class:** double-check both
  accounts registered with the *exact same* college name (it's a plain
  text match).
- **No live captions:** Web Speech API is Chrome-only and needs mic
  permission granted on the *teacher's* device, not the student's.
- **Recording upload fails:** it's non-blocking — the class still stops
  and generates notes even if the video upload errors out.
- **"401 Unauthorized" on some action:** the browser's session token is
  missing or stale — log out and back in. This is also exactly what should
  happen if someone tries to hit the API directly without logging in first.
- **Live updates feel delayed instead of instant:** the WebSocket may have
  failed to connect (some restrictive networks block `ws://`) — the app
  automatically falls back to polling every 8s, so it still works, just
  slower. Check the browser console for a WebSocket error to confirm.
- **Recording stays a `.webm` instead of becoming `.mp4`:** that means
  `ffmpeg` isn't installed on the machine running the backend. Install it
  (`apt install ffmpeg` / `brew install ffmpeg` / winget) and it'll convert
  automatically next time — or just play the `.webm`, which works fine in
  any modern browser regardless.
- **Render build fails with `pydantic-core` / `metadata-generation-failed`:**
  this means Render used a newer Python version than `pydantic-core` has
  prebuilt wheels for (it's a Rust-based package, and Render's default
  Python creeps forward over time). This repo already pins
  `PYTHON_VERSION=3.11.11` in `render.yaml` and a `.python-version` file
  to prevent this — if you still hit it, double check both of those got
  pushed to GitHub, and that Render's Environment tab actually shows
  `PYTHON_VERSION` set to `3.11.11` (not blank).
