// Dış komutu her sistemde aynı biçimde başlatmak: macOS/Linux'ta doğrudan; Windows'ta PATH + PATHEXT ile dosyayı bulup
// .exe'yi doğrudan, .cmd/.bat'ı (npm'in codex.cmd gibi kabukları) cmd.exe üzerinden.
//
// Node 20.12+ Windows'ta .cmd/.bat'ı kabuksuz başlatmayı reddediyor (EINVAL). shell: true ise argümanları kaçırmadan
// birleştirir. Bu yüzden cross-spawn'ın yöntemi: her argüman Windows (MSVCRT) kurallarıyla tırnaklanır, sonra cmd.exe
// metakarakterleri ^ ile kaçırılır; npm kabukları argümanı bir kez daha cmd'den geçirdiği için iki kez.
// cmd.exe argümanda satır sonu taşıyamaz: çok satırlı metin .cmd'ye argümanla verilmez (soru stdin'den gider).

import { spawn } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { delimiter, extname, join } from 'node:path';

const isFile = (path) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

// Komutun tam yolu ya da null. Windows'ta "codex" → codex.exe / codex.cmd (PATHEXT sırasıyla).
export function findExecutable(command, { platform = process.platform, env = process.env } = {}) {
  const exts = platform === 'win32' ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  const names = platform === 'win32' && extname(command) ? [command] : exts.map((ext) => command + ext.toLowerCase());
  // Yol verilmişse (ör. C:\npm\codex.cmd ya da ./bin/x) PATH'te aranmaz.
  if (/[\\/]/.test(command)) return names.find(isFile) ?? null;
  const dirs = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const full = join(dir, name);
      if (isFile(full)) return full;
    }
  }
  return null;
}

const META = /([()\][%!^"`<>&|;, *?])/g;

// Bir argümanı CreateProcess/MSVCRT kurallarına göre tırnaklar.
export function quoteArg(arg) {
  const s = String(arg).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
  return `"${s}"`;
}

// cmd.exe için: MSVCRT tırnağı + metakarakter kaçırma. twice: argümanları %* ile başka komuta aktaran kabuk
// (npm'in ürettiği .cmd) satırı yeniden ayrıştırır, kaçırma iki kez gerekir.
export function cmdArg(arg, { twice = true } = {}) {
  let s = quoteArg(arg).replace(META, '^$1');
  if (twice) s = s.replace(META, '^$1');
  return s;
}

// Komut adı tırnaklanmaz, yalnız metakarakterleri kaçırılır (boşluk dahil).
export const cmdCommand = (file) => file.replace(META, '^$1');

const isBatch = (file) => /\.(cmd|bat)$/i.test(file);
const forwardsArgs = (file) => {
  try {
    return readFileSync(file, 'utf8').includes('%*');
  } catch {
    return true;
  }
};

// spawn'a verilecek [dosya, argümanlar, ek seçenekler]. Bulunamazsa ENOENT'i spawn üretsin diye komut aynen kalır.
export function resolveSpawn(command, args, { platform = process.platform, env = process.env } = {}) {
  if (platform !== 'win32') return [command, args, {}];
  const file = findExecutable(command, { platform, env }) ?? command;
  if (!isBatch(file)) return [file, args, {}];
  if (args.some((a) => /[\r\n]/.test(a))) throw new Error(`${command} bir .cmd kabuğu: çok satırlı argüman geçirilemez.`);
  const twice = forwardsArgs(file);
  const line = [cmdCommand(file), ...args.map((a) => cmdArg(a, { twice }))].join(' ');
  if (line.length > CMD_LINE_LIMIT) throw new Error(`${command} komut satırı cmd.exe sınırını aşıyor (${line.length} > ${CMD_LINE_LIMIT}); bağlamı küçült.`);
  return [env.ComSpec || env.COMSPEC || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { windowsVerbatimArguments: true }];
}

export function spawnCommand(command, args, options = {}) {
  const [file, argv, extra] = resolveSpawn(command, args, { env: options.env ?? process.env });
  return spawn(file, argv, { ...options, ...extra, windowsHide: true });
}

// Süreci çocuklarıyla durdurur. Windows'ta cmd.exe kabuğunu öldürmek altındaki süreci durdurmaz: taskkill /T.
// group: süreç kendi grubunda başlatıldıysa (detached, POSIX) bütün grup.
export function killTree(child, { group = false } = {}) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => undefined);
    } else if (group) process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGTERM');
  } catch {
    // Süreç zaten bitmiş olabilir.
  }
}

// Komut satırı sınırları: Windows'ta CreateProcess 32767 karakter (tüm satır, yol ve diğer argümanlar dahil),
// cmd.exe üzerinden 8191; macOS'ta ~1 MB.
const CMD_LINE_LIMIT = 8_000;
export const MAX_ARG_CHARS = process.platform === 'win32' ? 28_000 : 800_000;

export const onPath = (command) => Boolean(findExecutable(command));
