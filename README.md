# Orkestra

Claude Code eklentisi. Claude **şef** olur: işi planlar, kodu kendisi yazar; Codex, Gemini (Antigravity) ve NVIDIA NIM modellerinden plan eleştirisi ve kod incelemesi toplar, her bulguyu kodu okuyarak doğrular ve süzer. Gerçek depoya hiçbir model yazmaz.

```
plan → mimar paneli → uygulama → kapı (tip/lint/test) → reviewer paneli → süzme → doğrulama
```

## Kurulum

Claude Code içinde:

```
/plugin marketplace add ugurseleci/orkestra
/plugin install orkestra@ugurseleci
```

Sonra herhangi bir projede Claude'a "orkestra doctor çalıştır" de ya da doğrudan bir iş ver; `orkestra` skill'i özellik geliştirme ve inceleme işlerinde devreye girer.

Gereken: Node 20.3+, git. macOS, Linux ve Windows'ta çalışır. Depoda çalışan ajan (`orkestra agent`): Codex/Gemini ajanı, komut aracı ve yazma kipi yalnızca macOS'ta; Orkestra'nın kendi döngüsü salt okunur kipte her sistemde.

### Windows

- [Git for Windows](https://git-scm.com/downloads/win) kur: Claude Code o zaman Bash aracı olarak Git Bash'i kullanır ve `orkestra` komutları macOS'taki gibi çalışır. Git yoksa Claude Code PowerShell kullanır; orkestra yine çalışır (`bin/orkestra.cmd`, soru `--input <dosya>` ile).
- Codex: `npm i -g @openai/codex`, sonra `codex login`. npm'in kurduğu `codex.cmd` kabuğu desteklenir.
- NVIDIA anahtarı (PowerShell):
  ```powershell
  New-Item -ItemType Directory -Force "$HOME\.config\orkestra" | Out-Null
  Set-Content -Encoding ascii "$HOME\.config\orkestra\env" "NVIDIA_API_KEY=nvapi-..."
  ```
- `orkestra agent` Windows'ta yalnız salt okunur çalışır (`--model ultra --tools read,search`): kum havuzu macOS'a özgü olduğu için Codex/Gemini ajanı, komut aracı ve `--write` kapalı. ask, panel, critic, review, gate, dashboard çalışır.

## Modeller: herkes kendi hesabıyla

Eklenti hiçbir anahtar ya da hesap bilgisi taşımaz. Her sağlayıcı **isteğe bağlıdır**. Hangisi kuruluysa o kullanılır, hiçbiri yoksa Claude işi tek başına yapar.

| Sağlayıcı | Ne gerekir | Ücret |
|---|---|---|
| **Codex** (OpenAI) | [Codex CLI](https://github.com/openai/codex) kur, `codex login` ile kendi ChatGPT hesabınla gir | ChatGPT aboneliğinin kotası |
| **Gemini** (Google) | Antigravity uygulamasının `agy` CLI'ı, kendi Google hesabınla giriş | Antigravity kotası |
| **NVIDIA NIM** (DeepSeek, GLM, Kimi, Nemotron) | [build.nvidia.com](https://build.nvidia.com)'dan kişisel API anahtarı | Ücretsiz katman |

NVIDIA anahtarını sohbete yapıştırma. Kendi terminalinde dosyaya yaz:

```bash
mkdir -p ~/.config/orkestra
printf 'NVIDIA_API_KEY=nvapi-...\n' > ~/.config/orkestra/env
chmod 600 ~/.config/orkestra/env
```

(Ya da kabuk profilinde `export NVIDIA_API_KEY=...`.)

Durumu görmek için: `orkestra doctor`. Gerçekten giriş yapılmış mı diye her sağlayıcıya kısa bir soru sormak için: `orkestra doctor --live`.

Model tercihleri kişiseldir: `~/.config/orkestra/config.json`

```json
{ "agents": { "codex": "gpt-5.5" }, "models": { "code": "z-ai/glm-5.3" } }
```

Codex'te model yazılmazsa hesabının varsayılan modeli kullanılır.

### Ek OpenAI uyumlu sağlayıcılar

`/v1/chat/completions` sunan başka bir servisi (kurum içi ya da kendi kurduğun bir sunucu) aynı dosyadan eklersin. Modeller `<sağlayıcı>:<model>` adıyla ya da `models` altında verdiğin kısa adla çağrılır:

```json
{
  "providers": { "ornek": { "baseUrl": "https://llm.ornek.com/v1", "keyEnv": "ORNEK_API_KEY", "minMaxTokens": 16384 } },
  "models": { "ornek-hizli": "ornek:model-id" }
}
```

Anahtarı `~/.config/orkestra/env` dosyasına `ORNEK_API_KEY=...` olarak yaz. `minMaxTokens` isteğe bağlıdır: düşünen modeller küçük bir `max_tokens`'ı düşünmeye harcayıp boş dönebiliyor. `orkestra doctor` sağlayıcıyı listeler; `--live` ilk kısa adı dener.

### Orkestra'nın kendi ajan döngüsü (NVIDIA ve OpenAI uyumlu modeller)

`orkestra agent --model codex|gemini` CLI'ın kendi araçlarını kullanır. Diğer her model için (NVIDIA ya da ek sağlayıcı) Orkestra
kendi araç döngüsünü yürütür: LangChain'in `create_agent` yapısının bağımlılıksız bir karşılığı (model ↔ araç döngüsü,
JSON şemalı araçlar, hatayı modele geri veren araç mesajları, middleware kancaları).

```
echo "soru"  | orkestra agent --model ultra --files lib            # okur, arar, (macOS) komut çalıştırır
echo "görev" | orkestra agent --model ultra --files lib/a.mjs,test --write   # kopyada düzenler, yama döner
echo "soru"  | orkestra agent --model ornek:model-id --files src --tools read,search --max-steps 15
```

- Araçlar: `list_files`, `read_file`, `search` (her sistemde); `run_command` (macOS, ağsız kum havuzu); `edit_file`, `write_file` (`--write`, macOS).
- Middleware: adım ve araç çağrı sınırı, süre ve token bütçesi, 429'da geri çekilme, eski araç çıktılarını temizleme, çıktı kırpma, anahtar karartma, aynı çağrıyı yineleme bekçisi, isteğe bağlı yedek model.
- Her adım panoya düşer (araç adı ve yol/komut özeti; dosya içeriği ve çıktı kayda girmez).
- Model araç çağırabilmeli: `orkestra doctor --live` yoklar. 18 Kasım 2026 yoklaması: `fast`, `step`, `lightning`, `super`, `ultra` çağırıyor; `code` zaman aşımına uğradı.

Ayarlar `~/.config/orkestra/config.json` → `"agent"` (sınırı genişletebilenler yalnız burada):

```json
{ "agent": { "model": "ultra", "maxSteps": 25, "maxToolCalls": 60, "maxTokens": 400000, "fallback": ["super"], "sandboxRead": ["~/.nvm"] } }
```

`sandboxRead`: araç zinciri ev klasöründeyse (nvm, volta, flutter) komut aracının okuyabilmesi için. Projenin `.claude/orkestra/config.json`'u
yalnız daraltır: `"agent": { "exclude": ["secrets/**"], "protect": ["ci"], "denyCommands": ["^git\\s+push"] }`. `exclude` Codex/Gemini ajanının kopyasına da uygulanır.

## Projeye ayar (isteğe bağlı)

```bash
orkestra init
```

`.claude/orkestra/` altına üç dosya kurar. Bunlar depoya girer, ekip paylaşır:

- `config.json`: kapı komutları (`"gate": {"types": "...", "lint": "...", "unit": "...", "integration": "...", "e2e": "..."}`, boş metin katmanı kapatır) ve inceleyici rolü (`"reviewer": "React Native / Expo"`).
- `lenses.md`: projede gerçekten yaşanmış hatalardan mercek maddeleri; reviewer panelinin istemine eklenir.
- `checklist.md`: Claude'un diff'e göre seçip panele eklediği inceleme listesi.

Ayar yoksa kapı katmanları projeden çıkarılır: projede kurulu `tsc`, `package.json` içindeki `lint`, `test`, `test:integration`, `test:e2e`.

Yerel kayıtlar (olaylar, ajan yamaları) projenin `.orkestra/` klasöründe tutulur; klasörün kendi `.gitignore`'u vardır, depoya girmez.

## Komutlar

Claude bunları kendisi çağırır; elle de kullanılabilir (eklentinin `bin/` klasörü üzerinden).

```
echo "soru" | orkestra ask [--model fast|code|step|codex|gemini-flash]
git diff | orkestra panel --models codex,gemini-flash,code
cat tasarim.md | orkestra critic --round 1
(echo "kabul ölçütleri"; git diff) | orkestra review --round 1
echo "görev" | orkestra agent --model codex|ultra --files <yol,glob> [--write] [--skill <ad>] [--tools read,search,run,write] [--max-steps n]
orkestra gate [--e2e]
orkestra dashboard            # http://localhost:4545, canlı hat
orkestra job start|done|status · orkestra note · orkestra usage
```

## Gizlilik ve güvenlik

- Danışman modellere (ask/panel/critic/review) yalnızca Claude'un prompt'a koyduğu metin gider; Claude'a `.env*`, anahtar ve kullanıcı verisi göndermemesi söylenir.
- Ajan CLI'ları boş bir geçici klasörde, araçları kapalı çalışır.
- `orkestra agent` deponun gizli dosyaları (`.env*`, `*.pem`, `*.key`, `.npmrc`… ve projenin `agent.exclude`'u) çıkarılmış bir kopyasında çalışır. Kopyanın git dizini kopyanın dışında ve ajana kapalıdır; yama kancasız ve fsmonitor'suz alınır (0.3.0 öncesinde ajan kopyadaki `.git/config`'e yazarak, yama alınırken kullanıcının yetkisiyle komut çalıştırabiliyordu).
- Codex/Gemini ajanı macOS `sandbox-exec` kum havuzunda çalışır: gerçek depoyu, ev klasörünü ve anahtarları okuyamaz, kopya dışına yazamaz. Ağ açıktır (modele ulaşmak için).
- Orkestra döngüsü API anahtarını tuttuğu için kum havuzu dışında çalışır; sınır araç başınadır: dosya araçları yolu `realpath` ile çözüp kopyaya kapatır (bağlantı kaçışı, `..`, gizli dosyalar reddedilir), komut aracı ağı kapalı kum havuzunda yalnız kopyada çalışır. Kapsamdaki dosyalar modelin sağlayıcısına gidebilir: kapsamı dar tut, gizli yolları `exclude`'a yaz.
- **Kapsamı Claude seçer:** `orkestra agent` `--files` olmadan çalışmaz; kopyaya yalnız Claude'un seçtiği yollar girer. Modele hangi dosyanın gidebileceğini model değil Claude belirler.
- **Değişiklik kendi denetimini değiştiremez:** ajan `.claude/`, `.agents/`, CI tanımları, `CLAUDE.md`, `REVIEW.md` ve `agent.protect` desenlerine yazamaz, bunlara dokunan yama reddedilir; test dosyasına dokunan yama uyarı alır. `orkestra gate` kapı ayarı ya da test betikleri değiştiyse uyarır, aynı işte üç kez üst üste kırmızıysa kullanıcıya danışılmasını söyler.
- Ajanın yaptığı değişiklik yama olarak döner; Claude okuyup uygular.
- Bilinen sınır: Antigravity girişini macOS anahtar zincirinde tuttuğu için `agy` ajanında anahtar zinciri dosyası (şifreli) okumaya açıktır.

## Geliştirme

```bash
npm test                           # node:test
claude plugin validate .
claude --plugin-dir .              # yerel kopyayla dene
```

## Gizli depo

Depo gizli olduğu için kurulumdan önce sahibinin seni GitHub'da depoya eklemesi gerekir. Claude Code depoyu kendi git girişinle indirir: `gh auth login` ya da git kimlik bilgisi yeterli. Güncellemeler için: `/plugin marketplace update ugurseleci`.

## Lisans

MIT
