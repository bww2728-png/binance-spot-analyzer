/* أكاديمية النظام: كل أدوات السيولة والتلاعب والتنفيذ (63 أداة) في 4 فئات.
 * status:
 *  - active   : تعمل الآن في محرك الكشف الآلي
 *  - partial  : تقريب مبسط يعمل الآن
 *  - external : تحتاج مصدراً خارجياً مدفوعاً (طبقة لاحقة)
 *  - advisory : ليست محدِّدة مناطق — استراتيجية تنفيذ/مخاطر (شرح تعليمي فقط)
 *  - heuristic: كشف تقريبي عبر شذوذ الحجم/السعر/المشاعر
 */

export type AcademyStatus = 'active' | 'partial' | 'external' | 'advisory' | 'heuristic';

export interface AcademyTool {
  name: string;
  status: AcademyStatus;
  what: string;
  liquidity: string;
}

export const STATUS_META: Record<AcademyStatus, { label: string; color: string; bg: string }> = {
  active: { label: 'تعمل الآن في الكشف', color: '#089981', bg: 'rgba(8,153,129,0.12)' },
  partial: { label: 'تقريب مبسط يعمل', color: '#3b82f6', bg: 'rgba(59,130,246,0.12)' },
  external: { label: 'مصدر خارجي مدفوع — لاحقاً', color: '#f59e0b', bg: 'rgba(245,158,11,0.12)' },
  advisory: { label: 'شرح تعليمي — ليست محدِّد مناطق', color: '#8b5cf6', bg: 'rgba(139,92,246,0.12)' },
  heuristic: { label: 'كشف تقريبي بالشذوذ', color: '#ec4899', bg: 'rgba(236,72,153,0.12)' }
};

export const ACADEMY_CATEGORIES: { key: string; title: string; intro: string; tools: AcademyTool[] }[] = [
  {
    key: 'structure',
    title: 'الفئة 1 — الهيكل الكلاسيكي (نواة الكشف)',
    intro: 'الأساس الذي يحدد أين تتجمع السيولة: قمم وقيعان السوينغ، التساوي، السحب، والفجوات — كلها تعمل آلياً في النظام وتُعاير عتباتها من تعليمك.',
    tools: [
      { name: 'BSL/SSL Sweep', status: 'active', what: 'اختراق مستوى سيولة بالذيل ثم إغلاق داخل النطاق — إشارة انعكاس.', liquidity: 'السحب يستهلك البركة؛ الإغلاق داخل النطاق هو الحكم لا الذيل.' },
      { name: 'Stop Hunting', status: 'active', what: 'دفع السعر عمداً إلى مستوى وقف الخسائر لجمع السيولة.', liquidity: 'نفس آلية السحب من منظور الفاعل الكبير — النظام يكتشفه كنمط.' },
      { name: 'EQH/EQL', status: 'active', what: 'قمم/قيعان متساوية تشكل بركة سيولة أكبر كلما زاد عدد النقاط.', liquidity: 'كل نقطة إضافية في العنقود ترفع درجة المنطقة آلياً.' },
      { name: 'Sweeps + FVG', status: 'active', what: 'تزامن سحب سيولة مع فجوة قيمة عادلة — أعلى توافق للدخول.', liquidity: 'توافق FVG قرب المنطقة يضيف نقاطاً لدرجتها في المحرك.' },
      { name: 'Inducement', status: 'active', what: 'سيولة بناء أولية فوق/تحت منطقة حقيقية لإغراء الدخول المبكر ثم سحبها.', liquidity: 'المحرك يرصد الـPivots الثانوية قبل المراسي الكبرى كمُغريات.' },
      { name: 'Liquidity Removal', status: 'active', what: 'امتصاص الأوامر عند المستوى ثم الانطلاق — نهاية دورة البركة.', liquidity: 'يظهر في النظام كمنطقة مُسحوبة (swept) بعلامة الاستهلاك.' },
      { name: 'Order Flow', status: 'partial', what: 'قراءة تدفق الأوامر المنفذة لفهم من يشتري فعلاً.', liquidity: 'يمثلها المحرك عبر CVD وأحجام الآجل من شموع السبوت.' },
      { name: 'Mean Reversion', status: 'active', what: 'ميل السعر للعودة لمتوسطه بعد الشذوذ.', liquidity: 'يُستخدم كطبقة سياق: المناطق بعيدة عن المتوسط تأخذ أولوية انعكاس.' }
    ]
  },
  {
    key: 'derivatives',
    title: 'الفئة 2 — المشتقات وتدفق الأوامر (مفعّلة بمجانية بينانس)',
    intro: 'بيانات رسمية حية من بينانس فيوتشرز + حسابات داخلية من شموع السبوت — بلا أي اشتراك خارجي.',
    tools: [
      { name: 'Open Interest', status: 'active', what: 'إجمالي قيمة العقود المفتوحة — وقود الحركة.', liquidity: 'ارتفاع OI قرب المستوى = رافعات جديدة تتراكم حوله.' },
      { name: 'Funding Rate', status: 'active', what: 'تكلفة تمويل المراكز الدائمة — مقياس الازدحام.', liquidity: 'تمويل متطرف قرب المنطقة يرفع درجتها (ازدحام جهة واحدة).' },
      { name: 'Long/Short Ratio', status: 'active', what: 'نسبة حسابات الطويلين للقصيرين — انحياز التجزئة.', liquidity: 'انحياز حاد يعني جهة سيولة وفيرة للسحب في الاتجاه المعاكس.' },
      { name: 'Taker Buy/Sell (CVD)', status: 'active', what: 'الدلتا التراكمية: ضغط أوامر السوق المنفذة.', liquidity: 'CVD مخالف للسعر قرب المنطقة = اختفاء سيولة استمرارية.' },
      { name: 'Liquidation Heatmap', status: 'partial', what: 'خرائط تتنبأ بمواقع التصفيات الجماعية.', liquidity: 'النظام يبني تقديراً داخلياً من OI + رافعات 10/25/50/100× — نفس مبدأ Coinglass مجاناً.' },
      { name: 'VWAP', status: 'partial', what: 'متوسط السعر مرجحاً بالحجم — معيار جودة تنفيذ المؤسسات.', liquidity: 'يُحسب من شموعك؛ انحراف السعر عنه يفسر الحركة نحو البرك.' },
      { name: 'TWAP', status: 'advisory', what: 'تنفيذ مقسم زمنياً بالتساوي — خوارزمية تنفيذ لا مؤشر.', liquidity: 'فهمها يفسر «السلالم» البطيئة التي تبني سيولة عند مستوى.' },
      { name: 'POV', status: 'advisory', what: 'تنفيذ بنسبة من حجم السوق — خوارزمية تنفيذ.', liquidity: 'أثرها يظهر كامتصاص منتظم للسيولة عند مستوى واحد.' },
      { name: 'Iceberg Orders', status: 'partial', what: 'أوامر كبيرة تخفي معظم حجمها وتعيد التعبئة.', liquidity: 'المحرك يكتشف مستوى ضُرب مرات كثيرة بأحجام متقاربة.' },
      { name: 'Hidden Icebergs', status: 'partial', what: 'آيسبرغ بدون خيار الرسمي — إخفاء كامل للكمية.', liquidity: 'نفس كشف إعادة التعبئة يلتقطه تقريبياً.' },
      { name: 'Spoofing', status: 'partial', what: 'أوامر كبيرة وهمية لتضليل الدفتر ثم الإلغاء.', liquidity: 'المحرك يقارن لقطتي دفتر: أمر كبير اختفى دون تنفيذ = Spoof.' },
      { name: 'Layering', status: 'partial', what: 'طبقات أوامر وهمية متعددة على جهة واحدة.', liquidity: 'يُلتقط كأنماط اختفاء متتالية عبر لقطات العمق المتكررة.' },
      { name: 'Quote Stuffing', status: 'partial', what: 'إغراق الدفتر بأوامر سريعة الإلغاء لإبطاء الآخرين.', liquidity: 'يظهر كارتفاع شذوذي في معدل تحديث العمق دون تنفيذ.' },
      { name: 'Smoking Guns', status: 'heuristic', what: 'آثار مباشرة تدليل على تدخل كبير (صفقات ضخمة مفاجئة).', liquidity: 'تمثلها صفقات aggTrades الكبيرة المتكررة عند مستوى.' },
      { name: 'Sniper Orders', status: 'advisory', what: 'أوامر تنتظر سيولة الآخرين بدقة لتنفذ فور ظهورها.', liquidity: 'أثرها: استهلاك فوري لأي سيولة جديدة عند المستوى.' },
      { name: 'Chase Orders', status: 'advisory', what: 'مطاردة السعر بترفع مستوى الأمر باستمرار.', liquidity: 'أثرها: امتصاص متتابع عبر عدة مستويات بسرعة.' },
      { name: 'Market Making', status: 'advisory', what: 'توفير سيولة من الجانبين مقابل السبريد.', liquidity: 'صانع السوق هو الطرف الذي تستهدفه البرك — فهمه يفهم السحب.' },
      { name: 'Inventory Management', status: 'advisory', what: 'إدارة مخزون صانع السوق لتقليل الانحياز.', liquidity: 'إفراغ المخزون يخلق موجات بيع/شراء تمسح البرك.' },
      { name: 'Whale Tracking', status: 'external', what: 'تتبع محافظ الحيتان الكبيرة.', liquidity: 'Whale Alert مدفوع — طبقة لاحقة إن أثبتت الحاجة.' },
      { name: 'Exchange Inflow/Outflow', status: 'external', what: 'تدفقات العملات من/إلى البورصات (نية بيع/شراء).', liquidity: 'تحتاج CryptoQuant/Glassnode — مدفوعة، لاحقاً.' },
      { name: 'Fear/Greed Index', status: 'partial', what: 'مؤشر الخوف والطمع السوقي.', liquidity: 'API مجاني — يُضاف كسياق عام لدرجات المناطق.' }
    ]
  },
  {
    key: 'manipulation',
    title: 'الفئة 3 — التلاعب والأحداث (كشف تقريبي بالشذوذ)',
    intro: 'غير قابلة للإثبات المباشر، لكن بصمتها تظهر في الحجم والسعر والمشاعر — يرصدها النظام كشذوذ يرفع درجة المنطقة.',
    tools: [
      { name: 'Painting the Tape', status: 'heuristic', what: 'تداول مصطنع لرسم نمط مضلل على الشارت.', liquidity: 'يظهر كحجم كبير بلا أثر سعر — شذوذ يحذر من المنطقة.' },
      { name: 'Wash Trading', status: 'heuristic', what: 'بيع وشراء لنفس الطرف لتضخيم الحجم.', liquidity: 'حجم وهمي = بركة أضعف مما تبدو — النظام يرجح الشك.' },
      { name: 'Volume Spoofing', status: 'partial', what: 'تضخيم حجم ظاهري عبر دفتر الأوامر.', liquidity: 'نفس كشف الـSpoof عبر اللقطات المتتالية.' },
      { name: 'Pump & Dump', status: 'heuristic', what: 'تضخيم ثم تفريغ منسق.', liquidity: 'بصمته: شمعة انطلاق بحجم شاذ — مناطق القمة بعدها برك دم غزيرة.' },
      { name: 'Bear & Bull Raid', status: 'heuristic', what: 'هجوم منسق لكسر مستوى وجمع السيولة.', liquidity: 'يكتشف كسر مستوى بحجم شاذ ثم ارتداد سريع.' },
      { name: 'Momentum Ignition', status: 'heuristic', what: 'إشعال زخم لسحب الآخرين خلفه.', liquidity: 'انطلاق سريع بحجم متزايد ينهي عند أول بركة كبرى.' },
      { name: 'FOMO Generation', status: 'heuristic', what: 'خلق خوف الفوات لجذب مشترين متأخرين.', liquidity: 'المشترون المتأخرون هم وقود الـBSL — زخم سوشال متطرف = تحذير.' },
      { name: 'FUD Distribution', status: 'heuristic', what: 'نشر الخوف لتجميع رخيص.', liquidity: 'ذعر سوشال + سرعة سقوط = برك SSL تُمسح بعنف.' },
      { name: 'News Timing', status: 'heuristic', what: 'تحركات حول مواعيد الأخبار.', liquidity: 'الأخبار تحدد متى تُمسح البرك — سياق زمني للدرجات.' },
      { name: 'News-Based Moves', status: 'heuristic', what: 'حركات مدفوعة بخبر مباشر.', liquidity: 'نفس الدور: سياق يفسر السحب لا يتنبأ به.' },
      { name: 'Social Sentiment', status: 'external', what: 'تحليل مشاعر المنصات.', liquidity: 'يحتاج مزوداً متخصصاً — لاحقاً.' },
      { name: 'Influencer Coordination', status: 'heuristic', what: 'تنسيق تضخيم عبر المؤثرين.', liquidity: 'قفزات اهتمام مفاجئة تسبق مسح البرك — شذوذ سياقي.' },
      { name: 'Margin Call Cascades', status: 'partial', what: 'سلسلة تصفيات تجر تصفيات.', liquidity: 'عناقيد التصفيات التقديرية في المحرك تحدد أين تنشأ السلاسل.' }
    ]
  },
  {
    key: 'strategies',
    title: 'الفئة 4 — استراتيجيات تنفيذ ومخاطر (شرح فقط — ليست محدِّدات مناطق)',
    intro: 'بصراحة منهجية: هذه استراتيجيات مراجحة وإدارة مخاطر وتشغيل، لا أدوات توقع أين تتجمع السيولة. وضعها في الكشف سيكون خلطاً — لذلك تُشرح هنا لتكتمل صورتك.',
    tools: [
      { name: 'Statistical Arbitrage (Stat Arb)', status: 'advisory', what: 'مراجحة إحصائية بين أصول مترابطة.', liquidity: 'توفّر سيولة مستمرة تسحب الانحرافات — تفسر عودة السعر لا البرك.' },
      { name: 'Latency Arbitrage', status: 'advisory', what: 'استغلال فرق سرعة الوصول للبيانات.', liquidity: 'أثرها: استهلاك لحظي لأي فرق سعر — لا يبني مناطق.' },
      { name: 'Pairs Trading', status: 'advisory', what: 'تداول زوج مترابط طويل/قصير.', liquidity: 'حركات الزوج تخلق «سيولة وهمية» على الفرد — سياق فقط.' },
      { name: 'Index Arbitrage', status: 'advisory', what: 'مراجحة السلة مقابل المؤشر.', liquidity: 'تدفقات السلة تمسح مستويات متعددة دفعة واحدة — تفسير بعد الحدوث.' },
      { name: 'Triangular Arbitrage', status: 'advisory', what: 'مراجحة ثلاثية بين أزواج العملات.', liquidity: 'تغلق الفروقات فوراً — تضيف عمقاً لا توجهاً.' },
      { name: 'Funding Arbitrage', status: 'advisory', what: 'جمع التمويل بمركز محايد.', liquidity: 'ازدحام المراجحين (تمويل متطرف) إشارة سياق يستخدمها المحرك عبر Funding نفسه.' },
      { name: 'Perp-Spot Basis', status: 'advisory', what: 'مراجحة فرق سعر الدائم والسبوت.', liquidity: 'اتساع البازيس = ازدحام جهة — سياق مشتق مفيد لاحقاً.' },
      { name: 'Delta Neutral', status: 'advisory', what: 'تحييد الانحياز الاتجاهي.', liquidity: 'إعادة توازن الدلتا تمسح بركاً صغيرة — تفسير لا تنبؤ.' },
      { name: 'Cross-Exchange Hedging', status: 'advisory', what: 'تحوّط بين بورصتين.', liquidity: 'فرق الأسعار بين البورصات يغلق بسرعة — لا مناطق.' },
      { name: 'Risk Parity', status: 'advisory', what: 'توزيع مخاطر متوازن للمحفظة.', liquidity: 'إدارة محفظة — علاقتها بالمناطق غير مباشرة كلياً.' },
      { name: 'Kelly Criterion', status: 'advisory', what: 'حجم المركز الأمثل رياضياً.', liquidity: 'تحديد حجم لا تحديد مكان — تكمّل الكشف لا تدخله.' },
      { name: 'Max Drawdown Control', status: 'advisory', what: 'سقف للتراجع الأقصى.', liquidity: 'إدارة مخاطر — لا علاقة بتحديد المناطق.' },
      { name: 'Cross-Collateral', status: 'advisory', what: 'استخدام أصول متعددة كضمان.', liquidity: 'بنية حساب — تؤثر على مواقع التصفيات الكبيرة نظرياً فقط.' },
      { name: 'Staking Lock-up', status: 'advisory', what: 'تجميد العملات في الستيكنغ.', liquidity: 'التجميد يقلل السيولة المتداولة — عامل هيكلي بطيء.' },
      { name: 'Launchpad Sniping', status: 'advisory', what: 'شراء فوري عند إدراج جديد.', liquidity: 'الإدراجات تخلق بركاً متقلبة قصيرة العمر — سياق خاص.' },
      { name: 'API Rate Limiting', status: 'advisory', what: 'إدارة حدود نداءات الـAPI.', liquidity: 'تشغيلي بحت — النظام يطبقه داخلياً لمصداقية بياناته.' },
      { name: 'Sub-Account Strategy', status: 'advisory', what: 'تقسيم العمليات على حسابات فرعية.', liquidity: 'تشغيلي — يخفي أثر الحيتان خارج نطاق بياناتنا.' },
      { name: 'Token Unlock', status: 'external', what: 'فتح عملات مجدولة من الحجز.', liquidity: 'مصدر عرض مفاجئ يخلق بركاً — Tokenomist مدفوع، لاحقاً.' },
      { name: 'Stablecoin Mint', status: 'external', what: 'طبخ الستيبلات = سيولة جديدة قادمة.', liquidity: 'Whale Alert/on-chain — لاحقاً.' },
      { name: 'Bridge Activity', status: 'external', what: 'حركة أموال بين السلاسل.', liquidity: 'تحتاج فهرسة on-chain — لاحقاً.' },
      { name: 'Gas Analysis', status: 'external', what: 'ارتفاع الغاز = نشاط شبكة مكثف.', liquidity: 'خصوصي Ethereum — لاحقاً عند الحاجة.' }
    ]
  }
];

export const ACADEMY_TOTAL = ACADEMY_CATEGORIES.reduce((a, c) => a + c.tools.length, 0);
