'use strict';

// Единый прогон всех тестов: node test/all.js  (или npm test).
// Node-тесты идут отдельными процессами — они поднимают свои порты и mock-серверы,
// поэтому падение одного не мешает остальным и не тащит за собой его состояние.
// Python-тесты запускаются только если найден Python с Tk (панель).

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const NODE_TESTS = [
  ['server: интеграционные тесты шлюза', 'test/run-tests.js'],
  ['http_helpers/translate/web_bridge: быстрые регрессии', 'test/server_regression_check.js'],
  ['каталог моделей: кэш и stale-while-revalidate', 'test/test_models.js'],
  ['провайдеры моделей', 'test/test_providers.js'],
  ['planner', 'test/test_planner.js'],
  ['сетевой слой', 'test/test_net.js'],
  ['сохранность файлов', 'test/test_safe_files.js'],
  ['перевод OpenAI <-> Gemini', 'test/test_translate.js'],
  ['файловые инструменты агента', 'test/agent_tools_test.js'],
  ['веб-мост Gemini', 'test/test_web_bridge.js'],
  ['диагностика', 'test/test_diagnostics.js'],
];

const PY_TESTS = [
  ['панель: config.json', 'test/test_app_config.py'],
  ['извлечение куки', 'test/test_cookie_extract.py'],
  ['куки через CDP', 'test/test_cookie_cdp.py'],
];

function findPython() {
  for (const exe of ['python', 'py', 'python3']) {
    const r = spawnSync(exe, ['-c', 'import tkinter, sys; sys.exit(0)'], { cwd: ROOT, encoding: 'utf8' });
    if (!r.error && r.status === 0) return exe;
  }
  return null;
}

function run(label, args) {
  process.stdout.write(`\n=== ${label}\n`);
  const r = spawnSync(args[0], args.slice(1), { cwd: ROOT, stdio: 'inherit', env: process.env });
  if (r.error) {
    console.error(`  FAIL: не удалось запустить ${args.join(' ')}: ${r.error.message}`);
    return false;
  }
  if (r.status !== 0) console.error(`  FAIL: ${label} (код ${r.status})`);
  return r.status === 0;
}

function main() {
  const started = Date.now();
  const failed = [];
  for (const [label, file] of NODE_TESTS) {
    if (!fs.existsSync(path.join(ROOT, file))) { failed.push(label + ' (файл не найден)'); continue; }
    if (!run(label, [process.execPath, file])) failed.push(label);
  }

  const py = findPython();
  if (py) {
    for (const [label, file] of PY_TESTS) {
      if (!fs.existsSync(path.join(ROOT, file))) continue;
      if (!run(label, [py, file])) failed.push(label);
    }
  } else {
    console.log('\n! Python с tkinter не найден — тесты панели (app.py) пропущены.');
  }

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n${failed.length ? 'ПРОВАЛЕНО: ' + failed.join('; ') : 'ВСЕ ТЕСТЫ ПРОЙДЕНЫ'} (${secs} с)`);
  process.exit(failed.length ? 1 : 0);
}

main();
