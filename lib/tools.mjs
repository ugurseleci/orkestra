// Orkestra'nın kendi ajan döngüsünün (loop.mjs) araçları.
// araç = ad + açıklama + JSON şeması + çalıştıran fonksiyon. Araç hatası istisna olarak
// döngüyü düşürmez; modele "Hata: …" içerikli araç mesajı olarak döner, model toparlar.
//
// Güvenlik: döngü API anahtarını tuttuğu için kum havuzunun dışında, Orkestra'nın kendi sürecinde çalışır. Sınır bu
// yüzden araç başınadır:
//  - Dosya araçları (list_files, read_file, search, edit_file, write_file) süreç içinde çalışır; her yol realpath ile
//    çözülür ve kopyanın (ya da okumada <kök>/node_modules'ın) içinde mi diye bakılır. Sembolik bağ kaçışı, "..",
//    gizli dosyalar (SECRET_GLOBS + agent.exclude) reddedilir. Yazma yalnız kopyaya, .git/ ve node_modules/ hariç.
//  - Komut aracı (run_command) ayrı süreçte, macOS sandbox-exec altında, ağ kapalı ve yalnız kopyada çalışır.
// Gerçek depoya hiçbir araç yazmaz; yazma kipindeki değişiklikler sonda yama olarak alınır ve Claude uygular.

import { spawn } from 'node:child_process';
import { closeSync, constants, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { globToRegExp } from './workspace.mjs';

// Modele gösterilecek hata: döngü bunu "Hata: <mesaj>" araç mesajına çevirir.
export class ToolError extends Error {}

// risk: 'read' | 'write' | 'exec'. run(args, ctx) → metin.
export function defineTool({ name, description, parameters, risk = 'read', run }) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new Error(`Geçersiz araç adı: ${name}`);
  return { name, description, parameters: { type: 'object', properties: {}, ...parameters }, risk, run };
}

// OpenAI biçimindeki araç tanımları (gövdedeki "tools").
export const toolSpecs = (tools) =>
  tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));

const TYPE_OK = {
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  integer: (v) => Number.isInteger(v),
  boolean: (v) => typeof v === 'boolean',
  array: (v) => Array.isArray(v),
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
};

// JSON şemasının küçük bir alt kümesi: type, properties, required, enum, items, bilinmeyen alan reddi.
// Hata metni (modele gider) ya da null.
export function validateArgs(schema, value, path = 'argümanlar') {
  if (schema.type && !TYPE_OK[schema.type]?.(value)) return `${path}: ${schema.type} bekleniyordu`;
  if (schema.enum && !schema.enum.includes(value)) return `${path}: şunlardan biri olmalı: ${schema.enum.join(', ')}`;
  if (schema.type === 'object') {
    const props = schema.properties ?? {};
    for (const key of schema.required ?? []) if (!(key in value)) return `${path}.${key} eksik`;
    for (const [key, v] of Object.entries(value)) {
      if (!props[key]) return `${path}.${key} tanımlı değil (geçerli: ${Object.keys(props).join(', ') || 'yok'})`;
      if (v === null && !(schema.required ?? []).includes(key)) continue;
      const error = validateArgs(props[key], v, `${path}.${key}`);
      if (error) return error;
    }
  }
  if (schema.type === 'array' && schema.items) {
    for (let i = 0; i < value.length; i++) {
      const error = validateArgs(schema.items, value[i], `${path}[${i}]`);
      if (error) return error;
    }
  }
  return null;
}

const inside = (base, path) => path === base || path.startsWith(base.endsWith(sep) ? base : base + sep);

// Kopyaya göre yol → güvenli mutlak yol. Okumada kökler: kopya ve <kök>/node_modules (kopyadaki bağ oraya çıkar);
// yazmada yalnız kopya. Var olmayan dosyada (yazma) en yakın var olan üst klasör çözülür.
export function resolveInside(ctx, path, { forWrite = false } = {}) {
  if (typeof path !== 'string' || !path.trim()) throw new ToolError('Yol boş.');
  const target = isAbsolute(path) ? path : resolve(ctx.dir, path);
  // Mutlak yol yalnız kopyanın içini gösteriyorsa kabul edilir.
  if (!inside(ctx.dir, resolve(target))) throw new ToolError(`Yol kopyanın dışında: ${path}`);
  const rel = relative(ctx.dir, resolve(target)).split(sep).join('/');
  if (ctx.isExcluded?.(rel)) throw new ToolError(`Bu dosya gizli ya da dışlanmış: ${rel}`);
  const parts = rel.split('/');
  if (parts.includes('.git')) throw new ToolError('.git kullanılamaz.');
  if (forWrite && parts[0] === 'node_modules') throw new ToolError('node_modules değiştirilemez.');
  // Değişiklik kendisini yargılayan denetimi (kapı/mercek ayarı, CI, CLAUDE.md) değiştiremez.
  if (forWrite && ctx.isProtected?.(rel)) throw new ToolError(`Bu dosya korunuyor (denetim ayarı): ${rel}`);

  let existing = resolve(target);
  const missing = [];
  for (;;) {
    try {
      existing = realpathSync(existing);
      break;
    } catch {
      // Var olan ama çözülemeyen girdi: hedefi olmayan bağlantı. Yazma onu izleyip kopya dışına dosya açabilirdi.
      let dangling = false;
      try {
        dangling = lstatSync(existing).isSymbolicLink();
      } catch {
        // Gerçekten yok.
      }
      if (dangling) throw new ToolError(`Hedefi olmayan bağlantı: ${relative(ctx.dir, existing).split(sep).join('/')}`);
      missing.unshift(existing.slice(dirname(existing).length + 1));
      const up = dirname(existing);
      if (up === existing) throw new ToolError(`Yol çözülemedi: ${path}`);
      existing = up;
    }
  }
  if (missing.length && !forWrite) throw new ToolError(`Dosya yok: ${rel}`);
  const real = join(existing, ...missing);
  const roots = forWrite ? [ctx.dir] : [ctx.dir, ...(ctx.readRoots ?? [])];
  if (!roots.some((r) => inside(r, real))) throw new ToolError(`Yol kopyanın dışına çıkıyor (bağlantı?): ${rel}`);
  const realRel = relative(ctx.dir, real).split(sep).join('/');
  if (inside(ctx.dir, real) && ctx.isExcluded?.(realRel)) throw new ToolError(`Bu dosya gizli ya da dışlanmış: ${realRel}`);
  // Bağlantı korunan klasörü gösteriyorsa gerçek yol da denetlenir.
  if (forWrite && ctx.isProtected?.(realRel)) throw new ToolError(`Bu dosya korunuyor (denetim ayarı): ${realRel}`);
  return real;
}

// Denetlenmiş yolu bağlantı izlemeden açar (O_NOFOLLOW) ve açılan dosyanın denetlenen dosya olduğunu doğrular.
// Neden: komut aracının bıraktığı bir süreç, denetimle açma arasında dosyayı kopya dışını gösteren bir bağlantıyla
// değiştirebilir; dosya araçları kum havuzunun dışında çalıştığı için bu bir kaçış olurdu. Komut süreç grubu her
// komuttan sonra öldürülür (run_command); bu ikinci savunmadır.
function openChecked(real, flags) {
  let fd;
  try {
    fd = openSync(real, flags | constants.O_NOFOLLOW, 0o644);
  } catch (e) {
    if (e.code === 'ELOOP') throw new ToolError('Dosya bir bağlantıya dönüştü; açılmadı.');
    throw e;
  }
  try {
    const opened = fstatSync(fd);
    const again = statSync(realpathSync(real));
    if (opened.ino !== again.ino || opened.dev !== again.dev) throw new ToolError('Dosya denetimden sonra değişti; açılmadı.');
  } catch (e) {
    closeSync(fd);
    throw e;
  }
  return fd;
}
export const readChecked = (real) => {
  const fd = openChecked(real, constants.O_RDONLY);
  try {
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
};
export const writeChecked = (ctx, real, data) => {
  // O_TRUNC yok: dosya doğrulanmadan kesilmesin; doğrulamadan sonra ftruncate.
  const fd = openChecked(real, constants.O_WRONLY | constants.O_CREAT);
  try {
    // Yazılan dosya hâlâ kopyanın içinde mi (üst klasör bağlantıya çevrilmiş olabilir).
    if (!inside(ctx.dir, realpathSync(real))) throw new ToolError('Yol kopyanın dışına çıktı; yazılmadı.');
    ftruncateSync(fd, 0);
    writeFileSync(fd, data);
  } finally {
    closeSync(fd);
  }
};

const relOf = (ctx, abs) => relative(ctx.dir, abs).split(sep).join('/') || '.';
const SKIP_DIRS = new Set(['.git', 'node_modules']);
const isBinary = (buf) => buf.subarray(0, 8000).includes(0);

// Kopyadaki dosyalar (bağlar izlenmez, node_modules ve .git atlanır), göreli yollarıyla.
function* walk(ctx, start) {
  const stack = [start];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? 1 : -1));
    for (const e of entries) {
      const abs = join(dir, e.name);
      const rel = relOf(ctx, abs);
      if (ctx.isExcluded?.(rel)) continue;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(abs);
      } else if (e.isFile()) yield rel;
    }
  }
}

const LIMITS = { listEntries: 500, readLines: 400, readBytes: 40_000, searchMatches: 200, lineChars: 300, searchFileBytes: 1_000_000, writeBytes: 200_000, commandOutput: 8_000 };

const listFiles = defineTool({
  name: 'list_files',
  description: 'Proje kopyasındaki dosyaları listeler (node_modules ve gizli dosyalar hariç). glob ile süz: "src/**/*.ts", "*.md".',
  parameters: {
    properties: {
      path: { type: 'string', description: 'Başlangıç klasörü (varsayılan: kök).' },
      glob: { type: 'string', description: 'İsteğe bağlı desen.' },
    },
  },
  run({ path = '.', glob }, ctx) {
    const start = resolveInside(ctx, path);
    if (!statSync(start).isDirectory()) throw new ToolError(`Klasör değil: ${path}`);
    const re = glob ? globToRegExp(glob) : null;
    const out = [];
    let more = false;
    for (const rel of walk(ctx, start)) {
      if (re && !re.test(rel)) continue;
      if (out.length >= LIMITS.listEntries) {
        more = true;
        break;
      }
      out.push(rel);
    }
    if (!out.length) return 'Eşleşen dosya yok.';
    return `${out.join('\n')}${more ? `\n… (ilk ${LIMITS.listEntries}; glob ya da path ile daralt)` : ''}`;
  },
});

const readFile = defineTool({
  name: 'read_file',
  description: `Bir dosyayı satır numaralarıyla okur. Uzun dosyada offset (1'den başlar) ve limit ile sayfa sayfa oku (en çok ${LIMITS.readLines} satır).`,
  parameters: {
    properties: {
      path: { type: 'string' },
      offset: { type: 'integer', description: 'Başlangıç satırı (1).' },
      limit: { type: 'integer', description: `Satır sayısı (en çok ${LIMITS.readLines}).` },
    },
    required: ['path'],
  },
  run({ path, offset = 1, limit = LIMITS.readLines }, ctx) {
    const abs = resolveInside(ctx, path);
    if (!statSync(abs).isFile()) throw new ToolError(`Dosya değil: ${path}`);
    const buf = readChecked(abs);
    if (isBinary(buf)) throw new ToolError(`İkili dosya okunmaz: ${path}`);
    const lines = buf.toString('utf8').split('\n');
    const from = Math.max(1, offset);
    const count = Math.min(Math.max(1, limit), LIMITS.readLines);
    const out = [];
    let bytes = 0;
    let last = from - 1;
    for (let i = from; i <= Math.min(lines.length, from + count - 1); i++) {
      const line = `${String(i).padStart(5)}\t${lines[i - 1]}`;
      bytes += line.length + 1;
      if (bytes > LIMITS.readBytes) {
        // Tek satır sınırı aşıyorsa satır kırpılarak verilir; yoksa dosya hiç okunamazdı.
        if (!out.length) {
          out.push(`${line.slice(0, LIMITS.readBytes)}… [satır ${line.length} karakter, kırpıldı]`);
          last = i;
        }
        break;
      }
      out.push(line);
      last = i;
    }
    if (!out.length) return `Dosya ${lines.length} satır; ${from}. satır yok.`;
    const rest = last < lines.length ? `\n… (${lines.length} satırın ${from}-${last} arası; devamı için offset: ${last + 1})` : '';
    return out.join('\n') + rest;
  },
});

const search = defineTool({
  name: 'search',
  description: 'Proje kopyasında düzenli ifade (JavaScript sözdizimi) arar; "dosya:satır: metin" döner.',
  parameters: {
    properties: {
      pattern: { type: 'string' },
      path: { type: 'string', description: 'Klasör ya da dosya (varsayılan: kök).' },
      glob: { type: 'string', description: 'Dosya deseni, ör. "*.mjs".' },
      ignore_case: { type: 'boolean' },
    },
    required: ['pattern'],
  },
  run({ pattern, path = '.', glob, ignore_case: ignoreCase = false }, ctx) {
    let re;
    try {
      re = new RegExp(pattern, ignoreCase ? 'i' : '');
    } catch (e) {
      throw new ToolError(`Geçersiz düzenli ifade: ${e.message}`);
    }
    const start = resolveInside(ctx, path);
    const files = statSync(start).isDirectory() ? walk(ctx, start) : [relOf(ctx, start)];
    const fileRe = glob ? globToRegExp(glob) : null;
    const out = [];
    for (const rel of files) {
      if (fileRe && !fileRe.test(rel)) continue;
      const abs = join(ctx.dir, rel);
      let buf;
      try {
        if (lstatSync(abs).size > LIMITS.searchFileBytes) continue;
        buf = readChecked(resolveInside(ctx, rel));
      } catch {
        continue;
      }
      if (isBinary(buf)) continue;
      const lines = buf.toString('utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i])) continue;
        out.push(`${rel}:${i + 1}: ${lines[i].slice(0, LIMITS.lineChars)}`);
        if (out.length >= LIMITS.searchMatches) return `${out.join('\n')}\n… (ilk ${LIMITS.searchMatches} eşleşme; daralt)`;
      }
    }
    return out.length ? out.join('\n') : 'Eşleşme yok.';
  },
});

const editFile = defineTool({
  name: 'edit_file',
  description: 'Dosyada bir metni değiştirir. old dosyada tam bir kez geçmeli (replace_all: true ise hepsi değişir). Önce read_file ile oku.',
  risk: 'write',
  parameters: {
    properties: {
      path: { type: 'string' },
      old: { type: 'string', description: 'Değişecek metin, girintisiyle birebir.' },
      new: { type: 'string' },
      replace_all: { type: 'boolean' },
    },
    required: ['path', 'old', 'new'],
  },
  run({ path, old, new: replacement, replace_all: all = false }, ctx) {
    const abs = resolveInside(ctx, path, { forWrite: true });
    let text;
    try {
      text = readChecked(abs).toString('utf8');
    } catch {
      throw new ToolError(`Dosya yok: ${path} (yeni dosya için write_file)`);
    }
    if (!old) throw new ToolError('old boş olamaz.');
    const count = text.split(old).length - 1;
    if (count === 0) throw new ToolError('old dosyada bulunamadı; read_file ile birebir metni al.');
    if (count > 1 && !all) throw new ToolError(`old ${count} kez geçiyor; daha uzun bir parça ver ya da replace_all: true.`);
    writeChecked(ctx, abs, all ? text.split(old).join(replacement) : text.replace(old, () => replacement));
    return `${relOf(ctx, abs)}: ${all ? count : 1} yer değişti.`;
  },
});

const writeFile = defineTool({
  name: 'write_file',
  description: 'Dosyayı verilen içerikle yazar (yoksa oluşturur, varsa üzerine yazar). Var olan dosyada küçük değişiklik için edit_file kullan.',
  risk: 'write',
  parameters: { properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
  run({ path, content }, ctx) {
    if (Buffer.byteLength(content) > LIMITS.writeBytes) throw new ToolError(`İçerik çok büyük (en çok ${LIMITS.writeBytes / 1000} KB).`);
    const abs = resolveInside(ctx, path, { forWrite: true });
    mkdirSync(dirname(abs), { recursive: true });
    if (!inside(ctx.dir, realpathSync(dirname(abs)))) throw new ToolError('Yol kopyanın dışına çıktı; yazılmadı.');
    writeChecked(ctx, abs, content);
    return `${relOf(ctx, abs)} yazıldı (${content.split('\n').length} satır).`;
  },
});

// Komutu kum havuzunda koşar: ağ kapalı, yalnız kopya (ve okumada node_modules) görünür, süzülmüş ortam.
// ctx.sandbox: { profile (dosya yolu), env, tmp }. ctx.denyCommands: projenin yasak desenleri (gürültü süzgeci;
// güvenlik sınırı kum havuzudur).
const runCommand = defineTool({
  name: 'run_command',
  description:
    'Proje kopyasında kabuk komutu çalıştırır (/bin/sh -c). Ağ kapalı; paket kuramazsın. Test, derleme, ls, grep için. ' +
    'Çıktının son kısmı ve çıkış kodu döner.',
  risk: 'exec',
  parameters: {
    properties: {
      command: { type: 'string' },
      timeout_s: { type: 'integer', description: 'Varsayılan 120, en çok 600.' },
    },
    required: ['command'],
  },
  run({ command, timeout_s: timeoutS = 120 }, ctx) {
    if (!ctx.sandbox) throw new ToolError('Komut aracı bu sistemde kapalı (yalnız macOS kum havuzunda).');
    const denied = (ctx.denyCommands ?? []).find((p) => new RegExp(p).test(command.trim()));
    if (denied) throw new ToolError(`Bu komut proje ayarında yasak (${denied}).`);
    const timeoutMs = Math.min(Math.max(1, timeoutS), 600) * 1000;
    return new Promise((resolvePromise, reject) => {
      const child = (ctx.spawnFn ?? spawn)('sandbox-exec', ['-f', ctx.sandbox.profile, '/bin/sh', '-c', command], {
        cwd: ctx.dir,
        env: ctx.sandbox.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
      let out = '';
      const keep = (d) => {
        out += d;
        if (out.length > LIMITS.commandOutput * 4) out = out.slice(-LIMITS.commandOutput * 2);
      };
      child.stdout.on('data', keep);
      child.stderr.on('data', keep);
      let timedOut = false;
      const kill = () => {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // Bitmiş olabilir.
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, timeoutMs);
      const onAbort = () => kill();
      ctx.signal?.addEventListener('abort', onAbort, { once: true });
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(new ToolError(`Komut başlatılamadı: ${e.message}`));
      });
      child.on('close', (code, sig) => {
        clearTimeout(timer);
        // Komutun arka planda bıraktığı süreçler de durdurulur (bkz. openChecked).
        kill();
        ctx.signal?.removeEventListener('abort', onAbort);
        const tail = out.length > LIMITS.commandOutput ? `… (çıktının son ${LIMITS.commandOutput} karakteri)\n${out.slice(-LIMITS.commandOutput)}` : out;
        const status = timedOut ? `zaman aşımı (${timeoutMs / 1000} sn), durduruldu` : `çıkış kodu ${code ?? sig}`;
        resolvePromise(`[${status}]\n${tail.trim() || '(çıktı yok)'}`);
      });
    });
  },
});

export const TOOL_SETS = {
  read: [listFiles, readFile],
  search: [search],
  run: [runCommand],
  write: [editFile, writeFile],
};

// Döngüye verilecek araçlar. sets: istenen kümeler; write ve run kapı koşullarına bağlı.
export function builtinTools({ sets = ['read', 'search', 'run'], write = false, exec = false } = {}) {
  const want = new Set(sets);
  if (write) want.add('write');
  return Object.entries(TOOL_SETS)
    .filter(([name]) => want.has(name) && (name !== 'write' || write) && (name !== 'run' || exec))
    .flatMap(([, tools]) => tools);
}
