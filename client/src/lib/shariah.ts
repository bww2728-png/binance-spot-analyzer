/* ============================================================
   طبقة التصنيف الشرعي — أداة فرز استرشادية (Screening Aid)
   ------------------------------------------------------------
   تنبيه شرعي: هذا المحرك أداة فرز موضوعية تستند إلى حقائق مكتوبة
   عن كل مشروع، وليس فتوى. الحكم الشرعي النهائي لأهل العلم،
   والنصوص المذكورة مثبتة بمراجعها من المصادر المعتمدة.
   لا تُضف نصاً شرعياً هنا إلا إذا تحققت من نصه ومرجعه.
   ============================================================ */

export type ShariahVerdict = 'halal' | 'haram' | 'uncertain';
export type EvidenceType = 'quran' | 'hadith' | 'principle';

export interface EvidenceItem {
  id: string;
  type: EvidenceType;
  /** النص الشرعي الكامل */
  text: string;
  /** المرجع: سورة:آية أو الراوي/الكتاب/الرقم */
  ref: string;
  /** درجة الصحة */
  grade: string;
  topic: 'riba' | 'maysir' | 'gharar' | 'trade' | 'general';
}

/** نسخة مختزنة من الدليل (بلا topic لتوافق الصف المخزن) */
export type StoredEvidence = Omit<EvidenceItem, 'topic'>;

/* ============ قاعدة الأدلة المُراجَعة (لا تضف إلا المثبت) ============ */

export const EVIDENCE: EvidenceItem[] = [
  {
    id: 'q-baqarah-275',
    type: 'quran',
    text: 'وَأَحَلَّ اللَّهُ الْبَيْعَ وَحَرَّمَ الرِّبَا',
    ref: 'البقرة 275',
    grade: 'نص قطعي الثبوت',
    topic: 'riba'
  },
  {
    id: 'q-baqarah-278',
    type: 'quran',
    text: 'يَا أَيُّهَا الَّذِينَ آمَنُوا اتَّقُوا اللَّهَ وَذَرُوا مَا بَقِيَ مِنَ الرِّبَا إِنْ كُنْتُمْ مُؤْمِنِينَ',
    ref: 'البقرة 278',
    grade: 'نص قطعي الثبوت',
    topic: 'riba'
  },
  {
    id: 'q-baqarah-279',
    type: 'quran',
    text: 'فَإِنْ لَمْ تَفْعَلُوا فَأْذَنُوا بِحَرْبٍ مِنَ اللَّهِ وَرَسُولِهِ',
    ref: 'البقرة 279',
    grade: 'نص قطعي الثبوت',
    topic: 'riba'
  },
  {
    id: 'q-maidah-90',
    type: 'quran',
    text: 'يَا أَيُّهَا الَّذِينَ آمَنُوا إِنَّمَا الْخَمْرُ وَالْمَيْسِرُ وَالْأَنْصَابُ وَالْأَزْلَامُ رِجْسٌ مِنْ عَمَلِ الشَّيْطَانِ فَاجْتَنِبُوهُ لَعَلَّكُمْ تُفْلِحُونَ',
    ref: 'المائدة 90',
    grade: 'نص قطعي الثبوت',
    topic: 'maysir'
  },
  {
    id: 'q-nisa-29',
    type: 'quran',
    text: 'يَا أَيُّهَا الَّذِينَ آمَنُوا لَا تَأْكُلُوا أَمْوَالَكُمْ بَيْنَكُمْ بِالْبَاطِلِ إِلَّا أَنْ تَكُونَ تِجَارَةً عَنْ تَرَاضٍ مِنْكُمْ',
    ref: 'النساء 29',
    grade: 'نص قطعي الثبوت',
    topic: 'trade'
  },
  {
    id: 'q-baqarah-168',
    type: 'quran',
    text: 'يَا أَيُّهَا النَّاسُ كُلُوا مِمَّا فِي الْأَرْضِ حَلَالًا طَيِّبًا',
    ref: 'البقرة 168',
    grade: 'نص قطعي الثبوت',
    topic: 'general'
  },
  {
    id: 'q-rum-39',
    type: 'quran',
    text: 'وَمَا آتَيْتُمْ مِنْ رِبًا لِيَرْبُوَ فِي أَمْوَالِ النَّاسِ فَلَا يَرْبُو عِنْدَ اللَّهِ',
    ref: 'الروم 39',
    grade: 'نص قطعي الثبوت',
    topic: 'riba'
  },
  {
    id: 'h-muslim-1587',
    type: 'hadith',
    text: 'الذَّهَبُ بِالذَّهَبِ مِثْلًا بِمِثْلٍ، وَالْفِضَّةُ بِالْفِضَّةِ مِثْلًا بِمِثْلٍ، وَالتَّمْرُ بِالتَّمْرِ مِثْلًا بِمِثْلٍ، وَالْبُرُّ بِالْبُرِّ مِثْلًا بِمِثْلٍ، وَالشَّعِيرُ بِالشَّعِيرِ مِثْلًا بِمِثْلٍ، وَالْمِلْحُ بِالْمِلْحِ مِثْلًا بِمِثْلٍ، فَمَنْ زَادَ أَوِ ازْدَادَ فَقَدْ أَرْبَى',
    ref: 'رواه مسلم (1587) عن عبادة بن الصامت',
    grade: 'صحيح',
    topic: 'riba'
  },
  {
    id: 'h-muslim-1598',
    type: 'hadith',
    text: 'لَعَنَ رَسُولُ اللَّهِ ﷺ آكِلَ الرِّبَا وَمُوَكِّلَهُ وَكَاتِبَهُ وَشَاهِدَيْهِ',
    ref: 'رواه مسلم (1598) عن جابر',
    grade: 'صحيح',
    topic: 'riba'
  },
  {
    id: 'h-bukhari-2766',
    type: 'hadith',
    text: 'اجْتَنِبُوا السَّبْعَ الْمُوبِقَاتِ... وَأَكْلُ الرِّبَا',
    ref: 'متفق عليه: البخاري (2766) ومسلم (89) عن أبي هريرة',
    grade: 'صحيح متفق عليه',
    topic: 'riba'
  },
  {
    id: 'h-muslim-1513',
    type: 'hadith',
    text: 'نَهَى رَسُولُ اللَّهِ ﷺ عَنْ بَيْعِ الْغَرَرِ',
    ref: 'رواه مسلم (1513) عن أبي هريرة',
    grade: 'صحيح',
    topic: 'gharar'
  },
  {
    id: 'h-tirmidhi-1232',
    type: 'hadith',
    text: 'لَا تَبِعْ مَا لَيْسَ عِنْدَكَ',
    ref: 'رواه الترمذي (1232) وأبو داود (3503) عن حكيم بن حزام — حسّنه الترمذي وصححه الألباني',
    grade: 'حسن صحيح',
    topic: 'gharar'
  },
  {
    id: 'h-tirmidhi-2518',
    type: 'hadith',
    text: 'دَعْ مَا يُرِيبُكَ إِلَى مَا لَا يُرِيبُكَ',
    ref: 'رواه الترمذي (2518) والنسائي — صححه الترمذي وحسّنه الألباني',
    grade: 'حسن صحيح',
    topic: 'gharar'
  },
  {
    id: 'h-bukhari-2079',
    type: 'hadith',
    text: 'الْبَيِّعَانِ بِالْخِيَارِ مَا لَمْ يَتَفَرَّقَا',
    ref: 'متفق عليه: البخاري (2079) ومسلم (1531) عن ابن عمر',
    grade: 'صحيح متفق عليه',
    topic: 'trade'
  },
  {
    id: 'q-maidah-2',
    type: 'quran',
    text: 'وَتَعَاوَنُوا عَلَى الْبِرِّ وَالتَّقْوَىٰ ۖ وَلَا تَعَاوَنُوا عَلَى الْإِثْمِ وَالْعُدْوَانِ',
    ref: 'المائدة 2',
    grade: 'نص قطعي الثبوت',
    topic: 'general'
  },
  {
    id: 'h-tirmidhi-1726',
    type: 'hadith',
    text: 'الْحَلَالُ مَا أَحَلَّ اللَّهُ فِي كِتَابِهِ، وَالْحَرَامُ مَا حَرَّمَ اللَّهُ فِي كِتَابِهِ',
    ref: 'رواه الترمذي (1726) عن سلمان الفارسي — قال الألباني: حسن صحيح',
    grade: 'حسن صحيح',
    topic: 'general'
  }
];

/* ============ المعايير: حقائق سؤال عنها لكل عملة ============ */

export interface ShariahFacts {
  /** هل للمشروع منفعة/استخدام حقيقي واضح؟ */
  has_utility: boolean | null;
  /** هل هي عملة ميم بلا منفعة جوهرية تعتمد على الانتشار؟ */
  is_memecoin: boolean | null;
  /** هل تقدم قروضاً/إقراضاً بعائد فائدة (lending protocol)؟ */
  has_lending_interest: boolean | null;
  /** هل تقدم عائداً مضموناً ثابتاً (staking المضمون/حصص ثابتة)؟ */
  has_fixed_yield: boolean | null;
  /** هل سبق تورطها في أنشطة محرمة (قمار/مقامرة/أدوات رافعة)؟ */
  linked_haram_activity: boolean | null;
  /** هل هي عملة مستقرة مدعومة بأصل حقيقي (stablecoin مغطاة)؟ */
  is_asset_backed: boolean | null;
  /** هل عالية الغرر/المضاربة الخالصة بلا قيمة جوهرية؟ */
  pure_speculation: boolean | null;
  /** هل خصوصية/إخفاء يتيح التمويه للمحرمات؟ */
  privacy_concern: boolean | null;
}

export interface CriterionHit {
  id: string;
  label: string;
  reason: string;
  evidenceIds: string[];
  /** أثر المعيار على الحكم */
  effect: 'haram' | 'halal' | 'uncertain';
  /** قوة الأثر (عدد المعايير الحرام المتراكمة) */
  severity: number;
}

export interface ShariahAssessment {
  verdict: ShariahVerdict;
  /** لماذا؟ جملة موجزة */
  headline: string;
  /** تفصيل الأسباب */
  reasons: string[];
  /** الأدلة المستدل بها (منقوعة من EVIDENCE فقط) */
  evidence: EvidenceItem[];
  hits: CriterionHit[];
  /** هل يوجد خلاف فقهي معروف في المسألة؟ */
  fiqh_dispute: string | null;
  /** تحفظ عام */
  disclaimer: string;
}

/* ============ المحرك الحتمي ============ */

const E = (id: string) => EVIDENCE.find(e => e.id === id)!;

export function evaluateShariah(facts: ShariahFacts, symbol: string): ShariahAssessment {
  const hits: CriterionHit[] = [];
  const reasons: string[] = [];

  // قاعدة الأصل: الإباحة ما لم يوجد محرم
  let verdict: ShariahVerdict = 'halal';
  let fiqh_dispute: string | null = null;
  let headline = 'الأصل في المعاملات الإباحة — لم يُرصد مانع شرعي واضح من البيانات المتاحة، مع بقاء التحقق الواجب.';

  const addHaram = (id: string, label: string, reason: string, evidenceIds: string[], severity: number) => {
    hits.push({ id, label, reason, evidenceIds, effect: 'haram', severity });
    reasons.push(reason);
  };
  const addUncertain = (id: string, label: string, reason: string, evidenceIds: string[]) => {
    hits.push({ id, label, reason, evidenceIds, effect: 'uncertain', severity: 1 });
    reasons.push(reason);
  };

  /* 1) الإقراض بفائدة — ربا صريح */
  if (facts.has_lending_interest === true) {
    addHaram('lending', 'إقراض بفائدة (Lending/Interest)',
      `مشروع ${symbol} يقوم على إقراض العملات مقابل فائدة — وهذا هو عين الربا المنهي عنه، إذ كل قرض جرّ نفعاً فهو ربا.`,
      ['q-baqarah-275', 'q-baqarah-278', 'h-muslim-1598', 'h-muslim-1587'], 3);
  }

  /* 2) عملة ميم بلا منفعة — قمار/ميسر */
  if (facts.is_memecoin === true) {
    addHaram('memecoin', 'عملة ميم بلا منفعة جوهرية',
      `عملة الميم مثل ${symbol} تقوم على المضاربة والانتشار لا على منفعة حقيقية، فيغلب عليها شبه الميسر (المقامرة) والغرر.`,
      ['q-maidah-90', 'h-muslim-1513', 'h-tirmidhi-2518'], 2);
  }

  /* 3) ارتباط بأنشطة محرمة */
  if (facts.linked_haram_activity === true) {
    addHaram('haram-link', 'ارتباط بأنشطة محرمة',
      `ارتبط مشروع ${symbol} بأنشطة محرمة (قمار، رافعة، تمويل محظور) — والتعاون معها محرم شرعاً.`,
      ['q-maidah-2'], 3);
  }

  /* 4) غرر عالٍ/مضاربة خالصة */
  if (facts.pure_speculation === true && verdict === 'halal') {
    addUncertain('speculation', 'مضاربة خالصة/غرر مرتفع',
      `يغلب على ${symbol} الغرر والمضاربة الخالصة بلا قيمة جوهرية، والبيوع الغررية منهي عنها.`,
      ['h-muslim-1513', 'h-tirmidhi-1232', 'h-tirmidhi-2518']);
  }

  /* 5) خصوصية/إخفاء */
  if (facts.privacy_concern === true) {
    addUncertain('privacy', 'طابع الإخفاء والخصوصية',
      `تمنح ${symbol} درجة إخفاء عالية قد تُستخدم في تهريب أموال وأنشطة محرمة، فلا يتحقق غرض الشفافية الشرعية في المعاملات.`,
      ['q-maidah-2', 'h-tirmidhi-2518']);
  }

  /* 6) عائد مضمون ثابت */
  if (facts.has_fixed_yield === true) {
    addUncertain('fixed-yield', 'عائد ثابت مضمون',
      `تقديم عائد مضمون ثابت على الأصل يشبه القرض الربوي عند جمهور الفقهاء (كل قرض جرّ نفعاً فهو ربا)؛ وإن كان محل خلاف فقهي معاصر.`,
      ['q-baqarah-275', 'q-baqarah-278', 'q-rum-39', 'h-tirmidhi-2518']);
    fiqh_dispute = 'خلاف معاصر: بعض المجامع الشرعية (كأماني وأعراف معتمدة) تجيز صيغاً معدّلة للعائد إذا قامت على عقد مضاربة/وكالة حقيقية لا على ضمان رأس المال وفائدة مقطوعة.';
  }

  /* 7) عملة مستقرة مغطاة */
  if (facts.is_asset_backed === true) {
    reasons.push(`${symbol} عملة مستقرة مغطاة بأصل حقيقي — أقرب إلى بدل مالي موضوعي يقلّل الغرر، مع اشتراط التحقق من التغطية الفعلية والشفافية.`);
  }

  /* 8) منفعة حقيقية */
  if (facts.has_utility === true && facts.is_memecoin !== true) {
    reasons.push(`${symbol} ذات منفعة/استخدام حقيقي — داخل دائرة التجارة المباحة التي أحلّها الله.`);
  }

  if (facts.is_asset_backed === true && facts.has_lending_interest !== true && facts.linked_haram_activity !== true) {
    // مغطاة ونظيفة: حلال بضوابط (مع تحفظ التغطية)
    if (verdict === 'halal') headline = `أقرب للحلال بضوابط: ${symbol} عملة مستقرة مغطاة بأصل حقيقي، مع اشتراط التحقق المستمر من التغطية وعدم ربطها بالفائدة.`;
  } else if (facts.has_utility === true && facts.is_memecoin === false && facts.has_lending_interest !== true &&
             facts.linked_haram_activity !== true && facts.pure_speculation !== true && verdict === 'halal') {
    headline = `يحتمل الحلّ: ${symbol} ذات منفعة حقيقية ولا يُرصد مانع شرعي مباشر من البيانات — والحكم النهائي لأهل العلم مع اشتراط التقابض الفوري (سبوت).`;
  }

  /* الحسم النهائي */
  const allUnknown = (Object.values(facts) as (boolean | null)[]).every(v => v === null);
  const maxHaram = hits.filter(h => h.effect === 'haram').reduce((m, h) => Math.max(m, h.severity), 0);
  if (allUnknown && maxHaram === 0) {
    verdict = 'uncertain';
    headline = `لا تتوفر بيانات موثقة عن مشروع ${symbol} — أُوقف اختياره احتياطاً حتى يوثَّق (عند عدم العلم: التوقف و«دَعْ مَا يُرِيبُكَ»)`;
    reasons.push('لا توجد حقائق موثقة عن هذا المشروع في قاعدة معرفة النظام؛ لا يصح الحكم له أو عليه بالتخمين — لذا استُبعد من قائمة الاختيار حتى يُستكمل توثيقه.');
  } else if (maxHaram >= 3) {
    verdict = 'haram';
    headline = `محرّمة على وجه التصريح: تورّط ${symbol} في الربا/المحرمات صريح حسب البيانات المتاحة.`;
  } else if (maxHaram >= 2) {
    verdict = 'haram';
    headline = `يغلب على ${symbol} الحرمة (ميسر/غرر) حسب البيانات المتاحة — والحكم النهائي لأهل العلم.`;
  } else if (hits.some(h => h.effect === 'uncertain')) {
    verdict = 'uncertain';
    headline = `محل شبهة: يوجد في ${symbol} معايير تُوجب الاحتياط (غرر/عائد/خصوصية) — «دَعْ مَا يُرِيبُكَ» والورع مطلوب حتى يتبين الأمر.`;
  } else {
    verdict = 'halal';
    if (!reasons.length) {
      headline = `لا يُرصد مانع ظاهر من البيانات المتاحة لـ ${symbol} — الأصل الإباحة، والحكم النهائي لأهل العلم.`;
    }
  }

  if (verdict === 'halal') {
    reasons.push('تنبيه: الأصل في المعاملات الإباحة، والمحرّم هو الربا والغرر والميسر فقط — ولم يثبت منها ما ينطبق على هذا الأصل حسب البيانات المتاحة.');
  }

  const usedIds = new Set<string>();
  for (const h of hits) for (const id of h.evidenceIds) usedIds.add(id);

  /* دليل الوقف عند عدم العلم */
  if (allUnknown && maxHaram === 0) {
    usedIds.add('h-tirmidhi-2518');
    usedIds.add('h-muslim-1513');
  }

  /* أدلة الإباحة التلقائية للحالات الحلال (أصل البيع والتجارة عن تراض) */
  if (verdict === 'halal') {
    usedIds.add('q-baqarah-275');   // «وأحلَّ الله البيع وحرَّم الربا»
    usedIds.add('q-nisa-29');       // «تجارة عن تراضٍ منكم»
  }

  const evidence = [...usedIds].map(E);

  return {
    verdict,
    headline,
    reasons: dedupe(reasons),
    evidence,
    hits,
    fiqh_dispute,
    disclaimer: 'التصنيف مبني على قاعدة أدلة مثبتة من الكتاب والسنة بقواعد حتمية على حقائق موثقة عن المشروع — والحكم الشرعي النهائي لأهل العلم.'
  };
}

function dedupe(a: string[]): string[] {
  const seen = new Set<string>();
  return a.filter(x => { if (seen.has(x)) return false; seen.add(x); return true; });
}

/* ============ قاعدة معرفة المشاريع (حقائق موثقة، قابلة للتعديل) ============ */
/* الحقائق معلومات عامة معروفة عن المشاريع بتاريخ الإعداد. أي مشروع غير مدرج
   يبقى «للتحقق» ولا يظهر في القائمة — لا تخمين أبداً. */

const F = (p: Partial<ShariahFacts>): ShariahFacts => ({
  has_utility: null, is_memecoin: false, has_lending_interest: false, has_fixed_yield: false,
  linked_haram_activity: false, is_asset_backed: null, pure_speculation: false, privacy_concern: false,
  ...p
});

/** منفعة حقيقية (L1/بنية تحتية/حوسبة/تخزين/شبكات) */
const UTIL = F({ has_utility: true });
/** عملة ميم بلا منفعة — ميسر/غرر */
const MEME = F({ has_utility: false, is_memecoin: true, pure_speculation: true });
/** خصوصية/إخفاء عالٍ */
const PRIV = F({ has_utility: true, privacy_concern: true });
/** منصة إقراض بفائدة — ربا صريح */
const LEND = F({ has_utility: true, has_lending_interest: true });
/** منصة مشتقات/رافعة/عقود — ميسر وغرر عالٍ */
const DERIV = F({ has_utility: true, linked_haram_activity: true });
/** أصل مكتتب بعائد مكدّس (staking/liquid staking) — شبهة عائد */
const STAKED = F({ has_utility: true, has_fixed_yield: true });
/** مغطاة بأصل حقيقي (مستقرة/مغلفة) */
const BACKED = F({ is_asset_backed: true });

export const DEFAULT_FACTS: Record<string, ShariahFacts> = {
  /* L1/L2 وبنية تحتية بمنفعة */
  BTC: UTIL, ETH: UTIL, BNB: UTIL, SOL: UTIL, ADA: UTIL, DOT: UTIL, XRP: UTIL, LTC: UTIL, BCH: UTIL,
  LINK: UTIL, AVAX: UTIL, MATIC: UTIL, POL: UTIL, UNI: UTIL, ATOM: UTIL, ETC: UTIL, FIL: UTIL,
  NEAR: UTIL, ARB: UTIL, OP: UTIL, INJ: UTIL, TON: UTIL, TRX: UTIL, XLM: UTIL, ALGO: UTIL, VET: UTIL,
  HBAR: UTIL, ICP: UTIL, APT: UTIL, SUI: UTIL, ASTR: UTIL, FLOW: UTIL, THETA: UTIL, EGLD: UTIL,
  FTM: UTIL, S: UTIL, SEI: UTIL, TIA: UTIL, DYM: UTIL, STRK: UTIL, ZK: UTIL, MNT: UTIL, KAVA: UTIL,
  CFX: UTIL, ROSE: UTIL, ONE: UTIL, ZIL: UTIL, IOTA: UTIL, KSM: UTIL, AVA: UTIL, CELO: UTIL,
  MINA: UTIL, QNT: UTIL, WLD: UTIL, AR: UTIL, STORJ: UTIL, SKL: UTIL, ANKR: UTIL, GRT: UTIL,
  API3: UTIL, BAND: UTIL, PYTH: UTIL, DIA: UTIL, FLUX: UTIL, CKB: UTIL, DUSK: UTIL, CHR: UTIL,
  W: UTIL, ETHFI: UTIL, EIGEN: UTIL, ALT: UTIL, JUP: UTIL, JTO: UTIL, PYUSDT_BASE: UTIL,

  /* ألعاب/ميتافيرس بمنفعة استخدام */
  SAND: UTIL, MANA: UTIL, ENJ: UTIL, AXS: UTIL, GALA: UTIL, IMX: UTIL, RONIN: UTIL, BIGTIME: UTIL,
  APE: UTIL, BLUR: UTIL, MAGIC: UTIL,

  /* عملات ميم بلا منفعة */
  DOGE: MEME, SHIB: MEME, PEPE: MEME, BONK: MEME, FLOKI: MEME, BOME: MEME, WIF: MEME, TURBO: MEME,
  DOGS: MEME, NEIRO: MEME, POPCAT: MEME, MEW: MEME, PENGU: MEME, TRUMP: MEME, FARTCOIN: MEME,
  '1000CAT': MEME, '1000CHEEMS': MEME, '1000SATS': F({ has_utility: false, is_memecoin: true, pure_speculation: true }),
  '1MBABYDOGE': MEME, BROCCOLI714: MEME, BANANAS31: MEME, ANIME: MEME, ACT: MEME, MOODENG: MEME,
  PNUT: MEME, GOAT: MEME, CHILLGUY: MEME, PWEASE: MEME, TST: MEME, BROCCOLI: MEME, SIREN: MEME,

  /* خصوصية/إخفاء عالٍ */
  XMR: PRIV, DASH: PRIV, ZEC: PRIV, FIRO: PRIV, BEAM: PRIV, SCRT: PRIV,

  /* منصات إقراض بفائدة — ربا */
  AAVE: LEND, COMP: LEND, MKR: LEND, EUL: LEND, XVS: LEND, RDNT: LEND, CRV: LEND, CVX: LEND,
  SPELL: LEND, TWT: UTIL, JUST: LEND, ALPACA: LEND, VENUS: LEND, HIFI: LEND,

  /* منصات مشتقات/رافعة/عقود */
  DYDX: DERIV, GMX: DERIV, SNX: DERIV, AEVO: DERIV, PENDLE: F({ has_utility: true, has_fixed_yield: true }),
  PERP: DERIV, LOOKS: UTIL, GNS: DERIV, VELO: DERIV, ASTER: DERIV, HYPER: DERIV,

  /* أصول مكدّسة بعائد (staking/liquid staking) */
  BNSOL: STAKED, WBETH: STAKED, MSOL: STAKED, JITOSOL: STAKED, RETH: STAKED, STETH: STAKED,
  BABA: STAKED, BBSol: STAKED,

  /* عملات مستقرة/مغلفة مغطاة بأصل */
  USDT: BACKED, USDC: BACKED, FDUSD: BACKED, TUSD: BACKED, DAI: BACKED, FRAX: BACKED, USDP: BACKED,
  PYUSD: BACKED, EUR: BACKED, EURI: BACKED, AEUR: BACKED, XUSD: BACKED, USDE: F({ is_asset_backed: true, has_fixed_yield: true }),
  WBTC: BACKED, CBBTC: BACKED, WBGL: BACKED, PAXG: BACKED, XAUT: BACKED, BFUSD: F({ is_asset_backed: true }),

  /* صناديق أسهم/سلع مسعّرة على السلسلة (توكنات مغطاة) */
  AAPLB: BACKED, AMZNB: BACKED, ASMLB: BACKED, AVGOB: BACKED, COINB: BACKED, CRCLB: BACKED,
  DELLB: BACKED, MSTRB: BACKED, TSLAB: BACKED, NVDAB: BACKED, METAB: BACKED, GOOGLB: BACKED,
  MCDLB: BACKED, ORCLB: BACKED, PAYPALB: BACKED, SPYB: BACKED, QQQB: BACKED, IAU_B: BACKED,

  /* أدوات/بنية أخرى بمنفعة */
  '1INCH': UTIL, C98: UTIL, SUSHI: UTIL, CAKE: UTIL, LDO: UTIL, AERO: UTIL, COW: UTIL, DODO: UTIL,
  ALICE: UTIL, COTI: UTIL, CVC: UTIL, CYBER: UTIL, DEXE: UTIL, DGB: UTIL, EDU: UTIL, ENA: UTIL,
  ENS: UTIL, FET: UTIL, FIDA: UTIL, FIS: UTIL, AUCTION: UTIL, AUDIO: UTIL, HIGH: UTIL,
  LIT: UTIL, MDT: UTIL, NKN: UTIL, OCEAN: UTIL, OGN: UTIL, PROS: UTIL, QI: UTIL,
  RARE: UTIL, RLC: UTIL, RSR: UTIL, SSV: UTIL, SUPER: UTIL, SXP: UTIL, TRU: UTIL, UMA: UTIL,
  UNFI: UTIL, WAVES: UTIL, WOO: UTIL, YFI: UTIL, ZEN: UTIL, ZRX: UTIL,
  BEL: UTIL, BEAMX: UTIL, BICO: UTIL, BNT: UTIL, CELR: UTIL, CTK: UTIL, CTSI: UTIL, EPS: UTIL,
  HOT: UTIL, KEY: UTIL, MTL: UTIL, PHA: UTIL, RAY: UTIL, REEF: UTIL,
  ARKM: UTIL, ARPA: UTIL, ASR: UTIL, ACE: UTIL, ACH: UTIL, ADX: UTIL, ALPINE: UTIL,
  AMB: UTIL, AMP: UTIL, ATS: UTIL, AVNT: UTIL, BAR: UTIL, BAT: UTIL, BB: UTIL,
  BERA: UTIL, BIO: UTIL, BMT: UTIL, BREV: MEME, BSX: UTIL, CATI: UTIL,
  CFG: UTIL, CGPT: UTIL, CHIP: UTIL, CITY: UTIL, COOKIE: UTIL, DOLO: UTIL,
  EDEN: UTIL, ENSO: UTIL, EPIC: UTIL, ERA: UTIL, ESP: UTIL, FF: UTIL,
  FLR: UTIL, FOGO: UTIL, FORM: UTIL, FTN: UTIL, G: UTIL, GHST: UTIL, GLM: UTIL, GMRX: UTIL,
  GNO: UTIL, HIVE: UTIL, HOOK: UTIL, HUMAN: UTIL, ID: UTIL, IL: UTIL, IO: UTIL, KAS: UTIL,
  KDA: UTIL, L3: UTIL, LAZIO: UTIL, LOKA: UTIL, MBOX: UTIL, MEDA: UTIL, MEMEFI: UTIL, MERL: UTIL,
  MOCA: UTIL, MYRO: UTIL, NFP: UTIL, NMR: UTIL, NOT: UTIL, NTRN: UTIL, OMO: UTIL, ONDO: UTIL,
  ORCA: UTIL, ORDINAL: UTIL, OS: UTIL, OXT: UTIL, PDA: UTIL, PIXEL: UTIL, PONKE: UTIL, PORTAL: UTIL,
  PUNDIX: UTIL, PYR: UTIL, REI: UTIL, RIF: UTIL, SAGA: UTIL, SANTOS: UTIL,
  SCR: UTIL, SEA: UTIL, SLP: UTIL, SONIC: UTIL, SPX: MEME, STEPN: UTIL, STRAX: UTIL, STX: UTIL,
  SWARMS: UTIL, SYM: UTIL, TAO: UTIL, TNSR: UTIL, TOKAMAK: UTIL, TRB: UTIL, U2U: UTIL, UFT: UTIL,
  UXLINK: UTIL, VANA: UTIL, VELVET: UTIL, VINE: MEME, VIRTUAL: UTIL, WAL: UTIL,
  XEC: UTIL, XEM: UTIL, XNO: UTIL, YGG: UTIL, ZAMA: UTIL, ZETA: UTIL, ZKW: UTIL, ZRO: UTIL,
  ZERO: UTIL, ZKSYNC: UTIL, GTC: UTIL, LOKOM: UTIL
};

/** الحقن: يستخدمه النظام لبناء تقييم لكود ليس له حقائق مسبقة */
export function factsForSymbol(symbol: string): ShariahFacts {
  const base = symbol.replace(/USDT$|USDC$|FDUSD$|BTC$|ETH$/, '');
  return DEFAULT_FACTS[base] ?? {
    has_utility: null, is_memecoin: null, has_lending_interest: null, has_fixed_yield: null,
    linked_haram_activity: null, is_asset_backed: null, pure_speculation: null, privacy_concern: null
  };
}