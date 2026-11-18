import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { completion } from '../lib/nvidia.mjs';
import { createWorkspace, sandboxProfile, workspacePatch } from '../lib/workspace.mjs';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'orkestra-ws-')));
after(() => rmSync(base, { recursive: true, force: true }));

// Küçük bir git deposu: izlenen, izlenmeyen, yok sayılan ve gizli dosyalar.
function repo() {
  const root = mkdtempSync(join(base, 'depo-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-q');
  writeFileSync(join(root, '.gitignore'), 'build/\n');
  writeFileSync(join(root, 'a.txt'), 'bir\n');
  writeFileSync(join(root, 'yeni.txt'), 'izlenmeyen\n');
  writeFileSync(join(root, '.env.local'), 'NVIDIA_API_KEY=gizli\n');
  writeFileSync(join(root, 'sunucu.pem'), 'pem\n');
  mkdirSync(join(root, 'build'));
  writeFileSync(join(root, 'build', 'x'), 'x');
  mkdirSync(join(root, 'secrets'));
  writeFileSync(join(root, 'secrets', 'k.json'), '{}');
  git('add', 'a.txt', '.gitignore');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'ilk');
  return root;
}

test('kopyaya gizli, dışlanan ve yok sayılan dosyalar girmez; git dizini dışarıda', () => {
  const ws = createWorkspace(repo(), { exclude: ['secrets/**'] });
  try {
    assert.ok(existsSync(join(ws.dir, 'a.txt')));
    assert.ok(existsSync(join(ws.dir, 'yeni.txt')));
    for (const f of ['.env.local', 'sunucu.pem', 'build/x', 'secrets/k.json', '.git']) assert.ok(!existsSync(join(ws.dir, f)), f);
    assert.ok(!ws.gitDir.startsWith(ws.dir));
    assert.equal(workspacePatch(ws), '');
  } finally {
    ws.cleanup();
  }
  assert.ok(!existsSync(ws.dir) && !existsSync(ws.gitDir));
});

test('yama değişen ve yeni dosyaları içerir', () => {
  const ws = createWorkspace(repo());
  try {
    writeFileSync(join(ws.dir, 'a.txt'), 'iki\n');
    writeFileSync(join(ws.dir, 'c.txt'), 'yeni\n');
    const patch = workspacePatch(ws);
    assert.match(patch, /^diff --git a\/a\.txt/m);
    assert.match(patch, /^diff --git a\/c\.txt/m);
    assert.match(patch, /^\+iki$/m);
  } finally {
    ws.cleanup();
  }
});

test('ajanın kopyaya yazdığı git ayarı yama alınırken komut çalıştıramaz', () => {
  const ws = createWorkspace(repo());
  const marker = join(base, 'calisti');
  try {
    // Kopyada sahte bir .git: core.fsmonitor ve kanca. Git dizini dışarıda olduğu için ikisi de okunmamalı.
    mkdirSync(join(ws.dir, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(ws.dir, '.git', 'config'), `[core]\n\tfsmonitor = "touch ${marker}"\n\thooksPath = .git/hooks\n`);
    writeFileSync(join(ws.dir, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    writeFileSync(join(ws.dir, 'a.txt'), 'değişti\n');
    const patch = workspacePatch(ws);
    assert.match(patch, /a\.txt/);
    assert.doesNotMatch(patch, /\.git\//);
    assert.ok(!existsSync(marker));
  } finally {
    ws.cleanup();
  }
});

test('kum havuzu profili: kök, git dizini ve ağ kapalı', () => {
  const root = repo();
  const p = sandboxProfile({ dir: '/tmp/k', gitDir: '/tmp/g', root, write: false, network: false, tmp: '/tmp/t' });
  assert.match(p, new RegExp(`\\(deny file-read\\* \\(subpath "${realpathSync(homedir())}"\\)\\)`));
  assert.ok(p.includes(`(deny file-read* (subpath "${realpathSync(root)}"))`));
  assert.ok(p.includes('(deny file-read* file-write* (subpath "/tmp/g"))'));
  assert.ok(p.includes('(deny file-write* (subpath "/tmp/k"))'));
  assert.ok(p.includes('(deny network-outbound)'));
  assert.ok(!p.includes('(allow file-write* (subpath "/private/tmp")'));
  assert.ok(p.includes('(deny file-read* (subpath "/private/tmp") (subpath "/private/var/folders"))'));
  const open = sandboxProfile({ dir: '/tmp/k', root, write: true });
  assert.ok(!open.includes('network') && !open.includes('(deny file-write* (subpath "/tmp/k"))'));
});

// Gerçek sandbox-exec: yalnız macOS.
test('sandbox-exec: ev klasörü ve depo okunamaz, git dizinine ve dışarı yazılamaz, ağ kapalı', { skip: process.platform !== 'darwin' || Boolean(process.env.ORKESTRA_SANDBOX) }, () => {
  const root = repo();
  const ws = createWorkspace(root);
  const scratch = realpathSync(mkdtempSync(join(base, 'tmp-')));
  try {
    const profile = join(scratch, 'p.sb');
    writeFileSync(profile, sandboxProfile({ dir: ws.dir, gitDir: ws.gitDir, root, write: true, network: false, tmp: scratch }));
    const sh = (cmd) => spawnSync('sandbox-exec', ['-f', profile, '/bin/sh', '-c', cmd], { cwd: ws.dir, encoding: 'utf8' });
    assert.equal(sh('cat a.txt').stdout, 'bir\n');
    assert.equal(sh('echo x > yazildi.txt').status, 0);
    assert.equal(sh(`echo x > ${scratch}/t`).status, 0);
    assert.notEqual(sh(`cat ${join(root, '.env.local')}`).status, 0);
    assert.notEqual(sh(`ls ${homedir()}/Documents`).status, 0);
    assert.notEqual(sh(`echo x > ${ws.gitDir}/config`).status, 0);
    assert.notEqual(sh(`cat ${ws.gitDir}/HEAD`).status, 0);
    assert.notEqual(sh(`echo x > ${base}/disari`).status, 0);
    assert.notEqual(sh('/usr/bin/curl -sS -m 5 -o /dev/null https://example.com').status, 0);
    assert.equal(readFileSync(join(ws.dir, 'yazildi.txt'), 'utf8'), 'x\n');
  } finally {
    ws.cleanup();
  }
});

// completion(): sahte fetch ile gövde ve cevap biçimi.
const target = { base: 'https://ornek/v1', apiKey: 'k', keyName: 'K', model: 'm', minMaxTokens: 0 };
const reply = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });

test('completion: araçsız gövde eskisiyle aynı; araçla tools ve tool_choice eklenir', async () => {
  const bodies = [];
  const fetchFn = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return reply(200, { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'c', function: { name: 'x', arguments: '{}' } }] } }], usage: { prompt_tokens: 7, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 2 } } });
  };
  const messages = [{ role: 'user', content: 'p' }];
  await completion({ messages, target, fetchFn });
  assert.deepEqual(Object.keys(bodies[0]), ['model', 'messages', 'max_tokens']);
  const tools = [{ type: 'function', function: { name: 'x', description: '', parameters: { type: 'object' } } }];
  const r = await completion({ messages, tools, target, fetchFn });
  assert.equal(bodies[1].tool_choice, 'auto');
  assert.deepEqual(bodies[1].tools, tools);
  assert.equal(r.finishReason, 'tool_calls');
  assert.equal(r.message.tool_calls[0].id, 'c');
  assert.deepEqual(r.usage, { input: 7, cached: 2, output: 3 });
});

test('completion: 429 bir kez yeniden denenir; 4xx hata durumunu taşır', async () => {
  let n = 0;
  const waits = [];
  const ok = await completion({ messages: [], target, sleepFn: async (ms) => waits.push(ms), fetchFn: async () => (n++ ? reply(200, { choices: [{ message: { content: 'tamam' } }] }) : reply(429, {})) });
  assert.equal(ok.message.content, 'tamam');
  assert.deepEqual(waits, [3000]);
  await assert.rejects(completion({ messages: [], target, fetchFn: async () => reply(400, { error: 'tools desteklenmiyor' }) }), (e) => e.status === 400 && /tools desteklenmiyor/.test(e.message));
  await assert.rejects(completion({ messages: [], target: { ...target, apiKey: null } }), /K yok/);
});
