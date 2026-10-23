// NVIDIA NIM (build.nvidia.com) istemci çekirdeği: MCP sunucusu ve CLI ortak kullanır.

import { readFileSync } from 'node:fs';
import { extname } from 'node:path';

import { agentChat, agentLabel, AGENT_ALIASES, isAgent } from './agents.mjs';
import { loadApiKey, PROJECT_ROOT, resolvePath, userConfig } from './config.mjs';
import { tracked } from './events.mjs';

export { loadApiKey, PROJECT_ROOT };
export const API_BASE = 'https://integrate.api.nvidia.com/v1';
export const DEFAULT_TIMEOUT_MS = 180_000;
export const DEFAULT_MAX_TOKENS = 4096;

// Kısa adlar → model id. Hız/kalite ölçümleri: 2026-10-23.
// Erişilemeyen (404): kimi-k2.6, nemotron-3-super, mistral-large-2, llama-3.1-nemotron-ultra-253b.
// kimi-k3 2026-10-15'te kaldırıldı.
export const MODEL_ALIASES = {
  fast: 'minimaxai/minimax-m3.1-flash', // ~1 sn; deepseek-v4.1-flash ~150 sn'ye çıktı
  code: 'z-ai/glm-5.3', // ~2 dk, kod ve mimari için güçlü ama yavaş
  step: 'stepfun-ai/step-5-preview', // ~13 sn, düşünen model
  lightning: 'nvidia/nemotron-3.5-lightning-30b-a3b', // ~4 sn, düşünen model
  super: 'nvidia/nemotron-3.5-super-vl-120b-a12b', // ~1 sn, görsel de okur
  ultra: 'nvidia/nemotron-3-ultra-550b-a55b', // ~2 sn
  // Görsel: super-vl ekran görüntüsündeki yazıları doğru okudu (~5 sn). 90b zaman aşımına
  // uğruyor. llama-3.2-11b-vision görseli uydurdu (Expo simgesine "Apple Pay logosu" dedi); kullanma.
  vision: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
  'vision-alt': 'google/gemma-4-31b-it', // ~40 sn
  // Çeviri: v2 <1 sn ve doğru. v1.1 anlamı uydurdu; kullanma. Prompt formatı özel, bkz. translate().
  translate: 'nvidia/riva-translate-4b-instruct-v2',
  // Kullanıcı kendi hesabına göre değiştirebilir: ~/.config/orkestra/config.json → "models".
  ...userConfig().models,
};
export const DEFAULT_PANEL = ['fast', 'ultra', 'super', 'step'];

// Ajan CLI'ları (codex, gemini) da aynı adlarla kullanılır; bkz. agents.mjs.
export const resolveModel = (m) => (isAgent(m) ? agentLabel(m) : (MODEL_ALIASES[m] ?? m));
export { AGENT_ALIASES };

const IMAGE_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
// Büyük base64 görseller isteği yavaşlatıyor; ekran görüntülerini önce küçült:
//   sips -s format jpeg -Z 1024 ekran.png --out ekran.jpg
const MAX_IMAGE_BYTES = 1_000_000;

function imagePart(path) {
  const mime = IMAGE_MIME[extname(path).toLowerCase()];
  if (!mime) throw new Error(`Desteklenmeyen görsel türü: ${path} (png, jpg, webp)`);
  const data = readFileSync(resolvePath(path));
  if (data.length > MAX_IMAGE_BYTES) {
    throw new Error(`Görsel çok büyük (${Math.round(data.length / 1024)} KB): önce küçült (sips -s format jpeg -Z 1024).`);
  }
  return { type: 'image_url', image_url: { url: `data:${mime};base64,${data.toString('base64')}` } };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// task: panoda görünen iş adı ("Reviewer paneli: via noktaları"); verilmezse ORKESTRA_TASK.
export function chat({ task = process.env.ORKESTRA_TASK, meta, ...options }) {
  return tracked({ model: options.model, label: resolveModel(options.model), task, meta }, () => chatModel(options));
}

async function chatModel({
  model,
  prompt,
  system,
  images = [],
  maxTokens = DEFAULT_MAX_TOKENS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (isAgent(model)) return agentChat({ model, prompt, system, images, timeoutMs, projectRoot: PROJECT_ROOT });

  const apiKey = loadApiKey();
  if (!apiKey) throw new Error('NVIDIA_API_KEY yok: ortam değişkeni ya da ~/.config/orkestra/env (bkz. orkestra doctor).');

  const userContent = images.length
    ? [{ type: 'text', text: prompt }, ...images.map(imagePart)]
    : prompt;
  const messages = system
    ? [
        { role: 'system', content: system },
        { role: 'user', content: userContent },
      ]
    : [{ role: 'user', content: userContent }];

  // 503 (aşırı yük) ve 429'da bir kez tekrar dene.
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`${API_BASE}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: resolveModel(model), messages, max_tokens: maxTokens }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if ((response.status === 503 || response.status === 429) && attempt === 0) {
      await sleep(3000);
      continue;
    }
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      throw new Error(`HTTP ${response.status}: ${detail}`);
    }

    const data = await response.json();
    const choice = data.choices?.[0];
    const content = choice?.message?.content?.trim();
    if (content) return content;
    // Akıl yürüten modeller token bitince sadece reasoning_content dönebiliyor.
    if (choice?.finish_reason === 'length') {
      throw new Error('Cevap yazılmadan token sınırına ulaşıldı; max_tokens değerini artır.');
    }
    throw new Error('Boş cevap döndü.');
  }
}

export async function timed(fn) {
  const start = Date.now();
  const value = await fn();
  return { value, seconds: ((Date.now() - start) / 1000).toFixed(1) };
}

// Aynı soruyu birden fazla modele paralel sorar; başarısız modeller hata olarak listelenir.
export async function panel({ prompt, models = DEFAULT_PANEL, system, maxTokens, timeoutMs, task, meta }) {
  const results = await Promise.allSettled(
    models.map((model) => timed(() => chat({ model, prompt, system, maxTokens, timeoutMs, task, meta })))
  );
  return results
    .map((r, i) => {
      const header = `### ${resolveModel(models[i])}`;
      return r.status === 'fulfilled'
        ? `${header} (${r.value.seconds} sn)\n\n${r.value.value}`
        : `${header} — HATA\n\n${r.reason?.message ?? r.reason}`;
    })
    .join('\n\n---\n\n');
}

const LANGUAGE_NAMES = { tr: 'Turkish', en: 'English', de: 'German', fr: 'French', es: 'Spanish', ar: 'Arabic', ru: 'Russian' };

// Riva Translate, kendi eğitim formatındaki prompt'la doğru çalışıyor.
export function translate({ text, from = 'tr', to = 'en', timeoutMs }) {
  const source = LANGUAGE_NAMES[from] ?? from;
  const target = LANGUAGE_NAMES[to] ?? to;
  return chat({
    model: 'translate',
    system: `You are an expert at translating text from ${source} to ${target}.`,
    prompt: `What is the ${target} translation of: ${text}`,
    maxTokens: 1024,
    timeoutMs,
  });
}
