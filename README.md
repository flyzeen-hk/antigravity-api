# Antigravity API

Expose Google Antigravity's models — Gemini, Claude, GPT-OSS — as a local **OpenAI-compatible** and **Gemini-native** HTTP API, with a desktop panel, live quota meters and server-side file tools for clients that cannot run tool calls.

![Antigravity API](assets/antigravity_logo.png)

---

## Contents

- [What it is and is not](#what-it-is-and-is-not)
- [Requirements](#requirements)
- [Install](#install)
- [First run](#first-run)
- [Model namespaces](#model-namespaces)
- [Endpoints](#endpoints)
- [Agent file tools](#agent-file-tools)
- [Gemini Web bridge](#gemini-web-bridge)
- [Connecting a client](#connecting-a-client)
- [Settings and limits](#settings-and-limits)
- [Data and privacy](#data-and-privacy)
- [Troubleshooting](#troubleshooting)
- [Testing](#testing)
- [Русская версия](#русская-версия)

---

## What it is and is not

**It is** a local HTTP server that relays requests to two different Google backends using credentials you already have on this machine:

- **Cloud Code** (`cloud/<id>`) — the same backend the Antigravity products use. Authentication is the OAuth session the Antigravity app or IDE already created on this machine.
- **Gemini Web** (`web/<alias>`) — the same StreamGenerate RPC that `gemini.google.com` uses. Authentication is a browser cookie you copy in manually.

**It is not:**

- **Not an official Google API.** Nothing here is supported by Google. The web half relies on an internal protocol that can change without notice.
- **Not free unlimited access.** Cloud models spend the quota of your own Antigravity account. The panel shows that quota in percent; when it runs out, requests fail exactly as they would inside Antigravity.
- **Not a remote service.** The server binds `127.0.0.1` by default. It is reachable from the network only if you change `host` yourself, and there is no built-in TLS — do not expose it directly to the internet.
- **Not a model host.** No model runs locally. Every request goes to Google.
- **Not a client.** You still need Cursor, Cline, Open WebUI, a script, or `curl` to talk to it.

What it adds on top of the raw APIs:

- **Server-side tool execution.** Chat clients that cannot run `tool_calls` still get working file tools, because the gateway runs the loop itself.
- **One endpoint for both providers.** Namespaced ids (`cloud/…`, `web/…`) in a single `/v1/models` list.
- **Panels, quotas and limits** without editing config files.

---

## Requirements

| Requirement | Why | Notes |
|---|---|---|
| **Antigravity desktop app or Antigravity IDE**, signed in | Source of the Cloud Code OAuth session | `scripts/extract_token.py` reads `state.vscdb` from `%APPDATA%\Antigravity IDE`, `%APPDATA%\Antigravity` or `%APPDATA%\antigravity` (macOS and Linux have the equivalent paths; `ANTIGRAVITY_STATE_DB` points it elsewhere). The app does not need to be running — only the stored session is used. **Antigravity CLI and the Antigravity extension for VS Code are detected by the panel but are not a token source.** |
| **Node.js 18+** | Runs `server.js` | LTS is fine. |
| **Python 3.10+** | Runs `app.py` (desktop panel), the installer, and the token extraction that fills `auth.json` | On Windows tick **"Add python.exe to PATH"** during install. Once `auth.json` exists, `node server.js` runs without Python — but the panel and re-extraction do need it. |

The `web/` bridge needs one more thing, but only if you intend to use web models: a Google account cookie from `gemini.google.com` (see [Gemini Web bridge](#gemini-web-bridge)). Cloud models work without it.

---

## Install

### Download

Take `antigravity-api-release.zip` from [Releases](https://github.com/flyzeen-hk/antigravity-api/releases) and extract it anywhere, or use `<> Code` → **Download ZIP**, or clone:

```bash
git clone https://github.com/flyzeen-hk/antigravity-api.git
cd antigravity-api
```

### Windows

Double-click **`install.bat`**. It checks Python and Node.js, installs the Python dependencies from `requirements.txt`, pulls your Antigravity session into `auth.json`, and asks whether to create Desktop and Start Menu shortcuts (answer `y` or `N`).

### macOS / Linux

```bash
chmod +x install.sh run.sh
./install.sh
./run.sh
```

### Manual install

If you prefer to do it yourself:

```bash
pip install -r requirements.txt       # panel only
python scripts/extract_token.py       # writes auth.json from the IDE session
python app.py                         # panel; press Start API Server
# or, without the panel:
node server.js                        # reads auth.json, serves on 127.0.0.1:8317
```

### Docker

Headless, no Python and no panel. Only the gateway:

```bash
mkdir -p data && cp auth.json data/            # cloud/* models need OAuth tokens
cp cookie.txt data/ 2>/dev/null                # optional: enables web/* models
docker compose up -d
cat data/apikey.txt                            # the generated client key
curl -s http://127.0.0.1:8317/_health
```

Notes that matter:

- The port is published on `127.0.0.1` only. The gateway is not meant to be exposed to a network
  without `adminKey` and TLS in front of it.
- `AG_DATA_DIR=/data` keeps `config.json`, `apikey.txt`, `auth.json`, `usage.json` and `backups/` in
  the volume; the image itself carries no secrets.
- OAuth cannot be completed inside the container — `auth.json` has to be produced on the host
  (`python scripts/extract_token.py`) and mounted.
- Without `auth.json` only `web/*` models and the local endpoints work.
- `AG_HOST` / `AG_PORT` override `config.json`, which is how the container listens on `0.0.0.0`.

---

## First run

1. Start the panel (`python app.py`, `run.bat`, or the shortcut). It opens in **English**; **RU / EN** in the header switches languages.
2. The panel shows the **API key**, the **base URL** (`http://127.0.0.1:8317/v1`), the detected Antigravity account and the current quota percentages.
3. Press **Start API Server**. The dot turns green when `GET /_health` answers.
4. Point your client at the base URL with that key.

Two files appear next to the program on first run and are **never committed**:

| File | Contents |
|---|---|
| `config.json` | settings, including the web-bridge cookie if you paste one |
| `apikey.txt` | the generated local API key |

If the key is lost, read it from `apikey.txt` or run `node server.js key`.

---

## Model namespaces

Every id has a provider prefix. This is not cosmetic — it decides which backend is contacted.

| Prefix | Backend | Authentication | Tool calling |
|---|---|---|---|
| `cloud/<id>` | Cloud Code | Antigravity OAuth session (`auth.json`) | native Gemini function calling |
| `web/<alias>` | gemini.google.com | browser cookie (manual) | none natively; text emulation is opt-in |

Rules that are easy to trip over:

- **Exact flat names still work.** A name with no prefix that exactly matches a model in your account catalog resolves to `cloud/<id>`, so older configurations keep working.
- **Unknown flat names fail** with `400 model_namespace_required` and an example — they are not guessed.
- **`-agent` is a suffix on the model id**, not a separate model: `cloud/gemini-3-flash-agent` is the same model in agent mode.
- **`cloud/` always goes to Cloud Code**, even if a web alias shares the name, so the two providers cannot shadow each other.

`GET /v1/models` lists both, each with `provider` and `owned_by` set, so a client can filter them.

---

## Endpoints

All endpoints except `/_health` require the key. Three ways are accepted:

```bash
-H "Authorization: Bearer <KEY>"      # OpenAI style
-H "x-goog-api-key: <KEY>"            # Gemini SDK style
?key=<KEY>                            # query style
```

### OpenAI-compatible

| Method | Path | Notes |
|---|---|---|
| POST | `/v1/chat/completions` | Streaming with `"stream": true`; `tool_calls` supported on `cloud/` |
| GET | `/v1/models` | Both namespaces in one list |
| GET | `/v1/models/{id}` | Single model; `404 model_not_found` if absent |

### Anthropic-compatible

| Method | Path | Notes |
|---|---|---|
| POST | `/v1/messages` | Claude Code, Cline, Continue, Zed; `stream: true` gives `message_start … message_stop` |
| POST | `/v1/messages/count_tokens` | Local estimate (~3.5 chars/token), no Google call |

`x-api-key: <KEY>` and `Authorization: Bearer <KEY>` both work, so an Anthropic client
can point at this gateway with `ANTHROPIC_BASE_URL=http://127.0.0.1:8317`.
Model names are mapped automatically: `claude-sonnet-4-5-20250929` → `cloud/claude-sonnet-4-5-20250929`.
Non-Claude ids pass through unchanged, so `claude-*`-style clients can also reach Gemini models.

CORS: `OPTIONS` preflight returns `204` with `access-control-allow-*` for the requesting
origin, so browser clients (Open WebUI, LibreChat, your own page) can call the gateway directly.

### Gemini native

| Method | Path | Notes |
|---|---|---|
| POST | `/v1beta/models/{m}:generateContent` | Returns a candidate with `finishReason` |
| POST | `/v1beta/models/{m}:streamGenerateContent` | Add `?alt=sse` for SSE framing |
| POST | `/v1beta/models/{m}:countTokens` | For `web/` models this is a local estimate, not a Google call |
| GET | `/v1beta/models/{m}` | Model metadata |

### Local

| Method | Path | Notes |
|---|---|---|
| GET | `/_health` | **No key required** — used by the panel to detect a running server |
| GET | `/_status` | Counters, tokens, network summary, agent settings |
| GET | `/_limits`, `/_quota` | Quotas; calls Google, can be slow on a cold start |
| GET | `/_network/test` | Probes Cloud Code, OAuth and Gemini Web routes |
| POST | `/_config` | Hot-updates Safe Mode, network and agent settings |
| POST | `/api/diagnostics/chat` | One-shot probe with a diagnostic error contract |

### Error behaviour worth knowing

- **Validation is local.** A missing `model` or empty `messages` returns `400` without contacting Google.
- **Oversized bodies return `413`** (`body_too_large`) above 16 MB (`AG_MAX_BODY_BYTES`). The check runs on
  `content-length` before any body is read, and streamed bodies are drained after the response so the client
  actually sees the 413 instead of a reset.
- **Client disconnect cancels the upstream request** and is logged as `499`, not as a server error.
- **A prompt blocked by Google** returns normally with `finish_reason: content_filter` and `promptFeedback`, not a 500.
- **Region blocks** surface as `region_not_supported` / `LOCATION_REJECTED 1060`. That is about the egress IP, not your account or cookie.

---

## Agent file tools

In Cursor or Cline the client executes `tool_calls`. In a plain chat nobody does, so the gateway executes them itself: the model asks for a tool, the gateway runs it on disk, the result goes back to the model, and the loop repeats until the model stops asking or the iteration cap is hit.

### Enabling

An ordinary chat gets **no** tools. Pick one of:

| Way | Example | Applies to |
|---|---|---|
| Model suffix | `"model": "cloud/gemini-3-flash-agent"` | cloud |
| Body flag | `"agent": true` | cloud |
| Tools shortcut | `"tools": "builtin"` | cloud |
| Web agent | `"model": "web/gemini-4-argon-agent"` plus `agent.allowWebAgent: true` in `config.json` | web |

```bash
curl http://127.0.0.1:8317/v1/chat/completions \
  -H "Authorization: Bearer <YOUR_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "cloud/gemini-3-flash-agent",
    "messages": [{"role": "user", "content": "Create notes/todo.txt with the plan for today and show the result"}]
  }'
```

The response includes an `agent` object describing what happened:

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

`completed: false` means the iteration cap was hit before the model finished — the answer is partial and the trace shows where it stopped.

### Tools

| Tool | What it does | Default |
|---|---|---|
| `list_dir` | Lists files and folders | on |
| `create_dir` | Creates a folder, including parents | on |
| `read_file` | Reads text; returns `next_offset` when truncated | on |
| `write_file` | Creates or overwrites a file, creating parents | on |
| `append_file` | Appends — use it to build long files in chunks | on |
| `edit_file` | Replaces one exact substring; refuses when ambiguous unless `replace_all` | on |
| `move_path` | Renames or moves; refuses to overwrite | on |
| `delete_path` | Deletes a file or folder | **off** — `agent.allowDelete` |
| `run_command` | Shell command with the workspace as cwd | **off** — `agent.allowShell` |

Tool names are aliased: `bash`, `terminal`, `shell`, `execute_command` → `run_command`; `mkdir` → `create_dir`; `write_to_file` → `write_file`; `replace_in_file` → `edit_file`; and so on. Calls emitted as raw JSON without the `tool_call` fence are recognised too, but only for known tool names, so ordinary text is never mistaken for a call.

### Limits and sandbox

| Limit | Default | Config key |
|---|---|---|
| Tool iterations per request | 8 | `agent.maxIterations` |
| Bytes read per `read_file` | 20 KB | `agent.maxReadBytes` |
| Bytes written per file | 2 MB | `agent.maxWriteBytes` |
| Entries returned by `list_dir` | 500 | `agent.maxListEntries` |
| Shell timeout | 60 s | `agent.shellTimeoutMs` |
| Audit log size before rotation | 5 MB | `agent.auditRotateBytes` |

- Paths are confined to `agent.workspaceRoot`. `..`, absolute paths (without the flag) and symlinks pointing outside are rejected.
- With `agent.allowAbsolutePaths: true`, writes outside the workspace are allowed, but these stay blocked on every drive: `\Windows`, `\Program Files`, `\Program Files (x86)`, `\ProgramData`.
- Every action is appended to `agent_audit.jsonl` with its result; the file rotates to `.1` when it exceeds the threshold.
- Long file work is expected to be chunked: `write_file` once, then `append_file`. A single reply is length-capped by the model, not by the gateway.

### Choosing the workspace

1. **Per request** — `"agent": {"workspaceRoot": "C:\\Users\\me\\Project"}`.
2. **Globally** — `config.json` → `agent.workspaceRoot`, or hot-reload with `POST /_config`.
3. **Subfolders** — the model creates them inside the workspace itself.
4. **Absolute paths** — requires `agent.allowAbsolutePaths: true`, subject to the system-folder block above.

### Planner

Inside the cloud loop the model may call `ask_planner` to ask a Gemini Web model (default `web/gemini-4-argon-thinking`) for a short plan or review. It returns a tool result rather than an error, so a timeout is visible to the model instead of failing the request. It spends no Cloud Code quota and is never offered to the web loop. Disable it with `agent.planner.enabled: false`.

---

## Gemini Web bridge

Some Gemini variants appear on `gemini.google.com` before they reach Cloud Code. The bridge sends requests to the same StreamGenerate backend the site uses, with your own session cookie.

| Model | Meaning |
|---|---|
| `web/gemini-4-argon` | flagship, default thinking depth |
| `web/gemini-4-argon-thinking` | deepest thinking — slowest |
| `web/gemini-4` | alias of `web/gemini-4-argon` |
| `web/gemini-4-thinking` | alias of `web/gemini-4-argon-thinking` |
| `web/gemini-4-pro` | same backend, described as full capability |
| `web/gemini-4-flash` | routes to Argon; no separate "4 Flash" exists |

All six route to the same `modelId` with two thinking depths, so the difference between "Argon" and "Pro" is naming, not a separate model.

### Enabling

**Settings & Limits → Gemini 4 Unlock**, then:

1. Sign in at `gemini.google.com`.
2. Open DevTools → Network, pick any request to `gemini.google.com`.
3. Copy the entire **Cookie** request header — it must contain `SAPISID`.
4. Paste it into the field and save. Changes apply to the running server immediately.

A `cookie.txt` next to the program works too. There are no automatic extraction buttons by design.

Without a cookie the bridge still starts and the models are listed, but requests are made anonymously and Google usually downgrades or refuses them. `GET /_config` reports `cookieSet: false` in that state.

### Multiple accounts

One gateway, several Google cookies. Each entry has its own cookie, optional proxy,
`authUser` and label:

```json
{
  "geminiWeb": {
    "accounts": [
      { "name": "personal", "cookie_file": "cookie-personal.txt", "label": "Pro", "proxy": "" },
      { "name": "work", "cookie_file": "cookie-work.txt", "label": "Workspace", "proxy": "http://127.0.0.1:7890" }
    ],
    "activeAccount": "personal",
    "autoRotateOn429": true
  }
}
```

- The active account is used until it fails. `401`/`403` (dead cookie) always moves to the next
  account and retries once; `429` does so only with `autoRotateOn429: true`.
- A failed account cools down (10 min for auth errors, 2 min for a 429) and is skipped by rotation.
- `GET /_status` → `geminiWeb.accounts[]` shows `active`, `requests`, `errors`, `cooldownUntil`,
  `lastError` per account; the dashboard shows the same as a single line.
- With `accounts: []` the single `cookie`/`cookie_file` keeps working exactly as before.

### Limitations, stated plainly

- **Unofficial.** The request format is reverse-engineered; Google can break it at any time.
- **Slow.** A short question typically takes 10–30 s and thinking modes take longer. The delay is Gemini generating, not the gateway — the local part (TLS handshake and request building) measured under half a second.
- **No native function calling.** The web protocol has none. `web/…-agent` fakes it by parsing `tool_call` blocks out of the answer text, which is why it is labelled **VERY unreliable** and capped in practice by reply length. Short tasks only.
- **Model identity is heuristic.** Google does not attest which model produced a reply in this protocol. The mode selector is checked to be the Argon one, but that is evidence, not proof.
- **Session binding can break it.** Chrome/Edge 127+ can bind a Google session to the browser (`Device Bound Sessions`), and such a cookie may be rejected by a local client even though the browser works.
- **Region matters.** If `gemini.google.com` is unreachable from your IP, set a proxy in **Network Transport** or a web-only proxy for the bridge.
- **The bridge is stateless.** The whole transcript is resent each turn, so cost grows with chat length.

---

## Connecting a client

| Setting | Value |
|---|---|
| Base URL | `http://127.0.0.1:8317/v1` |
| API key | from the panel or `apikey.txt` |
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

If your client needs a model list before it will connect, use `GET /v1/models`; every entry there is directly usable as `model`.

---

## Settings and limits

The panel is split by provider, because the two have nothing in common but the API:

- **Cloud Code** — account, quotas, cloud model list, and the detected Antigravity products (Antigravity, Antigravity IDE, Antigravity CLI, Antigravity for VS Code). The list is informational: only the app/IDE storage provides the token.
- **Gemini Web** — bridge state, cookie, web models, thinking depth, temporary chats.
- **Connection** — base URL, key, cURL example, port, autostart.
- **Settings & Limits** — **Cloud** (Safe Mode), **Web**, **Agent** (web agent permission, planner, workspace), **Network**, **Usage**.

Facts worth stating explicitly:

- **Safe Mode is off by default.** When off, requests go straight to Google with no local delays and no local 429s.
- **When on**, it applies limits you choose: requests per minute, hour, day and week; tokens per day and week; minimum interval between requests; maximum concurrency. The panel shows the values actually in force.
- **Agent permissions are not autostart.** Enabling the web agent or the planner only grants permission; nothing runs until a request asks for it with `-agent`, `"agent": true` or `"tools": "builtin"`.
- **Dangerous agent flags are read-only in the panel.** `allowDelete`, `allowShell` and `allowAbsolutePaths` can only be changed in `config.json`, and need a restart.
- **The port is changeable** from the Connection tab. Saving restarts the running server; a port already used by another program is refused.
- **Settings apply without a restart** for Safe Mode, network and agent options; only the dangerous flags above need one.

### Network

- **Proxy**: `http://`, `https://` or `socks5://`, with credentials. Applied to every outbound request; `NO_PROXY` is respected.
- **System proxy**: when no explicit proxy is set, the Windows Internet Settings proxy is used automatically (Node does not read it by itself).
- **DNS**: DNS-over-HTTPS or explicit DNS servers, used by the app's own HTTP client.
- **Auto-detection** scans environment variables, the Windows settings and common local ports, with loopback-only handshakes.
- **Not included on purpose**: domain fronting, TLS fragmentation, ECH spoofing. Pair the app with your own tunnel and point the proxy field at it.
- **Fallback host**: if `daily-cloudcode-pa.googleapis.com` fails at the network level, the request is retried once against `cloudcode-pa.googleapis.com`. HTTP statuses are never retried this way.

---

## Data and privacy

- **Everything stays local.** `auth.json`, `apikey.txt`, `config.json`, `usage.json` and `cookie.txt` live next to the program and are listed in `.gitignore`.
- **The only outbound traffic** goes to `daily-cloudcode-pa.googleapis.com`, `oauth2.googleapis.com` and `gemini.google.com` — or through your proxy. There is no telemetry endpoint.
- **Cookies are never printed or logged.** They are sent only to `gemini.google.com`. The panel redacts keys, tokens and cookie values from diagnostics and error text.
- **Config writes are atomic** with rolling backups in `backups/`. A damaged file is restored from the newest valid backup and the bad copy is kept as `.corrupt`.
- **The API key protects local access only.** Anyone on your machine who can read `apikey.txt` can use the gateway. Keep `host` on `127.0.0.1`.
- **Rotation:** an exposed cookie or key must be replaced manually — delete `auth.json` and re-run the token extraction, or delete `apikey.txt` and restart the server to generate a new key.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Panel stuck on «Loading…» quotas, `Offline (fetch failed)` | Google host unreachable — DNS filtering or DPI | Set a proxy in **Network Transport**; run **Check connection** |
| `region_not_supported` on `cloud/` | Egress IP not in a supported region | Use a proxy in a supported region; the account and cookie are not the cause |
| `401` from Cloud Code | Session expired or the IDE account changed | Re-run `python scripts/extract_token.py` |
| Web models return empty or garbled text | Cookie expired, wrong account, or cookie not bound to this browser | Re-copy the Cookie header; check `GET /_config` → `cookieSet` |
| Web request redirects to a Google «sorry» page | Google verification triggered by the egress IP | Change proxy/egress; the bridge reports `web_verification_required` |
| Answers truncated mid-file | Model reply length cap, not the gateway | Ask for chunked writing: `write_file` then `append_file` |
| `413 body_too_large` | Request above 64 MB | Send less in one request |
| `499` in the log | The client disconnected | Nothing to fix; the upstream request was cancelled |
| Port already in use | Another program or an old server on 8317 | Change the port in the Connection tab |

---

## Testing

```bash
npm test
```

That runs every suite: integration routing and streaming, translation, agent tools, the web bridge, diagnostics, safe file writes, networking, panel config and cookie extraction. Individual suites:

```bash
node test/run-tests.js              # integration: routing, streaming, agent, planner
node test/test_translate.js         # OpenAI <-> Gemini conversion
node test/agent_tools_test.js       # tool specs, sandbox, aliases
node test/test_web_bridge.js        # web aliases, payload, language detection
node test/test_diagnostics.js       # diagnostic route contracts
node test/test_safe_files.js        # atomic writes and backups
node test/test_net.js               # proxy, DNS, timeouts
node test/test_providers.js         # namespace parsing
node test/test_planner.js           # planner limits and timeout
python test/test_app_config.py      # panel config safety
python test/test_cookie_extract.py  # cookie import from a browser profile
python test/test_cookie_cdp.py      # cookie import over CDP
```

Panel smoke test:

```bash
python app.py --selftest
```

---

# Русская версия

Шлюз, который открывает модели **Google Antigravity** — Gemini, Claude, GPT-OSS — как обычный **OpenAI-совместимый** и **Gemini-native** HTTP API, с панелью на рабочем столе, живыми квотами и файловыми инструментами на стороне сервера.

## Что это и что это не

**Это** локальный HTTP-сервер, который пересылает запросы к двум разным бэкендам Google, используя учётные данные, уже имеющиеся на этом компьютере:

- **Cloud Code** (`cloud/<id>`) — тот же бэкенд, что используют продукты Antigravity. Авторизация — OAuth-сессия, которую приложение Antigravity или IDE уже создали на этой машине.
- **Gemini Web** (`web/<alias>`) — тот же StreamGenerate RPC, что использует `gemini.google.com`. Авторизация — куки браузера, которые вы копируете вручную.

**Это не:**

- **Не официальный API Google.** Google ничего из этого не поддерживает. Веб-часть держится на внутреннем протоколе, который может измениться без предупреждения.
- **Не бесплатный безлимитный доступ.** Модели `cloud/` расходуют квоту вашего аккаунта Antigravity. Панель показывает её в процентах; когда квота кончится, запросы будут падать так же, как внутри Antigravity.
- **Не удалённый сервис.** По умолчанию сервер слушает `127.0.0.1`. В сеть он выходит, только если вы сами измените `host`, и TLS в нём нет — не выставляйте его напрямую в интернет.
- **Не хостинг моделей.** Ни одна модель не работает локально. Каждый запрос уходит в Google.
- **Не клиент.** Чтобы с ним работать, нужен Cursor, Cline, Open WebUI, скрипт или `curl`.

Что шлюз добавляет к «сырым» API:

- **Исполнение инструментов на сервере.** Клиент, не умеющий запускать `tool_calls`, всё равно получает работающие файловые инструменты — цикл выполняет сам шлюз.
- **Одна точка для двух провайдеров.** Имена с префиксом (`cloud/…`, `web/…`) в одном списке `/v1/models`.
- **Панель, квоты и лимиты** без правки файлов конфигурации.

## Что нужно

| Требование | Зачем | Замечание |
|---|---|---|
| **Antigravity (приложение) или Antigravity IDE** с выполненным входом | Источник OAuth-сессии Cloud Code | `scripts/extract_token.py` читает `state.vscdb` из `%APPDATA%\Antigravity IDE`, `%APPDATA%\Antigravity` или `%APPDATA%\antigravity` (на macOS и Linux пути аналогичные; `ANTIGRAVITY_STATE_DB` задаёт свой). Само приложение не обязательно должно быть запущено — используется только сохранённая сессия. **Antigravity CLI и расширение Antigravity для VS Code панель находит, но источником токена они не являются.** |
| **Node.js 18+** | Запускает `server.js` | Подойдёт LTS. |
| **Python 3.10+** | Запускает `app.py` (панель), установщик и извлечение токена в `auth.json` | На Windows отметьте **«Add python.exe to PATH»**. Когда `auth.json` уже есть, `node server.js` работает без Python — а панель и повторное извлечение токена без него нет. |

Для веб-моста нужен ещё один пункт, но только если вы собираетесь пользоваться веб-моделями: куки аккаунта Google с `gemini.google.com` (см. раздел [Веб-мост Gemini](#веб-мост-gemini)). Моделям `cloud/` куки не нужны.

## Установка

**Скачивание.** Возьмите `antigravity-api-release.zip` со страницы [Releases](https://github.com/flyzeen-hk/antigravity-api/releases) и распакуйте куда удобно, либо нажмите `<> Code` → **Download ZIP**, либо клонируйте:

```bash
git clone https://github.com/flyzeen-hk/antigravity-api.git
cd antigravity-api
```

**Windows.** Запустите **`install.bat`**. Он проверит Python и Node.js, поставит зависимости из `requirements.txt`, извлечёт сессию Antigravity в `auth.json` и спросит про ярлыки на Рабочем столе и в меню «Пуск» (`y` или `N`).

**macOS / Linux:**

```bash
chmod +x install.sh run.sh
./install.sh
./run.sh
```

**Вручную:**

```bash
pip install -r requirements.txt       # только для панели
python scripts/extract_token.py       # создаёт auth.json из сессии IDE
python app.py                         # панель; нажмите Start API Server
# или без панели:
node server.js                        # читает auth.json, слушает 127.0.0.1:8317
```

## Первый запуск

1. Запустите панель (`python app.py`, `run.bat` или ярлык). Она открывается на **английском**; кнопки **RU / EN** в шапке переключают язык.
2. В окне видны **API-ключ**, **Base URL** (`http://127.0.0.1:8317/v1`), найденный аккаунт Antigravity и текущие квоты в процентах.
3. Нажмите **Start API Server**. Индикатор станет зелёным, когда ответит `GET /_health`.
4. Укажите Base URL и ключ в своём клиенте.

При первом запуске рядом с программой появляются два файла, которые **никогда не коммитятся**:

| Файл | Что внутри |
|---|---|
| `config.json` | настройки, включая куки веб-моста, если вы её вставили |
| `apikey.txt` | сгенерированный локальный API-ключ |

Ключ можно посмотреть в `apikey.txt` или командой `node server.js key`.

## Пространства имён моделей

У каждого идентификатора есть префикс провайдера. Это не украшение — от него зависит, к какому бэкенду уйдёт запрос.

| Префикс | Бэкенд | Авторизация | Инструменты |
|---|---|---|---|
| `cloud/<id>` | Cloud Code | OAuth-сессия Antigravity (`auth.json`) | нативный Gemini function calling |
| `web/<alias>` | gemini.google.com | куки браузера (вручную) | нативно нет, текстовая эмуляция по желанию |

Правила, на которых легко споткнуться:

- **Точные плоские имена работают.** Имя без префикса, точно совпадающее с моделью каталога аккаунта, трактуется как `cloud/<id>` — чтобы старые конфиги не сломались.
- **Неизвестные плоские имена дают** `400 model_namespace_required` с примером — их никто не угадывает.
- **`-agent` — суффикс идентификатора**, а не отдельная модель: `cloud/gemini-3-flash-agent` — та же модель в агентском режиме.
- **`cloud/` всегда идёт в Cloud Code**, даже если веб-алиас называется так же, поэтому провайдеры не перекрывают друг друга.

`GET /v1/models` отдаёт оба пространства, с полями `provider` и `owned_by`, чтобы клиент мог их разделить.

## Эндпоинты

Все эндпоинты, кроме `/_health`, требуют ключ. Принимаются три способа:

```bash
-H "Authorization: Bearer <KEY>"      # как в OpenAI
-H "x-goog-api-key: <KEY>"            # как в Gemini SDK
?key=<KEY>                            # в строке запроса
```

**OpenAI-совместимые:** `POST /v1/chat/completions` (включая `"stream": true` и `tool_calls` для `cloud/`), `GET /v1/models`, `GET /v1/models/{id}`.

**Gemini-нативные:** `POST /v1beta/models/{m}:generateContent`, `:streamGenerateContent` (добавьте `?alt=sse` для SSE-кадров), `:countTokens`, `GET /v1beta/models/{m}`. Для моделей `web/` счётчик токенов — локальная оценка, а не вызов Google.

**Служебные:** `GET /_health` (**без ключа** — по нему панель определяет, что сервер жив), `GET /_status`, `GET /_limits` и `/_quota`, `GET /_network/test`, `POST /_config`, `POST /api/diagnostics/chat`.

**Поведение ошибок, которое стоит знать:**

- **Валидация локальная.** Нет `model` или пустой `messages` — `400` без обращения к Google.
- **Тело больше 64 МБ → `413 body_too_large`**, соединение закрывается, а не вычитывается до конца.
- **Отключение клиента отменяет запрос к Google** и пишется в журнал как `499`, а не как ошибка сервера.
- **Промпт, заблокированный Google**, возвращается нормально с `finish_reason: content_filter` и `promptFeedback`, а не 500.
- **Региональные блокировки** приходят как `region_not_supported` / `LOCATION_REJECTED 1060`. Это про выходной IP, а не про аккаунт или куки.

## Файловые инструменты агента

В Cursor или Cline `tool_calls` исполняет клиент. В обычном чате — некому, поэтому шлюз исполняет их сам: модель просит инструмент, шлюз выполняет его на диске, результат возвращается модели, и цикл повторяется, пока модель не перестанет просить или не упрётся в лимит итераций.

**Включение.** Обычный чат инструментов **не получает**. Выберите один способ:

| Способ | Пример | Для чего |
|---|---|---|
| Суффикс модели | `"model": "cloud/gemini-3-flash-agent"` | cloud |
| Флаг в теле | `"agent": true` | cloud |
| Сокращение | `"tools": "builtin"` | cloud |
| Веб-агент | `"model": "web/gemini-4-argon-agent"` + `agent.allowWebAgent: true` в `config.json` | web |

```bash
curl http://127.0.0.1:8317/v1/chat/completions \
  -H "Authorization: Bearer <YOUR_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "cloud/gemini-3-flash-agent",
    "messages": [{"role": "user", "content": "Создай notes/todo.txt со списком дел на день и покажи результат"}]
  }'
```

В ответе будет объект `agent` с описанием того, что произошло. Значение `completed: false` означает, что модель упёрлась в лимит итераций: ответ частичный, а в trace видно, на чём она остановилась.

**Инструменты:**

| Инструмент | Что делает | По умолчанию |
|---|---|---|
| `list_dir` | список файлов и папок | вкл |
| `create_dir` | создать папку, включая родительские | вкл |
| `read_file` | чтение текста; при обрезке отдаёт `next_offset` | вкл |
| `write_file` | создать или перезаписать файл, создавая папки | вкл |
| `append_file` | дописать в конец — так собираются длинные файлы | вкл |
| `edit_file` | заменить одну точную подстроку; при неоднозначности отказ, если не `replace_all` | вкл |
| `move_path` | переименовать или переместить; не перезаписывает | вкл |
| `delete_path` | удалить файл или папку | **выкл** — `agent.allowDelete` |
| `run_command` | команда оболочки с workspace в качестве рабочей папки | **выкл** — `agent.allowShell` |

Имена инструментов имеют алиасы: `bash`, `terminal`, `shell`, `execute_command` → `run_command`; `mkdir` → `create_dir`; `write_to_file` → `write_file`; `replace_in_file` → `edit_file` и так далее. Вызовы, выданные сырым JSON без обёртки `tool_call`, тоже распознаются — но только для известных имён, чтобы обычный текст не приняли за вызов.

**Лимиты и песочница:**

| Лимит | По умолчанию | Ключ в конфиге |
|---|---|---|
| Итераций инструментов на запрос | 8 | `agent.maxIterations` |
| Байт за одно `read_file` | 20 КБ | `agent.maxReadBytes` |
| Байт на файл при записи | 2 МБ | `agent.maxWriteBytes` |
| Записей в `list_dir` | 500 | `agent.maxListEntries` |
| Таймаут команды | 60 с | `agent.shellTimeoutMs` |
| Размер журнала до ротации | 5 МБ | `agent.auditRotateBytes` |

- Пути заперты в `agent.workspaceRoot`. `..`, абсолютные пути (без флага) и symlink'и наружу отклоняются.
- С `agent.allowAbsolutePaths: true` запись вне workspace разрешена, но эти папки остаются заблокированными на любом диске: `\Windows`, `\Program Files`, `\Program Files (x86)`, `\ProgramData`.
- Каждое действие пишется в `agent_audit.jsonl` вместе с результатом; при превышении порога журнал ротируется в `.1`.
- Длинные файлы пишутся частями: один `write_file`, затем `append_file`. Длину одного ответа ограничивает модель, а не шлюз.

**Куда писать файлы:** в запросе через `"agent": {"workspaceRoot": "..."}`, глобально в `config.json` → `agent.workspaceRoot` (или на лету через `POST /_config`), подпапками внутри workspace — модель создаёт их сама, либо по абсолютному пути при `agent.allowAbsolutePaths: true`.

**Планировщик.** В cloud-цикле модель может вызвать `ask_planner` и спросить веб-модель (по умолчанию `web/gemini-4-argon-thinking`) о коротком плане или ревью. Инструмент возвращает результат, а не ошибку, поэтому таймаут виден модели, а не ломает запрос. Квоту Cloud Code он не тратит и веб-циклу не выдаётся. Отключается через `agent.planner.enabled: false`.

## Веб-мост Gemini

Часть моделей Gemini появляется на `gemini.google.com` раньше, чем в Cloud Code. Мост отправляет запросы в тот же бэкенд StreamGenerate, которым пользуется сайт, с вашей сессией.

| Модель | Что это |
|---|---|
| `web/gemini-4-argon` | флагман, обычная глубина мышления |
| `web/gemini-4-argon-thinking` | максимальная глубина — самый медленный |
| `web/gemini-4` | псевдоним `web/gemini-4-argon` |
| `web/gemini-4-thinking` | псевдоним `web/gemini-4-argon-thinking` |
| `web/gemini-4-pro` | тот же бэкенд, описан как полная мощность |
| `web/gemini-4-flash` | ведёт на Argon; отдельной «4 Flash» не существует |

Все шесть идут в один и тот же `modelId` с двумя глубинами мышления, поэтому разница между «Argon» и «Pro» — это название, а не отдельная модель.

**Включение:** **Settings & Limits → Gemini 4 Unlock**, затем войти на `gemini.google.com`, открыть DevTools → Network, выбрать любой запрос к `gemini.google.com`, скопировать заголовок **Cookie** целиком (в нём должен быть `SAPISID`), вставить в поле и сохранить. Настройки применяются к работающему серверу сразу. Подойдёт и файл `cookie.txt` рядом с программой. Автоматических кнопок извлечения нет — так задумано.

Без куки мост всё равно запускается и модели видны в списке, но запросы идут анонимно, и Google обычно их понижает или отклоняет. `GET /_config` в этом случае показывает `cookieSet: false`.

**Ограничения, честно:**

- **Неофициально.** Формат запросов получен реверс-инжинирингом; Google может сломать его в любой момент.
- **Медленно.** Короткий вопрос обычно занимает 10–30 с, режимы мышления — дольше. Это время генерации Gemini, а не шлюза: локальная часть (TLS-рукопожатие и сборка запроса) заняла меньше половины секунды.
- **Нативного function calling нет.** `web/…-agent` имитирует его разбором блоков `tool_call` из текста ответа, поэтому помечен **VERY unreliable** и на практике ограничен длиной ответа. Только короткие задачи.
- **Идентичность модели эвристическая.** Google в этом протоколе не подтверждает, какая модель ответила. Селектор режима проверен на Argon, но это свидетельство, а не доказательство.
- **Привязка сессии может всё сломать.** Chrome/Edge 127+ умеют привязывать сессию Google к браузеру (`Device Bound Sessions`), и такая куки может не приниматься локальным клиентом, хотя браузер работает.
- **Регион важен.** Если `gemini.google.com` недоступен с вашего IP, задайте прокси в **Network Transport** или отдельный прокси для моста.
- **Мост не помнит чат.** Он stateless: весь транскрипт отправляется заново каждый ход, поэтому стоимость растёт с длиной переписки.

## Подключение клиента

| Параметр | Значение |
|---|---|
| Base URL | `http://127.0.0.1:8317/v1` |
| API-ключ | из панели или `apikey.txt` |
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

Если клиенту нужен список моделей до подключения — берите `GET /v1/models`, любое имя оттуда можно сразу подставлять в `model`.

## Настройки и лимиты

Панель разделена по провайдерам, потому что общего у них только API:

- **Cloud Code** — аккаунт, квоты, список облачных моделей и найденные продукты Antigravity (Antigravity, Antigravity IDE, Antigravity CLI, Antigravity для VS Code). Список информационный: токен даёт только хранилище приложения или IDE.
- **Gemini Web** — состояние моста, куки, веб-модели, глубина мышления, временные чаты.
- **Connection** — Base URL, ключ, пример cURL, порт, автозапуск.
- **Settings & Limits** — **Cloud** (Safe Mode), **Web**, **Agent** (разрешение веб-агенту, планировщик, workspace), **Network**, **Usage**.

Что важно сказать прямо:

- **Safe Mode выключен по умолчанию.** Пока он выключен, запросы идут в Google напрямую, без локальных задержек и локальных 429.
- **Когда включён**, действуют ваши лимиты: запросы в минуту, час, день и неделю; токены в день и неделю; минимальный интервал; максимальная параллельность. Панель показывает фактические значения.
- **Разрешения агента — не автозапуск.** Включение веб-агента или планировщика только даёт разрешение; ничего не запускается, пока запрос не попросит об этом через `-agent`, `"agent": true` или `"tools": "builtin"`.
- **Опасные флаги агента в панели только для чтения.** `allowDelete`, `allowShell` и `allowAbsolutePaths` меняются только в `config.json` и требуют перезапуска.
- **Порт меняется** на вкладке Connection. Сохранение перезапускает сервер; занятый другой программой порт будет отклонён.
- **Без перезапуска применяются** Safe Mode, сеть и параметры агента; перезапуск нужен только для опасных флагов выше.

**Сеть:**

- **Прокси**: `http://`, `https://` или `socks5://`, с логином и паролем. Применяется ко всем исходящим запросам; `NO_PROXY` учитывается.
- **Системный прокси**: если явный прокси не задан, используется прокси из настроек Windows (Node сам его не читает).
- **DNS**: DNS-over-HTTPS или свои DNS-серверы, используемые собственным HTTP-клиентом приложения.
- **Автопоиск** проверяет переменные окружения, настройки Windows и типовые локальные порты, только loopback-рукопожатиями.
- **Намеренно не включено**: domain fronting, TLS-фрагментация, ECH-спуфинг. Свяжите приложение со своим туннелем и укажите его в поле прокси.
- **Резервный хост**: если `daily-cloudcode-pa.googleapis.com` падает на сетевом уровне, запрос один раз повторяется на `cloudcode-pa.googleapis.com`. HTTP-статусы так не ретраятся.

## Данные и приватность

- **Всё остаётся локально.** `auth.json`, `apikey.txt`, `config.json`, `usage.json` и `cookie.txt` лежат рядом с программой и перечислены в `.gitignore`.
- **Исходящий трафик идёт только** на `daily-cloudcode-pa.googleapis.com`, `oauth2.googleapis.com` и `gemini.google.com` — либо через ваш прокси. Телеметрии нет.
- **Куки нигде не печатаются и не логируются.** Они отправляются только на `gemini.google.com`. Панель вырезает ключи, токены и значения куки из диагностики и текста ошибок.
- **Запись конфигов атомарная**, со скользящими копиями в `backups/`. Повреждённый файл восстанавливается из свежей целой копии, а испорченный сохраняется как `.corrupt`.
- **API-ключ защищает только локальный доступ.** Любой, кто может прочитать `apikey.txt` на этой машине, получит доступ к шлюзу. Держите `host` на `127.0.0.1`.
- **Замена**: если куки или ключ утекли, их нужно менять вручную — удалить `auth.json` и заново извлечь токен, либо удалить `apikey.txt` и перезапустить сервер, чтобы ключ сгенерировался заново.

## Если что-то не работает

| Симптом | Причина | Что делать |
|---|---|---|
| Панель висит на «Загрузка…» квот, `Offline (fetch failed)` | Хост Google недоступен — фильтрация DNS или DPI | Задайте прокси в **Network Transport** и нажмите **Проверить соединение** |
| `region_not_supported` на `cloud/` | Выходной IP не из поддерживаемого региона | Прокси в поддерживаемом регионе; аккаунт и куки тут ни при чём |
| `401` от Cloud Code | Сессия истекла или сменился аккаунт в IDE | Повторно выполните `python scripts/extract_token.py` |
| Веб-модели отдают пустой или битый текст | Куки истекли, не тот аккаунт или куки не привязана к этому браузеру | Скопируйте заголовок Cookie заново; проверьте `GET /_config` → `cookieSet` |
| Веб-запрос уводит на страницу Google «sorry» | Google сработала проверка по выходному IP | Смените прокси/выход; мост сообщает `web_verification_required` |
| Ответ обрывается на середине файла | Лимит длины ответа модели, а не шлюза | Просите писать частями: `write_file`, затем `append_file` |
| `413 body_too_large` | Запрос больше 64 МБ | Отправьте меньше за один раз |
| `499` в журнале | Клиент отключился | Чинить нечего; запрос к Google отменён |
| Порт занят | Другая программа или старый сервер на 8317 | Смените порт на вкладке Connection |

## Тесты

```bash
npm test
```

Запускает все наборы: интеграционные маршруты и стриминг, конвертацию, инструменты агента, веб-мост, диагностику, безопасную запись файлов, сеть, конфиг панели и извлечение куки. По отдельности:

```bash
node test/run-tests.js              # интеграция: маршруты, стриминг, агент, планировщик
node test/test_translate.js         # конвертация OpenAI <-> Gemini
node test/agent_tools_test.js       # инструменты и песочница
node test/test_web_bridge.js        # веб-алиасы, payload, определение языка
node test/test_diagnostics.js       # контракты диагностики
node test/test_safe_files.js        # атомарная запись и бэкапы
node test/test_net.js               # прокси, DNS, таймауты
node test/test_providers.js         # разбор пространств имён
node test/test_planner.js           # лимиты и таймаут планировщика
python test/test_app_config.py      # сохранность config.json
python test/test_cookie_extract.py  # извлечение куки из профиля браузера
python test/test_cookie_cdp.py      # извлечение куки через CDP
```

Проверка запуска панели:

```bash
python app.py --selftest
```
