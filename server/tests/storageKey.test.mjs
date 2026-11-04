/**
 * اختيار مفتاح التخزين وهوية الخادم — العيوب التي يحرسها هذا الملف:
 *
 * 1) `server/db.js` كان يقرأ `SUPABASE_KEY = ANON ?? VITE_ ?? ''` فقط. لا مسار لهوية خدمة،
 *    وهذا يجعل تضييق RLS **مستحيلاً**: أي سياسة تمنع `anon` تُعطّل الخادم نفسه.
 *
 * 2) الخطر المضاد مُثبت بالمراجعة: جداول المشروع أُنشئت بمنفّذ لا يطبّق الامتيازات
 *    الافتراضية (منصوص عليه في `011_liquidity_workbench_grants.sql:1-2`)، ومنح
 *    `service_role` محصور بجداول المختبر. فلو فعّل **مجرد وجود المفتاح** الهوية، لتحوّل كل
 *    `rest()` إلى 401/403 بينما `storageConfigured()` يقول «مُهيّأ» و`/readyz` أخضر.
 *    لذلك التفعيل مشروط بإقرار صريح (`SUPABASE_SERVICE_ROLE_CONFIRMED=1`).
 *
 * 3) `isUsingServiceRole` تقارن الهوية لا الوجود: مفتاح عام موضوع في متغيّرة الخدمة
 *    (نسخ/لصق) لا يُعتبر هوية خدمة.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { selectStorageKey, selectPublicKey, isUsingServiceRole } from '../db.js';

const SERVICE = 'sb_secret_EXAMPLE_service_role_value_not_a_real_key';
const ANON = 'sb_publishable_EXAMPLE_anon_value';
const VITE = 'sb_publishable_EXAMPLE_vite_value';

const withService = (extra = {}) => ({
  SUPABASE_SERVICE_ROLE_KEY: SERVICE,
  SUPABASE_SERVICE_ROLE_CONFIRMED: '1',
  SUPABASE_ANON_KEY: ANON,
  ...extra
});

test('بلا إقرار: وجود مفتاح الخدمة لا يغيّر المفتاح المستخدم', () => {
  // هذا هو الحرس ضد الانقطاع: ضبط المفتاح وحده لا يُفعّل هوية بلا منح.
  assert.equal(selectStorageKey({ SUPABASE_SERVICE_ROLE_KEY: SERVICE, SUPABASE_ANON_KEY: ANON }), ANON);
  assert.equal(selectStorageKey({ SUPABASE_SERVICE_ROLE_KEY: SERVICE }), '');
});

test('بإقرار صريح: SERVICE_ROLE يُفضَّل على ANON', () => {
  assert.equal(selectStorageKey(withService()), SERVICE);
});

test('إقرار بقيمة غير "1" لا يُفعّل الهوية', () => {
  for (const value of ['true', 'yes', '0', '', undefined]) {
    assert.equal(
      selectStorageKey({ SUPABASE_SERVICE_ROLE_KEY: SERVICE, SUPABASE_SERVICE_ROLE_CONFIRMED: value, SUPABASE_ANON_KEY: ANON }),
      ANON,
      String(value)
    );
  }
});

test('إقرار بلا مفتاح خدمة ⇒ يسقط إلى المفتاح العام بلا فراغ', () => {
  assert.equal(selectStorageKey({ SUPABASE_SERVICE_ROLE_CONFIRMED: '1', SUPABASE_ANON_KEY: ANON }), ANON);
});

test('ANON يُستخدم عند غياب SERVICE_ROLE (السلوك الحالي بلا تغيير)', () => {
  assert.equal(selectStorageKey({ SUPABASE_ANON_KEY: ANON }), ANON);
});

test('VITE_ احتياط أخير — لا يُهمَل (كان سبب 503 كاذب سابقاً)', () => {
  assert.equal(selectPublicKey({ VITE_SUPABASE_PUBLISHABLE_KEY: VITE }), VITE);
  assert.equal(selectPublicKey({ SUPABASE_ANON_KEY: ANON, VITE_SUPABASE_PUBLISHABLE_KEY: VITE }), ANON);
});

test('selectPublicKey يتجاهل SERVICE_ROLE عمداً (عقد workbench)', () => {
  // سياسة المشروع: workbench يكتب بالمفتاح العام دائماً، وبها اختبار قائم يفرضها
  // (liquidityWorkbenchDb.test.mjs). انتهاكها هنا يُفشل ذلك الاختبار.
  assert.equal(selectPublicKey({ SUPABASE_SERVICE_ROLE_KEY: SERVICE, SUPABASE_ANON_KEY: ANON }), ANON);
  assert.equal(selectPublicKey({ SUPABASE_SERVICE_ROLE_KEY: SERVICE }), '');
});

test('بيئة فارغة ⇒ سلسلة فارغة لا undefined', () => {
  assert.equal(selectStorageKey({}), '');
  assert.equal(typeof selectStorageKey({}), 'string');
});

test('قيمة فارغة صريحة لا تتجاوز التالي في الترتيب', () => {
  // `||` وليس `??`: القيمة الفارغة تعني «غير مضبوط» لا «مضبوط بفراغ».
  assert.equal(selectStorageKey({ SUPABASE_SERVICE_ROLE_KEY: '', SUPABASE_ANON_KEY: ANON }), ANON);
  assert.equal(selectStorageKey(withService({ SUPABASE_SERVICE_ROLE_KEY: '' })), ANON);
});

test('isUsingServiceRole تشترط الإقرار + وجود مفتاح + اختلاف الهوية', () => {
  assert.equal(isUsingServiceRole(withService()), true);
  assert.equal(isUsingServiceRole({ SUPABASE_ANON_KEY: ANON }), false);
  assert.equal(isUsingServiceRole({ SUPABASE_SERVICE_ROLE_KEY: SERVICE, SUPABASE_ANON_KEY: ANON }), false, 'بلا إقرار');
  assert.equal(
    isUsingServiceRole({ SUPABASE_SERVICE_ROLE_CONFIRMED: '1', SUPABASE_ANON_KEY: ANON }),
    false,
    'إقرار بلا مفتاح'
  );
});

test('مفتاح عام موضوع في متغيّرة الخدمة لا يُعتبر هوية خدمة', () => {
  // الخطأ الواقعي الذي تحرسه هذه الحالة: نسخ/لصق المفتاح العام في متغيّرة الخدمة
  // كان يجعل الوثيقة تُعلن «المرحلة 1 ناجحة» ثم يُطبَّق تضييق RLS ⇒ انقطاع تام.
  const copyPaste = {
    SUPABASE_SERVICE_ROLE_KEY: ANON,
    SUPABASE_SERVICE_ROLE_CONFIRMED: '1',
    SUPABASE_ANON_KEY: ANON
  };
  assert.equal(isUsingServiceRole(copyPaste), false);
  assert.equal(selectStorageKey(copyPaste), ANON);
});

test('القيم المختبرية بديلة صريحة — لا مفتاح حقيقي في الملف', () => {
  assert.match(ANON, /EXAMPLE/);
  assert.match(SERVICE, /EXAMPLE/);
});
