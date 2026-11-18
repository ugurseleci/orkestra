// Araç çağıran ajan döngüsü: LangChain'in create_agent'ının (langchain/agents/factory.py) bağımlılıksız karşılığı.
//
//   model → araç çağrısı var mı? → evet: araçları çalıştır, sonuçları ekle, modele dön
//                                → hayır: son metin cevaptır, bitir          (factory.py: "klasik çıkış koşulu")
//
// LangGraph grafiği yerine düz bir döngü. Middleware kancaları (middleware.mjs): beforeAgent, beforeModel,
// wrapModelCall, afterModel (ters sırayla), wrapToolCall, afterAgent. Kanca { end: '<neden>' } dönerse döngü
// biter (LangChain'deki jump_to: "end").
//
// Döngü ne nvidia.mjs'i ne config.mjs'i bilir: model çağrısı (callModel) dışarıdan verilir; ağsız test edilir.
// Sınıra takılınca istisna atılmaz: model araçsız son bir kez çağrılıp bulduklarını yazması istenir.

import { compose, SECRET_PATTERNS } from './middleware.mjs';
import { ToolError, toolSpecs, validateArgs } from './tools.mjs';

const FINAL_NOTE =
  'Sınıra ulaşıldı; artık araç kullanamazsın. Buraya kadar bulduklarını ve yaptıklarını, eksik kalanları belirterek yaz.';

// Modelin araç çağrılarını ayrıştırır. arguments metin (OpenAI), nesne (bazı sağlayıcılar) ya da boş olabilir.
// Bozuk JSON çağrıyı düşürmez: hata olarak işaretlenir ve modele araç mesajıyla bildirilir (factory.py:679-710).
export function parseToolCalls(message, step) {
  return (message.tool_calls ?? []).map((call, i) => {
    const id = call.id || `call_${step}_${i}`;
    const name = call.function?.name ?? call.name ?? '';
    const raw = call.function?.arguments ?? call.arguments ?? call.args;
    let args = {};
    let error = null;
    if (raw && typeof raw === 'object') args = raw;
    else if (typeof raw === 'string' && raw.trim()) {
      try {
        args = JSON.parse(raw);
      } catch {
        error = `Argümanlar geçerli JSON değil (kesilmiş olabilir): ${raw.slice(0, 200)}`;
      }
    }
    if (!error && (args === null || typeof args !== 'object' || Array.isArray(args))) error = 'Argümanlar bir JSON nesnesi olmalı.';
    return { id, name, args, error, raw: typeof raw === 'string' ? raw : JSON.stringify(args ?? {}) };
  });
}

// Geri gönderilecek asistan mesajı: yalnız role, content, tool_calls (reasoning_content gibi ek alanlar atılır);
// eksik id'ler doldurulur ki araç mesajları eşleşsin.
const assistantMessage = (message, calls) => ({
  role: 'assistant',
  content: typeof message.content === 'string' ? message.content : (message.content ?? null),
  ...(calls.length
    ? { tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.raw || '{}' } })) }
    : {}),
});

const addUsage = (total, u) => {
  if (!u) return;
  total.input += u.input ?? 0;
  total.cached += u.cached ?? 0;
  total.output += u.output ?? 0;
};

// Metne dökülmüş araç çağrısı biçimleri (<tool_call>…</tool_call>, <function=…>…</function>).
export const stripToolMarkup = (text) =>
  text.replace(/<tool_call>[\s\S]*?(<\/tool_call>|$)/g, '').replace(/<function=[\s\S]*?(<\/function>|$)/g, '').trim();

const scrub = (text) => SECRET_PATTERNS.reduce((s, re) => s.replace(re, '[karartıldı]'), text);

const textOf = (message) => (typeof message?.content === 'string' ? message.content.trim() : '');

export async function runAgent({ callModel, system, prompt, tools = [], middleware = [], ctx = {}, onEvent = () => {}, signal }) {
  const mw = compose(middleware);
  const byName = new Map(tools.map((t) => [t.name, t]));
  const specs = toolSpecs(tools);
  const state = {
    messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: prompt }],
    steps: 0,
    toolCalls: 0,
    usage: { input: 0, cached: 0, output: 0 },
    started: Date.now(),
    stop: null,
    answer: '',
  };
  const emit = (event) => {
    try {
      onEvent(event);
    } catch {
      // Olay yazılamazsa döngü sürer.
    }
  };

  // Tek model çağrısı: middleware zinciri + süre ve kullanım kaydı.
  const modelCall = mw.modelCall(async (request) => callModel({ ...request, signal: ctx.signal ?? signal }));
  const askModel = async (request) => {
    const started = Date.now();
    try {
      const response = await modelCall({ ...request, state, ctx });
      addUsage(state.usage, response.usage);
      emit({ kind: 'model', n: state.steps + 1, ok: true, seconds: (Date.now() - started) / 1000, usage: response.usage ?? undefined, calls: response.message?.tool_calls?.length ?? 0 });
      return response;
    } catch (e) {
      emit({ kind: 'model', n: state.steps + 1, ok: false, seconds: (Date.now() - started) / 1000, error: String(e?.message ?? e).slice(0, 300) });
      throw e;
    }
  };

  const toolCall = mw.toolCall(async ({ call, tool }) => {
    if (call.error) throw new ToolError(call.error);
    if (!tool) throw new ToolError(`Bilinmeyen araç: ${call.name}. Kullanılabilenler: ${[...byName.keys()].join(', ') || 'yok'}`);
    const invalid = validateArgs(tool.parameters, call.args);
    if (invalid) throw new ToolError(`Geçersiz argüman: ${invalid}`);
    const out = await tool.run(call.args, ctx);
    return typeof out === 'string' ? out : JSON.stringify(out);
  });

  const runTool = async (call) => {
    const started = Date.now();
    const tool = byName.get(call.name);
    let content;
    let ok = true;
    try {
      content = await toolCall({ call, tool, ctx, state });
    } catch (e) {
      // Araç hatası modele gözlem olarak döner (LangChain ToolMessage status="error"); yığın izi gitmez.
      ok = false;
      content = `Hata: ${e instanceof ToolError ? e.message : `beklenmeyen hata: ${e?.message ?? e}`}`;
    }
    // Hata metni de (bozuk argümanın yankısı) karartılır; özet kayda girmeden karartılır.
    content = scrub(content);
    emit({ kind: 'tool', n: state.steps, tool: call.name, summary: scrub(summarize(call)), ok, seconds: (Date.now() - started) / 1000, chars: content.length });
    return { role: 'tool', tool_call_id: call.id, content };
  };

  await mw.beforeAgent(state, ctx);
  try {
    for (;;) {
      if (signal?.aborted) {
        state.stop = 'aborted';
        break;
      }
      const early = await mw.beforeModel(state, ctx);
      if (early?.end) {
        state.stop = early.end;
        break;
      }
      let response;
      try {
        response = await askModel({ messages: state.messages, tools: specs, toolChoice: specs.length ? 'auto' : undefined });
      } catch (e) {
        // İlk çağrı düşerse (anahtar, model yok) hata yukarı gider. Sonrakilerde yapılan iş kaybolmasın: döngü
        // durur, yazma kipinde yama yine alınır.
        if (state.steps === 0 && !signal?.aborted) throw e;
        // Sert süre sınırı (AbortSignal) 'aborted'; yumuşak sınır (budget) 'timeout' olur ve son çağrı yapılır.
        state.stop = signal?.aborted ? 'aborted' : 'model_error';
        state.error = String(e?.message ?? e).slice(0, 300);
        break;
      }
      state.steps++;
      const message = response.message ?? { role: 'assistant', content: '' };
      const calls = parseToolCalls(message, state.steps);
      state.messages.push(assistantMessage(message, calls));
      const late = await mw.afterModel(state, ctx, response);
      if (!calls.length) {
        state.answer = textOf(message);
        state.stop = response.finishReason === 'length' && !state.answer ? 'token_limit' : 'done';
        break;
      }
      // Okuma araçları koşut, yazan ve komut çalıştıranlar sırayla (LangChain her çağrıya ayrı Send açar).
      const results = new Array(calls.length);
      const parallel = calls.every((c) => (byName.get(c.name)?.risk ?? 'read') === 'read');
      if (parallel) (await Promise.all(calls.map(runTool))).forEach((r, i) => (results[i] = r));
      else for (let i = 0; i < calls.length; i++) results[i] = await runTool(calls[i]);
      state.messages.push(...results);
      state.toolCalls += calls.length;
      if (late?.end) {
        state.stop = late.end;
        break;
      }
    }

    // Sınıra takıldıysa: araçsız son çağrı, yarım iş de okunabilir bir cevapla döner.
    if (!['done', 'aborted', 'model_error'].includes(state.stop) && !state.answer) {
      state.messages.push({ role: 'user', content: FINAL_NOTE });
      try {
        // Araç tanımı gönderilmez: tool_choice 'none' ile bazı modeller (ultra, 18 Kasım 2026) çağrıyı düz metin olarak
        // yazıyordu. Metinde araç çağrısı biçimi kalırsa atılır.
        const response = await askModel({ messages: state.messages, tools: [], final: true });
        state.steps++;
        state.answer = stripToolMarkup(textOf(response.message));
        state.messages.push(assistantMessage(response.message ?? {}, []));
      } catch (e) {
        state.answer = '';
        emit({ kind: 'final', ok: false, error: String(e?.message ?? e).slice(0, 300) });
      }
      if (!state.answer) {
        state.answer = [...state.messages].reverse().filter((m) => m.role === 'assistant').map(textOf).find(Boolean) ?? '';
      }
    }
    if (['model_error', 'aborted'].includes(state.stop)) {
      const last = [...state.messages].reverse().filter((m) => m.role === 'assistant').map(textOf).find(Boolean) ?? '';
      state.answer = [last, state.error && `(Döngü model hatasıyla durdu: ${state.error})`].filter(Boolean).join('\n\n');
    }
  } finally {
    await mw.afterAgent(state, ctx);
  }

  return {
    answer: state.answer,
    stop: state.stop,
    steps: state.steps,
    toolCalls: state.toolCalls,
    usage: state.usage,
    messages: state.messages,
  };
}

// Panoya yazılacak kısa özet: yol, desen ya da komutun başı. İçerik ve çıktı kayda girmez.
export function summarize(call) {
  const a = call.args ?? {};
  const parts = [a.path, a.pattern && `/${a.pattern}/`, a.glob, a.command, a.offset && `${a.offset}+`].filter(Boolean);
  return String(parts.join(' ') || call.name).slice(0, 200);
}
