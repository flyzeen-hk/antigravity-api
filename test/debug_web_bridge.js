'use strict';
// Отладка веб-моста: дамп сырого SSE-ответа Google
const path = require('path');
process.chdir(path.join(__dirname, '..'));
const fs = require('fs');
const config = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const { GeminiWebBridge } = require(path.join(process.cwd(), 'lib', 'web_bridge.js'));

(async () => {
  const bridge = new GeminiWebBridge(config.geminiWeb || {});
  const meta = { modelId: 8, thinkMode: 4, hexId: '95a4c0abcba24364' };
  const bodyStr = bridge.buildPayload('Say hello.', meta.modelId, meta.thinkMode);
  console.log('bl =', bridge.bl);
  console.log('cookie loaded:', !!(config.geminiWeb && config.geminiWeb.cookie));
  try {
    const res = await bridge.sendStreamRequestResilient(bodyStr, meta);
    console.log('HTTP', res.statusCode, res.headers['content-type'] || '');
    let size = 0;
    for await (const chunk of res) {
      const s = chunk.toString('utf8');
      size += s.length;
      if (size <= 3000) process.stdout.write(s.slice(0, 3000));
      if (size > 100000) break;
    }
    console.log('\n--- total bytes:', size);
  } catch (e) {
    console.error('ERROR:', e.status || '', e.message);
    if (e.location) console.error('location:', e.location);
  }
})();
