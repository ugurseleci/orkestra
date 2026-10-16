// Ajanların çalıştığı yer: deponun anahtarsız bir kopyası ve onu saran kum havuzu.
//
// Kopya: izlenen ve izlenmeyen (yok sayılmayan) dosyalar; .env* hiçbir biçimde girmez (.gitignore'da olsalar da
// ayrıca elenir). node_modules gerçek depodakine bağlanır (testleri çalıştırabilsinler; içinde anahtar yok).
// Kopya kendi git deposudur: ajanın yaptığı değişiklik "git diff" ile yama olarak alınır.
//
// Kum havuzu (macOS sandbox-exec): ajan CLI'ı ve çalıştırdığı her komut için geçerlidir.
//  - Okuma: ev klasörünün tamamı kapalı; yalnızca kopya, node_modules, CLI'ın kendi klasörü ve araç zinciri açık.
//    Gerçek depo (.env.local), ~/.ssh, ~/.supabase, anahtar zinciri ve belgeler okunamaz.
//  - Yazma: yalnızca kopya (salt okunur kipte o da kapalı; kopya geçici klasörde durduğu için ayrıca yasaklanır),
//    geçici klasörler ve CLI'ın oturum klasörü.
//  - Ağ açık: CLI modele ulaşmak zorunda. Bu yüzden ajan kopyadaki kodu dışarı gönderebilir; kod zaten modele
//    gidiyor. Anahtarlar kopyada olmadığı ve okunamadığı için gidemez.
// Codex'in kendi kum havuzu yalnızca yazmayı kısıtlıyor (okumayı değil; denendi), iç içe kum havuzu da açılamıyor:
// bu yüzden Codex kendi kum havuzu kapalı, bizimki açık çalışır.

import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const SECRET = /(^|\/)\.env(\.|$)/;

const git = (cwd, args, input) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', input, maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args[0]} başarısız: ${r.stderr}`);
  return r.stdout;
};

// Kopyayı kurar; { dir, cleanup } döner.
export function createWorkspace(root) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orkestra-work-')));
  const files = git(root, ['ls-files', '-co', '--exclude-standard', '-z'])
    .split('\0')
    .filter((f) => f && !SECRET.test(f) && existsSync(join(root, f)));
  for (const file of files) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    // Depodaki bağlantılar (ör. .claude/skills/<ad> → .agents/skills/<ad>) bağlantı olarak kopyalanır.
    if (lstatSync(join(root, file)).isSymbolicLink()) symlinkSync(readlinkSync(join(root, file)), join(dir, file));
    else cpSync(join(root, file), join(dir, file));
  }
  if (existsSync(join(root, 'node_modules'))) symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'));
  // Deponun kendi yok sayma kuralları geçerli kalır (araç önbellekleri yamaya girmesin); bağlantı ve anahtarlar eklenir.
  appendFileSync(join(dir, '.gitignore'), '\nnode_modules\n.env*\n');
  git(dir, ['init', '-q']);
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'user.name=orkestra', '-c', 'user.email=orkestra@localhost', 'commit', '-q', '-m', 'başlangıç']);
  return { dir, files: files.length, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// Ajanın kopyada yaptığı değişiklik (yeni dosyalar dahil), yama olarak. Değişiklik yoksa boş metin.
export function workspacePatch(dir) {
  git(dir, ['add', '-A']);
  return git(dir, ['diff', '--cached', '--binary', 'HEAD']);
}

const q = (path) => `"${path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

// write: kopyaya yazılabilsin mi. extraRead/extraWrite: CLI'ın kendi klasörleri.
export function sandboxProfile({ dir, root, write, extraRead = [], extraWrite = [] }) {
  const home = realpathSync(homedir());
  const read = [dir, join(realpathSync(root), 'node_modules'), ...extraRead].map((p) => `(subpath ${q(p)})`).join(' ');
  const writable = [...(write ? [dir] : []), ...extraWrite].map((p) => `(subpath ${q(p)})`).join(' ');
  return `(version 1)
(allow default)
(deny file-read* (subpath ${q(home)}))
(allow file-read* ${read})
(allow file-read-metadata (subpath ${q(home)}))
(deny file-write* (subpath "/"))
(allow file-write* (subpath "/private/tmp") (subpath "/private/var/folders") (subpath "/dev") ${writable})
${write ? '' : `(deny file-write* (subpath ${q(dir)}))\n`}`;
}
