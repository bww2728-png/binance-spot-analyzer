# وثيقة تسليم الوكيل الجديد — نظام محلل العملات (binance-spot-analyzer)

> هذه الوثيقة للوكيل الذكي (AI Agent) الذي سيتولى متابعة هذا المشروع بعد الوكيل السابق.
> تشرح كل ما يلزم للوصول إلى قاعدة البيانات والنشر وحالة النظام — **دون أي مفاتيح سرية داخل المستودع عمداً** (المستودع عام، وكتابة الأسرار فيه تعني فقدان القاعدة للجميع).

---

## 1. ما هو النظام

محلل عملات Binance Spot كامل: محركا سيولة (legacy + v2)، مختبر سيولة موحد، فرص حية (استراتيجية شراء على مناطق SSL)، استراتيجية ثانية، باك تيست، ولوحات تحليل. واجهة React/Vite عربية RTL، خادم Node/Express، تخزين Supabase (PostgreSQL).

- **المستودع العام:** `https://github.com/bww2728-png/binance-spot-analyzer` — الفرع الأساسي `main`.
- **نشر Verdent (المحركات الكاملة):** `https://binance-spot-analyzer-u1kfl60.verdent.app`
- **نشر SnapDeploy (نسخة خفيفة LIGHT_MODE):** `https://spot-strategy-board.containers.snapdeploy.app`

## 2. قاعدة البيانات — كيف تصل إليها

قاعدة البيانات **Supabase (PostgreSQL مدارة)** وهي المصدر الدائم الوحيد. لا قاعدة ثانية.

### أ. الوصول الكامل المطلق — عبر حساب المالك (الأفضل)
1. `https://supabase.com` → تسجيل دخول بحساب مالك المشروع.
2. **Table Editor**: قراءة/تعديل كل الجداول (الشموع، المناطق، النقاط، الأحداث، الفرص، الإعدادات).
3. **SQL Editor**: تنفيذ أي استعلام أو ترحيل (ملفات الترحيل في `server/migrations/*.sql` جاهزة للصق والتنفيذ).
4. **Project Settings → Data API**: من هنا تُستخرج المفاتيح (انظر القسم 4).
5. **Project Settings → Database → Connection string**: سلسلة اتصال مباشرة لأدوات مثل psql/DBeaver.

### ب. الوصول عبر وكيل نشر Verdent (بدون أي مفتاح)
أي طلب REST يمر عبر نشر Verdent تُحقن فيه بيانات الدخول من الخادم تلقائياً:
```
https://binance-spot-analyzer-u1kfl60.verdent.app/rest/v1/<اسم-الجدول>?select=*
```
- يقرأ ويكتب (GET/PATCH/POST/DELETE تعمل).
- مفيد للفحص السريع والتشخيص دون الحاجة لمفاتيح.
- لا يعتمد عليه للإنتاج — يعتمد على بقاء نشر Verdent حياً.

### ج. الوصول عبر واجهات التطبيق نفسها (للتشخيص الوظيفي)
- `/healthz` — نبض الخادم.
- `/api/liquidity-workbench/status` — حالة مختبر السيولة (recovery، persistence، seeded).
- `/api/liquidity-workbench?timeframe=1h` — بيانات المختبر.
- `/api/live-opportunities` و `/api/live-opportunities/status` — الفرص الحية.
- `/api/symbols/meta` — حداثة قائمة الرموز.
- `/api/liquidity-history?engine=legacy|v2&days=90` — التاريخ الحسابي للمناطق.

### د. الوصول المباشر من كود المشروع
انسخ المستودع ثم أنشئ `.env` في الجذر:
```
SUPABASE_URL=<Project URL من لوحة Supabase>
SUPABASE_ANON_KEY=<مفتاح anon/publishable>
```
ثم `npm install && npm run build && npm start` — الخادم يتصل تلقائياً (`server/db.js`).

## 3. الجداول المهمة (نمط الأسماء)
- شموع ومختبر السيولة: جداول `liquidity_workbench_*` (candles, zones, points, runs, …).
- الفرص الحية: `live_*` (state, opportunities, lifecycle events).
- عام: `symbols`, `settings`, `events_log`, `health_samples`.
- سياسات RLS مفعّلة: القراءة والكتابة لمفتاح anon على جداول المختبر (اصطلاح معتمد — بيانات سوق آلية بلا بيانات مستخدمين). الترحيلات 007→013 في `server/migrations/` مطبقة على قاعدة التطوير.

## 4. المفاتيح — ماذا تطلب من المالك وكيف تحفظها

| المفتاح | من أين | حساسيته | الاستخدام |
|---|---|---|---|
| Project URL | Supabase → Settings → Data API | عام | كل الاتصالات |
| anon / publishable key | نفس الصفحة | **ليس سراً** (يظهر في المتصفح أصلاً) | قراءة/كتابة عبر RLS |
| service_role key | نفس الصفحة | **سر مطلق** | خادم فقط — تجاوز كامل لـRLS |

**قواعد صارمة للوكيل الجديد:**
1. **ممنوع منعاً باتاً** كتابة أي مفتاح (ولا حتى anon) داخل أي ملف في هذا المستودع — المستودع عام.
2. لا تطلب من المالك لصق `service_role` في المحادثة إلا إذا كان لا مفر، واعتبره محروقاً (يُدوَّر Rotate من نفس صفحة Data API بعد الاستخدام).
3. المفاتيح تُمرر للوكيل كمتغيرات بيئة على منصة النشر أو لصقاً مباشراً في سياق خاص، لا عبر ملفات ملتزمة.
4. إذا كُشف service_role لأي سبب: دورّه فوراً من لوحة Supabase وأبلغ المالك.

## 5. حالة النشر وقت كتابة هذه الوثيقة (28 أكتوبر 2026)

- **GitHub**: `main` = `740dd36` — يحوي كل الإصلاحات (استعادة، LIGHT_MODE، تسامح ws، واجهة ذاتية). فروع `feature/liquidity-history-replay` و`deploy/snapdeploy-free` متزامنة معه.
- **Verdent**: يعمل بنسخة سابقة (`fs_…b029a696`) — نشر نسخة أحدث محجوب مؤقتاً بحد خطة (`DEPLOYMENT_LIMIT_EXCEEDED`). عند سماح الحد: انشر مباشرة بأدوات النشر في المنصة.
- **SnapDeploy**: حاوية `spot-strategy-board` تعمل بآخر نسخة مع `LIGHT_MODE=1` (المحركات الثقيلة معطلة عمداً لحاوية 384MB، والـAPIs تقرأ نفس قاعدة Supabase عبر وكيل Verdent). ميزانية النشر اليومية هناك: 5 عمليات/يوم.
- **محرك الفرص الحية على Verdent**: في حلقة استعادة تلقائية بسبب تجاوز سجل lifecycle سقفاً قديماً — الإصلاح موجود في `main` (اقتطاع lifecycle غير قاتل + سقف 200k) وسيعمل فور نشر نسخة جديدة، ويُنتظر أن يُصلح نفسه ذاتياً بانقضاء نافذة 24 ساعة حتى بلا نشر.

## 6. الأعمال المعلقة (قائمة المتابعة)
1. نشر نسخة `main` على Verdent عند سماح حد الخطة، ثم التحقق: `recovery: ready` للفرص الحية + مختبر 14/14.
2. (اختياري) جعل نسخة LIGHT_MODE على SnapDeploy تقرأ بيانات المحركات من قاعدة البيانات مباشرة بدل الذاكرة.
3. مراقبة نمو جدول `live_lifecycle` — إن عاد الاقتطاع خفّض النافذة أو أضف تقصاً دورياً.
4. ترقية خطط Supabase عند اقتراب حدود النطاق الترددي.

## 7. خريطة الكود السريعة
- `server/index.js` — الخادم والمسارات وبوابات المحركات (`LIGHT_MODE`, `DISABLE_SERVER_WS`).
- `server/db.js` — طبقة Supabase (كل عمليات القاعدة).
- `server/migrations/` — ترحيلات المخطط (نسخة موازية في `.verdent/supabase/migrations/`).
- `server/live-opportunities/` — محرك الفرص الحية (loop, recovery, lifecycle, calibration).
- `server/market/streams.mjs` — بيانات السوق (بث اختياري + استطلاع REST احتياطي).
- `client/src/components/LiveOpportunitiesScreen.tsx` — واجهة الفرص الحية الذاتية.
- `client/src/lib/api.ts` — عميل الواجهة (REST نفس-الأصل + Supabase اختياري).
- `Dockerfile` + `railway.json` — بناء Docker (يستخدمه Verdent وRailway).
- الاختبارات: `npm test` (638+ ناجح)، بناء الواجهة: `npm run build --prefix client` أو `npm run build` من الجذر.
