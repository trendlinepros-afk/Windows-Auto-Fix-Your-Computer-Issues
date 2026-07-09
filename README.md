# Windows Troubleshooter 🛠️

An AI-powered Windows desktop app that diagnoses and fixes common system
issues through a friendly chat interface — built for non-technical users.

Tell it *"My computer is running slow"* or *"I'm out of disk space"*, and it
will collect diagnostics (only the categories you allow), analyze them with
AI, and propose fix scripts that **you review and approve** before anything
runs.

## How it works

1. **Describe your problem** in plain English in the chat.
2. **Diagnostics are collected** — Windows Event Logs, performance counters,
   network tests, storage analysis, services & startup items. Each category
   is opt-in and everything is sanitized (no usernames, hostnames, or MAC
   addresses) before it leaves your machine.
3. **Gemini analyzes** the diagnostics and identifies the top issues.
4. **DeepSeek generates** a PowerShell/CMD fix script for each issue.
5. **You review each fix**: a plain-English summary, a collapsible code
   block, a risk indicator, and an optional *"Create restore point before
   this fix"* checkbox — then Approve or Deny.
6. **Everything is logged** — command, output, exit code, before/after state —
   to plain-text files you can view, filter, export (PDF/TXT), or clear
   in-app.

## Features

- 💬 **Chat interface** with streaming AI analysis
- 🔍 **5 diagnostic categories** (event logs, performance, network, storage,
  services/startup) — each individually opt-in
- ✅ **Approve/Deny every fix** — nothing ever runs without your consent
- 🛟 **System Restore integration** — optional restore point per fix, with
  one-click undo via System Restore
- 🛡️ **Script safety validator** — AI-generated scripts are checked against a
  blocklist of destructive operations (formatting drives, deleting shadow
  copies, disabling Defender, download-and-execute, …) before they can run
- 📋 **Full audit log** — sortable/filterable in-app viewer, PDF/TXT export,
  open-in-Explorer, configurable retention (default 30 days), manual clear
- 👁 **Continuous monitoring mode** (optional) — lightweight background health
  checks every 15/30/60 minutes with tray notifications; never fixes anything
  automatically
- 🔄 **Auto-update** via GitHub releases with SHA-256 verification
- 🔒 **Privacy-first** — no telemetry, no cloud sync, diagnostic data is never
  written to disk, API keys stored encrypted (Windows DPAPI)

## Getting started

### Prerequisites

- Windows 10/11
- Node.js 18+ (for building from source)
- A [Gemini API key](https://aistudio.google.com/apikey) (diagnosis)
- A [DeepSeek API key](https://platform.deepseek.com/api_keys) (fix scripts)

### Run from source

```bash
git clone https://github.com/trendlinepros-afk/Windows-Auto-Fix-Your-Computer-Issues.git
cd Windows-Auto-Fix-Your-Computer-Issues
npm install
npm start
```

For development you can put API keys in a `.env`-style environment
(see `.env.example`); in the packaged app, enter them in **Settings** — they
are encrypted at rest with Electron `safeStorage`.

### Build the Windows installer

```bash
npm run dist
```

The NSIS installer is emitted to `release/`. The app requests administrator
privileges at launch (required for diagnostics and fixes); if started
unelevated it offers to restart itself with UAC.

## Project structure

```
src/
├── main/index.ts            Electron main process: window, tray, IPC,
│                            monitoring scheduler, PDF export, update check
├── preload/preload.ts       Context-isolated IPC bridge (window.api)
├── renderer/
│   ├── App.tsx              Shell: sidebar navigation, banners
│   ├── components/
│   │   ├── ChatInterface.tsx     Chat + streaming + diagnostic opt-ins
│   │   ├── FixApprovalModal.tsx  Fix card: summary, code, restore point,
│   │   │                         risk badge, Approve/Deny/Details
│   │   ├── LogsViewer.tsx        Sortable/filterable log table + export
│   │   └── SettingsPanel.tsx     Keys, monitoring, opt-ins, retention
│   └── styles/main.css
├── utils/
│   ├── diagnostics.ts       Read-only PowerShell collectors per category
│   ├── executor.ts          Script execution, elevation, restore points
│   ├── logger.ts            TXT audit log with retention + export
│   ├── apiClients.ts        Gemini (streaming) + DeepSeek clients
│   ├── scriptValidator.ts   Dangerous-command blocklist
│   ├── sanitizer.ts         PII scrubbing before any API call
│   ├── settings.ts          Encrypted settings store
│   └── updater.ts           GitHub-releases update check + download
└── types/index.ts           Shared types
```

## Logs

- **Location:** `%APPDATA%\WindowsTroubleshooter\logs\`
- **Format:** one JSON object per line in daily `.txt` files — human-readable
  and machine-parseable
- **Per entry:** timestamp (ISO 8601), fix name, exact command, plain-English
  description, status, exit code, captured output, error message, and
  before/after metric snapshots

## Security notes

- Every AI-generated script passes a safety validator that refuses
  destructive patterns outright — and the validator runs again immediately
  before execution.
- The renderer runs with context isolation and no Node integration; all
  privileged operations go through a narrow, typed IPC bridge.
- Critical fixes (registry, system services, sfc/chkdsk/DISM) trigger an
  explicit per-fix UAC confirmation; routine fixes run in the app's existing
  admin session so you aren't spammed with prompts.
- Update downloads are SHA-256 verified when a `.sha256` asset is published
  with the release.

## Roadmap (v2+)

- Cross-platform support (macOS, Linux)
- Scheduled task automation
- Remote diagnostics (MSP features)
- Advanced analytics dashboard

## License

[MIT](LICENSE)
