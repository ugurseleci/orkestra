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
  header { display: flex; align-items: center; gap: 12px; padding: 10px 16px; border-bottom: 1px solid var(--line); position: sticky; top: 0; background: var(--bg); z-index: 2; }
  h1 { font-size: 17px; margin: 0; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--err); }
  .dot.on { background: var(--ok); }
  .pill { margin-left: auto; display: inline-flex; align-items: center; gap: 8px; padding: 5px 12px; border-radius: 999px; background: var(--soft); color: var(--muted); font-size: 13px; font-weight: 600; transition: background .3s, color .3s; }
  .pill.busy { background: color-mix(in srgb, var(--run) 16%, transparent); color: var(--text); }
  .pill i { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
  .pill.busy i { background: var(--run); animation: beat 1.1s ease-in-out infinite; }
  main { max-width: 1740px; margin: 0 auto; padding: 0 16px 60px; }
  h2 { display: flex; align-items: baseline; gap: 10px; font-size: 12px; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); margin: 26px 0 12px; }
  h2 small { font-size: 12px; letter-spacing: 0; text-transform: none; font-weight: 400; }

  /* ---- Akış ---- */
  .board { background: var(--panel); border: 1px solid var(--line); border-radius: 16px; margin-top: 12px; overflow: hidden; }
  .board-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 10px 16px 0; }
  .board-title { font-weight: 650; font-size: 16px; }
  .board-meta { color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; }
  .tag { padding: 2px 9px; border-radius: 999px; font-size: 12px; font-weight: 600; background: var(--soft); color: var(--muted); }
  .tag.open { background: color-mix(in srgb, var(--run) 16%, transparent); color: var(--run); }
  .tag.merged { background: color-mix(in srgb, var(--ok) 16%, transparent); color: var(--ok); }
  .legend { margin-left: auto; display: flex; gap: 16px; color: var(--muted); font: 12px ui-monospace, Menlo, monospace; }
  .legend span::before { content: ''; display: inline-block; width: 22px; height: 3px; border-radius: 2px; background: var(--c); vertical-align: middle; margin-right: 7px; }
  #back { border: 1px solid var(--line); background: var(--panel); color: var(--text); border-radius: 999px; padding: 3px 11px; font: inherit; font-size: 12px; cursor: pointer; }
  #flow { display: block; width: 100%; height: auto; }
  #flow text { fill: var(--text); font-size: 13px; font-weight: 600; }
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
  .n.small .ring { stroke-width: 2.5; }
  .n.small:hover .ring, .n.small.sel .ring { stroke-width: 4; }
  #flow .n.small text { font-size: 12px; }
  #flow .n.small tspan.dim { fill: var(--muted); font-size: 11px; font-weight: 400; }
  #flow .n.small.sel text { fill: var(--run); }
  .bar { fill: var(--text); }
  .n.sel .bar { stroke: color-mix(in srgb, var(--run) 55%, transparent); stroke-width: 4; paint-order: stroke; }
  .badge { fill: var(--panel); stroke: var(--back); stroke-width: 1.5; }
  .box { fill: var(--panel); stroke: var(--muted); stroke-width: 1.5; }
  .box.on { fill: var(--ok); stroke: var(--ok); }
  .tick { fill: none; stroke: #fff; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .dotted { stroke: var(--muted); stroke-width: 2; stroke-dasharray: 2 5; stroke-linecap: round; }
  .empty-note { fill: var(--muted); font-size: 13px; font-weight: 400; }
  /* Şu an çalışanlar: şemanın sol altındaki boşlukta liste, düğümlerin yanında aynı renkte rozet. */
  .who-dot { fill: var(--c); }
  .who-ring { fill: none; stroke: var(--c); stroke-width: 2; opacity: .55; transform-box: fill-box; transform-origin: center; animation: halo 1.4s ease-out infinite; }
  #flow text.who-initial { fill: #fff; font-size: 10px; font-weight: 700; pointer-events: none; }
  #flow text.who-line { font-size: 13px; font-weight: 600; }
  #flow text.who-line tspan.dim { fill: var(--muted); font-weight: 400; }
  #flow text.who-line tspan.where { fill: var(--run); font-weight: 600; }

  .stages { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; padding: 2px 16px 12px; }
  .stage { display: inline-flex; align-items: center; gap: 8px; padding: 5px 13px 5px 6px; border-radius: 999px; border: 1px solid var(--line); background: var(--panel); color: var(--muted); font: inherit; font-size: 13px; cursor: pointer; }
  .stage b { display: grid; place-items: center; width: 20px; height: 20px; border-radius: 50%; border: 1px solid var(--line); font-size: 11px; font-weight: 600; }
  .stage.done { color: var(--text); } .stage.done b { background: var(--ok); border-color: var(--ok); color: #fff; }
  .stage.on { border-color: var(--run); color: var(--text); font-weight: 600; } .stage.on b { background: var(--run); border-color: var(--run); color: #fff; }
  .stages .hint { color: var(--muted); font: 12px ui-monospace, Menlo, monospace; margin-left: 6px; }
  #pick { border-top: 1px solid var(--line); padding: 14px 16px 16px; }
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
  .steps { margin: 6px 0 0; padding: 0; list-style: none; font: 12px ui-monospace, Menlo, monospace; color: var(--muted); max-height: 220px; overflow-y: auto; }
  .steps li { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .steps .err { color: var(--err); }

  /* ---- Skill'ler ---- */
  #skills { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; overflow: hidden; }
  .skill { display: grid; grid-template-columns: 220px 150px 1fr; gap: 12px; padding: 9px 14px; border-top: 1px solid var(--line); font-size: 13px; align-items: baseline; }
  .skill:first-child { border-top: 0; }
  .skill-name { font: 13px ui-monospace, Menlo, monospace; font-weight: 600; }
  .skill-who { color: var(--muted); font-size: 12px; }
  .skill-desc { color: var(--muted); overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .skill-used { color: var(--ok); font-weight: 600; }

  /* ---- Akış dışı çalışanlar ---- */
  /* Şemanın alt bandındaki boşlukta durur; yeri çizimden gelir (placeNow: --nx/--ny/--nw, viewBox'a göre yüzde).
     Boşluk yetmezse (üç paket, dar ekran) "below" ile şemanın altına iner. Yan yana dizilir; sığmazsa yatay kayar. */
  .flow-wrap { position: relative; }
  #now-box { position: absolute; left: var(--nx, 1.5%); top: var(--ny, 60%); width: var(--nw, 45%); pointer-events: none; }
  #now-box.below { position: static; width: auto; padding: 0 16px 6px; }
  #now-box > * { pointer-events: auto; }
  #now-box h2 { margin: 0 0 5px; font-size: 11px; }
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
  /* Yay eğrisi: hafifçe taşıp yerine oturur. Sürekli hareketler yalnız çalışan varken döner (#flow.busy, .s-run,
     .who.run); boşta hiçbir şey kıpırdamaz. Tek seferlik "fx-" hareketlerini betik tetikler (animateFlow). */
  :root { --spring: cubic-bezier(.34, 1.56, .64, 1); }
  .enter { animation: rise .5s var(--spring); }
  .leaving { animation: leave .3s ease-in forwards; pointer-events: none; }
  .fresh { animation: rise .5s var(--spring), flash 1.8s ease-out; }
  @keyframes rise { from { opacity: 0; translate: -14px 6px; scale: .97; } }
  @keyframes leave { to { opacity: 0; translate: 0 14px; scale: .96; } }
  .n .ring, .n .core, .n .bar, .orbit, .fx-burst, .fx-sparks, .fx-done circle, .round, .wk, .box, .who-dot { transform-box: fill-box; transform-origin: center; }

  /* Süren kenarda akan ışık boncuğu: kenarın üstünde, tek noktalı kesik çizgi olarak kayar. */
  .spark { fill: none; stroke: var(--run); stroke-width: 9; stroke-linecap: round; stroke-dasharray: 0 72; pointer-events: none; animation: bead 1.5s linear infinite; }
  .spark.glow { stroke-width: 18; opacity: .2; }
  @keyframes bead { to { stroke-dashoffset: -72; } }
  /* Çalışan düğüm: çekirdek nefes alır; kapının üç noktası sırayla zıplar; inceleme göbeğinin çevresinde yay döner. */
  #flow.busy .n.s-run .core { animation: corebeat .9s ease-in-out infinite alternate; }
  #flow.busy .n.s-run rect.ring ~ .core { animation: dots 1.1s ease-in-out infinite; }
  #flow.busy .n.s-run rect.ring ~ .core:nth-of-type(2) { animation-delay: .14s; }
  #flow.busy .n.s-run rect.ring ~ .core:nth-of-type(3) { animation-delay: .28s; }
  .orbit { fill: none; stroke: none; pointer-events: none; }
  #flow.busy .n.s-run .orbit { stroke: var(--run); stroke-width: 2.5; stroke-linecap: round; stroke-dasharray: 44 195; animation: orbit 2.2s linear infinite; }
  #flow.busy .who-dot { animation: breathe 1.1s ease-in-out infinite alternate; }
  .who.run .av { animation: avbreathe 1.1s ease-in-out infinite alternate; }
  @keyframes corebeat { from { transform: scale(.8); } to { transform: scale(1.2); } }
  @keyframes dots { 0%, 55%, 100% { transform: none; } 28% { transform: translateY(-4.5px); } }
  @keyframes orbit { to { transform: rotate(360deg); } }
  @keyframes breathe { to { transform: scale(1.1); } }
  @keyframes avbreathe { to { scale: 1.08; } }
  /* Döngüler: geri gönderilen tasarım yayında ok başları Eleştirmen'den Mimar'a döner; Düzelt'in iki çizgisi ters yönde akar. */
  #flow.busy .e-back.loop-up { stroke-dasharray: 5 6; animation: loopdash .55s linear infinite; }
  #flow.busy .e-back.loop-down { stroke-dasharray: 5 6; animation: loopdash .55s linear infinite reverse; }
  @keyframes loopdash { to { stroke-dashoffset: -11; } }
  .chev { display: none; fill: none; stroke: var(--back); stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; pointer-events: none; }
  @supports (offset-path: path('M 0 0 L 1 1')) {
    #flow.busy .chev { display: block; offset-rotate: auto; animation: travel 2.6s linear infinite; }
    #flow.busy .chev.b { animation-delay: -1.3s; }
  }
  @keyframes travel { from { offset-distance: 0%; } to { offset-distance: 100%; } }

  /* Tek seferlik geçişler: düğüm durumu değişince yay gibi büyür, halka saçılır; biten düğümde onay işareti çizilir,
     hata sarsılır, geri gönderilen sola çekilip döner. */
  .n.fx-pop .ring, .n.fx-ok .ring, .box.fx-pop { animation: pop .55s var(--spring); }
  .n.fx-ok .core { animation: pop .55s var(--spring) .12s backwards; }
  .n.fx-shake .ring, .n.fx-shake .core { animation: shake .5s ease-in-out; }
  .n.fx-nudge .ring, .n.fx-nudge .core { animation: nudge .6s ease-out; }
  .n.fx-sel .ring, .n.fx-sel .bar { animation: selpop .35s var(--spring); }
  .fx-burst { fill: none; stroke: var(--fx); stroke-width: 3; pointer-events: none; animation: burst .7s ease-out forwards; }
  .fx-sparks { fill: none; stroke: var(--fx); stroke-width: 3.5; stroke-linecap: round; animation: sparks .75s cubic-bezier(.2, .7, .3, 1) forwards; }
  .fx-done { animation: donefade 1.7s ease-in forwards; }
  .fx-done circle { fill: var(--ok); animation: pop .5s var(--spring); }
  .fx-done path { fill: none; stroke: #fff; stroke-width: 2.4; stroke-linecap: round; stroke-linejoin: round; stroke-dasharray: 14; stroke-dashoffset: 14; animation: tickdraw .35s ease-out .2s forwards; }
  .tick.fx-tick { stroke-dasharray: 13; stroke-dashoffset: 13; animation: tickdraw .4s ease-out .15s forwards; }
  .round.fx-bump { animation: bump .6s ease-out; }
  text.round.fx-bump { animation-name: bumpin; }
  .wk.fx-in { animation: wkin .5s var(--spring) backwards; }
  .wk.row.fx-in { animation: rowin .45s cubic-bezier(.2, .8, .2, 1) backwards; }
  @keyframes pop { from { transform: scale(var(--pop, .5)); } }
  /* İçinde yazı olan büyük göbek ve kapı az küçülür (yazının üstüne binmesin). */
  .n .orbit ~ .ring { --pop: .88; } .n rect.ring { --pop: .82; }
  @keyframes selpop { from { transform: scale(.8); } }
  @keyframes shake { 15% { transform: translateX(-5px); } 35% { transform: translateX(5px); } 55% { transform: translateX(-3px); } 75% { transform: translateX(2px); } }
  @keyframes nudge { 30% { transform: translateX(-7px) scale(.88); } 65% { transform: translateX(2px); } }
  @keyframes burst { from { transform: scale(1); opacity: .85; } to { transform: scale(var(--to, 1.9)); opacity: 0; } }
  @keyframes sparks { from { transform: scale(.6); opacity: 1; } 60% { opacity: 1; } to { transform: scale(var(--to, 1.8)); opacity: 0; } }
  @keyframes tickdraw { to { stroke-dashoffset: 0; } }
  @keyframes donefade { 0%, 72% { opacity: 1; } 100% { opacity: 0; } }
  @keyframes bump { 30% { transform: translateY(-7px) scale(1.2); } 60% { transform: translateY(1px) scale(.96); } }
  @keyframes bumpin { 30% { transform: scale(1.35); } 60% { transform: scale(.94); } }
  @keyframes wkin { from { opacity: 0; transform: scale(.3); } }
  @keyframes rowin { from { opacity: 0; transform: translateX(-14px); } }
  /* Kenar durumu değişince yeni renk kenar boyunca akar, önünde bir jeton kayar. */
  .e.fx-draw { stroke-dasharray: var(--len); animation: draw var(--ms) cubic-bezier(.45, 0, .25, 1) both; }
  .e.fx-tok { stroke-width: 11; stroke-dasharray: 0 var(--gap); pointer-events: none; animation: tok var(--ms) cubic-bezier(.45, 0, .25, 1) both; }
  .e.thin.fx-tok { stroke-width: 8; }
  @keyframes draw { from { stroke-dashoffset: var(--len); } to { stroke-dashoffset: 0; } }
  @keyframes tok { from { stroke-dashoffset: 0; opacity: 1; } 85% { opacity: 1; } to { stroke-dashoffset: var(--nlen); opacity: 0; } }
  /* İlk açılış: hat soldan sağa çizilir, düğümler sırayla belirir (yalnız sayfa yüklenince; --d/--len/--ms betikten;
     çift #flow, çizimin döngü kenarlarındaki akış kuralını da bastırması için). */
  #flow.intro > * { animation: fadein .4s ease-out both; animation-delay: calc(var(--d, 0ms) + 140ms); }
  #flow#flow.intro > .e { stroke-dasharray: var(--len); animation: draw var(--ms, .3s) linear both; animation-delay: var(--d, 0ms); }
  #flow.intro > .spark, #flow.intro .chev { animation: none; visibility: hidden; }
  #flow.intro .n .ring, #flow.intro .n .bar { animation: pop .55s var(--spring) both; animation-delay: calc(var(--d, 0ms) + 140ms); }
  .stages.intro .stage { animation: rise .5s var(--spring) both; animation-delay: calc(var(--i, 0) * 70ms + 350ms); }
  #flow.fx-swap { animation: fadein .35s ease-out; }
  @keyframes fadein { from { opacity: 0; } }
  /* Sayı değişince yeni değer aşağıdan yuvarlanır; öne geçen aşamanın numarası zıplar. */
  .roll, .member.upd span.muted { display: inline-block; animation: roll .45s var(--spring); }
  .stage.fx-pop b { animation: stagepop .5s var(--spring); }
  @keyframes roll { from { opacity: 0; translate: 0 .7em; } }
  @keyframes stagepop { from { scale: .4; } }
  @keyframes flash { 0%, 30% { box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 45%, transparent); } 100% { box-shadow: 0 0 0 3px transparent; } }
  @keyframes drop { from { opacity: 0; translate: 0 -6px; } }
  @keyframes spin { to { rotate: 360deg; } }
  @keyframes beat { 50% { scale: 1.6; opacity: .5; } }
  @keyframes slide { from { background-position: -50% 0; } to { background-position: 150% 0; } }
  @keyframes flowdash { to { stroke-dashoffset: -19; } }
  @keyframes halo { from { transform: scale(.75); opacity: .6; } to { transform: scale(1.35); opacity: 0; } }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation: none !important; transition: none !important; }
    .spark, .chev, .orbit { display: none !important; }
  }
  /* Alçak alan (editörün alt paneli gibi): başlık ve düğmeler sıkışır, hattın tamamı kaydırmadan görünür. */
  @media (max-height: 620px) {
    header { padding: 7px 16px; }
    h1 { font-size: 15px; }
    .pill { padding: 3px 11px; font-size: 12px; }
    .board { margin-top: 8px; }
    .board-head { padding: 8px 16px 0; }
    .board-title { font-size: 15px; }
    .stages { padding: 0 16px 8px; gap: 6px; }
    .stage { padding: 3px 11px 3px 4px; font-size: 12px; }
  }
  @media (max-width: 1080px) { .stages .hint { display: none; } }
  @media (max-width: 640px) {
    .done-row { grid-template-columns: 46px 1fr 60px 14px; }
    .chips, .legend { display: none; }
    .skill { grid-template-columns: 1fr; gap: 2px; }
    /* Dar ekranda şemanın üstüne binmesin: şemanın altında, alt alta. */
    #now-box { position: static; width: auto; padding: 0 12px 6px; }
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
      <svg id="flow" viewBox="0 0 1228 326" role="img" aria-label="İşin hattı"></svg>
      <div id="now-box" class="below">
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
  // Mercekler: İnceleme göbeğinin altında, bu sırayla alt alta.
  const LENSES = [['alignment', 'Plana uygunluk'], ['correctness', 'Doğruluk'], ['testing', 'Test'], ['production', 'Üretim'], ['architecture', 'Mimari'], ['security', 'Güvenlik']];
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
    else if (e.type === 'end' && calls.has(e.id)) Object.assign(calls.get(e.id), { state: e.ok ? 'ok' : 'err', seconds: e.seconds, text: e.text, endTs: e.ts, files: e.files, stop: e.stop });
    // Orkestra döngüsünün adımları (engine: 'loop'): araç adı ve kısa özet; içerik kayda girmez.
    else if (e.type === 'step' && calls.has(e.id)) {
      const c = calls.get(e.id);
      (c.steps ||= []).push(e);
      c.lastTs = e.ts;
    }
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
        // Adım yazan uzun ajan çağrısı son adımından sayılır.
        const stale = c.state === 'run' && now - (c.lastTs || c.startTs) > STALE_CALL_MS;
        return { ...hat(c), steps: c.steps, stop: c.stop, scope: c.scope, key: 'c' + c.id, actor: c.actor, model: c.model, task: c.task, start: c.startTs, end: stale ? c.startTs : c.endTs, state: stale ? 'stale' : c.state, seconds: c.seconds, text: c.text, lenses: c.lenses, agent: isAgentCall(c), skills: skillsOf(c), write: c.write === true, files: c.files };
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
    f.lenses = LENSES.map(([key, label]) => {
      const list = nodeItems(inRound, 'review/' + key).filter((i) => i.lens || i.state === 'run');
      return { key, label, state: stateOf(list), model: list[list.length - 1]?.model };
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
  // Tek bantlı yatay hat: İş → Tasarım → Yapım → Bütünleştirme → İnceleme → Birleştirme. Ana hat CY'de;
  // döngüler (tasarım turu, düzelt) hattın üstünde, ayrıntı listeleri (katmanlar, mercekler, onaylar) altında.
  // viewBox genişliği (FW) alanın genişliğini izler: yazılar ekranda gerçek boyunda kalır, artan yer aralara dağılır.
  const FH = 326, CY = 128, BOXW = 216;
  let FW = 1228;
  // Sütun genişlikleri: 2 tam · 1 mercek modeli yazılmaz · 0 dar (alt yazılar da yazılmaz).
  function planFlow(W) {
    const widths = (mode) => ({ arch: mode ? 92 : 82, crit: 124, box: mode ? 86 : 64, pill: BOXW + 40, hub: 160, merge: 154 + (mode === 2 ? 70 : 0), tail: mode ? 172 : 124 });
    const base = (mode) => 26 + Object.values(widths(mode)).reduce((a, b) => a + b, 0);
    const mode = [2, 1].find((m) => base(m) <= W) || 0;
    const w = widths(mode), g = Math.max(0, (W - base(mode)) / 6);
    const p = { mode, tight: mode === 0, min: base(0), xBar: 26 };
    p.xArch = Math.round(p.xBar + w.arch + g);
    p.xCrit = Math.round(p.xArch + w.crit + g);
    p.xBox = Math.round(p.xCrit + w.box + g);
    p.xPill = Math.round(p.xBox + w.pill + g);
    p.xHub = Math.round(p.xPill + w.hub + g);
    p.xMerge = Math.round(p.xHub + w.merge + g);
    return p;
  }
  const FW_MIN = planFlow(0).min, FW_MAX = 1700;
  function measureFlow() {
    const width = document.querySelector('.flow-wrap').clientWidth || 1228;
    FW = Math.min(FW_MAX, Math.max(FW_MIN, Math.round(width)));
    const box = '0 0 ' + FW + ' ' + FH, svg = document.getElementById('flow');
    if (svg.getAttribute('viewBox') !== box) svg.setAttribute('viewBox', box);
  }
  // Süren kalın kenarın üstüne akan ışık boncuğu biner (ince kenarlar kısa; onlarda yalnız kesik çizgi akar).
  const edge = (d, state, extra) => '<path class="e e-' + state + (extra ? ' ' + extra : '') + '" d="' + d + '"/>' +
    (state === 'run' && !extra ? '<path class="spark glow" d="' + d + '"/><path class="spark" d="' + d + '"/>' : '');
  const text = (x, y, s, cls, anchor) => '<text x="' + x + '" y="' + y + '"' + (cls ? ' class="' + cls + '"' : '') + ' text-anchor="' + (anchor || 'middle') + '">' + esc(s) + '</text>';
  // Düğüm anahtarı → şemadaki yeri (her çizimde yeniden dolar).
  let positions = {};
  function node(key, x, y, state, r) {
    r = r || 10;
    positions[key] = [x, y];
    return '<g class="n s-' + state + (key === currentPick ? ' sel' : '') + '" data-node="' + key + '" transform="translate(' + x + ' ' + y + ')">' +
      '<circle class="halo" r="' + (r + 9) + '"/><circle r="' + (r + 6) + '" fill="transparent"/><circle class="ring" r="' + r + '"/><circle class="core" r="' + (r - 5.5) + '"/></g>';
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

  // Şemanın sol altındaki boşluk (İş ve Tasarım'ın altı): şu an çalışanlar ve nerede çalıştıkları. Aynı renkte
  // küçük bir rozet ilgili düğümün yanına konur (düğümün etiketini örtmeyecek yere).
  const NOW_X = 16, NOW_Y = CY + 114, NOW_ROW = 24, NOW_MAX = 4;
  function badgeAt(key, at, n) {
    const step = (n - 1) * 20;
    // Göbeğin sağ üstü; Düzelt'in etiketi daha yukarıda kalır.
    if (key === 'review/*') return [at[0] + 40 + step, at[1] - 28];
    if (key === 'integrate/*') return [at[0] + 52 + step, at[1] + 26];
    // Birleştir çubuğunun üstünde etiketi, altında insan var: rozet sol alta konur.
    if (key === 'merge/*') return [at[0] - 20 - step, at[1] + 24];
    if (key === 'review/fix') return [at[0] - 24 - step, at[1]];
    // Yapım düğümlerinin etiketi üstte (rozet hattın üstünde, düğümün sağında), tasarım düğümlerininki altta.
    return key.startsWith('build/') ? [at[0] + 6 + step, at[1] + 17] : [at[0] + 18 + step, at[1] - 18];
  }
  // clipX: listenin taşmaması gereken sağ sınır (paket kutuları ya da akış dışı çalışanların kartları).
  function drawWorkers(f, clipX) {
    if (!f.job) return '';
    const running = f.its.filter((i) => i.state === 'run');
    let s = '<clipPath id="now-clip"><rect x="0" y="' + (NOW_Y - 44) + '" width="' + clipX + '" height="' + FH + '"/></clipPath><g clip-path="url(#now-clip)">' +
      text(NOW_X, NOW_Y - 24, 'ŞU AN' + (running.length > NOW_MAX ? ' · ' + running.length + ' ÇALIŞIYOR, İLK ' + NOW_MAX : ''), 'mono', 'start');
    if (running.length === 0) {
      const last = [...f.its].reverse().find((i) => !i.lens && i.end);
      return s + text(NOW_X, NOW_Y, 'Çalışan yok' + (last ? ' · son: ' + actorOf(last).name + ', ' + nodeLabel(nodeKeyOf(last)) + ' ' + hhmm(last.end) : ''), 'sub', 'start') + '</g>';
    }
    const perNode = {};
    let badges = '';
    running.slice(0, NOW_MAX).forEach((i, row) => {
      const a = actorOf(i), key = nodeKeyOf(i), y = NOW_Y + row * NOW_ROW;
      const what = [i.agent ? 'ajan' : i.note ? null : 'danışman', ...(i.skills || [])].filter(Boolean).join(' · ');
      s += '<g class="wk row" data-w="r:' + esc(i.key) + '" style="--c:' + a.color + '"><circle class="who-ring" cx="' + (NOW_X + 11) + '" cy="' + (y - 4) + '" r="11"/><circle class="who-dot" cx="' + (NOW_X + 11) + '" cy="' + (y - 4) + '" r="9"/>' +
        '<text class="who-initial" x="' + (NOW_X + 11) + '" y="' + y + '" text-anchor="middle">' + esc(a.name[0]) + '</text>' +
        '<text class="who-line" x="' + (NOW_X + 28) + '" y="' + y + '" text-anchor="start">' + esc(a.name) +
        '<tspan class="where" dx="8">' + esc(nodeLabel(key)) + '</tspan>' +
        '<tspan class="dim" dx="8" data-since="' + i.start + '"></tspan>' +
        (what ? '<tspan class="dim" dx="8">' + esc(what) + '</tspan>' : '') + '</text></g>';
      const at = positions[key];
      if (at) {
        const n = (perNode[key] = (perNode[key] || 0) + 1);
        const [bx, by] = badgeAt(key, at, n);
        badges += '<g class="wk" data-w="b:' + esc(i.key) + '" style="--c:' + a.color + '"><circle class="who-ring" cx="' + bx + '" cy="' + by + '" r="12"/><circle class="who-dot" cx="' + bx + '" cy="' + by + '" r="9"/>' +
          '<text class="who-initial" x="' + bx + '" y="' + (by + 4) + '" text-anchor="middle">' + esc(a.name[0]) + '</text></g>';
      }
    });
    return s + '</g>' + badges;
  }

  // Akış dışı çalışanların kartlarına ayrılan boşluk (viewBox birimiyle); drawFlow doldurur, placeNow yerleştirir.
  let nowZone = { x: 16, y: CY + 64, w: 500, h: 130 };
  function placeNow(count) {
    const box = document.getElementById('now-box');
    const scale = (document.getElementById('flow').clientWidth || FW) / FW;
    const fits = count > 0 && nowZone.h * scale >= 92 && nowZone.w * scale >= 200;
    box.classList.toggle('below', !fits);
    const pct = (v) => (v * 100).toFixed(2) + '%';
    box.style.setProperty('--nx', pct(nowZone.x / FW));
    box.style.setProperty('--ny', pct(nowZone.y / FH));
    box.style.setProperty('--nw', pct(nowZone.w / FW));
  }

  // loose: akış dışı çalışan iş sayısı (kartları alt banda biner; "şu an" listesi onlara yer bırakır).
  function drawFlow(f, loose) {
    const P = planFlow(FW), xBar = P.xBar, xArch = P.xArch, xCrit = P.xCrit, xBox = P.xBox, xPill = P.xPill, xHub = P.xHub, xMerge = P.xMerge;
    const xInt = xPill + 42;
    positions = { 'integrate/*': [xInt, CY], 'review/*': [xHub, CY], 'merge/*': [xMerge, CY] };
    const sel = (key) => (currentPick === key ? ' sel' : '');
    let s = '';

    // 1 · İş girişi → 2 · Tasarım: Mimar ⇄ Eleştirmen (geri gönderme yayı ve tur rozeti hattın üstünde)
    s += edge('M ' + (xBar + 5) + ' ' + CY + ' L ' + (xArch - 12) + ' ' + CY, f.architect);
    s += edge('M ' + (xArch + 12) + ' ' + CY + ' L ' + (xCrit - 12) + ' ' + CY, f.critic);
    const revising = f.critic === 'back', mid = Math.round((xArch + xCrit) / 2);
    // Mimar yeniden yazarken yay akar, üstünde iki ok başı Eleştirmen'den Mimar'a döner (rozetin arkasından geçer).
    const arc = 'M ' + xCrit + ' ' + (CY - 13) + ' C ' + xCrit + ' ' + (CY - 78) + ', ' + xArch + ' ' + (CY - 78) + ', ' + xArch + ' ' + (CY - 13);
    const looping = revising && f.architect === 'run';
    s += edge(arc, revising ? 'back' : 'idle', 'thin' + (looping ? ' loop-up' : ''));
    if (looping) s += ['', ' b'].map((c) => '<path class="chev' + c + '" d="M -4 -5 L 3 0 L -4 5" style="offset-path: path(' + "'" + arc + "'" + ')"/>').join('');
    if (f.round > 0) {
      s += '<g class="round" data-round="design:' + f.round + '"><rect class="badge" x="' + (mid - 47) + '" y="' + (CY - 73) + '" width="94" height="22" rx="11"' + (revising ? '' : ' style="stroke: var(--idle)"') + '/>';
      s += text(mid, CY - 58, 'tur ' + f.round + ' / ' + MAX_ROUNDS, 'mono' + (revising ? ' t-back' : '')) + '</g>';
    }
    if (revising) s += text(mid, CY - 28, 'düzelt', 't-back');
    s += '<g class="n' + sel('ticket') + '" data-node="ticket"><rect x="' + (xBar - 18) + '" y="' + (CY - 34) + '" width="36" height="68" fill="transparent"/><rect class="bar" x="' + (xBar - 4.5) + '" y="' + (CY - 26) + '" width="9" height="52" rx="2"' + (f.job ? '' : ' style="fill: var(--idle)"') + '/></g>';
    s += text(16, CY - 53, 'İş girişi', '', 'start') + text(16, CY - 37, f.job ? f.job.id : 'açık iş yok', 'sub', 'start');
    s += node('design/architect', xArch, CY, f.architect) + text(xArch, CY + 34, 'Mimar') + (P.tight ? '' : text(xArch, CY + 50, 'tasarımı yazar', 'sub'));
    s += node('design/critic', xCrit, CY, f.critic) + text(xCrit, CY + 34, 'Eleştirmen') + (P.tight ? '' : text(xCrit, CY + 50, 'tasarımı değerlendirir', 'sub'));

    // 3 · Yapım: paket kutuları; her pakette Uygulayıcı ve Testçi, yanlarında eleştirmenleri
    const n = f.pkgs.length, PH = 84, GAP = 8;
    const top = Math.max(18, CY - 43 - ((n - 1) * (PH + GAP)) / 2), bottom = top + n * PH + (n - 1) * GAP;
    const xi = xBox + 88, xc = xBox + 178, xSplit = xBox - 40, xOut = xBox + BOXW;
    let pkgHtml = '', nodesHtml = '';
    f.pkgs.forEach((pkg, p) => {
      const boxTop = top + p * (PH + GAP);
      pkgHtml += '<rect class="pkg" x="' + xBox + '" y="' + boxTop + '" width="' + BOXW + '" height="' + PH + '" rx="10"/>' + text(xOut - 9, boxTop + PH - 7, 'PAKET ' + pkg.name, 'mono', 'end');
      pkg.nodes.forEach((nd, r) => {
        const y = boxTop + 27 + r * 32;
        const out = nd.critic !== 'idle' ? nd.critic : nd.state === 'ok' ? 'ok' : 'idle';
        s += edge('M ' + (xCrit + 12) + ' ' + CY + ' L ' + xSplit + ' ' + CY + ' C ' + (xSplit + 26) + ' ' + CY + ', ' + (xBox - 26) + ' ' + y + ', ' + xBox + ' ' + y + ' L ' + (xi - 11) + ' ' + y, nd.state);
        s += edge('M ' + (xi + 11) + ' ' + y + ' L ' + (xc - 11) + ' ' + y, nd.critic !== 'idle' ? nd.critic : 'idle');
        s += edge('M ' + (xc + 11) + ' ' + y + ' L ' + xOut + ' ' + y + ' C ' + (xOut + 26) + ' ' + y + ', ' + (xPill - 26) + ' ' + CY + ', ' + xPill + ' ' + CY, out);
        // Etiketler hattın üstünde, düğümün solunda durur (alt alta satırlar birbirine binmesin).
        nodesHtml += node('build/' + nd.role + '/' + pkg.name, xi, y, nd.state, 9) + text(xi - 15, y - 8, nd.label, '', 'end') +
          node('build/critic-' + nd.role + '/' + pkg.name, xc, y, nd.critic, 9) + text(xc - 15, y - 8, 'eleştirmen', 'sub', 'end');
      });
    });
    s = pkgHtml + s + nodesHtml;
    if (!f.job) s += text(xBox + BOXW / 2, top - 14, 'Şu anda açık iş yok', 'empty-note');

    // 4 · Bütünleştir: kapı, altında test katmanları
    s += edge('M ' + (xPill + 84) + ' ' + CY + ' L ' + (xHub - 34) + ' ' + CY, f.review === 'idle' ? 'idle' : f.integrate === 'ok' ? 'ok' : 'idle');
    s += '<g class="n s-' + f.integrate + sel('integrate/*') + '" data-node="integrate/*"><rect class="ring" x="' + xPill + '" y="' + (CY - 17) + '" width="84" height="34" rx="17"/>' +
      [-18, 0, 18].map((dx) => '<circle class="core" cx="' + (xInt + dx) + '" cy="' + CY + '" r="3.5" style="' + (f.integrate === 'idle' ? 'fill: var(--idle)' : '') + '"/>').join('') + '</g>';
    s += text(xInt, CY - 28, 'Bütünleştir') + text(xPill + 2, CY + 52, 'TEST KATMANLARI', 'mono', 'start');
    f.tiers.forEach((t, i) => {
      const y = CY + 71 + i * 19;
      s += text(xPill + 2, y + 4, t.label, 'sub', 'start') + edge('M ' + (xPill + 80) + ' ' + y + ' L ' + (xPill + 122) + ' ' + y, t.state, 'thin');
    });

    // 5 · İnceleme: göbek hattın üstünde; üstünde Düzelt döngüsü, altında mercekler (gövdeden ayrılan dallar)
    const lensY = (i) => CY + 72 + i * 20;
    s += text(xHub + 14, CY + 52, 'MERCEKLER', 'mono', 'start');
    s += edge('M ' + xHub + ' ' + (CY + 34) + ' L ' + xHub + ' ' + lensY(f.lenses.length - 1), 'idle', 'thin');
    f.lenses.forEach((l, i) => {
      const y = lensY(i), x = xHub + 27, key = 'review/' + l.key;
      const model = P.mode === 2 && l.model ? l.model.split('/')[0] : '';
      positions[key] = [x, y];
      s += edge('M ' + xHub + ' ' + y + ' L ' + (x - 8) + ' ' + y, l.state, 'thin');
      s += '<g class="n small s-' + l.state + sel(key) + '" data-node="' + key + '"><rect x="' + (x - 12) + '" y="' + (y - 10) + '" width="' + (P.mode === 2 ? 190 : 122) + '" height="20" fill="transparent"/>' +
        '<circle class="halo" cx="' + x + '" cy="' + y + '" r="13"/><circle class="ring" cx="' + x + '" cy="' + y + '" r="6.5"/><circle class="core" cx="' + x + '" cy="' + y + '" r="2.5"/>' +
        '<text x="' + (x + 14) + '" y="' + (y + 4) + '" text-anchor="start">' + esc(l.label) +
        (model ? '<tspan class="dim" dx="8">' + esc(model.length > 12 ? model.slice(0, 11) + '…' : model) + '</tspan>' : '') + '</text></g>';
    });
    const fy = CY - 76, fixState = f.fix === 'idle' ? 'idle' : f.fix === 'run' ? 'back' : f.fix;
    s += edge('M ' + (xHub - 4) + ' ' + (CY - 33) + ' L ' + (xHub - 4) + ' ' + (fy + 9), fixState, 'thin loop-up') + edge('M ' + (xHub + 4) + ' ' + (CY - 33) + ' L ' + (xHub + 4) + ' ' + (fy + 9), fixState, 'thin loop-down');
    s += node('review/fix', xHub, fy, fixState, 9) + text(xHub + 17, fy + (P.tight ? 5 : -2), 'Düzelt', f.fix === 'run' ? 't-back' : '', 'start') + (P.tight ? '' : text(xHub + 17, fy + 14, 'sonra yeniden incele', 'sub', 'start'));
    s += edge('M ' + (xHub + 34) + ' ' + CY + ' L ' + (xMerge - 5) + ' ' + CY, f.review === 'ok' ? 'ok' : 'idle');
    s += '<g class="n s-' + f.review + sel('review/*') + '" data-node="review/*"><circle class="orbit" cx="' + xHub + '" cy="' + CY + '" r="38"/><circle class="ring" cx="' + xHub + '" cy="' + CY + '" r="34"/></g>';
    s += '<text x="' + xHub + '" y="' + (CY + (f.reviewRound > 1 ? -1 : 5)) + '" text-anchor="middle" pointer-events="none">İnceleme</text>' +
      (f.reviewRound > 1 ? '<text x="' + xHub + '" y="' + (CY + 15) + '" class="mono round" data-round="review:' + f.reviewRound + '" text-anchor="middle" pointer-events="none">tur ' + f.reviewRound + '</text>' : '');

    // 6 · Birleştir: çubuk, altında insan ve onay kutucukları
    const ready = f.checks.every((c) => c[1]), human = f.merged ? 'var(--ok)' : 'var(--text)', hy = CY + 64;
    s += '<g class="n' + sel('merge/*') + '" data-node="merge/*"><rect x="' + (xMerge - 18) + '" y="' + (CY - 34) + '" width="36" height="68" fill="transparent"/><rect class="bar" x="' + (xMerge - 4.5) + '" y="' + (CY - 26) + '" width="9" height="52" rx="2" style="fill: ' + (f.merged ? 'var(--ok)' : ready ? 'var(--text)' : 'var(--idle)') + '"/></g>';
    s += text(xMerge, CY - 36, 'Birleştir');
    s += '<path class="dotted" d="M ' + xMerge + ' ' + (CY + 31) + ' L ' + xMerge + ' ' + (hy - 18) + '"/>';
    s += '<circle cx="' + xMerge + '" cy="' + hy + '" r="15" fill="var(--panel)" stroke="' + human + '" stroke-width="2.5"/>' +
      '<circle cx="' + xMerge + '" cy="' + (hy - 4) + '" r="4.2" fill="' + human + '"/><path d="M ' + (xMerge - 8.5) + ' ' + (hy + 9) + ' a 8.5 7 0 0 1 17 0" fill="' + human + '"/>';
    const humanSub = f.merged ? 'birleştirdi' : P.tight ? '' : 'son birleştirmeyi yapar';
    s += text(xMerge + 24, hy + (humanSub ? -2 : 5), 'İnsan', '', 'start') + (humanSub ? text(xMerge + 24, hy + 14, humanSub, 'sub', 'start') : '');
    f.checks.forEach((c, i) => {
      const y = CY + 100 + i * 22, x = xMerge - 7.5;
      s += '<rect class="box' + (c[1] ? ' on' : '') + '" x="' + x + '" y="' + y + '" width="15" height="15" rx="3"/>' + (c[1] ? '<path class="tick" d="M ' + (x + 3.5) + ' ' + (y + 8) + ' l 3 3 l 5 -6"/>' : '') + text(xMerge + 16, y + 12, c[0], 'sub', 'start');
    });

    // Alt bant: solda "şu an" listesi; akış dışı kartlar iş açıkken paketlerin altına, iş yokken sol alta biner.
    nowZone = f.job ? { x: xBox, y: bottom + 12, w: xPill - 14 - xBox, h: FH - 4 - (bottom + 12) } : { x: 16, y: CY + 64, w: xPill - 30, h: FH - 68 - CY };
    s += drawWorkers(f, loose || bottom > CY + 92 ? xBox - 10 : xPill - 12);
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

  const STOPS = { step_limit: 'adım sınırı', tool_limit: 'araç sınırı', token_limit: 'token sınırı', timeout: 'süre sınırı', aborted: 'süre doldu ya da kesildi', model_error: 'model hatası' };
  // Döngü adımları: model turları sayılır, araç çağrıları tek tek listelenir.
  function stepList(m) {
    if (!m.steps || !m.steps.length) return '';
    const models = m.steps.filter((x) => x.kind === 'model');
    const tools = m.steps.filter((x) => x.kind === 'tool');
    const head = models.length + ' model turu · ' + tools.length + ' araç çağrısı' + (STOPS[m.stop] ? ' · durdu: ' + STOPS[m.stop] : '');
    const rows = m.steps.filter((x) => x.kind !== 'model' || !x.ok).map((x) =>
      '<li' + (x.ok === false ? ' class="err"' : '') + '>' + (x.n ?? '') + ' · ' + esc(x.kind === 'tool' ? x.tool + ' ' + (x.summary || '') : x.kind + (x.model ? ' ' + x.model : '') + (x.error ? ': ' + x.error : '')) + (x.seconds != null ? ' · ' + dur(x.seconds) : '') + '</li>');
    return '<div class="files">' + esc(head) + '</div>' + (rows.length ? '<ul class="steps">' + rows.join('') + '</ul>' : '');
  }

  function memberDetail(m) {
    const a = actorOf(m);
    return '<div class="detail-who" style="--c:' + a.color + '"><span class="chip"><i></i>' + esc(a.name) + '</span>' +
      (m.model ? '<span class="muted">' + esc(m.model) + '</span>' : '') +
      (m.note && m.task && m.stage ? '<span>' + esc(m.task) + '</span>' : '') +
      (m.round ? '<span class="muted">tur ' + m.round + '</span>' : '') +
      (m.agent ? '<span class="badge-agent">ajan</span>' + (m.write ? '<span class="badge-write">yazma</span>' : '') + m.skills.map((k) => '<span class="chip">' + esc(k) + '</span>').join('') : '') +
      '<span class="muted">' + hhmm(m.start) + (m.end && m.end !== m.start ? ' → ' + hhmm(m.end) : '') + '</span>' + stateText(m) + '</div>' +
      (m.files && m.files.length ? '<div class="files">yama: ' + m.files.map(esc).join(', ') + '</div>' : '') +
      (m.scope && m.scope.length ? '<div class="files">kapsam (Claude seçti): ' + m.scope.map(esc).join(', ') + '</div>' : '') +
      stepList(m) +
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
        // "upd": var olan öğenin içeriği değişti (sayaçlar yuvarlanarak yenilenir).
        el.className = item.cls + (el.classList.contains(enterClass) ? ' ' + enterClass : '') + (el.dataset.sig !== undefined && canMove() ? ' upd' : '');
        el.dataset.sig = item.sig;
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
  // Yazdıysa true döner (hareket katmanı yalnız yeniden çizilen şemada çalışır).
  function setHtml(el, html) {
    if (el.dataset.sig === html) return false;
    el.dataset.sig = html;
    el.innerHTML = html;
    return true;
  }

  // Sekme gizliyken süre sayaçları yazılmaz; görünür olunca hemen güncellenir.
  function tick() {
    if (document.hidden) return;
    const now = Date.now();
    for (const el of document.querySelectorAll('[data-since]')) {
      const s = dur(Math.max(0, (now - Number(el.dataset.since)) / 1000));
      if (el.textContent !== s) el.textContent = s;
    }
  }
  document.addEventListener('visibilitychange', tick);

  // ---- Hareket katmanı ----
  // Şema her değişiklikte baştan yazıldığından geçişler burada, önceki çizimle karşılaştırılarak tetiklenir: durumu
  // değişen düğüm, kenar, onay kutusu ya da tur rozeti bir kez oynar. Geçmiş yüklenirken, sekme gizliyken ve
  // "hareketi azalt" açıkken hiçbiri oynamaz. Veriye dokunmaz; yalnız sınıf ve geçici süs öğeleri ekler.
  const still = matchMedia('(prefers-reduced-motion: reduce)');
  const canMove = () => live && !still.matches && !document.hidden;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  let fxPrev = null; // önceki çizimin durumu
  let fxStage = null;
  let fxPick = { key: '', n: 0 }, fxPickKey = '', fxJob = '';
  let fxDirty = {}, fxQueued = false, fxSkip = false;
  let introDone = false;
  function replay(el, cls) {
    el.classList.remove(cls);
    void el.getBoundingClientRect();
    el.classList.add(cls);
  }
  // Sayı/metin değişince yeni değer aşağıdan yuvarlanarak gelir.
  function rollText(el, s) {
    if (el.textContent === s) return;
    el.textContent = s;
    if (canMove()) replay(el, 'roll');
  }
  function flowSnapshot(svg) {
    const snap = { id: fxJob, fw: FW, pick: currentPick, nodes: new Map(), edges: new Map(), boxes: [], rounds: new Map(), workers: new Set() };
    for (const el of svg.querySelectorAll('[data-node]')) snap.nodes.set(el.dataset.node, [...el.classList].find((c) => c.startsWith('s-')) || '');
    for (const el of svg.querySelectorAll('path.e')) snap.edges.set(el.getAttribute('d'), el.getAttribute('class').split(' ')[1]);
    for (const el of svg.querySelectorAll('.box')) snap.boxes.push(el.classList.contains('on'));
    for (const el of svg.querySelectorAll('[data-round]')) snap.rounds.set(el.dataset.round.split(':')[0], el.dataset.round);
    for (const el of svg.querySelectorAll('[data-w]')) snap.workers.add(el.dataset.w);
    return snap;
  }
  // Düğümün yeni durumuna göre tek seferlik hareket: yay gibi büyüme + saçılan halka; onayda kıvılcım ve çizilen
  // onay işareti, hatada sarsıntı, geri göndermede sola çekilme.
  function nodeFx(g, state) {
    const ring = g.querySelector('.ring');
    if (!ring || state === 'idle' || state === 'skip') return;
    g.classList.add(state === 'err' ? 'fx-shake' : state === 'back' ? 'fx-nudge' : state === 'ok' ? 'fx-ok' : 'fx-pop');
    const b = ring.getBBox(), cx = b.x + b.width / 2, cy = b.y + b.height / 2, r = b.height / 2;
    const burst = ring.cloneNode(false);
    burst.setAttribute('class', 'fx-burst');
    burst.setAttribute('style', '--fx: var(--' + (state === 'wait' ? 'run' : state) + '); --to: ' + (r > 20 ? 1.3 : 1.9));
    g.appendChild(burst);
    setTimeout(() => burst.remove(), 800);
    if (state !== 'ok' || ring.tagName !== 'circle') return;
    const rr = r + (r < 8 ? 4 : 7), extra = document.createElementNS(SVG_NS, 'g');
    extra.setAttribute('pointer-events', 'none');
    extra.innerHTML = '<circle class="fx-sparks" style="--fx: var(--ok); --to: ' + (r < 8 ? 1.4 : r > 20 ? 1.35 : 1.8) + '" cx="' + cx + '" cy="' + cy + '" r="' + rr + '" stroke-dasharray="0.1 ' + ((2 * Math.PI * rr) / 8 - 0.1).toFixed(2) + '"/>' +
      (r >= 8 && r <= 12 ? '<g class="fx-done"><circle cx="' + cx + '" cy="' + cy + '" r="' + (r + 1.5) + '"/><path d="M ' + (cx - 4.2) + ' ' + (cy + 0.4) + ' l 3 3 l 5.5 -6.5"/></g>' : '');
    g.appendChild(extra);
    setTimeout(() => extra.remove(), 1800);
  }
  // Kenarın durumu değişince yeni renk kenar boyunca akar; önünde bir jeton bir düğümden ötekine kayar.
  function edgeFx(el, was) {
    const cls = el.getAttribute('class'), state = cls.split(' ')[1];
    if (!['e-ok', 'e-back', 'e-err', 'e-wait'].includes(state) || (state === 'e-back' && cls.includes('loop-'))) return;
    const len = Math.ceil(el.getTotalLength());
    if (len < 12) return;
    const ms = Math.round(Math.min(900, Math.max(320, len * 2.6)));
    const under = el.cloneNode(false), tok = el.cloneNode(false);
    under.setAttribute('class', cls.replace(state, was));
    tok.setAttribute('class', 'e ' + state + ' fx-tok');
    for (const x of [el, tok]) {
      x.style.setProperty('--len', len + 'px');
      x.style.setProperty('--nlen', -len + 'px');
      x.style.setProperty('--gap', len + 24 + 'px');
      x.style.setProperty('--ms', ms + 'ms');
    }
    el.classList.add('fx-draw');
    el.parentNode.insertBefore(under, el);
    el.parentNode.insertBefore(tok, el.nextSibling);
    setTimeout(() => { under.remove(); tok.remove(); }, ms + 60);
  }
  // Şema ya da ayrıntı yeniden yazılınca çağrılır. Karşılaştırma bir sonraki kareye ertelenir: aynı anda gelen
  // birkaç olay şemayı art arda yazar, hareket ise ekrana son çıkan çizim ile yeni çizim arasındaki farka oynar.
  function animateFlow(what) {
    fxDirty[what] = true;
    if (what === 'flow') document.getElementById('flow').classList.remove('intro');
    if (fxQueued) return;
    if (!fxPrev || !canMove()) return flowFx();
    fxQueued = true;
    requestAnimationFrame(flowFx);
  }
  // Sekme gizlenince bekleyen karşılaştırma hareketsiz kapanır (dönüşte birikmiş geçişler topluca oynamasın).
  document.addEventListener('visibilitychange', () => { if (document.hidden) fxSkip = fxQueued; });
  function flowFx() {
    const move = canMove() && !fxSkip, dirty = fxDirty;
    fxQueued = fxSkip = false;
    fxDirty = {};
    if (dirty.pick) {
      // Seçili düğüme yeni kayıt düşünce yalnız yeni satırlar kayarak girer (en yeni kayıt en üstte).
      const rows = document.getElementById('pick').querySelectorAll('.detail-who');
      if (move && fxPick.key === fxPickKey) for (let i = 0; i < rows.length - fxPick.n; i++) rows[i].classList.add('enter');
      fxPick = { key: fxPickKey, n: rows.length };
    }
    if (!dirty.flow) return;
    const svg = document.getElementById('flow'), prev = fxPrev, snap = (fxPrev = flowSnapshot(svg));
    if (!prev || !move) return;
    if (prev.id !== snap.id) return replay(svg, 'fx-swap'); // başka iş: tek tek değil, bütün şema yumuşakça gelir
    if (prev.fw !== snap.fw) return; // yeniden dizildi; kenar yolları karşılaştırılamaz
    for (const g of svg.querySelectorAll('[data-node]')) {
      const key = g.dataset.node, was = prev.nodes.get(key), now = snap.nodes.get(key);
      if (picked === key && prev.pick !== key) g.classList.add('fx-sel');
      if (was !== undefined && was !== now && now) nodeFx(g, now.slice(2));
    }
    for (const el of [...svg.querySelectorAll('path.e')]) {
      const was = prev.edges.get(el.getAttribute('d'));
      if (was && was !== el.getAttribute('class').split(' ')[1]) edgeFx(el, was);
    }
    svg.querySelectorAll('.box').forEach((el, i) => {
      if (!el.classList.contains('on') || prev.boxes[i] !== false) return;
      el.classList.add('fx-pop');
      if (el.nextElementSibling) el.nextElementSibling.classList.add('fx-tick');
    });
    for (const el of svg.querySelectorAll('[data-round]')) if (prev.rounds.get(el.dataset.round.split(':')[0]) !== el.dataset.round) el.classList.add('fx-bump');
    for (const el of svg.querySelectorAll('[data-w]')) if (!prev.workers.has(el.dataset.w)) el.classList.add('fx-in');
  }
  // İlk açılış: hat soldan sağa çizilir; her öğe yatay konumuna göre sırasını bekler. Sayfa başına bir kez
  // (bağlantı kopup geçmiş yeniden gelince oynamaz); araya çizim girerse animateFlow keser.
  function playIntro() {
    if (introDone) return;
    introDone = true;
    if (still.matches || document.hidden) return;
    const svg = document.getElementById('flow'), box = svg.getBoundingClientRect(), SWEEP = 1100;
    if (!box.width) return;
    for (const el of svg.children) {
      const r = el.getBoundingClientRect();
      el.style.setProperty('--d', Math.max(0, Math.round(((r.left - box.left) / box.width) * SWEEP)) + 'ms');
      if (!el.classList.contains('e')) continue;
      el.style.setProperty('--len', Math.ceil(el.getTotalLength()) + 'px');
      el.style.setProperty('--ms', Math.max(140, Math.round((r.width / box.width) * SWEEP)) + 'ms');
    }
    const stages = document.getElementById('stages');
    svg.classList.add('intro');
    stages.classList.add('intro');
    setTimeout(() => { svg.classList.remove('intro'); stages.classList.remove('intro'); }, SWEEP + 1000);
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
    rollText(pill.lastElementChild, busy ? busy + ' çalışıyor' : 'Boşta');
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
    measureFlow();
    // Sürekli hareketler yalnız bu hatta gerçekten çalışan varken döner.
    const flowEl = document.getElementById('flow'), stagesEl = document.getElementById('stages'), pickEl = document.getElementById('pick');
    flowEl.classList.toggle('busy', f.its.some((i) => i.state === 'run'));
    fxJob = job ? job.id : '';
    if (setHtml(flowEl, drawFlow(f, running.length))) animateFlow('flow');
    const stagesNew = setHtml(stagesEl, STAGES.map(([key, label], i) =>
      '<button class="stage' + (f.stage === key ? ' on' : f.touched.includes(key) ? ' done' : '') + '" data-stage="' + key + '" style="--i: ' + i + '"><b>' + (i + 1) + '</b>' + label + '</button>').join('') +
      '<span class="hint">Ayrıntı için bir düğüme ya da aşamaya tıkla</span>');
    // Hat yeni bir aşamaya geçince o aşamanın numarası zıplar.
    if (stagesNew && canMove() && fxStage !== f.stage && stagesEl.querySelector('.stage.on')) stagesEl.querySelector('.stage.on').classList.add('fx-pop');
    fxStage = f.stage;
    fxPickKey = fxJob + '|' + (currentPick || 'ticket');
    if (setHtml(pickEl, pickHtml(f, currentPick || 'ticket'))) animateFlow('pick');

    placeNow(running.length);
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
    rollText(document.getElementById('count'), finished.length ? finished.length + ' iş' : 'Henüz biten iş yok');
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
      playIntro();
    });
    source.onmessage = (m) => { apply(JSON.parse(m.data)); render(); };
    source.onopen = () => conn.classList.add('on');
    source.onerror = () => conn.classList.remove('on');
  }
  // Alan genişleyip daralınca hat yeniden dizilir (viewBox genişliği alanı izler).
  new ResizeObserver(() => { const w = FW; measureFlow(); if (w !== FW) render(); }).observe(document.querySelector('.flow-wrap'));
  connect();
  refreshSkills();
  setInterval(refreshSkills, 300000);
  setInterval(tick, 1000);
  // Yanıtsız sayılma ve gün başlıkları için seyrek yeniden kurulum.
  setInterval(render, 30000);
</script>
</body>
</html>`;
