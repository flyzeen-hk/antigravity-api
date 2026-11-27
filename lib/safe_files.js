'use strict';

// Надёжная запись служебных файлов (config.json, auth.json, usage.json):
// запись во временный файл + rename, поэтому сбой питания или падение процесса
// не оставляют файл записанным наполовину; плюс ротация резервных копий в backups/.

const fs = require('fs');
const path = require('path');

// Windows: rename поверх файла, который другой процесс держит открытым без
// FILE_SHARE_DELETE (так читает Python), даёт EPERM/EBUSY — это временно.
const LOCK_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_RETRIES = 6;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function stripBom(text) {
  return String(text).replace(/^\uFEFF/, '');
}

function readJsonFile(file) {
  return JSON.parse(stripBom(fs.readFileSync(file, 'utf8')));
}

function writeFileAtomic(file, data, { fsync = true } = {}) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.tmp`);
  let mode;
  if (process.platform !== 'win32') {
    try { mode = fs.statSync(file).mode & 0o777; } catch {}
  }
  try {
    const fd = fs.openSync(tmp, 'w', mode);
    try {
      fs.writeFileSync(fd, data);
      if (fsync) fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(tmp, file);
        return;
      } catch (e) {
        if (!LOCK_CODES.has(e.code)) throw e;
        if (attempt < RENAME_RETRIES) {
          sleepSync(15 * (attempt + 1));
          continue;
        }
        // Цель заблокирована надолго (антивирус, редактор) — прямая запись лучше потери данных.
        fs.writeFileSync(file, data);
        return;
      }
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function sleepAsync(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Асинхронный вариант writeFileAtomic: та же схема tmp+rename с ретраями, но
// ретраи не блокируют event loop (sleepSync на Atomics.wait останавливает ВСЕ
// соединения шлюза на время ожидания). Используется для частых записей
// состояния (usage.json), где потеря последней секунды не критична.
async function writeFileAtomicAsync(file, data, { fsync = false } = {}) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.tmp`);
  let mode;
  if (process.platform !== 'win32') {
    try { mode = fs.statSync(file).mode & 0o777; } catch {}
  }
  try {
    const fd = fs.openSync(tmp, 'w', mode);
    try {
      fs.writeFileSync(fd, data);
      if (fsync) fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(tmp, file);
        return;
      } catch (e) {
        if (!LOCK_CODES.has(e.code)) throw e;
        if (attempt < RENAME_RETRIES) {
          await sleepAsync(15 * (attempt + 1));
          continue;
        }
        fs.writeFileSync(file, data);
        return;
      }
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function defaultBackupDir(file) {
  return path.join(path.dirname(file), 'backups');
}

function stamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
}

// Новейшие первыми: имя содержит штамп YYYYMMDD-HHMMSS-mmm.
function listBackups(file, { dir = defaultBackupDir(file), suffix = '.bak' } = {}) {
  const prefix = path.basename(file) + '.';
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names
    .filter((n) => n.startsWith(prefix) && n.endsWith(suffix))
    .sort()
    .reverse()
    .map((n) => path.join(dir, n));
}

// Копия текущего содержимого файла перед перезаписью. Повтор того же содержимого
// не плодит копии; хранится не больше keep штук.
function backupFile(file, { dir = defaultBackupDir(file), keep = 10, suffix = '.bak' } = {}) {
  let data;
  try { data = fs.readFileSync(file); } catch { return null; }
  fs.mkdirSync(dir, { recursive: true });
  const existing = listBackups(file, { dir, suffix });
  if (existing[0]) {
    try {
      if (fs.readFileSync(existing[0]).equals(data)) return existing[0];
    } catch {}
  }
  // '_' сортируется после '.', поэтому копия из той же миллисекунды считается новее.
  const base = `${path.basename(file)}.${stamp()}`;
  let dest = path.join(dir, base + suffix);
  for (let i = 1; fs.existsSync(dest); i++) {
    dest = path.join(dir, `${base}_${String(i).padStart(3, '0')}${suffix}`);
  }
  fs.writeFileSync(dest, data);
  for (const old of listBackups(file, { dir, suffix }).slice(Math.max(1, keep))) {
    try { fs.unlinkSync(old); } catch {}
  }
  return dest;
}

// Повреждённый JSON-файл: сохраняем его как *.corrupt и возвращаем новейшую
// резервную копию, которая разбирается и проходит validate. null — копий нет.
function restoreLatestBackup(file, { dir = defaultBackupDir(file), validate = () => true } = {}) {
  for (const candidate of listBackups(file, { dir })) {
    let text;
    let data;
    try {
      text = stripBom(fs.readFileSync(candidate, 'utf8'));
      data = JSON.parse(text);
    } catch {
      continue;
    }
    if (!validate(data)) continue;
    const corrupt = backupFile(file, { dir, suffix: '.corrupt', keep: 5 });
    writeFileAtomic(file, text);
    return { from: candidate, corrupt, data };
  }
  return null;
}

const RMDIR_RETRY_CODES = new Set(['ENOTEMPTY', 'EBUSY', 'EPERM']);

// Замена fs.rmSync: в Node 24 на Windows он молча ничего не удаляет, если в пути
// есть не-ASCII символы (C:\Users\<user>\...). Ссылки удаляются, а не обходятся.
function removeTree(target) {
  let st;
  try {
    st = fs.lstatSync(target);
  } catch (e) {
    if (e.code === 'ENOENT') return;
    throw e;
  }
  if (!st.isDirectory()) {
    try {
      fs.unlinkSync(target);
    } catch (e) {
      if (e.code !== 'EPERM' || process.platform !== 'win32') throw e;
      fs.chmodSync(target, 0o666); // атрибут «только чтение» на Windows
      fs.unlinkSync(target);
    }
    return;
  }
  for (const name of fs.readdirSync(target)) removeTree(path.join(target, name));
  for (let attempt = 0; ; attempt++) {
    try {
      fs.rmdirSync(target);
      return;
    } catch (e) {
      // Windows: удалённые файлы ещё держит антивирус/индексатор — папка «не пуста» доли секунды.
      if (!RMDIR_RETRY_CODES.has(e.code) || attempt >= RENAME_RETRIES) throw e;
      sleepSync(15 * (attempt + 1));
    }
  }
}

module.exports = {
  stripBom,
  readJsonFile,
  writeFileAtomic,
  writeFileAtomicAsync,
  backupFile,
  listBackups,
  restoreLatestBackup,
  defaultBackupDir,
  removeTree,
};
