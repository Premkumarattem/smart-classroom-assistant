// ---------------------------------------------------------------
// Smart Classroom Assistant — frontend logic
//
// API_BASE auto-detects two situations:
//  - Local dev: frontend on :5500 (python http.server), backend on :8000
//    separately -> talk to http://localhost:8000
//  - Deployed: backend serves this frontend itself from the same origin
//    (see backend/app.py's StaticFiles mount, and the README's "Deploying"
//    section) -> use relative paths, which automatically work on whatever
//    domain/port it's actually deployed to
// ---------------------------------------------------------------
const isLocalStandalone =
  (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") &&
  window.location.port !== "8000";

const API_BASE = isLocalStandalone ? "http://localhost:8000" : "";
const WS_BASE = isLocalStandalone
  ? API_BASE.replace(/^http/, "ws")
  : (window.location.protocol === "https:" ? "wss://" : "ws://") + window.location.host;

let currentUser = null; // { id, name, email, disabilities, role, college_name, language, token, settings }
let selectedRegRole = "student";

// Every mutating request (start/stop class, hand-raise, chat, recording,
// settings) needs this — the backend rejects them without a valid token.
function authHeaders(extra = {}) {
  return currentUser && currentUser.token
    ? { ...extra, Authorization: `Bearer ${currentUser.token}` }
    : extra;
}

// Screen-reader / keyboard support: jump straight past the header to
// whichever dashboard's <main> is currently visible.
document.getElementById("skipLinkBtn").addEventListener("click", (e) => {
  e.preventDefault();
  const target = [teacherScreenMain(), studentScreenMain(), collegeScreenMain()].find(isVisible);
  target?.focus();
});
function isVisible(el) {
  return !!el && el.offsetParent !== null;
}
function teacherScreenMain() { return document.querySelector("#teacherScreen main"); }
function studentScreenMain() { return document.querySelector("#studentScreen main"); }
function collegeScreenMain() { return document.querySelector("#collegeScreen main"); }

// =================================================================
// AUTH SCREEN
// =================================================================
const authScreen = document.getElementById("authScreen");
const teacherScreen = document.getElementById("teacherScreen");
const studentScreen = document.getElementById("studentScreen");
const collegeScreen = document.getElementById("collegeScreen");
const loginForm = document.getElementById("loginForm");
const registerForm = document.getElementById("registerForm");
const disabilityFieldset = document.getElementById("disabilityFieldset");

document.getElementById("showRegister").addEventListener("click", (e) => {
  e.preventDefault();
  loginForm.classList.add("hidden");
  registerForm.classList.remove("hidden");
});
document.getElementById("showLogin").addEventListener("click", (e) => {
  e.preventDefault();
  registerForm.classList.add("hidden");
  loginForm.classList.remove("hidden");
});

document.querySelectorAll(".role-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".role-tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    selectedRegRole = tab.dataset.role;
    disabilityFieldset.classList.toggle("hidden", selectedRegRole !== "student");
  });
});

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = document.getElementById("loginEmail").value.trim();
  const password = document.getElementById("loginPassword").value;
  const errEl = document.getElementById("loginError");
  errEl.textContent = "";
  try {
    const res = await fetch(`${API_BASE}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Login failed");
    onAuthSuccess(data.user);
  } catch (err) {
    errEl.textContent = err.message.includes("Failed to fetch")
      ? `Can't reach the backend at ${API_BASE}. Is it running?`
      : err.message;
  }
});

registerForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = document.getElementById("regName").value.trim();
  const email = document.getElementById("regEmail").value.trim();
  const password = document.getElementById("regPassword").value;
  const college_name = document.getElementById("regCollege").value.trim();
  const language = document.getElementById("regLanguage").value;
  const disabilities = selectedRegRole === "student"
    ? Array.from(registerForm.querySelectorAll('input[type="checkbox"]:checked')).map((cb) => cb.value)
    : [];
  const errEl = document.getElementById("registerError");
  errEl.textContent = "";

  try {
    const res = await fetch(`${API_BASE}/api/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, email, password, role: selectedRegRole, college_name, language, disabilities }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Registration failed");
    onAuthSuccess(data.user);
  } catch (err) {
    errEl.textContent = err.message.includes("Failed to fetch")
      ? `Can't reach the backend at ${API_BASE}. Is it running?`
      : err.message;
  }
});

function onAuthSuccess(user) {
  currentUser = user;
  localStorage.setItem("sca_user", JSON.stringify(user));
  routeToDashboard();
}

function logout() {
  localStorage.removeItem("sca_user");
  currentUser = null;
  stopAllPolling();
  [teacherScreen, studentScreen, collegeScreen].forEach((s) => s.classList.add("hidden"));
  document.getElementById("a11yToolbar").classList.add("hidden");
  authScreen.classList.remove("hidden");
}
document.getElementById("logoutBtnTeacher").addEventListener("click", logout);
document.getElementById("logoutBtnStudent").addEventListener("click", logout);
document.getElementById("logoutBtnCollege").addEventListener("click", logout);

function routeToDashboard() {
  authScreen.classList.add("hidden");
  [teacherScreen, studentScreen, collegeScreen].forEach((s) => s.classList.add("hidden"));

  if (currentUser.role === "teacher") {
    teacherScreen.classList.remove("hidden");
    document.getElementById("welcomeUserTeacher").textContent = currentUser.name;
    document.getElementById("teacherCollegeLabel").textContent = currentUser.college_name || "College";
    loadAccessibilitySnapshot();
  } else if (currentUser.role === "college") {
    collegeScreen.classList.remove("hidden");
    document.getElementById("welcomeUserCollege").textContent = `${currentUser.name} · ${currentUser.college_name}`;
    loadCollegeClasses();
  } else {
    studentScreen.classList.remove("hidden");
    document.getElementById("welcomeUserStudent").textContent = currentUser.name;
    document.getElementById("a11yToolbar").classList.remove("hidden");
    const hadSavedSettings = applySavedSettings(currentUser.settings);
    if (!hadSavedSettings) applyAccessibilityProfile(currentUser.disabilities || []);
    else applyFontLevel();
    renderBadges();
    renderSignGlossary();
    startStudentPolling();
  }
}

async function loadAccessibilitySnapshot() {
  const el = document.getElementById("a11ySnapshotContent");
  try {
    const params = new URLSearchParams({ college_name: currentUser.college_name || "" });
    const res = await fetch(`${API_BASE}/api/accessibility-stats?${params.toString()}`);
    const data = await res.json();
    const labels = { vision: "Vision", hearing: "Hearing", speech: "Speech", dyslexia: "Dyslexia", adhd: "ADHD", motor: "Motor" };
    const chips = Object.entries(data.counts)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `<span class="stat-chip"><strong>${n}</strong> ${labels[k] || k}</span>`)
      .join("");
    el.innerHTML = `<span class="stat-chip"><strong>${data.total_students}</strong> students</span>` +
      (chips || '<span class="stat-chip">No accessibility needs on file yet</span>');
  } catch (e) {
    el.innerHTML = '<span class="placeholder">Couldn\'t load — is the backend running?</span>';
  }
}

// Auto-login if a session is already stored in this browser
(function restoreSession() {
  const saved = localStorage.getItem("sca_user");
  if (saved) {
    try {
      currentUser = JSON.parse(saved);
      routeToDashboard();
    } catch (e) {
      localStorage.removeItem("sca_user");
    }
  }
})();

function stopAllPolling() {
  [handRaisePoll, teacherChatPoll, studentClassPoll, studentTranscriptPoll, studentChatPoll].forEach((id) => {
    if (id) clearInterval(id);
  });
  closeTeacherWebSocket();
  closeStudentWebSocket();
}

// =================================================================
// Clocks
// =================================================================
function tick() {
  const t = new Date().toLocaleTimeString();
  ["clockTeacher", "clockStudent"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.textContent = t;
  });
}
setInterval(tick, 1000);
tick();

// =================================================================
// ACCESSIBILITY: profile-driven defaults + manual toolbar (student only)
// =================================================================
const a11yToggle = document.getElementById("a11yToggle");
const a11yPanel = document.getElementById("a11yPanel");
a11yToggle.addEventListener("click", () => {
  const nowHidden = a11yPanel.classList.toggle("hidden");
  a11yToggle.setAttribute("aria-expanded", String(!nowHidden));
});

const toggleDyslexiaFont = document.getElementById("toggleDyslexiaFont");
const toggleFocusMode = document.getElementById("toggleFocusMode");
const toggleAutoRead = document.getElementById("toggleAutoRead");
const toggleSimpleLanguage = document.getElementById("toggleSimpleLanguage");
const toggleMagnifier = document.getElementById("toggleMagnifier");
const toggleVoiceCommands = document.getElementById("toggleVoiceCommands");

// ---- Personalized Accessibility Profile: save to the account, debounced ----
let settingsSaveTimer = null;
function currentSettingsSnapshot() {
  return {
    theme: document.querySelector(".theme-swatch.active")?.dataset.theme || "default",
    fontLevel,
    dyslexiaFont: toggleDyslexiaFont.checked,
    focusMode: toggleFocusMode.checked,
    autoRead: toggleAutoRead.checked,
    simpleLanguage: toggleSimpleLanguage.checked,
    magnifier: toggleMagnifier.checked,
    voiceCommands: toggleVoiceCommands.checked,
  };
}
function saveSettingsDebounced() {
  if (!currentUser || !currentUser.token) return;
  clearTimeout(settingsSaveTimer);
  settingsSaveTimer = setTimeout(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/settings`, {
        method: "PUT",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ settings: currentSettingsSnapshot() }),
      });
      const data = await res.json();
      if (data.user) {
        currentUser = data.user;
        localStorage.setItem("sca_user", JSON.stringify(currentUser));
      }
    } catch (e) { /* non-critical — local state is still correct either way */ }
  }, 600);
}

// Apply a previously-saved settings object (called on login, before any
// disability-profile defaults so a returning user's own choices win).
function applySavedSettings(settings) {
  if (!settings || !Object.keys(settings).length) return false;
  if (settings.theme && settings.theme !== "default") {
    document.querySelectorAll(".theme-swatch").forEach((b) => b.classList.remove("active"));
    document.querySelector(`.theme-swatch[data-theme="${settings.theme}"]`)?.classList.add("active");
    document.body.classList.remove("theme-bw", "theme-yb", "theme-blue");
    document.body.classList.add(`theme-${settings.theme}`);
  }
  if (typeof settings.fontLevel === "number") fontLevel = settings.fontLevel;
  toggleDyslexiaFont.checked = !!settings.dyslexiaFont;
  toggleFocusMode.checked = !!settings.focusMode;
  toggleAutoRead.checked = !!settings.autoRead;
  toggleSimpleLanguage.checked = !!settings.simpleLanguage;
  toggleMagnifier.checked = !!settings.magnifier;
  toggleVoiceCommands.checked = !!settings.voiceCommands;
  autoReadAnswers = toggleAutoRead.checked;
  simpleLanguageMode = toggleSimpleLanguage.checked;
  document.body.classList.toggle("dyslexia-font", toggleDyslexiaFont.checked);
  document.body.classList.toggle("focus-mode", toggleFocusMode.checked);
  document.body.classList.toggle("magnifier-active", toggleMagnifier.checked);
  if (toggleVoiceCommands.checked) startVoiceCommands();
  return true;
}

toggleDyslexiaFont.addEventListener("change", () => { document.body.classList.toggle("dyslexia-font", toggleDyslexiaFont.checked); saveSettingsDebounced(); });
toggleFocusMode.addEventListener("change", () => { document.body.classList.toggle("focus-mode", toggleFocusMode.checked); saveSettingsDebounced(); });

let autoReadAnswers = false;
toggleAutoRead.addEventListener("change", () => { autoReadAnswers = toggleAutoRead.checked; saveSettingsDebounced(); });

let simpleLanguageMode = false;
toggleSimpleLanguage.addEventListener("change", () => { simpleLanguageMode = toggleSimpleLanguage.checked; saveSettingsDebounced(); });

// ---- Theme presets ----
document.querySelectorAll(".theme-swatch").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".theme-swatch").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    document.body.classList.remove("theme-bw", "theme-yb", "theme-blue");
    const theme = btn.dataset.theme;
    if (theme !== "default") document.body.classList.add(`theme-${theme}`);
    saveSettingsDebounced();
  });
});

// ---- Font size presets (S/M/L/XL) ----
let fontLevel = 1;
function applyFontLevel() {
  document.body.classList.remove("text-small", "text-large", "text-xlarge");
  if (fontLevel === 0) document.body.classList.add("text-small");
  if (fontLevel === 2) document.body.classList.add("text-large");
  if (fontLevel === 3) document.body.classList.add("text-xlarge");
  document.querySelectorAll(".fs-btn").forEach((b) => b.classList.toggle("active", Number(b.dataset.size) === fontLevel));
}
document.querySelectorAll(".fs-btn").forEach((btn) => {
  btn.addEventListener("click", () => { fontLevel = Number(btn.dataset.size); applyFontLevel(); saveSettingsDebounced(); });
});

// ---- Magnifier mode ----
const magnifierGlass = document.getElementById("magnifierGlass");
toggleMagnifier.addEventListener("change", () => {
  document.body.classList.toggle("magnifier-active", toggleMagnifier.checked);
  saveSettingsDebounced();
});
document.addEventListener("mousemove", (e) => {
  if (!document.body.classList.contains("magnifier-active")) return;
  magnifierGlass.style.left = `${e.clientX - 110}px`;
  magnifierGlass.style.top = `${e.clientY - 110}px`;
  magnifierGlass.style.backgroundImage = "none";
});

// ---- Voice commands (student side, separate from the teacher's lecture mic) ----
let voiceCommandRecognition = null;
toggleVoiceCommands.addEventListener("change", () => {
  if (toggleVoiceCommands.checked) startVoiceCommands();
  else if (voiceCommandRecognition) voiceCommandRecognition.stop();
  saveSettingsDebounced();
});

function startVoiceCommands() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) { alert("Voice commands need Chrome."); toggleVoiceCommands.checked = false; return; }
  voiceCommandRecognition = new SpeechRecognition();
  voiceCommandRecognition.continuous = true;
  voiceCommandRecognition.interimResults = false;
  voiceCommandRecognition.lang = "en-US";
  voiceCommandRecognition.onresult = (event) => {
    const said = event.results[event.results.length - 1][0].transcript.toLowerCase();
    if (said.includes("explain")) document.getElementById("explainBtn").click();
    else if (said.includes("raise hand") || said.includes("raise my hand")) document.getElementById("raiseHandBtn").click();
    else if (said.includes("ask a question") || said.includes("ask question")) document.getElementById("qaInput").focus();
    else if (said.includes("flashcard")) document.getElementById("flashcardsBtn").click();
    else if (said.includes("mind map")) document.getElementById("mindmapBtn").click();
  };
  voiceCommandRecognition.onend = () => { if (toggleVoiceCommands.checked) voiceCommandRecognition.start(); };
  voiceCommandRecognition.start();
}

function applyAccessibilityProfile(disabilities) {
  const has = (d) => disabilities.includes(d);
  if (has("vision")) {
    document.querySelectorAll(".theme-swatch").forEach((b) => b.classList.remove("active"));
    document.querySelector('.theme-swatch[data-theme="bw"]').classList.add("active");
    document.body.classList.add("theme-bw");
    toggleAutoRead.checked = true; autoReadAnswers = true;
    fontLevel = 2;
  }
  if (has("dyslexia")) { toggleDyslexiaFont.checked = true; fontLevel = Math.max(fontLevel, 2); }
  if (has("adhd")) { toggleFocusMode.checked = true; }
  if (has("motor")) { document.body.classList.add("big-targets"); }
  // hearing / speech: the dashboard is already text-first (captions + chat),
  // which is exactly what these profiles need most — nothing extra to flip.
  document.body.classList.toggle("dyslexia-font", toggleDyslexiaFont.checked);
  document.body.classList.toggle("focus-mode", toggleFocusMode.checked);
  applyFontLevel();
}

function speak(text) {
  if (!("speechSynthesis" in window) || !text) return;
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  const langMap = { telugu: "te-IN", hindi: "hi-IN", english: "en-US" };
  utter.lang = langMap[currentUser?.language] || "en-US";
  utter.rate = 0.98;
  window.speechSynthesis.speak(utter);
}

document.getElementById("readNotesBtn").addEventListener("click", () => speak(document.getElementById("notesContent").innerText));
document.getElementById("readExplainBtn").addEventListener("click", () => speak(document.getElementById("explainText").textContent));

// Helper: current disabilities array plus "simple" if Simple Language Mode is on
function currentDisabilitiesForRequest() {
  const base = currentUser ? [...currentUser.disabilities] : [];
  if (simpleLanguageMode && !base.includes("simple")) base.push("simple");
  return base;
}

// =================================================================
// Achievement badges (lightweight, session-based — no backend needed)
// =================================================================
const badgeDefs = [
  { id: "curious", icon: "🔍", label: "Curious Mind", need: 3, track: "questions" },
  { id: "quick", icon: "⚡", label: "Quick Learner", need: 3, track: "explains" },
  { id: "explorer", icon: "🧭", label: "Accessibility Explorer", need: 1, track: "a11yUsed" },
  { id: "consistent", icon: "📌", label: "Consistent Learner", need: 5, track: "questions" },
];
const badgeCounts = { questions: 0, explains: 0, a11yUsed: 0 };

function renderBadges() {
  const row = document.getElementById("badgeRow");
  if (!row) return;
  row.innerHTML = badgeDefs.map((b) => {
    const earned = badgeCounts[b.track] >= b.need;
    return `<span class="badge-chip ${earned ? "earned" : ""}">${b.icon} ${b.label}</span>`;
  }).join("");
}
function trackActivity(kind) {
  if (badgeCounts[kind] !== undefined) badgeCounts[kind] += 1;
  renderBadges();
}
document.querySelectorAll(".a11y-row input").forEach((el) => {
  el.addEventListener("change", () => trackActivity("a11yUsed"));
});

// =================================================================
// TEACHER DASHBOARD
// =================================================================
let teacherSessionId = null;
let teacherRecognition = null;
let teacherListening = false;
let teacherFullTranscript = "";
let mediaRecorder = null;
let recordedChunks = [];
let handRaisePoll = null;
let teacherChatPoll = null;
let teacherLastChatId = 0;

document.getElementById("startClassBtn").addEventListener("click", async () => {
  const subject = document.getElementById("subjectInput").value.trim();
  if (!subject) { alert("Enter a subject first."); return; }

  try {
    const res = await fetch(`${API_BASE}/api/classes/start`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        teacher_id: currentUser.id, teacher_name: currentUser.name,
        college_name: currentUser.college_name, subject,
      }),
    });
    const data = await res.json();
    teacherSessionId = data.session_id;
  } catch (err) {
    alert(`Couldn't reach the backend at ${API_BASE}. Is it running?`);
    return;
  }

  document.getElementById("classStartForm").classList.add("hidden");
  document.getElementById("classActivePanel").classList.remove("hidden");
  document.getElementById("classNotesPanel").classList.add("hidden");
  document.getElementById("activeSubjectLabel").textContent = subject;
  document.getElementById("transcriptBoxTeacher").innerHTML = '<p class="placeholder">Listening…</p>';
  teacherFullTranscript = "";

  startTeacherSpeechRecognition();
  startTeacherRecording();
  connectTeacherWebSocket(teacherSessionId);
  handRaisePoll = setInterval(pollHandRaises, 8000);   // safety net — WS handles instant updates
  teacherChatPoll = setInterval(pollTeacherChat, 8000); // safety net — WS handles instant updates
  teacherLastChatId = 0;
  document.getElementById("teacherChatThread").innerHTML = '<p class="placeholder">Messages from students who can\'t speak will appear here.</p>';
});

let teacherWS = null;
function connectTeacherWebSocket(sessionId) {
  if (teacherWS) teacherWS.close();
  teacherWS = new WebSocket(`${WS_BASE}/ws/class/${sessionId}`);
  teacherWS.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "hand_raise") pollHandRaises();
    if (msg.type === "chat") pollTeacherChat();
  };
  teacherWS.onerror = () => console.warn("Teacher WebSocket error — falling back to polling only.");
}
function closeTeacherWebSocket() {
  if (teacherWS) { teacherWS.close(); teacherWS = null; }
}

function appendTeacherTranscriptLine(text) {
  const box = document.getElementById("transcriptBoxTeacher");
  if (box.querySelector(".placeholder")) box.innerHTML = "";
  const p = document.createElement("p");
  p.className = "line";
  p.textContent = text;
  box.appendChild(p);
  box.scrollTop = box.scrollHeight;
}

function startTeacherSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    alert("Live captions need Chrome (Web Speech API not supported here). Recording will still work.");
    return;
  }
  teacherRecognition = new SpeechRecognition();
  teacherRecognition.continuous = true;
  teacherRecognition.interimResults = false;
  teacherRecognition.lang = "en-US";

  teacherRecognition.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      if (event.results[i].isFinal) {
        const text = event.results[i][0].transcript.trim();
        if (!text) continue;
        teacherFullTranscript += (teacherFullTranscript ? " " : "") + text;
        appendTeacherTranscriptLine(text);
        if (teacherSessionId) {
          fetch(`${API_BASE}/api/classes/${teacherSessionId}/transcript`, {
            method: "POST",
            headers: authHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify({ chunk: text }),
          }).catch(() => {});
        }
      }
    }
  };
  teacherRecognition.onend = () => { if (teacherListening) teacherRecognition.start(); };
  teacherListening = true;
  teacherRecognition.start();
}

let teacherCamStream = null;

async function startTeacherRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    teacherCamStream = stream;
    const preview = document.getElementById("teacherCamPreview");
    preview.srcObject = stream;

    const mimeCandidates = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
    const mimeType = mimeCandidates.find((m) => MediaRecorder.isTypeSupported(m)) || "";

    recordedChunks = [];
    mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
    mediaRecorder.start();
  } catch (err) {
    console.warn("Camera/mic recording unavailable, falling back to audio only:", err);
    try {
      const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recordedChunks = [];
      mediaRecorder = new MediaRecorder(audioStream);
      mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
      mediaRecorder.start();
    } catch (err2) {
      console.warn("No recording available at all:", err2);
    }
  }
}

function stopTeacherCamPreview() {
  if (teacherCamStream) {
    teacherCamStream.getTracks().forEach((t) => t.stop());
    teacherCamStream = null;
  }
}

let teacherRecordingPath = null;

document.getElementById("stopClassBtn").addEventListener("click", async () => {
  teacherListening = false;
  if (teacherRecognition) teacherRecognition.stop();
  clearInterval(handRaisePoll);
  clearInterval(teacherChatPoll);
  closeTeacherWebSocket();

  const stopBtn = document.getElementById("stopClassBtn");
  stopBtn.disabled = true;
  stopBtn.textContent = "Generating smart notes…";
  teacherRecordingPath = null;

  // Stop recording and upload the video+audio blob, if we have one
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    await new Promise((resolve) => {
      mediaRecorder.onstop = resolve;
      mediaRecorder.stop();
    });
    stopTeacherCamPreview();
    if (recordedChunks.length) {
      const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || "video/webm" });
      const formData = new FormData();
      formData.append("file", blob, "class.webm");
      try {
        const upRes = await fetch(`${API_BASE}/api/classes/${teacherSessionId}/recording`, {
          method: "POST", headers: authHeaders(), body: formData,
        });
        const upData = await upRes.json();
        teacherRecordingPath = upData.recording_path;
      } catch (e) { console.warn("Recording upload failed:", e); }
    }
  }

  try {
    const res = await fetch(`${API_BASE}/api/classes/${teacherSessionId}/stop`, {
      method: "POST", headers: authHeaders(),
    });
    const data = await res.json();
    document.getElementById("classNotesPanel").classList.remove("hidden");
    document.getElementById("smartNotesContent").innerText = data.ai_notes;
    // /stop may have converted the recording to .mp4 — use whatever path it reports
    const finalPath = data.recording_path || teacherRecordingPath;
    const playback = document.getElementById("recordingPlayback");
    playback.innerHTML = finalPath
      ? `<h3 class="mini-head">Class Recording</h3><video controls src="${API_BASE}${finalPath}"></video>`
      : "";
  } catch (err) {
    document.getElementById("classNotesPanel").classList.remove("hidden");
    document.getElementById("smartNotesContent").innerText = `Couldn't reach the backend at ${API_BASE}.`;
  }

  stopBtn.disabled = false;
  stopBtn.textContent = "■ Stop Class & Generate Smart Notes";
  document.getElementById("classActivePanel").classList.add("hidden");
  document.getElementById("classStartForm").classList.remove("hidden");
  document.getElementById("subjectInput").value = "";
  teacherSessionId = null;
});

async function pollHandRaises() {
  if (!teacherSessionId) return;
  try {
    const res = await fetch(`${API_BASE}/api/hand-raise?session_id=${teacherSessionId}`);
    const data = await res.json();
    const list = document.getElementById("handRaiseList");
    list.innerHTML = "";
    if (!data.raised.length) {
      list.innerHTML = '<li class="placeholder">No hands raised yet.</li>';
      return;
    }
    data.raised.forEach((r) => {
      const li = document.createElement("li");
      if (r.urgent) li.classList.add("urgent");
      const time = new Date(r.raised_at).toLocaleTimeString();
      const icon = r.urgent ? "🚨" : "🖐";
      li.innerHTML = `<span>${icon} <strong>${r.student_name}</strong> · ${time}${r.urgent ? " · URGENT" : ""}</span>`;
      const btn = document.createElement("button");
      btn.className = "resolve-btn";
      btn.textContent = "Acknowledge";
      btn.addEventListener("click", async () => {
        await fetch(`${API_BASE}/api/hand-raise/${r.id}/resolve`, { method: "POST", headers: authHeaders() });
        pollHandRaises();
      });
      li.appendChild(btn);
      list.appendChild(li);
    });
  } catch (e) { /* silent — next poll will retry */ }
}

async function pollTeacherChat() {
  if (!teacherSessionId) return;
  try {
    const res = await fetch(`${API_BASE}/api/chat?session_id=${teacherSessionId}&since_id=${teacherLastChatId}`);
    const data = await res.json();
    const thread = document.getElementById("teacherChatThread");
    data.messages.forEach((m) => {
      if (thread.querySelector(".placeholder")) thread.innerHTML = "";
      const div = document.createElement("div");
      div.className = "qa-item";
      div.innerHTML = `<div class="q">${m.sender_role === "teacher" ? "You" : m.sender_name}</div><div class="a">${m.message}</div>`;
      thread.appendChild(div);
      teacherLastChatId = Math.max(teacherLastChatId, m.id);
    });
    thread.scrollTop = thread.scrollHeight;
  } catch (e) { /* silent */ }
}

document.getElementById("teacherChatForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("teacherChatInput");
  const message = input.value.trim();
  if (!message || !teacherSessionId) return;
  input.value = "";
  await fetch(`${API_BASE}/api/chat`, {
    method: "POST", headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ session_id: teacherSessionId, sender_name: currentUser.name, sender_role: "teacher", message }),
  });
  pollTeacherChat();
});

// =================================================================
// STUDENT DASHBOARD
// =================================================================
let studentSessionId = null;
let studentFullTranscript = "";
let studentClassPoll = null;
let studentTranscriptPoll = null;
let studentChatPoll = null;
let studentLastChatId = 0;
let lastRenderedTranscriptLen = 0;

function startStudentPolling() {
  pollForActiveClass();
  studentClassPoll = setInterval(pollForActiveClass, 4000);
}

async function pollForActiveClass() {
  try {
    const params = new URLSearchParams({ status: "active" });
    if (currentUser.college_name) params.set("college_name", currentUser.college_name);
    const res = await fetch(`${API_BASE}/api/classes?${params.toString()}`);
    const data = await res.json();
    if (data.classes.length) {
      const active = data.classes[0];
      if (active.id !== studentSessionId) {
        studentSessionId = active.id;
        lastRenderedTranscriptLen = 0;
        studentFullTranscript = "";
        document.getElementById("noActiveClassMsg").textContent = `Live now: ${active.subject} — ${active.teacher_name}`;
        document.getElementById("transcriptBoxStudent").innerHTML = '<p class="placeholder">Listening for captions…</p>';
        if (studentTranscriptPoll) clearInterval(studentTranscriptPoll);
        studentTranscriptPoll = setInterval(pollStudentTranscript, 8000); // safety net — WS handles instant updates
        if (studentChatPoll) clearInterval(studentChatPoll);
        studentLastChatId = 0;
        document.getElementById("studentChatThread").innerHTML = '<p class="placeholder">Type instead of speaking — the teacher sees this live.</p>';
        studentChatPoll = setInterval(pollStudentChat, 8000); // safety net — WS handles instant updates
        connectStudentWebSocket(active.id);
      }
    } else if (studentSessionId !== null) {
      studentSessionId = null;
      clearInterval(studentTranscriptPoll);
      clearInterval(studentChatPoll);
      closeStudentWebSocket();
      document.getElementById("noActiveClassMsg").textContent = "No class is live right now for your college. This checks every few seconds.";
    }
  } catch (e) { /* silent — keep trying */ }
}

let studentWS = null;
function connectStudentWebSocket(sessionId) {
  if (studentWS) studentWS.close();
  studentWS = new WebSocket(`${WS_BASE}/ws/class/${sessionId}`);
  studentWS.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "transcript") appendLiveTranscriptChunk(msg.chunk);
    if (msg.type === "chat") pollStudentChat();
  };
  studentWS.onerror = () => console.warn("Student WebSocket error — falling back to polling only.");
}
function closeStudentWebSocket() {
  if (studentWS) { studentWS.close(); studentWS = null; }
}

function appendLiveTranscriptChunk(chunk) {
  if (!chunk) return;
  studentFullTranscript = (studentFullTranscript + " " + chunk).trim();
  lastRenderedTranscriptLen = studentFullTranscript.length;
  const box = document.getElementById("transcriptBoxStudent");
  if (box.querySelector(".placeholder")) box.innerHTML = "";
  const p = document.createElement("p");
  p.className = "line";
  p.textContent = chunk.trim();
  box.appendChild(p);
  box.scrollTop = box.scrollHeight;
  flashMatchingSignCards(chunk);
}

async function pollStudentTranscript() {
  if (!studentSessionId) return;
  try {
    const res = await fetch(`${API_BASE}/api/classes/${studentSessionId}`);
    const data = await res.json();
    studentFullTranscript = data.session.transcript || "";
    if (studentFullTranscript.length > lastRenderedTranscriptLen) {
      const box = document.getElementById("transcriptBoxStudent");
      if (box.querySelector(".placeholder")) box.innerHTML = "";
      const newText = studentFullTranscript.slice(lastRenderedTranscriptLen);
      const p = document.createElement("p");
      p.className = "line";
      p.textContent = newText.trim();
      box.appendChild(p);
      box.scrollTop = box.scrollHeight;
      lastRenderedTranscriptLen = studentFullTranscript.length;
      flashMatchingSignCards(newText);
    }
    if (data.session.status === "ended") {
      clearInterval(studentTranscriptPoll);
    }
  } catch (e) { /* silent */ }
}

async function pollStudentChat() {
  if (!studentSessionId) return;
  try {
    const res = await fetch(`${API_BASE}/api/chat?session_id=${studentSessionId}&since_id=${studentLastChatId}`);
    const data = await res.json();
    const thread = document.getElementById("studentChatThread");
    data.messages.forEach((m) => {
      if (thread.querySelector(".placeholder")) thread.innerHTML = "";
      const div = document.createElement("div");
      div.className = "qa-item";
      const label = m.sender_role === "teacher" ? "Teacher" : (m.sender_name === currentUser.name ? "You" : m.sender_name);
      div.innerHTML = `<div class="q">${label}</div><div class="a">${m.message}</div>`;
      thread.appendChild(div);
      studentLastChatId = Math.max(studentLastChatId, m.id);
    });
    thread.scrollTop = thread.scrollHeight;
  } catch (e) { /* silent */ }
}

document.getElementById("studentChatForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("studentChatInput");
  const message = input.value.trim();
  if (!message || !studentSessionId) return;
  input.value = "";
  await fetch(`${API_BASE}/api/chat`, {
    method: "POST", headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ session_id: studentSessionId, sender_name: currentUser.name, sender_role: "student", message }),
  });
  pollStudentChat();
});

document.getElementById("raiseHandBtn").addEventListener("click", async () => {
  if (!studentSessionId) { alert("No live class to raise your hand in yet."); return; }
  const btn = document.getElementById("raiseHandBtn");
  btn.disabled = true;
  btn.textContent = "🖐 Hand raised — teacher notified";
  await fetch(`${API_BASE}/api/hand-raise`, {
    method: "POST", headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ session_id: studentSessionId, student_name: currentUser.name }),
  });
  setTimeout(() => { btn.disabled = false; btn.textContent = "🖐 Raise Hand"; }, 8000);
});

document.getElementById("emergencyBtn").addEventListener("click", async () => {
  if (!studentSessionId) { alert("No live class right now."); return; }
  const btn = document.getElementById("emergencyBtn");
  btn.disabled = true;
  btn.textContent = "🚨 Teacher notified — urgent";
  await fetch(`${API_BASE}/api/hand-raise`, {
    method: "POST", headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ session_id: studentSessionId, student_name: currentUser.name, urgent: true }),
  });
  setTimeout(() => { btn.disabled = false; btn.textContent = "🚨 Emergency Help"; }, 8000);
});

// ---- Notes / explain / ask (same ideas as before, now backed by the live class transcript) ----
async function refreshNotes() {
  const notesEl = document.getElementById("notesContent");
  try {
    const res = await fetch(`${API_BASE}/api/summarize`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transcript: studentFullTranscript,
        disabilities: currentDisabilitiesForRequest(),
        language: currentUser ? currentUser.language : "english",
      }),
    });
    const data = await res.json();
    const bullets = data.summary.split("\n").map((l) => l.replace(/^[-•*]\s*/, "").trim()).filter(Boolean);
    notesEl.innerHTML = `<ul>${bullets.map((b) => `<li>${b}</li>`).join("")}</ul>`;
    if (autoReadAnswers) speak(bullets.join(". "));
  } catch (err) {
    notesEl.innerHTML = `<p class="placeholder">Couldn't reach the backend at ${API_BASE}.</p>`;
  }
}
document.getElementById("summarizeBtn").addEventListener("click", refreshNotes);

const explainBtn = document.getElementById("explainBtn");
const explainCard = document.getElementById("explainCard");
const explainText = document.getElementById("explainText");

explainBtn.addEventListener("click", async () => {
  if (!studentFullTranscript.trim()) {
    explainCard.classList.remove("hidden");
    explainText.textContent = "Nothing's been said yet — once a class is live, this button will re-explain whatever the teacher just said.";
    return;
  }
  explainBtn.disabled = true;
  explainBtn.classList.add("loading");
  explainBtn.textContent = "Thinking of a simpler way to say that…";
  explainCard.classList.remove("hidden");
  explainText.textContent = "";
  try {
    const res = await fetch(`${API_BASE}/api/explain`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transcript: studentFullTranscript,
        disabilities: currentDisabilitiesForRequest(),
        language: currentUser ? currentUser.language : "english",
      }),
    });
    const data = await res.json();
    explainText.textContent = data.explanation;
    if (autoReadAnswers) speak(data.explanation);
    trackActivity("explains");
  } catch (err) {
    explainText.textContent = `Couldn't reach the backend at ${API_BASE}.`;
  } finally {
    explainBtn.disabled = false;
    explainBtn.classList.remove("loading");
    explainBtn.textContent = "🤔 I didn't understand that — explain simply";
  }
});

document.getElementById("qaForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("qaInput");
  const question = input.value.trim();
  if (!question) return;
  input.value = "";
  const thread = document.getElementById("qaThread");
  if (thread.querySelector(".placeholder")) thread.innerHTML = "";
  const item = document.createElement("div");
  item.className = "qa-item";
  item.innerHTML = `<div class="q">Q: ${question}</div><div class="a">Thinking…</div>`;
  thread.appendChild(item);
  thread.scrollTop = thread.scrollHeight;
  try {
    const res = await fetch(`${API_BASE}/api/ask`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transcript: studentFullTranscript, question,
        disabilities: currentDisabilitiesForRequest(),
        language: currentUser ? currentUser.language : "english",
      }),
    });
    const data = await res.json();
    item.querySelector(".a").textContent = data.answer;
    if (autoReadAnswers) speak(data.answer);
    trackActivity("questions");
  } catch (err) {
    item.querySelector(".a").textContent = `Couldn't reach the backend at ${API_BASE}.`;
  }
  thread.scrollTop = thread.scrollHeight;
});

// =================================================================
// COLLEGE DASHBOARD
// =================================================================
async function loadCollegeClasses() {
  const params = new URLSearchParams();
  if (currentUser.college_name) params.set("college_name", currentUser.college_name);
  const subject = document.getElementById("filterSubject").value.trim();
  const teacher = document.getElementById("filterTeacher").value.trim();
  const date = document.getElementById("filterDate").value;
  if (subject) params.set("subject", subject);
  if (teacher) params.set("teacher_name", teacher);
  if (date) params.set("date", date);

  const list = document.getElementById("collegeClassList");
  try {
    const res = await fetch(`${API_BASE}/api/classes?${params.toString()}`);
    const data = await res.json();
    if (!data.classes.length) {
      list.innerHTML = '<li class="placeholder">No classes match this search yet.</li>';
      return;
    }
    list.innerHTML = "";
    data.classes.forEach((c) => {
      const li = document.createElement("li");
      const start = new Date(c.start_time).toLocaleTimeString();
      const end = c.end_time ? new Date(c.end_time).toLocaleTimeString() : "in progress";
      li.innerHTML = `<div class="class-title">${c.subject}</div>
        <div class="class-meta">${c.teacher_name} · ${c.session_date} · ${start}–${end} · ${c.status}</div>
        ${c.recording_path ? `<a class="recording-link" href="${API_BASE}${c.recording_path}" target="_blank" rel="noopener">🎥 Watch recording</a>` : ""}`;
      list.appendChild(li);
    });
  } catch (err) {
    list.innerHTML = `<li class="placeholder">Couldn't reach the backend at ${API_BASE}.</li>`;
  }
}
document.getElementById("applyFiltersBtn").addEventListener("click", loadCollegeClasses);

// =================================================================
// AI Flashcard Generator
// =================================================================
document.getElementById("flashcardsBtn").addEventListener("click", async () => {
  const btn = document.getElementById("flashcardsBtn");
  const container = document.getElementById("flashcardsContainer");
  if (!studentFullTranscript.trim()) {
    container.innerHTML = '<p class="placeholder">No lecture captured yet — flashcards need something to study from.</p>';
    return;
  }
  btn.disabled = true;
  btn.textContent = "Generating flashcards…";
  try {
    const res = await fetch(`${API_BASE}/api/flashcards`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript: studentFullTranscript, language: currentUser ? currentUser.language : "english" }),
    });
    const data = await res.json();
    container.innerHTML = "";
    (data.flashcards || []).forEach((card) => {
      const div = document.createElement("div");
      div.className = "flashcard";
      div.innerHTML = `<div class="fc-q">${card.question}</div><div class="fc-a">${card.answer}</div>`;
      div.addEventListener("click", () => div.classList.toggle("flipped"));
      container.appendChild(div);
    });
  } catch (err) {
    container.innerHTML = `<p class="placeholder">Couldn't reach the backend at ${API_BASE}.</p>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "🎴 Generate Flashcards";
  }
});

// =================================================================
// AI Mind Map
// =================================================================
document.getElementById("mindmapBtn").addEventListener("click", async () => {
  const btn = document.getElementById("mindmapBtn");
  const container = document.getElementById("mindmapContainer");
  if (!studentFullTranscript.trim()) {
    container.innerHTML = '<p class="placeholder">No lecture captured yet — the mind map needs something to map.</p>';
    return;
  }
  btn.disabled = true;
  btn.textContent = "Generating mind map…";
  try {
    const res = await fetch(`${API_BASE}/api/mindmap`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript: studentFullTranscript, language: currentUser ? currentUser.language : "english" }),
    });
    const data = await res.json();
    const mm = data.mindmap;
    if (!mm) {
      container.innerHTML = '<p class="placeholder">Nothing to map yet.</p>';
      return;
    }
    let html = `<div class="mm-topic">${mm.topic}</div>`;
    (mm.branches || []).forEach((b) => {
      html += `<div class="mm-branch"><div class="mm-branch-title">${b.title}</div><ul>${
        (b.points || []).map((p) => `<li>${p}</li>`).join("")
      }</ul></div>`;
    });
    container.innerHTML = html;
  } catch (err) {
    container.innerHTML = `<p class="placeholder">Couldn't reach the backend at ${API_BASE}.</p>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "🧠 Generate Mind Map";
  }
});

// =================================================================
// Sign Language Glossary (prototype) — illustrative reference cards,
// NOT verified ASL/ISL. A real deployment would use filmed clips from
// a certified signer. This demonstrates the concept honestly: a small
// set of common classroom phrases that highlight when heard live.
// =================================================================
const HAND_ICON_SVG = `<svg class="sign-hand-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M7 11V5a1.5 1.5 0 0 1 3 0v5M10 10.5V4a1.5 1.5 0 0 1 3 0v6.5M13 10.5V5a1.5 1.5 0 0 1 3 0v6M16 11V8a1.5 1.5 0 0 1 3 0v6c0 3.5-2 6-6 6h-1c-3 0-4.5-1.2-6-3.5L4 14c-.6-.9-.3-1.8.5-2.2.7-.4 1.5-.1 2 .5l1.5 2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

const signGlossary = [
  { keywords: ["yes", "correct", "right"], emoji: "👍", label: "Yes" },
  { keywords: ["no", "not", "incorrect"], emoji: "✋", label: "No" },
  { keywords: ["question", "doubt", "ask"], emoji: "❓", label: "Question" },
  { keywords: ["wait", "stop", "pause"], emoji: "🛑", label: "Wait" },
  { keywords: ["thank you", "thanks"], emoji: "🙏", label: "Thank You" },
  { keywords: ["hello", "hi ", "good morning"], emoji: "👋", label: "Hello" },
  { keywords: ["repeat", "again", "once more"], emoji: "🔁", label: "Repeat" },
  { keywords: ["understand", "clear", "got it"], emoji: "💡", label: "Understood" },
];

function renderSignGlossary() {
  const grid = document.getElementById("signGrid");
  if (!grid) return;
  grid.innerHTML = signGlossary.map((s, i) =>
    `<div class="sign-card" data-index="${i}">${HAND_ICON_SVG}<span class="sign-emoji-badge">${s.emoji}</span><span class="sign-label">${s.label}</span></div>`
  ).join("");
}

function flashMatchingSignCards(newText) {
  const lower = newText.toLowerCase();
  signGlossary.forEach((s, i) => {
    if (s.keywords.some((k) => lower.includes(k))) {
      const card = document.querySelector(`.sign-card[data-index="${i}"]`);
      if (card) {
        card.classList.add("active");
        setTimeout(() => card.classList.remove("active"), 2200);
      }
    }
  });
}

// =================================================================
// OCR + Read Aloud — photograph a textbook page, get it read back
// =================================================================
document.getElementById("ocrFileInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const resultEl = document.getElementById("ocrResult");
  resultEl.innerHTML = '<p class="placeholder">Reading the page…</p>';

  const formData = new FormData();
  formData.append("file", file);
  formData.append("disabilities", JSON.stringify(currentDisabilitiesForRequest()));
  formData.append("language", currentUser ? currentUser.language : "english");

  try {
    const res = await fetch(`${API_BASE}/api/ocr-read`, { method: "POST", body: formData });
    const data = await res.json();
    resultEl.textContent = data.text;
    speak(data.text);
  } catch (err) {
    resultEl.innerHTML = `<p class="placeholder">Couldn't reach the backend at ${API_BASE}.</p>`;
  }
  e.target.value = "";
});
