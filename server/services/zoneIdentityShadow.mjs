/**
 * ★2 قياس (وضع الظل — لا يقرأه أي قرار منشور): حجم عدم ثبات معرّف منطقة السيولة.
 *
 * المشكلة (A4): المعرّف `cluster-<kind>-<i>-<price>` يحمل ترتيب العنقود `i`، وترتيب
 * العنقود يتغيّر كلما ظهرت قمة أو قاع جديد قبله. فمنطقة لم يتغيّر سعرها ولا نوعها قد
 * يتغيّر معرّفها بين دورتين، ويُبقي `mergeZones` النسختين معاً مع أن المنطقة واحدة.
 *
 * التجربة السببية هنا: نُشغّل الكشف مرتين على نفس الشموع بفارق شمعة واحدة في `endIndex`.
 * الشمعة الواحدة لا يمكن أن تُنشئ أو تُلغي مناطق بعيدة، فكل منطقة «مُطابَقة» بين
 * التشغيلين هي **نفس المنطقة**. إذا اختلف معرّفها فذلك عدم ثبات خالص.
 *
 * المطابقة بالتقارب لا بمفتاح مُقرَّب: شبكة التقريب نفسها غير مستقرة على الحدود،
 * فالمطابقة بمفتاح شبكي تُنتج دوراناً وهمياً وتُفسد القياس.
 */

/** المسافة النسبية بين سعرين (نفس قاعدة دمج العناقيد في المحرك) */
function relativeDistance(a, b) {
  return Math.abs(a - b) / Math.max(Math.abs(b), 1e-12);
}

/**
 * يحسب ثبات الهوية بين تشغيلين لنفس (رمز، فريم).
 * @param {Array} prev مناطق التشغيل الأول
 * @param {Array} next مناطق التشغيل الثاني (بشمعة أقل)
 * @param {number} tolerancePct نسبة التحمل نفسها المستخدمة في العنقدة
 * @param {number} keepPairs سقف الأزواج المُعادة (منع تضخّم الذاكرة في عيّنة كبيرة)
 * @returns {{matched:number, churned:number, added:number, removed:number, churnRate:number|null, examples:Array, pairs:Array}}
 */
export function idStability(prev = [], next = [], tolerancePct = 0.002, keepPairs = 64) {
  const used = new Set();
  let matched = 0;
  let churned = 0;
  let stable = 0;
  const examples = [];
  const pairs = [];

  for (const zone of next) {
    let best = null;
    let bestDistance = Infinity;
    for (let i = 0; i < prev.length; i += 1) {
      if (used.has(i)) continue;
      const candidate = prev[i];
      if (candidate.kind !== zone.kind) continue;
      const distance = relativeDistance(zone.referenceLevel, candidate.referenceLevel);
      if (distance <= tolerancePct && distance < bestDistance) {
        best = i;
        bestDistance = distance;
      }
    }
    if (best == null) continue;
    used.add(best);
    matched += 1;
    const same = prev[best].id === zone.id;
    if (same) stable += 1;
    else {
      churned += 1;
      if (examples.length < 3) {
        examples.push({
          kind: zone.kind,
          level: Number(zone.referenceLevel.toPrecision(10)),
          driftPct: Number((bestDistance * 100).toFixed(5)),
          before: prev[best].id,
          after: zone.id
        });
      }
    }
    /**
     * الأزواج تُعاد لتُغذّى بها مقارنة الظل **بالحبيبة الصحيحة** وهي المنطقة لا العيّنة:
     * نسبة دوران مرجّحة بعدد المناطق. `stable` مُبقى للعرض السريع فقط.
     */
    if (pairs.length < keepPairs) pairs.push({ before: prev[best].id, after: zone.id, same });
  }

  /**
   * `removed` بالمعنى المادي: منطقة اختفت فعلاً من الكشف، لا منطقة تغيّر معرّفها.
   * لو حُسبت هكذا لدخل الدوران في العدّ مرتين وانتفخ المؤشر.
   */
  const removed = prev.length - used.size;
  return {
    matched,
    churned,
    stable,
    added: next.length - matched,
    removed,
    churnRate: matched === 0 ? null : Number((churned / matched).toFixed(4)),
    examples,
    pairs
  };
}

/**
 * يقيس ثبات الهوية بتشغيل الكشف مرتين بفارق `lookbackBars` شمعة. الاتجاه **أمامي**:
 * حالة المنطقة قبل `lookbackBars` مقابل معرّفها الآن — وهذا ما يحدث فعلاً بين دورتي فحص
 * لنفس الزوج والفريم. `detect` تُمرَّر كدالة لتبقى هذه الوحدة نقية (فتُختبر بمُصنَّع).
 *
 * القياس المُشتق على بيانات حقيقية (5 أزواج × فريمان، BTC/ETH/SOL/BNB/XRP، 900 شمعة):
 *   فجوة شمعة واحدة 22.1% | فجوتان 34.6% | 4 شموع 37.6% | 8 شموع 48.0%
 * والانزياح السعري في كل الأمثلة أقل من 0.1% وهو دون نسبة العنقدة (0.2%) — فالمنطقة هي
 * **نفسها** مادياً لكن معرّفها تغيّر. لهذا نافذة القياس الافتراضية 4 شموع لا شمعة واحدة:
 * شمعة واحدة تُظهر 22% فقط فتُبخّس حجم العيب.
 */
export function measureIdentityStability({ detect, symbol, timeframe, endIndex, tolerancePct, lookbackBars = 4 }) {
  const bars = Math.max(1, Number(lookbackBars) || 4);
  const full = detect({ endIndex });
  const olderEnd = endIndex - bars;
  if (olderEnd < 20) return { symbol, timeframe, endIndex, lookbackBars: bars, zonesFull: full.length, zonesTrimmed: 0, matched: 0, churned: 0, stable: 0, added: 0, removed: 0, churnRate: null, examples: [], pairs: [] };
  const older = detect({ endIndex: olderEnd });
  return {
    symbol,
    timeframe,
    endIndex,
    lookbackBars: bars,
    zonesFull: full.length,
    zonesTrimmed: older.length,
    ...idStability(older, full, tolerancePct)
  };
}

/**
 * مجمّع تراكمي للتقرير: يبني ناتج `shadow.compare` من عيّنات `measureIdentityStability`.
 * `keys` عدّ العيّنات، و`churnRate` نسبة الدوران المرجّحة بعدد المناطق المُطابَقة.
 */
export function createIdentityCollector() {
  let samples = 0;
  let matched = 0;
  let churned = 0;
  let zones = 0;
  const examples = [];

  return {
    add(sample) {
      if (!sample || !sample.matched) { samples += 1; zones += sample?.zonesFull ?? 0; return; }
      samples += 1;
      matched += sample.matched;
      churned += sample.churned;
      zones += sample.zonesFull;
      for (const example of sample.examples ?? []) {
        if (examples.length < 3) examples.push({ ...example, symbol: sample.symbol, timeframe: sample.timeframe });
      }
    },
    summary() {
      return {
        samples,
        zones,
        matched,
        churned,
        churnRate: matched === 0 ? null : Number((churned / matched).toFixed(4)),
        examples
      };
    }
  };
}
