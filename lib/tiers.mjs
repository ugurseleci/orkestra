// Kapı katmanları: proje ayarından ya da projeden çıkarılır.
//
// Proje ayarı (<proje>/.claude/orkestra/config.json) her katmanı kabuk komutu olarak verebilir; boş metin katmanı kapatır:
//   { "gate": { "types": "npx tsc --noEmit", "lint": "npx expo lint", "unit": "npm test", "e2e": "npm run test:e2e" } }
// Ayar yoksa: tip denetimi yalnızca projede kurulu tsc varsa (npx yabancı paket indirmesin, onay beklemesin);
// lint, birim, entegrasyon ve uçtan uca package.json betiklerinden (lint, test, test:integration, test:e2e).
// Uçtan uca katman uzun sürebildiği için yalnızca --e2e ile koşar.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const TIER_DEFS = [
  { key: 'types', label: 'tip' },
  { key: 'lint', label: 'lint', script: 'lint' },
  { key: 'unit', label: 'birim', script: 'test' },
  { key: 'integration', label: 'entegrasyon', script: 'test:integration' },
  { key: 'e2e', label: 'uçtan uca', script: 'test:e2e', optIn: '--e2e' },
];

export function packageManager(root) {
  if (existsSync(join(root, 'bun.lock')) || existsSync(join(root, 'bun.lockb'))) return 'bun';
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

function scripts(root) {
  try {
    return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts ?? {};
  } catch {
    return {};
  }
}

// Her katman: { key, label, optIn?, command: string | null, source: 'ayar' | 'proje' | null }.
// command null ise katman "tanımlı değil".
export function detectTiers(root, gate = {}) {
  const pkgScripts = scripts(root);
  const pm = packageManager(root);
  const npmTest = pm === 'npm';
  return TIER_DEFS.map((tier) => {
    if (typeof gate[tier.key] === 'string') {
      return { ...tier, command: gate[tier.key].trim() || null, source: 'ayar' };
    }
    if (tier.key === 'types') {
      // Göreli yol: kapı proje kökünde koşar; ayara yazılınca başka makinede de geçerli, kabuğa yol girmez.
      const ok = existsSync(join(root, 'tsconfig.json')) && existsSync(join(root, 'node_modules', '.bin', 'tsc'));
      return { ...tier, command: ok ? 'node_modules/.bin/tsc --noEmit' : null, source: ok ? 'proje' : null };
    }
    if (!pkgScripts[tier.script]) return { ...tier, command: null, source: null };
    // npm, "test" betiğinde de --silent ile gereksiz başlık basmasın.
    const command = npmTest ? `npm run --silent ${tier.script}` : `${pm} run ${tier.script}`;
    return { ...tier, command, source: 'proje' };
  });
}
