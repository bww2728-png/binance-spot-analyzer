# تدقيق استقلال قاعدة البيانات والاستضافة

**الفرع:** `feature/database-portability`  
**خط الأساس:** `main @ 7340da7d5321fc5fea820dac9167766f052137dc`  
**تاريخ التدقيق:** 2026-11-17  
**النطاق:** التخزين والاستضافة فقط. لم يُعدّل منطق التداول أو السيولة أو الاستراتيجية.

## 1. الحالة الحالية

النظام تطبيق Node 22 + Express 5 يخدم واجهة React من عملية واحدة، وقد كان التخزين
مركّزاً عملياً في `server/db.js`: هذا الملف يحمل اتصال Supabase REST، وبناء استعلامات
PostgREST، وتحويل النتائج، وقواعد أعمال مرتبطة بالأحداث، وطرق Binance REST.

يوجد مصدران مستقلان للترحيلات:

- `server/migrations/` هو المخطط التشغيلي الأغنى، ويحتوي 19 ملفاً تاريخياً ومجموعة
  `fresh-install.sql` مولّدة.
- `.verdent/supabase/migrations/` يحتوي تسعة ملفات تثبيت أولية أقدم، ويتضمن جداول
  بأنواع وأسماء سياسات مختلفة.

الواجهة لا تزال تحتوي أربعة مسارات بيانات مباشرة إلى Supabase SDK:

- `coin_shariah`: قراءة، كتابة، حذف.
- `settings`: قراءة وتحديث.
- `events_log`: قراءة مناطق، وإنشاء منطقة، وتعديل منطقة، وإخفاؤها كحذف منطقي.
- `liquidity_manual_drawings`: كان يقرأ ويكتب مباشرة قبل المرحلة الأولى من هذا الفرع.
  أُزيل هذا الاتصال في المرحلة الأولى وأصبح الرسومات تمرّ عبر Express.

مسار `manualLiquidity.ts` لم يكن يستخدم `@supabase/supabase-js`; كان يجلب
`/api/manual-liquidity/config` ثم يبني `fetch` مباشراً إلى `${url}/rest/v1/...`.
هذا يعني أن تعطيل SDK في `api.ts` وحده لا يلغي اعتماد المتصفح على Supabase REST.

القاعدة الحالية المستخدمة في تشغيل Verdent هي Data API متوافقة مع PostgREST، وليست
دائماً عنوان `*.supabase.co`. لذلك أي تحقق صرف يفرض شكل Supabase السحابي سيمنع
الاستضافة التي تستخدم Supabase-compatible REST من عنوانها الخاص.

## 2. جرد الجداول وعملياتها

| الجدول | CRUD / الاستخدام الفعلي | مستهلك التخزين |
|---|---|---|
| `analyses` | قراءة، إنشاء، تعديل، حذف | `db.analyses`، فحص الباركود |
| `coin_flags` | قراءة، upsert | `db.coinFlags`، مسار الباركود |
| `barcode_scans` | قراءة، قراءة حسب الرمز، upsert، ومسارات توافق عبر `events_log`/`coin_flags` | `db.barcodeScans` |
| `coin_shariah` | قراءة كاملة، قراءة أحكام مختصرة، upsert مفرد ودفعات، حذف | `db.coinShariah` وواجهة SDK |
| `settings` | قراءة، إنشاء صف id=1، تعديل | `db.settings`، `ensureSettings` |
| `events_log` | append، patch، delete، count، pagination، بحث بالأنواع، قراءة دورة الحياة والفرص والاستراتيجيات | `db.events`، `db.zones`، `db.cases`، `db.engineState` |
| `health_samples` | إنشاء، قراءة حديثة، count، حذف زمني، حذف الأقدم | `db.health` |
| `cases` | مخطط موجود، لكن شاشة القرارات الفعلية تمثّل قرارات على `events_log` | ليس مسار الإنتاج الحالي بعد النقل إلى events |
| `case_images` | مخطط وعلاقة FK تاريخية، بينما الصور الحالية تُخزَّن كأحداث `decision_image` | ليس مسار الإنتاج الحالي |
| `symbols` | قراءة، آخر تحديث، upsert دفعات | `db.symbols` |
| `liquidity_manual_drawings` | قراءة، upsert، حذف، وقيود JSON | `db.manualLiquidityDrawings`، ثم عبر الخادم فقط |
| `liquidity_workbench_candles` | قراءة، upsert دفعات، حذف تقليدي | `db.liquidityWorkbench` |
| `liquidity_workbench_events` | قراءة وupsert idempotent | `db.liquidityWorkbench` |
| `liquidity_workbench_samples` | إنشاء idempotent وحذف | `db.liquidityWorkbench` |
| `liquidity_workbench_scans` | قراءة وupsert | `db.liquidityWorkbench` |
| `liquidity_workbench_points` | قراءة وupsert | `db.liquidityWorkbench` |
| `liquidity_workbench_point_zone_links` | قراءة وupsert، علاقة FK بنقاط المختبر | `db.liquidityWorkbench` |

`cases` و`case_images` يجب أن يبقيا محفوظين للتوافق التاريخي. لا تثبت الشفرة أن
شاشة القرارات الحديثة تكتب إليهما؛ المسار الحالي يحوّل القرارات إلى
`events_log(type=decision_*)`، والصور إلى `events_log(type=decision_image)`.

## 3. واجهة العمليات المطلوبة للعقد

العقد النهائي يجب أن يغطي هذه العمليات الفعلية فقط:

- `zones`: `list`, `listAuto`, `listAll`, `history`, `append`, `appendFeedback`,
  `getAutoSnapshot`, `appendAutoSnapshot`, `getCalibration`, `autoHistory`,
  `appendZoneScreenshot`, `listZoneScreenshots`, `appendCalibration`.
- `symbols`: `list`, `lastUpdated`, `upsertChunk`.
- `manualLiquidityDrawings`: `list`, `upsert`, `remove`.
- `liquidityWorkbench`: `listScans`, `listEvents`, `listCandles`, `upsertCandles`,
  `upsertScan`, `upsertPoints`, `upsertPointLinks`, `listPointLinks`, `listPoints`,
  `insertZoneEvent`, `insertSample`, `pruneRaw`.
- `analyses`: `list`, `create`, `update`, `remove`.
- `coinFlags`: `list`, `upsert`.
- `barcodeScans`: `list`, `get`, `upsert`.
- `coinShariah`: `list`, `listVerdicts`, `upsert`, `upsertChunk`, `remove`.
- `settings`: `get`, `create`, `update`.
- `health`: `append`, `recent`, `count`, `deleteBefore`, `deleteOldest`.
- `cases`: `save`, `list`, `get`, `imagesSave`, `imagesList`.
- `engineState`: `get`, `getStrict`, `put`, `keys`.
- `events`: `list`, `get`, `create`, `countByType`, `listByType`, `deleteBefore`,
  `deleteByIds`, `clearImagesBefore`, `opportunityHistoryPage`,
  `opportunityHistorySummary`, `opportunityOutcomeEventsPage`, `rejectedEventsPage`,
  `rejectedSummary`, `liveOppEvents`, `liveOppEventsPage`, `liveLifecycle`,
  `liveLifecyclePage`, `strategy2Events`, `strategy2EventsPage`,
  `strategy2Calibration`, `strategy2FeedbackSave`, `strategy2FeedbackEvents`,
  `strategy2FeedbackEventsPage`, `strategy2DirectionEvents`,
  `strategy2DirectionEventsPage`.

## 4. استيرادات ومستهلكو التخزين

`server/index.js` يستورد `db` واحداً ويستخدمه لجميع المجموعات أعلاه. هناك مستهلكون
غير مباشرين أيضاً:

- `server/health.mjs` يكتب عينات الجودة.
- `server/services/inventoryStore.mjs` يقرأ ويكتب `engineState`.
- `server/services/retention.mjs` يحذف الأحداث والعينات وفق السياسة.
- `server/services/shadow.mjs` يحفظ ويقرأ تقرير الظل.
- `server/services/settingsDefaults.mjs` يضمن صف الإعدادات.
- `server/tools/exportArchiveCsv.mjs` يقرأ القرارات وتاريخ اللقطات.
- `server/tests/liquidityWorkbenchDb.test.mjs` و`manualLiquidityDb.test.mjs`
  يثبتان توجيه المفاتيح والاستعلامات REST، لا صحة القاعدة نفسها.
- وحدات Binance في `server/market/` و`server/liquidity-zones/` و`server/strategy2/`
  تتلقى دوال `klines`/`prices` من الخارج. لا يجب أن تعرف طبقة التخزين.

## 5. افتراضات Supabase وPostgREST

- بناء الاستعلامات والأعمدة والترتيب يستخدم صياغة PostgREST (`eq.*`, `in.(...)`,
  `like.*`, `not.is.null`, `on_conflict`).
- قراءة عدد الصفوف تعتمد HEAD و`Content-Range` و`Prefer: count=exact`.
- الكتابة تعتمد `Prefer: resolution=merge-duplicates` و`return=representation/minimal`.
- `coin_shariah.facts/reasons/evidence` من نوع `jsonb` في
  `000_full_schema.sql`، بينما الشفرة تتعامل معها أحياناً كسلسلة JSON وأحياناً
  ككائن. PostgreSQL adapter يجب أن يحافظ على تمثيل المستهلك، لا أن يفرض تحويلاً جديداً.
- `liquidity_manual_drawings.payload` من نوع `jsonb`; العمليات القديمة تمرر كائناً.
- `events_log.meta` نص text، وليس JSONB. تحويله إلى JSONB سيمس عقد كل قارئ.
- `cases.payload` نص، و`case_images.data_url` نص.
- التوقيتات في الجداول التشغيلية هي `bigint` بالميلي ثانية، باستثناء السكربتات
  الأولية القديمة في Verdent التي تستخدم `timestamptz`. مصدر التشغيل الحالي هو
  `server/migrations`.
- بعض الأنواع `numeric` تعود من PostgREST كنص، ثم يحوّلها المستهلك. الموصل
  PostgreSQL يجب أن يعيد تمثيلاً متوافقاً في كل مسار بدلاً من تحويل عام قد يغيّر
  دلالات الأرقام.

يوجد fetch مباشر إضافي في `db.js` حول HEAD للعدّ، لكن لا توجد عمليات قاعدة بيانات
خارج الملف في وحدات الإنتاج عدا واجهة SDK داخل المتصفح.

## 6. `events_log` والاستعادة

`events_log` هو السجل المركزي والذاكرة الدائمة، وليس سجل تشخيص فقط. يستخدمه النظام في:

- تكوين المناطق اليدوية (`liquidity_zone`) والتغذية الراجعة (`zone_feedback`).
- لقطات المناطق الآلية (`auto_zones_snapshot`) وصورها (`auto_zone_screenshot`) ومعايرتها
  (`zone_calibration`).
- قرارات التحليل (`decision_*`) وصور القرار (`decision_image`).
- بذور التوافق للباركود (`barcode_scan`).
- حالة محركات مفتاح/قيمة (`engine_state`): `liquidity_inventory`,
  `backtest_last_run`, `shadow_report`, `liquidity_learning`,
  `live_opportunities_control`.
- الفرص الحية (`live_opportunity`, `live_opportunity_closed`,
  `live_opportunity_rejected`, `live_lifecycle`).
- «استراتيجيتي» (`strategy2_published`, `strategy2_resolved`,
  `strategy2_rejected`, `strategy2_calibration`, `strategy2_direction`,
  `strategy2_feedback`).
- تغييرات التصنيف البحثي (`shariah_auto_change`).

الاستعادة بعد التشغيل تعتمد على قراءة صفحات `events_log` تنازلياً بمعرّف مستقر ثم
إعادتها زمنياً، مع قراءة `engine_state` للإيقاف والمخزون. أي adaptor يجب أن يحافظ على
`id` تصاعدي، `ts` بالميلي ثانية، والترتيب الثانوي بـ`id`، وعدم اعتبار الاتصال الناجح
دليلاً على اكتمال سجل الاستعادة.

## 7. البيانات المطلوبة للجاهزية والاستعادة

- `client/dist/index.html` موجود.
- `DATABASE_PROVIDER` صريح، وبيانات اعتماده صالحة.
- `SELECT 1` ينجح ضمن مهلة محدودة.
- الجداول والقيود والفهارس الأساسية موجودة.
- سجل الترحيلات مطابق للملفات الرسمية، وليس فيه ترحيل معلّق أو غير مكتمل.
- قراءة وكتابة اختبارية أساسية تنجح.
- استعادة الفرص الحية اكتملت أو أن النظام معلن أنه في حالة `starting`/`failed`.
- `events_log` و`engine_state` قابلان للقراءة بالشكل الذي تتوقعه محركات الاستعادة.
- `settings.id=1` قابل للقراءة.
- لا تُستخدم استجابة REST ناجحة وحدها كدليل على المخطط؛ يجب فحص المخطط سابقاً.

## 8. اختلافات الترحيلات الفعلية

- `server/migrations/000_full_schema.sql` و`001_init_analyses_schema.sql` يتداخلان في
  إنشاء الجداول الأساسية، لكن الأول يستخدم `id bigint identity` و`ts bigint`، والثاني
  كذلك بعد التعديلات، بينما ملف Verdent الأول يستخدم `serial` و`timestamptz`.
- `server/migrations` يحتوي ترحيلات مختبر السيولة والرسومات اليدوية و`016`؛
  `.verdent/supabase/migrations` لا يحتويها.
- `fresh-install.sql` لا يحتوي `016_public_database_access.sql`، بينما
  `db-bundle.mjs` لا يضيف `016` إلى قائمة `ORDER`.
- `016` يمنح `anon` CRUD على جميع الجداول العامة، بما فيها الجداول الحساسة، ويضيف
  `alter default privileges` واسعة. هذا لا يجوز تطبيقه تلقائياً على قاعدة PostgreSQL
  عادية أو قاعدة جديدة قبل تصميم الصلاحيات.
- `014` يحاول تضييق `anon` مع استثناء مختبر السيولة، لكن الرسومات اليدوية الجديدة
  لا تظهر في استثناءاته التقريبية. يجب أن يبقى `016` صريحاً ومصدر قرار أمني مستقل.
- ملفات `015` و`016` تضيف قيداً على محتوى الرسم يختلف عن التحقق في الخادم؛ يجب أن
  يستخدم الموصلان التحقق نفسه على الحدود، مع بقاء قيد القاعدة كحماية دفاعية.
- `SETUP.md` يذكر «12 ترحيلاً» و«16 جدولاً» بينما القائمة التشغيلية الفعلية تضم
  ترحيلات أكثر وجداول أكثر. سيُصحح وصف المصدر بدلاً من اعتبار الأرقام عقداً ثابتاً.

## 9. مواقع قواعد البيانات المباشرة من المتصفح

| الملف | المسار الحالي | الإجراء المطلوب |
|---|---|---|
| `client/src/lib/manualLiquidity.ts` | `/config` ثم `/rest/v1/liquidity_manual_drawings` | **تمت إزالته في المرحلة الأولى**؛ يستخدم Express الآن |
| `client/src/lib/api.ts` | SDK Supabase لـ`coin_shariah` و`settings` و`events_log` | نقل تدريجي عبر Express، مع استبدال مسار مناطق/إعدادات/شرعية |
| `server/routes/manualLiquidityRouter.mjs` | يعرض `/config` للواجهة | **أُزيل بعد إثبات آخر مستهلك** |

`client/src/lib/api.ts` يعلن `useSupabase=false`، لكن `sbApi` ما زال موجوداً ويُثبت
الاتصال المباشر بعقد التبديل. يجب عدم اعتبار العَلَم الميت دليلاً على إزالة الاعتماد.

## 10. الاختبارات الحالية وما تثبته

خط الأساس على `7340da7`:

- الخادم: 795 اختباراً؛ 793 ناجحاً، 1 فاشلاً بسبب مهلة `liquidityHistory.test.mjs`
  عند تشغيل الكتلة، 1 ملغى من غياب `fast-check` في أول تشغيل قبل تثبيت الاعتماديات.
  إعادة تشغيل `liquidityHistory.test.mjs` واختبار property منفردين نجحت `12/12` و`3/3`.
- العميل: `60/60` ناجحاً قبل تعديلات المرحلة الأولى.
- `npm run build` للعميل نجح.
- اختبارات `manualLiquidity.test.mjs` تثبت التحقق والقراءة والكتابة والحذف وحدود الحجم
  في الخادم ومسارات REST، بينما كانت اختبارات العميل تثبت الوصول المباشر القديم.
- اختبارات `liveRecovery.test.mjs` تثبت فشل الاستعادة المغلق، وإعادة المحاولة، ومنع
  بدء محرك بلا استعادة؛ لكنها تستخدم مصادر صفوف اصطناعية ولا تثبت PostgreSQL واقعياً.
- `liquidityWorkbenchDb.test.mjs` تثبت أن المختبر كان مقصوداً عبر `anon`؛ هذا العقد
  سيُستبدل باستخدام الخادم فقط أو بيانات اعتماد مخصصة، ولا تُحذف تغطية إنشاء النقاط
  والروابط.
- `readiness.test.mjs` يثبت تقييم أعلام محقونة فقط، ولا يوجد اختبار اتصال قاعدة حقيقي
  أو فحص مخطط.

## 11. الأمان ومخاطر البيانات

1. `016` يفتح CRUD لكل جداول public عبر `anon` افتراضياً. هذا ثقب أمني في أي نشر عام.
2. مفتاح `anon` في الواجهة يعني أن أي حماية مستقبلية تعتمد على منع الاتصال من المتصفح
   لا تعمل إلا بعد إزالة SDK والمفاتيح من الحزمة.
3. `SUPABASE_SERVICE_ROLE_CONFIRMED=1` في `setup-env.mjs` إقرار غير مشروط بأن
   الترحيلات المطلوبة قد طُبقت. السكربت لا يعرف حالة القاعدة ولا يفحصها.
4. `storageConfigured()` يختبر وجود URL والمفتاح فقط؛ لا يثبت الاتصال ولا المخطط ولا
   صلاحية الكتابة.
5. `railway.json` يستخدم `/healthz`، وهو سلوك حيوية صحيح. جعلها `/readyz` قد يسبب
   حلقة إعادة تشغيل أثناء استعادة طويلة؛ سيُحتفظ بالفصل مع تحديث فحص الجاهزية الداخلي
   ليصبح قادراً على فحص قاعدة حقيقية بمهلة.
6. `events_log` يحتوي بيانات تشغيل وفرص وسجل قرار؛ سياسات RLS وسياسة النسخ الاحتياطي
   يجب أن تعاملها كبيانات إنتاج وليست بيانات قابلة للإسقاط.

## 12. الخطة الهندسية

1. **المرحلة الأولى:** إزالة اتصال المتصفح بالرسومات، وإضافة اختبارات قراءة/كتابة/حذف
   وoutbox وعدم التكرار. تبقى بيانات الرسومات وشكلها كما هي.
2. **المرحلة الثانية:** استخراج `StorageContract` و`SupabaseRestAdapter`، ثم فصل
   `server/services/binanceRest.mjs` عن `db.js` مع واجهة توافق `db.binance`.
3. **المرحلة الثالثة:** `PostgresAdapter` باستخدام `pg` pool وparameterized queries
   وtransactions حيث يلزم، مع اختيار صريح لمزود واحد وعدم fallback صامت.
4. **المرحلة الرابعة:** مجلد الترحيلات الرسمي ومخطط PostgreSQL الأساسي مفصول عن
   ترحيلات Supabase الخاصة بالدور وRLS. مشغّل migrations مع checksum وregistry.
5. **المرحلة الخامسة:** أدوات preflight/backup/restore/verify وrunbook قطع وتراجع،
   بلا أي تنفيذ إنتاجي في هذه الجولة.
6. **المرحلة السادسة:** readiness يفحص `SELECT 1` والمخطط والإصدار والصلاحيات
   الأساسية والاستعادة، مع مهلة؛ يبقى `/healthz` فحص حيوية مستقلاً.

## 13. قرارات مؤجلة وحدود الموافقة

- لا قاعدة إنتاج ولا ترحيل ولا نسخ/نقل بيانات في هذه الجولة دون موافقة صريحة.
- لا يُطبق `016` تلقائياً على قاعدة جديدة.
- لا يُحوَّل `events_log` إلى جدول جديد أو JSONB.
- لا تُعاد كتابة محركات التداول أو السيولة.
- قبل قطع الإنتاج: نسخة احتياطية، restore إلى قاعدة جديدة، اختبار تكامل، إيقاف كتابة،
  نقل فرق نهائي، تحقق، تغيير `DATABASE_PROVIDER` و`DATABASE_URL`، مراقبة، ثم إبقاء
  القاعدة القديمة للرجوع.
