// orkestra init: projeye <proje>/.claude/orkestra/ şablonlarını kurar. Var olan dosyaya dokunmaz.
// Kapı komutları projeden çıkarılıp config.json'a yazılır; kullanıcı düzeltir ve depoya ekler.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PROJECT_CONFIG_DIR, PROJECT_ROOT } from './config.mjs';
import { detectTiers } from './tiers.mjs';

const TEMPLATES = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates');
mkdirSync(PROJECT_CONFIG_DIR, { recursive: true });

const write = (name, make) => {
  const file = join(PROJECT_CONFIG_DIR, name);
  if (existsSync(file)) return process.stdout.write(`  · ${name} zaten var, dokunulmadı\n`);
  make(file);
  process.stdout.write(`  ✓ ${name}\n`);
};

process.stdout.write(`${PROJECT_CONFIG_DIR}\n`);
write('config.json', (file) => {
  const template = JSON.parse(readFileSync(join(TEMPLATES, 'config.json'), 'utf8'));
  // Projede ayardan bağımsız bulunan katmanlar şablona yazılır; tip denetimi yerel tsc ile kalır.
  for (const t of detectTiers(PROJECT_ROOT)) template.gate[t.key] = t.command ?? '';
  writeFileSync(file, `${JSON.stringify(template, null, 2)}\n`);
});
write('lenses.md', (file) => copyFileSync(join(TEMPLATES, 'lenses.md'), file));
write('checklist.md', (file) => copyFileSync(join(TEMPLATES, 'checklist.md'), file));
process.stdout.write('\nDüzenle, sonra depoya ekle. Yerel kayıtlar .orkestra/ altında kalır (kendi .gitignore\'u var).\n');
