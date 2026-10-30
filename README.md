# 🕒 Miss Minutes • Time Variance Authority (TVA) AI Assistant

> *"Hey y'all! Welcome to the Time Variance Authority! For all time. Always."*

An interactive retro-futuristic AI companion inspired by Marvel's *Loki*. Miss Minutes serves as your lively, Southern-accented assistant, animated mascot, and temporal administrator.

---

## ✨ Features

- **Animated Mascot & Expressive Avatar (`MissMinutesAvatar.tsx`)**:
  - Interactive cartoon clock face with dynamic facial expressions: *cheerful*, *talking*, *winking*, *suspicious*, *scary* (He Who Remains), *thinking*, and *pruning*.
  - Cursor tracking (pupils follow mouse movement smoothly).
  - Autonomous natural blinking and lip-syncing mouth synchronized to speech audio.
  - Interactive click feedback: tap Miss Minutes to hear random TVA quotes, clock ticks, and reactions.
  - Hologram scanline effect and projector beam mode.

- **Voice Synthesis (TTS) & Speech Recognition (STT)**:
  - Real-time text-to-speech with a tailored, upbeat Southern cartoon pitch and cadence.
  - Hands-free microphone input using the Web Speech API.
  - Zero-latency Web Audio API sound generator for TVA 3-tone chimes, clock ticks, pruning disintegration zaps, and Nexus alert sirens.

- **Sacred Timeline Chrono-Scope (`TimelineMonitor.tsx`)**:
  - Animated retro oscilloscope visualizer rendering the Sacred Timeline and branching deviations.
  - Red Line threshold indicator (critical 80% deviation mark).
  - Reset Charge deployment: prune dangerous timeline branches with particle disintegration effects.
  - "Simulate Nexus Event" button to trigger spontaneous branch emergencies.

- **TVA Variant Dossier (`VariantCard.tsx`)**:
  - View and customize your official TVA case file, designation (e.g. `VAR-L1130`), offenses against the Sacred Timeline, origin coordinates, and prune risk priority.

- **Multi-AI Provider Pairing (`SettingsModal.tsx`)**:
  - **Google Gemini API**: Connect directly via your Gemini API key (supports `gemini-1.5-flash`, `gemini-2.0-flash`, `gemini-1.5-pro`, etc.).
  - **OpenAI / ChatGPT**: Connect with your OpenAI API key (`gpt-4o-mini`, `gpt-4o`, etc.).
  - **Anthropic Claude**: Connect with your Anthropic key (`claude-3-5-sonnet`).
  - **Local Ollama / OpenAI-Compatible**: Connect to `http://localhost:11434/v1` for 100% private, local LLMs.
  - **Built-in TVA Offline Hologram AI**: Works instantly out of the box with zero configuration or keys required!

- **TemPad Time Door Warp**:
  - Activate the TemPad to open a glowing orange portal and time-jump with cosmic particle animations.

---

## 🚀 Quick Start

1. Install dependencies:
   ```bash
   npm install
   ```

2. Start the development server:
   ```bash
   npm run dev
   ```

3. Open your browser at the displayed local URL (typically `http://localhost:5173`).

---

## 🔑 Pairing with an AI Provider

1. Click the **Pair AI** button in the top header.
2. Select your provider (**Gemini**, **OpenAI**, **Claude**, **Ollama**, or **TVA Offline**).
3. Paste your API key. It is stored in this browser's local storage and sent to the provider you selected when you make a request. It is not stored in the desktop OS credential vault in this version.
4. Click **Test Connection** to verify your temporal neural link, then click **Save & Connect Link**!

---

*For all time. Always.*


---

## Native desktop companion

The Tauri desktop build adds a persistent Windows avatar overlay, a native system tray, opt-in login startup, and typed browser-to-Rust IPC. See [native/desktop/README.md](native/desktop/README.md) for the platform matrix, privacy boundary, and build commands. The task executor and Android/iOS background agents remain future phases; this branch does not claim those features are implemented.


## Native task actions

The Rust agent can propose a typed Markdown-note creation action, but it cannot write merely because a folder is monitored. Grant a separate write permission to one exact subfolder, inspect the full proposed content and destination in the desktop panel, and approve or reject the one-shot action. The only implemented write capability creates new .md files without overwriting existing files. General unattended execution, mobile background agents and unrestricted machine control are not claimed. See the implementation roadmap and native agent README.
