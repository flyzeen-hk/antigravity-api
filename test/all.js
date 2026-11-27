'use strict';

// Единый прогон всех тестов: node test/all.js (или npm test).
// Тесты идут отдельными процессами — поднимают изолированные порты и mock-серверы,
// поэтому падение одного не влияет на остальные и не тянет за собой состояние.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const NODE_TESTS = [
  ['server: интеграционные тесты шлюза', 'test/run-tests.js'],
  ['http_helpers/translate/web_bridge: быстрые регрессии', 'test/server_regression_check.js'],
  ['конфигурация: defaults/schema/patch', 'test/test_config.js'],
  ['безопасность агента, guard, models, anthropic, web_bridge', 'test/test_security_and_fixes.js'],
  ['извлечение токена Antigravity IDE (pure Node)', 'test/test_token_extract.js'],
  ['автопоиск прокси (pure Node)', 'test/test_proxy_detect.js'],
  ['каталог моделей: кэш и stale-while-revalidate', 'test/test_models.js'],
  ['провайдеры моделей', 'test/test_providers.js'],
  ['planner', 'test/test_planner.js'],
  ['сетевой слой', 'test/test_net.js'],
  ['сохранность файлов', 'test/test_safe_files.js'],
  ['перевод OpenAI <-> Gemini', 'test/test_translate.js'],
  ['файловые инструменты агента', 'test/agent_tools_test.js'],
  ['веб-мост Gemini', 'test/test_web_bridge.js'],
  ['диагностика', 'test/test_diagnostics.js'],
  ['режим только веб-моделей (AG_NO_CLOUD)', 'test/test_web_only.js'],
  ['UI-супервизор и жизненный цикл шлюза', 'test/test_supervisor.js'],
];

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

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n${failed.length ? 'ПРОВАЛЕНО: ' + failed.join('; ') : 'ВСЕ ТЕСТЫ ПРОЙДЕНЫ'} (${secs} с)`);
  process.exit(failed.length ? 1 : 0);
}

main();
