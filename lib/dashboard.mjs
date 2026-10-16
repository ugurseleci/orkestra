#!/usr/bin/env node
// Orkestra panosu: açık işin hattı (iş → tasarım → yapım → bütünleştirme → inceleme → birleştirme) akış şeması
// olarak, canlı. Altında biten işler. .orkestra/events.jsonl dosyasını izler.
//
//   orkestra dashboard [--port 4545]  →  http://localhost:4545
//
// Yalnızca 127.0.0.1'de dinler; dışarıya bir şey gönderilmez.

import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { PROJECT_ROOT } from './config.mjs';
import { EVENTS_FILE } from './events.mjs';

const { values } = parseArgs({ options: { port: { type: 'string', default: '4545' } } });
const PORT = Number(values.port);
const POLL_MS = 500;
// Panoya ilk açılışta gönderilen geçmiş: tarih sınırı yok, son olaylar (günler önceki işler de görünür).
const MAX_HISTORY = 2000;

function readFrom(offset) {
  let size = 0;
  try {
    size = statSync(EVENTS_FILE).size;
  } catch {
    return { lines: [], offset: 0 };
  }
  if (size < offset) offset = 0; // dosya silinip yeniden başladı
  if (size === offset) return { lines: [], offset };
  const fd = openSync(EVENTS_FILE, 'r');
  const buffer = Buffer.alloc(size - offset);
  readSync(fd, buffer, 0, buffer.length, offset);
  closeSync(fd);
  const text = buffer.toString('utf8');
  // Yarım yazılmış son satır bir sonraki turda okunur.
  const end = text.lastIndexOf('\n') + 1;
  return { lines: text.slice(0, end).split('\n').filter(Boolean), offset: offset + Buffer.byteLength(text.slice(0, end)) };
}

// Projenin skill'leri: .agents/skills (yoksa .claude/skills) altındaki SKILL.md üstbilgisinden ad ve açıklama;
// kaynağı varsa README'deki tablodan.
const SKILLS_DIR = ['.agents', '.claude'].map((d) => join(PROJECT_ROOT, d, 'skills')).find((d) => existsSync(d)) ?? join(PROJECT_ROOT, '.agents', 'skills');
function skills() {
  if (!existsSync(SKILLS_DIR)) return [];
  let readme = '';
  try {
    readme = readFileSync(join(SKILLS_DIR, 'README.md'), 'utf8');
  } catch {
    // README yoksa hepsi "bizim" görünür.
  }
  const external = readme.split('## Dışarıdan alınanlar')[1] ?? '';
  const ours = readme.split('## Dışarıdan alınanlar')[0];
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(SKILLS_DIR, d.name, 'SKILL.md')))
    .map((d) => {
      const head = readFileSync(join(SKILLS_DIR, d.name, 'SKILL.md'), 'utf8').match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
      // Açıklama tek satır, tırnaklı ya da katlanmış (">") olabilir.
      const raw = head.match(/^description:\s*(?:>-?\s*\n)?([\s\S]*?)(?=\n[a-zA-Z-]+:|$)/m)?.[1] ?? '';
      const description = raw.replace(/\s+/g, ' ').trim().replace(/^["']|["']$/g, '');
      const who = ours.match(new RegExp('\\| ' + d.name + ' \\| ([^|]+) \\|'))?.[1]?.trim() ?? null;
      const source = external.match(new RegExp('[|,] ?[^|]*\\b' + d.name + '\\b[^|]*\\| ([^|]+) \\|'))?.[1]?.trim() ?? null;
      return { name: d.name, description, who, source: who ? null : source };
    })
    .sort((a, b) => Number(!!a.source) - Number(!!b.source) || a.name.localeCompare(b.name, 'tr'));
}

const server = createServer((req, res) => {
  if (req.url === '/skills') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(skills()));
    return;
  }
  if (req.url === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    let { lines, offset } = readFrom(0);
    const history = lines.slice(-MAX_HISTORY).filter((line) => {
      try {
        JSON.parse(line);
        return true;
      } catch {
        return false;
      }
    });
    res.write(`event: history\ndata: [${history.join(',')}]\n\n`);
    const timer = setInterval(() => {
      const next = readFrom(offset);
      offset = next.offset;
      for (const line of next.lines) res.write(`data: ${line}\n\n`);
    }, POLL_MS);
    req.on('close', () => clearInterval(timer));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(PAGE);
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`Orkestra panosu (${PROJECT_ROOT}): http://localhost:${PORT}\n`);
});

const PAGE = /* html */ `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Orkestra</title>
<style>
  :root {
    --bg: #f6f7f6; --panel: #ffffff; --text: #16211d; --muted: #6b7772; --line: #e2e6e3; --soft: #eef1ef; --idle: #d3d9d5;
    --codex: #10a37f; --gemini: #4f7cf6; --nvidia: #76b900; --claude: #d97757; --gate: #7a8580;
    --ok: #1f9d77; --err: #d84a3a; --run: #4a55d9; --back: #c96a36;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #0f1412; --panel: #171e1b; --text: #e9efec; --muted: #93a19b; --line: #26302c; --soft: #1e2723; --idle: #36423d; --run: #8089ff; --back: #e08a56; --ok: #37b890; }
  }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  header { display: flex; align-items: center; gap: 12px; padding: 14px 24px; border-bottom: 1px solid var(--line); position: sticky; top: 0; background: var(--bg); z-index: 2; }
  h1 { font-size: 17px; margin: 0; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--err); }
  .dot.on { background: var(--ok); }
  .pill { margin-left: auto; display: inline-flex; align-items: center; gap: 8px; padding: 5px 12px; border-radius: 999px; background: var(--soft); color: var(--muted); font-size: 13px; font-weight: 600; transition: background .3s, color .3s; }
  .pill.busy { background: color-mix(in srgb, var(--run) 16%, transparent); color: var(--text); }
  .pill i { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
  .pill.busy i { background: var(--run); animation: beat 1.1s ease-in-out infinite; }
  main { max-width: 1160px; margin: 0 auto; padding: 8px 24px 60px; }
  h2 { display: flex; align-items: baseline; gap: 10px; font-size: 12px; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); margin: 26px 0 12px; }
  h2 small { font-size: 12px; letter-spacing: 0; text-transform: none; font-weight: 400; }

  /* ---- Akış ---- */
  .board { background: var(--panel); border: 1px solid var(--line); border-radius: 18px; margin-top: 18px; overflow: hidden; }
  .board-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 14px 18px 0; }
  .board-title { font-weight: 650; font-size: 16px; }
  .board-meta { color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; }
  .tag { padding: 2px 9px; border-radius: 999px; font-size: 12px; font-weight: 600; background: var(--soft); color: var(--muted); }
  .tag.open { background: color-mix(in srgb, var(--run) 16%, transparent); color: var(--run); }
  .tag.merged { background: color-mix(in srgb, var(--ok) 16%, transparent); color: var(--ok); }
  .legend { margin-left: auto; display: flex; gap: 16px; color: var(--muted); font: 12px ui-monospace, Menlo, monospace; }
  .legend span::before { content: ''; display: inline-block; width: 22px; height: 3px; border-radius: 2px; background: var(--c); vertical-align: middle; margin-right: 7px; }
  #back { border: 1px solid var(--line); background: var(--panel); color: var(--text); border-radius: 999px; padding: 3px 11px; font: inherit; font-size: 12px; cursor: pointer; }
  #flow { display: block; width: 100%; height: auto; }
  #flow text { fill: var(--text); font-size: 14px; font-weight: 600; }
  #flow text.sub { fill: var(--muted); font-size: 12px; font-weight: 400; }
  #flow text.mono { fill: var(--muted); font: 11px ui-monospace, Menlo, monospace; font-weight: 400; letter-spacing: .06em; }
  #flow text.t-back { fill: var(--back); }
  .e { fill: none; stroke: var(--idle); stroke-width: 4; stroke-linecap: round; stroke-linejoin: round; transition: stroke .4s; }
  .e.thin { stroke-width: 3; }
  .e-run, .e-wait { stroke: var(--run); }
  .e-run { stroke-dasharray: 12 7; animation: flowdash .7s linear infinite; }
  .e-ok { stroke: var(--ok); }
  .e-back { stroke: var(--back); }
  .e-err { stroke: var(--err); }
  .e-skip { stroke-dasharray: 3 6; }
  .pkg { fill: var(--soft); }
  .n { cursor: pointer; }
  .n .ring { fill: var(--panel); stroke: var(--text); stroke-width: 3; transition: stroke .4s; }
  .n .core { fill: none; }
  .n .halo { fill: none; stroke: none; }
  .n:hover .ring { stroke-width: 4.5; }
  .n.s-idle .ring, .n.s-skip .ring { stroke: var(--text); }
  .n.s-run .ring, .n.s-wait .ring { stroke: var(--run); }
  .n.s-run .core { fill: var(--run); }
  .n.s-run .halo { stroke: var(--run); stroke-width: 2; opacity: .5; transform-box: fill-box; transform-origin: center; animation: halo 1.4s ease-out infinite; }
  .n.s-ok .ring { stroke: var(--ok); } .n.s-ok .core { fill: var(--ok); }
  .n.s-back .ring { stroke: var(--back); } .n.s-back .core { fill: var(--back); }
  .n.s-err .ring { stroke: var(--err); } .n.s-err .core { fill: var(--err); }
  .n.sel .ring { stroke-width: 5; }
  .bar { fill: var(--text); }
  .badge { fill: var(--panel); stroke: var(--back); stroke-width: 1.5; }
  .box { fill: var(--panel); stroke: var(--muted); stroke-width: 1.5; }
  .box.on { fill: var(--ok); stroke: var(--ok); }
  .tick { fill: none; stroke: #fff; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .dotted { stroke: var(--muted); stroke-width: 2; stroke-dasharray: 2 5; stroke-linecap: round; }
  .empty-note { fill: var(--muted); font-size: 13px; font-weight: 400; }
  /* Şu an çalışanlar: şemanın ortasındaki boşlukta liste, düğümlerin yanında aynı renkte rozet. */
  .who-dot { fill: var(--c); }
  .who-ring { fill: none; stroke: var(--c); stroke-width: 2; opacity: .55; transform-box: fill-box; transform-origin: center; animation: halo 1.4s ease-out infinite; }
  #flow text.who-initial { fill: #fff; font-size: 10px; font-weight: 700; pointer-events: none; }
  #flow text.who-line { font-size: 13px; font-weight: 600; }
  #flow text.who-line tspan.dim { fill: var(--muted); font-weight: 400; }
  #flow text.who-line tspan.where { fill: var(--run); font-weight: 600; }

  .stages { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; padding: 4px 18px 16px; }
  .stage { display: inline-flex; align-items: center; gap: 8px; padding: 5px 13px 5px 6px; border-radius: 999px; border: 1px solid var(--line); background: var(--panel); color: var(--muted); font: inherit; font-size: 13px; cursor: pointer; }
  .stage b { display: grid; place-items: center; width: 20px; height: 20px; border-radius: 50%; border: 1px solid var(--line); font-size: 11px; font-weight: 600; }
  .stage.done { color: var(--text); } .stage.done b { background: var(--ok); border-color: var(--ok); color: #fff; }
  .stage.on { border-color: var(--run); color: var(--text); font-weight: 600; } .stage.on b { background: var(--run); border-color: var(--run); color: #fff; }
  .stages .hint { color: var(--muted); font: 12px ui-monospace, Menlo, monospace; margin-left: 6px; }
  #pick { border-top: 1px solid var(--line); padding: 14px 18px 16px; }
  .pick-title { font-weight: 650; margin-bottom: 4px; }
  .reason { margin: 8px 0 0; padding: 8px 12px; border-left: 3px solid var(--back); background: color-mix(in srgb, var(--back) 9%, transparent); border-radius: 0 8px 8px 0; font-size: 13px; }

  /* ---- Ekip ---- */
  #team { display: flex; flex-wrap: wrap; gap: 8px; }
  .member { display: inline-flex; align-items: center; gap: 8px; padding: 6px 12px 6px 6px; border-radius: 999px; background: var(--panel); border: 1px solid var(--line); font-size: 13px; }
  .member .av { width: 22px; height: 22px; font-size: 11px; }
  .member b { font-weight: 650; }
  .member span.muted { font-variant-numeric: tabular-nums; }
  .badge-agent { padding: 1px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; background: color-mix(in srgb, var(--run) 16%, transparent); color: var(--run); }
  .badge-write { padding: 1px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; background: color-mix(in srgb, var(--back) 16%, transparent); color: var(--back); }
  .files { margin: 6px 0 0; font: 12px ui-monospace, Menlo, monospace; color: var(--muted); }

  /* ---- Skill'ler ---- */
  #skills { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; overflow: hidden; }
  .skill { display: grid; grid-template-columns: 220px 150px 1fr; gap: 12px; padding: 9px 14px; border-top: 1px solid var(--line); font-size: 13px; align-items: baseline; }
  .skill:first-child { border-top: 0; }
  .skill-name { font: 13px ui-monospace, Menlo, monospace; font-weight: 600; }
  .skill-who { color: var(--muted); font-size: 12px; }
  .skill-desc { color: var(--muted); overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .skill-used { color: var(--ok); font-weight: 600; }

  /* ---- Akış dışı çalışanlar ---- */
  /* Şemanın üstündeki boş bantta durur (başlığın altı; Mimar-Eleştirmen yayının ve paket kutularının üstü:
     viewBox'a göre y 0-105). Aynı anda çalışanlar yan yana dizilir; sığmazsa yatay kayar. */
  .flow-wrap { position: relative; }
  #now-box { position: absolute; left: 2%; top: 0; width: 96%; max-height: 15%; pointer-events: none; }
  #now-box > * { pointer-events: auto; }
  #now-box h2 { margin: 6px 0 6px; font-size: 11px; }
  #now { display: flex; gap: 10px; align-items: flex-start; overflow-x: auto; scrollbar-width: none; padding-bottom: 4px; }
  #now::-webkit-scrollbar { display: none; }
  #now .job { flex: 0 0 auto; min-width: 190px; border-radius: 12px; padding: 8px 12px 11px; box-shadow: none; }
  #now .job-title { flex: 1; min-width: 0; max-width: 300px; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #now .job-time { font-size: 12px; }
  #now .whos { display: flex; gap: 16px; }
  #now .who { flex: none; margin-top: 6px; gap: 7px; }
  #now .av { width: 22px; height: 22px; font-size: 11px; }
  #now .who-name { font-size: 13px; }
  #now .who-model { max-width: 96px; font-size: 11px; }
  #now .who-state { margin-left: 2px; font-size: 12px; }
  .job { position: relative; overflow: hidden; background: var(--panel); border: 1px solid var(--line); border-radius: 16px; padding: 14px 16px 18px; box-shadow: 0 6px 20px rgba(0, 0, 0, .05); }
  .job::after { content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: 3px; background: linear-gradient(90deg, transparent, var(--run), transparent); background-size: 50% 100%; background-repeat: no-repeat; animation: slide 1.6s linear infinite; }
  .job-head { display: flex; gap: 10px; align-items: baseline; }
  .job-title { font-weight: 650; font-size: 15px; line-height: 1.3; }
  .job-time { margin-left: auto; font-variant-numeric: tabular-nums; color: var(--muted); white-space: nowrap; font-size: 13px; }
  .who { display: flex; align-items: center; gap: 10px; margin-top: 10px; }
  .av { position: relative; flex: none; width: 26px; height: 26px; border-radius: 50%; display: grid; place-items: center; color: #fff; font-size: 12px; font-weight: 700; background: var(--c); }
  .who.run .av::after { content: ''; position: absolute; inset: -4px; border-radius: 50%; border: 2px solid var(--c); border-top-color: transparent; animation: spin .9s linear infinite; }
  .who-name { font-weight: 600; }
  .who-model { color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .who-state { margin-left: auto; font-variant-numeric: tabular-nums; font-size: 13px; white-space: nowrap; }
  .who.run .who-state { color: var(--run); font-weight: 600; }

  /* ---- Bitenler ---- */
  .day { font-size: 12px; font-weight: 600; color: var(--muted); margin: 18px 4px 8px; }
  .done { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; margin-bottom: 8px; overflow: hidden; }
  .done.shown { border-color: var(--run); }
  .done-row { display: grid; grid-template-columns: 52px 1fr auto 72px 16px; gap: 12px; align-items: center; padding: 10px 14px; cursor: pointer; }
  .done-row:hover { background: var(--soft); }
  .done-clock { color: var(--muted); font-variant-numeric: tabular-nums; font-size: 13px; }
  .done-title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chips { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
  .chip { display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; border-radius: 999px; background: var(--soft); font-size: 12px; white-space: nowrap; }
  .chip i { width: 7px; height: 7px; border-radius: 50%; background: var(--c); }
  .chip.err { color: var(--err); }
  .done-total { text-align: right; font-variant-numeric: tabular-nums; color: var(--muted); font-size: 13px; }
  .chev { color: var(--muted); transition: rotate .2s; font-size: 11px; }
  .done.open .chev { rotate: 90deg; }
  .detail { display: none; border-top: 1px solid var(--line); padding: 12px 14px 14px; }
  .done.open .detail { display: block; animation: drop .25s ease-out; }
  .detail-who { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13px; margin-top: 10px; }
  .detail-who:first-child { margin-top: 0; }
  pre { white-space: pre-wrap; word-break: break-word; font: 12px/1.5 ui-monospace, Menlo, monospace; margin: 8px 0 0; padding: 10px 12px; background: var(--soft); border-radius: 10px; max-height: 360px; overflow: auto; }
  .ok { color: var(--ok); } .err { color: var(--err); } .muted { color: var(--muted); } .back { color: var(--back); } .runc { color: var(--run); }
  #more { display: block; margin: 14px auto 0; padding: 8px 16px; border-radius: 999px; border: 1px solid var(--line); background: var(--panel); color: var(--text); font: inherit; cursor: pointer; }

  /* ---- Hareket ---- */
  .enter { animation: rise .4s cubic-bezier(.2, .8, .2, 1); }
  .leaving { animation: leave .3s ease-in forwards; pointer-events: none; }
  .fresh { animation: rise .4s cubic-bezier(.2, .8, .2, 1), flash 1.8s ease-out; }
  @keyframes rise { from { opacity: 0; translate: 0 10px; scale: .98; } }
  @keyframes leave { to { opacity: 0; translate: 0 14px; scale: .96; } }
  @keyframes flash { 0%, 30% { box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 45%, transparent); } 100% { box-shadow: 0 0 0 3px transparent; } }
  @keyframes drop { from { opacity: 0; translate: 0 -6px; } }
  @keyframes spin { to { rotate: 360deg; } }
  @keyframes beat { 50% { scale: 1.6; opacity: .5; } }
  @keyframes slide { from { background-position: -50% 0; } to { background-position: 150% 0; } }
  @keyframes flowdash { to { stroke-dashoffset: -19; } }
  @keyframes halo { from { transform: scale(.75); opacity: .6; } to { transform: scale(1.35); opacity: 0; } }
  @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
  @media (max-width: 640px) {
    .done-row { grid-template-columns: 46px 1fr 60px 14px; }
    .chips, .legend { display: none; }
    .skill { grid-template-columns: 1fr; gap: 2px; }
    /* Dar ekranda şemanın üstüne binmesin: şemanın altında, alt alta. */
    #now-box { position: static; width: auto; max-height: none; padding: 0 12px; }
    #now { flex-wrap: wrap; }
  }
</style>
</head>
<body>
<header>
  <span class="dot" id="conn" title="Bağlantı"></span>
  <h1>Orkestra</h1>
  <span class="pill" id="pill"><i></i><span>Boşta</span></span>
</header>
<main>
  <section class="board">
    <div class="board-head">
      <span class="board-title" id="job-title"></span>
      <span class="tag" id="job-tag" hidden></span>
      <span class="board-meta" id="job-meta"></span>
      <button id="back" hidden>Açık işe dön</button>
      <div class="legend">
        <span style="--c: var(--run)">sürüyor</span>
        <span style="--c: var(--back)">geri gönderildi</span>
        <span style="--c: var(--ok)">onaylandı</span>
      </div>
    </div>
    <div class="flow-wrap">
      <svg id="flow" viewBox="0 0 1120 700" role="img" aria-label="İşin hattı"></svg>
      <div id="now-box">
        <h2 id="now-title" hidden>Akış dışı çalışanlar</h2>
        <div id="now"></div>
      </div>
    </div>
    <div class="stages" id="stages"></div>
    <div id="pick"></div>
  </section>
  <h2>Ekip <small>danışman çağrıları ve ajan görevleri</small></h2>
  <div id="team"></div>
  <h2>Biten işler <small id="count"></small></h2>
  <div id="done"></div>
  <button id="more" hidden>Daha eskileri göster</button>
  <h2>Skill'ler <small id="skills-count"></small></h2>
  <div id="skills"></div>
</main>
<script>
  const ACTORS = {
    claude: { name: 'Claude', color: 'var(--claude)' },
    codex: { name: 'Codex', color: 'var(--codex)' },
    gemini: { name: 'Gemini', color: 'var(--gemini)' },
    nvidia: { name: 'NVIDIA', color: 'var(--nvidia)' },
    gate: { name: 'Kapı', color: 'var(--gate)' },
  };
  const STAGES = [['ticket', 'İş'], ['design', 'Tasarım'], ['build', 'Yapım'], ['integrate', 'Bütünleştirme'], ['review', 'İnceleme'], ['merge', 'Birleştirme']];
  // Mercekler ve göbek etrafındaki açıları (derece; 0 sağ, 90 yukarı). 0 ve 180 ana hattır.
  const LENSES = [['alignment', 'Plana uygunluk', 118], ['correctness', 'Doğruluk', 205], ['testing', 'Test', 245], ['production', 'Üretim', 295], ['architecture', 'Mimari', 335], ['security', 'Güvenlik', 22]];
  const TIERS = [['types', 'tip'], ['lint', 'lint'], ['unit', 'birim'], ['integration', 'entegrasyon'], ['e2e', 'uçtan uca']];
  const BUILD_ROLES = [['implementer', 'Uygulayıcı'], ['tester', 'Testçi']];
  const NODE_NAMES = { 'ticket': 'İş girişi', 'design/architect': 'Mimar', 'design/critic': 'Eleştirmen', 'design/*': 'Tasarım', 'build/*': 'Yapım', 'integrate/*': 'Bütünleştirme kapısı', 'review/*': 'İnceleme', 'review/fix': 'Düzeltme', 'merge/*': 'Birleştirme' };
  const MAX_ROUNDS = 5;
  // Bitiş olayı gelmeyen iş (süreç öldürüldü, bitiş bildirilmedi) bu süreden sonra "yanıtsız" sayılır.
  const STALE_CALL_MS = 15 * 60 * 1000;
  const STALE_NOTE_MS = 2 * 3600 * 1000;
  // Aynı aşama adıyla bu süre içinde başlayan çağrılar tek iş (panel) sayılır.
  const PANEL_WINDOW_MS = 10 * 60 * 1000;
  const calls = new Map(); // id → çağrı
  const notes = []; // aşama notları ve kararlar
  const lensEvents = [];
  const gateEvents = [];
  const jobsById = new Map(); // hattı olan işler
  const opened = new Set();
  let live = false; // geçmiş yüklendikten sonra gelenler hareketle girer
  let limit = 40;
  let shownJob = null; // elle seçilen (bitmiş) iş; null: açık iş
  let picked = null; // elle seçilen düğüm; null: son hareket eden düğüm

  function apply(e) {
    if (e.type === 'start') calls.set(e.id, { ...e, startTs: e.ts, state: 'run' });
    else if (e.type === 'end' && calls.has(e.id)) Object.assign(calls.get(e.id), { state: e.ok ? 'ok' : 'err', seconds: e.seconds, text: e.text, endTs: e.ts, files: e.files });
    else if (e.type === 'lens') lensEvents.push(e);
    else if (e.type === 'gate') gateEvents.push(e);
    else if (e.type === 'job') {
      const job = jobsById.get(e.job) || { id: e.job, start: e.ts };
      Object.assign(job, { title: e.title || job.title, status: e.status, end: e.status === 'open' ? null : e.ts });
      jobsById.set(e.job, job);
    } else if (e.type === 'note') {
      // Karar ve "tanımlı değil" olayları anlıktır.
      if (e.verdict || e.status === 'skipped') return void notes.push({ ...e, endTs: e.ts, instant: true });
      // Bitişi bildirilmemiş eski bir aşama, aynı adla yeniden başlayan işi yutmasın.
      const open = [...notes].reverse().find((n) => !n.instant && n.task === e.task && n.job === e.job && n.role === e.role && !n.endTs && e.ts - n.ts < STALE_NOTE_MS);
      if (e.status === 'done') {
        if (open) open.endTs = e.ts;
        else notes.push({ ...e, endTs: e.ts });
      } else if (!open) notes.push({ ...e });
    }
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const hhmm = (ts) => new Date(ts).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
  function dur(s) {
    if (s < 59.95) return s.toFixed(1).replace('.', ',') + ' sn';
    const t = Math.round(s);
    return t < 3600 ? Math.floor(t / 60) + ' dk ' + (t % 60) + ' sn' : Math.floor(t / 3600) + ' sa ' + Math.floor((t % 3600) / 60) + ' dk';
  }
  const dayKey = (ts) => new Date(ts).toDateString();
  function dayLabel(ts) {
    const d = new Date(ts), today = new Date(), yesterday = new Date(Date.now() - 86400000);
    if (d.toDateString() === today.toDateString()) return 'Bugün';
    if (d.toDateString() === yesterday.toDateString()) return 'Dün';
    return d.toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', weekday: 'long' });
  }
  // Depoda çalışan ajan çağrısı (kendi okur, komut çalıştırır); eski kayıtlarda "agent" alanı yok, "write" var.
  const isAgentCall = (c) => c.agent === true || c.write !== undefined;
  // Eski kayıtlarda skill listesi yok; rol alanı skill adını taşıyorsa (hattın genel rollerinden biri değilse) o sayılır.
  const skillsOf = (c) => c.skills || (isAgentCall(c) && c.role && !['tester', 'reviewer', 'implementer', 'architect', 'critic'].includes(c.role) ? [c.role] : []);
  const actorOfLabel = (label) => (/^codex/.test(label || '') ? 'codex' : /gemini|^agy/.test(label || '') ? 'gemini' : 'nvidia');

  // Bütün olaylar tek biçimde: çağrılar, notlar, kararlar, mercek sonuçları.
  function allItems(now) {
    const hat = (o) => ({ job: o.job, stage: o.stage, role: o.role, round: o.round, pkg: o.pkg });
    return [
      ...[...calls.values()].map((c) => {
        const stale = c.state === 'run' && now - c.startTs > STALE_CALL_MS;
        return { ...hat(c), key: 'c' + c.id, actor: c.actor, model: c.model, task: c.task, start: c.startTs, end: stale ? c.startTs : c.endTs, state: stale ? 'stale' : c.state, seconds: c.seconds, text: c.text, lenses: c.lenses, agent: isAgentCall(c), skills: skillsOf(c), write: c.write === true, files: c.files };
      }),
      ...notes.map((n) => {
        const stale = !n.endTs && now - n.ts > STALE_NOTE_MS;
        const state = n.instant ? (n.status === 'skipped' ? 'skip' : n.verdict === 'sent_back' ? 'back' : 'ok') : stale ? 'stale' : n.endTs ? 'ok' : 'run';
        return { ...hat(n), key: 'n' + n.ts + n.task, actor: n.actor || 'claude', task: n.task, start: n.ts, end: stale ? n.ts : n.endTs, state, seconds: n.endTs && !n.instant ? (n.endTs - n.ts) / 1000 : undefined, note: true, verdict: n.verdict, reason: n.reason };
      }),
      ...lensEvents.map((l, i) => ({ ...hat(l), key: 'l' + i + l.ts, actor: actorOfLabel(l.model), model: l.model, task: 'Mercek', start: l.ts, end: l.ts, state: l.outcome === 'clean' ? 'ok' : l.outcome === 'findings' ? 'back' : 'skip', text: l.text, lens: true })),
    ].sort((a, b) => a.start - b.start);
  }

  // Hattı olmayan (eski ya da tekil) işler: her iş bir aşama notu ya da aynı adla başlamış model çağrıları (panel).
  function looseJobs(items) {
    const list = [];
    const panels = new Map(); // aşama adı → son panel
    for (const item of items) {
      if (item.job) continue;
      const panel = !item.note && item.task ? panels.get(item.task) : null;
      if (panel && item.start - panel.start < PANEL_WINDOW_MS) panel.members.push(item);
      else {
        const job = { key: item.key, title: item.task || item.model, start: item.start, members: [item] };
        list.push(job);
        if (!item.note && item.task) panels.set(item.task, job);
      }
    }
    for (const job of list) {
      job.running = job.members.some((m) => m.state === 'run');
      job.end = Math.max(...job.members.map((m) => m.end ?? m.start));
    }
    return list;
  }

  // Bir düğümün durumu, kayıtlarından: süren varsa "run", yoksa son kaydın sonucu.
  function stateOf(list) {
    if (!list.length) return 'idle';
    if (list.some((i) => i.state === 'run')) return 'run';
    const last = list[list.length - 1];
    return last.state === 'stale' ? 'err' : last.state;
  }
  function nodeItems(its, key) {
    const [stage, role, pkg] = key.split('/');
    return its.filter((i) => i.stage === stage &&
      (role === '*' || i.role === role || (i.role === 'reviewer' && (i.lenses || []).includes(role))) &&
      (!pkg || String(i.pkg || '1') === pkg));
  }

  // Bir işin hattı: her düğümün durumu.
  function flowOf(job, items) {
    const its = job ? items.filter((i) => i.job === job.id && i.stage) : [];
    const at = (key) => nodeItems(its, key);
    const f = { its, job };

    f.architect = stateOf(at('design/architect'));
    const critics = at('design/critic');
    f.critic = stateOf(critics);
    // Eleştirmen çağrısının başarıyla bitmesi onay değildir: karar yazılana kadar "bekliyor".
    if (f.critic === 'ok' && !critics[critics.length - 1].verdict) f.critic = 'wait';
    f.round = Math.max(0, ...at('design/*').map((i) => i.round || 1));
    f.reason = [...critics].reverse().find((i) => i.verdict)?.reason;

    const pkgs = [...new Set(at('build/*').map((i) => String(i.pkg || '1')))].sort();
    f.pkgs = (pkgs.length ? pkgs : ['1']).slice(0, 3).map((name) => ({
      name,
      nodes: BUILD_ROLES.map(([role, label]) => ({ role, label, state: stateOf(at('build/' + role + '/' + name)), critic: stateOf(at('build/critic-' + role + '/' + name)) })),
    }));

    f.tiers = TIERS.map(([key, label]) => ({ key, label, state: stateOf(at('integrate/' + key).slice(-1)) }));
    const gates = gateEvents.filter((g) => g.job === job?.id);
    f.gate = gates[gates.length - 1] || null;
    const tierStates = f.tiers.map((t) => t.state);
    f.integrate = tierStates.includes('run') ? 'run' : tierStates.every((s) => s === 'idle') ? 'idle' : tierStates.includes('err') ? 'err' : f.gate?.ok ? 'ok' : 'run';
    // Kapıdan sonra kod değiştiyse (yapım ya da düzeltme) yeşil geçersizdir.
    const changedAfterGate = f.gate && its.some((i) => (i.stage === 'build' || i.role === 'fix') && (i.end ?? i.start) > f.gate.ts);
    f.gateFresh = !!f.gate?.ok && !changedAfterGate && f.integrate === 'ok';

    f.reviewRound = Math.max(0, ...at('review/*').map((i) => i.round || 1));
    const inRound = its.filter((i) => (i.round || 1) === f.reviewRound);
    f.lenses = LENSES.map(([key, label, angle]) => {
      const list = nodeItems(inRound, 'review/' + key).filter((i) => i.lens || i.state === 'run');
      return { key, label, angle, state: stateOf(list), model: list[list.length - 1]?.model };
    });
    f.fix = stateOf(at('review/fix'));
    const lensStates = f.lenses.map((l) => l.state);
    const decision = at('review/decision').pop();
    const lastLens = Math.max(0, ...its.filter((i) => i.lens).map((i) => i.start));
    f.review = lensStates.includes('run') ? 'run'
      : decision && decision.start >= lastLens ? decision.state
      : lensStates.every((s) => s === 'idle') ? 'idle'
      : f.fix === 'run' || lensStates.includes('back') ? 'back'
      : lensStates.includes('ok') ? 'wait' : 'err';
    // Mercekler temiz olsa da incelemeyi kapatan, bulguları süzen Claude'un kararıdır.
    if (f.review === 'wait' && !lensStates.includes('skip') && !lensStates.includes('back')) f.review = 'ok';

    f.pr = stateOf(at('merge/pr'));
    f.merged = job?.status === 'merged';
    f.checks = [['İnceleme onaylı', f.review === 'ok'], ['Kapı yeşil', f.gateFresh], ['PR hazır', f.pr === 'ok']];

    const busy = { design: [f.architect, f.critic], build: f.pkgs.flatMap((p) => p.nodes.flatMap((n) => [n.state, n.critic])), integrate: [f.integrate], review: [f.review, f.fix], merge: [f.pr] };
    const touched = STAGES.map(([key]) => key).filter((key) => key === 'ticket' ? !!job : busy[key].some((s) => s !== 'idle'));
    f.stage = f.merged ? 'merge' : touched[touched.length - 1] || null;
    f.touched = touched;
    const last = its[its.length - 1];
    f.lastKey = !last ? (job ? 'ticket' : null)
      : last.stage === 'build' ? 'build/' + last.role + '/' + String(last.pkg || '1')
      : last.stage === 'integrate' ? 'integrate/*'
      : last.stage === 'merge' ? 'merge/*'
      : last.role === 'reviewer' || last.role === 'decision' ? 'review/*'
      : last.stage + '/' + last.role;
    return f;
  }

  // ---- Şema ----
  const CY = 250, RY = 585;
  const edge = (d, state, extra) => '<path class="e e-' + state + (extra ? ' ' + extra : '') + '" d="' + d + '"/>';
  const text = (x, y, s, cls, anchor) => '<text x="' + x + '" y="' + y + '"' + (cls ? ' class="' + cls + '"' : '') + ' text-anchor="' + (anchor || 'middle') + '">' + esc(s) + '</text>';
  // Düğüm anahtarı → şemadaki yeri (her çizimde yeniden dolar).
  let positions = {};
  function node(key, x, y, state, r) {
    r = r || 10;
    positions[key] = [x, y];
    return '<g class="n s-' + state + (key === currentPick ? ' sel' : '') + '" data-node="' + key + '" transform="translate(' + x + ' ' + y + ')">' +
      '<circle class="halo" r="' + (r + 9) + '"/><circle r="' + (r + 8) + '" fill="transparent"/><circle class="ring" r="' + r + '"/><circle class="core" r="' + (r - 5.5) + '"/></g>';
  }
  let currentPick = null;

  // Çalışan bir kaydın şemadaki düğümü.
  function nodeKeyOf(i) {
    const pkg = String(i.pkg || '1');
    if (i.stage === 'build') return BUILD_ROLES.some((r) => r[0] === i.role || 'critic-' + r[0] === i.role) ? 'build/' + i.role + '/' + pkg : 'build/tester/' + pkg;
    if (i.stage === 'integrate') return 'integrate/*';
    if (i.stage === 'merge') return 'merge/*';
    if (i.role === 'fix') return 'review/fix';
    if (i.stage === 'review') return 'review/*';
    return i.stage + '/' + (i.role === 'critic' ? 'critic' : 'architect');
  }
  const nodeLabel = (key) => {
    const parts = key.split('/');
    const role = BUILD_ROLES.find((r) => parts[1] === r[0] || parts[1] === 'critic-' + r[0]);
    return NODE_NAMES[key] || (role ? (parts[1].startsWith('critic-') ? role[1] + ' eleştirmeni' : role[1]) : key === 'review/fix' ? 'Düzelt' : key);
  };

  // Şemanın ortasındaki boşluk (Mimar/Eleştirmen'in altı, onay kutularının üstü): şu an çalışanlar ve nerede
  // çalıştıkları. Aynı renkte küçük bir rozet ilgili düğümün yanına konur (düğümün etiketini örtmeyecek köşeye).
  const NOW_X = 40, NOW_Y = 374, NOW_ROW = 26, NOW_MAX = 4;
  function badgeAt(key, at, n) {
    const step = (n - 1) * 20;
    if (key === 'review/*') return [at[0] + 36 + step, at[1] - 32];
    if (key === 'integrate/*') return [at[0] + 56 + step, at[1] + 22];
    // Birleştir çubuğunun sağında onay kutuları var: rozet sol üste konur.
    if (key === 'merge/*') return [at[0] - 16 - step, at[1] - 40];
    if (key === 'review/fix') return [at[0] - 18 - step, at[1] - 16];
    // Yapım düğümlerinin etiketi üstte, tasarım düğümlerininki altta.
    return key.startsWith('build/') ? [at[0] + 18 + step, at[1] + 18] : [at[0] + 18 + step, at[1] - 18];
  }
  function drawWorkers(f) {
    if (!f.job) return '';
    const running = f.its.filter((i) => i.state === 'run');
    let s = text(NOW_X, NOW_Y - 20, 'ŞU AN' + (running.length > NOW_MAX ? ' · ' + running.length + ' ÇALIŞIYOR, İLK ' + NOW_MAX : ''), 'mono', 'start');
    if (running.length === 0) {
      const last = [...f.its].reverse().find((i) => !i.lens && i.end);
      return s + text(NOW_X, NOW_Y + 4, 'Çalışan yok' + (last ? ' · son: ' + actorOf(last).name + ', ' + nodeLabel(nodeKeyOf(last)) + ' ' + hhmm(last.end) : ''), 'sub', 'start');
    }
    const perNode = {};
    running.slice(0, NOW_MAX).forEach((i, row) => {
      const a = actorOf(i), key = nodeKeyOf(i), y = NOW_Y + row * NOW_ROW;
      const what = [i.agent ? 'ajan' : i.note ? null : 'danışman', ...(i.skills || [])].filter(Boolean).join(' · ');
      s += '<g style="--c:' + a.color + '"><circle class="who-ring" cx="' + (NOW_X + 9) + '" cy="' + (y - 4) + '" r="12"/><circle class="who-dot" cx="' + (NOW_X + 9) + '" cy="' + (y - 4) + '" r="9"/>' +
        '<text class="who-initial" x="' + (NOW_X + 9) + '" y="' + y + '" text-anchor="middle">' + esc(a.name[0]) + '</text>' +
        '<text class="who-line" x="' + (NOW_X + 26) + '" y="' + y + '" text-anchor="start">' + esc(a.name) +
        '<tspan class="where" dx="8">' + esc(nodeLabel(key)) + '</tspan>' +
        (what ? '<tspan class="dim" dx="8">' + esc(what) + '</tspan>' : '') +
        '<tspan class="dim" dx="8" data-since="' + i.start + '"></tspan></text>';
      const at = positions[key];
      if (at) {
        const n = (perNode[key] = (perNode[key] || 0) + 1);
        const [bx, by] = badgeAt(key, at, n);
        s += '<circle class="who-ring" cx="' + bx + '" cy="' + by + '" r="12"/><circle class="who-dot" cx="' + bx + '" cy="' + by + '" r="9"/>' +
          '<text class="who-initial" x="' + bx + '" y="' + (by + 4) + '" text-anchor="middle">' + esc(a.name[0]) + '</text>';
      }
      s += '</g>';
    });
    return s;
  }

  function drawFlow(f) {
    positions = { 'integrate/*': [960, CY], 'review/*': [650, RY], 'merge/*': [161, RY] };
    let s = '';
    const jobState = f.job ? 'ok' : 'idle';
    // İş girişi → Mimar → Eleştirmen
    s += edge('M 52 ' + CY + ' L 228 ' + CY, f.architect === 'idle' ? 'idle' : f.architect);
    s += edge('M 252 ' + CY + ' L 408 ' + CY, f.critic);
    const revising = f.critic === 'back';
    s += edge('M 420 ' + (CY - 14) + ' C 420 ' + (CY - 96) + ', 240 ' + (CY - 96) + ', 240 ' + (CY - 14), revising ? 'back' : 'idle', 'thin');
    if (f.round > 0) {
      s += '<rect class="badge" x="272" y="' + (CY - 132) + '" width="116" height="24" rx="12"' + (revising ? '' : ' style="stroke: var(--idle)"') + '/>';
      s += text(330, CY - 116, 'tur ' + f.round + ' / ' + MAX_ROUNDS, 'mono' + (revising ? ' t-back' : ''));
    }
    if (revising) s += text(330, CY - 58, 'düzelt', 't-back');
    s += '<g class="n' + (currentPick === 'ticket' ? ' sel' : '') + '" data-node="ticket"><rect x="30" y="' + (CY - 34) + '" width="36" height="68" fill="transparent"/><rect class="bar" x="43" y="' + (CY - 26) + '" width="9" height="52" rx="2"' + (jobState === 'idle' ? ' style="fill: var(--idle)"' : '') + '/></g>';
    s += text(38, CY + 52, 'İş girişi', '', 'start') + text(38, CY + 69, f.job ? f.job.id : 'açık iş yok', 'sub', 'start');
    s += node('design/architect', 240, CY, f.architect) + text(240, CY + 38, 'Mimar') + text(240, CY + 55, 'tasarımı yazar', 'sub');
    s += node('design/critic', 420, CY, f.critic) + text(420, CY + 38, 'Eleştirmen') + text(420, CY + 55, 'tasarımı değerlendirir', 'sub');

    // Paketler
    const n = f.pkgs.length;
    const H = n === 3 ? 128 : 140, GAP = n === 3 ? 14 : 24;
    const top = CY - (n * H + (n - 1) * GAP) / 2;
    let pkgHtml = '', nodesHtml = '';
    f.pkgs.forEach((pkg, p) => {
      const boxTop = top + p * (H + GAP);
      pkgHtml += '<rect class="pkg" x="556" y="' + boxTop + '" width="288" height="' + H + '" rx="10"/>' + text(834, boxTop + H - 9, 'PAKET ' + pkg.name, 'mono', 'end');
      pkg.nodes.forEach((nd, r) => {
        const y = boxTop + (r === 0 ? 46 : H - 28);
        const out = nd.critic !== 'idle' ? nd.critic : nd.state === 'ok' ? 'ok' : 'idle';
        s += edge('M 432 ' + CY + ' C 500 ' + CY + ', 496 ' + y + ', 556 ' + y + ' L 608 ' + y, nd.state);
        s += edge('M 632 ' + y + ' L 733 ' + y, nd.critic !== 'idle' ? nd.critic : 'idle');
        s += edge('M 757 ' + y + ' L 844 ' + y + ' C 898 ' + y + ', 884 ' + CY + ', 914 ' + CY, out);
        nodesHtml += node('build/' + nd.role + '/' + pkg.name, 620, y, nd.state) + text(620, y - 20, nd.label) +
          node('build/critic-' + nd.role + '/' + pkg.name, 745, y, nd.critic) + text(745, y - 20, 'eleştirmen', 'sub');
      });
    });
    s = pkgHtml + s + nodesHtml;

    // Bütünleştir
    s += edge('M 1006 ' + CY + ' L 1048 ' + CY + ' Q 1076 ' + CY + ' 1076 ' + (CY + 28) + ' L 1076 ' + (RY - 28) + ' Q 1076 ' + RY + ' 1048 ' + RY + ' L 690 ' + RY, f.review === 'idle' ? 'idle' : f.integrate === 'ok' ? 'ok' : 'idle');
    s += '<g class="n s-' + f.integrate + (currentPick === 'integrate/*' ? ' sel' : '') + '" data-node="integrate/*"><rect class="ring" x="914" y="' + (CY - 19) + '" width="92" height="38" rx="19"/>' +
      [940, 960, 980].map((x) => '<circle class="core" cx="' + x + '" cy="' + CY + '" r="4" style="' + (f.integrate === 'idle' ? 'fill: var(--idle)' : '') + '"/>').join('') + '</g>';
    s += text(960, CY - 50, 'Bütünleştir') + text(960, CY - 33, 'bütün test katmanlarını koşar', 'sub');
    f.tiers.forEach((t, i) => {
      const y = CY + 54 + i * 22;
      s += text(900, y + 4, t.label, 'sub', 'start') + edge('M 992 ' + y + ' L 1052 ' + y, t.state, 'thin');
    });

    // İnceleme göbeği
    const L = 100;
    f.lenses.forEach((l) => {
      const a = (l.angle * Math.PI) / 180, x = Math.round(650 + Math.cos(a) * L), y = Math.round(RY - Math.sin(a) * L);
      const right = Math.cos(a) > 0.2, left = Math.cos(a) < -0.2;
      s += edge('M 650 ' + RY + ' L ' + x + ' ' + y, l.state, 'thin') + node('review/' + l.key, x, y, l.state);
      const tx = right ? x + 18 : left ? x - 18 : x, anchor = right ? 'start' : left ? 'end' : 'middle';
      const ty = right || left ? y + 5 : y + (Math.sin(a) > 0 ? -20 : 30);
      s += text(tx, ty, l.label, '', anchor) + (l.model ? text(tx, ty + 16, l.model.split('/')[0], 'sub', anchor) : '');
    });
    const fa = (64 * Math.PI) / 180, fx = Math.round(650 + Math.cos(fa) * 112), fy = Math.round(RY - Math.sin(fa) * 112);
    const fixState = f.fix === 'idle' ? 'idle' : f.fix === 'run' ? 'back' : f.fix;
    s += edge('M 646 ' + RY + ' L ' + (fx - 4) + ' ' + fy, fixState, 'thin') + edge('M 654 ' + RY + ' L ' + (fx + 4) + ' ' + fy, fixState, 'thin');
    s += node('review/fix', fx, fy, f.fix === 'run' ? 'back' : f.fix) + text(fx + 18, fy + 2, 'Düzelt', f.fix === 'run' ? 't-back' : '', 'start') + text(fx + 18, fy + 18, 'sonra yeniden incele', 'sub', 'start');
    s += edge('M 610 ' + RY + ' L 166 ' + RY, f.review === 'ok' ? 'ok' : 'idle');
    s += '<g class="n s-' + f.review + (currentPick === 'review/*' ? ' sel' : '') + '" data-node="review/*"><circle class="ring" cx="650" cy="' + RY + '" r="38"/></g>';
    s += '<text x="650" y="' + (RY + (f.reviewRound > 1 ? 0 : 5)) + '" text-anchor="middle" pointer-events="none">İnceleme</text>' +
      (f.reviewRound > 1 ? '<text x="650" y="' + (RY + 17) + '" class="mono" text-anchor="middle" pointer-events="none">tur ' + f.reviewRound + '</text>' : '');

    // Birleştir + insan
    const ready = f.checks.every((c) => c[1]);
    s += '<g class="n' + (currentPick === 'merge/*' ? ' sel' : '') + '" data-node="merge/*"><rect x="144" y="' + (RY - 34) + '" width="36" height="68" fill="transparent"/><rect class="bar" x="157" y="' + (RY - 26) + '" width="9" height="52" rx="2" style="fill: ' + (f.merged ? 'var(--ok)' : ready ? 'var(--text)' : 'var(--idle)') + '"/></g>';
    s += text(144, RY + 5, 'Birleştir', '', 'end');
    f.checks.forEach((c, i) => {
      const y = RY - 104 + i * 25;
      s += '<rect class="box' + (c[1] ? ' on' : '') + '" x="186" y="' + y + '" width="15" height="15" rx="3"/>' + (c[1] ? '<path class="tick" d="M 189.5 ' + (y + 8) + ' l 3 3 l 5 -6"/>' : '') + text(210, y + 12, c[0], 'sub', 'start');
    });
    s += '<path class="dotted" d="M 161 ' + (RY + 30) + ' L 161 ' + (RY + 56) + '"/>';
    s += '<circle cx="161" cy="' + (RY + 78) + '" r="18" fill="var(--panel)" stroke="' + (f.merged ? 'var(--ok)' : 'var(--text)') + '" stroke-width="2.5"/>' +
      '<circle cx="161" cy="' + (RY + 73) + '" r="5" fill="' + (f.merged ? 'var(--ok)' : 'var(--text)') + '"/><path d="M 151 ' + (RY + 88) + ' a 10 8 0 0 1 20 0" fill="' + (f.merged ? 'var(--ok)' : 'var(--text)') + '"/>';
    s += text(190, RY + 75, 'İnsan', '', 'start') + text(190, RY + 92, f.merged ? 'birleştirdi' : 'son birleştirmeyi yapar', 'sub', 'start');
    if (!f.job) s += text(650, RY - 150, 'Şu anda açık iş yok', 'empty-note');
    s += drawWorkers(f);
    return s;
  }

  const actorOf = (m) => ACTORS[m.actor] || { name: m.actor, color: 'var(--muted)' };
  const stateText = (m) =>
    m.state === 'run' ? '<span class="runc" data-since="' + m.start + '"></span>'
    : m.state === 'stale' ? '<span class="err">yanıtsız</span>'
    : m.state === 'err' ? '<span class="err">✗ hata' + (m.seconds != null ? ' · ' + dur(m.seconds) : '') + '</span>'
    : m.state === 'skip' ? '<span class="muted">' + (m.lens ? 'incelenemedi' : 'tanımlı değil') + '</span>'
    : m.state === 'back' ? '<span class="back">' + (m.lens ? 'bulgu var' : '↩ geri gönderildi') + '</span>'
    : m.verdict ? '<span class="ok">✓ onaylandı</span>'
    : m.lens ? '<span class="ok">✓ bulgu yok</span>'
    : '<span class="ok">✓ ' + (m.seconds != null ? dur(m.seconds) : '') + '</span>';

  function memberDetail(m) {
    const a = actorOf(m);
    return '<div class="detail-who" style="--c:' + a.color + '"><span class="chip"><i></i>' + esc(a.name) + '</span>' +
      (m.model ? '<span class="muted">' + esc(m.model) + '</span>' : '') +
      (m.note && m.task && m.stage ? '<span>' + esc(m.task) + '</span>' : '') +
      (m.round ? '<span class="muted">tur ' + m.round + '</span>' : '') +
      (m.agent ? '<span class="badge-agent">ajan</span>' + (m.write ? '<span class="badge-write">yazma</span>' : '') + m.skills.map((k) => '<span class="chip">' + esc(k) + '</span>').join('') : '') +
      '<span class="muted">' + hhmm(m.start) + (m.end && m.end !== m.start ? ' → ' + hhmm(m.end) : '') + '</span>' + stateText(m) + '</div>' +
      (m.files && m.files.length ? '<div class="files">yama: ' + m.files.map(esc).join(', ') + '</div>' : '') +
      (m.reason ? '<div class="reason">' + esc(m.reason) + '</div>' : '') +
      (m.text ? '<pre>' + esc(m.text) + '</pre>' : '');
  }

  // ---- Ekip: kim kaç kez danışman, kaç kez ajan olarak çalıştı ve hangi skill'lerle ----------------------------
  let skillList = [];
  function teamRows() {
    const stats = {};
    for (const key of ['codex', 'gemini', 'nvidia']) stats[key] = { advisor: 0, agent: 0, skills: new Map() };
    for (const c of calls.values()) {
      const st = stats[c.actor];
      if (!st) continue;
      if (isAgentCall(c)) {
        st.agent++;
        for (const k of skillsOf(c)) st.skills.set(k, (st.skills.get(k) || 0) + 1);
      } else st.advisor++;
    }
    return Object.keys(stats).map((key) => {
      const a = ACTORS[key], st = stats[key];
      const used = [...st.skills].sort((x, y) => y[1] - x[1]).map(([k, n]) => '<span class="chip">' + esc(k) + ' ×' + n + '</span>').join('');
      return { key: 'm:' + key, cls: 'member', sig: JSON.stringify([st.advisor, st.agent, [...st.skills]]),
        html: '<span class="av" style="--c:' + a.color + '">' + esc(a.name[0]) + '</span><b>' + esc(a.name) + '</b><span class="muted">' + st.advisor + ' danışman · ' + st.agent + ' ajan</span>' + used };
    });
  }
  function renderTeam() {
    sync(document.getElementById('team'), teamRows(), 'enter');
    const used = new Map();
    for (const c of calls.values()) for (const k of skillsOf(c)) used.set(k, (used.get(k) || 0) + 1);
    setHtml(document.getElementById('skills'), skillList.map((k) =>
      '<div class="skill"><span class="skill-name">' + esc(k.name) + '</span><span class="skill-who">' + esc(k.who || (k.source ? k.source.replace('github.com/', '').replace(/ *[(].*$/, '') : '')) +
      (used.get(k.name) ? ' · <span class="skill-used">' + used.get(k.name) + ' kez</span>' : '') + '</span><span class="skill-desc">' + esc(k.description) + '</span></div>').join(''));
    document.getElementById('skills-count').textContent = skillList.length ? skillList.length + ' kurulu · ' + skillList.filter((k) => k.source).length + ' dışarıdan' : '';
  }
  async function refreshSkills() {
    try { skillList = await (await fetch('/skills')).json(); } catch { skillList = []; }
    renderTeam();
  }

  function pickHtml(f, key) {
    if (!f.job) return '<span class="muted">İş açılınca hat burada canlı görünür: <code>orkestra job start --title "…"</code></span>';
    const parts = key.split('/');
    const lens = LENSES.find((l) => 'review/' + l[0] === key);
    const role = BUILD_ROLES.find((r) => parts[1] === r[0] || parts[1] === 'critic-' + r[0]);
    const name = NODE_NAMES[key] || (lens ? 'Mercek: ' + lens[1] : role ? (parts[1].startsWith('critic-') ? role[1] + ' eleştirmeni' : role[1]) + ' · paket ' + parts[2] : key);
    if (key === 'ticket') return '<div class="pick-title">' + esc(name) + '</div><span class="muted">' + esc(f.job.title) + ' · ' + esc(f.job.id) + ' · ' + new Date(f.job.start).toLocaleString('tr-TR', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) + '</span>';
    const list = nodeItems(f.its, key);
    let extra = '';
    if (key === 'integrate/*' && f.gate) extra = '<div class="muted">Son kapı: ' + (f.gate.ok ? '<span class="ok">yeşil</span>' : '<span class="err">kırmızı</span>') + ' · revizyon ' + esc(f.gate.rev) + (f.gate.ok && !f.gateFresh ? ' · <span class="back">sonrasında kod değişti, yeniden koşmalı</span>' : '') + '</div>';
    return '<div class="pick-title">' + esc(name) + '</div>' + extra +
      (list.length ? [...list].reverse().map(memberDetail).join('') : '<span class="muted">Bu adımda henüz kayıt yok.</span>');
  }

  function jobCard(job) {
    return '<div class="job-head"><span class="job-title">' + esc(job.title) + '</span><span class="job-time" data-since="' + job.start + '"></span></div>' +
      '<div class="whos">' + job.members.map((m) => {
        const a = actorOf(m);
        return '<div class="who' + (m.state === 'run' ? ' run' : '') + '" style="--c:' + a.color + '"><span class="av">' + esc(a.name[0]) + '</span>' +
          '<span class="who-name">' + esc(a.name) + '</span>' + (m.agent ? '<span class="badge-agent">ajan</span>' : '') + (m.model ? '<span class="who-model">' + esc(m.model) + '</span>' : '') +
          '<span class="who-state">' + stateText(m) + '</span></div>';
      }).join('') + '</div>';
  }

  function doneCard(job) {
    const total = (job.end - job.start) / 1000;
    const chips = job.members.map((m) => {
      const a = actorOf(m);
      return '<span class="chip' + (m.state === 'ok' ? '' : ' err') + '" style="--c:' + a.color + '"><i></i>' + esc(a.name) + (m.state === 'ok' ? '' : m.state === 'stale' ? ' · yanıtsız' : ' · hata') + '</span>';
    }).join('');
    return '<div class="done-row"><span class="done-clock">' + hhmm(job.end) + '</span><span class="done-title">' + esc(job.title) + '</span>' +
      '<span class="chips">' + chips + '</span><span class="done-total">' + (total >= 0.05 ? dur(total) : '') + '</span><span class="chev">▶</span></div>' +
      '<div class="detail">' + job.members.map(memberDetail).join('') + '</div>';
  }

  function flowRow(job, f) {
    const total = (job.end - job.start) / 1000;
    const chips = '<span class="chip"><i style="background: var(--' + (job.status === 'merged' ? 'ok' : 'muted') + ')"></i>' + (job.status === 'merged' ? 'birleştirildi' : 'kapatıldı') + '</span>' +
      (f.round > 1 ? '<span class="chip">tasarım ' + f.round + ' tur</span>' : '') + (f.reviewRound > 1 ? '<span class="chip">inceleme ' + f.reviewRound + ' tur</span>' : '');
    return '<div class="done-row"><span class="done-clock">' + hhmm(job.end) + '</span><span class="done-title">' + esc(job.title) + '</span>' +
      '<span class="chips">' + chips + '</span><span class="done-total">' + dur(total) + '</span><span class="chev">◆</span></div>';
  }

  // Anahtarlı güncelleme: öğeler yeniden yaratılmaz, böylece hareketler her saniye baştan başlamaz.
  const pools = new Map();
  function sync(container, list, enterClass) {
    let pool = pools.get(container);
    if (!pool) pools.set(container, (pool = new Map()));
    const seen = new Set();
    let before = [...container.children].find((el) => !el.classList.contains('leaving')) || null;
    for (const item of list) {
      seen.add(item.key);
      let el = pool.get(item.key);
      if (!el) {
        el = document.createElement('div');
        el.dataset.key = item.key;
        if (live && enterClass) el.classList.add(enterClass);
        pool.set(item.key, el);
      }
      if (el.dataset.sig !== item.sig) {
        el.dataset.sig = item.sig;
        el.className = item.cls + (el.classList.contains(enterClass) ? ' ' + enterClass : '');
        el.innerHTML = item.html;
      }
      if (el !== before) container.insertBefore(el, before);
      before = el.nextElementSibling;
      while (before && before.classList.contains('leaving')) before = before.nextElementSibling;
    }
    for (const [key, el] of pool) {
      if (seen.has(key)) continue;
      pool.delete(key);
      if (live) {
        el.classList.add('leaving');
        setTimeout(() => el.remove(), 300);
      } else el.remove();
    }
  }
  // Yalnızca içerik değişince yazar: şemadaki hareketler her olayda baştan başlamasın.
  function setHtml(el, html) {
    if (el.dataset.sig === html) return;
    el.dataset.sig = html;
    el.innerHTML = html;
  }

  function tick() {
    const now = Date.now();
    for (const el of document.querySelectorAll('[data-since]')) el.textContent = dur(Math.max(0, (now - Number(el.dataset.since)) / 1000));
  }

  function render() {
    const now = Date.now();
    const items = allItems(now);
    const loose = looseJobs(items);
    const flows = [...jobsById.values()];
    const openJob = flows.filter((j) => j.status === 'open').sort((a, b) => b.start - a.start)[0] || null;
    if (shownJob && !jobsById.has(shownJob)) shownJob = null;
    const job = shownJob ? jobsById.get(shownJob) : openJob;
    const f = flowOf(job, items);

    const running = loose.filter((j) => j.running).sort((a, b) => a.start - b.start);
    const busy = items.filter((i) => i.state === 'run').length;
    const pill = document.getElementById('pill');
    pill.classList.toggle('busy', busy > 0);
    pill.lastElementChild.textContent = busy ? busy + ' çalışıyor' : 'Boşta';
    document.title = (busy ? '(' + busy + ') ' : '') + 'Orkestra';

    // Akış
    document.getElementById('job-title').textContent = job ? job.title : 'Açık iş yok';
    const tag = document.getElementById('job-tag');
    tag.hidden = !job;
    if (job) {
      tag.className = 'tag ' + job.status;
      tag.textContent = job.status === 'open' ? 'sürüyor' : job.status === 'merged' ? 'birleştirildi' : 'kapatıldı';
    }
    setHtml(document.getElementById('job-meta'), !job ? '' : job.end ? hhmm(job.start) + ' → ' + hhmm(job.end) + ' · ' + dur((job.end - job.start) / 1000) : '<span data-since="' + job.start + '"></span>');
    document.getElementById('back').hidden = !shownJob;
    currentPick = picked && job ? picked : f.lastKey;
    setHtml(document.getElementById('flow'), drawFlow(f));
    setHtml(document.getElementById('stages'), STAGES.map(([key, label], i) =>
      '<button class="stage' + (f.stage === key ? ' on' : f.touched.includes(key) ? ' done' : '') + '" data-stage="' + key + '"><b>' + (i + 1) + '</b>' + label + '</button>').join('') +
      '<span class="hint">Ayrıntı için bir düğüme ya da aşamaya tıkla</span>');
    setHtml(document.getElementById('pick'), pickHtml(f, currentPick || 'ticket'));

    document.getElementById('now-title').hidden = running.length === 0;
    sync(document.getElementById('now'), running.map((j) => ({ key: j.key, cls: 'job', sig: j.members.map((m) => m.key + m.state).join('|'), html: jobCard(j) })), 'enter');

    // Bitenler: hattı olan işler ve eski kayıtlar, bitişe göre.
    const finished = [
      ...loose.filter((j) => !j.running).map((j) => ({ loose: j, end: j.end })),
      ...flows.filter((j) => j.status !== 'open').map((j) => ({ flow: j, end: j.end })),
    ].sort((a, b) => b.end - a.end);
    const rows = [];
    let day = '';
    for (const item of finished.slice(0, limit)) {
      if (dayKey(item.end) !== day) {
        day = dayKey(item.end);
        rows.push({ key: 'day' + day, cls: 'day', sig: dayLabel(item.end), html: esc(dayLabel(item.end)) });
      }
      if (item.flow) {
        const shown = shownJob === item.flow.id;
        rows.push({ key: 'job:' + item.flow.id, cls: 'done' + (shown ? ' shown' : ''), sig: shown + item.flow.status, html: flowRow(item.flow, flowOf(item.flow, items)) });
      } else {
        const j = item.loose, open = opened.has(j.key);
        rows.push({ key: j.key, cls: 'done' + (open ? ' open' : ''), sig: open + '|' + j.members.map((m) => m.key + m.state).join('|'), html: doneCard(j) });
      }
    }
    sync(document.getElementById('done'), rows, 'fresh');
    document.getElementById('count').textContent = finished.length ? finished.length + ' iş' : 'Henüz biten iş yok';
    document.getElementById('more').hidden = finished.length <= limit;
    renderTeam();
    tick();
  }

  document.getElementById('done').addEventListener('click', (ev) => {
    const row = ev.target.closest('.done-row');
    if (!row) return;
    const key = row.parentElement.dataset.key;
    if (key.startsWith('job:')) {
      shownJob = shownJob === key.slice(4) ? null : key.slice(4);
      picked = null;
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else opened.has(key) ? opened.delete(key) : opened.add(key);
    render();
  });
  document.getElementById('flow').addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-node]');
    if (!el) return;
    picked = el.dataset.node;
    render();
  });
  document.getElementById('stages').addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-stage]');
    if (!el) return;
    picked = el.dataset.stage === 'ticket' ? 'ticket' : el.dataset.stage + '/*';
    render();
  });
  document.getElementById('back').addEventListener('click', () => { shownJob = null; picked = null; render(); });
  document.getElementById('more').addEventListener('click', () => { limit += 40; render(); });

  function connect() {
    const source = new EventSource('/events');
    const conn = document.getElementById('conn');
    source.addEventListener('history', (m) => {
      calls.clear(); notes.length = 0; lensEvents.length = 0; gateEvents.length = 0; jobsById.clear(); live = false;
      for (const e of JSON.parse(m.data)) apply(e);
      render();
      live = true;
    });
    source.onmessage = (m) => { apply(JSON.parse(m.data)); render(); };
    source.onopen = () => conn.classList.add('on');
    source.onerror = () => conn.classList.remove('on');
  }
  connect();
  refreshSkills();
  setInterval(refreshSkills, 300000);
  setInterval(tick, 1000);
  // Yanıtsız sayılma ve gün başlıkları için seyrek yeniden kurulum.
  setInterval(render, 30000);
</script>
</body>
</html>`;
