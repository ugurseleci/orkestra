// Abonelikle çalışan ajan CLI'ları (Codex, Gemini): orkestrada NVIDIA modelleriyle aynı arayüzden sorulur.
//
// Bu CLI'lar NVIDIA API'sinden farklı olarak ajan: dosya okuyup komut çalıştırabilirler. Bu yüzden
//  - Gemini, Antigravity CLI'ı (agy) üzerinden çalışır: Gemini CLI kişisel hesapla girişi artık kabul etmiyor,
//  - repoda değil, her çağrıda açılıp silinen boş bir geçici klasörde çalışırlar,
//  - Codex'in kabuk ve eklenti araçları kapalıdır (salt okunur sandbox tek başına diski okumayı engellemiyor;
//    denendi: package.json'ı okudu), agy başsız modda araç izinlerini reddeder,
//  - yalnızca gerekli ortam değişkenlerini alırlar (NVIDIA anahtarı vb. geçmez),
//  - soru stdin'den verilir; model repoyu göremez, bağlamı prompt'a koymak gerekir.
// Giriş bilgileri CLI'ların kendi yerlerinde (~/.codex, Antigravity); burada anahtar tutulmaz.
//
// İkinci yol (agentWork, dosyanın sonunda): ajan deponun anahtarsız kopyasında, kum havuzu içinde araçlarıyla
// çalışır. Kullanıcı kararı (13 Ekim 2026): ajanlar kopyayı okuyabilir ve orada kod/test yazabilir.

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { providers, resolvePath, userConfig } from './config.mjs';
import { createWorkspace, sandboxProfile, workspacePatch } from './workspace.mjs';

// Kısa ad → CLI ve model. "codex:gpt-5.5" gibi açık model de verilebilir.
// Codex'te model boşsa hesabın varsayılanı kullanılır (her planda aynı modeller yok). Kullanıcı kendi tercihini
// ~/.config/orkestra/config.json → "agents": { "codex": "<model>" } ile yazar.
const AGENT_MODELS = { codex: null, gemini: 'gemini-3.1-pro-high', 'gemini-flash': 'gemini-3.8-flash-medium', ...userConfig().agents };
export const AGENT_ALIASES = {
  codex: { cli: 'codex', model: AGENT_MODELS.codex }, // ~5-30 sn; güçlü kod reviewer'ı
  gemini: { cli: 'agy', model: AGENT_MODELS.gemini }, // Antigravity aboneliği; ~10-40 sn, geniş bağlam
  'gemini-flash': { cli: 'agy', model: AGENT_MODELS['gemini-flash'] }, // hızlı
};

export function isAgent(model) {
  return typeof model === 'string' && model.split(':')[0] in AGENT_ALIASES;
}

export function resolveAgent(model) {
  const [name, explicit] = model.split(':');
  const agent = AGENT_ALIASES[name];
  return { cli: agent.cli, model: explicit ?? agent.model };
}

export function agentLabel(model) {
  const { cli, model: m } = resolveAgent(model);
  return m ? `${cli}/${m}` : `${cli}`;
}

// Codex'te kapatılan araçlar (codex features list). Görsel ekleme (-i) araç değil, açık kalır.
const NO_TOOLS = ['shell_tool', 'unified_exec', 'code_mode_host', 'view_image', 'apps', 'plugins', 'browser_use', 'computer_use', 'multi_agent', 'image_generation', 'in_app_browser', 'hooks', 'skill_search', 'tool_suggest'];

// macOS'ta argüman sınırı ~1 MB; agy soruyu argümanla alıyor.
const MAX_ARG_BYTES = 800_000;
const NO_TOOLS_NOTE =
  'Hiçbir araç kullanma (komut, dosya okuma, arama yok): gereken tüm bağlam aşağıda. Yalnızca metinle cevap ver.';

// Alt sürece geçen ortam: giriş ve yollar için gerekenler, başka hiçbir şey.
const ENV_KEYS = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM'];
function childEnv() {
  const env = { NO_COLOR: '1' };
  for (const key of ENV_KEYS) if (process.env[key]) env[key] = process.env[key];
  return env;
}

function run(command, args, { input, cwd, timeoutMs }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Zaman aşımı (${Math.round(timeoutMs / 1000)} sn).`));
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e.code === 'ENOENT' ? new Error(`${command} kurulu değil.`) : e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });
    // Süreç stdin okunmadan çıkarsa EPIPE: sonuç 'close' ile gelir, hata süreci düşürmesin.
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
}

export async function agentChat({ model, prompt, system, images = [], timeoutMs, projectRoot }) {
  const { cli, model: modelId } = resolveAgent(model);
  const dir = mkdtempSync(join(tmpdir(), 'orkestra-'));
  const text = system ? `${system}\n\n${prompt}` : prompt;
  try {
    if (cli === 'codex') {
      const out = join(dir, 'answer.md');
      const args = ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config'];
      // Salt okunur sandbox diski okumaya izin veriyor: kabuk ve eklenti araçları kapalı, model yalnızca cevap yazar.
      for (const feature of NO_TOOLS) args.push('--disable', feature);
      args.push('-c', 'web_search="disabled"');
      args.push('--color', 'never', '-C', dir, '-o', out);
      if (modelId) args.push('-m', modelId);
      for (const image of images) args.push('-i', resolvePath(image));
      args.push('-');
      const { code, stderr } = await run('codex', args, { input: text, cwd: dir, timeoutMs });
      let answer = '';
      try {
        answer = readFileSync(out, 'utf8').trim();
      } catch {
        // Cevap dosyası yoksa aşağıdaki hata.
      }
      if (code !== 0 || !answer) throw new Error(lastLines(stderr) || `codex çıkış kodu ${code}`);
      return answer;
    }

    // Gemini: Antigravity CLI (agy). Başsız modda izin soramadığı için komut ve dosya okuma araçları kendiliğinden
    // reddedilir (denendi); model yalnızca cevap yazar. Görsel ekleme yolu yok: görseller Codex'e.
    if (images.length) throw new Error('gemini (agy) görsel almıyor; görsel inceleme için codex kullan.');
    if (Buffer.byteLength(text) > MAX_ARG_BYTES) throw new Error('Soru argüman sınırını aşıyor; bağlamı küçült.');
    const seconds = Math.max(10, Math.round(timeoutMs / 1000) - 5);
    const args = ['--sandbox', '--disable-slash-commands', '--output-format', 'json', '--print-timeout', `${seconds}s`];
    if (modelId) args.push('--model', modelId);
    // agy metin modunda stdin'i okumuyor; soru -p= ile verilir. Flash modeller bağlamı araçla aramaya kalkıyor
    // (reddedilince cevap boş kalıyor): araç kullanmaması baştan söylenir.
    args.push(`-p=${NO_TOOLS_NOTE}\n\n${text}`);
    const { code, stdout, stderr } = await run('agy', args, { input: '', cwd: dir, timeoutMs });
    const line = stdout.trim().split('\n').findLast((l) => l.startsWith('{'));
    let data = null;
    try {
      data = line ? JSON.parse(line) : null;
    } catch {
      // JSON değilse aşağıdaki hata.
    }
    const answer = data?.response?.trim();
    if (!answer && data?.denied_actions?.length) {
      throw new Error(`Model araç kullanmaya çalıştı (${data.denied_actions.map((d) => d.action).join(', ')}); bağlamı prompt'a koy.`);
    }
    if (code !== 0 || !answer) throw new Error(lastLines(stderr || stdout) || `agy çıkış kodu ${code}`);
    return answer;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- Depoda çalışan ajan -----------------------------------------------------------------------------------
//
// agentChat'ten farkı: ajan deponun anahtarsız kopyasını görür, komut çalıştırır (dosya okur, testi koşar) ve
// istenirse kopyada değişiklik yapar. Hepsi workspace.mjs'teki kum havuzunun içinde olur. Dönen değer: cevap,
// (yazma kipinde) yama ve token kullanımı. Yamayı gerçek depoya uygulamak ve doğrulamak Claude'un işidir.

// CLI'ların giriş ve oturum klasörleri: kum havuzunda ev klasöründen yalnızca bunlar açılır.
// agy girişini macOS anahtar zincirinde tutuyor: dosyayı okuyamazsa "authentication required" der (denendi).
// Anahtar zinciri dosyası şifrelidir ve kayıtlara erişimi sistem denetler, ama dosyanın kendisi okunabilir olur;
// bu yüzden yalnızca okumaya açılır ve yalnızca agy için.
const CLI_DIRS = {
  codex: { write: ['.codex'], read: [] },
  agy: { write: ['.antigravity', '.gemini', 'Library/Application Support/Antigravity'], read: ['.local/bin', 'Library/Keychains'] },
};

const WORK_NOTE = {
  read: 'Bu klasör projenin bir kopyası. Dosyaları oku ve gerekirse komut çalıştır (ör. ilgili testler); hiçbir dosyayı değiştirme. Bulduklarını metinle yaz.',
  write:
    'Bu klasör projenin bir kopyası. İstenen değişikliği burada yap; bitince projenin ilgili testlerini ve tip/lint denetimini çalıştır. Paket kurma, ağ isteği atma, git commit yapma. Sonunda ne yaptığını, hangi dosyaları değiştirdiğini ve testlerin sonucunu kısaca yaz.',
};

// web: Codex'in web araması açılır (araştırma görevleri). Kapalıyken de ağ açıktır; fark, modelin arama aracıdır.
export async function agentWork({ model, prompt, system, write = false, web = false, timeoutMs, projectRoot }) {
  // Kum havuzu macOS'un sandbox-exec'i: başka sistemde ajan depoyu güvenle göremez, danışman kipi (ask/panel) kullanılır.
  if (!providers().sandbox) throw new Error('Depoda çalışan ajan yalnızca macOS\'ta (sandbox-exec). Bu sistemde ask/panel/review kullan.');
  const { cli, model: modelId } = resolveAgent(model);
  const workspace = createWorkspace(projectRoot);
  const scratch = mkdtempSync(join(tmpdir(), 'orkestra-'));
  const home = homedir();
  const writable = CLI_DIRS[cli].write.map((d) => join(home, d));
  const readable = [...writable, ...CLI_DIRS[cli].read.map((d) => join(home, d))];
  const profile = join(scratch, 'profile.sb');
  writeFileSync(profile, sandboxProfile({ dir: workspace.dir, root: projectRoot, write, extraRead: readable, extraWrite: writable }));
  const text = [system, WORK_NOTE[write ? 'write' : 'read'], prompt].filter(Boolean).join('\n\n');
  try {
    let answer = '';
    let usage = null;
    if (cli === 'codex') {
      const out = join(scratch, 'answer.md');
      // Codex'in kendi kum havuzu kapalı (iç içe açılamıyor, okumayı da kısıtlamıyor); sınırı dıştaki koyar.
      const args = ['-f', profile, 'codex', 'exec', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config'];
      args.push('-c', `web_search="${web ? 'live' : 'disabled'}"`, '--color', 'never', '--json', '-C', workspace.dir, '-o', out);
      if (modelId) args.push('-m', modelId);
      args.push('-');
      const { code, stdout, stderr } = await run('sandbox-exec', args, { input: text, cwd: workspace.dir, timeoutMs });
      try {
        answer = readFileSync(out, 'utf8').trim();
      } catch {
        // Cevap dosyası yoksa aşağıdaki hata.
      }
      if (code !== 0 || !answer) throw new Error(lastLines(stderr) || `codex çıkış kodu ${code}`);
      // Son "turn.completed" olayı toplam kullanımı taşır.
      for (const line of stdout.split('\n')) {
        if (!line.includes('"turn.completed"')) continue;
        try {
          const u = JSON.parse(line).usage;
          usage = { input: u.input_tokens ?? 0, cached: u.cached_input_tokens ?? 0, output: (u.output_tokens ?? 0) + (u.reasoning_output_tokens ?? 0) };
        } catch {
          // Biçim değiştiyse kullanım boş kalır.
        }
      }
    } else {
      if (Buffer.byteLength(text) > MAX_ARG_BYTES) throw new Error('Soru argüman sınırını aşıyor; bağlamı küçült.');
      const seconds = Math.max(10, Math.round(timeoutMs / 1000) - 5);
      const args = ['-f', profile, 'agy', '--dangerously-skip-permissions', '--disable-slash-commands', '--output-format', 'json', '--print-timeout', `${seconds}s`];
      if (modelId) args.push('--model', modelId);
      args.push(`-p=${text}`);
      const { code, stdout, stderr } = await run('sandbox-exec', args, { input: '', cwd: workspace.dir, timeoutMs });
      const line = stdout.trim().split('\n').findLast((l) => l.startsWith('{'));
      let data = null;
      try {
        data = line ? JSON.parse(line) : null;
      } catch {
        // JSON değilse aşağıdaki hata.
      }
      answer = data?.response?.trim() ?? '';
      if (code !== 0 || !answer) throw new Error(lastLines(stderr || stdout) || `agy çıkış kodu ${code}`);
      const u = data?.usage ?? null;
      if (u) usage = { input: u.input_tokens ?? 0, cached: u.cache_read_input_tokens ?? u.cache_read_tokens ?? 0, output: (u.output_tokens ?? 0) + (u.thinking_tokens ?? 0) };
    }
    return { answer, usage, patch: write ? workspacePatch(workspace.dir) : '' };
  } finally {
    workspace.cleanup();
    rmSync(scratch, { recursive: true, force: true });
  }
}

function lastLines(text, n = 5) {
  return text.trim().split('\n').slice(-n).join('\n');
}
