# Antigravity API 🚀

[![Release](https://img.shields.io/github/v/release/flyzeen-source/antigravity-api?style=flat-square&color=6366F1)](https://github.com/flyzeen-source/antigravity-api/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg?style=flat-square&logo=node.js)](https://nodejs.org/)
[![Python](https://img.shields.io/badge/Python-3.10%2B-yellow.svg?style=flat-square&logo=python)](https://python.org/)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg?style=flat-square)]()

> Turn your **Google Antigravity** account into a local, high-performance **OpenAI-compatible** & **Gemini-native** API server with a native GUI dashboard and real-time quota meters in `%`. Connect models directly to Cursor, Cline, Continue, Open WebUI, LibreChat, and any OpenAI-compatible client.

![Antigravity API](assets/antigravity_logo.png)

---

## 📑 Table of Contents / Оглавление
- [English Quick Start Guide](#-quick-start-guide-windows--macos--linux)
- [🇷🇺 Инструкция по установке (Русский язык)](#-пошаговая-инструкция-по-установке-на-русском)
- [✨ Key Features](#-key-features)
- [🔌 Connecting Clients (Cursor, Cline, Continue)](#-connecting-clients)
- [⚙️ In-App Settings & Limits](#️-in-app-settings--limits)
- [🛡️ Privacy & Security](#️-privacy--security)

---

## ⚡ Quick Start Guide (Windows / macOS / Linux)

### 1. Prerequisites
Before installing, ensure you have:
1. **Google Antigravity IDE**: Installed on your PC and logged into your Google account.
2. **Python 3.10+**: Download from [python.org](https://www.python.org/downloads/).  
   > ⚠️ **Important on Windows:** During Python installation, check the box **"Add python.exe to PATH"**.
3. **Node.js 18+**: Download from [nodejs.org](https://nodejs.org/) (LTS recommended).

---

### 2. Download the App
Choose one of the following methods:
- **Option A (Easiest)**: Download the latest pre-built `.zip` from [GitHub Releases](https://github.com/flyzeen-source/antigravity-api/releases) or click the green **`<> Code`** button at the top of this page → **`Download ZIP`**, then extract it anywhere.
- **Option B (Git clone)**:
  ```bash
  git clone https://github.com/flyzeen-source/antigravity-api.git
  cd antigravity-api
  ```

---

### 3. Installation & Launch

#### 🪟 Windows (1-Click Installer):
1. Open the unzipped folder.
2. Double-click **`install.bat`**.
3. The installer will automatically:
   - Verify Python and Node.js.
   - Install required dependencies.
   - Extract your logged-in Google Antigravity OAuth session.
   - Generate native desktop and Start Menu shortcuts with the Antigravity icon.
4. Launch the application anytime using the **Antigravity API** shortcut on your Desktop or by running **`run.bat`**.

#### 🍎 macOS / 🐧 Linux:
```bash
chmod +x run.sh
./run.sh
```

---

## 🇷🇺 Пошаговая инструкция по установке (на русском)

### Шаг 1. Подготовка системы
Убедитесь, что на вашем компьютере установлены:
1. **Google Antigravity**: Установлен и выполнен вход в аккаунт Google.
2. **Python 3.10 или новее**: [Скачать с официального сайта python.org](https://www.python.org/downloads/).  
   > ⚠️ **Обязательно при установке Python поставьте галочку:**  
   > ☑️ **«Add python.exe to PATH»** (в самом низу первого окна установщика).
3. **Node.js 18 или новее**: [Скачать с официального сайта nodejs.org](https://nodejs.org/) (рекомендуется версия LTS).

### Шаг 2. Скачивание программы
1. Перейдите во вкладку [Releases (Релизы)](https://github.com/flyzeen-source/antigravity-api/releases) и скачайте архив `antigravity-api-release.zip`, либо вверху этой страницы нажмите зеленую кнопку **`<> Code`** → **`Download ZIP`**.
2. Распакуйте архив в любую удобную папку (например, `C:\antigravity-api` или на Рабочий стол).

### Шаг 3. Установка в 1 клик
1. Откройте распакованную папку.
2. Запустите файл **`install.bat`** (двойным кликом).
3. Установщик сделает всё сам:
   - Проверит установку Node.js и Python.
   - Установит недостающие библиотеки.
   - Автоматически найдет токен вашей авторизации Antigravity.
   - Создаст красивый ярлык с иконкой на **Рабочем столе** и в **меню Пуск**.
4. В конце установщик предложит сразу запустить программу — нажмите **Enter** (или `Y`).

### Шаг 4. Запуск и использование
- В дальнейшем запускайте программу кликом по ярлыку **«Antigravity API»** на Рабочем столе или файлом `run.bat`.
- Откроется окно в стиле оригинального Antigravity:
  - **API Key** и **Base URL** будут показаны в окне (по умолчанию: `http://127.0.0.1:8317/v1`).
  - Внизу отображаются реальные остатки квот Google Cloud Code в процентах (`%`).
  - Кнопка **Settings & Limits** позволяет настраивать лимиты под себя.

---

## ✨ Key Features

- **1-Click Zero-Config Setup**: Automatically detects and extracts your Google Antigravity session on Windows, macOS, and Linux without copying tokens manually.
- **Real Upstream Quotas in Percent (%)**: Real-time server-side quotas directly from Google Cloud Code (`v1internal:retrieveUserQuotaSummary`). Displays exact weekly and 5-hour percentage meters and reset countdowns for both **Gemini Models** and **Claude / GPT Models**.
- **In-App Limit Configuration**: Customize Safe Mode rate limits (RPM, requests/day, tokens/day, request interval) directly inside the GUI with instant dynamic persistence without restarting.
- **Top Tier Models Supported**:
  - `gemini-3.8-flash-tiered`, `gemini-3.7-flash-tiered`, `gemini-3-flash`
  - `gemini-2.5-pro`, `gemini-3.5-flash-lite`
  - `claude-opus-4-6-thinking`, `claude-sonnet-4-6`
  - `gpt-oss-120b-medium`, `gpt-oss-120b-low`
  - and all other models available in your account.
- **Dual API Compatibility**:
  - **OpenAI Standard**: `POST /v1/chat/completions`, `GET /v1/models` (supports streaming SSE, tool calling, thought signatures, reasoning content).
  - **Google Gemini Native**: `POST /v1beta/models/{m}:generateContent`, `:streamGenerateContent`, `:countTokens`.
- **Optional Account Protection Guard**:
  - Disabled by default: requests pass directly to Google without artificial local delays or token lockouts.
  - Optional Safe Mode toggle in Settings with configurable RPM, RPH, RPD, and human jitter delays.
- **Original Antigravity Desktop Aesthetic**:
  - Deep space obsidian UI (`#0B0C10` / `#141622`), electric indigo (`#6366F1`) & cyan (`#38BDF8`) accents.
  - High-resolution multi-scale `.ico` desktop and start menu shortcuts.

---

## 🔌 Connecting Clients

Configure your favorite AI client (Cursor, Cline, Continue, LibreChat, Open WebUI, etc.):

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

## ⚙️ In-App Settings & Limits

Click **Settings & Limits** in the dashboard to access:
- **Enable Local Rate Limit & Safe Mode Guard (Checkbox)**: Disabled by default. When disabled, queries pass freely to Google Cloud Code without local synthetic token caps or false-positive 429 lockouts.
- **Configurable Throttles**:
  - **Max Requests / Minute (RPM)**: Default `60`
  - **Max Requests / Hour**: Default `600`
  - **Max Requests / Day**: Default `3000`
  - **Max Tokens / Day**: Default `50,000,000`
  - **Min Interval (ms)**: Default `200`
  - **Max Concurrent Requests**: Default `4`
- **Real-Time Dynamic Reload**: Changes are saved to `config.json` and hot-reloaded into the running server immediately without restarting.

---

## 🛡️ Privacy & Security

- **Zero Remote Telemetry**: Credentials (`auth.json`, `apikey.txt`, `config.json`, `usage.json`) never leave your local machine.
- Requests travel directly between your machine and Google's official Cloud Code gateway (`daily-cloudcode-pa.googleapis.com`).
- Keep your `auth.json` private — it is protected by `.gitignore` and never committed.

---

## 🧪 Testing

Run the automated test suite (17 tests covering OpenAI/Gemini translation, tool calling, sanitize schemas, quota parsing, and Safe Mode):
```bash
node test/run-tests.js
```

Verify desktop UI startup:
```bash
python app.py --selftest
```
