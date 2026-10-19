-- إصلاح جوهري بعد نقل البيانات:
-- النقل أدخل الصفوف بمعرّفاتها الأصلية (حتى 121516 لسجل الأحداث) دون تحريك عدّاد
-- الهوية (identity sequence)، فبدأت الإدراجات الجديدة من 1 وتصادمت مع الصفوف
-- المنقولة → 409 duplicate key على كل حفظ حدث، وتعطّل كشف المناطق وسجل القرارات.
--
-- الحل: ضبط كل عدّاد على (أعلى معرّف موجود + 1). آمن للتشغيل مرات متعددة.
select setval(pg_get_serial_sequence('public.events_log', 'id'),
              coalesce((select max(id) from public.events_log), 1), true);
select setval(pg_get_serial_sequence('public.analyses', 'id'),
              coalesce((select max(id) from public.analyses), 1), true);
select setval(pg_get_serial_sequence('public.cases', 'id'),
              coalesce((select max(id) from public.cases), 1), true);
select setval(pg_get_serial_sequence('public.case_images', 'id'),
              coalesce((select max(id) from public.case_images), 1), true);
select setval(pg_get_serial_sequence('public.health_samples', 'id'),
              coalesce((select max(id) from public.health_samples), 1), true);
