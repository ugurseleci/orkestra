// Orkestra olay kaydı: kim hangi işi yapıyor. Pano (dashboard.mjs) bu dosyayı canlı izler.
//
// Her satır bir JSON olay: { id, ts, type: 'start' | 'end' | 'note', actor, model?, task?, ok?, seconds?, text? }.
// Hat (pipeline) alanları, hepsi isteğe bağlı: job (iş kimliği), stage (design | build | integrate | review | merge),
// role (architect, critic, implementer, tester, katman ya da mercek adı, fix, pr), round, pkg, verdict
// (approved | sent_back; yalnızca açık karar olayında), reason. Ek olay türleri: 'job' (iş açıldı/kapandı),
// 'lens' (bir merceğin sonucu), 'gate' (kapının toplam sonucu ve koştuğu revizyon).
// Depoda çalışan ajan çağrısı: start'ta agent: true, skills: [ad…], write: true|false; end'de usage
// ({ input, cached, output } token) ve files (yamadaki dosyalar).
// Yalnızca yerelde tutulur (<proje>/.orkestra/ kendi .gitignore'uyla git'e girmez); prompt kaydedilmez, cevabın başı kaydedilir.

import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

import { ensureStateDir, STATE_DIR } from './config.mjs';

// ORKESTRA_EVENTS: panoyu sahte olaylarla denemek için başka bir kayıt dosyası.
export const EVENTS_FILE = process.env.ORKESTRA_EVENTS || join(STATE_DIR, 'events.jsonl');
const JOB_FILE = join(dirname(EVENTS_FILE), 'current-job.json');
const MAX_TEXT = 4000;

// Açık iş: etkileşimli kullanımda her çağrıya --job yazmamak için. Aynı anda tek iş açık olur.
export function currentJob() {
  try {
    return JSON.parse(readFileSync(JOB_FILE, 'utf8'));
  } catch {
    return null;
  }
}

const ensureDir = () => (process.env.ORKESTRA_EVENTS ? mkdirSync(dirname(EVENTS_FILE), { recursive: true }) : ensureStateDir());

export function setCurrentJob(job) {
  ensureDir();
  if (job) writeFileSync(JOB_FILE, JSON.stringify(job));
  else rmSync(JOB_FILE, { force: true });
}

export function logEvent(event) {
  try {
    ensureDir();
    const text = event.text && event.text.length > MAX_TEXT ? `${event.text.slice(0, MAX_TEXT)}…` : event.text;
    // Aşaması olan olay, iş verilmediyse açık işe yazılır.
    const job = event.job ?? (event.stage ? currentJob()?.job : undefined);
    appendFileSync(EVENTS_FILE, `${JSON.stringify({ ts: Date.now(), ...event, job, text })}\n`);
  } catch {
    // Kayıt yazılamazsa orkestra yine çalışır.
  }
}

// Model adından şerit: claude, codex, gemini ya da nvidia.
export function actorOf(model) {
  if (model.startsWith('codex')) return 'codex';
  if (model.startsWith('gemini')) return 'gemini';
  return 'nvidia';
}

// Bir model çağrısını başlangıç ve bitiş olaylarıyla sarar.
// meta: hat alanları (stage, role, round, pkg, lenses). fn düz metin ya da { text, usage, … } döndürebilir:
// usage ({ input, cached, output } token) kayda yazılır, pano model başına toplar.
export async function tracked({ model, label, task, meta }, fn) {
  const id = randomUUID();
  const started = Date.now();
  logEvent({ id, type: 'start', actor: actorOf(model), model: label, task, ...meta });
  try {
    const value = await fn();
    const text = typeof value === 'string' ? value : value?.text;
    const usage = typeof value === 'string' ? undefined : (value?.usage ?? undefined);
    // files: ajanın yamasındaki dosyalar (yazma kipinde).
    const files = typeof value === 'string' ? undefined : (value?.files ?? undefined);
    logEvent({ id, type: 'end', ok: true, seconds: (Date.now() - started) / 1000, text, usage, files });
    return value;
  } catch (e) {
    logEvent({ id, type: 'end', ok: false, seconds: (Date.now() - started) / 1000, text: String(e?.message ?? e) });
    throw e;
  }
}
