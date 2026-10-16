import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { decodeText } from '../lib/config.mjs';
import { cmdArg, cmdCommand, findExecutable, quoteArg, resolveSpawn } from '../lib/proc.mjs';

// Windows davranışı platform parametresiyle sınanır; gerçek cmd.exe burada yok.
function winDir(files) {
  const dir = mkdtempSync(join(tmpdir(), 'orkestra-win-'));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}
const winEnv = (dir) => ({ PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD', ComSpec: 'C:\\Windows\\system32\\cmd.exe' });

test('Windows\'ta komut PATHEXT sırasıyla bulunur; macOS\'ta uzantısız', () => {
  const dir = winDir({ 'codex.cmd': '@node "%dp0%\\codex.js" %*', 'agy.exe': '' });
  try {
    assert.equal(findExecutable('codex', { platform: 'win32', env: winEnv(dir) }), join(dir, 'codex.cmd'));
    assert.equal(findExecutable('agy', { platform: 'win32', env: winEnv(dir) }), join(dir, 'agy.exe'));
    assert.equal(findExecutable('codex', { platform: 'darwin', env: { PATH: dir } }), null);
    assert.equal(findExecutable('yok', { platform: 'win32', env: winEnv(dir) }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('.exe doğrudan, .cmd kabuğu cmd.exe üzerinden başlatılır', () => {
  const dir = winDir({ 'codex.cmd': '@node "%dp0%\\codex.js" %*', 'agy.exe': '' });
  try {
    const env = winEnv(dir);
    const [exe, exeArgs, exeExtra] = resolveSpawn('agy', ['-p=çok\nsatır'], { platform: 'win32', env });
    assert.equal(exe, join(dir, 'agy.exe'));
    assert.deepEqual(exeArgs, ['-p=çok\nsatır']);
    assert.deepEqual(exeExtra, {});

    const [file, args, extra] = resolveSpawn('codex', ['exec', '-c', 'web_search="disabled"', '-'], { platform: 'win32', env });
    assert.equal(file, env.ComSpec);
    assert.deepEqual(args.slice(0, 3), ['/d', '/s', '/c']);
    assert.equal(extra.windowsVerbatimArguments, true);
    assert.ok(args[3].startsWith(`"${cmdCommand(join(dir, 'codex.cmd'))} `));
    assert.ok(args[3].includes(cmdArg('web_search="disabled"')));
    assert.ok(args[3].endsWith('"'));
    assert.throws(() => resolveSpawn('codex', ['a\nb'], { platform: 'win32', env }), /çok satırlı/);
    assert.deepEqual(resolveSpawn('codex', ['x'], { platform: 'darwin', env }), ['codex', ['x'], {}]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('argüman MSVCRT kurallarıyla tırnaklanır, cmd metakarakterleri kaçırılır', () => {
  assert.equal(quoteArg('a b'), '"a b"');
  assert.equal(quoteArg('say "hi"'), '"say \\"hi\\""');
  assert.equal(quoteArg('C:\\yol\\'), '"C:\\yol\\\\"');
  assert.equal(quoteArg(''), '""');
  assert.equal(cmdArg('a&b', { twice: false }), '^"a^&b^"');
  assert.equal(cmdArg('a&b'), '^^^"a^^^&b^^^"');
  assert.equal(cmdArg('%PATH%', { twice: false }), '^"^%PATH^%^"');
  assert.equal(cmdCommand('C:\\Program Files\\nodejs\\codex.cmd'), 'C:\\Program^ Files\\nodejs\\codex.cmd');
});

test('--input dosyası UTF-8, UTF-8 BOM ve UTF-16 LE olarak okunur', () => {
  const text = 'Şu diff\'i incele: ğüşıöç';
  assert.equal(decodeText(Buffer.from(text, 'utf8')), text);
  assert.equal(decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')])), text);
  assert.equal(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])), text);
});

test('tam yolla verilen komut PATH\'te aranmadan bulunur', () => {
  const dir = winDir({ 'codex.cmd': '%*' });
  try {
    assert.equal(findExecutable(join(dir, 'codex'), { platform: 'win32', env: { PATH: '', PATHEXT: '.EXE;.CMD' } }), join(dir, 'codex.cmd'));
    assert.equal(findExecutable(join(dir, 'codex.cmd'), { platform: 'win32', env: { PATH: '' } }), join(dir, 'codex.cmd'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('alt süreç ortamı: yalnız izinli anahtarlar; Windows\'ta "Path" de alınır, anahtar sızmaz', async () => {
  const { childEnv } = await import('../lib/agents.mjs');
  const win = childEnv({ Path: 'C:\\bin', SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\u', NVIDIA_API_KEY: 'gizli', HTTPS_PROXY: 'http://p' }, 'win32');
  assert.equal(win.PATH, 'C:\\bin');
  assert.equal(win.SystemRoot, 'C:\\Windows');
  assert.equal(win.HTTPS_PROXY, 'http://p');
  assert.equal(win.NVIDIA_API_KEY, undefined);
  assert.equal(Object.keys(win).filter((k) => k.toLowerCase() === 'systemroot').length, 1);
  const mac = childEnv({ PATH: '/bin', SystemRoot: 'x', NVIDIA_API_KEY: 'gizli' }, 'darwin');
  assert.deepEqual(Object.keys(mac).sort(), ['NO_COLOR', 'PATH']);
});
