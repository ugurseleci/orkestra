#!/usr/bin/env node
// Bütünleştirme kapısı: bütün test katmanlarını sırayla koşar ve her birini panoya yazar.
//
//   orkestra gate            tip, lint, birim, entegrasyon (tanımlı olanlar)
//   orkestra gate --e2e      uçtan uca katmanıyla
//
// Katmanlar proje ayarından ya da projeden çıkarılır (bkz. tiers.mjs). Tanımlı olmayan katman atlanır.
// Sonuç koştuğu revizyonla (HEAD + çalışma ağacındaki değişiklikler) kaydedilir: kod değişirse yeşil geçersizdir.
// Çıkış kodu: hepsi geçtiyse 0.

import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';

import { PROJECT_ROOT, projectConfig } from './config.mjs';
import { currentJob, logEvent } from './events.mjs';
import { killTree } from './proc.mjs';
import { detectTiers } from './tiers.mjs';

const TIERS = detectTiers(PROJECT_ROOT, projectConfig().gate);
const TAIL_CHARS = 3000;
// Takılan katman (ör. girdi bekleyen komut) kapıyı sonsuza kadar tutmasın.
const TIER_TIMEOUT_MS = 15 * 60 * 1000;

// HEAD + çalışma ağacındaki değişiklikler + izlenmeyen dosyaların içeriği.
function revision() {
  const git = (args, input) => spawnSync('git', args, { cwd: PROJECT_ROOT, encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 }).stdout ?? '';
  const head = git(['rev-parse', '--short', 'HEAD']).trim();
  const untracked = git(['ls-files', '--others', '--exclude-standard']);
  const dirty = git(['status', '--porcelain']) + git(['diff', 'HEAD']) + (untracked ? git(['hash-object', '--stdin-paths'], untracked) : '');
  return dirty ? `${head}+${createHash('sha1').update(dirty).digest('hex').slice(0, 8)}` : head;
}

function run(command) {
  return new Promise((done) => {
    // Ayardaki komut kabuk komutudur (ör. "npx expo lint"); stdin kapalı: girdi bekleyen komut takılmaz.
    // POSIX'te kendi süreç grubunda: zaman aşımında kabukla birlikte başlattığı süreçler de durur. Windows'ta detached
    // yeni konsol penceresi açar; orada süreç ağacını taskkill durdurur. Kabuk: POSIX'te sh, Windows'ta cmd.exe.
    const posix = process.platform !== 'win32';
    const child = spawn(command, { cwd: PROJECT_ROOT, shell: true, detached: posix, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1' } });
    let output = '';
    const collect = (chunk) => {
      output += chunk;
      process.stdout.write(chunk);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => {
      output += '\nZaman aşımı: katman durduruldu.';
      killTree(child, { group: posix });
    }, TIER_TIMEOUT_MS);
    child.on('error', (e) => done({ ok: false, output: String(e.message) }));
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ ok: code === 0, output });
    });
  });
}

const rev = revision();
// İş başta sabitlenir: kapı koşarken açık iş değişse de sonuç doğru işe yazılır.
const job = currentJob()?.job;
let allOk = true;
let ran = 0;
for (const tier of TIERS) {
  const wanted = !tier.optIn || process.argv.includes(tier.optIn);
  const command = wanted ? tier.command : null;
  const base = { actor: 'gate', job, stage: 'integrate', role: tier.key, task: `Kapı: ${tier.label}` };
  if (!command) {
    logEvent({ ...base, type: 'note', status: 'skipped' });
    process.stdout.write(`\n— ${tier.label}: ${tier.command ? `atlandı (${tier.optIn} ile koşar)` : 'tanımlı değil'}\n`);
    continue;
  }
  ran++;
  process.stdout.write(`\n— ${tier.label}: ${command}\n`);
  const id = randomUUID();
  const started = Date.now();
  logEvent({ ...base, id, type: 'start', model: command });
  const { ok, output } = await run(command);
  logEvent({ id, type: 'end', ok, seconds: (Date.now() - started) / 1000, text: output.trim().slice(-TAIL_CHARS) });
  allOk &&= ok;
}

// Hiç katman koşmadıysa kapı yeşil sayılmaz.
if (!ran) {
  allOk = false;
  process.stdout.write('\nHiç katman tanımlı değil: .claude/orkestra/config.json → "gate" ile komutları yaz (orkestra init şablon kurar).\n');
}

// Katmanlar koşarken kod değiştiyse sonuç hiçbir revizyona ait değildir.
if (allOk && revision() !== rev) {
  allOk = false;
  process.stdout.write('\nKapı koşarken kod değişti: sonuç geçersiz, yeniden koş.\n');
}
logEvent({ type: 'gate', actor: 'gate', job, stage: 'integrate', ok: allOk, rev });
process.stdout.write(`\nKapı ${allOk ? 'YEŞİL' : 'KIRMIZI'} · revizyon ${rev}\n`);
process.exit(allOk ? 0 : 1);
