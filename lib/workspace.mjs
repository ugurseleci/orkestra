// Ajanların çalıştığı yer: deponun anahtarsız bir kopyası ve onu saran kum havuzu.
//
// Kopya: izlenen ve izlenmeyen (yok sayılmayan) dosyalar. Gizli dosyalar (.env*, anahtar ve sertifika dosyaları,
// .npmrc vb.; bkz. SECRET_GLOBS) ve projenin ayarındaki agent.exclude desenleri hiçbir biçimde girmez.
// node_modules gerçek depodakine bağlanır (testleri çalıştırabilsinler; içinde anahtar yok).
//
// Git deposu kopyanın DIŞINDA durur (--git-dir): ajan kopyaya yazabildiği için .git/config'e komut çalıştıran
// bir ayar (core.fsmonitor, kanca) yazabilirdi; yama kum havuzu dışında alındığından o komut kullanıcının tam
// yetkisiyle çalışırdı. Git dizini kum havuzunda kapalıdır, yama komutları kancasız ve fsmonitor'suz koşar.
// Bedeli: kopyada "git status/diff" çalışmaz (kopya bir git deposu değildir).
//
// Kum havuzu (macOS sandbox-exec): ajan CLI'ı ve çalıştırdığı her komut için geçerlidir.
//  - Okuma: ev klasörünün ve gerçek deponun tamamı kapalı; yalnızca kopya, node_modules, CLI'ın kendi klasörü
//    ve araç zinciri açık. Gerçek depo (.env.local), ~/.ssh, anahtar zinciri ve belgeler okunamaz.
//  - Yazma: yalnızca kopya (salt okunur kipte o da kapalı), geçici klasörler ve CLI'ın oturum klasörü.
//  - Ağ: CLI ajanlarında açık (CLI modele ulaşmak zorunda). Orkestra'nın kendi döngüsünde (loop.mjs) modele
//    giden çağrıyı üst süreç yapar; komut aracı ağsız çalışır (network: false), yalnız yerel adresler açık.
// Codex'in kendi kum havuzu yalnızca yazmayı kısıtlıyor (okumayı değil; denendi), iç içe kum havuzu da açılamıyor:
// bu yüzden Codex kendi kum havuzu kapalı, bizimki açık çalışır.

import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';

// Kopyaya girmeyen, ajan araçlarının da okuyamadığı dosyalar.
export const SECRET_GLOBS = [
  '.env', '.env.*', '*.pem', '*.key', '*.p12', '*.pfx', '*.jks', '*.keystore', '*.mobileprovision',
  '.npmrc', '.pypirc', '.netrc', 'id_rsa*', 'id_ed25519*', 'id_ecdsa*',
];

// Basit glob: ** (klasörler dahil), * ve ? (klasör ayırıcısı hariç). Eğik çizgi içermeyen desen her klasörde
// dosya ya da klasör adıyla eşleşir (.gitignore gibi); eşleşen klasörün altındaki her şey de eşleşir.
// anchored: true ise desen her zaman köke bağlıdır (eğik çizgisiz ad da yalnız kökte eşleşir).
export function globToRegExp(glob, { anchored: forceAnchor = false, ignoreCase = false } = {}) {
  const g = glob.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
  const anchored = forceAnchor || g.includes('/');
  let src = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      if (g[i + 2] === '/') {
        src += '(?:.*/)?';
        i += 2;
      } else {
        src += '.*';
        i += 1;
      }
    } else if (c === '*') src += '[^/]*';
    else if (c === '?') src += '[^/]';
    else src += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(anchored ? `^${src}(?:/.*)?$` : `(?:^|/)${src}(?:/.*)?$`, ignoreCase ? 'i' : '');
}

// Claude'un seçtiği kapsam (--files): her girdi depo köküne bağlı bir yol ya da glob. "lib" klasörün tamamı,
// "lib/a.mjs" tek dosya, "src/**/*.ts" desen. Kökte olmayan adla eşleşmek için "**/" ile başla.
export function includeMatcher(entries) {
  const res = entries.map((e) => globToRegExp(e, { anchored: true }));
  return (path) => res.some((re) => re.test(path.replace(/\\/g, '/')));
}

// Ajanın değiştiremeyeceği yollar: değişiklik kendisini yargılayan denetimi değiştirememeli (kapı, mercek ve
// kontrol listesi ayarı .claude/ altında; CI tanımları). Proje ayarı agent.protect ile ekler.
export const PROTECTED_GLOBS = ['.claude', '.agents', '.orkestra', '.github', '.gitlab-ci.yml', '.circleci', 'CLAUDE.md', 'REVIEW.md'];
export const protectedMatcher = (extra = []) => {
  // Harfe duyarsız: macOS'ta ".CLAUDE/x" aynı klasöre yazar.
  const res = [...PROTECTED_GLOBS, ...extra].map((g) => globToRegExp(g, { ignoreCase: true }));
  return (path) => res.some((re) => re.test(path.replace(/\\/g, '/')));
};
// Test dosyaları: yazılabilir (test yazan ajan var) ama yama bunlara dokunursa Claude ayrıca bakar.
const TEST_RES = ['*.test.*', '*.spec.*', '*_test.*', 'test_*.py', 'test', 'tests', '__tests__', 'spec', 'integration_test'].map((g) => globToRegExp(g, { ignoreCase: true }));
export const isTestPath = (path) => TEST_RES.some((re) => re.test(path));

// Değişen dosyalar git'in kendisinden (yama başlığı ayrıştırılmaz: boşluklu ve Türkçe adlar tırnaklı yazılır,
// yeniden adlandırmada iki yol olur). --no-renames: taşınan dosyanın eski ve yeni yolu ayrı ayrı görünür.
// Her girdi { path, link }: link, değişiklik sonrası yolun sembolik bağlantı olup olmadığı (mod 120000).
export function workspaceChangedFiles(ws) {
  workspaceGit(ws, ['add', '-A']);
  const parts = workspaceGit(ws, ['-c', 'core.quotepath=false', 'diff', '--cached', '--raw', '--no-renames', '-z', 'HEAD']).split('\0');
  const out = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = parts[i].trim();
    if (!meta.startsWith(':')) continue;
    out.push({ path: parts[i + 1], link: meta.split(/\s+/)[1] === '120000' });
  }
  return out;
}

// Değişikliğin denetimi: korunan yola dokunan değişiklik reddedilir; test dosyalarına dokunuyorsa uyarı döner.
// files: workspaceChangedFiles çıktısı.
export function checkPatch(changes, { protect = [] } = {}) {
  const isProtected = protectedMatcher(protect);
  const entries = changes.map((c) => (typeof c === 'string' ? { path: c, link: false } : c));
  const files = entries.map((c) => c.path);
  // Ajanın eklediği ya da değiştirdiği bağlantı kapsamı ve korumayı aşmanın yolu olabilir (ör. kisayol → .claude).
  const links = entries.filter((c) => c.link).map((c) => c.path);
  if (links.length) throw new Error(`Yama reddedildi: ajan sembolik bağlantı ekleyemez (${links.join(', ')}). Gerekiyorsa Claude ekler.`);
  const blocked = files.filter(isProtected);
  if (blocked.length) {
    throw new Error(`Yama reddedildi: ajan kendi denetimini değiştiremez (${blocked.join(', ')}). Bu dosyaları gerekiyorsa Claude değiştirir.`);
  }
  const tests = files.filter(isTestPath);
  return tests.length ? `Uyarı: yama test dosyalarına dokunuyor (${tests.join(', ')}); testin gevşetilip gevşetilmediğine ayrıca bak.` : '';
}

// Yol (kopyaya göre, "/" ayırıcılı) gizli ya da dışlanmış mı.
export function excludedMatcher(extra = []) {
  const res = [...SECRET_GLOBS, ...extra].map(globToRegExp);
  return (path) => res.some((re) => re.test(path.replace(/\\/g, '/')));
}

const git = (cwd, args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git başarısız (${args.filter((a) => !a.startsWith('-')).slice(-2).join(' ')}): ${r.stderr}`);
  return r.stdout;
};

// Kopyanın git'i: dizin dışarıda, kanca ve fsmonitor kapalı (ajanın yazdığı hiçbir şey komut çalıştıramaz).
export function workspaceGit(ws, args) {
  return git(ws.dir, [
    '--git-dir', ws.gitDir, '--work-tree', ws.dir,
    '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${join(ws.gitDir, 'kanca-yok')}`, '-c', 'core.autocrlf=false',
    ...args,
  ]);
}

// Kopyayı kurar; { dir, gitDir, files, included, isExcluded, cleanup } döner. exclude: projenin agent.exclude desenleri.
// include: Claude'un seçtiği kapsam (--files); verilirse kopyaya yalnız bunlar girer, eşleşen dosya yoksa hata.
export function createWorkspace(root, { exclude = [], include } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orkestra-work-')));
  const gitDir = realpathSync(mkdtempSync(join(tmpdir(), 'orkestra-git-')));
  const isExcluded = excludedMatcher(exclude);
  const ws = {
    dir,
    gitDir,
    files: 0,
    isExcluded,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
      rmSync(gitDir, { recursive: true, force: true });
    },
  };
  try {
    const inScope = include ? includeMatcher(include) : () => true;
    const files = git(root, ['ls-files', '-co', '--exclude-standard', '-z'])
      .split('\0')
      .filter((f) => f && !isExcluded(f) && inScope(f) && existsSync(join(root, f)));
    if (include && !files.length) throw new Error(`--files ile seçilen hiçbir dosya kopyaya girmedi: ${include.join(', ')}`);
    const realRoot = realpathSync(root);
    const kept = [];
    for (const file of files) {
      const src = join(root, file);
      if (lstatSync(src).isSymbolicLink()) {
        // Bağlantı yalnız hedefi depo içinde, kapsamda ve gizli değilse taşınır (ör. .claude/skills/<ad> → .agents/skills/<ad>);
        // aksi halde kapsam dışı ya da depo dışı bir dosya (/tmp/…) bağlantı üzerinden okunabilirdi.
        let target;
        try {
          target = relative(realRoot, realpathSync(src)).split(sep).join('/');
        } catch {
          continue;
        }
        if (target.startsWith('..') || target === '' || isExcluded(target) || !inScope(target)) continue;
        mkdirSync(dirname(join(dir, file)), { recursive: true });
        symlinkSync(readlinkSync(src), join(dir, file));
      } else {
        mkdirSync(dirname(join(dir, file)), { recursive: true });
        cpSync(src, join(dir, file));
      }
      kept.push(file);
    }
    ws.included = kept;
    ws.files = kept.length;
    // node_modules yalnız Claude kapsama koyduysa bağlanır (testleri koşmak için); kapsam dışı hiçbir şey görünmez.
    ws.nodeModules = Boolean(include?.some((e) => e.replace(/^\.\//, '').split('/')[0] === 'node_modules')) && existsSync(join(root, 'node_modules'));
    if (!include) ws.nodeModules = existsSync(join(root, 'node_modules'));
    if (ws.nodeModules) symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'));
    git(dir, ['--git-dir', gitDir, 'init', '-q']);
    // Deponun kendi yok sayma kuralları geçerli kalır (araç önbellekleri yamaya girmesin); bağlantı ve gizliler eklenir.
    mkdirSync(join(gitDir, 'info'), { recursive: true });
    appendFileSync(join(gitDir, 'info', 'exclude'), `\nnode_modules\n${[...SECRET_GLOBS, ...exclude].join('\n')}\n`);
    workspaceGit(ws, ['add', '-A']);
    workspaceGit(ws, ['-c', 'user.name=orkestra', '-c', 'user.email=orkestra@localhost', 'commit', '-q', '--no-verify', '--allow-empty', '-m', 'başlangıç']);
  } catch (e) {
    ws.cleanup();
    throw e;
  }
  return ws;
}

// Ajanın kopyada yaptığı değişiklik (yeni dosyalar dahil), yama olarak. Değişiklik yoksa boş metin.
export function workspacePatch(ws) {
  workspaceGit(ws, ['add', '-A']);
  return workspaceGit(ws, ['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv', 'HEAD']);
}

// Yamadaki dosyalar.
export const patchFiles = (patch) => [...patch.matchAll(/^diff --git a\/(\S+)/gm)].map((m) => m[1]);

const q = (path) => `"${path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const sub = (paths) => paths.map((p) => `(subpath ${q(p)})`).join(' ');

// write: kopyaya yazılabilsin mi. extraRead/extraWrite: CLI'ın kendi klasörleri ve kullanıcının açtığı araç zinciri.
// gitDir: kopyanın git dizini; okumaya da yazmaya da kapanır.
// network: false ise dışarıya bağlantı kapalı (yerel adresler ve unix soketleri açık).
// tmp: verilirse ortak geçici klasörler yerine yalnız bu klasör yazılabilir. deny: okumaya ve yazmaya kapalı ek yollar
// (ör. profilin kendi klasörü).
// SBPL'de aynı işleme uyan son kural geçerlidir: yasaklar, ardından açılan istisnalar, en sonda kesin yasaklar.
// protect: kopyada yazmaya kapalı yollar (korunan denetim dosyaları; çalışma sırasında da değiştirilemesin).
// tmp verildiğinde ortak geçici klasörler okumaya da kapanır (başka oturumların dosyaları); kopya ve tmp açıktır.
export function sandboxProfile({ dir, gitDir, root, write, extraRead = [], extraWrite = [], network = true, tmp, deny = [], protect = [] }) {
  const home = realpathSync(homedir());
  const realRoot = realpathSync(root);
  const read = [dir, join(realRoot, 'node_modules'), ...(tmp ? [tmp] : []), ...extraRead];
  const writable = [...(write ? [dir] : []), ...extraWrite];
  const tmpRules = tmp ? sub([tmp]) : '(subpath "/private/tmp") (subpath "/private/var/folders")';
  const lines = [
    '(version 1)',
    '(allow default)',
    `(deny file-read* (subpath ${q(home)}))`,
    `(deny file-read* (subpath ${q(realRoot)}))`,
    // Ortak geçici klasörlerde içerik kapalı; üst dizin bilgisi (stat) açık, yoksa realpath ve Node açılışı düşer.
    ...(tmp ? ['(deny file-read* (subpath "/private/tmp") (subpath "/private/var/folders"))', '(allow file-read-metadata (subpath "/private/tmp") (subpath "/private/var/folders"))'] : []),
    `(allow file-read* ${sub(read)})`,
    `(allow file-read-metadata (subpath ${q(home)}))`,
    '(deny file-write* (subpath "/"))',
    `(allow file-write* ${tmpRules} (subpath "/dev") ${sub(writable)})`,
  ];
  if (!write) lines.push(`(deny file-write* (subpath ${q(dir)}))`);
  else if (protect.length) lines.push(`(deny file-write* ${protect.map((p) => `(subpath ${q(join(dir, p))})`).join(' ')})`);
  for (const p of [gitDir, ...deny].filter(Boolean)) lines.push(`(deny file-read* file-write* (subpath ${q(p)}))`);
  if (!network) {
    lines.push('(deny network-outbound)', '(allow network-outbound (remote ip "localhost:*"))', '(allow network-outbound (remote unix-socket))');
  }
  return `${lines.join('\n')}\n`;
}
