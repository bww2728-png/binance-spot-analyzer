/* ============================================================
   محرك استخراج الحقائق من بيانات المشروع — حتمي نقي بلا شبكة
   ------------------------------------------------------------
   المدخل: بيانات CoinGecko المهيكلة (تصنيفات رسمية + وصف رسمي)
   والنص المستخرج من الموقع الرسمي اختيارياً.
   المخرج: لكل حقيقة من الحقائق الثمانية { value, confidence, source }.
   لا استنتاج ذكاء اصطناعي ولا تخمين — قواعد معلنة قابلة للاختبار،
   وكل حقيقة تحت عتبة الثقة تُهمل (تبقى null) قبل التقييم والحفظ.
   ============================================================ */

export const CONFIDENCE_THRESHOLD = 0.85;

export const FACT_KEYS = [
  'has_utility', 'is_memecoin', 'has_lending_interest', 'has_fixed_yield',
  'linked_haram_activity', 'is_asset_backed', 'pure_speculation', 'privacy_concern'
];

const fact = (value, confidence, source) => ({ value, confidence, source });
const unknown = () => ({ value: null, confidence: 0, source: '' });

/** تصنيفات جدية تدل على منفعة حقيقية (بلا تصنيفات «المنظومة» العامة المفتوحة على الجميع) */
const SERIOUS_CATEGORIES = [
  'smart contract platform', 'layer 1', 'layer 2', 'layer-1', 'layer-2',
  'oracle', 'infrastructure', 'decentralized storage', 'storage',
  'depin', 'rwa', 'real world assets', 'real-world assets',
  'gaming', 'gamefi', 'metaverse', 'nft', 'launchpad', 'exchange',
  'wallet', 'dao', 'governance', 'payments', 'interoperability',
  'scaling', 'rollup', 'data availability', 'zk rollup', 'optimistic rollup',
  'artificial intelligence', 'ai agents', 'compute network', 'insurance'
];

/** عناصر تُبطل شبهة الخصوصية: بنية تحتية معلنة لا أدوات إخفاء هوية */
const INFRA_CATEGORIES = [
  'smart contract platform', 'layer 2', 'layer-2', 'rollup', 'zk rollup',
  'scaling', 'oracle', 'infrastructure', 'data availability'
];

const listHas = (list, ...needles) => needles.some(n => list.some(c => c.includes(n)));

/**
 * يستخرج الحقائق الثمانية من بيانات المشروع.
 * @param {{ categories?: string[], description?: string, name?: string }} gecko
 * @param {string} homepageText نص الموقع الرسمي (اختياري)
 */
export function extractFacts(gecko, homepageText = '') {
  const categories = (gecko?.categories ?? []).map(c => String(c).toLowerCase());
  const desc = String(gecko?.description ?? '').toLowerCase();
  const web = String(homepageText ?? '').toLowerCase();
  const hay = desc + '\n' + web;

  const F = {};
  for (const k of FACT_KEYS) F[k] = unknown();

  /* ---- 1) التصنيفات الرسمية — ثقة عالية ---- */
  if (listHas(categories, 'meme')) {
    F.is_memecoin = fact(true, 0.95, 'تصنيف CoinGecko الرسمي: Meme');
    F.pure_speculation = fact(true, 0.9, 'تصنيف Meme — القيمة من الانتشار والمضاربة');
  }
  if (listHas(categories, 'privacy')) {
    F.privacy_concern = fact(true, 0.95, 'تصنيف CoinGecko الرسمي: Privacy');
  }
  if (listHas(categories, 'stablecoin')) {
    if (/algorithmic|yield[- ]bearing|synthetic dollar|basis cash|empty set/.test(hay)) {
      F.has_fixed_yield = fact(true, 0.85, 'عملة مستقرة خوارزمية/بعائد وفق الوصف الرسمي');
      F.is_asset_backed = fact(true, 0.7, 'تصنيف Stablecoin (تغطية غير مؤكدة)');
    } else if (/backed by|reserves|collateral|proof of reserves|treasury/.test(hay)) {
      F.is_asset_backed = fact(true, 0.9, 'تصنيف Stablecoin + وصف التغطية الرسمي');
    } else {
      F.is_asset_backed = fact(true, 0.75, 'تصنيف CoinGecko الرسمي: Stablecoin');
    }
  }
  if (listHas(categories, 'liquid staking', 'staking')) {
    F.has_fixed_yield = fact(true, 0.9, 'تصنيف CoinGecko الرسمي: Staking');
  }
  if (listHas(categories, 'lending', 'cdp')) {
    F.has_lending_interest = fact(true, 0.9, 'تصنيف CoinGecko الرسمي: Lending/CDP');
  }

  /* ---- 2) الكلمات المفتاحية من الوصف الرسمي والموقع — ثقة متوسطة/عالية ---- */
  const kw = (re, key, conf, source, guard) => {
    if (F[key].value !== null) return;
    if (guard && guard()) return;
    if (re.test(hay)) F[key] = fact(true, conf, source);
  };

  kw(
    /\b(gambling|casino|betting|lottery)\b/,
    'linked_haram_activity', 0.9, 'ذكر أنشطة قمار في المواد الرسمية للمشروع'
  );
  kw(
    /\b(lending|borrowing|loans?)\b.{0,120}\b(interest|apy|yield)\b|\b(interest|apy)\b.{0,120}\b(lending|borrowing|loans?)\b/,
    'has_lending_interest', 0.85, 'كلمات رسمية: إقراض بعائد فائدة'
  );
  kw(
    /\b(ring signature|stealth address|untraceable|anonymous transactions)\b/,
    'privacy_concern', 0.8, 'وصف رسمي: أدوات إخفاء هوية المعاملات',
    () => listHas(categories, ...INFRA_CATEGORIES)
  );
  kw(
    /\b(algorithmic|synthetic)\b.{0,60}\bstable|\byield[- ]bearing\b/,
    'has_fixed_yield', 0.8, 'وصف رسمي: أصل بعائد/مستقرة خوارزمية'
  );
  kw(
    /\b(backed by|proof of reserves|fully collateralized)\b/,
    'is_asset_backed', 0.85, 'وصف رسمي: مغطاة بأصل أو ضمانات'
  );

  /* ---- 3) المنفعة: من التصنيفات الجدية فقط — الغياب ليس دليل منفعة ولا دليل عدمها ---- */
  const seriousHits = categories.filter(c => SERIOUS_CATEGORIES.some(s => c.includes(s)));
  if (F.is_memecoin.value === true && seriousHits.length === 0) {
    F.has_utility = fact(false, 0.8, 'تصنيف Meme بلا أي تصنيف منفعة جادة');
  } else if (seriousHits.length > 0) {
    F.has_utility = fact(true, 0.85, 'تصنيفات CoinGecko الجدية: ' + seriousHits.slice(0, 3).join('، '));
  }

  return F;
}

/**
 * بوابة الثقة: يحذف أي حقيقة تحت العتبة قبل التقييم والحفظ — لا تخمين.
 * @returns حقيقة متوافقة مع ShariahFacts (boolean|null)
 */
export function verdictGate(facts, threshold = CONFIDENCE_THRESHOLD) {
  const out = {};
  for (const k of FACT_KEYS) {
    const f = facts?.[k];
    out[k] = f && f.value !== null && f.confidence >= threshold ? f.value : null;
  }
  return out;
}

/** أدنى ثقة بين الحقائق المحسومة (0 إن لم يُحسم شيء) */
export function researchConfidence(facts) {
  const resolved = FACT_KEYS.map(k => facts?.[k]).filter(f => f && f.value !== null);
  if (!resolved.length) return 0;
  return Math.round(Math.min(...resolved.map(f => f.confidence)) * 100) / 100;
}

/** ملخص القراءة: عدد الحقائق المحسومة قبل/بعد البوابة */
export function researchSummary(facts, gated) {
  const resolvedRaw = FACT_KEYS.filter(k => facts?.[k]?.value !== null).length;
  const resolvedGated = FACT_KEYS.filter(k => gated?.[k] !== null).length;
  return { resolvedRaw, resolvedGated };
}
