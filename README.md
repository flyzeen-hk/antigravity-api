# Antigravity API 🚀

## Gemini browser connection and Gemini 4 Unlock

**Gemini 4 Unlock (Web Bridge) работает.** Запросы к моделям `web/gemini-4*`
идут через веб-шлюз `gemini.google.com` (StreamGenerate RPC — тот же бэкенд,
что у сайта) и обслуживаются на обоих эндпоинтах: OpenAI (`/v1/chat/completions`,
включая стриминг) и Gemini (`/v1beta/models/web/...:generateContent`,
`:streamGenerateContent`). Модели `web/gemini-4*` рекламируются в `/v1/models`
и `/v1beta/models` с пометкой `owned_by: google-web`, когда мост включён
(`config.json → geminiWeb.enabled` или GUI: Settings & Limits → Gemini 4 Unlock).

**Namespace-контракт (важно).** Основные пространства имён:
`cloud/<model-id>` — Cloud Code (OAuth, квоты в %), `web/<alias>` — веб-мост
(cookies, без нативных tools). Если клиент присылает плоское имя, которое
**точно совпадает** с id модели из каталога аккаунта, сервер автоматически
трактует его как `cloud/<id>` (совместимость со старыми клиентами, включая
`-agent`); плоский веб-алиас (`gemini-4`) разрешается в `web/<alias>`.
Неизвестные плоские имена по-прежнему дают 400 `model_namespace_required`
с подсказкой-примером. Суффикс `-agent` (`cloud/<id>-agent`,
`web/<alias>-agent`) включает серверный агентский цикл.

Выбор именно Gemini 4 Argon идёт через поле `MODE_CATEGORY` (inner[79])
веб-протокола со значением **8 = ARGON** — результат реверс-инжиниринга
веб-клиента ([zexadev/gemini-web2api-go](https://github.com/zexadev/gemini-web2api-go)):
проверено, что именно mode решает, какая модель отвечает. Для аккаунтов
Google AI Pro / Ultra, у которых Gemini 4 уже есть в веб-версии, запросы
обслуживает Gemini 4 Argon; бесплатные аккаунты Google даунгрейдит.

Честная оговорка: верификация эвристическая, а не криптографическая —
Google не отдаёт в этом протоколе per-response аттестованный идентификатор
модели, и привязка mode=8 → Argon может сломаться при обновлении Google.
Веб-алиасы проверяются только по точному списку `web/...`; префикс `cloud/`
всегда уходит в Cloud Code, поэтому пересечения имён между провайдерами
не влияют на маршрутизацию.

Use **Connect Gemini (browser)** on the dashboard to open Chrome/Edge with a
dedicated profile. Sign in manually once; the browser retains that session.
Cookies are imported manually: sign in at gemini.google.com, open DevTools →
Network, pick a request to gemini.google.com, copy the **Cookie** request header
(must contain `SAPISID`) and paste it into Settings & Limits → Gemini Web.
Automatic cookie extraction was removed.
A cookie pasted manually or saved as `cookie.txt` (must contain `SAPISID`) is accepted.

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
- [🤖 Agent File Tools](#-agent-file-tools)
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
   - Ask if you want to create optional Desktop and Start Menu shortcuts.
4. Launch the application anytime using the **Antigravity API** shortcut on your Desktop or by running **`run.bat`**.

#### 🍎 macOS / 🐧 Linux:
```bash
chmod +x install.sh run.sh
./install.sh
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
   - Предложит по желанию создать ярлык на **Рабочем столе** и в **меню Пуск** (y/N).
4. В конце установщик предложит сразу запустить программу — нажмите **Enter** (или `Y`).

Для **Linux / macOS**:
```bash
chmod +x install.sh run.sh
./install.sh
./run.sh
```

### Шаг 4. Запуск и использование
- В дальнейшем запускайте программу кликом по ярлыку **«Antigravity API»** на Рабочем столе или файлом `run.bat`.
- Откроется окно в стиле оригинального Antigravity:
  - **API Key** и **Base URL** будут показаны в окне (по умолчанию: `http://127.0.0.1:8317/v1`).
  - Внизу отображаются реальные остатки квот Google Cloud Code в процентах (`%`).
  - Кнопка **Settings & Limits** позволяет настраивать лимиты под себя.

---
## 🌐 Разблокировка Gemini 4 (Web Bridge)

Gemini 4 пока не завезли в Antigravity для подписки Pro, но она уже работает
на сайте `gemini.google.com`. Функция «Gemini 4 Unlock» направляет запросы
через тот же веб-шлюз, которым пользуется сайт, — и отдаёт их в приложении
в обычном OpenAI/Gemini-совместимом формате.

**Доступные модели:**

| Имя модели | Что это | Куки |
|---|---|---|
| `web/gemini-4-argon` | Gemini 4 Argon, флагман (режим 8 веб-протокола) | рекомендуются (Pro/Ultra) |
| `web/gemini-4-argon-thinking` | Argon с глубоким мышлением (экспериментально) | рекомендуются |
| `web/gemini-4` | Псевдоним → `web/gemini-4-argon` | рекомендуются |
| `web/gemini-4-pro` | Argon на полную мощность | нужны |
| `web/gemini-4-thinking` | Псевдоним → `web/gemini-4-argon-thinking` | рекомендуются |
| `web/gemini-4-flash` | Ведёт на Argon (отдельной «4 Flash» не существует) | не нужны |

**Как включить:**
1. Откройте **Settings & Limits → Gemini 4 Unlock** в окне приложения.
2. Войдите на [gemini.google.com](https://gemini.google.com) в браузере → F12 → Network →
   выберите запрос к `gemini.google.com` → Request Headers → скопируйте заголовок
   **Cookie** целиком (в нём должен быть `SAPISID=...`) → вставьте в поле «Google cookie».
   Можно также сохранить строку в `cookie.txt` рядом с программой.
3. Сохраните — настройки применяются к работающему серверу сразу, без перезапуска.
   Автоматических кнопок извлечения куки нет: они убраны.

> Значения куки нигде не печатаются, не логируются и не уходят никуда, кроме
> запросов к `gemini.google.com`. CDP-порт слушает только `127.0.0.1` и только
> для выделенного профиля приложения — ваш основной браузер не затрагивается.

**Нюансы (честно):**
- Запросы идут в `gemini.google.com` с вашим cookie (SAPISIDHASH), это тот же
  аккаунт, что и в браузере. Куки хранятся только локально (`config.json`) —
  берегите их как пароль.
- Если `gemini.google.com` недоступен с вашего IP (Россия или блокировки по IP) —
  укажите глобальный прокси в **Network Transport** (например, `socks5://127.0.0.1:1080`
  от вашего VPN/Xray) или отдельный прокси только для моста в поле
  **«Web-only proxy»** (например, `http://127.0.0.1:7890`).
- Опция **Temporary chats** отправляет флаг временного чата, чтобы история
  не сохранялась в вашем аккаунте Gemini.
- Поле **«Подпись веб-аккаунта»** (`geminiWeb.accountLabel`, напр. «личный Pro») —
  показывается на дашборде в карточке веб-моста, чтобы отличать веб-аккаунт
  от аккаунта Antigravity (у них разные пулы лимитов, аккаунты могут различаться).
  Числовых лимитов веб-интерфейс Google не отдаёт — в карточке статус моста,
  наличие куки и число веб-моделей.
- Какая модель Gemini 4 «максимально думает»: **web/gemini-4-argon-thinking**
  («Gemini 4 Argon — максимальное мышление», thinkMode 0 = EXTENDED) против
  обычного **web/gemini-4-argon** (thinkMode 4 = DEFAULT).
- Мост неофициальный (по мотивам проектов `gemini-web2api`) — внутренний формат
  Google может поменять в любой момент.

> **Провайдер фильтрует Google или режет DNS?** Симптом: `Resolve-DnsName daily-cloudcode-pa.googleapis.com`
> висит с таймаутом, а `googleapis.com` резолвится; в программе — вечная «Загрузка…»
> лимитов и `Account status: Offline (fetch failed)`. В приложении есть настоящий
> сетевой слой (не «плацебо» `dns.setServers`): **Settings & Limits → Network
> Transport** позволяет задать глобальный прокси (`http://`, `https://`, `socks5://`
> с логином/паролем), DNS-over-HTTPS (`https://cloudflare-dns.com/dns-query`) или
> свои DNS-серверы. Там же кнопка **«Найти прокси»** (сканирует переменные
> окружения, настройки Windows и типовые локальные порты Clash / v2rayN / Tor) и
> **«Проверить соединение»** — реальная проверка маршрутов Cloud Code, OAuth и
> Gemini Web плюс DNS, без раскрытия куки. Те же значения в `config.json`:
>
> ```json
> "network": {
>   "proxy": "socks5://127.0.0.1:1080",
>   "dohUrl": "https://cloudflare-dns.com/dns-query",
>   "dnsServers": [],
>   "useEnvProxy": true,
>   "timeoutMs": 30000
> }
> ```
>
> Настройки применяются на лету, без Stop/Start. Прокси используется для всех
> исходящих запросов (Cloud Code, OAuth, каталог моделей, Gemini Web), уважает
> `NO_PROXY`, поддерживает HTTP/HTTPS CONNECT и SOCKS5. `geminiWeb.proxy`
> остаётся отдельным переопределением только для веб-моста.

> **Фолбэк апстрима.** Если `daily-cloudcode-pa.googleapis.com` недоступен по сети
> (DNS/TCP/TLS — DPI, блокировки), сервер автоматически повторяет запрос на
> продакшн-хост `cloudcode-pa.googleapis.com` (практика сообщества,
> см. `lib/fetch_fallback.js`). Срабатывает только на сетевые ошибки, не на
> HTTP-статусы. Свой резервный хост: `"upstreamFallbackHost": "https://..."` в
> `config.json`; пустая строка отключает фолбэк.

---

## ✨ Key Features

- **1-Click Zero-Config Setup**: Automatically detects and extracts your Google Antigravity session on Windows, macOS, and Linux without copying tokens manually.
- **Real Upstream Quotas in Percent (%)**: Real-time server-side quotas directly from Google Cloud Code (`v1internal:retrieveUserQuotaSummary`). Displays exact weekly and 5-hour percentage meters and reset countdowns for both **Gemini Models** and **Claude / GPT Models**.
- **In-App Limit Configuration**: Customize Safe Mode rate limits (RPM, requests/day, tokens/day, request interval) directly inside the GUI with instant dynamic persistence without restarting.
- **Top Tier Models Supported** (namespace `cloud/`):
  - `cloud/gemini-3.8-flash-tiered`, `cloud/gemini-3.7-flash-tiered`, `cloud/gemini-3-flash`
  - `cloud/gemini-2.5-pro`, `cloud/gemini-3.5-flash-lite`
  - `cloud/claude-opus-4-6-thinking`, `cloud/claude-sonnet-4-6`
  - `cloud/gpt-oss-120b-medium`, `cloud/gpt-oss-120b-low`
  - and all other models available in your account.
- **🌐 Gemini 4 Unlock (Web Bridge)**:
  - Models `web/gemini-4`, `web/gemini-4-argon`, `web/gemini-4-pro`, `web/gemini-4-thinking` are routed through the Gemini **web gateway** (`gemini.google.com` StreamGenerate RPC) — the same backend as the browser site, so Gemini 4 works even before it appears in Antigravity/Cloud Code.
  - Works anonymously for faster models; to unlock **Gemini 4 Pro / Advanced**, paste a Google **Cookie** header manually (must contain `SAPISID`) in Settings → Gemini Web. Automatic extraction buttons were removed.
  - **Chrome/Edge DBSC limitation**: Chrome/Edge 127+ bind the Google session to the browser (`Default/Network/Device Bound Sessions`). Such cookies cannot be replayed by a local gateway — the browser works, but Node receives 401/400 even with the same cookies, XSRF token and IP. This is a browser security feature, not a VPN or cookie-expiry bug. Web models are therefore unavailable with a Chrome/Edge session; use **cloud** models.
  - **Sign in** button opens a normal browser window for logging in; cookies are then copied manually from DevTools (Network → Request Headers → Cookie).
  - Auto-updating `BL` version (matches the current `boq_*` web build string), HTTP proxy support, multi-account `/u/N` index, temporary chats (not saved to Gemini history), full SSE streaming.
  - No native function calling: `web/*` is plain chat; agent mode for web models is text-protocol emulation and **VERY unreliable** (opt-in via `agent.allowWebAgent`, see below).
  - Configure it in the GUI (**Settings & Limits → Gemini 4 Unlock**) or in `config.json` → `geminiWeb`. Cookie can be given as raw header string, path to `cookie.txt`, or JSON `{"cookie": "..."}`.
- **🤖 Agent File Tools (server-side tool execution)**:
  - Models can work with real files on your PC: `list_dir`, `read_file`, `write_file`, `append_file`, `edit_file`, `move_path` (plus optional `delete_path`, `run_command`).
  - For `cloud/*` the **server runs the agent loop on native Gemini function calling** — thought signatures and parallel calls survive; results are fed back until the task is done, so even plain chat clients (Open WebUI, curl) get a file-capable agent.
  - Everything is sandboxed inside `agent_workspace` (path-escape and symlink protection, size limits, iteration cap, JSONL audit log `agent_audit.jsonl`). `delete_path` and `run_command` are disabled by default.
  - Enable per request: model alias with `-agent` suffix (e.g. `cloud/gemini-3-flash-agent`) or a flag in the body: `"agent": true` / `"tools": "builtin"`. Web models require `agent.allowWebAgent` and carry a **VERY unreliable** warning. See [Agent File Tools](#-agent-file-tools).
- **🧭 Planner (`ask_planner`)**:
  - In the cloud agent loop the model can consult a Gemini Web model (default `web/gemini-4-argon-thinking`) for a short plan, review or advice — a hybrid of reliable native execution and web-only Gemini 4 reasoning.
  - `ask_planner` is a tool result, never a quota drain: Cloud Code usage is unaffected; call budget (`agent.planner.maxCalls`, default 2) and timeout (`timeoutMs`) are enforced per request. The web loop never gets the planner tool.
- **🛰 Network Transport (built-in bypass layer)**:
  - Global egress for every outbound request (Cloud Code, OAuth, model catalog, Gemini Web): **HTTP/HTTPS CONNECT proxy and SOCKS5**, optional credentials, `NO_PROXY` respected, keep-alive agents.
  - Real custom DNS: **DNS-over-HTTPS** (RFC 8484 JSON) with cache, or explicit DNS servers — not the `dns.setServers` placebo that global `fetch` ignores.
  - **Proxy auto-detection**: environment variables, Windows Internet Settings registry, and common local ports (Clash, Mihomo, v2rayN, Tor) probed with loopback-only handshakes.
  - **Connection test** in the GUI and `GET /_network/test` (redacted summary: route, DNS mode, proxy reachability); settings hot-reload without restart.
  - Remote DPI bypass is deliberately *not* included: no domain fronting, TLS fragmentation or ECH spoofing. Pair the app with your own tunnel (WireGuard, Xray, SOCKS5) and point the proxy field at it.
- **Dual API Compatibility**:
  - **OpenAI Standard**: `POST /v1/chat/completions`, `GET /v1/models`, `GET /v1/models/{id}` (supports streaming SSE, tool calling, thought signatures, reasoning content).
  - **Google Gemini Native**: `POST /v1beta/models/{m}:generateContent`, `:streamGenerateContent`, `:countTokens`, `GET /v1beta/models/{model}`.
  - **Strict client validation**: a missing `model` or empty `messages` returns a local 400 with the expected namespace format instead of reaching Google; region blocks surface as `region_not_supported`.
- **Optional Account Protection Guard**:
  - Disabled by default: requests pass directly to Google without artificial local delays or token lockouts.
  - Optional Safe Mode toggle in Settings with configurable RPM, RPH, RPD, and human jitter delays.
- **Original Antigravity Desktop Aesthetic**:
  - Deep space obsidian UI (`#0B0C10` / `#141622`), electric indigo (`#6366F1`) & cyan (`#38BDF8`) accents.
  - High-resolution multi-scale `.ico` desktop and start menu shortcuts.

---

## 🤖 Agent File Tools

Обычно `tool_calls` должен исполнять клиент (Cursor, Cline). Но в обычном чате
(Open WebUI, curl, скрипты) исполнять их некому — и модель не может трогать файлы.
Поэтому шлюз умеет исполнять инструменты **сам, на сервере**: модель получает
результаты и продолжает работу, пока задача не будет выполнена.

### Как включить

Агентский цикл включается **только явно** — обычный чат (`cloud/...` или `web/...`
без суффикса) инструментов не получает.

| Способ | Пример |
|---|---|
| Алиас модели с суффиксом `-agent` | `"model": "cloud/gemini-3-flash-agent"` |
| Флаг в теле запроса | `"agent": true` с обычной `cloud/<id>` |
| Строка вместо списка tools | `"tools": "builtin"` |
| Веб-агент (opt-in) | `"model": "web/gemini-4-argon-agent"` + `agent.allowWebAgent: true` |

Провайдер определяет качество цикла:

| Namespace | Цикл | Надёжность |
|---|---|---|
| `cloud/<id>-agent` | нативный Gemini function calling (thought signatures, параллельные вызовы) | высокая, `reliability: "high"` |
| `web/<alias>-agent` | эмуляция протокола текстом (```tool_call```), только при `agent.allowWebAgent` | **VERY unreliable**, `reliability: "very-low"` |

> ⚠️ **Веб-агент — VERY unreliable.** У Gemini Web нет нативного function calling:
> запросы stateless, ответы ограничены по длине, поэтому большие проекты
> обрезаются до пары КБ. Годится только для коротких задач. Без
> `agent.allowWebAgent: true` сервер отвечает 400 `web_agent_disabled`.
> Планировщик (`ask_planner`) веб-циклу не предлагается.

```bash
curl http://127.0.0.1:8317/v1/chat/completions \
  -H "Authorization: Bearer <YOUR_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "cloud/gemini-3-flash-agent",
    "messages": [{"role": "user", "content": "Создай notes/todo.txt со списком дел на день и покажи, что получилось"}]
  }'
```

В ответе появится объект `agent` с отчётом о действиях (для веб-агента — ещё и
предупреждение):

```json
{
  "choices": [{"message": {"role": "assistant", "content": "Готово: создал notes/todo.txt …"}}],
  "agent": {
    "provider": "cloud",
    "reliability": "high",
    "workspace": "…/antigravity-api/agent_workspace",
    "iterations": 2,
    "completed": true,
    "actions": [
      {"tool": "write_file", "args": "{\"path\": \"notes/todo.txt\"}", "ok": true, "result": "{\"ok\":true,\"bytes\":123}"}
    ],
    "planner": {"enabled": true, "model": "web/gemini-4-argon-thinking", "calls": 0, "errors": 0, "ms": 0}
  }
}
```

### Planner (`ask_planner`)

В cloud-цикле модель может позвать консультанта на веб-модели
(по умолчанию `web/gemini-4-argon-thinking`): краткий план, ревью или совет.
Инструмент возвращает **результат**, а не бросает ошибку: таймаут и лимит
вызовов видны модели. Квоту Cloud Code planner не тратит и в Safe Mode
не попадает. Веб-цикл planner не получает. Отключается в
`config.json` → `agent.planner.enabled` (или через Settings & Limits → Agent).

### Инструменты

| Инструмент | Назначение | Вкл. по умолчанию |
|---|---|---|
| `list_dir` | список файлов/папок | ✅ |
| `create_dir` | создать папку (родительские — автоматически) | ✅ |
| `read_file` | чтение текстового файла (с лимитом и продолжением `next_offset`) | ✅ |
| `write_file` | создать/перезаписать файл (папки создаются автоматически) | ✅ |
| `append_file` | дописать в конец файла — для длинных файлов чанками (write_file + append_file) | ✅ |
| `edit_file` | точечная замена подстроки (как у agentic-редакторов) | ✅ |
| `move_path` | переименовать/переместить | ✅ |
| `delete_path` | удалить файл/папку | ❌ (`agent.allowDelete`) |
| `run_command` | команда оболочки в workspace | ❌ (`agent.allowShell`) |

### Безопасность

- **Песочница**: все пути строго внутри `agent.workspaceRoot`
  (по умолчанию `<проект>/agent_workspace`). Абсолютные пути, `..` и symlinks
  наружу отклоняются.
- **Лимиты**: чтение ≤ 20 КБ за раз (продолжается через `next_offset` — компактный ввод важен для веб-моделей), запись ≤ 2 МБ,
  максимум 8 tool-итераций на запрос (`agent.maxIterations`).
- **Аудит**: каждое действие пишется в `agent_audit.jsonl` (время, инструмент,
  аргументы, результат, длительность).
- Опасные инструменты (`delete_path`, `run_command`) выключены по умолчанию
  и включаются в `config.json` → `agent` осознанно.

### Как указать папку для файлов (4 способа)

**1. Прямо в запросе** (высший приоритет, работает без рестарта):

```json
{
  "model": "cloud/gemini-3-flash-agent",
  "agent": { "workspaceRoot": "C:\\Users\\me\\Desktop\\Мой проект" },
  "messages": [{ "role": "user", "content": "Создай notes.txt" }]
}
```

**2. Глобально** — `config.json` → `agent.workspaceRoot` (ко всем чатам; меняется
и на лету через `POST /_config` с телом `{"agent": {"workspaceRoot": "..."}}`).

**3. Внутри workspace** — модель сама создаёт любую структуру папок
(`создай Carbon` → `<workspace>/Carbon`); за пределы workspace ей нельзя.

**4. Прямо по абсолютному пути в чате** («создай файл Carbon в C:\Games») —
требует `agent.allowAbsolutePaths: true` в config.json (по умолчанию **выкл**).
При включённой опции модель пишет по любому пути, КРОМЕ системных папок
(Windows, Program Files, ProgramData — они заблокированы всегда). Все действия
по-прежнему пишутся в `agent_audit.jsonl`. Отключение — `"allowAbsolutePaths": false`.

### Режим размышления веб-моделей (thinkMode)

По умолчанию `web/gemini-4` / `web/gemini-4-pro` отвечают в обычном режиме (быстро).
Для сложных задач включите расширенное мышление (EXTENDED, максимум рассуждений)
для ВСЕХ веб-моделей сразу — требуется куки Google-аккаунта:

```json
"geminiWeb": { "thinkMode": "extended" }
```

Меняется и на лету: `POST /_config {"geminiWeb": {"thinkMode": "extended"}}`.
Поимённо EXTENDED включает модель `web/gemini-4-argon-thinking` / `web/gemini-4-thinking`.

### Настройки (config.json → agent)

```json
{
  "agent": {
    "enabled": true,
    "allowWebAgent": false,
    "workspaceRoot": "",
    "maxIterations": 8,
    "allowDelete": false,
    "allowShell": false,
    "shellTimeoutMs": 60000,
    "planner": {
      "enabled": true,
      "model": "web/gemini-4-argon-thinking",
      "maxCalls": 2,
      "timeoutMs": 60000
    }
  }
}
```

`autoAgent` больше не существует: обычный чат инструментов не получает,
веб-агент включается только `allowWebAgent: true`.

> **Алиасы**: модели часто называют инструменты как в других агентах — шлюз понимает
> `bash`/`terminal`/`execute_command` → `run_command`, `mkdir` → `create_dir`,
> `write_to_file` → `write_file`, `replace_in_file` → `edit_file` и т.д. Вызовы,
> выданные сырым JSON без обёртки ```tool_call, тоже распознаются (только для
> известных имён инструментов). Если модель зовёт выключенный `run_command`, она
> получает подсказку использовать `create_dir`/`write_file` и исправляется в цикле.
>
> `cloud/*` использует **нативный** Gemini function calling: `tool_calls` уходят
> как `functionCall` с thought signature, результаты — как `functionResponse`;
> текстовая склейка транскрипта не применяется, поэтому подписи не теряются.
> `web/*` — только текстовая эмуляция (VERY unreliable, opt-in).
> Прогресс инструментов в streaming-режиме передаётся событиями `agent_event`.

---

## 🔌 Connecting Clients

Configure your favorite AI client (Cursor, Cline, Continue, LibreChat, Open WebUI, etc.):

| Setting | Value |
|---|---|
| **Base URL** | `http://127.0.0.1:8317/v1` |
| **API Key** | Your generated key (shown in app or `apikey.txt`) |
| **Model** | Any model from `GET /v1/models` (e.g. `cloud/gemini-3.8-flash-tiered` or `web/gemini-4-argon`) |

> Модели всегда с префиксом провайдера: `cloud/` — Cloud Code, `web/` —
> Gemini Web. Плоские имена отклоняются с 400 и подсказкой-примером.

### Example cURL Request
```bash
curl http://127.0.0.1:8317/v1/chat/completions \
  -H "Authorization: Bearer <YOUR_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "cloud/gemini-3.8-flash-tiered",
    "messages": [{"role": "user", "content": "Hello world!"}]
  }'
```

---

## ⚙️ In-App Settings & Limits

Click **Settings & Limits** in the dashboard to access:
- **Tabs are split by provider**: the main window has **Cloud Code** (account, quotas, cloud models), **Gemini Web** (bridge, cookie/session, web models) and **Connection** (Base URL, API key, cURL example, startup); **Settings & Limits** has **Cloud**, **Web**, **Agent** (opt-in web agent, planner, workspace), **Network** and **Usage**.
- **Language switch (RU / EN)**: the **RU** / **EN** buttons in the header re-render the whole interface (main window, Settings, Diagnostic Chat, status messages) in one language. The choice is stored in `ui_language.txt` next to `app.py`; `config.json` (with credentials) is never touched. Default is English; a first run without that file starts in English and switching to RU writes it.
- **Detected Antigravity installations** (Cloud Code tab): lists Antigravity (desktop), Antigravity IDE, Antigravity CLI and the Antigravity VS Code extension with a **✓ / ○** status (a folder without an executable is treated as not installed). The pencil sets a custom path; overrides live in `install_paths.json`, never in `config.json`.
- **Changeable server port** (Connection tab): the Base URL is derived from the port. “Save & restart” validates 1–65535, refuses a port already occupied by another program, writes it to `config.json`, updates the cURL example, and restarts the running server.
- **Quota windows**: `retrieveUserQuotaSummary` returns both **Gemini Models** (`gemini-weekly`, `gemini-5h`) and **Claude/GPT** (`3p-weekly`, `3p-5h`) buckets. Google exposes the Gemini group only to the official client signature, so the gateway presents `antigravity/<version> (aidev_client; os_type=…; arch=…; cl=…)` and upgrades legacy `antigravity/1.x` values automatically. The per-model catalog quota is a 5-hour fallback if the summary is unavailable.
- **Enable Local Rate Limit & Safe Mode Guard (Checkbox)**: Disabled by default. When disabled, queries pass freely to Google Cloud Code without local synthetic token caps or false-positive 429 lockouts.
- **Agent tab**: `allowWebAgent` (off by default, marked **VERY unreliable**), planner (`enabled`, `model`, `maxCalls`, `timeoutMs`), `workspaceRoot`, `maxIterations`; dangerous flags (`allowDelete`, `allowShell`, `allowAbsolutePaths`) are shown read-only and only editable in `config.json`. The agent/planner checkboxes are **permissions, not auto-start**: nothing runs until a request explicitly uses `-agent`, `"agent": true` or `"tools": "builtin"`; the planner is only a tool the cloud agent may call.
- **Configurable Throttles**:
  - **Max Requests / Minute (RPM)**: Default `60`
  - **Max Requests / Hour**: Default `600`
  - **Max Requests / Day**: Default `3000`
  - **Max Tokens / Day**: Default `50,000,000`
  - **Min Interval (ms)**: Default `200`
  - **Max Concurrent Requests**: Default `4`
- **Real-Time Dynamic Reload**: Changes are saved to `config.json` and hot-reloaded into the running server immediately without restarting.
- **Network Transport**:
  - **Global proxy**: `http://`, `https://` or `socks5://` (credentials allowed, masked in the UI and logs).
  - **Find proxy**: scans environment variables, Windows Internet Settings and usual local ports; only loopback handshakes, no external traffic.
  - **Windows system proxy**: when no explicit proxy/env proxy is set, the server automatically uses the enabled Windows Internet Settings proxy (Node does not read it natively).
  - **AGUnlocker / antigravity-proxy relay**: detected automatically via its loopback DNS (`127.0.0.53`); only the Cloud Code API hosts (`daily-cloudcode-pa`, `cloudcode-pa`) are routed through the relay, OAuth stays direct. `gemini.google.com` is **not** sent through the relay: Google answers the relay's HTML/RPC traffic with a “sorry” verification page, so web models use the normal proxy/direct route. Explicit DNS/DoH settings turn auto-relay off.
  - **DNS-over-HTTPS / custom DNS**: real resolver used by the app's HTTP client, with cache.
  - **Use environment proxy**: honors `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`.
  - **Check connection**: probes Cloud Code, OAuth and Gemini Web routes plus DNS and the configured proxy.

---

## 🛡️ Privacy & Security

- **Zero Remote Telemetry**: Credentials (`auth.json`, `apikey.txt`, `config.json`, `usage.json`, `cookie.txt`) never leave your local machine.
- Requests travel directly between your machine and Google's official gateways (`daily-cloudcode-pa.googleapis.com`, `oauth2.googleapis.com`, `gemini.google.com`) — through your own proxy, if one is configured. The proxy is the only third party that sees the connection.
- **Cookie import is local-only**: cookies are pasted manually; they are never printed, logged or written anywhere except `config.json` when you save them.
- Keep your `auth.json` and cookie private — they are protected by `.gitignore` and never committed.

---

## 🧪 Testing

Run the full automated suite — integration (OpenAI/Gemini translation, namespaced
routing, native cloud agent loop, opt-in web agent, planner), namespace unit tests,
and agent tool tests:
```bash
npm test
```

Individual suites:

```bash
node test/run-tests.js          # integration + child suites (web bridge, diagnostics, net, cookies)
node test/test_providers.js     # cloud/ and web/ parsing, -agent, capabilities
node test/test_planner.js       # ask_planner availability, limits, timeout
node test/agent_tools_test.js   # tool specs, aliases, sandbox executor
node test/test_web_bridge.js    # exact web aliases, StreamGenerate, SSE
node test/test_diagnostics.js   # diagnostic route error contract
node lib/server_regression_check.js
```

The network layer and CDP import can also be tested in isolation:
```bash
node test/test_net.js
python test/test_cookie_cdp.py
```

Verify desktop UI startup:
```bash
python app.py --selftest
```
