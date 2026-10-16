import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { defaultAskModel, defaultReviewers, modelAvailable } from '../lib/config.mjs';
import { detectTiers, packageManager } from '../lib/tiers.mjs';

const none = { codex: false, agy: false, nvidia: false, sandbox: false };

test('varsayılan inceleyiciler kurulu sağlayıcılardan seçilir', () => {
  assert.deepEqual(defaultReviewers({ ...none, codex: true, agy: true, nvidia: true }), ['codex', 'gemini-flash']);
  assert.deepEqual(defaultReviewers({ ...none, agy: true }), ['gemini-flash']);
  assert.deepEqual(defaultReviewers({ ...none, nvidia: true }), ['code', 'fast']);
  assert.deepEqual(defaultReviewers({ ...none, codex: true, nvidia: true }), ['codex', 'code']);
  assert.deepEqual(defaultReviewers(none), []);
});

test('tek soru önce hızlı modele gider, yoksa kurulu ajana', () => {
  assert.equal(defaultAskModel({ ...none, nvidia: true, codex: true }), 'fast');
  assert.equal(defaultAskModel({ ...none, codex: true }), 'codex');
  assert.equal(defaultAskModel(none), null);
});

test('model sağlayıcısına göre eşlenir; açık model adı da', () => {
  assert.equal(modelAvailable('codex:gpt-5.5', { ...none, codex: true }), true);
  assert.equal(modelAvailable('gemini', { ...none, codex: true }), false);
  assert.equal(modelAvailable('z-ai/glm-5.3', { ...none, nvidia: true }), true);
});

function project(files) {
  const dir = mkdtempSync(join(tmpdir(), 'orkestra-test-'));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}
const byKey = (tiers) => Object.fromEntries(tiers.map((t) => [t.key, t.command]));

test('kapı katmanları package.json betiklerinden ve yerel tsc\'den çıkarılır', () => {
  const dir = project({
    'package.json': JSON.stringify({ scripts: { lint: 'eslint .', test: 'jest', 'test:e2e': 'maestro test' } }),
    'tsconfig.json': '{}',
    'node_modules/.bin/tsc': '',
  });
  try {
    const tiers = byKey(detectTiers(dir));
    assert.equal(tiers.types, 'node_modules/.bin/tsc --noEmit');
    assert.equal(tiers.lint, 'npm run --silent lint');
    assert.equal(tiers.unit, 'npm run --silent test');
    assert.equal(tiers.integration, null);
    assert.equal(tiers.e2e, 'npm run --silent test:e2e');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tsc kurulu değilse tip katmanı npx ile indirilmez, tanımsız kalır', () => {
  const dir = project({ 'tsconfig.json': '{}', 'package.json': '{}' });
  try {
    assert.equal(byKey(detectTiers(dir)).types, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ayar komutu önceliklidir, boş metin katmanı kapatır; paket yöneticisi kilit dosyasından', () => {
  const dir = project({ 'package.json': JSON.stringify({ scripts: { lint: 'eslint .', test: 'vitest' } }), 'bun.lock': '' });
  try {
    assert.equal(packageManager(dir), 'bun');
    const tiers = byKey(detectTiers(dir, { lint: 'npx expo lint', unit: '' }));
    assert.equal(tiers.lint, 'npx expo lint');
    assert.equal(tiers.unit, null);
    assert.equal(byKey(detectTiers(dir)).unit, 'bun run test');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('proje kökü alt klasörden de git köküdür', () => {
  const dir = project({ 'pkg/a/x.txt': '' });
  try {
    const r = spawnSync('git', ['init', '-q'], { cwd: dir });
    assert.equal(r.status, 0);
    const out = spawnSync(process.execPath, ['-e', "import('" + new URL('../lib/config.mjs', import.meta.url).href + "').then((m) => process.stdout.write(m.PROJECT_ROOT))"], {
      cwd: tmpdir(),
      env: { ...process.env, ORKESTRA_PROJECT_DIR: join(dir, 'pkg', 'a') },
      encoding: 'utf8',
    });
    assert.equal(out.stdout, realpathSync(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
