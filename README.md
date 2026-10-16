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

Gereken: Node 20+, git. Depoda çalışan ajan (`orkestra agent`) yalnızca macOS'ta çalışır; diğer her şey her sistemde.

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
echo "soru" | orkestra ask [--model fast|code|kimi|codex|gemini-flash]
git diff | orkestra panel --models codex,gemini-flash,code
cat tasarim.md | orkestra critic --round 1
(echo "kabul ölçütleri"; git diff) | orkestra review --round 1
echo "görev" | orkestra agent --model codex --write [--skill <ad>]
orkestra gate [--e2e]
orkestra dashboard            # http://localhost:4545, canlı hat
orkestra job start|done|status · orkestra note · orkestra usage
```

## Gizlilik ve güvenlik

- Danışman modellere (ask/panel/critic/review) yalnızca Claude'un prompt'a koyduğu metin gider; Claude'a `.env*`, anahtar ve kullanıcı verisi göndermemesi söylenir.
- Ajan CLI'ları boş bir geçici klasörde, araçları kapalı çalışır.
- `orkestra agent` deponun `.env*` dosyaları çıkarılmış bir kopyasında, macOS `sandbox-exec` kum havuzunda çalışır: gerçek depoyu, ev klasörünü ve anahtarları okuyamaz, kopya dışına yazamaz. Ağ açıktır (modele ulaşmak için). Ajanın yaptığı değişiklik yama olarak döner; Claude okuyup uygular.
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
