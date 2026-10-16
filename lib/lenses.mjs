// İnceleme mercekleri ve tasarım eleştirmeni: hattın "Review" göbeğindeki kollar.
//
// Her mercek ayrı bir bakış açısıdır ama her biri için ayrı model çağrısı yapılmaz: mercekler modellere
// paylaştırılır (ör. iki model × üç mercek) ve cevap mercek başlıklarına göre bölünür. Buradaki maddeler genel;
// projenin kendi yaşanmış hataları <proje>/.claude/orkestra/lenses.md'ye yazılır ve ilgili merceğe eklenir.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PROJECT_CONFIG_DIR } from './config.mjs';

export const LENSES = {
  correctness: {
    label: 'Doğruluk',
    brief: `Mantık hataları ve durum yönetimi.
- Koşullar, döngü sınırları, null/undefined, boş liste; sınır değerin tam kendisi.
- Async akış: aynı işi iki kez başlatan yollar, yarış durumu, art arda isteklerde yalnızca sonuncunun sonucunun uygulanması.
- Başarısız işte eski durum korunuyor mu; yarım kalan değişiklik geri alınıyor mu.
- Birimler (m/km, sn/ms, yüzde) ve yuvarlama.`,
  },
  security: {
    label: 'Güvenlik',
    brief: `Gizlilik ve yetki.
- Anahtarlar, kişisel veri ya da kullanıcı içeriği loglara, hata mesajlarına ya da üçüncü taraf servislere gidiyor mu.
- Kullanıcı onayı olmadan yeni bir dış servis çağrısı eklenmiş mi.
- Yetki denetimi: kullanıcı yalnızca kendi verisine erişebiliyor mu.
- Kullanıcı girdisi sorguya, HTML'e ya da kabuğa süzülmeden giriyor mu.`,
  },
  testing: {
    label: 'Test',
    brief: `Değişikliğin testle kanıtı.
- Değişen hesap ya da karar mantığının birim testi var mı; yoksa hangi durumlar testsiz kalıyor.
- Var olan testler değişiklikten sonra hâlâ anlamlı mı (beklenti gevşetilerek geçirilmiş test var mı).
- Sınır durumları: boş liste, null, sıfır, eşik değerin tam kendisi.`,
  },
  alignment: {
    label: 'Plana uygunluk',
    brief: `Değişiklik istenen işi yapıyor mu.
- Kabul ölçütlerinin her biri karşılanmış mı; karşılanmayanı adıyla yaz.
- İstenmeyen kapsam: işle ilgisiz değişiklik, sorulmamış özellik.
- Kullanıcıya görünen metin projenin diline ve üslubuna uyuyor mu.`,
  },
  architecture: {
    label: 'Mimari',
    brief: `Yapı ve bakım.
- Değişiklik doğru katmanda mı (arayüz / durum / servis / saf hesap).
- Yinelenen mantık, gereksiz soyutlama, ölü kod; var olan yardımcı yerine yenisi yazılmış mı.
- Önbellek anahtarları ve sürümler değişen girdileri ve biçimleri yansıtıyor mu.`,
  },
  production: {
    label: 'Üretim',
    brief: `Gerçek ortamda ve gerçek yükte davranış.
- Ağ hatası, zaman aşımı, boş yanıt, izin reddi: kullanıcı ne görür, uygulama takılı kalır mı.
- Performans: sık çalışan yolda pahalı iş, gereksiz yeniden hesap ya da istek.
- Kota ve maliyet: yeni çağrı sıklığı hız sınırlarına ve ücretsiz kotalara sığıyor mu.`,
  },
};

// Projeye özel mercek maddeleri: <proje>/.claude/orkestra/lenses.md içinde "## <mercek>" başlıkları altında.
// Genel maddelerin sonuna eklenir. Bilinmeyen başlık yok sayılır.
export function parseLensNotes(text) {
  const notes = {};
  const marks = [...text.matchAll(/^##\s+([a-z]+)\b.*$/gim)];
  marks.forEach((m, i) => {
    const key = m[1].toLowerCase();
    if (!(key in LENSES)) return;
    const body = text.slice(m.index + m[0].length, i + 1 < marks.length ? marks[i + 1].index : undefined).trim();
    if (body) notes[key] = notes[key] ? `${notes[key]}\n${body}` : body;
  });
  return notes;
}

export function projectLensNotes() {
  try {
    return parseLensNotes(readFileSync(join(PROJECT_CONFIG_DIR, 'lenses.md'), 'utf8'));
  } catch {
    return {};
  }
}

export const LENS_KEYS = Object.keys(LENSES);

// Mercekleri modellere sırayla paylaştırır: iki modelde üçer mercek.
export function assignLenses(models, lenses = LENS_KEYS) {
  const size = Math.ceil(lenses.length / models.length);
  return models.map((model, i) => ({ model, lenses: lenses.slice(i * size, (i + 1) * size) })).filter((a) => a.lenses.length > 0);
}

// role: inceleyicinin uzmanlığı (proje ayarındaki "reviewer", ör. "React Native / Expo / Supabase").
// notes: projeye özel mercek maddeleri (projectLensNotes).
export function reviewSystem(lenses, { role, notes = {} } = {}) {
  return `Kıdemli bir ${role ? `${role} ` : ''}kod reviewer'ısın. Repoyu göremezsin; yalnızca sana verilen diff ve bağlamı incele.
Aşağıdaki her mercek için AYRI bir bölüm yaz. Her bölüm tam olarak "## <mercek anahtarı>" başlığıyla başlar.

${lenses.map((key) => `## ${key} (${LENSES[key].label})\n${LENSES[key].brief}${notes[key] ? `\nBu projede ayrıca:\n${notes[key]}` : ''}`).join('\n\n')}

Her bölümde şunlardan biri:
- Bulgular, her biri tek satır: "dosya:satır, sorun, somut hata senaryosu, önem (yüksek|orta|düşük)".
- Bulgu yoksa yalnızca: BULGU YOK
- Bağlam yetersizse yalnızca: İNCELEYEMEDİM: <eksik olan>
Tahminle bulgu ya da onay üretme. Diff'te silinen (-) satırı hâlâ duruyor sanma. Türkçe yaz; giriş ve özet yazma.`;
}

// Cevabı mercek bölümlerine ayırır. Bölümü bulunmayan mercek "incelenemedi" sayılır.
export function splitByLens(text, lenses) {
  const sections = new Map();
  const heading = /^#{1,3}\s*\**\s*([a-z]+)\b.*$/gim;
  // İstenmeyen bir merceğin başlığı da bölümü bitirir; mercek olmayan başlık (ör. "## notlar") bitirmez.
  const marks = [...text.matchAll(heading)].filter((m) => LENS_KEYS.includes(m[1].toLowerCase()));
  marks.forEach((m, i) => {
    const body = text.slice(m.index + m[0].length, i + 1 < marks.length ? marks[i + 1].index : undefined).trim();
    sections.set(m[1].toLowerCase(), body);
  });
  return lenses.map((key) => {
    const body = sections.get(key);
    if (body == null) return { lens: key, outcome: 'skipped', text: 'Cevapta bu merceğin bölümü yok.' };
    if (/İNCELEYEMED[İI]M/i.test(body)) return { lens: key, outcome: 'skipped', text: body };
    if (/BULGU YOK/i.test(body) && body.length < 200) return { lens: key, outcome: 'clean', text: body };
    return { lens: key, outcome: 'findings', text: body };
  });
}

export const MAX_DESIGN_ROUNDS = 5;

export const CRITIC_SYSTEM = `Kıdemli bir yazılım mimarısın ve bu tasarımın eleştirmenisin. Repoyu göremezsin; yalnızca verilen tasarımı ve bağlamı değerlendir.
Puan verme. Tam olarak şu üç başlıkla cevap ver:

## ENGELLER
Bu haliyle uygulanırsa kırılacak ya da yanlış sonuç verecek şeyler. Her biri tek satır ve somut senaryolu. Yoksa yalnızca: ENGEL YOK

## UYARILAR
Kırmaz ama pahalıya patlar: gereksiz karmaşıklık, daha basit yol, bakım yükü.

## EKSİK KANIT
Karar verebilmek için tasarımda olmayan bilgi.

Önceki turda yazdığın bir engel giderildiyse yeniden yazma. Türkçe, kısa, madde madde.`;
