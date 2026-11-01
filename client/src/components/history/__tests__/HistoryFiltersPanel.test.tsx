import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { defaultFilters } from '../../../../../shared/historyModel.mjs';
import type { HistoryFilters, HistoryMeta, SelectionCounts } from '../../../../../shared/historyModel.mjs';
import HistoryFiltersPanel from '../HistoryFiltersPanel';

afterEach(cleanup);

const OPTIONS = {
  types: [
    { id: 'horizontal_bsl', label: 'BSL أفقي', color: '#f00', count: 307 },
    { id: 'horizontal_ssl', label: 'SSL أفقي', color: '#0f0', count: 297 },
    { id: 'trendline_bsl', label: 'خط هابط BSL', color: '#00f', count: 1 }
  ],
  states: [
    { id: 'confirmed', label: 'مؤكدة' },
    { id: 'swept', label: 'مسحوبة' }
  ],
  formations: [
    { id: 'pivots', label: 'بيفوتات' },
    { id: 'trendline', label: 'خط اتجاه' }
  ]
};

const META: HistoryMeta = {
  engine: 'legacy',
  engineTypes: ['horizontal_bsl', 'horizontal_ssl', 'trendline_bsl', 'trendline_ssl'],
  typesPresent: ['horizontal_bsl'],
  statesPresent: ['swept'],
  formationsPresent: ['pivots'],
  gaps: [],
  untimedCount: 0
};

const COUNTS: SelectionCounts = {
  total: 34_756,
  visible: 34_000,
  hidden: {
    replay: 100,
    untimed: 6,
    type: 0,
    state: 400,
    formation: 0,
    strength: 0,
    time: 0,
    price: 0,
    history: 250
  }
};

const setup = (over: Partial<{ open: boolean; filters: HistoryFilters; meta: HistoryMeta; counts: SelectionCounts }> = {}) => {
  const onChange = vi.fn();
  const onReset = vi.fn();
  const onToggle = vi.fn();
  const props = {
    open: over.open ?? true,
    onToggle,
    options: OPTIONS,
    filters: over.filters ?? defaultFilters(),
    meta: over.meta ?? META,
    counts: over.counts ?? COUNTS,
    range: { from: 1_000_000, to: 2_000_000 },
    onChange,
    onReset
  };
  const view = render(<HistoryFiltersPanel {...props} />);
  return { ...view, onChange, onReset, onToggle };
};

describe('HistoryFiltersPanel — العدّادات والعرض', () => {
  it('يعرض الإجمالي والمرئي ومجموع المخفي كما وصل من اختيار العناصر', () => {
    setup();
    expect(screen.getByText(/إجمالي 34756 · مرئي 34000 · مخفي 756/)).toBeTruthy();
  });

  it('يطوي الجسد عند open=false فلا تظهر أزرار الفلاتر', () => {
    setup({ open: false });
    expect(screen.queryByText('إخفاء الكل')).toBeNull();
    expect(screen.getByText(/الفلاتر والتحكم بالعرض/)).toBeTruthy();
  });

  it('يفصّل أسباب الإخفاء بأرقامها الحقيقية بلا اختراع', () => {
    setup();
    expect(screen.getByText('لم يقع بعد:').textContent).toContain('100');
    expect(screen.getByText('حالة:').textContent).toContain('400');
    expect(screen.getByText('منتهية:').textContent).toContain('250');
    expect(screen.getByText('غير مؤرخة:').textContent).toContain('6');
    // أسباب صفرية لا تُعرض إطلاقاً
    expect(screen.queryByText('نوع:')).toBeNull();
    expect(screen.queryByText('سعر:')).toBeNull();
  });

  it('يعرض شارة عدد الفلاتر المفعّلة', () => {
    const filters = defaultFilters();
    filters.confirmedOnly = true;
    filters.minTouches = 3;
    setup({ filters });
    expect(screen.getByText('2 مفعّل')).toBeTruthy();
  });
});

describe('HistoryFiltersPanel — الفلاتر تغيّر العرض فقط', () => {
  it('قلب نوع واحد يمرّر نسخة كاملة من الفلاتر مع تعطيل ذلك النوع وحده', () => {
    const { onChange } = setup();
    fireEvent.click(screen.getByTitle('307 عنصراً من هذا النوع في البيانات'));
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as HistoryFilters;
    expect(next.types.horizontal_bsl).toBe(false);
    expect(next.types.horizontal_ssl).toBeUndefined();
    expect(next.showHistory).toBe(true); // بقية الفلاتر كما هي
  });

  it('«إخفاء الكل» يعطّل كل أنواع المحرك المعروضة دون حذف أي عنصر من البيانات', () => {
    const { onChange } = setup();
    fireEvent.click(screen.getByText('إخفاء الكل'));
    const next = onChange.mock.calls[0][0] as HistoryFilters;
    expect(next.types).toEqual({ horizontal_bsl: false, horizontal_ssl: false, trendline_bsl: false });
  });

  it('«إظهار الكل» يفرّغ خريطة الأنواع (الافتراضي = الكل مرئي)', () => {
    const filters = defaultFilters();
    filters.types = { horizontal_bsl: false, horizontal_ssl: false };
    const { onChange } = setup({ filters });
    fireEvent.click(screen.getByText('إظهار الكل'));
    const next = onChange.mock.calls[0][0] as HistoryFilters;
    expect(next.types).toEqual({});
  });

  it('تصفية زمنية سريعة تحترم حدود النطاق ولا تتجاوزه', () => {
    const { onChange } = setup();
    fireEvent.click(screen.getByText('آخر 500 شمعة'));
    const next = onChange.mock.calls[0][0] as HistoryFilters;
    expect(next.timeFrom).toBe(2_000_000 - 500 * 60);
    expect(next.timeTo).toBeNull();
  });

  it('«استعادة الافتراضي» ينادي onReset', () => {
    const { onReset } = setup();
    fireEvent.click(screen.getByText('استعادة الافتراضي'));
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it('«المؤكدة فقط» تبديل حقيقي على الفلاتر', () => {
    const { onChange } = setup();
    const input = screen.getByText('المؤكدة فقط').querySelector('input');
    expect(input).not.toBeNull();
    fireEvent.click(input as HTMLInputElement);
    const next = onChange.mock.calls[0][0] as HistoryFilters;
    expect(next.confirmedOnly).toBe(true);
  });

  it('«العناصر غير المؤرخة في وضع التتبع» معطّل افتراضياً ومُعلن بسببه', () => {
    setup();
    const label = screen.getByText('العناصر غير المؤرخة في وضع التتبع');
    expect(label.getAttribute('title')).toContain('قد يوحي بمعرفة سابقة');
  });
});

describe('HistoryFiltersPanel — إعلان فجوات البيانات', () => {
  it('يعرض الفجوات الموثقة ولا يخترع لها قيماً', () => {
    setup({ meta: { ...META, gaps: ['v2 لا ينتج horizontal_ssl'] } });
    expect(screen.getByText(/فجوات بيانات موثقة \(1\) — لا تُخترع لها قيم/)).toBeTruthy();
    expect(screen.getByText('v2 لا ينتج horizontal_ssl')).toBeTruthy();
  });

  it('لا يعرض قسم الفجوات حين لا توجد فجوات', () => {
    setup();
    expect(screen.queryByText(/فجوات بيانات موثقة/)).toBeNull();
  });
});
