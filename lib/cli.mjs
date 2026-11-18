#!/usr/bin/env node
// Orkestra CLI: modellere terminalden soru sorar. Soru stdin'den okunur. Eklentide `orkestra <komut>` olarak çağrılır.
//
//   git diff | orkestra panel --models code,step --system "Kıdemli reviewer'sın..."
//   echo "soru" | orkestra ask --model fast
//   echo "Arayüzde sorun var mı?" | orkestra ask --model codex --image ekran.jpg
//   echo "İstasyon bulunamadı" | orkestra translate --from tr --to en
//
// Ajanlar: --model codex / gemini / gemini-flash (ya da codex:<model>); panelde NVIDIA modelleriyle karışık kullanılabilir.
// Depoda ajan: orkestra agent --model codex|gemini (CLI) ya da --model code|<sağlayıcı:model> (Orkestra'nın araç döngüsü).
// Seçenekler: --model <ad>  --models <a,b,c>  --system <metin>  --max-tokens <n>  --timeout <sn>
//             --image <yol> (tekrarlanabilir)  --from <dil>  --to <dil>  --task <panodaki iş adı>
//             --input <dosya> (stdin yerine; PowerShell'de bunu kullan)
//             agent: --files <yol,glob> (zorunlu)  --write  --skill <ad>  --web (codex)  --tools read,search,run,write  --max-steps <n>
//
// Hat (iş → tasarım → yapım → bütünleştirme → inceleme → birleştirme):
//   orkestra job start --title "…"                               iş açar (aynı anda tek iş)
//   orkestra note --stage design --role architect --task "…" [--status done]
//   cat tasarim.md | orkestra critic --round 1                    eleştirmen paneli: engeller / uyarılar / eksik kanıt
//   orkestra note --stage design --role critic --round 1 --verdict sent_back --reason "…"   kararı Claude yazar
//   orkestra note --stage build --role implementer|tester [--pkg 2] --task "…" [--status done]
//   orkestra gate                                                 tip, lint, birim (+ varsa entegrasyon, uçtan uca)
//   (bağlam; git diff) | orkestra review --round 1                mercekli inceleme (mercekler modellere paylaştırılır)
//   orkestra note --stage review --role fix --round 1 --task "…" [--status done]
//   orkestra note --stage merge --role pr --task "PR #8" --status done
//   orkestra job done [--status merged|closed]                    birleştirmeyi insan yapar; sonra kapatılır
// ask/panel çağrıları da --stage --role --round --pkg alır.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

import { agentSettings, loopAgentWork, savePatch, stopText } from './agent-run.mjs';
import { agentLabel, agentWork, isAgent } from './agents.mjs';
import { decodeText, defaultAskModel, defaultReviewers, ensureStateDir, modelAvailable, NO_MODELS, PROJECT_ROOT, projectConfig, resolvePath } from './config.mjs';
import { currentJob, EVENTS_FILE, logEvent, setCurrentJob, tracked } from './events.mjs';
import { assignLenses, CRITIC_SYSTEM, LENS_KEYS, LENSES, MAX_DESIGN_ROUNDS, projectLensNotes, reviewSystem, splitByLens } from './lenses.mjs';
import { chat, DEFAULT_PANEL, panel, resolveModel, timed, translate } from './nvidia.mjs';
import { patchFiles } from './workspace.mjs';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    model: { type: 'string' },
    models: { type: 'string' },
    system: { type: 'string' },
    'max-tokens': { type: 'string' },
    timeout: { type: 'string' },
    image: { type: 'string', multiple: true },
    from: { type: 'string', default: 'tr' },
    to: { type: 'string', default: 'en' },
    task: { type: 'string' },
    actor: { type: 'string', default: 'claude' },
    status: { type: 'string' },
    title: { type: 'string' },
    job: { type: 'string' },
    stage: { type: 'string' },
    role: { type: 'string' },
    round: { type: 'string' },
    pkg: { type: 'string' },
    verdict: { type: 'string' },
    reason: { type: 'string' },
    lenses: { type: 'string' },
    skill: { type: 'string', multiple: true },
    input: { type: 'string' },
    write: { type: 'boolean', default: false },
    'max-steps': { type: 'string' },
    tools: { type: 'string' },
    files: { type: 'string', multiple: true },
    web: { type: 'boolean', default: false },
  },
});

const [mode, action] = positionals;
const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(2);
};

const STAGES = ['design', 'build', 'integrate', 'review', 'merge'];
if (values.stage && !STAGES.includes(values.stage)) fail(`--stage şunlardan biri olmalı: ${STAGES.join(', ')}`);
if (values.verdict && !['approved', 'sent_back'].includes(values.verdict)) fail('--verdict approved ya da sent_back olmalı.');
const round = values.round ? Number(values.round) : undefined;
if (values.round && !(Number.isInteger(round) && round >= 1)) fail('--round 1 ya da daha büyük bir tam sayı olmalı.');
// Hat alanları: yalnızca verilenler yazılır.
const meta = Object.fromEntries(
  Object.entries({ job: values.job, stage: values.stage, role: values.role, round, pkg: values.pkg }).filter(([, v]) => v != null)
);

if (mode === 'job') {
  const open = currentJob();
  if (action === 'start') {
    if (!values.title) fail('job start için --title gerekli.');
    if (open) fail(`Açık iş var: "${open.title}". Önce: orkestra job done --status merged|closed`);
    const job = { job: `j${Date.now().toString(36)}`, title: values.title };
    setCurrentJob(job);
    logEvent({ type: 'job', actor: values.actor, ...job, status: 'open' });
    process.stdout.write(`${job.job}\n`);
  } else if (action === 'done') {
    const status = values.status ?? 'merged';
    if (!['merged', 'closed'].includes(status)) fail('job done için --status merged ya da closed olmalı.');
    if (!open) fail('Açık iş yok.');
    logEvent({ type: 'job', actor: values.actor, ...open, status });
    setCurrentJob(null);
  } else if (action === 'status') {
    process.stdout.write(open ? `${open.job}  ${open.title}\n` : 'Açık iş yok.\n');
  } else fail('Kullanım: orkestra job start --title "…" | job done [--status merged|closed] | job status');
  process.exit(0);
}

// Token kullanımı: orkestra usage → model başına çağrı, süre ve (kaydı olanlarda) token toplamı.
// Yalnızca depoda çalışan ajan çağrıları token bildirir; danışman çağrılarında ve Claude'da kayıt yoktur.
if (mode === 'usage') {
  const events = existsSync(EVENTS_FILE)
    ? readFileSync(EVENTS_FILE, 'utf8').split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean)
    : [];
  const starts = new Map(events.filter((e) => e.type === 'start').map((e) => [e.id, e]));
  const totals = new Map();
  for (const e of events) {
    const start = e.type === 'end' ? starts.get(e.id) : null;
    if (!start || !start.model || !['codex', 'gemini', 'nvidia'].includes(start.actor)) continue;
    const t = totals.get(start.model) ?? { calls: 0, ok: 0, seconds: 0, measured: 0, input: 0, cached: 0, output: 0 };
    t.calls++;
    if (e.ok) t.ok++;
    t.seconds += e.seconds ?? 0;
    if (e.usage) {
      t.measured++;
      t.input += e.usage.input ?? 0;
      t.cached += e.usage.cached ?? 0;
      t.output += e.usage.output ?? 0;
    }
    totals.set(start.model, t);
  }
  const n = (v) => String(v).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  process.stdout.write('model | çağrı (başarılı) | toplam süre | token ölçülen çağrı | giriş (önbellekten) | çıkış\n');
  for (const [model, t] of [...totals].sort((a, b) => b[1].input + b[1].output - (a[1].input + a[1].output) || b[1].calls - a[1].calls)) {
    process.stdout.write(`${model} | ${t.calls} (${t.ok}) | ${Math.round(t.seconds / 60)} dk | ${t.measured} | ${n(t.input)} (${n(t.cached)}) | ${n(t.output)}\n`);
  }
  // Hesap geneli kullanım ve kota: OpenUsage menü çubuğu uygulaması açıksa yerel arayüzünden okunur
  // (http://127.0.0.1:6736/v1/usage). Rakamlar bu projeye değil hesabın tamamına aittir; tutarlar abonelik
  // ücreti değil, aynı kullanımın liste fiyatıyla karşılığıdır.
  try {
    const providers = await (await fetch('http://127.0.0.1:6736/v1/usage', { signal: AbortSignal.timeout(3000) })).json();
    process.stdout.write('\nHesap geneli (OpenUsage):\n');
    for (const p of providers) {
      const line = (label) => p.lines?.find((l) => l.label === label);
      const quota = ['Session', 'Weekly'].map((label) => (line(label) ? `${label === 'Session' ? 'oturum' : 'hafta'} %${line(label).used}` : null)).filter(Boolean).join(', ');
      const month = line('Last 30 Days');
      process.stdout.write(`${p.displayName} (${p.plan ?? '-'}) | kota: ${quota || '-'} | son 30 gün: ${month ? (month.value ?? month.text ?? '-') : '-'}\n`);
    }
  } catch {
    process.stdout.write('\nHesap geneli kullanım için OpenUsage açık olmalı.\n');
  }
  process.exit(0);
}

// Claude'un kendi aşamaları panoya: orkestra note --task "Uygulama: …" [--status start|done] [--actor claude]
if (mode === 'note') {
  if (!values.task && !values.stage) fail('note için --task ya da --stage gerekli.');
  if (values.verdict === 'sent_back' && !values.reason) fail('Geri gönderme için --reason gerekli.');
  logEvent({
    type: 'note',
    actor: values.actor,
    task: values.task ?? `${values.stage}: ${values.role ?? ''}`,
    // Karar olayı anlıktır; aşama notu başlar ve --status done ile biter.
    status: values.status ?? (values.verdict ? 'done' : 'start'),
    ...meta,
    verdict: values.verdict,
    reason: values.reason,
  });
  process.exit(0);
}

if (!['ask', 'panel', 'translate', 'critic', 'review', 'agent'].includes(mode)) {
  fail(
    'Kullanım: <prompt> | orkestra ask|panel|translate|critic|review|agent [--model m] [--models a,b] [--image yol]\n' +
      '          orkestra job start|done|status · orkestra note --task "…" · orkestra usage\n' +
      '          orkestra gate [--e2e] · orkestra dashboard [--port 4545] · orkestra doctor [--live] · orkestra init'
  );
}
if (mode === 'critic' && round > MAX_DESIGN_ROUNDS) {
  fail(`Tasarım ${MAX_DESIGN_ROUNDS} turda onaylanamadı: karar kullanıcıya sorulmalı, yeni tur açılmaz.`);
}

// Soru stdin'den ya da --input <dosya> ile. Dosya yolu PowerShell için: PowerShell 5.1 yerel komuta pipe ederken
// Türkçe karakterleri bozabiliyor. Dosya UTF-8 (BOM'lu ya da BOM'suz) ya da UTF-16 LE (PowerShell'in Out-File'ı) olabilir.
let prompt = '';
if (values.input) {
  let data;
  try {
    data = readFileSync(resolvePath(values.input));
  } catch (e) {
    fail(`--input okunamadı: ${e.message}`);
  }
  prompt = decodeText(data);
} else {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  prompt = decodeText(Buffer.concat(chunks));
}
if (!prompt.trim()) fail('Soru boş: stdin ya da --input <dosya> bekleniyor.');

const maxTokens = values['max-tokens'] ? Number(values['max-tokens']) : undefined;
const timeoutMs = values.timeout ? Number(values.timeout) * 1000 : undefined;
const models = values.models ? values.models.split(',').map((m) => m.trim()) : null;
// Genel panel: NVIDIA anahtarı varsa NVIDIA paneli, yoksa kurulu ajanlar.
const defaultPanel = () => {
  const nvidia = DEFAULT_PANEL.filter((m) => modelAvailable(m));
  return nvidia.length ? nvidia : reviewers();
};
// Eleştirmen ve inceleme paneli: --models verilmediyse kurulu sağlayıcılardan seçilir.
const reviewers = () => {
  const list = models ?? defaultReviewers();
  if (!list.length) fail(NO_MODELS);
  return list;
};

// Depoda çalışan ajan: deponun anahtarsız kopyasında (bkz. workspace.mjs). Kopyaya yalnız Claude'un --files ile seçtiği
// dosyalar girer (köke bağlı yol ya da glob: "lib", "lib/a.mjs", "src/**/*.ts"). Yama korunan dosyaya (.claude/, CI,
// CLAUDE.md, agent.protect) dokunursa reddedilir: değişiklik kendisini yargılayan denetimi değiştiremez.
//   echo "görev" | orkestra agent --model codex --skill test-yazari --write --task "…"
//   echo "soru"  | orkestra agent --model code [--tools read,search] [--max-steps 30]
// codex / gemini / gemini-flash: CLI kendi araçlarıyla, bütünüyle kum havuzunda (agents.mjs → agentWork).
// Diğer her model (NVIDIA ya da OpenAI uyumlu): Orkestra'nın kendi araç döngüsü (agent-run.mjs → loop.mjs).
//   --tools: araç kümeleri read, search, run, write (varsayılan read,search + macOS'ta run). --max-steps: model çağrı sınırı.
// --skill: projedeki .agents/skills/<ad>/SKILL.md ya da .claude/skills/<ad>/SKILL.md (uzmanlık talimatı; tekrarlanabilir).
// --web: Codex'te web araması açılır. --write: kopyada değişiklik yapabilir;
// yama .orkestra/patches/ altına yazılır, gerçek depoya Claude inceleyip uygular (git apply).
if (mode === 'agent') {
  const ROOT = PROJECT_ROOT;
  const settings = agentSettings();
  const model = values.model ?? settings.model;
  const loop = !isAgent(model);
  if (!loop && (values['max-steps'] || values.tools)) fail('--max-steps ve --tools yalnız Orkestra döngüsünde (codex/gemini dışındaki modeller).');
  if (loop && values.web) fail('--web yalnız codex ile; Orkestra döngüsünde web aracı yok.');
  const maxSteps = values['max-steps'] ? Number(values['max-steps']) : undefined;
  if (values['max-steps'] && !(Number.isInteger(maxSteps) && maxSteps >= 1)) fail('--max-steps 1 ya da daha büyük bir tam sayı olmalı.');
  // Modele hangi dosyanın gideceğine Claude karar verir: kopyaya yalnız --files ile seçilenler girer.
  const include = (values.files ?? []).flatMap((f) => f.split(',')).map((f) => f.trim()).filter(Boolean);
  if (!include.length) fail('agent için --files gerekli: modele gidecek dosya ve klasörleri Claude seçer (ör. --files lib/events.mjs,test).');
  const sets = values.tools ? values.tools.split(',').map((t) => t.trim()).filter(Boolean) : undefined;
  const skills = (values.skill ?? []).map((name) => {
    const file = ['.agents', '.claude'].map((d) => join(ROOT, d, 'skills', name, 'SKILL.md')).find((f) => existsSync(f));
    if (!file) fail(`Skill yok: .agents/skills/${name}/SKILL.md ya da .claude/skills/${name}/SKILL.md`);
    // Baştaki --- … --- üstbilgisi modele gitmez.
    return `# Uzmanlık: ${name}\n\n${readFileSync(file, 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '').trim()}`;
  });
  const system = [values.system, ...skills].filter(Boolean).join('\n\n---\n\n') || undefined;
  const label = loop ? resolveModel(model) : agentLabel(model);
  try {
    const result = await tracked(
      {
        model,
        label,
        task: values.task ?? `Ajan: ${(values.skill ?? []).join(', ') || 'görev'}`,
        meta: { ...meta, role: meta.role ?? values.skill?.[0], agent: true, skills: values.skill ?? [], write: values.write, scope: include, ...(loop ? { engine: 'loop' } : {}) },
      },
      async ({ id }) => {
        if (loop) {
          const r = await loopAgentWork({
            model,
            prompt,
            system,
            write: values.write,
            include,
            sets,
            maxSteps,
            maxTokens,
            timeoutMs: timeoutMs ?? 600_000,
            projectRoot: ROOT,
            settings,
            // Adım olayları panoya; içerik ve çıktı yazılmaz, yalnız araç adı ve kısa özet.
            onEvent: (e) => logEvent({ type: 'step', id, ...e }),
          });
          return { text: r.answer || '(cevap yok)', usage: r.usage, patch: r.patch, warning: r.warning, scope: r.scope, files: patchFiles(r.patch), stop: r.stop, steps: r.steps, toolCalls: r.toolCalls };
        }
        const r = await agentWork({ model, prompt, system, write: values.write, web: values.web, include, timeoutMs: timeoutMs ?? 600_000, projectRoot: ROOT });
        return { text: r.answer, usage: r.usage, patch: r.patch, warning: r.warning, scope: r.scope, files: patchFiles(r.patch) };
      }
    );
    const u = result.usage;
    const parts = [
      label,
      result.steps != null ? `${result.steps} adım · ${result.toolCalls} araç` : null,
      u ? `${u.input} giriş (${u.cached} önbellek) + ${u.output} çıkış token` : null,
      result.stop ? `durdu: ${stopText(result.stop)}` : null,
    ].filter(Boolean);
    process.stdout.write(`[${parts.join(' · ')}]\nKapsam (${result.scope.length} dosya): ${result.scope.slice(0, 20).join(', ')}${result.scope.length > 20 ? ' …' : ''}\n\n${result.text}\n`);
    if (values.write) {
      if (result.patch.trim()) {
        const { file, files } = savePatch(result.patch, model);
        process.stdout.write(`\nYama: ${file}\nDosyalar: ${files.join(', ')}\n${result.warning ? `${result.warning}\n` : ''}İncele, sonra uygula: git apply --3way "${file}"\n`);
      } else process.stdout.write('\nYama yok: ajan dosya değiştirmedi.\n');
    }
  } catch (e) {
    process.stderr.write(`HATA: ${e.message ?? e}\n`);
    process.exit(1);
  }
  process.exit(0);
}

try {
  if (mode === 'translate') {
    process.stdout.write(`${await translate({ text: prompt.trim(), from: values.from, to: values.to, timeoutMs })}\n`);
  } else if (mode === 'ask') {
    const model = values.model ?? defaultAskModel();
    if (!model) fail(NO_MODELS);
    const { value, seconds } = await timed(() =>
      chat({ model, prompt, system: values.system, images: values.image, maxTokens, timeoutMs, task: values.task, meta })
    );
    process.stdout.write(`[${resolveModel(model)} · ${seconds} sn]\n\n${value}\n`);
  } else if (mode === 'panel') {
    process.stdout.write(
      `${await panel({ prompt, models: models ?? defaultPanel(), system: values.system, maxTokens, timeoutMs, task: values.task, meta })}\n`
    );
  } else if (mode === 'critic') {
    const r = round ?? 1;
    const out = await panel({
      prompt,
      models: reviewers(),
      system: CRITIC_SYSTEM,
      maxTokens: maxTokens ?? 5000,
      timeoutMs: timeoutMs ?? 300_000,
      task: values.task ?? `Eleştirmen: tur ${r}`,
      meta: { ...meta, stage: 'design', role: 'critic', round: r },
    });
    process.stdout.write(`${out}\n\nKararı yaz: orkestra note --stage design --role critic --round ${r} --verdict approved|sent_back [--reason "…"]\n`);
  } else {
    const r = round ?? 1;
    const lenses = values.lenses ? values.lenses.split(',').map((l) => l.trim()) : LENS_KEYS;
    const unknown = lenses.filter((l) => !LENSES[l]);
    if (unknown.length) fail(`Bilinmeyen mercek: ${unknown.join(', ')} (${LENS_KEYS.join(', ')})`);
    const base = { ...meta, stage: 'review', round: r };
    const context = { role: projectConfig().reviewer, notes: projectLensNotes() };
    const results = await Promise.all(
      assignLenses(reviewers(), lenses).map(async (part) => {
        const label = resolveModel(part.model);
        let text;
        try {
          text = await chat({
            model: part.model,
            prompt,
            system: reviewSystem(part.lenses, context),
            maxTokens: maxTokens ?? 6000,
            timeoutMs: timeoutMs ?? 300_000,
            task: values.task ?? `İnceleme: tur ${r}`,
            meta: { ...base, role: 'reviewer', lenses: part.lenses },
          });
        } catch (e) {
          text = null;
          for (const lens of part.lenses) {
            logEvent({ type: 'lens', ...base, role: lens, model: label, outcome: 'skipped', text: `Çağrı başarısız: ${e.message ?? e}` });
          }
          return `### ${label} — HATA\n\n${e.message ?? e}`;
        }
        // Mercek sonuçları: bulgu varsa kol turuncu, yoksa yeşil. Bulguları doğrulamak yine Claude'un işi.
        for (const section of splitByLens(text, part.lenses)) {
          logEvent({ type: 'lens', ...base, role: section.lens, model: label, outcome: section.outcome, text: section.text });
        }
        return `### ${label} · ${part.lenses.join(', ')}\n\n${text}`;
      })
    );
    process.stdout.write(`${results.join('\n\n---\n\n')}\n`);
  }
} catch (e) {
  process.stderr.write(`HATA: ${e.message ?? e}\n`);
  process.exit(1);
}
