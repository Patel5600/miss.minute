# Miss Minutes Design System Master File

**Project:** Miss Minutes (Desktop Tauri + Android Companion)
**Style:** AI-Native Conversational Interface (Gemini / ChatGPT Aesthetic) + TVA Obsidian & Clockwork Amber Identity
**Design Dials:** Motion 5/10 (Standard, `prefers-reduced-motion` guarded) | Density 5/10 (Focused, breathable reading rhythm)

---

## Global Rules & Constraints

1. **CSP-Safe Typography:** Never import external Google Fonts (`fonts.googleapis.com` / `fonts.gstatic.com`), as desktop Tauri CSP and Android WebView isolation block external font CDNs.
   - **UI & Reading Font:** `"Segoe UI Variable", "Segoe UI", Roboto, system-ui, -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif`
   - **Monospace / Telemetry Font:** `"Cascadia Code", "JetBrains Mono", Consolas, ui-monospace, SFMono-Regular, monospace` (`tabular-nums` for timers and timestamps)
2. **Icons Only from Lucide:** Never use raw emojis as UI icons; use `lucide-react` stroke SVGs (`1.75`–`2px`).
3. **Interactive Cursor & Focus Rings:** All clickable controls use `cursor-pointer` and visible `:focus-visible` `2px` `#FF7A1A` rings.
4. **Overlay Window Isolation:** Floating transparent overlays (`html.mm-native-overlay`, `body.mm-native-overlay`, and mobile `overlay.html`) MUST stay `background: transparent !important`.
5. **Fail-Closed Owner Authority:** Unauthenticated Guest/Candidate sessions must never display `"Boss"` greetings or expose private owner panels, settings, memories, or conversation history.

---

## Color Palette

| Role | Hex / Value | CSS Variable |
|------|-------------|--------------|
| Canvas Background | `#0B0908` | `--mm-bg` |
| Sidebar / Drawer Surface | `#100D0A` | `--mm-sidebar` |
| Elevated Card / Pill Surface | `#16120E` | `--mm-surface` |
| Interactive Hover Surface | `#211B15` | `--mm-surface-hover` |
| User Message Bubble | `#241C14` | `--mm-surface-user` |
| Signature Clockwork Accent | `#FF7A1A` | `--mm-accent` |
| Accent Hover | `#FF903B` | `--mm-accent-hover` |
| Accent Soft Tint | `rgba(255, 122, 26, 0.14)` | `--mm-accent-soft` |
| Primary Text (Editorial Cream) | `#F5EFE6` | `--mm-cream` |
| Secondary Text | `#CBBEB0` | `--mm-text-secondary` |
| Muted Metadata (>=4.5:1) | `#9D9082` | `--mm-muted` |
| Subtle Border | `rgba(255, 255, 255, 0.08)` | `--mm-border-subtle` |
| Warm Border | `rgba(255, 176, 87, 0.16)` | `--mm-border` |
| Authority: Owner Mode | `#34D399` | Semantic Emerald |
| Authority: Owner Candidate | `#FBBF24` | Semantic Amber |
| Destructive / Kill Switch | `#D93025` / `#EF4444` | Semantic Red |

---

## Layout & Navigation Architecture

### Desktop App
- **Full-Viewport App Shell (`h-dvh overflow-hidden flex`)**:
  - **Collapsible Left Sidebar (`272px`)**: Brand header, `New chat` button, live chat search, date-grouped conversation history (`Today`, `Yesterday`, `Previous 7 Days`, `Earlier`) with inline rename & delete, Workspace section (`Chat`, `Sacred Timeline`, `Toolbelt`, `Dossier`, `Activity`), and bottom Owner Authority + Settings bar.
  - **Main Workspace**: Minimal `56px` header (`Sidebar toggle`, `Model/Provider Pill`, `Voice Mute`, `Hands-Free Voice`, `Live Companion Drawer toggle`, `Settings`) over centered `max-w-3xl` Gemini/ChatGPT conversation stream + sticky floating pill composer, or spacious `max-w-5xl` Workspace panel view.
  - **Dockable Right Companion Stage Drawer (`360px`)**: Interactive animated `<MissMinutesRig>` in volumetric TVA obsidian projector lighting with subtitle overlay and glass-tap interactivity.
  - **Centered Two-Pane Settings Modal**: Left category rail + clean scrollable settings canvas.

### Android App
- **Native Chrome (`DashboardActivity.java`)**: Compact obsidian `#110D0A` top bar with live runtime status, rounded pill `ownerButton` (`minHeight >= 48dp`), and emergency `KillSwitch` `stopButton` (`minHeight >= 48dp`). IME insets resize the WebView natively above the Android keyboard.
- **Chat-First Mobile Web Shell**:
  - **Top Bar (`56px`)**: Drawer hamburger (`48x48dp`), Model / Authority pill, quick New Chat (`48x48dp`).
  - **Slide-Over Navigation Drawer**: New chat, conversation search & history, sections (`Chat`, `Companion Hub`, `Timeline & Tools`, `Settings`), and live Owner Authority status.
  - **Full-Bleed Edge-to-Edge Chat**: Centered `max-w-2xl` readable stream, floating scroll-to-bottom button, multi-line pill composer locked cleanly above the Android IME keyboard, `>=48px` touch targets throughout.

---

## Pre-Delivery Verification Checklist

- [ ] No external CDN font imports (100% CSP compliant)
- [ ] All icons from `lucide-react` SVG set (zero structural emojis)
- [ ] Zero forbidden endearments (`\bsugar\b|darlin'?`)
- [ ] No unauthenticated `"Boss"` greeting or private data leakage
- [ ] Minimum `48px` touch targets on Android primary controls & switches
- [ ] Zero horizontal scroll at `375px`
- [ ] Transparent floating overlay styles preserved intact
