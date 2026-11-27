'use strict';

/*
 * Тесты агентных файловых инструментов (lib/agent.js) — без сети.
 *   1. Песочница: escape-пути, symlinks, абсолютные пути — отклоняются.
 *   2. Инструменты: list_dir / read_file / write_file / edit_file / move_path,
 *      лимиты размеров, бинарный sniff, delete_path и run_command по умолчанию off.
 *   3. parseToolCallBlocks: разбор ```tool_call```-блоков.
 *   4. runAgentLoop: полный цикл с фейковой моделью (scripted tool calls).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createExecutor,
  parseToolCallBlocks,
  extractToolCalls,
  buildSystemPrompt,
  runAgentLoop,
  TOOL_SPECS,
  TOOL_ALIASES,
  isSystemPath,
  isDangerousWriteName,
  toolResultForModel,
} = require('../lib/agent');
const { removeTree } = require('../lib/safe_files');

let passed = 0;
let failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('  ok ', name); }
  else { failed++; console.error('  FAIL', name); }
}

// Временная песочница на каждый тест-ран
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-agent-test-'));
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-agent-proj-'));
const ex = createExecutor({ workspaceRoot: tmp, auditFile: path.join(projectDir, 'audit.jsonl') }, projectDir);

(async () => {
  console.log('== 1. Песочница');
  let r = await ex.execute('write_file', { path: '../../escape.txt', content: 'x' });
  ok(r.ok === false && /за пределы|запрещены/.test(r.error), 'write за пределы корня отклонён: ' + (r.error || ''));

  r = await ex.execute('write_file', { path: 'C:\\Windows\\evil.txt', content: 'x' });
  ok(r.ok === false, 'абсолютный путь отклонён');

  r = await ex.execute('read_file', { path: '..' });
  ok(r.ok === false, 'чтение родительского каталога отклонено');

  // symlink-escape
  try {
    fs.symlinkSync(projectDir, path.join(tmp, 'leak'), 'dir');
    r = await ex.execute('read_file', { path: 'leak/config.json' });
    ok(r.ok === false && /пределы/.test(r.error || ''), 'symlink наружу отклонён');
  } catch (e) {
    console.log('  (symlink не поддержан, пропуск)');
  }

  console.log('== 2. Инструменты');
  r = await ex.execute('write_file', { path: 'docs/report.md', content: '# Отчёт\n\nСтрока одна.\nСтрока две.\n' });
  ok(r.ok === true && r.bytes > 0, 'write_file создаёт файл с родительской папкой');

  r = await ex.execute('read_file', { path: 'docs/report.md' });
  ok(r.ok === true && r.content.includes('Строка две'), 'read_file возвращает содержимое');

  r = await ex.execute('edit_file', { path: 'docs/report.md', old_string: 'Строка одна.', new_string: 'Строка ПЕРВАЯ.' });
  ok(r.ok === true && r.replacements === 1, 'edit_file заменяет уникальное вхождение');

  r = await ex.execute('edit_file', { path: 'docs/report.md', old_string: 'нет такого', new_string: 'x' });
  ok(r.ok === false && /не найден/.test(r.error), 'edit_file ругается на отсутствующий old_string');

  r = await ex.execute('list_dir', { path: '.' });
  ok(r.ok === true && r.items.some(i => i.name === 'docs' && i.type === 'dir'), 'list_dir показывает папки');

  r = await ex.execute('move_path', { from: 'docs/report.md', to: 'docs/report2.md' });
  ok(r.ok === true && !fs.existsSync(path.join(tmp, 'docs', 'report.md')), 'move_path перемещает файл');

  // Бинарный sniff
  const bin = Buffer.from([0x00, 0x01, 0x02, 0x03]);
  fs.writeFileSync(path.join(tmp, 'blob.bin'), bin);
  r = await ex.execute('read_file', { path: 'blob.bin' });
  ok(r.ok === false && /бинарн/i.test(r.error), 'бинарный файл не читается как текст');

  // Лимит записи
  r = await ex.execute('write_file', { path: 'big.txt', content: 'a'.repeat(3 * 1024 * 1024) });
  ok(r.ok === false && /лимит/.test(r.error), 'лимит размера записи работает');

  // delete/run по умолчанию выключены
  r = await ex.execute('delete_path', { path: 'blob.bin' });
  ok(r.ok === false && /выключено/i.test(r.error), 'delete_path выключен по умолчанию');

  r = await ex.execute('run_command', { command: 'echo hi' });
  ok(r.ok === false && /run_command/.test(r.error) && /выключен/i.test(r.error), 'run_command выключен по умолчанию');

  // Неизвестный инструмент
  r = await ex.execute('nuke_everything', {});
  ok(r.ok === false && /Неизвестный инструмент/.test(r.error), 'неизвестный инструмент отклонён');

  // Аудит пишется
  const audit = fs.readFileSync(path.join(projectDir, 'audit.jsonl'), 'utf8').trim().split('\n');
  ok(audit.length >= 10 && JSON.parse(audit[audit.length - 1]).tool, 'аудит-лог пишется в agent_audit.jsonl');

  r = await ex.execute('write_file', { path: 'long/big.txt', content: 'часть-1;' });
  r = await ex.execute('append_file', { path: 'long/big.txt', content: 'часть-2;' });
  r = await ex.execute('append_file', { path: 'long/big.txt', content: 'часть-3' });
  ok(r.ok === true && r.total === fs.statSync(path.join(tmp, 'long/big.txt')).size, 'append_file дописывает и возвращает total');
  ok(fs.readFileSync(path.join(tmp, 'long/big.txt'), 'utf8') === 'часть-1;часть-2;часть-3', 'чанки склеились в правильном порядке');
  r = await ex.execute('append_file', { path: 'long/new_via_append.txt', content: 'создан аппендом' });
  ok(r.ok === true && fs.existsSync(path.join(tmp, 'long/new_via_append.txt')), 'append_file создаёт отсутствующий файл');

  console.log('== 3. parseToolCallBlocks');
  const text = 'Начну с создания файла.\n```tool_call\n{"name": "write_file", "arguments": {"path": "a.txt", "content": "привет"}}\n```\nЗатем дочитаю.';
  const parsed = parseToolCallBlocks(text);
  ok(parsed.toolCalls.length === 1 && parsed.toolCalls[0].function.name === 'write_file', 'tool_call блок распознан');
  ok(JSON.parse(parsed.toolCalls[0].function.arguments).path === 'a.txt', 'аргументы распознаны');
  ok(parsed.cleanText.includes('Начну') && parsed.cleanText.includes('Затем дочитаю'), 'блок вырезан из чистого текста');
  ok(parseToolCallBlocks('без блоков').toolCalls.length === 0, 'текст без блоков даёт 0 вызовов');

  console.log('== 4. runAgentLoop (фейковая модель)');
  const sys = buildSystemPrompt({ workspace: tmp, toolNames: ['write_file'], allowDelete: false, allowShell: false });
  ok(sys.includes(tmp) && sys.includes('tool_call'), 'системный промпт содержит воркспейс и протокол');
  ok(!sys.includes('ask_planner'), 'без extraTools planner не предлагается');
  const sysPlanner = buildSystemPrompt({ workspace: tmp, toolNames: ['write_file', 'ask_planner'], allowDelete: false, allowShell: false, extraTools: ['ask_planner'] });
  ok(sysPlanner.includes('ask_planner') && /TEXT only/.test(sysPlanner), 'extraTools добавляет политику ask_planner в промпт');

  // Сценарий: 1-й ответ — tool_call на write_file; 2-й — финальный ответ.
  let callCount = 0;
  const fakeChat = async (msgs) => {
    callCount++;
    if (callCount === 1) {
      return {
        content: 'Создаю файл.',
        tool_calls: [{
          id: 'call_1', type: 'function',
          function: { name: 'write_file', arguments: JSON.stringify({ path: 'loop.txt', content: 'создано циклом' }) },
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      };
    }
    const toolMsg = msgs.find(m => m.role === 'tool');
    ok(toolMsg && JSON.parse(toolMsg.content).ok === true, 'результат инструмента передан модели как role=tool');
    return { content: 'Готово: файл loop.txt создан.', tool_calls: [], usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } };
  };

  const result = await runAgentLoop({
    chat: fakeChat,
    messages: [{ role: 'user', content: 'Создай loop.txt' }],
    executor: ex,
    maxIterations: 4,
    systemPrompt: sys,
  });

  ok(fs.readFileSync(path.join(tmp, 'loop.txt'), 'utf8') === 'создано циклом', 'цикл реально создал файл на диске');
  ok(result.completed === true && result.content.includes('Готово'), 'цикл завершён финальным ответом');
  ok(result.iterations === 2, '2 итерации (tool + финал)');
  ok(result.trace.length === 1 && result.trace[0].tool === 'write_file' && result.trace[0].ok === true, 'trace содержит действие');
  ok(result.usage.total_tokens === 43, 'usage просуммирован по итерациям');

  // Лимит итераций: модель вечно вызывает инструменты
  let endless = 0;
  const loopChat = async () => ({
    content: 'снова инструмент',
    tool_calls: [{ id: 'c' + (++endless), type: 'function', function: { name: 'write_file', arguments: '{"path": "x.txt", "content": "1"}' } }],
  });
  const r2 = await runAgentLoop({ chat: loopChat, messages: [{ role: 'user', content: 'go' }], executor: ex, maxIterations: 3, systemPrompt: '' });
  ok(r2.completed === false && r2.iterations === 4, 'лимит итераций останавливает вечный цикл');
  ok(r2.content.includes('снова инструмент'), 'после лимита возвращён последний ответ модели');

  // Спецификации инструментов валидны (7 файловых + run_command)
  ok(TOOL_SPECS.length === 9 && TOOL_SPECS.every(t => t.function.name && t.function.parameters), '9 спецификаций инструментов корректны');
  ok(!TOOL_SPECS.some(t => t.function.name === 'ask_planner'), 'ask_planner не входит в базовый список инструментов');

  console.log('== 5. Алиасы и устойчивый разбор вызовов');
  // Сценарий пользователя: модель зовёт "bash" с PowerShell-командой
  r = await ex.execute('bash', { command: 'New-Item -ItemType Directory -Path "Carbon"' });
  ok(r.ok === false && /выключен/i.test(r.error) && /run_command/.test(r.error) && /create_dir/.test(r.error),
    'bash -> run_command (алиас), но выключен с подсказкой альтернатив');

  r = await ex.execute('mkdir', { path: 'Carbon' });
  ok(r.ok === true && fs.existsSync(path.join(tmp, 'Carbon')), 'mkdir -> create_dir: папка реально создана');

  r = await ex.execute('write_to_file', { path: 'Carbon/inside.txt', content: 'ok' });
  ok(r.ok === true && fs.existsSync(path.join(tmp, 'Carbon', 'inside.txt')), 'write_to_file -> write_file (алиас Cline)');

  // extractToolCalls: сырой JSON без фенса больше НЕ исполняется.
  // Цитата из файла/пользовательского текста не должна запускать инструмент.
  let ext = extractToolCalls('Создаю папку.\n' + JSON.stringify({ name: 'bash', arguments: { command: 'mkdir Carbon' } }) + '\nГотово.');
  ok(ext.toolCalls.length === 0, 'сырой JSON без фенса не считается вызовом');
  ok(ext.cleanText.includes('"arguments"'), 'сырой JSON остаётся текстом, а не вырезается');

  // ```tool_call-фенс с алиасом bash — рабочий путь
  ext = extractToolCalls('```tool_call\n' + JSON.stringify({ name: 'bash', arguments: { command: 'echo 1' } }) + '\n```');
  ok(ext.toolCalls.length === 1 && ext.toolCalls[0].function.name === 'bash', 'вызов в ```tool_call-фенсе распознан (алиас bash)');

  // Дубликат того же вызова в одном ответе исполняется один раз
  ext = extractToolCalls('```tool_call\n' + JSON.stringify({ name: 'create_dir', arguments: { path: 'a' } }) + '\n```\n```tool_call\n' + JSON.stringify({ name: 'create_dir', arguments: { path: 'a' } }) + '\n```');
  ok(ext.toolCalls.length === 1, 'одинаковые вызовы схлопываются в один');

  // Неизвестное имя инструмента НЕ считается вызовом (остаётся текстом)
  ext = extractToolCalls('Пример: {"name": "nuke", "arguments": {}}');
  ok(ext.toolCalls.length === 0 && ext.cleanText.includes('nuke'), 'неизвестное имя игнорируется');

  // Обычный JSON без arguments — не вызов
  ext = extractToolCalls('Конфиг: {"name": "app", "version": 1}');
  ok(ext.toolCalls.length === 0, 'JSON без arguments не принимается за вызов');

  console.log('== 6. Цикл: модель зовёт bash, исправляется на create_dir');
  let step2 = 0;
  const selfCorrectingChat = async (msgs) => {
    step2++;
    if (step2 === 1) {
      // модель зовёт bash (алиас run_command) через фенс и получает отказ
      return { content: 'Пробую терминал.\n```tool_call\n' + JSON.stringify({ name: 'bash', arguments: { command: 'mkdir Carbon2' } }) + '\n```' };
    }
    // [...msgs] — копия, чтобы не мутировать convo цикла
    const toolMsg = [...msgs].reverse().find(m => m.role === 'tool');
    if (step2 === 2) {
      ok(toolMsg && toolMsg.name === 'run_command' && JSON.parse(toolMsg.content).ok === false,
        'модель получила ошибку от run_command (алиас bash) и может исправиться');
      return {
        content: 'Терминал недоступен — создаю папку инструментом.',
        tool_calls: [{ id: 'c2', type: 'function', function: { name: 'create_dir', arguments: JSON.stringify({ path: 'Carbon2' }) } }],
      };
    }
    return { content: 'Папка Carbon2 создана.', tool_calls: [] };
  };
  const r3 = await runAgentLoop({
    chat: selfCorrectingChat,
    messages: [{ role: 'user', content: 'Создай папку Carbon2' }],
    executor: ex,
    maxIterations: 4,
    systemPrompt: '',
  });
  ok(fs.existsSync(path.join(tmp, 'Carbon2')), 'после самоисправления модель создала папку на диске');
  ok(r3.trace.some(a => a.tool === 'run_command' && a.ok === false) && r3.trace.some(a => a.tool === 'create_dir' && a.ok === true),
    'trace: попытка bash -> run_command (ошибка) затем create_dir (успех)');
  ok(r3.completed === true && r3.content.includes('Папка Carbon2 создана'), 'цикл завершён финальным ответом');

  console.log('== 7. Абсолютные пути (allowAbsolutePaths)');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-agent-outside-'));
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-agent-ws2-'));
  const proj2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-agent-proj2-'));
  const exAbs = createExecutor({ workspaceRoot: tmp2, allowAbsolutePaths: true, auditFile: path.join(proj2, 'a.jsonl') }, proj2);

  r = await exAbs.execute('write_file', { path: path.join(outside, 'outside.txt'), content: 'абсолютный путь работает' });
  ok(r.ok === true, 'write_file по абсолютному пути (флаг включён)');
  r = await exAbs.execute('read_file', { path: path.join(outside, 'outside.txt') });
  ok(r.ok === true && r.content === 'абсолютный путь работает', 'read_file по абсолютному пути');

  r = await exAbs.execute('create_dir', { path: 'C:\\Windows\\AgentTest' });
  ok(r.ok === false && /(системн|защищ)/i.test(r.error), 'системные папки (Windows) заблокированы даже с флагом: ' + (r.error || '').slice(0, 60));

  r = await exAbs.execute('write_file', { path: 'C:\\Program Files\\evil.txt', content: 'x' });
  ok(r.ok === false && /(системн|защищ)/i.test(r.error), 'Program Files заблокирован');

  // Без флага абсолютные пути по-прежнему отклоняются
  r = await ex.execute('write_file', { path: path.join(outside, 'x.txt'), content: 'x' });
  ok(r.ok === false && /запрещен/i.test(r.error), 'без флага абсолютные пути отклонены');

  // Системный промпт отражает режим
  const sysAbs = buildSystemPrompt({ workspace: tmp2, toolNames: ['write_file'], allowDelete: false, allowShell: false, allowAbsolutePaths: true });
  ok(/ABSOLUTE paths ARE allowed/.test(sysAbs), 'промпт с флагом разрешает абсолютные пути');
  const sysSandbox = buildSystemPrompt({ workspace: tmp2, toolNames: ['write_file'], allowDelete: false, allowShell: false, allowAbsolutePaths: false });
  ok(/must be RELATIVE/.test(sysSandbox), 'промпт без флага требует относительные пути');

  // Рекурсивное удаление: раньше fs.rmSync в Node 24 на пути с кириллицей
  // (C:\Users\<user>\...) молча ничего не удалял, а инструмент отвечал ok:true.
  const delRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-agent-del-'));
  const delAudit = path.join(os.tmpdir(), `ag-agent-del-audit-${process.pid}.jsonl`);
  const exDel = createExecutor({ workspaceRoot: delRoot, allowDelete: true, auditFile: delAudit }, delRoot);
  fs.mkdirSync(path.join(delRoot, 'подпапка', 'глубже'), { recursive: true });
  fs.writeFileSync(path.join(delRoot, 'подпапка', 'глубже', 'файл.txt'), 'x');
  r = await exDel.execute('delete_path', { path: 'подпапка', recursive: true });
  ok(r.ok === true, 'рекурсивное удаление вернуло ok');
  ok(!fs.existsSync(path.join(delRoot, 'подпапка')), 'рекурсивное удаление реально удалило папку');
  r = await exDel.execute('delete_path', { path: 'подпапка', recursive: true });
  ok(r.ok === false && /Не найдено/.test(r.error), 'повторное удаление — «не найдено»');
  removeTree(delRoot);
  removeTree(delAudit);

  console.log('== 8. Границы UTF-8, $-паттерны, журнал, run_command, системные пути');
  const exC = createExecutor({ workspaceRoot: path.join(projectDir, 'ws-c'), auditFile: path.join(projectDir, 'audit-c.jsonl') }, projectDir);

  // read_file не должен резать многобайтный символ на границе чанка.
  const manyE = 'ж'.repeat(10000) + 'END';
  fs.writeFileSync(path.join(exC.workspace, 'utf8.txt'), manyE);
  let acc = '';
  let off = 0;
  let rounds = 0;
  for (;;) {
    r = await exC.execute('read_file', { path: 'utf8.txt', offset_bytes: off });
    ok(r.ok === true, 'чтение чанка ' + rounds);
    ok(!r.content.includes('\uFFFD'), 'в чанке нет символа замены ' + rounds);
    acc += r.content;
    if (r.next_offset == null) break;
    off = r.next_offset;
    if (++rounds > 50) break;
  }
  ok(acc === manyE, 'склейка чанков даёт исходный текст');

  // new_string с $-последовательностями должен попасть в файл дословно.
  fs.writeFileSync(path.join(exC.workspace, 'price.md'), 'Цена: OLD\n');
  r = await exC.execute('edit_file', { path: 'price.md', old_string: 'OLD', new_string: '$& $1 $\' $` $$' });
  ok(r.ok === true, 'edit_file с $-паттернами выполнен');
  ok(fs.readFileSync(path.join(exC.workspace, 'price.md'), 'utf8') === 'Цена: $& $1 $\' $` $$\n', 'new_string записан дословно: ' + JSON.stringify(fs.readFileSync(path.join(exC.workspace, 'price.md'), 'utf8')));

  // Журнал пишет фактический исход, а не ok:true для любой ошибки.
  await exC.execute('read_file', { path: 'нет-такого.txt' });
  const auditC = fs.readFileSync(path.join(projectDir, 'audit-c.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const lastRec = auditC[auditC.length - 1];
  ok(lastRec.ok === false && /не найден/i.test(lastRec.error || ''), 'в журнале ok=false и причина');

  // Ротация: превышение порога уводит журнал в .1.
  const rotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-agent-rot-'));
  const rotAudit = path.join(rotDir, 'audit.jsonl');
  const exRot = createExecutor({ workspaceRoot: path.join(rotDir, 'ws'), auditFile: rotAudit, auditRotateBytes: 64 * 1024 }, rotDir);
  await exRot.execute('create_dir', { path: 'a' });
  fs.appendFileSync(rotAudit, 'x'.repeat(70 * 1024) + '\n');
  await exRot.execute('create_dir', { path: 'b' });
  ok(fs.existsSync(rotAudit + '.1') && fs.statSync(rotAudit + '.1').size > 64 * 1024, 'журнал уведён в .1');
  ok(fs.readFileSync(rotAudit, 'utf8').trim().split('\n').length === 1, 'новый журнал начинается с одной записи');
  removeTree(rotDir);

  // run_command: реальный код возврата, а не «ошибка при stdout».
  const exShell = createExecutor({ workspaceRoot: path.join(projectDir, 'ws-shell'), allowShell: true, auditFile: path.join(projectDir, 'audit-shell.jsonl') }, projectDir);
  r = await exShell.execute('run_command', { command: 'exit 3' });
  ok(r.ok === false && r.exit_code === 3, 'run_command: ненулевой код -> ok=false, exit_code=3');
  r = await exShell.execute('run_command', { command: 'echo привет' });
  ok(r.ok === true && r.exit_code === 0 && /привет/.test(r.stdout), 'run_command: успешная команда -> ok=true');

  if (process.platform === 'win32') {
    // cmd пишет cp866, node/python — UTF-8; построчное определение кодировки.
    r = await exShell.execute('run_command', { command: 'echo привет & node -e "process.stdout.write(\'мир\\n\')"' });
    ok(r.ok === true && r.stdout.includes('привет') && r.stdout.includes('мир'),
      'смешанный вывод cmd(cp866)+node(utf8) читается: ' + JSON.stringify(r.stdout));
  }

  // Системные пути: \\?\-префикс и Windows на другом диске не обходят защиту.
  r = await exAbs.execute('create_dir', { path: '\\\\?\\C:\\Windows\\AgentTest2' });
  ok(r.ok === false && /(системн|защищ)/i.test(r.error), '\\\\?\\C:\\Windows заблокирован');
  r = await exAbs.execute('create_dir', { path: 'D:\\Windows\\AgentTest3' });
  ok(r.ok === false && /(системн|защищ)/i.test(r.error), 'D:\\Windows заблокирован');
  r = await exAbs.execute('read_file', { path: 'D:\\Windows\\notepad.exe' });
  ok(r.ok === false, 'чтение D:\\Windows\\... заблокировано');
  r = await exAbs.execute('create_dir', { path: path.join(outside, 'ok-dir') });
  ok(r.ok === true, 'обычный путь вне системных папок разрешён');

  console.log('== 8. Защита домашних каталогов, автозапуска и исполняемых файлов');
  const home = os.homedir();
  const mustBlock = [
    path.join(home, '.ssh', 'authorized_keys'),
    path.join(home, '.gnupg', 'gpg.conf'),
    path.join(process.env.APPDATA || home, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'x.lnk'),
    path.join(outside, '.git', 'hooks', 'pre-commit'),
    path.join('C:/', 'ProgramData', 'evil.txt'),
  ];
  for (const target of mustBlock) {
    ok(isSystemPath(target) === true, 'защищённый путь: ' + target.replace(home, '~'));
  }
  ok(isSystemPath(path.join(outside, 'docs', 'notes.txt')) === false, 'обычный текстовый путь не защищён');
  ok(isDangerousWriteName(path.join(outside, 'run.ps1')) === true, '.ps1 считается опасным для записи вне workspace');
  ok(isDangerousWriteName(path.join(outside, 'notes.md')) === false, '.md не опасен');

  r = await exAbs.execute('write_file', { path: path.join(outside, 'evil.ps1'), content: 'Remove-Item -Recurse -Force C:' });
  ok(r.ok === false && /(запрещен|исполняем)/i.test(r.error), 'запись .ps1 вне workspace запрещена: ' + String(r.error || '').slice(0, 60));
  r = await exAbs.execute('write_file', { path: path.join(home, '.ssh', 'authorized_keys'), content: 'ssh-rsa AAAA' });
  ok(r.ok === false, 'запись в ~/.ssh запрещена даже с allowAbsolutePaths');

  // Внутри workspace исполняемые файлы разрешены: это песочница задачи.
  r = await exAbs.execute('write_file', { path: 'tool.ps1', content: 'Write-Host ok' });
  ok(r.ok === true, 'внутри workspace .ps1 разрешён');

  console.log('== 9. Бюджет tool-результата: JSON остаётся валидным');
  const bigStdout = 'x'.repeat(100000);
  const funneled = toolResultForModel({ ok: true, stdout: bigStdout, exit_code: 0 });
  let parsedBig = null;
  try { parsedBig = JSON.parse(funneled); } catch { parsedBig = null; }
  ok(parsedBig !== null, 'обрезанный результат — валидный JSON');
  ok(funneled.length <= 24000 && parsedBig.truncated === true, 'в результат добавлен truncated и он в бюджете: ' + funneled.length);
  ok(typeof parsedBig.stdout === 'string' && parsedBig.stdout.length < bigStdout.length, 'stdout обрезан по полю, а не по строке JSON');
  ok(JSON.parse(toolResultForModel({ ok: true, content: 'small' })).content === 'small', 'маленький результат проходит без изменений');

  console.log('== 10. Системный промпт: данные из инструментов недоверенные');
  const prompt = buildSystemPrompt({ workspace: tmp, toolNames: TOOL_SPECS.map((t) => t.function.name), allowDelete: false, allowShell: false, allowAbsolutePaths: false });
  ok(/UNTRUSTED DATA/.test(prompt), 'в промпте есть правило про недоверенные данные');
  ok(/Outside the workspace only text files/.test(prompt), 'промпт предупреждает про ограничения записи вне workspace');

  removeTree(outside);
  removeTree(tmp2);
  removeTree(proj2);

  console.log(`\nИтого: ${passed} ok, ${failed} fail`);
  removeTree(tmp);
  removeTree(projectDir);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
