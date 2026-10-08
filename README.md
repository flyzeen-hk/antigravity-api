# Antigravity API 🚀

> Turn your **Google Antigravity** account into a local, high-performance **OpenAI-compatible** & **Gemini-native** API server. Connect your models to Cursor, Cline, Continue, Open WebUI, LibreChat, and any OpenAI API-compatible tooling.

![Antigravity API](assets/antigravity_logo.png)

---

## ✨ Key Features

- **1-Click Zero-Config Setup**: Automatically detects and extracts your Google Antigravity IDE OAuth session on Windows, macOS, and Linux. No manual tokens or header copying needed.
- **Real Upstream Quotas in Percent (%)**: Real-time server-side quotas directly from Google Cloud Code (`v1internal:retrieveUserQuotaSummary`). Displays exact weekly and 5-hour percentage meters and reset countdowns for both **Gemini Models** and **Claude / GPT Models**.
- **In-App Limit Configuration**: Customize Safe Mode rate limits (RPM, requests/day, tokens/day, request interval) directly inside the GUI with instant dynamic persistence without restarting.
- **Top Tier Models**:
  - `gemini-3.8-flash-tiered`, `gemini-3.7-flash-tiered`, `gemini-3-flash`
  - `gemini-2.5-pro`, `gemini-3.5-flash-lite`
  - `claude-opus-4-6-thinking`, `claude-sonnet-4-6`
  - `gpt-oss-120b-medium`, `gpt-oss-120b-low`
  - and all other models unlocked in your account (~25 models).
- **Dual API Compatibility**:
  - **OpenAI Standard**: `POST /v1/chat/completions`, `GET /v1/models` (supports streaming SSE, multi-turn function calling / tool calls, thought signatures, reasoning content).
  - **Google Gemini Native**: `POST /v1beta/models/{m}:generateContent`, `:streamGenerateContent`, `:countTokens`.
- **Optional Account Protection Guard**:
  - Disabled by default: requests pass directly to Google without artificial local delays or token lockouts.
  - Optional Safe Mode toggle in Settings with configurable RPM, RPH, RPD, and human jitter delays.
- **Original Antigravity Desktop Aesthetic**:
  - Deep space obsidian UI (`#0B0C10` / `#141622`), electric indigo (`#6366F1`) & cyan (`#38BDF8`) accents.
  - High-resolution multi-scale `.ico` desktop and start menu shortcuts.
  - English by default.

---

## ⚡ 1-Click Installation & Setup

### Requirements
- **Antigravity IDE** installed and logged in.
- **Python** (3.10+)
- **Node.js** (18+)

### Windows (Automated Installer)
Double-click `install.bat`. The installer will:
1. Verify Python and Node.js.
2. Install Python dependencies (`Pillow`).
3. Generate high-resolution desktop and Start Menu shortcuts.
4. Auto-detect your Antigravity IDE credentials.
5. Offer to launch the application.

### Manual Launch
**Windows**:
```cmd
run.bat
```
or run silently via shortcut or `pythonw app.py`.

**macOS / Linux**:
```bash
chmod +x run.sh
./run.sh
```

---

## 🔌 Connection Details

Configure your client (Cursor, Cline, NextChat, Open WebUI, etc.):

| Setting | Value |
|---|---|
| **Base URL** | `http://127.0.0.1:8317/v1` |
| **API Key** | Your generated key (shown in app or `apikey.txt`) |
| **Model** | Any available model (e.g. `gemini-3.8-flash-tiered` or `claude-sonnet-4-6`) |

### Example cURL Request
```bash
curl http://127.0.0.1:8317/v1/chat/completions \
  -H "Authorization: Bearer <YOUR_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3.8-flash-tiered",
    "messages": [{"role": "user", "content": "Hello world!"}]
  }'
```

---

## ⚙️ In-App Settings & Optional Limit Configuration

Click **Settings & Limits** in the dashboard to access:
- **Enable Local Rate Limit & Safe Mode Guard (Checkbox)**: Disabled by default. When disabled, your queries pass freely without local synthetic token caps or 429 lockouts.
- **Configurable Throttles (Active only when Guard is turned ON)**:
  - **Max Requests / Minute (RPM)**: Default `60`
  - **Max Requests / Hour**: Default `600`
  - **Max Requests / Day**: Default `3000`
  - **Max Tokens / Day**: Default `50,000,000`
  - **Min Interval (ms)**: Default `200`
  - **Max Concurrent Requests**: Default `4`
- **Local Consumption Metrics**: Informational stats showing local queries and token volume.

Changes are saved to `config.json` and hot-reloaded dynamically into the running server immediately via `POST /_config`.

---

## 🛡️ Privacy & Security

- **Zero Remote Telemetry**: Credentials (`auth.json`, `apikey.txt`, `config.json`, `usage.json`) never leave your local machine.
- Requests travel directly between your machine and Google's official Cloud Code gateway (`daily-cloudcode-pa.googleapis.com`).
- Keep your `auth.json` private — never commit or share it.

---

## 🧪 Testing & Verification

Run the full automated test suite (17 tests covering OpenAI/Gemini translation, tool calling, sanitize schemas, quota parsing, and Safe Mode):
```bash
node test/run-tests.js
```

Verify desktop UI startup:
```bash
python app.py --selftest
```
