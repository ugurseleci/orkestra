// orkestra doctor [--live]: hangi sağlayıcının kurulu olduğunu, proje ayarını ve kapı katmanlarını gösterir.
// --live her kurulu sağlayıcıya kısa bir soru sorar (giriş gerçekten çalışıyor mu); az da olsa kota harcar.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { AGENT_ALIASES, agentLabel } from './agents.mjs';
import { defaultAskModel, defaultReviewers, PROJECT_CONFIG_DIR, PROJECT_ROOT, projectConfig, providers, USER_DIR } from './config.mjs';
import { chat, resolveModel, timed } from './nvidia.mjs';
import { detectTiers } from './tiers.mjs';

const live = process.argv.includes('--live');
const p = providers();
const out = (line = '') => process.stdout.write(`${line}\n`);
const mark = (ok) => (ok ? '✓' : '·');

out(`Proje: ${PROJECT_ROOT}`);
out();
out('Sağlayıcılar (her biri isteğe bağlı; kendi hesabınla):');

let codexLogin = null;
if (p.codex) {
  const r = spawnSync('codex', ['login', 'status'], { encoding: 'utf8' });
  codexLogin = r.status === 0 ? (r.stdout || r.stderr).trim().split('\n')[0] : 'giriş yok';
}
out(`  ${mark(p.codex)} Codex CLI      ${p.codex ? `${codexLogin} · model: ${AGENT_ALIASES.codex.model ?? 'hesabın varsayılanı'}` : 'kurulu değil → npm i -g @openai/codex, sonra: codex login'}`);
out(`  ${mark(p.agy)} Antigravity    ${p.agy ? `agy kurulu · ${agentLabel('gemini-flash')}, ${agentLabel('gemini')}` : 'kurulu değil → Antigravity uygulamasından agy CLI, kendi Google hesabınla giriş'}`);
out(`  ${mark(p.nvidia)} NVIDIA NIM     ${p.nvidia ? 'anahtar bulundu' : `anahtar yok → build.nvidia.com'dan ücretsiz anahtar al, ${join(USER_DIR, 'env')} dosyasına NVIDIA_API_KEY=… yaz`}`);
out(`  ${mark(p.sandbox)} Depoda ajan    ${p.sandbox ? 'macOS sandbox-exec var' : 'yalnızca macOS; bu sistemde ask/panel/review çalışır, agent çalışmaz'}`);
out();
const reviewers = defaultReviewers(p);
out(`Varsayılanlar: soru → ${defaultAskModel(p) ?? 'yok'} · eleştirmen/inceleme → ${reviewers.join(', ') || 'yok (Claude tek başına)'}`);
out();

const config = projectConfig();
out(`Proje ayarı (${PROJECT_CONFIG_DIR}): ${existsSync(PROJECT_CONFIG_DIR) ? '' : 'yok → orkestra init'}`);
if (existsSync(PROJECT_CONFIG_DIR)) {
  for (const f of ['config.json', 'lenses.md', 'checklist.md']) out(`  ${mark(existsSync(join(PROJECT_CONFIG_DIR, f)))} ${f}`);
  if (config.reviewer) out(`  inceleyici rolü: ${config.reviewer}`);
}
out();
out('Kapı katmanları:');
for (const t of detectTiers(PROJECT_ROOT, config.gate)) {
  out(`  ${mark(Boolean(t.command))} ${t.label.padEnd(12)} ${t.command ? `${t.command}${t.source === 'ayar' ? '  (ayar)' : ''}${t.optIn ? `  (${t.optIn} ile)` : ''}` : 'tanımlı değil'}`);
}

if (live) {
  out();
  out('Canlı deneme:');
  const models = [p.codex && 'codex', p.agy && 'gemini-flash', p.nvidia && 'fast'].filter(Boolean);
  const results = await Promise.allSettled(
    models.map((model) => timed(() => chat({ model, prompt: 'Yalnızca "tamam" yaz.', maxTokens: 50, timeoutMs: 120_000, task: 'doctor' })))
  );
  results.forEach((r, i) => {
    const label = resolveModel(models[i]);
    out(r.status === 'fulfilled' ? `  ✓ ${label} (${r.value.seconds} sn)` : `  ✗ ${label}: ${String(r.reason?.message ?? r.reason).split('\n')[0]}`);
  });
  if (!models.length) out('  denenecek sağlayıcı yok');
}
