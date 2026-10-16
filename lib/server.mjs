#!/usr/bin/env node
// NVIDIA NIM modellerini (build.nvidia.com) Claude Code'a MCP araçları olarak açan, bağımlılıksız stdio sunucusu.
// Sadece geliştirme sırasında kullanılır; uygulama paketine girmez.
// MCP stdio: satır başına bir JSON-RPC 2.0 mesajı. stdout protokole ayrılmıştır, loglar stderr'e.

import { createInterface } from 'node:readline';

import {
  API_BASE,
  chat,
  DEFAULT_MAX_TOKENS,
  DEFAULT_PANEL,
  loadApiKey,
  MODEL_ALIASES,
  panel,
  resolveModel,
  timed,
  translate,
} from './nvidia.mjs';

const TOOLS = [
  {
    name: 'nvidia_ask',
    description:
      'Tek bir NVIDIA NIM modeline soru sorar. Kod incelemesi, ikinci görüş, Türkçe metin önerisi, test verisi üretimi gibi işler için. ' +
      `Model kısa adları: ${Object.entries(MODEL_ALIASES)
        .map(([a, id]) => `${a}=${id}`)
        .join(', ')}. Ajan CLI'ları: codex (gpt-5.5, güçlü reviewer), gemini (Antigravity, Gemini 3.1 Pro, yavaş, geniş bağlam), gemini-flash (hızlı); ` +
      'abonelik kotasıyla çalışır, yalnızca mimar paneli ve son inceleme için. Tam model id de verilebilir. Modeller yavaştır (10-120 sn).',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Soru; gerekli kod/bağlamı da içermeli (model repo dosyalarını göremez).' },
        model: { type: 'string', description: 'Kısa ad veya tam model id. Varsayılan: fast' },
        system: { type: 'string', description: 'İsteğe bağlı sistem mesajı.' },
        images: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Görsel dosya yolları (proje köküne göre; png/jpg/webp, ≤1 MB). Sadece görsel modellerle (vision, vision-alt, codex) kullan.',
        },
        max_tokens: { type: 'number', description: `Varsayılan ${DEFAULT_MAX_TOKENS}.` },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'nvidia_translate',
    description:
      'Metni NVIDIA Riva Translate (v2) ile çevirir; <1 sn. Arayüz metinleri ve hata mesajları için. Dil kodları: tr, en, de, fr, es, ar, ru.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Çevrilecek metin.' },
        from: { type: 'string', description: 'Kaynak dil kodu. Varsayılan: tr' },
        to: { type: 'string', description: 'Hedef dil kodu. Varsayılan: en' },
      },
      required: ['text'],
    },
  },
  {
    name: 'nvidia_panel',
    description:
      'Aynı soruyu birden fazla NVIDIA modeline paralel sorar ve tüm cevapları döner; karşılaştırıp sentezlemek sana kalır. ' +
      `Mimari kararlar, farklı yaklaşımları görmek, hata avı için. Varsayılan panel: ${DEFAULT_PANEL.join(', ')}. ` +
      'Başarısız modeller hata olarak listelenir, diğer cevaplar yine döner.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Soru; gerekli kod/bağlamı da içermeli.' },
        models: { type: 'array', items: { type: 'string' }, description: 'Kısa adlar veya model id listesi.' },
        system: { type: 'string', description: 'İsteğe bağlı sistem mesajı.' },
        max_tokens: { type: 'number', description: `Model başına. Varsayılan ${DEFAULT_MAX_TOKENS}.` },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'nvidia_models',
    description: 'Hesabın erişebildiği NVIDIA model id listesini ve kısa adları döner.',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function callTool(name, args) {
  switch (name) {
    case 'nvidia_ask': {
      const model = args.model ?? 'fast';
      const { value, seconds } = await timed(() =>
        chat({ model, prompt: args.prompt, system: args.system, images: args.images, maxTokens: args.max_tokens })
      );
      return `[${resolveModel(model)} · ${seconds} sn]\n\n${value}`;
    }
    case 'nvidia_translate':
      return translate({ text: args.text, from: args.from, to: args.to });
    case 'nvidia_panel': {
      const models = args.models?.length ? args.models : DEFAULT_PANEL;
      return panel({ prompt: args.prompt, models, system: args.system, maxTokens: args.max_tokens });
    }
    case 'nvidia_models': {
      const apiKey = loadApiKey();
      if (!apiKey) throw new Error('NVIDIA_API_KEY yok: ortam değişkeni ya da ~/.config/orkestra/env (bkz. orkestra doctor).');
      const response = await fetch(`${API_BASE}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const { data } = await response.json();
      const aliases = Object.entries(MODEL_ALIASES)
        .map(([a, id]) => `${a} = ${id}`)
        .join('\n');
      return `Kısa adlar:\n${aliases}\n\nTüm modeller (${data.length}):\n${data
        .map((m) => m.id)
        .sort()
        .join('\n')}`;
    }
    default:
      throw new Error(`Bilinmeyen araç: ${name}`);
  }
}

// --- JSON-RPC / MCP stdio ---

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);

async function handle(msg) {
  const { id, method, params } = msg;
  // id'siz mesajlar bildirimdir (ör. notifications/initialized); cevap verilmez.
  if (id === undefined) return;

  try {
    switch (method) {
      case 'initialize':
        return send({
          id,
          result: {
            protocolVersion: params?.protocolVersion ?? '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'orkestra', version: '0.2.0' },
          },
        });
      case 'ping':
        return send({ id, result: {} });
      case 'tools/list':
        return send({ id, result: { tools: TOOLS } });
      case 'tools/call':
        try {
          const text = await callTool(params.name, params.arguments ?? {});
          return send({ id, result: { content: [{ type: 'text', text }] } });
        } catch (e) {
          // Araç hataları protokol hatası değil; modele isError ile iletilir.
          return send({ id, result: { content: [{ type: 'text', text: String(e.message ?? e) }], isError: true } });
        }
      default:
        return send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  } catch (e) {
    send({ id, error: { code: -32603, message: String(e.message ?? e) } });
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return send({ id: null, error: { code: -32700, message: 'Parse error' } });
  }
  handle(msg);
});

process.stderr.write('orkestra MCP sunucusu hazır\n');
