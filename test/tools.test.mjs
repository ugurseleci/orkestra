import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { builtinTools, readChecked, resolveInside, TOOL_SETS, validateArgs, writeChecked } from '../lib/tools.mjs';
import { excludedMatcher, globToRegExp } from '../lib/workspace.mjs';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'orkestra-tools-')));
after(() => rmSync(base, { recursive: true, force: true }));

const dir = join(base, 'kopya');
const outside = join(base, 'dis');
mkdirSync(join(dir, 'src'), { recursive: true });
mkdirSync(outside);
writeFileSync(join(outside, 'gizli.txt'), 'DIŞARIDA');
writeFileSync(join(dir, 'src', 'a.mjs'), Array.from({ length: 1000 }, (_, i) => `satır ${i + 1}`).join('\n'));
writeFileSync(join(dir, 'src', 'b.mjs'), 'export const tracked = 1;\n');
writeFileSync(join(dir, '.env.local'), 'NVIDIA_API_KEY=x');
writeFileSync(join(dir, 'ikili.bin'), Buffer.from([1, 0, 2]));
writeFileSync(join(dir, 'sirlar.yaml'), 'x');
symlinkSync(outside, join(dir, 'kacis'));
symlinkSync(join(outside, 'gizli.txt'), join(dir, 'kacis.txt'));

const ctx = (extra = {}) => ({ dir, readRoots: [], isExcluded: excludedMatcher(['sirlar.yaml']), ...extra });
const tool = (name) => Object.values(TOOL_SETS).flat().find((t) => t.name === name);
const run = (name, args, c = ctx()) => tool(name).run(args, c);

test('yol denetimi: dışarı çıkan, gizli ve dışlanan yollar reddedilir', () => {
  for (const p of ['../dis/gizli.txt', join(outside, 'gizli.txt'), 'kacis/gizli.txt', 'kacis.txt', '.env.local', 'sirlar.yaml', '.git/config']) {
    assert.throws(() => resolveInside(ctx(), p), /dışında|dışına|gizli|\.git/, p);
  }
  assert.equal(resolveInside(ctx(), 'src/a.mjs'), join(dir, 'src', 'a.mjs'));
  assert.equal(resolveInside(ctx(), join(dir, 'src', 'a.mjs')), join(dir, 'src', 'a.mjs'));
  assert.throws(() => resolveInside(ctx(), 'yok.txt'), /Dosya yok/);
  assert.equal(resolveInside(ctx(), 'yeni/klasor/x.txt', { forWrite: true }), join(dir, 'yeni', 'klasor', 'x.txt'));
  assert.throws(() => resolveInside(ctx(), 'kacis/yeni.txt', { forWrite: true }), /dışına/);
  assert.throws(() => resolveInside(ctx(), 'node_modules/x.js', { forWrite: true }), /node_modules/);
});

test('okuma kökü: node_modules bağı yalnız okumada geçer', () => {
  const nm = join(base, 'nm');
  mkdirSync(join(nm, 'paket'), { recursive: true });
  writeFileSync(join(nm, 'paket', 'i.js'), 'ok');
  symlinkSync(nm, join(dir, 'node_modules'));
  try {
    assert.equal(resolveInside(ctx({ readRoots: [nm] }), 'node_modules/paket/i.js'), join(nm, 'paket', 'i.js'));
    assert.throws(() => resolveInside(ctx(), 'node_modules/paket/i.js'), /dışına/);
  } finally {
    unlinkSync(join(dir, 'node_modules'));
  }
});

test('read_file sayfalar, ikili dosyayı reddeder', () => {
  const out = run('read_file', { path: 'src/a.mjs', offset: 10, limit: 3 });
  assert.match(out, /^ {3}10\tsatır 10\n {3}11\tsatır 11\n {3}12\tsatır 12\n… \(1000 satırın 10-12 arası; devamı için offset: 13\)$/);
  assert.equal(run('read_file', { path: 'src/a.mjs' }).split('\n').length, 401);
  assert.throws(() => run('read_file', { path: 'ikili.bin' }), /İkili/);
});

test('list_files ve search gizli, dışlanan ve bağlı dosyaları göstermez', () => {
  const list = run('list_files', {}).split('\n');
  assert.deepEqual(list.sort(), ['ikili.bin', 'src/a.mjs', 'src/b.mjs']);
  assert.equal(run('list_files', { glob: '*.mjs' }).split('\n').length, 2);
  assert.equal(run('search', { pattern: 'tracked' }), 'src/b.mjs:1: export const tracked = 1;');
  assert.equal(run('search', { pattern: 'NVIDIA' }), 'Eşleşme yok.');
  assert.equal(run('search', { pattern: 'DIŞARIDA' }), 'Eşleşme yok.');
  assert.match(run('search', { pattern: 'satır' }), /ilk 200 eşleşme/);
  assert.throws(() => run('search', { pattern: '(' }), /Geçersiz düzenli ifade/);
});

test('edit_file tek eşleşme ister; write_file kopyaya yazar', () => {
  writeFileSync(join(dir, 'd.txt'), 'x = 1\nx = 1\n');
  assert.throws(() => run('edit_file', { path: 'd.txt', old: 'x = 1', new: 'x = 2' }), /2 kez/);
  run('edit_file', { path: 'd.txt', old: 'x = 1', new: 'x = $&', replace_all: true });
  assert.equal(readFileSync(join(dir, 'd.txt'), 'utf8'), 'x = $&\nx = $&\n');
  run('edit_file', { path: 'd.txt', old: 'x = $&\nx', new: 'y' });
  assert.equal(readFileSync(join(dir, 'd.txt'), 'utf8'), 'y = $&\n');
  run('write_file', { path: 'yeni/dosya.txt', content: 'merhaba' });
  assert.equal(readFileSync(join(dir, 'yeni', 'dosya.txt'), 'utf8'), 'merhaba');
  assert.throws(() => run('write_file', { path: '.env', content: 'x' }), /gizli/);
});

test('run_command kum havuzu yoksa kapalı', () => {
  assert.throws(() => run('run_command', { command: 'ls' }), /kapalı/);
  assert.throws(() => run('run_command', { command: 'git push' }, ctx({ sandbox: {}, denyCommands: ['^git\\s+push'] })), /yasak/);
});

test('araç kümeleri: yazma ve komut koşula bağlı', () => {
  const names = (o) => builtinTools(o).map((t) => t.name);
  assert.deepEqual(names({ sets: ['read', 'search', 'run', 'write'] }), ['list_files', 'read_file', 'search']);
  assert.deepEqual(names({ sets: ['read'], write: true, exec: true }), ['list_files', 'read_file', 'edit_file', 'write_file']);
  assert.deepEqual(names({ sets: ['run'], exec: true }), ['run_command']);
});

test('validateArgs alt kümesi', () => {
  const schema = { type: 'object', properties: { a: { type: 'string', enum: ['x', 'y'] }, n: { type: 'integer' }, l: { type: 'array', items: { type: 'string' } } }, required: ['a'] };
  assert.equal(validateArgs(schema, { a: 'x', n: 2, l: ['q'] }), null);
  assert.match(validateArgs(schema, {}), /a eksik/);
  assert.match(validateArgs(schema, { a: 'z' }), /şunlardan biri/);
  assert.match(validateArgs(schema, { a: 'x', n: 1.5 }), /integer/);
  assert.match(validateArgs(schema, { a: 'x', l: [1] }), /l\[0\]/);
  assert.match(validateArgs(schema, { a: 'x', fazla: 1 }), /tanımlı değil/);
  assert.equal(validateArgs(schema, { a: 'x', n: null }), null);
});

test('glob', () => {
  assert.ok(globToRegExp('*.pem').test('a/b/c.pem'));
  assert.ok(globToRegExp('.env.*').test('.env.local'));
  assert.ok(!globToRegExp('.env.*').test('x.env.ts'));
  assert.ok(globToRegExp('secrets/**').test('secrets/a/b'));
  assert.ok(!globToRegExp('secrets/**').test('x/secrets/a'));
  assert.ok(globToRegExp('**/*.pem').test('a.pem'));
  assert.ok(globToRegExp('src/**/*.ts').test('src/a/b.ts'));
  assert.ok(globToRegExp('src/**/*.ts').test('src/b.ts'));
  assert.ok(globToRegExp('ios/GoogleService-Info.plist').test('ios/GoogleService-Info.plist'));
  assert.ok(globToRegExp('id_rsa*').test('.ssh/id_rsa.pub'));
});

test('denetimden sonra bağlantıya çevrilen dosya açılmaz, dışarıdaki dosya kesilmez', () => {
  writeFileSync(join(dir, 'yaris.txt'), 'iç');
  const real = resolveInside(ctx(), 'yaris.txt');
  // Komut aracının bıraktığı bir süreç dosyayı dışarıyı gösteren bağlantıyla değiştirir.
  unlinkSync(real);
  symlinkSync(join(outside, 'gizli.txt'), real);
  assert.throws(() => readChecked(real), /bağlantı/);
  assert.throws(() => writeChecked(ctx(), real, 'x'), /bağlantı/);
  assert.equal(readFileSync(join(outside, 'gizli.txt'), 'utf8'), 'DIŞARIDA');
  unlinkSync(real);
  // Üst klasör bağlantıya çevrilirse yazma reddedilir.
  mkdirSync(join(dir, 'ust'));
  const target = resolveInside(ctx(), 'ust/yeni.txt', { forWrite: true });
  renameSync(join(dir, 'ust'), join(dir, 'ust-eski'));
  symlinkSync(outside, join(dir, 'ust'));
  assert.throws(() => writeChecked(ctx(), target, 'x'), /dışına|değişti/);
  assert.equal(readFileSync(join(outside, 'gizli.txt'), 'utf8'), 'DIŞARIDA');
});

test('hedefi olmayan bağlantıdan yazılmaz; çok uzun ilk satır kırpılarak okunur', () => {
  symlinkSync(join(outside, 'yok-klasor'), join(dir, 'olu'));
  symlinkSync(join(outside, 'yok.txt'), join(dir, 'olu.txt'));
  assert.throws(() => run('write_file', { path: 'olu.txt', content: 'x' }), /Hedefi olmayan bağlantı/);
  assert.throws(() => run('write_file', { path: 'olu/x.txt', content: 'x' }), /Hedefi olmayan bağlantı/);
  writeFileSync(join(dir, 'uzun.txt'), 'u'.repeat(50_000));
  assert.match(run('read_file', { path: 'uzun.txt' }), /kırpıldı\]$/);
});
