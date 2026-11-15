'use strict';

/*
 * Сохранность служебных файлов: атомарная запись, резервные копии в backups/,
 * восстановление повреждённого config.json, синхронизация apikey.txt,
 * устойчивость Guard и TokenManager к повреждённым/незаписываемым файлам.
 * Только временные каталоги, без сети. Запуск: node test/test_safe_files.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

process.env.AG_SIG_FILE = path.join(os.tmpdir(), `ag-test-sigs-${process.pid}.json`);


const {
  writeFileAtomic, readJsonFile, backupFile, listBackups, restoreLatestBackup, removeTree,
} = require('../lib/safe_files');
process.on('exit', () => removeTree(process.env.AG_SIG_FILE));
const { loadConfig } = require('../server');
const { Guard } = require('../lib/guard');
const { TokenManager } = require('../lib/auth');

const tmpRoots = [];
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-safe-'));
  tmpRoots.push(dir);
  return dir;
}

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok  ' + name);
  } catch (e) {
    failed++;
    console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e));
  }
}

// Предупреждения о восстановлении ожидаемы — не засоряем вывод.
async function quiet(fn) {
  const warn = console.warn;
  const warnings = [];
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    return { result: await fn(), warnings };
  } finally {
    console.warn = warn;
  }
}

const tmpLeftovers = (dir) => fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'));
const KEY_A = 'agk_' + 'a'.repeat(48);
const KEY_B = 'agk_' + 'b'.repeat(48);

(async () => {
  console.log('== safe_files');

  await test('writeFileAtomic: создаёт и перезаписывает, без .tmp-хвостов', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'x.json');
    writeFileAtomic(file, '{"v":1}');
    writeFileAtomic(file, '{"v":2}', { fsync: false });
    assert.deepStrictEqual(readJsonFile(file), { v: 2 });
    assert.deepStrictEqual(tmpLeftovers(dir), []);
  });

  await test('writeFileAtomic: ошибка записи не оставляет временный файл', () => {
    const dir = tmpDir();
    const target = path.join(dir, 'occupied');
    fs.mkdirSync(target);
    assert.throws(() => writeFileAtomic(target, 'data'));
    assert.deepStrictEqual(tmpLeftovers(dir), []);
  });

  if (process.platform === 'win32') {
    await test('writeFileAtomic: файл открыт другим процессом (Python) — данные всё равно записаны', async () => {
      const dir = tmpDir();
      const file = path.join(dir, 'config.json');
      fs.writeFileSync(file, '{"old":true}');
      const holder = spawn('python', ['-c',
        'import sys,time\nf=open(sys.argv[1],"rb")\nprint("ready",flush=True)\ntime.sleep(2.5)\n', file]);
      const ready = await new Promise((resolve) => {
        let out = '';
        holder.stdout.on('data', (d) => { out += d; if (out.includes('ready')) resolve(true); });
        holder.on('error', () => resolve(false));
        holder.on('exit', () => resolve(false));
      });
      if (!ready) {
        console.log('       (python недоступен — проверка пропущена)');
        return;
      }
      try {
        writeFileAtomic(file, '{"new":true}');
        assert.deepStrictEqual(readJsonFile(file), { new: true });
        assert.deepStrictEqual(tmpLeftovers(dir), []);
      } finally {
        holder.kill();
      }
    });
  }

  await test('readJsonFile: UTF-8 BOM (Блокнот) не ломает разбор', () => {
    const file = path.join(tmpDir(), 'bom.json');
    fs.writeFileSync(file, '\uFEFF{"ok":1}');
    assert.deepStrictEqual(readJsonFile(file), { ok: 1 });
  });

  await test('backupFile: нет файла — null; одинаковое содержимое не дублируется', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'config.json');
    assert.strictEqual(backupFile(file), null);
    fs.writeFileSync(file, '{"a":1}');
    const first = backupFile(file);
    assert.ok(first && fs.existsSync(first));
    assert.strictEqual(path.dirname(first), path.join(dir, 'backups'));
    assert.strictEqual(backupFile(file), first);
    assert.strictEqual(listBackups(file).length, 1);
  });

  await test('backupFile: хранит не больше keep копий, новейшая первой', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'config.json');
    for (let i = 0; i < 7; i++) {
      fs.writeFileSync(file, JSON.stringify({ i }));
      backupFile(file, { keep: 3 });
    }
    const list = listBackups(file);
    assert.strictEqual(list.length, 3);
    assert.deepStrictEqual(list.map((f) => readJsonFile(f).i), [6, 5, 4]);
  });

  await test('restoreLatestBackup: пропускает битую копию, берёт новейшую целую', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, '{"gen":1}');
    backupFile(file);
    fs.writeFileSync(file, '{"gen":2}');
    backupFile(file);
    fs.writeFileSync(file, '{"gen":');
    backupFile(file);
    const restored = restoreLatestBackup(file, { validate: (d) => !!d && typeof d === 'object' });
    assert.ok(restored);
    assert.deepStrictEqual(restored.data, { gen: 2 });
    assert.deepStrictEqual(readJsonFile(file), { gen: 2 });
    assert.ok(restored.corrupt.endsWith('.corrupt'));
    assert.strictEqual(fs.readFileSync(restored.corrupt, 'utf8'), '{"gen":');
  });

  await test('restoreLatestBackup: нет копий — null, файл не тронут', () => {
    const file = path.join(tmpDir(), 'config.json');
    fs.writeFileSync(file, 'garbage');
    assert.strictEqual(restoreLatestBackup(file), null);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'garbage');
  });

  console.log('== loadConfig');

  await test('первый запуск: создаёт config.json и apikey.txt с одним ключом', () => {
    const root = tmpDir();
    const { config, created } = loadConfig(root);
    assert.strictEqual(created, true);
    assert.match(config.apiKey, /^agk_[0-9a-f]{48}$/);
    assert.strictEqual(fs.readFileSync(path.join(root, 'apikey.txt'), 'utf8').trim(), config.apiKey);
    assert.strictEqual(readJsonFile(path.join(root, 'config.json')).apiKey, config.apiKey);
  });

  await test('config.json удалён, apikey.txt остался — ключ сохраняется', () => {
    const root = tmpDir();
    fs.writeFileSync(path.join(root, 'apikey.txt'), KEY_A + '\r\n');
    const { config, created } = loadConfig(root);
    assert.strictEqual(created, true);
    assert.strictEqual(config.apiKey, KEY_A);
    assert.strictEqual(readJsonFile(path.join(root, 'config.json')).apiKey, KEY_A);
  });

  await test('в config.json нет apiKey — берётся ключ из apikey.txt, остальное не теряется', () => {
    const root = tmpDir();
    const file = path.join(root, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ port: 9001, geminiWeb: { cookie: 'SID=x' } }));
    fs.writeFileSync(path.join(root, 'apikey.txt'), KEY_A);
    const { config } = loadConfig(root);
    assert.strictEqual(config.apiKey, KEY_A);
    const saved = readJsonFile(file);
    assert.strictEqual(saved.apiKey, KEY_A);
    assert.strictEqual(saved.port, 9001);
    assert.strictEqual(saved.geminiWeb.cookie, 'SID=x');
    assert.strictEqual(listBackups(file).length, 1, 'копия до перезаписи');
  });

  await test('apikey.txt расходится с config.json — синхронизируется (с копией)', () => {
    const root = tmpDir();
    const keyFile = path.join(root, 'apikey.txt');
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ apiKey: KEY_A }));
    fs.writeFileSync(keyFile, KEY_B);
    const { config } = loadConfig(root);
    assert.strictEqual(config.apiKey, KEY_A);
    assert.strictEqual(fs.readFileSync(keyFile, 'utf8').trim(), KEY_A);
    const [copy] = listBackups(keyFile);
    assert.strictEqual(fs.readFileSync(copy, 'utf8'), KEY_B);
  });

  await test('apikey.txt совпадает — файл не переписывается', () => {
    const root = tmpDir();
    const keyFile = path.join(root, 'apikey.txt');
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ apiKey: KEY_A }));
    fs.writeFileSync(keyFile, KEY_A + '\n');
    const before = fs.statSync(keyFile).mtimeMs;
    loadConfig(root);
    assert.strictEqual(fs.statSync(keyFile).mtimeMs, before);
    assert.strictEqual(listBackups(keyFile).length, 0);
  });

  await test('повреждённый config.json восстанавливается из backups/', async () => {
    const root = tmpDir();
    const file = path.join(root, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ apiKey: KEY_A, port: 9002, geminiWeb: { cookie: 'SID=keep' } }));
    backupFile(file);
    fs.writeFileSync(file, '{"apiKey": "agk_trunc');
    const { result, warnings } = await quiet(() => loadConfig(root));
    assert.strictEqual(result.config.apiKey, KEY_A);
    assert.strictEqual(result.config.port, 9002);
    assert.strictEqual(result.config.geminiWeb.cookie, 'SID=keep');
    assert.strictEqual(readJsonFile(file).port, 9002);
    assert.strictEqual(listBackups(file, { suffix: '.corrupt' }).length, 1);
    assert.ok(warnings.some((w) => w.includes('восстановлен')));
  });

  await test('повреждён и копий нет — понятная ошибка, файл не перезаписан', () => {
    const root = tmpDir();
    const file = path.join(root, 'config.json');
    fs.writeFileSync(file, '{broken');
    assert.throws(() => loadConfig(root), /повреждён.*backups/);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), '{broken');
  });

  await test('JSON-массив вместо объекта считается повреждением', async () => {
    const root = tmpDir();
    const file = path.join(root, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ apiKey: KEY_A }));
    backupFile(file);
    fs.writeFileSync(file, '[]');
    const { result } = await quiet(() => loadConfig(root));
    assert.strictEqual(result.config.apiKey, KEY_A);
  });

  await test('config.json с BOM читается', () => {
    const root = tmpDir();
    fs.writeFileSync(path.join(root, 'config.json'), '\uFEFF' + JSON.stringify({ apiKey: KEY_A, port: 9003 }));
    assert.strictEqual(loadConfig(root).config.port, 9003);
  });

  await test('safeMode: недостающие поля берутся из DEFAULT_CONFIG, свои сохраняются', () => {
    const root = tmpDir();
    fs.writeFileSync(path.join(root, 'config.json'),
      JSON.stringify({ apiKey: KEY_A, safeMode: { enabled: true, maxRequestsPerDay: 5 } }));
    const { safeMode } = loadConfig(root).config;
    assert.strictEqual(safeMode.enabled, true);
    assert.strictEqual(safeMode.maxRequestsPerDay, 5);
    assert.strictEqual(safeMode.maxRequestsPerWeek, 20000);
    assert.strictEqual(safeMode.maxTokensPerWeek, 200000000);
    assert.strictEqual(safeMode.maxRequestsPerMinute, 60);
  });

  console.log('== Guard / TokenManager');

  await test('Guard: битый usage.json сохраняется как .corrupt, учёт начинается заново', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'usage.json');
    fs.writeFileSync(file, '{"days": {');
    const guard = new Guard({ enabled: true }, file);
    assert.strictEqual(guard.summary().requestsToday, 0);
    assert.ok(readJsonFile(file).days, 'файл перезаписан целым');
    const [corrupt] = listBackups(file, { suffix: '.corrupt' });
    assert.strictEqual(fs.readFileSync(corrupt, 'utf8'), '{"days": {');
  });

  await test('Guard: отсутствующий usage.json — без .corrupt-копий', () => {
    const file = path.join(tmpDir(), 'usage.json');
    new Guard({ enabled: true }, file);
    assert.ok(fs.existsSync(file));
    assert.strictEqual(listBackups(file, { suffix: '.corrupt' }).length, 0);
  });

  await test('TokenManager: auth.json с BOM читается', () => {
    const file = path.join(tmpDir(), 'auth.json');
    fs.writeFileSync(file, '\uFEFF' + JSON.stringify({ refresh_token: 'r', email: 'u@example.com' }));
    const tm = new TokenManager(file);
    assert.strictEqual(tm.email, 'u@example.com');
  });

  await test('TokenManager: refresh успешен, даже если auth.json не записать', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'auth.json');
    fs.writeFileSync(file, JSON.stringify({ refresh_token: 'r', access_token: '', access_expires_at: 0 }));
    const network = {
      fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'fresh', expires_in: 3600 }) }),
    };
    const tm = new TokenManager(file, { network });
    fs.unlinkSync(file);
    fs.mkdirSync(file); // запись в каталог невозможна
    const { result, warnings } = await quiet(() => tm.getAccessToken());
    assert.strictEqual(result, 'fresh');
    assert.ok(warnings.some((w) => w.includes('auth.json')));
    assert.deepStrictEqual(tmpLeftovers(dir), []);
  });

  // Node 24 на Windows: fs.rmSync молча ничего не делает, если в пути есть
  // не-ASCII символы (C:\Users\максим\...). removeTree должен работать и так.
  const cyrDir = () => {
    const dir = path.join(tmpDir(), 'кириллица', 'вложенная-папка');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };

  await test('removeTree: файл на кириллическом пути удаляется', () => {
    const file = path.join(cyrDir(), 'файл.txt');
    fs.writeFileSync(file, 'x');
    removeTree(file);
    assert.strictEqual(fs.existsSync(file), false);
  });

  await test('removeTree: вложенные папки на кириллическом пути удаляются', () => {
    const dir = cyrDir();
    fs.mkdirSync(path.join(dir, 'папка', 'глубже'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'папка', 'глубже', 'файл.txt'), 'x');
    fs.writeFileSync(path.join(dir, 'корень.txt'), 'y');
    removeTree(dir);
    assert.strictEqual(fs.existsSync(dir), false);
  });

  await test('removeTree: несуществующий путь — без ошибки', () => {
    removeTree(path.join(os.tmpdir(), 'ag-safe-нет-такого-пути-' + process.pid));
    removeTree(path.join(os.tmpdir(), 'ag-safe-нет-такого-пути-' + process.pid, 'вложенный'));
  });

  if (process.platform === 'win32') {
    await test('removeTree: junction не обходится, цель остаётся', () => {
      const dir = cyrDir();
      const target = cyrDir();
      fs.writeFileSync(path.join(target, 'важно.txt'), 'keep');
      const link = path.join(dir, 'ссылка');
      fs.symlinkSync(target, link, 'junction');
      removeTree(dir);
      assert.strictEqual(fs.existsSync(dir), false);
      assert.strictEqual(fs.existsSync(path.join(target, 'важно.txt')), true, 'цель junction должна остаться');
    });
  }

  for (const dir of tmpRoots) {
    try { removeTree(dir); } catch {}
  }
  console.log(`\nИтого: ${passed} ok, ${failed} fail`);
  process.exit(failed ? 1 : 0);
})();
