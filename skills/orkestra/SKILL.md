---
name: orkestra
description: Çok modelli geliştirme orkestrası. Claude şef olarak işi planlar, Codex, Gemini (Antigravity) ve NVIDIA NIM modellerinden plan eleştirisi, alternatif ve kod incelemesi toplar, bulguları doğrulayıp süzer, son kodu kendisi yazar. Özellik geliştirme, mimari karar, hata ayıklama ve "bitti" demeden önceki inceleme işlerinde kullan.
---

# Orkestra

Claude **şef**tir: işi planlar, böler, modellere dağıtır, gelen cevapları **doğrular ve süzer**, son kodu yazar ve test eder. Modeller iki biçimde çalışır: **danışman** (verilen metne bakıp fikir ve bulgu üretir) ve **ajan** (deponun anahtarsız kopyasında kendisi okur, komut çalıştırır, istenirse yama döndürür). Gerçek depoya hiçbir model yazmaz: yamayı Claude okur ve uygular. Son sözü doğrulama söyler, çoğunluk oyu değil.

## Başlarken

İlk kullanımda ve bir model hata verdiğinde `orkestra doctor` çalıştır: hangi sağlayıcının kurulu olduğunu, varsayılan panelleri ve kapı katmanlarını gösterir (`--live` her sağlayıcıya kısa bir soru sorar). Sağlayıcıların hepsi isteğe bağlıdır ve her kullanıcı kendi hesabını kullanır:

- **Codex CLI**: kendi ChatGPT hesabıyla `codex login`
- **Antigravity CLI (`agy`)**: kendi Google hesabıyla giriş
- **NVIDIA NIM**: build.nvidia.com'dan kişisel anahtar; `NVIDIA_API_KEY` ortam değişkeni ya da `~/.config/orkestra/env`

Hiçbiri yoksa akış yine işler: paneller atlanır, Claude işi tek başına bitirir ve bunu raporlar. **Kullanıcıdan anahtarı sohbete yapıştırmasını isteme**; dosyaya kendisi yazsın.

Projede `.claude/orkestra/` yoksa ve iş anlamlıysa `orkestra init` öner: kapı komutları (`config.json`), projeye özel mercek maddeleri (`lenses.md`) ve inceleme kontrol listesi (`checklist.md`) şablonlarını kurar. Bu dosyalar depoya girer; yerel kayıtlar `.orkestra/` altında kalır.

## Araçlar

`orkestra` komutu eklenti açıkken Bash'te doğrudan çalışır (bulunamazsa: `node "${CLAUDE_PLUGIN_ROOT}/bin/orkestra"`). Soru stdin'den ya da `--input <dosya>` ile okunur.

**Windows:** Git Bash'te (Bash aracı) komutlar aynen çalışır. PowerShell aracındaysan `orkestra` yerine `node "${CLAUDE_PLUGIN_ROOT}/bin/orkestra"` yaz ve soruyu pipe etme: PowerShell 5.1 Türkçe karakterleri bozabilir. Soruyu Write aracıyla bir dosyaya yaz (ör. `.orkestra/soru.md`) ve `--input .orkestra/soru.md` ver; diff için önce `git diff > .orkestra/diff.txt`, sonra dosyayı birleştir. `(echo …; git diff) |` gibi bash sözdizimini PowerShell'de kullanma. Depoda çalışan ajan (`orkestra agent`) Windows'ta yok.

```bash
echo "<soru>" | orkestra ask [--model fast|code|step|codex|gemini-flash]
git diff | orkestra panel --models codex,gemini-flash,code --system "<rol>"
echo "<soru>" | orkestra ask --model codex --image ekran.jpg      # görsel: codex ya da NVIDIA vision
echo "<metin>" | orkestra translate --from tr --to en
```

- Model adları: `codex`, `gemini` (yavaş, geniş bağlam), `gemini-flash` (hızlı) ajan CLI'larıdır; `fast`, `code`, `step`, `super`, `ultra`, `vision` NVIDIA modelleridir. `codex:<model>` ile model seçilir. Kullanıcı varsayılanları `~/.config/orkestra/config.json` ile değiştirir (`"agents": {"codex": "…"}`, `"models": {…}`).
- `--models` verilmezse eleştirmen ve inceleme paneli kurulu sağlayıcılardan seçilir (codex, gemini-flash, code, fast sırasıyla ilk ikisi).
- Modeller yavaştır (10–120+ sn). Panel çağrılarını `run_in_background` ile başlat, beklerken kendi işine devam et.
- MCP araçları da var (`nvidia_ask`, `nvidia_panel`, `nvidia_translate`, `nvidia_models`); CLI ile aynı modelleri kullanır.
- **Pano:** `orkestra dashboard` (http://localhost:4545) hattı canlı çizer. Kullanıcı izlemek isterse arka planda başlat. Her model çağrısına `--task "<aşama>: <konu>"` ver.

## Hat (iş → tasarım → yapım → bütünleştirme → inceleme → birleştirme)

Anlamlı her iş hat olarak yürür. Tek satırlık işlerde hat açma.

```bash
orkestra job start --title "<iş>"                                   # aynı anda tek iş
orkestra note --stage design --role architect --round 1 --task "<tasarım>" [--status done]
cat tasarim.md | orkestra critic --round 1                          # engeller / uyarılar / eksik kanıt (puan yok)
orkestra note --stage design --role critic --round 1 --verdict approved|sent_back --reason "…"
orkestra note --stage build --role implementer|tester [--pkg 2] --task "…" [--status done]
orkestra gate [--e2e]                                               # tip, lint, birim, entegrasyon (+ uçtan uca)
(echo "<kabul ölçütleri ve bağlam>"; git diff) | orkestra review --round 1
orkestra note --stage review --role fix --round 1 --task "…" [--status done]
orkestra note --stage review --role decision --round N --verdict approved --task "<süzme özeti>"
orkestra job done --status merged|closed                            # birleştirmeyi kullanıcı yapar
```

- **Karar Claude'undur, modelin değil.** Eleştirmen çağrısının bitmesi onay değildir; engelleri süz, kararı `--verdict` ile yaz. Geri göndermede `--reason` zorunlu. Tasarım çoğu işte 2 turda biter; 5 tur emniyet sınırıdır, aşılırsa kullanıcıya sor.
- **Mercekler:** doğruluk, güvenlik, test, plana uygunluk, mimari, üretim. Modellere paylaştırılır; cevap mercek başlıklarına göre bölünür. Projenin `lenses.md`'sindeki maddeler ilgili merceğe eklenir. "Bulgu var" doğrulanmamış bulgudur.
- **Kapı** revizyona bağlıdır: kapıdan sonra kod değişirse yeşil geçersizdir; düzeltmeden sonra yeniden koş. Katman tanımlı değilse `orkestra init` ya da `.claude/orkestra/config.json` → `"gate"`.

## Depoda çalışan ajanlar

```bash
echo "<görev>" | orkestra agent --model codex --files lib/tarih.mjs,test --skill <skill> --write --task "Test yazarı: <modül>"
echo "<soru>"  | orkestra agent --model gemini-flash --files src/odeme --task "Uzman inceleme: <konu>"
echo "<soru>"  | orkestra agent --model ultra --files lib --task "Araştırma: <konu>"            # Orkestra döngüsü
echo "<görev>" | orkestra agent --model ultra --files lib/a.mjs,test/a.test.mjs --write --max-steps 30 --task "…"
```

- **Kapsamı Claude seçer (`--files`, zorunlu):** modele hangi dosyanın gideceğine model değil Claude karar verir. Kopyaya yalnız `--files` ile verilen yollar ve desenler girer (köke bağlı: `lib` klasörün tamamı, `lib/a.mjs` tek dosya, `src/**/*.ts` desen). Görevin gerçekten gerektirdiği en dar kümeyi ver: değişecek dosya, testi, doğrudan bağımlılıkları. Bütün depoyu (`.`) yalnız gerekçesi varsa ver. Gizli dosyalar kapsamda olsa da girmez; kapsam dışını ya da depo dışını gösteren bağlantılar da girmez. JS testlerini koşturacaksan `node_modules`'ı kapsama ayrıca yaz (yoksa bağlanmaz). Seçilen kapsam çıktıda ve panoda görünür. Ajan sembolik bağlantı ekleyen yama üretemez.
- **Değişiklik kendi denetimini değiştiremez:** ajan `.claude/`, `.agents/`, CI tanımları, `CLAUDE.md`, `REVIEW.md` ve projenin `agent.protect` desenlerine yazamaz; bunlara dokunan yama reddedilir. Test dosyalarına dokunan yama uyarı alır: testin gevşetilip gevşetilmediğine (silinen beklenti, `skip`, eklenen bekleme/yeniden deneme) ayrıca bak.

- **İki motor:** `codex`/`gemini`/`gemini-flash` CLI'ın kendi araçlarıyla, bütünüyle kum havuzunda (yalnız macOS). Diğer her model (NVIDIA, ek sağlayıcı) **Orkestra'nın araç döngüsünde** çalışır: `list_files`, `read_file`, `search` her sistemde; `run_command` (ağsız kum havuzu) ve `--write` ile `edit_file`/`write_file` yalnız macOS. `--tools read,search,run,write` kümeleri seçer, `--max-steps` model turunu sınırlar. Varsayılan model `ultra` (~2 sn/tur); model araç çağıramıyorsa `orkestra doctor --live` söyler.
- **Kopya ve kum havuzu:** ajan deponun kopyasında çalışır; kopyada gizli dosyalar (`.env*`, anahtar dosyaları, projenin `agent.exclude`'u) yoktur, kopya bir git deposu değildir. Ajan gerçek depoyu, ev klasörünü ve anahtarları okuyamaz, kopya dışına yazamaz. `--write` yoksa kopyaya da yazamaz.
- **Skill** (`--skill`, tekrarlanabilir): projedeki `.agents/skills/<ad>/SKILL.md` ya da `.claude/skills/<ad>/SKILL.md` ajanın uzmanlık talimatı olur.
- **Yama** (`--write`): `.orkestra/patches/` altına yazılır. Claude yamayı OKUR, sonra `git apply --3way` ile uygular ve kapıyı koşar. Okunmamış yama uygulanmaz; ajan "testler geçti" dese de kapı yeniden koşulur. Zayıf modellerin yaması çalışsa da temizlik ister (kullanılmayan değişken, yanlış yerde kod): uygularken düzelt.
- **Ne devredilir:** saf modüle birim testi, kaynaklı araştırma, bir alanın uzman incelemesi, iyi tanımlı tek modüllük değişiklik; Orkestra döngüsü ayrıca "bu nerede kullanılıyor", "testleri koş ve kalanları açıkla" gibi depo okuma işlerinde ucuzdur. **Ne devredilmez:** canlıya alma, veritabanı, anahtar gerektiren her şey, commit ve push, kullanıcıyla konuşulacak kararlar.
- **Veri:** Orkestra döngüsünde modele hangi dosyanın gideceğini model seçer; hassas depoda `--tools read,search` ve dar görev ver, gizli yolları projenin `agent.exclude`'una yaz.
- Ajan çağrıları kota harcar; her küçük soru için değil. `orkestra usage` model başına çağrı ve token toplamını gösterir; panoda döngünün her adımı (araç ve yol) görünür.

## Doğrulama kuralları

"How the Claude Code team thinks about verification" (16 Kasım 2026) yazısından; güvenlik ve kalite için:

- **Doğrulama, değişikliği çalıştırmaktır.** Kapı yeşili yeterli değil; uygulamayı uçtan uca çalıştırıp değişen akışı dene (web: tarayıcı, mobil: simülatör, arka uç: servisi yerelde koş). Projede bunun yolu `.claude/skills/verify/` gibi bir skill'de yazılı olmalı.
- **Üç turda düzelmeyen hata insana gider.** Aynı işte kapı üç kez üst üste kırmızıysa `orkestra gate` bunu söyler: düzeltmeyi bırak, ne denendiğini anlatıp kullanıcıya sor.
- **Değişiklik kendi denetimini değiştiremez.** Kapı ayarı (`.claude/orkestra/`) ya da `package.json` test betikleri değiştiyse kapı uyarır: o farkı kullanıcıya göster, onaysız yeşile güvenme. Ajanlar bu dosyalara hiç yazamaz.
- **Kararsız (flaky) testi geçirmek için tekrar koşma, bekleme ekleme, atlama.** Kök nedeni bul; bulunamazsa testi sil ve nedenini yaz.
- **İnceleme revizyona bağlıdır.** Eski revizyonun yeşili ya da onayı geçersizdir; düzeltmeden sonra kapı ve gerekiyorsa inceleme yeniden.
- **Kaçırılan hatayı kurala çevir.** İncelemenin kaçırdığı ve sonra bulunan hata, diff'ten tanınabiliyorsa projenin `lenses.md`'sine ya da `checklist.md`'sine madde olur. Bu dosyaları ara ara buda.

## Roller

| Rol | Model(ler) | Ne zaman |
|---|---|---|
| Mimar paneli | `critic` varsayılanı (ek görüş: `step`) | Yeni özellik veya mimari karar öncesi: planı eleştir, alternatif öner |
| Reviewer paneli | `review` varsayılanı (küçük diff'te tek model) | Her anlamlı diff sonrası, bitti demeden önce |
| Geniş bağlam | `gemini` (arka planda) | Birden çok dosyalık inceleme |
| Hızlı yardımcı | `fast` | Kısa metin, test verisi, regex, küçük sorular |
| Hakem | `codex` (yedek `ultra`) | Panel çelişkide kalırsa ve doğrulamayla karar verilemiyorsa |
| Görsel inceleyici | `codex` (yedek NVIDIA `vision`) | Ekran görüntüsünde taşma, kontrast, üst üste binme. **Birincil görsel inceleyici Claude'dur**; model ikinci görüş verir |
| Çevirmen | `translate` | Arayüz metni taslak çevirisi; her çeviriyi Claude gözden geçirir |

## Akış

1. **Planla (Claude):** Hedefi, etkilenen dosyaları ve riskleri çıkar. Küçük işlerde (tek dosya, belli çözüm) 2. adımı atla.
2. **Mimar paneli:** Planı, ilgili kodu ve proje kısıtlarını ver. Sor: "Bu planda ne kırılır, daha basit yol var mı?"
3. **Uygula (Claude):** Kodu sen yaz. Modellerin kütüphane bilgisi eskidir; API'leri güncel dokümandan doğrula.
4. **Reviewer paneli:** Diff'i, dokunulan dosyaların bağlamını, kabul ölçütlerini ve projenin `checklist.md`'sinden diff'e uyan bölümleri ver. Bulguları `dosya:satır, sorun, somut hata senaryosu, önem` biçiminde iste.
5. **Süz (Claude):** Her bulguyu kodu okuyarak ya da test ederek doğrula: ✅ geçerli (düzelt), ❓ belirsiz (test et), ❌ geçersiz (neden?). Birden fazla modelin bağımsızca bulduğu sorun daha güçlü bir sinyaldir ama yine de doğrula.
6. **Doğrula:** `orkestra gate`; ağ kodunda gerçek API'ye karşı küçük bir canlı test.
7. **Raporla:** Kullanıcıya ne yapıldığını, hangi modelin neye katkı verdiğini, reddedilen önerileri ve nedenlerini kısaca yaz.

## Kurallar

- **Gizlilik:** Modellere kod ve diff gönderilebilir. `.env*` içerikleri, API anahtarları ve kullanıcı verisi asla gönderilmez; diff'i ilgili yollarla sınırla (`git diff -- src`).
- **Bağlam:** Danışman modeller repoyu göremez. Diff'le birlikte gerekli dosyaları ve proje kısıtlarını prompt'a koy.
- **Dayanıklılık:** Panelde model düşerse (503, zaman aşımı, giriş yok) kalanlarla devam et; hepsi düşerse işi Claude tek başına bitirir ve bunu raporlar. Model erişimi işi hiçbir zaman bloklamaz.
- **Maliyet ve zaman:** Tek satırlık değişiklikler için panel çağırma.

## Operasyonel dersler

- **Küçük ve odaklı sor.** Kısa sorular 30–70 sn'de döner; büyük dosya incelemeleri yoğunlukta 300 sn'yi aşabilir. Bütün dosya yerine ilgili fonksiyonu ve tek bir net soru gönder.
- **Token bütçesi:** Akıl yürüten NVIDIA modelleri (DeepSeek, Kimi, GLM) düşünmeye token harcar; `--max-tokens` en az 5000 olmalı.
- **Zaman sınırı:** Varsayılan 180 sn; büyük işlerde `--timeout 300` ve arka plan.
- **Görseller:** Göndermeden önce küçült (macOS: `sips -s format jpeg -Z 1024 in.png --out out.jpg`; sınır 1 MB). Modeller görselde olmayan sorun uydurabilir; görsel bulguyu Claude kendisi doğrular.
- **Bulgu kalitesi:** Modeller diff'te silinen satırı hâlâ duruyor sanabilir ve var olmayan yarış durumu iddia edebilir. Süzme adımı zorunludur.
