import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseToolCalls, runAgent } from '../lib/loop.mjs';
import { callLimit, CLEARED, clearOldToolResults, compose, loopGuard, rateLimitBackoff, redact, trimToolOutput } from '../lib/middleware.mjs';
import { defineTool, ToolError } from '../lib/tools.mjs';

// Sahte model: sıralı cevaplar; her isteğin kopyasını saklar.
const fake = (script) => {
  let i = 0;
  const seen = [];
  const fn = async (req) => {
    seen.push(structuredClone({ messages: req.messages, tools: req.tools, toolChoice: req.toolChoice }));
    const next = script[i++];
    if (next instanceof Error) throw next;
    if (!next) throw new Error('senaryo bitti');
    return { finishReason: next.tool_calls ? 'tool_calls' : 'stop', usage: { input: 10, cached: 0, output: 2 }, ...('message' in next ? next : { message: { role: 'assistant', ...next } }) };
  };
  return Object.assign(fn, { seen });
};
const call = (name, args, id) => ({ id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } });

const echo = defineTool({
  name: 'echo',
  description: 'yankı',
  parameters: { properties: { text: { type: 'string' } }, required: ['text'] },
  run: ({ text }) => `yankı: ${text}`,
});
const boom = defineTool({ name: 'boom', description: '', run: () => { throw new ToolError('patladı'); } });
const crash = defineTool({ name: 'crash', description: '', run: () => { throw new TypeError('gizli yığın'); } });

test('araç çağrısı yoksa tek adımda biter', async () => {
  const model = fake([{ content: 'merhaba' }]);
  const r = await runAgent({ callModel: model, prompt: 'selam', tools: [echo] });
  assert.equal(r.answer, 'merhaba');
  assert.equal(r.stop, 'done');
  assert.equal(r.steps, 1);
  assert.deepEqual(r.usage, { input: 10, cached: 0, output: 2 });
  assert.equal(model.seen[0].tools[0].function.name, 'echo');
  assert.equal(model.seen[0].toolChoice, 'auto');
});

test('araç sonucu modele tool_call_id ile döner, sonra cevap', async () => {
  const model = fake([{ content: null, tool_calls: [call('echo', { text: 'a' }, 'c1'), call('echo', { text: 'b' }, 'c2')] }, { content: 'bitti' }]);
  const events = [];
  const r = await runAgent({ callModel: model, system: 'sis', prompt: 'p', tools: [echo], onEvent: (e) => events.push(e) });
  assert.equal(r.answer, 'bitti');
  assert.equal(r.toolCalls, 2);
  const second = model.seen[1].messages;
  assert.deepEqual(second.map((m) => m.role), ['system', 'user', 'assistant', 'tool', 'tool']);
  assert.deepEqual(second.slice(3).map((m) => [m.tool_call_id, m.content]), [['c1', 'yankı: a'], ['c2', 'yankı: b']]);
  assert.deepEqual(events.map((e) => e.kind), ['model', 'tool', 'tool', 'model']);
  assert.ok(events.every((e) => !('content' in e)));
});

test('bozuk JSON, bilinmeyen araç, şema hatası ve istisna modele hata olarak döner', async () => {
  const model = fake([
    { tool_calls: [call('echo', '{"text": "ya', 'a'), call('yok', {}, 'b'), call('echo', { text: 3 }, 'c'), call('boom', {}, 'd'), call('crash', {}, 'e')] },
    { content: 'toparladım' },
  ]);
  const r = await runAgent({ callModel: model, prompt: 'p', tools: [echo, boom, crash] });
  assert.equal(r.answer, 'toparladım');
  const tools = model.seen[1].messages.filter((m) => m.role === 'tool').map((m) => m.content);
  assert.match(tools[0], /^Hata: Argümanlar geçerli JSON değil/);
  assert.match(tools[1], /^Hata: Bilinmeyen araç: yok/);
  assert.match(tools[2], /^Hata: Geçersiz argüman: argümanlar.text: string/);
  assert.equal(tools[3], 'Hata: patladı');
  assert.match(tools[4], /^Hata: beklenmeyen hata: gizli yığın$/);
});

test('eksik id üretilir ve asistan mesajına da yazılır; ek alanlar atılır', () => {
  const calls = parseToolCalls({ tool_calls: [{ function: { name: 'echo', arguments: { text: 'x' } } }] }, 4);
  assert.equal(calls[0].id, 'call_4_0');
  assert.deepEqual(calls[0].args, { text: 'x' });
  assert.deepEqual(parseToolCalls({ tool_calls: [{ id: 'z', function: { name: 'echo', arguments: '' } }] }, 1)[0].args, {});
});

test('adım sınırında araçsız son çağrı yapılır', async () => {
  const loopy = { tool_calls: [call('echo', { text: 'x' }, 'c')] };
  const model = fake([loopy, loopy, { content: 'özet' }]);
  const r = await runAgent({ callModel: model, prompt: 'p', tools: [echo], middleware: [callLimit({ maxSteps: 2 })] });
  assert.equal(r.stop, 'step_limit');
  assert.equal(r.answer, 'özet');
  assert.equal(model.seen[2].toolChoice, undefined);
  assert.deepEqual(model.seen[2].tools, []);
  assert.match(model.seen[2].messages.at(-1).content, /Sınıra ulaşıldı/);
});

test('araç sınırı aşan çağrıyı koşmaz', async () => {
  const model = fake([{ tool_calls: [call('echo', { text: '1' }, 'a'), call('echo', { text: '2' }, 'b')] }, { content: 'son' }]);
  const r = await runAgent({ callModel: model, prompt: 'p', tools: [echo], middleware: [callLimit({ maxToolCalls: 1 })] });
  const tools = model.seen[1].messages.filter((m) => m.role === 'tool').map((m) => m.content);
  assert.equal(tools[0], 'yankı: 1');
  assert.match(tools[1], /Araç çağrı sınırı/);
  assert.equal(r.stop, 'tool_limit');
});

test('son çağrı da düşerse son asistan metni döner', async () => {
  const model = fake([{ content: 'ara not', tool_calls: [call('echo', { text: 'x' }, 'c')] }, new Error('kota')]);
  const r = await runAgent({ callModel: model, prompt: 'p', tools: [echo], middleware: [callLimit({ maxSteps: 1 })] });
  assert.equal(r.stop, 'step_limit');
  assert.equal(r.answer, 'ara not');
});

test('model hatası (sınır değil) döngüden yukarı atılır', async () => {
  const model = fake([new Error('HTTP 401')]);
  await assert.rejects(runAgent({ callModel: model, prompt: 'p' }), /401/);
});

test('sarmalayıcı sırası: ilk en dışta; afterModel ters sırada', async () => {
  const order = [];
  const mk = (n) => ({
    name: n,
    afterModel: () => void order.push(`after:${n}`),
    wrapModelCall: async (req, next) => {
      order.push(`in:${n}`);
      const r = await next(req);
      order.push(`out:${n}`);
      return r;
    },
  });
  await runAgent({ callModel: fake([{ content: 'x' }]), prompt: 'p', middleware: [mk('a'), mk('b')] });
  assert.deepEqual(order, ['in:a', 'in:b', 'out:b', 'out:a', 'after:b', 'after:a']);
  const c = compose([{ beforeModel: () => ({ end: 'dur' }) }, { beforeModel: () => assert.fail('çağrılmamalı') }]);
  assert.deepEqual(await c.beforeModel({}), { end: 'dur' });
});

test('beforeModel end dönerse model çağrılmaz', async () => {
  const model = fake([{ content: 'son söz' }]);
  const r = await runAgent({ callModel: model, prompt: 'p', middleware: [{ beforeModel: (s) => (s.steps === 0 ? { end: 'timeout' } : undefined) }] });
  assert.equal(r.stop, 'timeout');
  assert.equal(r.answer, 'son söz');
  assert.equal(model.seen.length, 1);
  assert.equal(model.seen[0].toolChoice, undefined);
});

test('eski araç çıktıları temizlenir, son üçü kalır', async () => {
  const messages = [{ role: 'user', content: 'p' }];
  for (let i = 0; i < 5; i++) messages.push({ role: 'assistant', content: null, tool_calls: [] }, { role: 'tool', tool_call_id: `${i}`, content: 'x'.repeat(100) });
  const m = clearOldToolResults({ triggerChars: 300, keep: 3 });
  await m.wrapModelCall({ messages }, async () => ({}));
  const tools = messages.filter((x) => x.role === 'tool').map((x) => x.content);
  assert.deepEqual(tools.map((c) => c === CLEARED), [true, true, false, false, false]);
  assert.equal(messages.length, 11);
});

test('kırpma, karartma ve döngü bekçisi', async () => {
  const trimmed = await trimToolOutput({ maxChars: 100 }).wrapToolCall({}, async () => 'a'.repeat(300));
  assert.ok(trimmed.length < 160 && trimmed.includes('kırpıldı'));
  const key = 'nvapi-' + 'A'.repeat(30);
  assert.equal(await redact().wrapToolCall({}, async () => `anahtar=${key} ok`), 'anahtar=[karartıldı] ok');
  const guard = loopGuard({ repeat: 3 });
  const req = { call: { name: 'echo', args: { text: 'x' } } };
  await guard.wrapToolCall(req, async () => 'ok');
  await guard.wrapToolCall(req, async () => 'ok');
  await assert.rejects(guard.wrapToolCall(req, async () => 'ok'), /3\. kez/);
});

test('429 ve 5xx üstel geri çekilmeyle yeniden denenir, 4xx denenmez', async () => {
  const waits = [];
  const m = rateLimitBackoff({ retries: 2, baseMs: 100, sleepFn: async (ms) => waits.push(ms), random: () => 0.5 });
  let n = 0;
  const r = await m.wrapModelCall({}, async () => {
    if (n++ < 2) throw Object.assign(new Error('çok istek'), { status: 429 });
    return 'ok';
  });
  assert.equal(r, 'ok');
  assert.deepEqual(waits, [100, 200]);
  await assert.rejects(m.wrapModelCall({}, async () => { throw Object.assign(new Error('yetki'), { status: 401 }); }), /yetki/);
  assert.equal(waits.length, 2);
});

test('ilk adımdan sonra model düşerse döngü durur, iş kaybolmaz; araç hatası ve özet karartılır', async () => {
  const key = 'nvapi-' + 'B'.repeat(30);
  const model = fake([{ content: 'okudum', tool_calls: [call('echo', `{"text": "${key}`, 'a')] }, Object.assign(new Error('HTTP 503'), { status: 503 })]);
  const events = [];
  const r = await runAgent({ callModel: model, prompt: 'p', tools: [echo], onEvent: (e) => events.push(e) });
  assert.equal(r.stop, 'model_error');
  assert.match(r.answer, /^okudum\n\n\(Döngü model hatasıyla durdu: HTTP 503\)$/);
  const tool = model.seen[1].messages.find((m) => m.role === 'tool').content;
  assert.ok(!tool.includes(key) && tool.includes('[karartıldı]'));
  assert.ok(!JSON.stringify(events).includes(key));
});

test('sert süre sınırında (signal) kontrollü duruş', async () => {
  const ctrl = new AbortController();
  const model = fake([{ content: 'ara', tool_calls: [call('echo', { text: 'x' }, 'a')] }]);
  const slow = async (req) => {
    if (model.seen.length) {
      ctrl.abort();
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }
    return model(req);
  };
  const r = await runAgent({ callModel: slow, prompt: 'p', tools: [echo], signal: ctrl.signal });
  assert.equal(r.stop, 'aborted');
  assert.match(r.answer, /^ara/);
});

test('son çağrıda metne dökülen araç çağrısı atılır', async () => {
  const { stripToolMarkup } = await import('../lib/loop.mjs');
  assert.equal(stripToolMarkup('Özet burada.\n<tool_call>\n<function=read_file>\n<parameter=path>\nx\n</parameter>\n</function>\n</tool_call>'), 'Özet burada.');
  assert.equal(stripToolMarkup('<tool_call><function=x>'), '');
});
