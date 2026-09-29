/* محرك الحالة المستمرة وتتبع الأحداث — CSSE
 * Continuous Strategy State & Event Tracking Engine
 *
 * المبدأ: Previous State + New Candle + New Events = Updated State
 * (وليس: حمّل الشارت ← حلّل ← انسَ ← حلّل مجدداً)
 *
 * هذا الملف نقي وحتمي 100%: لا شبكة، لا تواريخ حية داخلية (now يُمرَّر)،
 * ولا يغيّر أي تعريف من تعريفات الاستراتيجية — يشتق كل شيء من مخرجات
 * النواة القائمة (analyzeCandles / computeDirectionState) كما هي.
 *
 * لكل (رمز|فريم) يحتفظ بـ:
 *  - عناصر بهويات حتمية: BSL#n / SSL#n / PH#n / PL#n / CHoCH / IND_S / IND_B / TP1 / TP2
 *    (المعرف = رمز|فريم|نوع|زمن التكوين|مستوى مقرب — يُعاد اشتقاقه نفسه بعد restart)
 *  - دورة حياة لكل عنصر + تفاعلات السعر معه + تاريخ انتقالات مسجل
 *  - علاقات (سويب ← عنصر ← قاع/قمة ← رِجل ← ديسكاونت) + قائمة تسلسل (تحقق/لم يتحقق بعد)
 *  - آلة إعداد: WAIT → WATCH → ARMED → CONFIRMED → OPPORTUNITY → INVALIDATED → RESOLVED
 *    (CSSE يحسب حتى CONFIRMED/INVALIDATED؛ OPPORTUNITY/RESOLVED يرفعها loop عند النشر/الحسم)
 */

export const CSSE_VERSION = 'csse-v1';
export const MAX_ELEMENTS_PER_KEY = 120;
export const MAX_EVENTS_PER_KEY = 300;

// حالات العنصر
export const ELEMENT_STATES = [
  'created', 'active', 'tested', 'swept', 'broken',
  'confirmed', 'invalidated', 'resolved'
];

// تفاعلات السعر
export const INTERACTIONS = [
  'approached', 'touched', 'wickedThrough', 'closedThrough',
  'rejected', 'swept', 'reclaimed', 'movedAway', 'returned'
];

/** معرف حتمي للعنصر — نفس المدخلات تعطي نفس المعرف بعد أي restart */
export function elementId(symbol, tf, kind, anchorTime, level) {
  const lv = Number(level);
  const lvl = Number.isFinite(lv) ? lv.toPrecision(10) : 'nan';
  return `${String(symbol).toUpperCase()}|${tf}|${kind}|${Number(anchorTime) || 0}|${lvl}`;
}

export function createCsseState(symbol, tf) {
  return {
    version: CSSE_VERSION,
    symbol: String(symbol).toUpperCase(),
    tf,
    elements: new Map(),   // id → عنصر
    order: [],             // ترتيب الإنشاء (للاحتفاظ بالأقدم عند الإخلاء)
    events: [],            // سجل زمني (الأحدث في النهاية)
    links: [],             // علاقات {from, to, rel, at}
    setup: { state: 'WAIT', since: null, reason: 'تهيئة', detail: {} },
    lastCandleTime: null,
    updatedAt: null
  };
}

/** تسجيل حدث (مقيد السقف) */
function logEvent(st, ev) {
  st.events.push({
    at: ev.at ?? Date.now(),
    tf: st.tf,
    symbol: st.symbol,
    type: ev.type,
    elementId: ev.elementId ?? null,
    prevState: ev.prevState ?? null,
    newState: ev.newState ?? null,
    reason: ev.reason ?? '',
    evidence: ev.evidence ?? null
  });
  if (st.events.length > MAX_EVENTS_PER_KEY) {
    st.events.splice(0, st.events.length - MAX_EVENTS_PER_KEY);
  }
}

function link(st, from, to, rel, at) {
  st.links.push({ from, to, rel, at });
  if (st.links.length > MAX_EVENTS_PER_KEY) {
    st.links.splice(0, st.links.length - MAX_EVENTS_PER_KEY);
  }
}

/** إنشاء أو جلب عنصر (لا حذف للقديم عند ظهور الجديد — كل هوية مستقلة) */
function ensureElement(st, { kind, level, anchorTime, anchorIndex, source, at }) {
  const id = elementId(st.symbol, st.tf, kind, anchorTime, level);
  let el = st.elements.get(id);
  if (!el) {
    el = {
      id, kind,
      level: Number(level),
      anchorTime: Number(anchorTime) || null,
      anchorIndex: anchorIndex ?? null,
      state: 'created',
      taken: false,          // هل فُتحت عليه فرصة؟
      broken: false,
      interactions: [],      // {kind, at, price}
      history: [{ at, state: 'created', reason: source ?? 'رصد النواة' }],
      createdAt: at,
      updatedAt: at,
      feedback: []           // تصحيحات بشرية (تعليق فقط — لا تغيّر القواعد)
    };
    st.elements.set(id, el);
    st.order.push(id);
    // إخلاء: الأقدم resolved/invalidated أولاً — الفعال لا يُمس
    while (st.order.length > MAX_ELEMENTS_PER_KEY) {
      const victim = st.order.find(
        (cid) => ['resolved', 'invalidated'].includes(st.elements.get(cid)?.state)
      ) ?? null;
      if (!victim) break;
      st.elements.delete(victim);
      st.order.splice(st.order.indexOf(victim), 1);
    }
    logEvent(st, { at, type: `${kind}_created`, elementId: id, newState: 'created', reason: source ?? 'رصد النواة', evidence: { level } });
  }
  return el;
}

function transition(st, el, newState, { at, reason, evidence } = {}) {
  if (el.state === newState) return false;
  const prev = el.state;
  el.state = newState;
  el.updatedAt = at;
  el.history.push({ at, state: newState, reason: reason ?? '' });
  logEvent(st, { at, type: 'element_transition', elementId: el.id, prevState: prev, newState, reason: reason ?? '', evidence: evidence ?? null });
  return true;
}

function interact(st, el, kind, { at, price }) {
  const last = el.interactions[el.interactions.length - 1];
  if (last && last.kind === kind && last.at === at) return;
  el.interactions.push({ kind, at, price });
  if (el.interactions.length > 40) el.interactions.splice(0, el.interactions.length - 40);
  logEvent(st, { at, type: 'price_interaction', elementId: el.id, reason: kind, evidence: { price } });
}

/** تصنيف تفاعل آخر شمعة مع مستوى */
function classifyTouch(candle, level, atr) {
  const h = Number(candle.high), l = Number(candle.low);
  const close = Number(candle.close);
  if (![h, l, close].every(Number.isFinite) || !Number.isFinite(level)) return null;
  const tol = Math.max(Number(atr) || 0, 1e-12) * 0.15;
  const dist = Math.min(Math.abs(h - level), Math.abs(l - level));
  const touched = (l <= level && level <= h);
  if (!touched) {
    return dist <= tol * 4 ? 'approached' : (Math.abs(close - level) > (Number(atr) || 0) * 3 ? 'movedAway' : null);
  }
  // داخل النطاق: تمييز الذيل عن الإغلاق
  const wickAbove = h > level && close <= level;
  const wickBelow = l < level && close >= level;
  if (wickAbove || wickBelow) return 'wickedThrough';
  if ((close > level && candle.open <= level) || (close < level && candle.open >= level)) return 'closedThrough';
  return 'touched';
}

function setSetup(st, state, { at, reason, detail }) {
  if (st.setup.state === state && !reason) return false;
  const prev = st.setup.state;
  st.setup = { state, since: at, reason: reason ?? '', detail: detail ?? {} };
  logEvent(st, { at, type: 'setup_transition', prevState: prev, newState: state, reason: reason ?? '', evidence: detail ?? null });
  return true;
}

/**
 * التحديث التدريجي: الحالة السابقة + الشموع الجديدة/التحليل الجديد = حالة محدثة.
 * analysis: مخرج analyzeCandles كما هو (لا يعيد حسابه هنا).
 * dirState: مخرج computeDirectionState الاختياري (للموت/المرحلة).
 * outcome: من loop عند النشر/الحسم {kind:'published'|'resolved', ...} — اختياري.
 */
export function updateCsse(prevState, { symbol, tf, candles, analysis, dirState = null, outcome = null, now = Date.now() } = {}) {
  const st = prevState ?? createCsseState(symbol, tf);
  const at = Number(now) || Date.now();
  const last = Array.isArray(candles) && candles.length ? candles[candles.length - 1] : null;
  const candleTime = last ? Number(last.timeMs ?? last.time * 1000) : null;
  const isNewCandle = candleTime != null && candleTime !== st.lastCandleTime;
  if (candleTime != null) st.lastCandleTime = candleTime;
  st.updatedAt = at;

  // تحديث بالنتيجة فقط (نشر/حسم من loop) بلا تحليل جديد
  if (!analysis) {
    if (outcome && (outcome.kind === 'published' || outcome.kind === 'resolved')) {
      const at0 = Number(now) || Date.now();
      if (outcome.kind === 'published') {
        setSetup(st, 'OPPORTUNITY', { at: at0, reason: 'نُشرت فرصة', detail: { id: outcome.id ?? null } });
        for (const el of st.elements.values()) {
          if (el.kind === 'SSL' && el.state === 'swept') el.taken = true;
        }
      } else {
        setSetup(st, 'RESOLVED', { at: at0, reason: `حُسمت: ${outcome.outcome}`, detail: { outcome: outcome.outcome } });
        for (const el of st.elements.values()) {
          if (el.taken && ['swept', 'confirmed', 'tested', 'active'].includes(el.state)) {
            transition(st, el, 'resolved', { at: at0, reason: `حسم الفرصة: ${outcome.outcome}` });
          }
        }
      }
      st.updatedAt = at0;
    }
    return st;
  }
  const atrV = Number(analysis.atr) || 0;
  const price = Number(analysis.price);

  // 1) القمم/القيعان المحمية المكتملة (هويات مستقرة بزمن التكوين)
  for (const [kind, obj, label] of [
    ['PH', analysis.protectedHigh, 'قمة محمية'],
    ['PL', analysis.protectedLow, 'قاع محمية']
  ]) {
    if (obj && Number.isFinite(Number(obj.level)) && obj.at != null) {
      const el = ensureElement(st, {
        kind, level: Number(obj.level), anchorTime: Number(obj.at),
        source: `${label} مكتملة بخطواتها`, at
      });
      if (el.state === 'created') transition(st, el, 'active', { at, reason: 'اكتمال الخطوات' });
      if (obj.steps) link(st, el.id, el.id, 'steps', at);
    }
  }

  // 2) سيولة داخلية مفتوحة (BSL/SSL) — تُسجَّل ولا تُحذف عند ظهور غيرها
  const internal = analysis.internal ?? {};
  for (const z of [...(internal.openBsl ?? []), ...(internal.openSsl ?? [])]) {
    const kind = String(z.kind ?? '').toLowerCase().includes('ssl') ? 'SSL' : 'BSL';
    if (!Number.isFinite(Number(z.level))) continue;
    const el = ensureElement(st, {
      kind, level: Number(z.level), anchorTime: Number(z.time ?? z.i ?? 0),
      anchorIndex: z.i ?? null, source: `سيولة داخلية ${kind}`, at
    });
    if (el.state === 'created') transition(st, el, 'active', { at, reason: 'رصدت مفتوحة' });
    if (z.state === 'swept' && el.state !== 'swept' && !el.taken) {
      transition(st, el, 'swept', { at, reason: 'سويب مسجل في النواة', evidence: { level: z.level } });
    }
    if (z.state === 'broken' && !el.broken) {
      el.broken = true;
      transition(st, el, 'broken', { at, reason: 'كسر مسجل في النواة' });
    }
  }

  // 3) تفاعلات آخر شمعة مع العناصر الفعالة (تقارب/لمس/ذيل/إغلاق/ابتعاد)
  if (last && (isNewCandle || true)) {
    for (const el of st.elements.values()) {
      if (['invalidated', 'resolved'].includes(el.state)) continue;
      const kind = classifyTouch(last, el.level, atrV);
      if (!kind) continue;
      interact(st, el, kind, { at, price: Number(last.close) });
      if (el.state === 'active' && ['touched', 'wickedThrough', 'closedThrough'].includes(kind)) {
        transition(st, el, 'tested', { at, reason: `تفاعل: ${kind}` });
      }
      // سويب/كسر من التفاعل (مكمل لإشارة النواة — لا يخترع قواعد، نفس تعريفاتها)
      if (el.kind === 'SSL' && kind === 'wickedThrough' && el.state !== 'swept') {
        transition(st, el, 'swept', { at, reason: 'ذيل تحت SSL وإغلاق فوقه' });
      }
      if (el.kind === 'BSL' && kind === 'wickedThrough' && el.state !== 'swept') {
        transition(st, el, 'swept', { at, reason: 'ذيل فوق BSL وإغلاق تحته' });
      }
    }
  }

  // 4) الإشارة/الفشل من التدفق (نفس حقول النواة — بلا إعادة تفسير)
  const flow = analysis.flow ?? {};
  const signal = flow.signal ?? null;
  const invalid = flow.invalid ?? null;
  if (signal) {
    const sigId = elementId(st.symbol, st.tf, 'SETUP', Number(signal.at) || at, Number(signal.entry));
    let sel = st.elements.get(sigId);
    if (!sel) {
      sel = ensureElement(st, {
        kind: 'SETUP', level: Number(signal.entry), anchorTime: Number(signal.at) || at,
        source: `إشارة نموذج ${signal.model}`, at
      });
    }
    transition(st, sel, 'confirmed', { at, reason: `نموذج ${signal.model} — ${flow.phase ?? ''}`, evidence: { entry: signal.entry, stop: signal.stop, tp1: signal.tp1, tp2: signal.tp2 ?? null, rr: signal.rr } });
    // ربط الإشارة بعناصرها: الديسكاونت + السويب + القمة المحمية
    for (const el of st.elements.values()) {
      if (el.kind === 'SSL' && el.state === 'swept' && !el.taken) {
        link(st, el.id, sel.id, 'swept_before_signal', at);
      }
    }
    if (analysis.protectedHigh) {
      const phId = elementId(st.symbol, st.tf, 'PH', Number(analysis.protectedHigh.at), Number(analysis.protectedHigh.level));
      if (st.elements.has(phId)) link(st, phId, sel.id, 'choch_source', at);
    }
    // الأهداف كعناصر مستقلة
    for (const [tk, tv] of [['TP1', signal.tp1], ['TP2', signal.tp2]]) {
      if (Number.isFinite(Number(tv))) {
        const t = ensureElement(st, { kind: tk, level: Number(tv), anchorTime: Number(signal.at) || at, source: `هدف ${tk}`, at });
        link(st, sel.id, t.id, 'targets', at);
      }
    }
    setSetup(st, 'CONFIRMED', { at, reason: flow.phase ?? 'إشارة مؤكدة', detail: { model: signal.model, rr: signal.rr } });
  } else if (invalid) {
    setSetup(st, 'INVALIDATED', { at, reason: invalid.reason ?? 'فشل نقطة الدخول', detail: { at: invalid.at ?? null } });
    logEvent(st, { at, type: 'entry_failure', reason: invalid.reason ?? '', evidence: { at: invalid.at ?? null } });
  } else if (analysis.upLegDead) {
    setSetup(st, 'INVALIDATED', { at, reason: 'موت المشوار الصاعد — بلوغ العرض الخارجي', detail: { htf: analysis.htf?.direction ?? null } });
  } else if (flow.phase) {
    // مراحل الانتظار: WATCH (بلا قمة محمية) / ARMED (choch تم — بانتظار الديسكاونت/التأكيد)
    const hasPH = Boolean(analysis.protectedHigh);
    const armed = /الديسكاونت|نموذج|ssl|تأكيد/i.test(String(flow.phase));
    setSetup(st, hasPH && armed ? 'ARMED' : hasPH ? 'WATCH' : 'WAIT', {
      at, reason: flow.phase, detail: { waiting: flow.waiting ?? {}, phaseDetail: flow.phaseDetail ?? null }
    });
  }

  // 5) اتجاه HTF كموت/سياق (لا يعيد حسابه — يوثقه فقط عند التغير)
  if (dirState) {
    if (dirState.dead && st.setup.state !== 'INVALIDATED') {
      setSetup(st, 'INVALIDATED', { at, reason: 'موت المشوار من سجل الاتجاهات', detail: { dir: dirState.dir ?? null } });
    }
    const dirKey = `${dirState.dir ?? '?'}|${dirState.agreement ?? '?'}|${Boolean(dirState.dead)}`;
    if (st._lastDirKey !== dirKey) {
      st._lastDirKey = dirKey;
      logEvent(st, { at, type: 'direction_context', reason: `HTF=${dirState.dir ?? '؟'} توافق=${dirState.agreement ?? '؟'}`, evidence: { dir: dirState.dir ?? null, agreement: dirState.agreement ?? null, dead: Boolean(dirState.dead) } });
    }
  }

  // 6) نتائج loop (نشر/حسم) — ترفع الإعداد وتوسم العناصر مأخوذة/محسومة
  if (outcome && outcome.kind === 'published' && outcome.signal) {
    setSetup(st, 'OPPORTUNITY', { at, reason: `نُشرت فرصة نموذج ${outcome.signal.model}`, detail: { id: outcome.id ?? null } });
    for (const el of st.elements.values()) {
      if (el.kind === 'SSL' && el.state === 'swept') el.taken = true;
    }
  }
  if (outcome && outcome.kind === 'resolved') {
    setSetup(st, 'RESOLVED', { at, reason: `حُسمت: ${outcome.outcome}`, detail: { outcome: outcome.outcome, price: outcome.price ?? null } });
    for (const el of st.elements.values()) {
      if (el.taken && ['swept', 'confirmed', 'tested', 'active'].includes(el.state)) {
        transition(st, el, 'resolved', { at, reason: `حسم الفرصة: ${outcome.outcome}` });
      }
    }
  }

  void price;
  return st;
}

/** قائمة التسلسل: ماذا تحقق وماذا لم يتحقق بعد (من حقول النواة نفسها) */
export function sequenceChecklist(analysis) {
  const flow = analysis?.flow ?? {};
  const pd = flow.phaseDetail ?? {};
  const waiting = flow.waiting ?? {};
  const items = [];
  const push = (key, label, status, opts = {}) => items.push({
    key, label, status, required: opts.required ?? true, detail: opts.detail ?? null
  });
  const hasPH = Boolean(analysis?.protectedHigh);
  push('protectedHigh', 'قمة محمية مكتملة', hasPH ? 'occurred' : 'not-yet', { required: true });
  const chochDone = /choch/i.test(String(flow.phase ?? '')) || pd.model1Progress || pd.model2Progress || Boolean(flow.signal);
  push('chochUp', 'اختراق القمة (choch up)', chochDone ? 'occurred' : (hasPH ? 'not-yet' : 'skipped'), { required: true });
  const discReached = pd.discountLevel != null || waiting.discountLevel != null || chochDone === true && false;
  const discFromWaiting = waiting.discountLevel != null;
  push('discount', 'بلوغ الديسكاونت (إلزامي)', (discReached || discFromWaiting || pd.model1Progress || pd.model2Progress || flow.signal) ? 'occurred' : (chochDone ? 'not-yet' : 'skipped'), { required: true });
  const sslNeed = pd.needSsl === true;
  const sslDone = pd.model1Progress === true || waiting.sslLevels != null || Boolean(flow.signal);
  push('sslSweep', sslNeed ? 'سويب ssl (مشروط — سبقه تعدي bsl)' : 'سويب ssl', sslDone ? 'occurred' : (chochDone ? 'not-yet' : 'skipped'), { required: sslNeed || chochDone });
  push('confirm1', 'تأكيد نموذج 1 (choch داخلي)', pd.internalChochUp ? 'occurred' : 'not-yet', { required: false });
  push('confirm2', 'تأكيد نموذج 2 (ابتلاع شرائي)', (pd.bullishPair || pd.bullishEngulf) ? 'occurred' : 'not-yet', { required: false });
  if (flow.invalid) push('failed', `فشل: ${flow.invalid.reason ?? ''}`, 'failed', { required: false });
  if (analysis?.upLegDead) push('legDead', 'موت المشوار', 'failed', { required: false });
  return items;
}

/** تسلسل إلى نص مدمج للواجهة */
export function checklistSummary(items) {
  const sym = { occurred: '✓', 'not-yet': '…', failed: '✗', skipped: '–' };
  return (items ?? []).map(i => `${sym[i.status] ?? '?'} ${i.label}`).join(' · ');
}

/** إرفاق تصحيح بشري (تعليق قابل للعكس — لا يمس القواعد) */
export function attachFeedback(st, { elementId: eid, verdict, reason, at = Date.now(), id = null }) {
  const el = st.elements.get(eid);
  const fb = { id: id ?? `fb-${at}`, verdict, reason: String(reason ?? ''), at, revoked: false };
  if (!el) {
    logEvent(st, { at, type: 'feedback_orphan', elementId: eid, reason: fb.reason });
    return fb;
  }
  el.feedback.push(fb);
  logEvent(st, { at, type: 'feedback', elementId: eid, reason: `${verdict}: ${fb.reason}` });
  return fb;
}

/** تسلسل الأحداث لعنصر (الأحدث أولاً) */
export function elementStory(st, eid) {
  const el = st.elements.get(eid);
  if (!el) return null;
  return {
    element: { id: el.id, kind: el.kind, level: el.level, state: el.state, taken: el.taken, createdAt: el.createdAt },
    history: [...el.history].reverse(),
    interactions: [...el.interactions].reverse(),
    feedback: el.feedback,
    related: st.links.filter(l => l.from === eid || l.to === eid)
  };
}

/** تسلسل إلى JSON قابل للتخزين/العرض (Maps → arrays) */
export function serializeCsse(st) {
  return {
    version: st.version,
    symbol: st.symbol,
    tf: st.tf,
    setup: st.setup,
    lastCandleTime: st.lastCandleTime,
    updatedAt: st.updatedAt,
    elements: [...st.elements.values()].map(e => ({ ...e, interactions: e.interactions.slice(-10), history: e.history.slice(-12) })),
    events: st.events.slice(-80),
    links: st.links.slice(-80)
  };
}
