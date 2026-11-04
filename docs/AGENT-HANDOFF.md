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

- **GitHub**: `main` = `fdff283` — يحوي كل إصلاحات الجلسات السابقة (استعادة، LIGHT_MODE، تسامح ws، واجهة ذاتية) + دفعة التدقيق الأمني للوكيل الجديد (PR #1: CI، readiness، ترحيلات 013b/014/014a). فروع `feature/liquidity-history-replay` و`deploy/snapdeploy-free` متزامنة معه.
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

## 8. سجل المحادثات الكامل — كل المعطيات المستخرجة من جلسات التشغيل (28 أكتوبر 2026)

> استُخرج هذا القسم بالكامل من محادثات التشغيل الفعلية بطلب صريح من المالك.
> **قيم الأسرار الحقيقية غير موجودة هنا عمداً** — أماكنها وطريقة استخراجها وتدويرها موثقة في القسمين 4 و8.8.

### 8.1 كل الروابط
| ماذا | الرابط |
|---|---|
| نشر Verdent (المحركات الكاملة) | `https://binance-spot-analyzer-u1kfl60.verdent.app` |
| وكيل Supabase عبر النشر (قراءة/كتابة بلا مفتاح) | `https://binance-spot-analyzer-u1kfl60.verdent.app/rest/v1/<جدول>?select=*` |
| نشر SnapDeploy (نسخة خفيفة) | `https://spot-strategy-board.containers.snapdeploy.app` |
| دومين Railway (متوقف) | `https://binance-spot-analyzer-production-7604.up.railway.app` |
| المستودع | `https://github.com/bww2728-png/binance-spot-analyzer` |

### 8.2 معرفات Verdent
- `deployment_id`: `dep_68592412fc8a`
- نسخ منشورة: `fs_749859585764343808_22_261027_153150_88134f35` (النسخة الحية)، `fs_..._154524_b029a696`، ومحاولة `fs_..._111802_9538dffa` فشلت بحد الخطة
- أسرار المنصة المعرفة بالاسم: `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` (تُحقن قيمها آلياً وقت البناء/التشغيل — الأدوات ترى الأسماء فقط)

### 8.3 معرفات وحالة SnapDeploy
- الحاوية: `spot-strategy-board` — containerId `3a20033a-d08f-4ca6-adc5-eef7d75b4645` — RUNNING
- ربط GitHub: repoLinkId `83978295-dc0e-44d5-9d6d-b6e7d7f1f3c0` — يراقب فرع `deploy/snapdeploy-free`
- عمليات النشر: `ea61d619…` COMPLETED (النسخة العاملة)، `0065959c…` FAILED (نُشر كود LIGHT_MODE بلا متغيره في البيئة)، `6c054b2f…` FAILED (فحص المنفذ أثناء التبديل — لكن السجلات تثبت أن النسخة الجديدة عملت فعلاً بعده)
- حد النشر: 5 عمليات/يوم
- متغيرات البيئة الفعلية المضبوطة (كلها غير سرية): `NODE_OPTIONS=--max-old-space-size=256`, `DISABLE_SERVER_WS=1`, `LIGHT_MODE=1`, `SHADOW_FIXES=` (فارغ), `SUPABASE_URL=https://binance-spot-analyzer-u1kfl60.verdent.app`, `SUPABASE_ANON_KEY=verdent-baas-proxy` (قيمة وهمية يتجاهلها وكيل Verdent ويحقن الحقيقي داخلياً)
- قيود المنصة: الأسماء ببادئة `binance` محجوزة؛ WebSockets على Always-On المدفوع فقط؛ ماسح البناء يستخدم Node-source (يتجاهل Dockerfile) ويطلب `npm start` جذرية (موجودة) ويرفض `DO blocks` في SQL
- توكن الـAPI: من لوحة SnapDeploy → API tokens (قيمته مرّت في محادثة سابقة — **دوّره**، انظر 8.8)

### 8.4 معرفات وحالة Railway
- workspace `db451f9a-4c4b-45fa-9132-fa1522829a84` · project `7de63f39-0238-4b21-89c8-b3a7c2a1be2f` · service `dd1c5ddb-3835-470d-b294-6b5df1ada17a` · environment production `0d79b5b1-ba62-4b66-8593-1f0dc391a559` · deployment trigger على main `f0453b5c-75a9-4846-b5bd-ded162b5abc7`
- الحالة: الفترة التجريبية منتهية (أي نشر يُرجع "Your trial has expired")، متغيرات الخدمة فارغة تماماً، آخر نشر FAILED بتاريخ 6 أكتوبر، والنشر التلقائي معطل على المشغّل
- توكن الـAPI: من لوحة Railway → Account → Tokens (قيمته مرّت في محادثة سابقة — **دوّره**، انظر 8.8)

### 8.5 Supabase — المعروف والمجهول
- القاعدة مدارة عبر Verdent: عنوان وكيل من نمط `supabase-api-prod.verdent.ai/p/<project-ref>` (وُجد في أرشيف الجلسات) — المفاتيح الحقيقية معتّمة في الأرشيف ولا يمكن استخراجها أدواتياً
- المفاتيح الحقيقية تُستخرج حصراً من لوحة المالك: Project Settings → Data API (Project URL + anon + service_role)
- الترحيلات المطبقة فعلاً على قاعدة التطوير: حتى `013` (اصطلاح كتابة anon) — تحقّق بصري بقسم `information_schema` نجح
- ترحيلات الوكيل الجديد `013b_grant_service_role.sql` و`014_restrict_anon_privileges.sql` و`014a_rollback_anon_privileges.sql` **جاهزة غير مطبقة** — تُطبق من SQL Editor في لوحة Supabase
- RLS الحالي: قراءة/كتابة anon على `liquidity_workbench_*` و`live_*`

### 8.6 إثباتات رقمية من التشغيل الفعلي (مرجع سريع)
- استعادة كاملة ناجحة بعد إصلاح السقف: **17,457 متتبعاً، 53 صفحة أحداث، بلا اقتطاع**
- سبب الانسداد الدائم القديم: 50,000 حدث `live_lifecycle` تجاوزت السقف القديم (`truncated: true` مثبت من API)
- الإصلاح: سقف 200,000 صف (`index.js`) + اقتطاع lifecycle غير قاتل (`recovery.mjs`) — اقتطاع فرص النشر يبقى قاتلاً
- الاختبارات: 638 ناجحاً، صفر فشل (اختباراتا البث تُتخطيان تلقائياً بلا حزمة `ws`)
- SnapDeploy على حاوية 384MB: يعمل مع LIGHT_MODE؛ بلا LIGHT_MODE تتجمد الحلقة (سقف heap = سقف الحاوية → OOM)
- عبر وكيل Verdent: مزامنة 1,380 رمزاً، حساب شرعي لـ362 عملة، بذر 6,076 مفتاح مناطق، استعادة الحالة وlearning — كلها نجحت في السجلات

### 8.7 قرارات جوهرية وأسبابها (لا تُلغى دون فهم سببها)
1. **حذف `ws` من تبعيات الخادم + استيراد ديناميكي محروس**: المنصات المجانية تمنع WS؛ الواجهة لديها احتياطي استقصاء جاهز (`pollSymbolsMeta` في `client/src/lib/binance.ts`)
2. **`LIGHT_MODE=1`**: يوقف المحركات الثقيلة (workbench/live-opp/strategy2/market streams) على الحاويات الصغيرة — التطبيق والـAPIs تقرأ نفس قاعدة Supabase
3. **اسم الحاوية `spot-strategy-board`**: أي اسم ببادئة `binance` مرفوض منصياً
4. **المعايرة الأولى تنطلق تلقائياً** عند بدء المحرك إن لم توجد محفوظة (كانت تنتظر 6 ساعات)
5. **الواجهة الذاتية بلا أزرار تشغيل يدوي**: زر الإيقاف الطارئ فقط + شارة "تشغيل ذاتي · الدورة N"

### 8.8 تنبيه تدوير المفاتيح (مهم قبل التسليم)
توكن SnapDeploy وتوكن Railway مرّا نصاً في محادثة تشغيل — **يُنصح بتدويرهما من لوحتيهما فوراً** قبل تسليم الوكيل الجديد، وتسليم القيم الجديدة للموكيل مباشرة في محادثته (لا في هذا المستودع العام). مفاتيح Supabase لم تظهر في أي محادثة أصلاً — تُستخرج من لوحة المالك فقط.
