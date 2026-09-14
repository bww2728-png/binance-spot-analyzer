import type { Analysis } from './types';

export type Tri = 0 | 1 | null;

export interface SortInput {
  analysis: Analysis;
  livePrice: number | null;
}

export interface SortResultRow {
  analysis: Analysis;
  group: SortGroup;
  distancePct: number | null;
}

export type SortGroup =
  | 'up_to_ssl'
  | 'down_touched_bsl_then_ssl'
  | 'down_touched_bsl_only'
  | 'down_not_touched_bsl'
  | 'incomplete';

export const GROUP_LABELS: Record<SortGroup, string> = {
  up_to_ssl: 'صاعدة — الأقرب إلى SSL',
  down_touched_bsl_then_ssl: 'هابطة — لمست BSL ثم SSL',
  down_touched_bsl_only: 'هابطة — لمست BSL فقط',
  down_not_touched_bsl: 'هابطة — لم تلمس BSL',
  incomplete: 'غير مكتملة'
};

export const GROUP_ORDER: SortGroup[] = [
  'up_to_ssl',
  'down_touched_bsl_then_ssl',
  'down_touched_bsl_only',
  'down_not_touched_bsl',
  'incomplete'
];

const isTrue = (v: Tri) => v === 1;

/** السوق "صاعد" إذا كان صاعداً في الفريم الأصغر أو الأكبر */
export function isUptrend(a: Analysis): boolean {
  return a.trend_lower === 'up' || a.trend_upper === 'up';
}

export function isDowntrend(a: Analysis): boolean {
  return a.trend_lower === 'down' && a.trend_upper === 'down';
}

export function classify(a: Analysis): SortGroup {
  if (!a.trend_lower && !a.trend_upper) return 'incomplete';
  if (isUptrend(a)) return 'up_to_ssl';
  if (isDowntrend(a)) {
    if (isTrue(a.bsl_touched) && isTrue(a.ssl_touched)) return 'down_touched_bsl_then_ssl';
    if (isTrue(a.bsl_touched)) return 'down_touched_bsl_only';
    return 'down_not_touched_bsl';
  }
  return 'incomplete';
}

/** المسافة النسبية من السعر الحي إلى المنطقة (%) — المنطقة هي المقام */
export function distancePct(live: number | null, zone: number | null): number | null {
  if (live === null || zone === null || !Number.isFinite(live) || !Number.isFinite(zone) || zone <= 0) return null;
  return Math.abs(live - zone) / zone * 100;
}

/**
 * ترتيب قواعد الاستراتيجية:
 * 1) الصاعدة: الأقرب إلى SSL
 * 2) الهابطة التي لمست BSL ثم SSL: الأقرب إلى BSL التي لمستها
 * 3) الهابطة التي لمست BSL فقط: الأقرب إلى SSL
 * 4) الهابطة التي لم تلمس BSL: الأقرب إلى BSL
 * 5) غير المكتملة أخيراً (حسب الاسم)
 */
export function sortAnalyses(items: SortInput[]): SortResultRow[] {
  const rows: SortResultRow[] = items.map(({ analysis, livePrice }) => {
    const group = classify(analysis);
    const zone =
      group === 'up_to_ssl' ? analysis.ssl_price
      : group === 'down_touched_bsl_then_ssl' ? analysis.bsl_price
      : group === 'down_touched_bsl_only' ? analysis.ssl_price
      : group === 'down_not_touched_bsl' ? analysis.bsl_price
      : null;
    return { analysis, group, distancePct: distancePct(livePrice, zone) };
  });

  const groupRank = (g: SortGroup) => GROUP_ORDER.indexOf(g);
  rows.sort((x, y) => {
    const gr = groupRank(x.group) - groupRank(y.group);
    if (gr !== 0) return gr;
    if (x.distancePct === null && y.distancePct === null) return x.analysis.symbol.localeCompare(y.analysis.symbol);
    if (x.distancePct === null) return 1;
    if (y.distancePct === null) return -1;
    return x.distancePct - y.distancePct;
  });
  return rows;
}
