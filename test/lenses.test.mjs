import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assignLenses, LENS_KEYS, parseLensNotes, reviewSystem, splitByLens } from '../lib/lenses.mjs';

const outcomes = (text, lenses) => Object.fromEntries(splitByLens(text, lenses).map((s) => [s.lens, s.outcome]));

test('mercekler modellere eşit paylaştırılır, hiçbiri açıkta kalmaz', () => {
  assert.deepEqual(assignLenses(['a', 'b']).map((p) => p.lenses.length), [3, 3]);
  assert.deepEqual(assignLenses(['a']).map((p) => p.lenses), [LENS_KEYS]);
  const three = assignLenses(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  assert.deepEqual(three.flatMap((p) => p.lenses), LENS_KEYS);
  assert.equal(three.length, 6);
});

test('cevap mercek başlıklarına göre bölünür', () => {
  const text = '## correctness\na.ts:1, x, y, orta\n\n## security (Güvenlik)\nBULGU YOK\n\n### **testing**\nİNCELEYEMEDİM: test dosyası yok';
  assert.deepEqual(outcomes(text, ['correctness', 'security', 'testing']), { correctness: 'findings', security: 'clean', testing: 'skipped' });
  assert.equal(splitByLens(text, ['correctness'])[0].text, 'a.ts:1, x, y, orta');
});

test('bölümü olmayan mercek temiz sayılmaz', () => {
  assert.deepEqual(outcomes('## security\nBULGU YOK', ['security', 'production']), { security: 'clean', production: 'skipped' });
  assert.deepEqual(outcomes('Genel olarak iyi görünüyor.', ['security']), { security: 'skipped' });
});

test('"BULGU YOK" deyip bulgu da yazan bölüm bulgulu sayılır', () => {
  const long = '## correctness\nBULGU YOK ama şuna dikkat: ' + 'src/app/trip.tsx:212, bekleme süresi sıfırlanmıyor, sürücü rotaya dönüp yeniden çıkınca beklenmez, orta. '.repeat(3);
  assert.deepEqual(outcomes(long, ['correctness']), { correctness: 'findings' });
});

test('istenmeyen merceğin başlığı bölümü kesmez', () => {
  const text = '## correctness\nbulgu 1\n## notlar\nek açıklama\n## security\nBULGU YOK';
  const [correctness] = splitByLens(text, ['correctness', 'security']);
  assert.match(correctness.text, /ek açıklama/);
});

test('sistem istemi yalnızca istenen mercekleri içerir', () => {
  const system = reviewSystem(['security', 'testing']);
  assert.match(system, /## security/);
  assert.match(system, /## testing/);
  assert.doesNotMatch(system, /## production/);
});

test('projeye özel maddeler ilgili merceğe eklenir, bilinmeyen başlık yok sayılır', () => {
  const notes = parseLensNotes('# Başlık\n\n## correctness\n- onPress olayı parametreye gider\n\n## notlar\n- yok sayılır\n\n## security\n\n## production\n- PostGIS st_subdivide');
  assert.deepEqual(Object.keys(notes).sort(), ['correctness', 'production']);
  assert.match(notes.correctness, /onPress/);
  assert.doesNotMatch(notes.correctness, /yok sayılır/);
  const system = reviewSystem(['correctness', 'security'], { role: 'React Native', notes });
  assert.match(system, /Kıdemli bir React Native kod reviewer'ısın/);
  assert.match(system, /Bu projede ayrıca:\n- onPress/);
  assert.equal(system.match(/Bu projede ayrıca/g).length, 1);
});

test('rol verilmezse istem genel kalır', () => {
  assert.match(reviewSystem(['testing']), /^Kıdemli bir kod reviewer'ısın/);
});
