// Ajan döngüsünün (loop.mjs) middleware'i: LangChain'in AgentMiddleware kancalarının (langchain/agents/middleware/types.py)
// sınıfsız karşılığı. Bir middleware düz bir nesnedir:
//
//   { name,
//     beforeAgent?(state, ctx), afterAgent?(state, ctx),          bir kez, başta ve sonda
//     beforeModel?(state, ctx) → { end: '<neden>' }?               her model çağrısından önce, liste sırasıyla
//     afterModel?(state, ctx, response) → { end }?                 her cevaptan sonra, TERS sırayla
//     wrapModelCall?(request, next) → response                     model çağrısını sarar; listedeki ilk en dışta
//     wrapToolCall?(request, next) → metin }                       her araç çağrısını sarar; ilk en dışta
//
// Model isteği: { messages, tools, toolChoice, state, ctx, final? }; cevap: { message, finishReason, usage }.
// Araç isteği: { call: { id, name, args, raw }, tool, ctx, state }. Araç sarmalayıcısı ToolError atarsa modele
// "Hata: …" olarak döner.

import { ToolError } from './tools.mjs';

const noop = async () => undefined;

export function compose(middleware = []) {
  const list = middleware.filter(Boolean);
  const hooks = (name) => list.filter((m) => typeof m[name] === 'function');
  const firstEnd = (ms, name) => async (...args) => {
    for (const m of ms) {
      const r = await m[name](...args);
      if (r?.end) return r;
    }
    return undefined;
  };
  const wrap = (name) => (fn) => hooks(name).reduceRight((next, m) => (request) => m[name](request, next), fn);
  const all = (ms, name) => (ms.length ? async (...args) => { for (const m of ms) await m[name](...args); } : noop);
  return {
    beforeAgent: all(hooks('beforeAgent'), 'beforeAgent'),
    afterAgent: all(hooks('afterAgent'), 'afterAgent'),
    beforeModel: firstEnd(hooks('beforeModel'), 'beforeModel'),
    afterModel: firstEnd(hooks('afterModel').reverse(), 'afterModel'),
    modelCall: wrap('wrapModelCall'),
    toolCall: wrap('wrapToolCall'),
  };
}

// Model ve araç çağrısı sınırı (ModelCallLimitMiddleware, ToolCallLimitMiddleware). LangChain'de varsayılan
// fiilen sınırsız; burada kota ve süre olduğu için varsayılan açık.
export function callLimit({ maxSteps = 25, maxToolCalls = 60 } = {}) {
  let used = 0;
  return {
    name: 'callLimit',
    beforeModel(state) {
      if (state.steps >= maxSteps) return { end: 'step_limit' };
      if (state.toolCalls >= maxToolCalls) return { end: 'tool_limit' };
      return undefined;
    },
    async wrapToolCall(request, next) {
      // Aynı turda sınırı aşan çağrılar koşmaz, modele bildirilir.
      if (used >= maxToolCalls) throw new ToolError(`Araç çağrı sınırı (${maxToolCalls}) doldu; bulduklarınla cevap yaz.`);
      used++;
      return next(request);
    },
  };
}

// Toplam süre ve token tavanı. Süre yumuşak sınırdır (yeni adım başlatılmaz); sert kesme agent-run'daki AbortSignal.
export function budget({ deadlineMs, maxTokens, now = Date.now } = {}) {
  return {
    name: 'budget',
    beforeModel(state) {
      if (deadlineMs && now() - state.started > deadlineMs) return { end: 'timeout' };
      if (maxTokens && state.usage.input + state.usage.output >= maxTokens) return { end: 'token_limit' };
      return undefined;
    },
  };
}

// Tek araç çıktısını baş ve sonu tutarak kırpar (ShellToolMiddleware'deki kırpma).
export function trimToolOutput({ maxChars = 8000 } = {}) {
  return {
    name: 'trimToolOutput',
    async wrapToolCall(request, next) {
      const out = await next(request);
      if (typeof out !== 'string' || out.length <= maxChars) return out;
      const head = Math.floor(maxChars * 0.6);
      const tail = maxChars - head;
      return `${out.slice(0, head)}\n… [${out.length - maxChars} karakter kırpıldı] …\n${out.slice(-tail)}`;
    },
  };
}

export const CLEARED = '[temizlendi: eski araç çıktısı; gerekirse aracı yeniden çağır]';

// Bağlam eşiği aşılınca eski araç çıktılarını siler, son `keep` tanesini tutar (ContextEditingMiddleware +
// ClearToolUsesEdit). Ek model çağrısı yok; asistan/araç eşleşmesi bozulmaz (yalnız içerik değişir).
export function clearOldToolResults({ triggerChars = 240_000, keep = 3 } = {}) {
  return {
    name: 'clearOldToolResults',
    async wrapModelCall(request, next) {
      const size = request.messages.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content ?? '').length), 0);
      if (size > triggerChars) {
        const toolIdx = request.messages.map((m, i) => (m.role === 'tool' ? i : -1)).filter((i) => i >= 0);
        for (const i of toolIdx.slice(0, Math.max(0, toolIdx.length - keep))) request.messages[i].content = CLEARED;
      }
      return next(request);
    },
  };
}

// Araç çıktısındaki anahtar benzeri dizgiler modele gitmez.
export const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:sk|rk)-[A-Za-z0-9_-]{20,}/g,
  /\bnvapi-[A-Za-z0-9_-]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
];
export function redact({ patterns = SECRET_PATTERNS } = {}) {
  return {
    name: 'redact',
    async wrapToolCall(request, next) {
      const out = await next(request);
      return typeof out === 'string' ? patterns.reduce((s, re) => s.replace(re, '[karartıldı]'), out) : out;
    },
  };
}

// Aynı araç aynı argümanla `repeat`. kez çağrılırsa koşmaz (zayıf modellerde sık görülen kısır döngü).
export function loopGuard({ repeat = 3 } = {}) {
  const seen = new Map();
  return {
    name: 'loopGuard',
    async wrapToolCall(request, next) {
      const key = `${request.call.name}\0${JSON.stringify(request.call.args)}`;
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      if (n >= repeat) throw new ToolError(`Aynı çağrıyı ${n}. kez yineliyorsun; sonucu yukarıda. Başka bir yol dene ya da cevabını yaz.`);
      return next(request);
    },
  };
}

const retryable = (e) => e?.status === 429 || (e?.status >= 500 && e?.status < 600) || e?.name === 'TypeError';

// 429 ve 5xx'te üstel geri çekilme ±%25 oynamayla (ModelRetryMiddleware, _retry.py). completion()'ın kendi
// tek denemesinin üstüne gelir; çok adımlı döngüde ücretsiz kotanın 429'ları sık.
export function rateLimitBackoff({ retries = 3, baseMs = 5000, sleepFn = (ms) => new Promise((r) => setTimeout(r, ms)), random = Math.random } = {}) {
  return {
    name: 'rateLimitBackoff',
    async wrapModelCall(request, next) {
      for (let attempt = 0; ; attempt++) {
        try {
          return await next(request);
        } catch (e) {
          if (attempt >= retries || !retryable(e) || request.ctx?.signal?.aborted) throw e;
          await sleepFn(baseMs * 2 ** attempt * (0.75 + random() * 0.5));
        }
      }
    },
  };
}

// Model hata verirse aynı istek sıradaki modelle denenir (ModelFallbackMiddleware). callers: [{ label, call }].
export function modelFallback(callers = [], { onSwitch = () => {} } = {}) {
  return {
    name: 'modelFallback',
    async wrapModelCall(request, next) {
      try {
        return await next(request);
      } catch (first) {
        if (request.ctx?.signal?.aborted || !callers.length) throw first;
        let last = first;
        for (const c of callers) {
          try {
            onSwitch(c.label, last);
            return await c.call({ messages: request.messages, tools: request.tools, toolChoice: request.toolChoice, signal: request.ctx?.signal });
          } catch (e) {
            last = e;
          }
        }
        throw last;
      }
    },
  };
}
