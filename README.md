# Antigravity API

Turn your **Google Antigravity** account into a local **OpenAI-compatible** and **Gemini-native** API server with a desktop dashboard, live quota meters and server-side agent file tools.

[![Release](https://img.shields.io/github/v/release/flyzeen-hk/antigravity-api?style=flat-square&color=6366F1)](https://github.com/flyzeen-hk/antigravity-api/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg?style=flat-square&logo=node.js)](https://nodejs.org/)
[![Python](https://img.shields.io/badge/Python-3.10%2B-yellow.svg?style=flat-square&logo=python)](https://python.org/)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg?style=flat-square)]()

![Antigravity API](assets/antigravity_logo.png)

---

## Contents

- [Why this exists](#why-this-exists)
- [Quick start](#quick-start)
- [Two model namespaces](#two-model-namespaces)
- [Agent file tools](#agent-file-tools)
- [Gemini Web bridge](#gemini-web-bridge)
- [Connecting clients](#connecting-clients)
- [Settings and limits](#settings-and-limits)
- [Privacy and security](#privacy-and-security)
- [Testing](#testing)
- [Русская версия](#русская-версия)

---

## Why this exists

Antigravity ships with capable models — Gemini, Claude, GPT-OSS — but they are locked inside the IDE. This gateway exposes them as a normal HTTP API, so Cursor, Cline, Continue, Open WebUI, LibreChat, scripts and plain `curl` can use them as if they were OpenAI or Gemini endpoints.

It also does two things the IDE does not:

- **Server-side agent tools.** In a plain chat there is nobody to execute a `tool_call`. The gateway runs the loop itself and lets the model read and write real files.
- **Gemini Web models.** Some Gemini variants appear on `gemini.google.com` before they reach Cloud Code. The bridge routes requests through the same web backend the browser uses, with your own session.

Everything runs on your machine. Credentials never leave it.

---

## Quick start

### Prerequisites

1. **Google Antigravity IDE** installed and signed in with your Google account.
2. **Python 3.10+** from [python.org](https://www.python.org/downloads/) — on Windows tick **"Add python.exe to PATH"**.
3. **Node.js 18+** from [nodejs.org](https://nodejs.org/) (LTS is fine).

### Install

Download the latest `antigravity-api-release.zip` from [Releases](https://github.com/flyzeen-hk/antigravity-api/releases), or use `<> Code` → **Download ZIP**, or clone:

```bash
git clone https://github.com/flyzeen-hk/antigravity-api.git
cd antigravity-api
```

**Windows:** double-click `install.bat`. It checks Python and Node.js, installs dependencies, extracts your Antigravity session, and offers to create desktop and Start Menu shortcuts.

**macOS / Linux:**

```bash
chmod +x install.sh run.sh
./install.sh
./run.sh
```

### Run

Launch the **Antigravity API** shortcut, `run.bat`, or `python app.py`. The panel shows the API key, the base URL (`http://127.0.0.1:8317/v1` by default) and live quotas in percent. Press **Start API Server** and point your client at the base URL.

The interface starts in English; the **RU** / **EN** buttons switch it.

---

## Two model namespaces

Every model id carries its provider prefix:

| Prefix | Source | Auth | Tools |
|---|---|---|---|
| `cloud/<id>` | Antigravity Cloud Code | your IDE session (OAuth) | native function calling |
| `web/<alias>` | gemini.google.com | your browser session cookie | text emulation (opt-in) |

A flat name that exactly matches a model in your account catalog resolves to `cloud/<id>` for backward compatibility; unknown flat names return `400 model_namespace_required` with an example. The `-agent` suffix starts the server-side tool loop.

### Endpoints

**OpenAI:** `POST /v1/chat/completions` (streaming included), `GET /v1/models`, `GET /v1/models/{id}`.

**Gemini native:** `POST /v1beta/models/{m}:generateContent`, `:streamGenerateContent`, `:countTokens`, `GET /v1beta/models/{m}`.

Missing `model` or empty `messages` returns a local `400` instead of reaching Google. A prompt blocked by Google comes back with `finish_reason: content_filter`.

---

## Agent file tools

Normally the client executes `tool_calls`. In a plain chat there is no client, so the gateway executes them itself: the model calls a tool, gets the result, and continues until the task is done.

Tools: `list_dir`, `create_dir`, `read_file`, `write_file`, `append_file`, `edit_file`, `move_path`, plus `delete_path` and `run_command`, which are **off by default**.

Enable per request — an ordinary chat gets no tools:

| Way | Example |
|---|---|
| Model alias | `"model": "cloud/gemini-3-flash-agent"` |
| Body flag | `"agent": true` with a `cloud/<id>` model |
| Tools shortcut | `"tools": "builtin"` |
| Web agent (opt-in) | `"model": "web/gemini-4-argon-agent"` + `agent.allowWebAgent: true` |

```bash
curl http://127.0.0.1:8317/v1/chat/completions \
  -H "Authorization: Bearer <YOUR_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "cloud/gemini-3-flash-agent",
    "messages": [{"role": "user", "content": "Create notes/todo.txt with the plan for today and show the result"}]
  }'
```

The response carries an `agent` object with every action taken:

```json
{
  "choices": [{"message": {"role": "assistant", "content": "Done: created notes/todo.txt"}}],
  "agent": {
    "provider": "cloud",
    "reliability": "high",
    "workspace": "…/antigravity-api/agent_workspace",
    "iterations": 2,
    "completed": true,
    "actions": [
      {"tool": "write_file", "args": "{\"path\": \"notes/todo.txt\"}", "ok": true}
    ]
  }
}
```

### Sandbox

- All paths stay inside `agent.workspaceRoot` (default `<project>/agent_workspace`). Absolute paths, `..` and symlinks that point outside are rejected.
- Reads are capped at 20 KB per call and continue with `next_offset`; writes at 2 MB; 8 tool iterations per request.
- Every action is appended to `agent_audit.jsonl`.
- `delete_path` and `run_command` require `agent.allowDelete` / `agent.allowShell` in `config.json`.

### Choosing the workspace

1. **Per request** — `"agent": {"workspaceRoot": "C:\\Users\\me\\Project"}`.
2. **Globally** — `config.json` → `agent.workspaceRoot`, or hot-reload via `POST /_config`.
3. **Inside the workspace** — the model creates any subfolder itself.
4. **Absolute paths in chat** — needs `agent.allowAbsolutePaths: true`. System folders (Windows, Program Files, ProgramData) stay blocked on every drive.

### Planner

In the cloud loop the model may call `ask_planner` to consult a web model (default `web/gemini-4-argon-thinking`) for a short plan or review. It costs no Cloud Code quota, is capped by `maxCalls` and `timeoutMs`, and is never offered to the web loop.

---

## Gemini Web bridge

Some Gemini variants reach `gemini.google.com` before Cloud Code. The bridge sends requests to the same StreamGenerate backend the site uses.

| Model | What it is |
|---|---|
| `web/gemini-4-argon` | flagship, default thinking |
| `web/gemini-4-argon-thinking` | deepest thinking |
| `web/gemini-4` / `web/gemini-4-thinking` | aliases |
| `web/gemini-4-pro` | full capability (paid cookie) |
| `web/gemini-4-flash` | routes to Argon — no separate 4 Flash exists |

Enable it in **Settings & Limits → Gemini 4 Unlock**: sign in at gemini.google.com, open DevTools → Network, copy the **Cookie** request header of any request to gemini.google.com (it must contain `SAPISID`) and paste it into the field. A `cookie.txt` next to the app works too. There are no automatic extraction buttons.

Honest limitations:

- **It is unofficial.** Google can change the internal format at any time.
- **Answers are slow.** 10–30 s for a short question is normal; thinking modes take longer. That is Gemini generating, not a local delay.
- **No native tools.** The web protocol has no function calling; the web agent emulates it as text and is **VERY unreliable** — short tasks only.
- **Session cookies matter.** Chrome/Edge 127+ can bind the session to the browser (DBSC); such cookies may be rejected by a local gateway even though the browser works.
- **Region.** If gemini.google.com is blocked from your IP, set a proxy in **Network Transport** or a web-only proxy for the bridge.

---

## Connecting clients

| Setting | Value |
|---|---|
| Base URL | `http://127.0.0.1:8317/v1` |
| API Key | from the panel or `apikey.txt` |
| Model | any id from `GET /v1/models` |

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

## Settings and limits

The panel is split by provider: **Cloud Code** (account, quotas, models), **Gemini Web** (bridge, cookie, models) and **Connection** (base URL, key, cURL example, autostart). **Settings & Limits** holds **Cloud**, **Web**, **Agent**, **Network** and **Usage**.

- **Quotas** come from `retrieveUserQuotaSummary`: weekly and 5-hour buckets for Gemini and for Claude/GPT. The gateway presents the official client signature; otherwise Google hides the Gemini group.
- **Safe Mode** is off by default. When enabled it applies RPM, requests per hour and per day, tokens per day, minimum interval and concurrency limits locally.
- **Network Transport**: global HTTP/HTTPS/SOCKS5 proxy, proxy auto-detection, DNS-over-HTTPS or custom DNS servers, and a connection test. Settings apply without a restart.
- **Port** can be changed and the running server restarted from the panel.

---

## Privacy and security

- **No telemetry.** `auth.json`, `apikey.txt`, `config.json`, `usage.json` and `cookie.txt` never leave your machine and are covered by `.gitignore`.
- Requests go straight to Google's gateways through your own proxy if you configured one.
- Cookies are pasted locally and are never printed or logged.
- Writes to `config.json`, `auth.json` and `usage.json` are atomic and keep rolling backups, so a power loss cannot leave them half written.

---

## Testing

```bash
npm test            # every suite
```

Individual suites:

```bash
node test/run-tests.js              # integration: routing, streaming, agent, planner
node test/test_translate.js         # OpenAI <-> Gemini conversion
node test/agent_tools_test.js       # tool specs, sandbox, aliases
node test/test_web_bridge.js        # web aliases, payload, language detection
node test/test_diagnostics.js       # diagnostic route contracts
node test/test_safe_files.js        # atomic writes and backups
node test/test_net.js               # proxy, DNS, timeouts
python test/test_app_config.py      # panel config safety
python test/test_cookie_cdp.py      # CDP cookie import
```

Check that the desktop panel starts:

```bash
python app.py --selftest
```

---

# Русская версия

Локальный шлюз, который превращает аккаунт **Google Antigravity** в обычный **OpenAI-совместимый** и **Gemini-native** API-сервер с панелью, живыми квотами в процентах и файловыми инструментами на стороне сервера.

## Зачем это нужно

Модели Gemini, Claude и GPT-OSS живут внутри IDE Antigravity и недоступны снаружи. Шлюз открывает их как обычный HTTP API, и ими можно пользоваться из Cursor, Cline, Continue, Open WebUI, LibreChat, скриптов и обычного `curl`.

Сверх этого шлюз умеет то, чего нет в IDE:

- **Файловые инструменты.** В обычном чате некому исполнять `tool_call` — шлюз делает это сам и даёт модели читать и писать реальные файлы.
- **Модели Gemini Web.** Часть моделей раньше появляется на `gemini.google.com`, чем в Cloud Code; мост идёт через тот же веб-бэкенд, что и браузер, с вашей сессией.

Всё работает на вашем компьютере, ключи никуда не уходят.

## Быстрый старт

**Что нужно:**

1. **Google Antigravity IDE**, установленная со входом в аккаунт Google.
2. **Python 3.10+** с [python.org](https://www.python.org/downloads/). На Windows обязательно поставьте галочку **«Add python.exe to PATH»**.
3. **Node.js 18+** с [nodejs.org](https://nodejs.org/) (подойдёт LTS).

**Установка.** Скачайте `antigravity-api-release.zip` со страницы [Releases](https://github.com/flyzeen-hk/antigravity-api/releases) (или кнопка `<> Code` → **Download ZIP**), либо клонируйте репозиторий:

```bash
git clone https://github.com/flyzeen-hk/antigravity-api.git
cd antigravity-api
```

**Windows:** запустите `install.bat`. Он проверит Python и Node.js, поставит зависимости, извлечёт сессию Antigravity и предложит создать ярлыки на Рабочем столе и в меню «Пуск».

**Linux / macOS:**

```bash
chmod +x install.sh run.sh
./install.sh
./run.sh
```

**Запуск.** Ярлык **«Antigravity API»**, файл `run.bat` или `python app.py`. В окне видны API-ключ, Base URL (`http://127.0.0.1:8317/v1` по умолчанию) и остатки квот в процентах. Нажмите **Start API Server** и укажите этот адрес в своём клиенте.

Интерфейс открывается на английском; кнопки **RU** / **EN** переключают язык.

## Два пространства имён

У каждой модели есть префикс провайдера:

| Префикс | Источник | Авторизация | Инструменты |
|---|---|---|---|
| `cloud/<id>` | Antigravity Cloud Code | сессия IDE (OAuth) | нативный function calling |
| `web/<alias>` | gemini.google.com | cookie браузера | текстовая эмуляция (по желанию) |

Плоское имя, точно совпадающее с моделью каталога аккаунта, трактуется как `cloud/<id>` — для совместимости со старыми клиентами. Неизвестные плоские имена дают `400 model_namespace_required` с примером. Суффикс `-agent` включает агентский цикл.

**Эндпоинты.** OpenAI: `POST /v1/chat/completions` (включая стриминг), `GET /v1/models`, `GET /v1/models/{id}`. Gemini: `POST /v1beta/models/{m}:generateContent`, `:streamGenerateContent`, `:countTokens`, `GET /v1beta/models/{m}`.

Отсутствующий `model` или пустой `messages` дают локальный `400`, не доходя до Google. Промпт, заблокированный Google, приходит с `finish_reason: content_filter`.

## Файловые инструменты агента

Обычно `tool_calls` исполняет клиент. В обычном чате клиента нет, поэтому шлюз исполняет инструменты сам: модель зовёт инструмент, получает результат и продолжает работу, пока задача не готова.

Инструменты: `list_dir`, `create_dir`, `read_file`, `write_file`, `append_file`, `edit_file`, `move_path`, а также `delete_path` и `run_command` — они **выключены по умолчанию**.

Включается только явно — обычный чат инструментов не получает:

| Способ | Пример |
|---|---|
| Алиас модели | `"model": "cloud/gemini-3-flash-agent"` |
| Флаг в теле | `"agent": true` с моделью `cloud/<id>` |
| Сокращение для tools | `"tools": "builtin"` |
| Веб-агент (по желанию) | `"model": "web/gemini-4-argon-agent"` + `agent.allowWebAgent: true` |

```bash
curl http://127.0.0.1:8317/v1/chat/completions \
  -H "Authorization: Bearer <YOUR_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "cloud/gemini-3-flash-agent",
    "messages": [{"role": "user", "content": "Создай notes/todo.txt со списком дел на день и покажи результат"}]
  }'
```

В ответе будет объект `agent` со всеми выполненными действиями.

**Песочница:**

- Все пути строго внутри `agent.workspaceRoot` (по умолчанию `<проект>/agent_workspace`). Абсолютные пути, `..` и symlink'и наружу отклоняются.
- Чтение — до 20 КБ за вызов с продолжением через `next_offset`; запись — до 2 МБ; до 8 итераций инструментов на запрос.
- Каждое действие пишется в `agent_audit.jsonl`.
- `delete_path` и `run_command` требуют `agent.allowDelete` / `agent.allowShell` в `config.json`.

**Куда писать файлы:**

1. **В запросе** — `"agent": {"workspaceRoot": "C:\\Users\\me\\Project"}`.
2. **Глобально** — `config.json` → `agent.workspaceRoot`, меняется и на лету через `POST /_config`.
3. **Внутри workspace** — модель сама создаёт нужные папки.
4. **По абсолютному пути** — нужен `agent.allowAbsolutePaths: true`. Системные папки (Windows, Program Files, ProgramData) заблокированы всегда, на любом диске.

**Планировщик.** В cloud-цикле модель может вызвать `ask_planner` и получить короткий план или ревью от веб-модели (по умолчанию `web/gemini-4-argon-thinking`). Квота Cloud Code не тратится, вызовы ограничены `maxCalls` и `timeoutMs`. Веб-циклу планировщик не выдаётся.

## Веб-мост Gemini

Часть моделей Gemini раньше появляется на `gemini.google.com`, чем в Cloud Code. Мост отправляет запросы в тот же бэкенд StreamGenerate, которым пользуется сайт.

| Модель | Что это |
|---|---|
| `web/gemini-4-argon` | флагман, обычное мышление |
| `web/gemini-4-argon-thinking` | максимальное мышление |
| `web/gemini-4` / `web/gemini-4-thinking` | псевдонимы |
| `web/gemini-4-pro` | полная мощность (платная куки) |
| `web/gemini-4-flash` | ведёт на Argon — отдельной «4 Flash» не существует |

**Включение:** **Settings & Limits → Gemini 4 Unlock**. Войдите на gemini.google.com, откройте DevTools → Network, выберите запрос к gemini.google.com и скопируйте заголовок **Cookie** (в нём должен быть `SAPISID`) в поле. Подойдёт и файл `cookie.txt` рядом с программой. Автоматических кнопок извлечения нет.

**Честно об ограничениях:**

- **Мост неофициальный.** Google может поменять внутренний формат в любой момент.
- **Ответы медленные.** 10–30 секунд на короткий вопрос — норма, режимы мышления дольше. Это время генерации Gemini, а не задержка программы.
- **Нет нативных инструментов.** В веб-протоколе нет function calling; веб-агент эмулирует его текстом и работает **VERY unreliable** — только короткие задачи.
- **Куки решают.** Chrome/Edge 127+ могут привязывать сессию к браузеру (DBSC), и такая куки может не приниматься шлюзом, хотя браузер работает.
- **Регион.** Если gemini.google.com недоступен с вашего IP, задайте прокси в **Network Transport** или отдельный прокси для моста.

## Подключение клиентов

| Параметр | Значение |
|---|---|
| Base URL | `http://127.0.0.1:8317/v1` |
| API Key | из окна программы или `apikey.txt` |
| Модель | любой id из `GET /v1/models` |

```bash
curl http://127.0.0.1:8317/v1/chat/completions \
  -H "Authorization: Bearer <YOUR_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "cloud/gemini-3.8-flash-tiered",
    "messages": [{"role": "user", "content": "Привет, мир!"}]
  }'
```

## Настройки и лимиты

Окно разделено по провайдерам: **Cloud Code** (аккаунт, квоты, модели), **Gemini Web** (мост, куки, модели) и **Connection** (Base URL, ключ, пример cURL, автозапуск). В **Settings & Limits** — разделы **Cloud**, **Web**, **Agent**, **Network** и **Usage**.

- **Квоты** берутся из `retrieveUserQuotaSummary`: недельные и пятичасовые окна для Gemini и для Claude/GPT.
- **Safe Mode** выключен по умолчанию; при включении работает по RPM, запросам в час и день, токенам в день, минимальному интервалу и параллельности.
- **Network Transport**: глобальный прокси, автопоиск прокси, DNS-over-HTTPS или свои DNS, проверка соединения. Применяется без перезапуска.
- **Порт** меняется из окна, сервер перезапускается сам.

## Приватность и безопасность

- **Никакой телеметрии.** `auth.json`, `apikey.txt`, `config.json`, `usage.json` и `cookie.txt` не покидают ваш компьютер и закрыты в `.gitignore`.
- Запросы идут напрямую к серверам Google — через ваш прокси, если он настроен.
- Куки вставляются локально и нигде не печатаются и не логируются.
- Запись в `config.json`, `auth.json` и `usage.json` атомарная, со скользящими резервными копиями: сбой питания не оставит файл записанным наполовину.

## Тесты

```bash
npm test            # весь набор
```

По отдельности:

```bash
node test/run-tests.js              # интеграция: маршруты, стриминг, агент, планировщик
node test/test_translate.js         # конвертация OpenAI <-> Gemini
node test/agent_tools_test.js       # инструменты и песочница
node test/test_web_bridge.js        # веб-алиасы, payload, определение языка
node test/test_diagnostics.js       # контракты диагностики
node test/test_safe_files.js        # атомарная запись и бэкапы
node test/test_net.js               # прокси, DNS, таймауты
python test/test_app_config.py      # сохранность config.json
python test/test_cookie_cdp.py      # импорт куки через CDP
```

Проверить, что панель запускается:

```bash
python app.py --selftest
```
