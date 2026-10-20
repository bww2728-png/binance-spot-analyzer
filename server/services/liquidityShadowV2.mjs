/**
 * قياس ظل محرك السيولة v2 مقابل المحرك الأول — **بلا أي أثر على القرارات المنشورة**.
 *
 * الغرض المعلن: قبل أي تفعيل، نريد رقماً حقيقياً يجيب سؤالاً واحداً:
 * «هل يُنتج المحرك الجديد نفس المناطق التي كان المحرك الأول يُنتجها؟» — وإن اختلف، فأين
 * وكيف ولماذا. بلا هذا الرقم يكون أي «تحسين» دعوى لا دليل.
 *
 * طريقة القياس:
 *  - نفس الشموع، ونفس اللحظة (`endIndex` نفسه) يأخذها المحركان من نفس المخزن.
 *  - المطابقة **بالتقارب** (مفتاح شبكي على السعر المرجعي + النوع)، لا بمفتاح مُقرَّب:
 *    القياس السابق أثبت أن الشبكة التقريبية غير مستقرة على الحدود فتُنتج دوراناً وهمياً.
 *  - القياس **تراكمي مرجّح بعدد المناطق** لا متوسط نسب العيّنات (المتوسط يُخفي الفرق:
 *    أعطى 0.5 بينما الحقيقة 0.0099).
 *  - تقدّم المحرك v2 لا يؤثر في المحرك v1 ولا في أي قرار: القراءة فقط من المخزن.
 */

import { detectLiquidityZones } from '../liquidity-zones/engine.mjs';
import { detectLiquidityZonesV2 } from '../liquidity-zones/v2/index.mjs';

const fin = (v) => Number.isFinite(Number(v));

/**
 * مطابقة مجموعتين بالتقارب. كل عنصر: { kind, referenceLevel }.
 * @returns {{ matched:number, sameState:number, onlyOld:number, onlyNew:number, stateChanges:Array }}
 */
export function matchByProximity(oldZones, newZones, tolerancePct = 0.002) {
  const used = new Set();
  let matched = 0;
  let sameState = 0;
  const stateChanges = [];
  const byKind = {};
  const bump = (kind, field) => {
    if (!byKind[kind]) byKind[kind] = { old: 0, new: 0, matched: 0, sameState: 0 };
    byKind[kind][field] += 1;
  };
  for (const z of oldZones) bump(z.kind, 'old');
  for (const nz of newZones) {
    bump(nz.kind, 'new');
    let best = -1;
    let bestDist = Infinity;
    for (let i = 0; i < oldZones.length; i += 1) {
      if (used.has(i) || oldZones[i].kind !== nz.kind) continue;
      const a = Number(oldZones[i].referenceLevel);
      const b = Number(nz.referenceLevel);
      if (!fin(a) || !fin(b)) continue;
      const dist = Math.abs(a - b) / Math.max(Math.abs(a), 1e-12);
      if (dist <= tolerancePct && dist < bestDist) { best = i; bestDist = dist; }
    }
    if (best < 0) continue;
    used.add(best);
    matched += 1;
    byKind[nz.kind].matched += 1;
    if (oldZones[best].state === nz.state) {
      sameState += 1;
      byKind[nz.kind].sameState += 1;
    } else if (stateChanges.length < 12) {
      stateChanges.push({
        kind: nz.kind,
        referenceLevel: Number(nz.referenceLevel),
        oldState: oldZones[best].state,
        newState: nz.state
      });
    }
  }
  return {
    matched,
    sameState,
    onlyOld: oldZones.length - used.size,
    onlyNew: newZones.length - matched,
    stateChanges,
    byKind
  };
}

/** مُجمِّع تراكمي: يجمع على مستوى المنطقة لا على مستوى العيّنة */
export function createParityCollector() {
  /** خريطة لكل نوع: { old, new, matched, sameState } — أساس حساب التطابق العادل */
  const kinds = new Map();
  const totals = {
    samples: 0, oldZones: 0, newZones: 0, matched: 0, sameState: 0, onlyOld: 0, onlyNew: 0,
    stateChanges: 0, structure: { idm: 0, bosUp: 0, bosDown: 0, chochUp: 0, chochDown: 0 },
    idmConfirmed: 0, fvg: 0, fvgTriggered: 0, sdConfirmed: 0, sdProvisional: 0,
    oldMs: 0, newMs: 0, maxNewMs: 0
  };
  function add(entry) {
    totals.samples += 1;
    totals.oldZones += entry.oldCount;
    totals.newZones += entry.newCount;
    totals.matched += entry.match.matched;
    totals.sameState += entry.match.sameState;
    totals.onlyOld += entry.match.onlyOld;
    totals.onlyNew += entry.match.onlyNew;
    totals.stateChanges += entry.match.stateChanges.length;
    for (const k of ['idm', 'bosUp', 'bosDown', 'chochUp', 'chochDown']) totals.structure[k] += entry.structure?.[k] ?? 0;
    totals.idmConfirmed += entry.idmConfirmed ?? 0;
    totals.fvg += entry.fvg ?? 0;
    totals.fvgTriggered += entry.fvgTriggered ?? 0;
    totals.sdConfirmed += entry.sdConfirmed ?? 0;
    totals.sdProvisional += entry.sdProvisional ?? 0;
    totals.oldMs += entry.oldMs ?? 0;
    totals.newMs += entry.newMs ?? 0;
    totals.maxNewMs = Math.max(totals.maxNewMs, entry.newMs ?? 0);
    for (const [kind, v] of Object.entries(entry.match.byKind ?? {})) {
      const cur = kinds.get(kind) ?? { old: 0, new: 0, matched: 0, sameState: 0 };
      cur.old += v.old; cur.new += v.new; cur.matched += v.matched; cur.sameState += v.sameState;
      kinds.set(kind, cur);
    }
  }
  function report() {
    const perKind = Object.fromEntries(kinds);
    /**
     * التطابق العادل يُحسب على **الأنواع المشتركة بين المحركين فقط**.
     *
     * عيب مُثبت في القياس الأول: كان `parityPct` يُقسم المطابَقات على **كل** مناطق المحرك
     * الأول، بينما مناطق العرض/الطلب (نوعان جديدان بطلب صاحب النظام، ~48 ألف منطقة) لا
     * مقابل لها في المحرك الأول أصلاً — فتُحسب «مناطق جديدة لا نظير لها» وتُفسد الرقم.
     * القياس ظهر ‏68.3% وهو **رقم مضلِّل** لأن معظم مناطقه الجديدة لا يُقارَن بشيء.
     * الصواب: نوع بنوع، ثم نسبتان — نسبة على الأنواع المشتركة، وقائمة صريحة بالأنواع الجديدة.
     */
    const shared = {};
    const added = {};
    for (const [kind, v] of Object.entries(perKind)) {
      if (v.old > 0) shared[kind] = v;
      else added[kind] = v;
    }
    const sharedOld = Object.values(shared).reduce((a, v) => a + v.old, 0);
    const sharedMatched = Object.values(shared).reduce((a, v) => a + v.matched, 0);
    const sharedSame = Object.values(shared).reduce((a, v) => a + v.sameState, 0);
    return {
      ...totals,
      byKind: perKind,
      sharedKinds: shared,
      addedKinds: added,
      parityPct: sharedOld ? Number(((100 * sharedMatched) / sharedOld).toFixed(1)) : null,
      stateParityPct: sharedMatched ? Number(((100 * sharedSame) / sharedMatched).toFixed(1)) : null,
      avgOldMs: totals.samples ? Number((totals.oldMs / totals.samples).toFixed(2)) : 0,
      avgNewMs: totals.samples ? Number((totals.newMs / totals.samples).toFixed(2)) : 0
    };
  }
  return { add, report, totals };
}

/**
 * مقارنة محركَي السيولة على نفس الشموع ونفس اللحظة.
 * @param {Object} p { symbol, timeframe, candles, endIndex, tolerancePct, now }
 */
export function compareEngines({ symbol, timeframe, candles, endIndex, tolerancePct = 0.002, now = 0 }) {
  const empty = { old: [], v2: [], match: { matched: 0, sameState: 0, onlyOld: 0, onlyNew: 0, stateChanges: [] } };
  if (!Array.isArray(candles) || candles.length < 60) return empty;

  const t0 = process.hrtime.bigint();
  let oldZones = [];
  try {
    oldZones = detectLiquidityZones({ symbol, timeframe, candles, endIndex }) ?? [];
  } catch { oldZones = []; }
  const t1 = process.hrtime.bigint();

  let v2Zones = [];
  try {
    v2Zones = detectLiquidityZonesV2({ symbol, timeframe, candles, endIndex, opts: { nowMs: now } }) ?? [];
  } catch { v2Zones = []; }
  const t2 = process.hrtime.bigint();

  return {
    symbol,
    timeframe,
    old: oldZones,
    v2: v2Zones,
    match: matchByProximity(oldZones, v2Zones, tolerancePct),
    oldMs: Number(t1 - t0) / 1e6,
    newMs: Number(t2 - t1) / 1e6
  };
}

/** حصيلة عيّنة واحدة تُغذّي المُجمِّع */
export function summarizeSample(result) {
  const kinds = {};
  for (const z of result.v2 ?? []) kinds[z.kind] = (kinds[z.kind] ?? 0) + 1;
  const sd = (result.v2 ?? []).filter(z => z.kind === 'demand' || z.kind === 'supply');
  const events = (result.v2 ?? []).flatMap(z => z.structureEvents ?? []);
  const uniq = new Map();
  for (const e of events) uniq.set(`${e.type}:${e.index}`, e);
  const list = [...uniq.values()];
  return {
    oldCount: (result.old ?? []).length,
    newCount: (result.v2 ?? []).length,
    match: result.match,
    byKind: kinds,
    structure: {
      idm: list.filter(e => e.type === 'idm').length,
      bosUp: list.filter(e => e.type === 'bos_up').length,
      bosDown: list.filter(e => e.type === 'bos_down').length,
      chochUp: list.filter(e => e.type === 'choch_up').length,
      chochDown: list.filter(e => e.type === 'choch_down').length
    },
    idmConfirmed: list.filter(e => e.type === 'idm' && e.confirmed !== false).length,
    fvg: (result.v2 ?? []).reduce((a, z) => a + (z.fvgs?.length ?? 0), 0),
    fvgTriggered: (result.v2 ?? []).filter(z => (z.fvgs?.length ?? 0) > 0 && z.state === 'confirmed').length,
    sdConfirmed: sd.filter(z => z.state === 'confirmed').length,
    sdProvisional: sd.filter(z => z.state !== 'confirmed').length,
    oldMs: result.oldMs,
    newMs: result.newMs
  };
}
