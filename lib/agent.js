'use strict';

/*
 * Агентные файловые инструменты для шлюза Antigravity API.
 *
 * Зачем: web-мост отдаёт только текст (web-протокол Gemini не умеет нативный
 * function calling). Мост уже парсит ```tool_call```-блоки из текста модели,
 * но исполнить их должен клиент. Этот модуль добавляет СЕРВЕРНЫЙ агентный
 * цикл: модель просит инструмент -> сервер исполняет его над реальными
 * файлами ПК -> результат возвращается модели -> повтор до готовности.
 * Благодаря этому Gemini 4 работает с файлами даже из обычного чата
 * (Open WebUI, curl), где клиент не умеет исполнять tools.
 *
 * Безопасность:
 *   - жёсткая песочница: все пути только внутри agent.workspaceRoot;
 *   - лимиты на размеры чтения/записи и число итераций;
 *   - delete_path и run_command выключены по умолчанию (agent.allowDelete /
 *     agent.allowShell в config.json);
 *   - каждое действие пишется в agent_audit.jsonl.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { exec } = require('child_process');
const { removeTree } = require('./safe_files');

const AGENT_SUFFIX = '-agent';

// Модели часто называют инструменты как в других агентах (Codex/Claude Code/
// Cline). Прозрачно маппим эти имена на наши инструменты, иначе цикл срывается
// на "неизвестный инструмент" и файлы не создаются.
const TOOL_ALIASES = {
  bash: 'run_command', sh: 'run_command', shell: 'run_command', terminal: 'run_command',
  execute_command: 'run_command', run_cmd: 'run_command', powershell: 'run_command', cmd: 'run_command',
  mkdir: 'create_dir', make_dir: 'create_dir', create_directory: 'create_dir',
  create_folder: 'create_dir', new_dir: 'create_dir', new_folder: 'create_dir',
  ls: 'list_dir', dir: 'list_dir', list_files: 'list_dir', glob: 'list_dir',
  cat: 'read_file', open_file: 'read_file',
  write_to_file: 'write_file', create_file: 'write_file', save_file: 'write_file', new_file: 'write_file',
  append: 'append_file', append_to_file: 'append_file',
  replace_in_file: 'edit_file', str_replace: 'edit_file', patch_file: 'edit_file', edit: 'edit_file',
  mv: 'move_path', rename: 'move_path', rename_path: 'move_path',
  rm: 'delete_path', del: 'delete_path', remove: 'delete_path', remove_path: 'delete_path',
};

function canonicalTool(name) {
  const n = String(name || '').toLowerCase().trim();
  return TOOL_ALIASES[n] || n;
}

const DEFAULTS = {
  enabled: true,
  // Веб-агент (web/<alias>-agent) — эмуляция протокола текстом, VERY unreliable.
  // Включается только явно: agent.allowWebAgent=true в config.json.
  allowWebAgent: false,
  workspaceRoot: '',        // '' -> <проект>/agent_workspace
  allowAbsolutePaths: false, // true — модель может писать по абсолютным путям (кроме системных папок)
  maxIterations: 8,         // максимум tool-раундов на один запрос
  maxReadBytes: 20 * 1024,  // потолок чтения одного файла (дальше — next_offset);
                            // компактный ввод важен для веб-моделей
  maxWriteBytes: 2 * 1024 * 1024,
  maxListEntries: 500,
  allowDelete: false,       // удаление файлов/папок
  allowShell: false,        // выполнение команд оболочки
  shellTimeoutMs: 60000,
  auditFile: '',            // '' -> <проект>/agent_audit.jsonl
  auditRotateBytes: 5 * 1024 * 1024, // журнал больше — уходящая часть уезжает в .1
};

class ToolError extends Error {}

// ---- Спецификации инструментов (OpenAI function-формат) ----

const TOOL_SPECS = [
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List files and folders in a directory of the workspace. Returns names, types and sizes.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path relative to the workspace root. "." means the root.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a text file (UTF-8) from the workspace. Large files are truncated; the response tells you if so.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the workspace root.' },
          offset_bytes: { type: 'integer', description: 'Optional byte offset to continue reading a truncated file.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or overwrite a text file with the given content. Parent folders are created automatically. Prefer edit_file for small changes to existing files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the workspace root.' },
          content: { type: 'string', description: 'Full new content of the file.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'append_file',
      description: 'Append content to the END of a file (creates it if missing). Use to write long files in chunks: the model response has a length cap, so big files must be written as write_file (part 1) + append_file (parts 2..N).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path (relative to workspace, or absolute if allowed).' },
          content: { type: 'string', description: 'Text to append to the end of the file.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Replace an exact substring in an existing text file. old_string must match exactly and be unique unless replace_all=true. Read the file first to copy the exact text.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the workspace root.' },
          old_string: { type: 'string', description: 'Exact text to replace.' },
          new_string: { type: 'string', description: 'Replacement text.' },
          replace_all: { type: 'boolean', description: 'Replace every occurrence (default: false, requires uniqueness).' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_dir',
      description: 'Create a folder (missing parent folders are created automatically). Use this instead of shell commands like mkdir/New-Item.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Folder path relative to the workspace root.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'move_path',
      description: 'Rename or move a file/folder inside the workspace.',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Source path relative to the workspace root.' },
          to: { type: 'string', description: 'Destination path relative to the workspace root.' },
        },
        required: ['from', 'to'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_path',
      description: 'Delete a file or an empty folder. DISABLED unless the server config enables it (allowDelete).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the workspace root.' },
          recursive: { type: 'boolean', description: 'Delete a non-empty folder with everything inside (dangerous).' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run a shell command with the workspace as the current directory. DISABLED unless the server config enables it (allowShell).',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Command line to execute.' },
          timeout_sec: { type: 'integer', description: 'Optional timeout in seconds (capped by server config).' },
        },
        required: ['command'],
      },
    },
  },
];

const TOOL_NAMES = TOOL_SPECS.map(t => t.function.name);

// ---- Песочница путей ----

function resolveWorkspace(userCfg, rootDir) {
  const cfg = { ...DEFAULTS, ...(userCfg || {}) };
  return cfg.workspaceRoot ? path.resolve(cfg.workspaceRoot) : path.join(rootDir, 'agent_workspace');
}

// Системные папки защищены даже при allowAbsolutePaths — ОС не должна страдать.
const SYSTEM_DIR_BLOCKLIST = [
  '\\windows',
  '\\program files',
  '\\program files (x86)',
  '\\programdata',
];

function isSystemPath(abs) {
  // \\?\C:\... и \\.\C:\... — длинные/устройственные префиксы Windows, их легко
  // подставить, чтобы обойти проверку по строке.
  const lower = String(abs).toLowerCase()
    .replace(/[\\/]+/g, '\\')
    .replace(/^\\\\[?.]\\(?:unc\\)?/, '');
  // Папка Windows на любом диске: C:\Windows, D:\Windows.
  if (/^[a-z]:\\windows(\\|$)/.test(lower)) return true;
  // Program Files/ProgramData — обычно на системном диске, но проверяем как суффикс пути.
  return SYSTEM_DIR_BLOCKLIST.some(p => lower === p || lower.startsWith(p + '\\') || lower.includes(p + '\\'));
}

function resolveSafe(root, rel, allowAbsolute = false) {
  const raw = String(rel ?? '');
  if (!raw.trim()) throw new ToolError('Путь не указан');
  const isAbs = /^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('\\\\') || raw.startsWith('file:');

  if (isAbs) {
    if (!allowAbsolute) {
      throw new ToolError(`Абсолютные пути запрещены — используйте путь относительно рабочей папки ` +
        `(или пусть пользователь включит agent.allowAbsolutePaths=true в config.json): "${raw.slice(0, 120)}"`);
    }
    const abs = path.resolve(raw.startsWith('file:') ? raw.slice(5) : raw);
    if (isSystemPath(abs)) {
      throw new ToolError(`Системные папки защищены (Windows/Program Files/ProgramData): "${abs}"`);
    }
    return abs;
  }

  const abs = path.resolve(root, raw);
  const relCheck = path.relative(path.resolve(root), abs);
  if (relCheck && (relCheck.startsWith('..') || path.isAbsolute(relCheck))) {
    throw new ToolError(`Путь выходит за пределы рабочей папки: "${raw.slice(0, 120)}"`);
  }
  // Символьные ссылки не должны выводить за пределы песочницы.
  const realRoot = fs.realpathSync(path.resolve(root));
  let probe = abs;
  for (;;) {
    if (fs.existsSync(probe)) {
      const real = fs.realpathSync(probe);
      const rr = path.relative(realRoot, real);
      if (rr.startsWith('..') || path.isAbsolute(rr)) {
        throw new ToolError(`Символьная ссылка ведёт за пределы рабочей папки: "${raw.slice(0, 120)}"`);
      }
      break;
    }
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  return abs;
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function preview(text, cap = 400) {
  const s = String(text ?? '');
  return s.length > cap ? s.slice(0, cap) + `… (+${s.length - cap} симв.)` : s;
}

const OEM_DECODER = process.platform === 'win32' ? new TextDecoder('cp866') : null;

// Приложение, запущенное из Node, не переключает консоль на UTF-8: cmd.exe,
// powershell и git пишут в OEM-кодировке (cp866), а node/python — в UTF-8.
// Поэтому декодируем построчно: строка, которая целиком валидна как UTF-8,
// остаётся UTF-8, остальные читаются как cp866. Без этого русский вывод
// превращается в "�ਢ��".
function decodeProcessOutput(buf) {
  if (!OEM_DECODER || !buf || !buf.length) return buf ? buf.toString('utf8') : '';
  const parts = [];
  const toutf8 = new TextDecoder('utf-8', { fatal: true });
  let start = 0;
  for (let i = 0; i <= buf.length; i++) {
    if (i === buf.length || buf[i] === 0x0a) {
      const seg = buf.subarray(start, i);
      if (seg.length) {
        try { parts.push(toutf8.decode(seg)); } catch { parts.push(OEM_DECODER.decode(seg)); }
      }
      if (i === buf.length) break;
      parts.push('\n');
      start = i + 1;
    }
  }
  return parts.join('');
}

// ---- Исполнитель инструментов ----

function createExecutor(userCfg, rootDir) {
  const cfg = { ...DEFAULTS, ...(userCfg || {}) };
  const root = resolveWorkspace(userCfg, rootDir);
  fs.mkdirSync(root, { recursive: true });
  const auditPath = cfg.auditFile ? path.resolve(cfg.auditFile) : path.join(rootDir, 'agent_audit.jsonl');
  const AUDIT_ROTATE_BYTES = Math.max(64 * 1024, Number(cfg.auditRotateBytes) || 5 * 1024 * 1024);

  // Журнал растёт бесконечно (каждый запуск сервера дописывает в тот же файл).
  // При превышении порога уходящий файл переименовывается в .1, предыдущий .1
  // перезаписывается — храним один архив, объём ограничен 2×порога.
  function rotateAudit() {
    let size = 0;
    try { size = fs.statSync(auditPath).size; } catch { return; }
    if (size < AUDIT_ROTATE_BYTES) return;
    try { fs.renameSync(auditPath, auditPath + '.1'); } catch {}
  }

  function audit(tool, args, ok, ms, error) {
    try {
      const rec = {
        ts: new Date().toISOString(),
        tool,
        args: preview(JSON.stringify(args ?? {}), 1200),
        ok,
        ms,
        ...(error ? { error: preview(error, 300) } : {}),
      };
      rotateAudit();
      fs.appendFileSync(auditPath, JSON.stringify(rec) + '\n');
    } catch {}
  }

  async function execute(name, args = {}) {
    const t0 = Date.now();
    function record(out, errorText) {
      // Инструменты о неудаче сообщают через {ok:false}, а не исключением —
      // журнал должен отражать фактический результат.
      const ok = !errorText && out && out.ok !== false;
      const err = errorText || (ok ? undefined : String((out && out.error) || 'ok=false'));
      audit(name, args, ok, Date.now() - t0, err);
    }
    try {
      const out = await dispatch(name, args);
      record(out);
      return out;
    } catch (e) {
      const msg = e instanceof ToolError ? e.message : String(e.message || e);
      record(null, msg);
      return { ok: false, error: msg };
    }
  }

  async function dispatch(rawName, args) {
    // Прозрачные алиасы: bash/terminal -> run_command, mkdir -> create_dir и т.д.
    const name = canonicalTool(rawName);
    switch (name) {
      case 'list_dir': return listDir(args);
      case 'read_file': return readFile(args);
      case 'write_file': return writeFile(args);
      case 'append_file': return appendFile(args);
      case 'edit_file': return editFile(args);
      case 'create_dir': return createDir(args);
      case 'move_path': return movePath(args);
      case 'delete_path': return deletePath(args);
      case 'run_command': return runCommand(args);
      default:
        return {
          ok: false,
          error: `Неизвестный инструмент "${rawName}". Доступны: ${TOOL_NAMES.join(', ')}. ` +
            'Подсказка: терминал — это run_command (может быть выключен), папки — create_dir, файлы — write_file.',
        };
    }
  }

  function createDir(args) {
    const abs = resolveSafe(root, args.path ?? '.', cfg.allowAbsolutePaths);
    fs.mkdirSync(abs, { recursive: true });
    return { ok: true, path: String(args.path), created: true };
  }

  function listDir(args) {
    const abs = resolveSafe(root, args.path ?? '.', cfg.allowAbsolutePaths);
    if (!fs.existsSync(abs)) return { ok: false, error: `Не найдено: ${args.path}` };
    if (!fs.statSync(abs).isDirectory()) return { ok: false, error: `Это файл, а не папка: ${args.path}` };
    const items = fs.readdirSync(abs, { withFileTypes: true })
      .map(d => {
        let size = null;
        try { if (!d.isDirectory()) size = fs.statSync(path.join(abs, d.name)).size; } catch {}
        return { name: d.name, type: d.isDirectory() ? 'dir' : 'file', ...(size != null ? { size } : {}) };
      })
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    const truncated = items.length > cfg.maxListEntries;
    return { ok: true, path: args.path ?? '.', count: Math.min(items.length, cfg.maxListEntries), truncated, items: items.slice(0, cfg.maxListEntries) };
  }

  function readFile(args) {
    const abs = resolveSafe(root, args.path, cfg.allowAbsolutePaths);
    if (!fs.existsSync(abs)) return { ok: false, error: `Файл не найден: ${args.path}. Посмотрите list_dir.` };
    const st = fs.statSync(abs);
    if (st.isDirectory()) return { ok: false, error: `Это папка: ${args.path}` };
    const offset = Math.max(0, Number(args.offset_bytes) || 0);
    const fd = fs.openSync(abs, 'r');
    try {
      const len = Math.min(cfg.maxReadBytes, Math.max(0, st.size - offset));
      const buf = Buffer.alloc(len);
      if (len) fs.readSync(fd, buf, 0, len, offset);
      if (looksBinary(buf)) return { ok: false, error: 'Файл выглядит бинарным — текстовое чтение отключено.' };
      // Не режем многобайтный символ по границе чанка: half-символ в конце
      // превратился бы в "�", а next_offset сдвинулся бы внутрь символа.
      const end = offset + len;
      let cut = len;
      if (end < st.size) {
        while (cut > 0 && (buf[cut - 1] & 0xC0) === 0x80) cut--;
        if (cut > 0 && buf[cut - 1] >= 0xC0) cut--;
      }
      const body = cut === len ? buf : buf.subarray(0, cut);
      const consumed = cut;
      return {
        ok: true,
        path: String(args.path),
        bytes: st.size,
        offset,
        truncated: offset + consumed < st.size,
        next_offset: offset + consumed < st.size ? offset + consumed : null,
        content: body.toString('utf8'),
      };
    } finally {
      fs.closeSync(fd);
    }
  }

  function writeFile(args) {
    if (typeof args.content !== 'string') return { ok: false, error: 'content обязателен (строка)' };
    const body = Buffer.from(args.content, 'utf8');
    if (body.length > cfg.maxWriteBytes) {
      return { ok: false, error: `Слишком большой файл: ${body.length} байт (лимит ${cfg.maxWriteBytes}). Разбейте на части.` };
    }
    const abs = resolveSafe(root, args.path, cfg.allowAbsolutePaths);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
    return { ok: true, path: String(args.path), bytes: body.length, created: true };
  }

  function appendFile(args) {
    if (typeof args.content !== 'string') return { ok: false, error: 'content обязателен (строка)' };
    const body = Buffer.from(args.content, 'utf8');
    const abs = resolveSafe(root, args.path, cfg.allowAbsolutePaths);
    let existing = 0;
    try { existing = fs.statSync(abs).size; } catch {}
    if (existing + body.length > cfg.maxWriteBytes) {
      return { ok: false, error: `Файл превысит лимит ${cfg.maxWriteBytes} байт (сейчас ${existing}). Начните новый файл.` };
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.appendFileSync(abs, body);
    return { ok: true, path: String(args.path), appended: body.length, total: existing + body.length };
  }

  function editFile(args) {
    const { old_string: oldStr, new_string: newStr } = args;
    if (typeof oldStr !== 'string' || typeof newStr !== 'string') {
      return { ok: false, error: 'old_string и new_string обязательны' };
    }
    if (oldStr === newStr) return { ok: false, error: 'old_string и new_string совпадают — правка не нужна' };
    const abs = resolveSafe(root, args.path, cfg.allowAbsolutePaths);
    if (!fs.existsSync(abs)) return { ok: false, error: `Файл не найден: ${args.path}` };
    const src = fs.readFileSync(abs, 'utf8');
    const count = src.split(oldStr).length - 1;
    if (count === 0) {
      return { ok: false, error: `old_string не найден в ${args.path}. Прочитайте файл через read_file и скопируйте текст точно, включая пробелы.` };
    }
    if (count > 1 && !args.replace_all) {
      return { ok: false, error: `old_string встречается ${count} раз. Уточните контекст или передайте replace_all=true.` };
    }
    // String.replace разворачивает $&, $', $1… в new_string — заменяем через функцию.
    const next = args.replace_all ? src.split(oldStr).join(newStr) : src.replace(oldStr, () => newStr);
    const out = Buffer.from(next, 'utf8');
    if (out.length > cfg.maxWriteBytes) return { ok: false, error: `Результат превышает лимит размера (${cfg.maxWriteBytes})` };
    fs.writeFileSync(abs, out);
    return { ok: true, path: String(args.path), replacements: args.replace_all ? count : 1, bytes: out.length };
  }

  function movePath(args) {
    const from = resolveSafe(root, args.from, cfg.allowAbsolutePaths);
    const to = resolveSafe(root, args.to, cfg.allowAbsolutePaths);
    if (!fs.existsSync(from)) return { ok: false, error: `Не найдено: ${args.from}` };
    if (fs.existsSync(to)) return { ok: false, error: `Цель уже существует: ${args.to}` };
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    return { ok: true, from: String(args.from), to: String(args.to) };
  }

  function deletePath(args) {
    if (!cfg.allowDelete) {
      return { ok: false, error: 'Удаление выключено. Включите agent.allowDelete=true в config.json (требует перезапуска).' };
    }
    const abs = resolveSafe(root, args.path, cfg.allowAbsolutePaths);
    if (abs.toLowerCase() === path.resolve(root).toLowerCase()) {
      return { ok: false, error: 'Нельзя удалить корень рабочей папки' };
    }
    if (!fs.existsSync(abs)) return { ok: false, error: `Не найдено: ${args.path}` };
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      if (args.recursive) removeTree(abs);
      else fs.rmdirSync(abs); // пустая папка; непустая бросит ENOTEMPTY
    } else {
      fs.unlinkSync(abs);
    }
    return { ok: true, path: String(args.path), recursive: !!args.recursive };
  }

  function runCommand(args) {
    if (!cfg.allowShell) {
      return {
        ok: false,
        error: 'run_command (команды оболочки) выключен по умолчанию. ' +
          'Для папок используйте create_dir, для файлов — write_file/edit_file. ' +
          'Либо включите agent.allowShell=true в config.json (нужен перезапуск сервера).',
      };
    }
    const command = String(args.command ?? '');
    if (!command.trim()) return { ok: false, error: 'Пустая команда' };
    const timeout = Math.min(cfg.shellTimeoutMs, Math.max(1000, (Number(args.timeout_sec) || cfg.shellTimeoutMs / 1000) * 1000));
    return new Promise(resolve => {
      exec(command, { cwd: root, timeout, maxBuffer: 512 * 1024, windowsHide: true, encoding: 'buffer' }, (err, stdout, stderr) => {
        // Успех определяется только кодом возврата: старый вариант
        // (!err || err.killed === false && ...) считал упавший процесс успешным.
        const exitCode = err == null ? 0 : (typeof err.code === 'number' ? err.code : null);
        resolve({
          ok: exitCode === 0,
          exit_code: exitCode,
          timed_out: !!(err && err.killed),
          stdout: preview(decodeProcessOutput(stdout), 32000),
          stderr: preview(decodeProcessOutput(stderr), 16000),
        });
      });
    });
  }

  return { execute, workspace: root, auditPath, toolNames: TOOL_NAMES, cfg };
}

// ---- Разбор ```tool_call```-блоков из текста (для cloud-моделей и тестов) ----

function parseToolCallBlocks(text) {
  const pattern = /```tool_call\s*\n([\s\S]*?)\n```/g;
  const toolCalls = [];
  let match;
  while ((match = pattern.exec(String(text ?? ''))) !== null) {
    try {
      const data = JSON.parse(match[1].trim());
      if (data && typeof data.name === 'string') {
        toolCalls.push({
          id: 'call_' + crypto.randomBytes(6).toString('hex'),
          type: 'function',
          function: { name: data.name, arguments: JSON.stringify(data.arguments ?? {}) },
        });
      }
    } catch {}
  }
  const clean = String(text ?? '').replace(pattern, '').trim();
  return { cleanText: clean, toolCalls };
}

// Устойчивый разбор: модели часто выдают вызов без строгой обёртки ```tool_call
// (просто JSON-объект или ```json-блок). Принимаем только те вызовы, чьё имя
// совпадает с известным инструментом или алиасом — иначе это просто текст.
function extractToolCalls(text) {
  const s = String(text ?? '');
  const strict = parseToolCallBlocks(s);
  if (strict.toolCalls.length) return strict;

  const valid = new Set([...TOOL_NAMES, ...Object.keys(TOOL_ALIASES)]);
  const spans = []; // {start, end, name, args}
  const fenceRanges = [];
  const tryParse = (body, start, end, fromFence = false) => {
    // Сырой скан не должен дублировать вызовы, уже найденные в фенсах
    if (!fromFence && fenceRanges.some(([a, b]) => start < b && end > a)) return;
    let obj;
    try { obj = JSON.parse(body.trim()); } catch { return; }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
    if (typeof obj.name !== 'string' || !('arguments' in obj)) return;
    if (!valid.has(obj.name.toLowerCase().trim())) return;
    spans.push({ start, end, name: obj.name, args: obj.arguments ?? {} });
  };

  // 1) ```json / ```-фенсы: убираем весь блок целиком
  const fenceRe = /```(?:json)?[ \t]*\n([\s\S]*?)\n```/g;
  let m;
  while ((m = fenceRe.exec(s)) !== null) {
    fenceRanges.push([m.index, m.index + m[0].length]);
    tryParse(m[1], m.index, m.index + m[0].length, true);
  }

  // 2) сырые сбалансированные {...}: каждый '{' — независимая попытка,
  //    кавычки вне JSON не ломают сканер
  const balancedFrom = (from) => {
    let depth = 0, inStr = false, esc = false;
    for (let j = from; j < s.length; j++) {
      const ch = s[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return s.slice(from, j + 1);
        if (depth < 0) return null;
      }
    }
    return null;
  };
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '{') continue;
    const cand = balancedFrom(i);
    if (cand) { tryParse(cand, i, i + cand.length); i += cand.length - 1; }
  }

  if (!spans.length) return { cleanText: s.trim(), toolCalls: [] };

  // Вырезаем найденные вызовы из текста (с последнего к первому)
  spans.sort((a, b) => b.start - a.start);
  let clean = s;
  for (const sp of spans) {
    clean = clean.slice(0, sp.start) + clean.slice(sp.end);
  }
  // Подчищаем осиротевшие фенсы ```json ... ```
  clean = clean.replace(/```(?:json)?[ \t]*\n\s*```/g, '').trim();

  const toolCalls = spans.reverse().map(sp => ({
    id: 'call_' + crypto.randomBytes(6).toString('hex'),
    type: 'function',
    function: { name: sp.name, arguments: JSON.stringify(sp.args) },
  }));
  return { cleanText: clean, toolCalls };
}

// ---- Системная инструкция агента ----

function buildSystemPrompt({ workspace, toolNames, allowDelete, allowShell, allowAbsolutePaths, extraTools = [] }) {
  const extras = [
    allowDelete ? 'delete_path включён (осторожно)' : 'delete_path ВЫКЛЮЧЕН',
    allowShell ? 'run_command включён' : 'run_command ВЫКЛЮЧЕН',
  ].join(', ');
  const plannerLine = extraTools.includes('ask_planner')
    ? '- ask_planner: consult Gemini 4 (Gemini Web) for a plan, a review or advice. It returns TEXT only — it cannot read/write files or run commands. Call it at most a couple of times per task, and only when the task is genuinely complex or you are unsure about the approach.'
    : null;
  const pathRule = allowAbsolutePaths
    ? 'Paths: ABSOLUTE paths ARE allowed — when the user names a location (e.g. "C:\\Games\\file.txt" or "D:\\docs"), use that exact absolute path in the tool call. System folders (Windows, Program Files, ProgramData) are blocked by the server. If the user does NOT name a location, keep files in the workspace (' + workspace + ').'
    : 'All tool paths must be RELATIVE to this root; escaping it is impossible and attempts are rejected.';
  return [
    'You are an autonomous FILE AGENT running on the user\'s PC via a local API gateway.',
    `Host OS: ${os.platform()} (${os.type()}).`,
    `Workspace root: ${workspace}`,
    pathRule,
    `Enabled tools: ${toolNames.join(', ')}. (${extras})`,
    '',
    'IMPORTANT tool facts:',
    '- There is NO "bash"/"terminal"/"shell" tool. If run_command is not enabled, you cannot run commands at all — do not try.',
    '- On Windows run_command executes via cmd.exe: use mkdir/dir/type/copy, NOT PowerShell cmdlets (New-Item will fail).',
    '- To create a folder use create_dir, or just write a file inside it: write_file creates parent folders automatically.',
    '- RESPONSE LENGTH CAP: one reply cannot hold a big file. For any file longer than ~6000 characters (games, apps, long code), write it in CHUNKS: write_file (part 1) then append_file (parts 2..N) until the file is complete. Plan the structure first, keep each chunk 3000-5000 characters, and ALWAYS finish the file — never leave it truncated.',
    '- If a file already ends abruptly (your previous chunk was cut off), continue it with append_file from the exact cut point.',
    '- Use ONLY the tools listed above. Inventing tool names (bash, python, browser...) always fails.',
    ...(plannerLine ? [plannerLine] : []),
    '',
    'Protocol:',
    '1. Plan briefly, then call tools by replying with ```tool_call blocks:',
    '```tool_call',
    '{"name": "write_file", "arguments": {"path": "notes/a.txt", "content": "..."}}',
    '```',
    'The block must be fenced EXACTLY with ```tool_call and contain a single JSON object.',
    '2. After each of your tool calls you receive a "[Tool result for <name>]" message with JSON: ok=true means success, ok=false means the "error" field explains what to fix.',
    '3. Call several tools per reply when they are independent; wait for results when dependent.',
    '4. When the task is done, reply with the final answer IN THE USER\'S LANGUAGE: a short summary of what you read/created/changed (list the files), plus the answer itself.',
    '',
    'Rules:',
    '- NEVER invent file contents: read_file before edit_file, and copy old_string exactly (whitespace matters).',
    '- Prefer edit_file for small changes; write_file for new files or full rewrites.',
    '- In your final answer ALWAYS state the FULL ABSOLUTE PATH of every file/folder you created or changed (workspace root + relative path) — the user will look for it there.',
    '- If a tool errors, adjust arguments and retry (max a few times), then explain to the user.',
    '- Do not ask for permission: the sandbox already enforces safety.',
    '- Binary/large files: read_file reports truncation — continue with next_offset.',
  ].join('\n');
}

// ---- Агентный цикл ----

// chat(messages) -> { content, tool_calls, usage?, upstream_model? }
function runAgentLoop({ chat, messages, executor, maxIterations, systemPrompt }) {
  const maxIter = Math.max(1, Math.min(24, Number(maxIterations) || DEFAULTS.maxIterations));

  return (async () => {
    const convo = [];
    if (systemPrompt) convo.push({ role: 'system', content: systemPrompt });
    convo.push(...(messages || []));

    const trace = [];
    const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    let upstreamModel = '';
    let iterations = 0;
    let lastAssistant = { content: '', tool_calls: [] };

    const acc = (u) => {
      if (u && typeof u === 'object') {
        usage.prompt_tokens += u.prompt_tokens || 0;
        usage.completion_tokens += u.completion_tokens || 0;
        usage.total_tokens += u.total_tokens || 0;
      }
      if (u && u.upstream_model) upstreamModel = u.upstream_model;
    };

    for (; iterations < maxIter; iterations++) {
      const resp = await chat(convo, iterations);
      acc(resp.usage);
      if (resp.upstream_model) upstreamModel = resp.upstream_model;

      let content = resp.content || '';
      let calls = resp.tool_calls || [];
      // Мост парсит только строгие ```tool_call-фенсы. Модель нередко выдаёт
      // вызов сырым JSON (или в ```json) — достаём его из текста, иначе цикл
      // завершается "пустым" ответом и файлы не создаются.
      if (!calls.length && content) {
        const extracted = extractToolCalls(content);
        if (extracted.toolCalls.length) {
          calls = extracted.toolCalls;
          content = extracted.cleanText;
        }
      }
      lastAssistant = { content, tool_calls: calls };
      if (!lastAssistant.tool_calls.length) {
        return {
          content: lastAssistant.content, toolCalls: [], trace, usage,
          upstream_model: upstreamModel, iterations: iterations + 1, completed: true,
          workspace: executor.workspace,
        };
      }

      convo.push({
        role: 'assistant',
        content: lastAssistant.content,
        tool_calls: lastAssistant.tool_calls,
      });

      for (const call of lastAssistant.tool_calls) {
        let args = {};
        try { args = JSON.parse(call.function?.arguments || '{}'); } catch {}
        const requested = call.function?.name;
        const cname = canonicalTool(requested); // bash -> run_command и т.п.
        const out = await executor.execute(cname, args);
        trace.push({
          tool: cname,
          ...(cname !== requested ? { requested_as: requested } : {}),
          args: preview(JSON.stringify(args), 600),
          ok: out && out.ok !== false,
          result: preview(JSON.stringify(out), 800),
        });
        convo.push({
          role: 'tool',
          tool_call_id: call.id,
          name: cname,
          content: JSON.stringify(out).slice(0, 24000),
        });
      }
    }

    // Лимит итераций: принудительный финальный ответ без инструментов.
    convo.push({
      role: 'user',
      content: '[System]: Tool iteration limit reached. Do NOT call any more tools — give the final answer right now, summarizing what was done.',
    });
    const resp = await chat(convo, maxIter);
    acc(resp.usage);
    if (resp.upstream_model) upstreamModel = resp.upstream_model;
    return {
      content: resp.content || lastAssistant.content, toolCalls: resp.tool_calls || [], trace, usage,
      upstream_model: upstreamModel, iterations: maxIter + 1, completed: false,
      workspace: executor.workspace,
    };
  })();
}

module.exports = {
  AGENT_SUFFIX,
  DEFAULTS,
  TOOL_SPECS,
  TOOL_NAMES,
  TOOL_ALIASES,
  ToolError,
  canonicalTool,
  createExecutor,
  resolveWorkspace,
  parseToolCallBlocks,
  extractToolCalls,
  buildSystemPrompt,
  runAgentLoop,
  decodeProcessOutput,
};
