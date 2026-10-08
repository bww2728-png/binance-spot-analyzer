# بروتوكول الاختبار الأعمى — الفرص الحية (ملزم)

## لماذا
الـ20 حالة الدخانية يراها المطور — تثبت التنفيذ لا التعميم.
المجموعة العمياء تُدار بحيث **لا يرى الكود ولا المطور إجاباتها قبل التنفيذ**.

## الأدوار
1. **المسمّي (أنت/أحمد)**: يبني ملف `blind-labels.json` — كل حالة: `{id, symbol, timeframe, zone, ticks, expected}` حيث `expected` ∈ `sweep_ok | sweep_fail | late | no_reclaim | invalidated`.
2. **المنفذ (النظام)**: `node server/tests/blindRunner.mjs <labels.json>` يشغّل `replayTimeline` لكل حالة ويقارن النتيجة المتوقعة **دون كشف الإجابات في السجل** — يطبع فقط `id: PASS/FAIL` والمجموع.
3. **المصحح (أنت)**: تحكم على النسبة. العتبة المقترحة: ≥90% للانتقال للمرحلة التالية.

## القواعد
- ملف التسميات **لا يُحفظ في المستودع أبدا** (يُمرَّر كمسار خارجي) — حتى لا يتسرب للتدريب أو المراجعة.
- الحالات تغطي: ناجح/فاشل/استعادة 1-2-3/بلا استعادة/تكرار/فجوة/إعادة تشغيل/حدث متعدد الفريمات.
- أي FAIL يُرفق به `phaseTrail` الكامل للتشخيص (يُحفظ محليا فقط).

## صيغة الحالة
```json
{
  "id": "B03",
  "zone": { "symbol": "BTCUSDT", "timeframe": "5m", "id": "z", "kind": "ssl", "referenceLevel": 100, "liquidityLevel": 99, "atr": 1 },
  "atr": 1,
  "reclaimWindowBars": 3,
  "ticks": [{ "price": 103, "at": 1700000000000 }, { "price": 98.5, "at": 1700000060000 }],
  "expected": "sweep_ok"
}
```

## تفسير النتائج المتوقعة
| expected | الشرط |
|---|---|
| `sweep_ok` | حدث `sweep` واحد + حدث `reclaim` (ضمن النافذة) |
| `sweep_fail` | حدث `sweep` + انتهاء `expired/invalidated` بلا `reclaim` |
| `late` | حدث `late_reclaim` بالضبط (وبلا `reclaim`) |
| `no_reclaim` | لا `reclaim` ولا `late_reclaim` |
| `invalidated` | طور نهائي `invalidated` |
