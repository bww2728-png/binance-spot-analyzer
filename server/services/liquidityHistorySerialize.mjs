/**
 * تسلسل مخرجات محركي السيولة للشارت التاريخي — طبقة تمرير فقط.
 *
 * لا قاعدة كشف واحدة هنا: كل الحقول تُنسخ من نتيجة المحرك كما هي، والإضافات
 * محدودة ومُعلنة:
 *   - `availableAt` + `availableAtBasis`: أول لحظة يمكن فيها معرفة العنصر.
 *       · مناطق/خطوط من بيفوتات: تأكيد **آخر** بيفوت = candles[index + rightBars].time
 *         (نفس قاعدة `findPivots` المعلنة في المحرك، و`rightBars` من adaptiveConfig).
 *       · عرض/طلب: تكون FVG يحتاج الشمعة التالية للفجوة ⇒ time(maxFvgIndex + 1).
 *       · IDM: زمن كسر الحركة الارتدادية إن تأكد، وإلا زمن تأكيد بيفوته.
 *   - `brokenPivotTime`/`brokenTime`: استعلام فهرس→زمن فقط.
 *   - تمرير `confirmedAt`/`invalidatedAt`/`fvgs`/`structureEvents` بدل إسقاطها.
 *
 * سبب الحاجة مُثبت: بدون هذه الأزمنة يصبح `createdAt` (زمن البيفوت) هو المتاح
 * للواجهة، وهو يسبق لحظة المعرفة الحقيقية بـ3..12 شمعة ⇒ تسرب مستقبل في وضع
 * التتبع. والاختبارات في `server/tests/liquidityHistoryContract.test.mjs` تثبته.
 */

const fin = (v) => v != null && v !== '' && Number.isFinite(Number(v));
const numOrNull = (v) => (fin(v) ? Number(v) : null);

export function createHistorySerializer(candles) {
  const list = Array.isArray(candles) ? candles : [];
  const endIndex = list.length - 1;

  const timeAt = (index) => {
    if (!fin(index)) return null;
    const i = Math.trunc(Number(index));
    if (i < 0 || i >= list.length) return null;
    const t = Number(list[i].time);
    return Number.isFinite(t) ? t : null;
  };

  let rightBars = 3;

  const setRightBars = (value) => {
    if (Number.isFinite(Number(value)) && Number(value) > 0) rightBars = Math.trunc(Number(value));
  };

  const pivotConfirmTime = (index) => {
    if (!fin(index)) return null;
    const i = Math.trunc(Number(index));
    return timeAt(Math.min(i + rightBars, endIndex));
  };

  const isSupplyDemand = (zone) => zone?.kind === 'supply' || zone?.kind === 'demand';

  const serializeTouch = (p) => {
    const index = numOrNull(p?.index);
    const time = numOrNull(p?.time);
    const price = numOrNull(p?.price);
    if (time == null || price == null) return null;
    return {
      index,
      time,
      price,
      availableAt: index != null ? pivotConfirmTime(index) : time
    };
  };

  const serializeFvg = (f) => {
    if (!f) return null;
    const top = numOrNull(f.top);
    const bottom = numOrNull(f.bottom);
    const index = numOrNull(f.index);
    if (top == null || bottom == null || index == null) return null;
    return {
      index,
      time: numOrNull(f.time) ?? timeAt(index),
      kind: f.kind ?? null,
      top,
      bottom,
      availableAt: timeAt(index + 1),
      invalidatedAt: numOrNull(f.invalidatedAt)
    };
  };

  const serializeEvent = (e) => {
    if (!e || !fin(e.index) || !fin(e.price)) return null;
    const index = Math.trunc(Number(e.index));
    const evidence = e.evidence && typeof e.evidence === 'object' ? e.evidence : null;
    const brokenIndex = evidence && fin(evidence.brokenIndex) ? Math.trunc(Number(evidence.brokenIndex)) : null;
    const brokenPivotIndex = fin(e.brokenPivotIndex) ? Math.trunc(Number(e.brokenPivotIndex)) : null;
    const time = numOrNull(e.time) ?? timeAt(index);
    if (time == null) return null;
    const isIdm = e.type === 'idm';
    const confirmed = evidence ? evidence.confirmed !== false : true;
    return {
      key: `${e.type}:${index}`,
      type: e.type,
      index,
      time,
      price: Number(e.price),
      brokenLevel: numOrNull(e.brokenLevel),
      brokenPivotIndex,
      brokenPivotTime: brokenPivotIndex != null ? timeAt(brokenPivotIndex) : null,
      brokenIndex,
      brokenTime: brokenIndex != null ? timeAt(brokenIndex) : null,
      confirmBasis: e.confirmBasis ?? null,
      external: e.external === true,
      priorBos: numOrNull(e.priorBos),
      idmLevel: numOrNull(e.idmLevel),
      availableAt: isIdm ? (confirmed && brokenIndex != null ? timeAt(brokenIndex) : pivotConfirmTime(index)) : time,
      confirmed: isIdm ? confirmed : true,
      evidence
    };
  };

  const serializeZone = (zone) => {
    const sd = isSupplyDemand(zone);
    const createdAt = numOrNull(zone.createdAt);
    const confirmedAt = numOrNull(zone.confirmedAt);
    const sweptAt = numOrNull(zone.sweptAt) ?? numOrNull(zone.invalidation?.at);

    const fvgs = Array.isArray(zone.fvgs) ? zone.fvgs.map(serializeFvg).filter(Boolean) : [];
    const touches = Array.isArray(zone.touchPoints) ? zone.touchPoints.map(serializeTouch).filter(Boolean) : [];

    let availableAt = null;
    let availableAtBasis = 'created';
    if (sd) {
      const maxFvgIndex = fvgs.reduce((m, f) => Math.max(m, f.index), -1);
      const formed = maxFvgIndex >= 0 ? timeAt(maxFvgIndex + 1) : null;
      const candidates = [createdAt, formed].filter((v) => v != null);
      if (candidates.length) {
        availableAt = Math.max(...candidates);
        availableAtBasis = formed != null && availableAt === formed ? 'fvg_formed' : 'created';
      }
    } else {
      const pivotTimes = touches
        .map((p) => (p.index != null ? pivotConfirmTime(p.index) : p.time))
        .filter((v) => v != null);
      const lastPivot = pivotTimes.length ? Math.max(...pivotTimes) : null;
      const candidates = [createdAt, lastPivot].filter((v) => v != null);
      if (candidates.length) {
        availableAt = Math.max(...candidates);
        availableAtBasis = lastPivot != null && availableAt === lastPivot ? 'pivot_confirm' : 'created';
      }
    }

    // نقاط لمس منطقة العرض/الطلب ليست بيفوتاً: تُعرف عند تكون المنطقة نفسها
    if (sd && availableAt != null) {
      for (const p of touches) p.availableAt = availableAt;
    }

    const trendline = zone.trendline && Array.isArray(zone.trendline.points) && zone.trendline.points.length >= 2
      ? {
          points: zone.trendline.points.slice(0, 12).map((p) => ({
            index: numOrNull(p.index),
            time: numOrNull(p.time),
            price: numOrNull(p.price)
          })).filter((p) => p.time != null && p.price != null),
          projected: numOrNull(zone.trendline.projected),
          slope: numOrNull(zone.trendline.slope),
          errorAtr: numOrNull(zone.trendline.errorAtr),
          maxDeviationAtr: numOrNull(zone.trendline.maxDeviationAtr)
        }
      : null;

    return {
      id: zone.id,
      kind: zone.kind,
      state: zone.state,
      direction: zone.direction ?? null,
      referenceLevel: numOrNull(zone.referenceLevel),
      referenceAlt: numOrNull(zone.referenceAlt),
      liquidityLevel: numOrNull(zone.liquidityLevel),
      retailStop: numOrNull(zone.retailStop),
      zoneBox: zone.zoneBox ?? null,
      bodyBox: zone.bodyBox ?? null,
      createdAt,
      confirmedAt,
      /**
       * `detectedAt` في المحرك القديم = `Date.now()` (ساعة الجهاز) عند الحساب:
       * لا يحمل أي معلومة تاريخية عن العنصر، ويجعل مخرجات الشارت غير حتمية بين
       * تشغيلين. يُسقَط صراحةً هنا بدل تمريره ليُفهم خطأً كزمن اكتشاف تاريخي.
       */
      detectedAt: null,
      sweptAt,
      invalidatedAt: numOrNull(zone.invalidation?.at),
      invalidation: zone.invalidation ?? null,
      availableAt,
      availableAtBasis,
      confidence: numOrNull(zone.confidence),
      touches: numOrNull(zone.touches),
      timeframe: zone.timeframe,
      touchPoints: touches,
      trendline,
      staircase: zone.staircase ?? null,
      finalBreak: zone.finalBreak ?? null,
      breakSteps: Array.isArray(zone.breakSteps) ? zone.breakSteps : [],
      atr: numOrNull(zone.atr),
      distanceAtr: numOrNull(zone.distanceAtr),
      prominenceAtr: numOrNull(zone.prominenceAtr),
      reasons: Array.isArray(zone.reasons) ? zone.reasons : [],
      premium: zone.premium ?? null,
      form: zone.form ?? null,
      fvgs,
      /**
       * `structureEvents` في محرك v2 = **كل** الأحداث من نشأة المنطقة حتى نهاية
       * النافذة (index.mjs: `related`)، وليست أحداثاً مرتبطة بالمنطقة بعينها.
       * نسخها لكل منطقة كان يضخّم الحمولة إلى عشرات الميغابايت (1146 منطقة ×
       * آلاف المفاتيح) ويُسقط خيط الحساب بحد 128MB. لذلك تُمرَّر الأحداث مرة
       * واحدة في حمولة الاستجابة، وتُعرض أحداث المنطقة من نطاقها الزمني الحقيقي.
       */
      structureEventKeys: [],
      source: zone.source ?? null
    };
  };

  return { get rightBars() { return rightBars; }, setRightBars, serializeZone, serializeEvent, serializeTouch, serializeFvg, timeAt, pivotConfirmTime };
}
