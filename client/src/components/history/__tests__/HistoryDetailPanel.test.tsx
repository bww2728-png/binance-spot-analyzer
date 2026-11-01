import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { buildElements } from '../../../../../shared/historyModel.mjs';
import type { HistoryElement } from '../../../../../shared/historyModel.mjs';
import type { LiquidityHistoryResponse } from '../../../lib/liquidityHistory';
import HistoryDetailPanel from '../HistoryDetailPanel';
import { buildLegacy, buildV2, elementOf, legacyZone, responseOf, v2UntimedZone } from './fixtures';

afterEach(cleanup);

const renderPanel = (
  element: HistoryElement,
  data: LiquidityHistoryResponse,
  cursorTime: number,
  replay = false
) =>
  render(
    <HistoryDetailPanel
      element={element}
      data={data}
      cursorTime={cursorTime}
      replay={replay}
      onClose={() => {}}
      onJump={() => {}}
    />
  );

describe('HistoryDetailPanel — بيانات المصدر وسلسلة التوقيت', () => {
  const legacy = buildLegacy();
  const element = elementOf(legacy, 'zone:Z1');

  it('يعرض الأزمنة الموجودة فقط في مخرجات المحرك', () => {
    renderPanel(element, responseOf('legacy', [legacyZone]), 1300);
    expect(screen.getByText('النشأة (createdAt):')).toBeTruthy();
    expect(screen.getByText('أول معرفة (availableAt):')).toBeTruthy();
    expect(screen.getByText('التأكيد (confirmedAt):')).toBeTruthy();
    expect(screen.getByText('السويب (sweptAt):')).toBeTruthy();
    // invalidatedAt فارغ في المصدر ⇒ لا سطر مخترع
    expect(screen.queryByText('الإبطال (invalidatedAt):')).toBeNull();
  });

  it('لا يعرض سطر التأكيد حين لا ينتجه المحرك، ويعلن غياب الأزمنة بدل اختراعها', () => {
    const v2 = buildElements({ engine: 'v2', zones: [{ ...v2UntimedZone }] });
    renderPanel(elementOf(v2, 'zone:Z2'), responseOf('v2', [v2UntimedZone]), 6000);
    expect(screen.queryByText('التأكيد (confirmedAt):')).toBeNull();
    expect(screen.queryByText('السويب (sweptAt):')).toBeNull();
    expect(screen.queryByText('الإبطال (invalidatedAt):')).toBeNull();
    expect(screen.getByText('النشأة (createdAt):')).toBeTruthy();
  });

  it('يعلن صراحةً أن detectedAt لا يُستخدم في قرار الظهور', () => {
    renderPanel(element, responseOf('legacy', [legacyZone]), 1300);
    const note = screen.getByText(/لا يُستخدم في قرار الظهور التاريخي/);
    expect(note.textContent).toContain('detectedAt');
  });

  it('عنصر بلا أي زمن معلن يعرض «لا أزمنة في مخرجات هذا العنصر»', () => {
    const timeless = {
      ...legacyZone,
      id: 'Z3',
      createdAt: null,
      availableAt: null,
      confirmedAt: null,
      sweptAt: null,
      invalidatedAt: null,
      detectedAt: null
    };
    const built = buildElements({ engine: 'legacy', zones: [timeless] });
    renderPanel(elementOf(built, 'zone:Z3'), responseOf('legacy', [timeless]), 1000);
    expect(screen.getByText('لا أزمنة في مخرجات هذا العنصر')).toBeTruthy();
  });
});

describe('HistoryDetailPanel — الحالة عند المؤشر تتبع الأزمنة الحقيقية', () => {
  const legacy = buildLegacy();
  const element = elementOf(legacy, 'zone:Z1');
  const data = responseOf('legacy', [legacyZone]);

  const stateLabelAt = (t: number) => {
    const { unmount } = renderPanel(element, data, t);
    const found = ['غير معروفة بعد', 'مرشحة', 'مؤكدة', 'مسحوبة', 'مبطلة']
      .find((label) => screen.queryByText(`عند المؤشر: ${label}`) != null);
    unmount();
    return found ?? null;
  };

  it('pending قبل availableAt، ثم candidate، ثم confirmed، ثم swept', () => {
    expect(stateLabelAt(900)).toBe('غير معروفة بعد'); // قبل النشأة
    expect(stateLabelAt(1000)).toBe('غير معروفة بعد'); // عند النشأة وقبل المعرفة
    expect(stateLabelAt(1060)).toBe('مرشحة'); // عند لحظة المعرفة
    expect(stateLabelAt(1199)).toBe('مرشحة'); // قبل التأكيد
    expect(stateLabelAt(1200)).toBe('مؤكدة'); // عند التأكيد
    expect(stateLabelAt(1999)).toBe('مؤكدة'); // قبل السويب
    expect(stateLabelAt(2000)).toBe('مسحوبة'); // عند السويب
  });

  it('يعرض الحالة النهائية كما سجّلها المحرك بجانب الحالة عند المؤشر', () => {
    renderPanel(element, data, 1300);
    expect(screen.getByText('الحالة النهائية في المحرك: swept')).toBeTruthy();
  });

  it('يُظهر شارة «وضع التتبع» فقط في وضع التتبع', () => {
    const { unmount } = renderPanel(element, data, 1300, false);
    expect(screen.queryByText('وضع التتبع')).toBeNull();
    unmount();
    renderPanel(element, data, 1300, true);
    expect(screen.getByText('وضع التتبع')).toBeTruthy();
  });
});

describe('HistoryDetailPanel — أحداث البنية تُقيَّد بنطاق حياة المنطقة', () => {
  const v2 = buildV2();
  const element = elementOf(v2, 'zone:Z2');
  const evt = (key: string, availableAt: number) => ({
    key,
    type: 'bos_up',
    index: 1,
    time: availableAt,
    price: 100,
    brokenLevel: 99,
    brokenPivotIndex: 1,
    brokenPivotTime: availableAt,
    brokenIndex: 2,
    brokenTime: availableAt,
    confirmBasis: 'close',
    external: true,
    priorBos: null,
    idmLevel: null,
    availableAt,
    confirmed: true,
    evidence: null
  });

  it('يستبعد الأحداث السابقة لنشأة المنطقة واللاحقة لمؤشر الوقت', () => {
    const data = responseOf('v2', [v2UntimedZone], [
      evt('bos_up:before', 4000), // قبل النشأة 5000
      evt('bos_up:inside', 6000), // داخل النطاق
      evt('bos_up:after', 9000) // بعد المؤشر 8000
    ]);
    renderPanel(element, data, 8000);
    expect(screen.getByText('أحداث البنية داخل نطاق حياة المنطقة (1)')).toBeTruthy();
  });

  it('لا يعرض القسم إطلاقاً بلا أحداث داخل النطاق', () => {
    const data = responseOf('v2', [v2UntimedZone], [evt('bos_up:before', 4000)]);
    renderPanel(element, data, 8000);
    expect(screen.queryByText(/أحداث البنية داخل نطاق حياة المنطقة/)).toBeNull();
  });
});

describe('HistoryDetailPanel — بيانات المصدر وأزمنة النقر', () => {
  const legacy = buildLegacy();
  const element = elementOf(legacy, 'zone:Z1');

  it('يعرض JSON المصدر كما هو ويعطي أزمنة صحيحة لدالة الانتقال', () => {
    const onJump = vi.fn();
    const { container } = render(
      <HistoryDetailPanel
        element={element}
        data={responseOf('legacy', [legacyZone])}
        cursorTime={1300}
        replay={false}
        onClose={() => {}}
        onJump={onJump}
      />
    );
    const pre = container.querySelector('pre');
    expect(pre?.textContent).toContain('"kind": "horizontal_bsl"');
    expect(pre?.textContent).toContain('"availableAtBasis": "pivot_confirm"');

    // زر «انتقل» بجانب «النشأة (createdAt)» يجب أن يعطي زمن النشأة الحقيقي 1000
    const row = screen.getByText('النشأة (createdAt):').parentElement;
    const jump = row?.querySelector('button');
    expect(jump?.textContent).toBe('انتقل');
    jump?.click();
    expect(onJump).toHaveBeenCalledWith(1000);
  });
});
