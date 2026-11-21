'use strict';

// Проверка режима «только веб-модели» (AG_NO_CLOUD=1): контейнер без auth.json
// должен стартовать, отдавать web/* и явно отклонять cloud/*.
// Запуск: node test/test_web_only.js

const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { removeTree } = require('../lib/safe_files');

function freePort() {
  return new Promise((resolve) => {
    const srv = require('net').createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-webonly-'));
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      AG_DATA_DIR: dataDir,
      AG_PORT: String(port),
      AG_HOST: '127.0.0.1',
      AG_NO_CLOUD: '1',
      // Доказываем, что OAuth-файл не нужен и не подхватывается.
      AG_AUTH_FILE: path.join(dataDir, 'auth-absent.json'),
      AG_USAGE_FILE: path.join(dataDir, 'usage.json'),
    },
    windowsHide: true,
  });

  let log = '';
  child.stdout.on('data', (d) => { log += d.toString(); });
  child.stderr.on('data', (d) => { log += d.toString(); });

  const base = `http://127.0.0.1:${port}`;
  const health = async () => {
    for (let i = 0; i < 80; i++) {
      try {
        const r = await fetch(base + '/_health');
        if (r.ok) return true;
      } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  };

  try {
    assert.strictEqual(await health(), true, 'сервер не поднялся без auth.json\n' + log.slice(-800));

    const key = fs.readFileSync(path.join(dataDir, 'apikey.txt'), 'utf8').trim();
    assert.ok(key.length >= 16, 'apikey.txt не создан');
    assert.ok(!fs.existsSync(path.join(dataDir, 'auth-absent.json')), 'auth.json не должен создаваться');

    const modelsRes = await fetch(base + '/v1/models', { headers: { authorization: 'Bearer ' + key } });
    assert.strictEqual(modelsRes.status, 200);
    const models = (await modelsRes.json()).data || [];
    assert.ok(models.length > 0, 'пустой каталог');
    assert.ok(models.every((m) => m.id.startsWith('web/')), 'в режиме web-only не должно быть cloud/*: '
      + models.filter((m) => !m.id.startsWith('web/')).map((m) => m.id).join(', '));
    console.log('  ok  /v1/models отдаёт только web/* (' + models.length + ')');

    const cloudRes = await fetch(base + '/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'cloud/gemini-3-flash', messages: [{ role: 'user', content: 'x' }] }),
    });
    const cloudBody = await cloudRes.json();
    assert.strictEqual(cloudRes.status, 400, JSON.stringify(cloudBody));
    assert.strictEqual(cloudBody.error.code, 'cloud_disabled');
    console.log('  ok  cloud-модель отклонена с cloud_disabled');

    const gemRes = await fetch(base + '/v1beta/models/cloud/gemini-3-flash:generateContent', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'x' }] }] }),
    });
    assert.strictEqual(gemRes.status, 400);
    assert.strictEqual((await gemRes.json()).error.code, 'cloud_disabled');
    console.log('  ok  Gemini-нативный cloud-путь отклонён');

    const anthRes = await fetch(base + '/v1/messages', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 16, messages: [{ role: 'user', content: 'x' }] }),
    });
    assert.strictEqual(anthRes.status, 400);
    console.log('  ok  Anthropic-путь отклонён');

    const limitsRes = await fetch(base + '/_limits', { headers: { authorization: 'Bearer ' + key } });
    assert.strictEqual(limitsRes.status, 200, 'панель не должна зависать на /_limits');
    const limits = await limitsRes.json();
    assert.strictEqual(limits.account && limits.account.error, 'cloud_disabled');
    console.log('  ok  /_limits отвечает без Google');

    console.log('\nWEB-ONLY MODE TESTS PASSED!');
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 400));
    try { removeTree(dataDir); } catch {}
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
