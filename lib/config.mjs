// Orkestranın nerede çalıştığı ve neyi kullanabildiği: proje kökü, anahtar, kullanıcı ve proje ayarları, kurulu sağlayıcılar.
//
// Eklenti hiçbir anahtar ya da hesap bilgisi taşımaz. Her kullanıcı kendi girişini kullanır:
//  - Codex CLI: kendi ChatGPT hesabıyla `codex login`
//  - Antigravity CLI (agy): kendi Google hesabıyla giriş
//  - NVIDIA NIM: build.nvidia.com'dan alınan kişisel anahtar (NVIDIA_API_KEY)
// Hiçbiri zorunlu değil; olmayan sağlayıcı varsayılan panellerden düşer.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

// Proje kökü: MCP sunucusuna eklenti ORKESTRA_PROJECT_DIR verir; Bash'ten çağrılan CLI çalışılan klasörün git kökünü bulur.
// İkisi de git köküne çıkar: Claude deponun alt klasöründe başlatılsa da MCP ve CLI aynı kökü kullanır.
function findProjectRoot() {
  const env = process.env.ORKESTRA_PROJECT_DIR;
  const start = env && !env.includes('${') && existsSync(env) ? resolve(env) : process.cwd();
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: start, encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : start;
}

export const PROJECT_ROOT = findProjectRoot();
export const USER_DIR = process.env.ORKESTRA_HOME || join(homedir(), '.config', 'orkestra');
export const PROJECT_CONFIG_DIR = join(PROJECT_ROOT, '.claude', 'orkestra');
// Yerel kayıt (olaylar, yamalar): depoya girmez.
export const STATE_DIR = join(PROJECT_ROOT, '.orkestra');

// .orkestra/ ilk kullanımda kendi .gitignore'uyla kurulur; kullanıcının .gitignore'una dokunulmaz.
export function ensureStateDir() {
  mkdirSync(STATE_DIR, { recursive: true });
  const ignore = join(STATE_DIR, '.gitignore');
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n');
  return STATE_DIR;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

// Görsel yolu: çalışılan klasöre göre (CLI), bulunamazsa proje köküne göre (MCP).
export function resolvePath(path) {
  const fromCwd = resolve(process.cwd(), path);
  return existsSync(fromCwd) ? fromCwd : resolve(PROJECT_ROOT, path);
}

// Kullanıcı ayarı (~/.config/orkestra/config.json): model takma adlarını kendi hesabına göre değiştirmek için.
//   { "agents": { "codex": "gpt-6-astra" }, "models": { "code": "z-ai/glm-5.3" } }
export const userConfig = () => readJson(join(USER_DIR, 'config.json'));
// Proje ayarı (<proje>/.claude/orkestra/config.json): kapı komutları ve inceleyici rolü. Depoya girer.
export const projectConfig = () => readJson(join(PROJECT_CONFIG_DIR, 'config.json'));

function readEnvFile(file, key) {
  try {
    return readFileSync(file, 'utf8').match(new RegExp(`^${key}=(.+)$`, 'm'))?.[1].trim().replace(/^["']|["']$/g, '') || null;
  } catch {
    return null;
  }
}

// Anahtar sırası: ortam değişkeni → ~/.config/orkestra/env → projenin .env.local'ı.
export function loadApiKey() {
  return (
    process.env.NVIDIA_API_KEY ||
    readEnvFile(join(USER_DIR, 'env'), 'NVIDIA_API_KEY') ||
    readEnvFile(join(PROJECT_ROOT, '.env.local'), 'NVIDIA_API_KEY')
  );
}

export function onPath(command) {
  return (process.env.PATH ?? '').split(delimiter).some((dir) => dir && existsSync(join(dir, command)));
}

// Kurulu sağlayıcılar. Giriş yapılıp yapılmadığı burada denenmez (yavaş ve kota harcar); `doctor --live` dener.
export function providers() {
  return {
    codex: onPath('codex'),
    agy: onPath('agy'),
    nvidia: Boolean(loadApiKey()),
    sandbox: process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec'),
  };
}

// Bir modelin sağlayıcısı kurulu mu.
export function modelAvailable(model, p = providers()) {
  const name = model.split(':')[0];
  if (name === 'codex') return p.codex;
  if (name === 'gemini' || name === 'gemini-flash') return p.agy;
  return p.nvidia;
}

// Eleştirmen ve inceleyici paneli için varsayılan modeller: kurulu olanlardan tercih sırasıyla iki tane.
export const PREFERRED_REVIEWERS = ['codex', 'gemini-flash', 'code', 'fast'];
export function defaultReviewers(p = providers(), count = 2) {
  return PREFERRED_REVIEWERS.filter((m) => modelAvailable(m, p)).slice(0, count);
}

// Tek soru için: önce hızlı ve ucuz olan.
export function defaultAskModel(p = providers()) {
  return ['fast', 'gemini-flash', 'codex'].find((m) => modelAvailable(m, p)) ?? null;
}

export const NO_MODELS =
  'Kurulu model yok (codex, agy ya da NVIDIA_API_KEY). Kurulum için: orkestra doctor. Claude işi tek başına sürdürür.';
