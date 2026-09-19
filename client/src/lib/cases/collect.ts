import { useStore } from '../../store/useStore';
import { api } from '../api';
import { captureViews } from './chartViews';
import type { Analysis, CaseActor, LiquidityZone } from '../types';

/* حد الإرسال الأدنى بين لقطات تعديل التحليل لنفس العملة — يمنع ضجيج الكتابة المتكررة */
const MIN_GAP_MS = 30_000;
const lastShot = new Map<string, number>();

interface BaseCase {
  symbol: string;
  actor: CaseActor;
  before: Analysis | null;
  after: Analysis | null;
  note?: string | null;
  zone?: LiquidityZone | null;
  zones?: LiquidityZone[];
  sendCharts?: boolean;
  screenshots?: { tf: string; dataUrl: string }[];
}

function buildBody(c: BaseCase) {
  const st = useStore.getState();
  const decidedAt = Date.now();
  return {
    symbol: c.symbol,
    actor: c.actor,
    decided_at: decidedAt,
    snapshot: {
      livePrice: st.prices[c.symbol] ?? null,
      charts: c.sendCharts === false ? [] : captureViews(c.symbol),
      zones: c.zones ?? [],
      analysis: c.before,
      analysisAfter: c.after,
      note: c.note ?? null,
      zone: c.zone ?? null,
      screenshots: c.screenshots ?? []
    }
  };
}

function ship(body: Parameters<typeof api.createCase>[0]) {
  void api.createCase(body).catch(() => undefined);
}

/** قرار منطقة يدوية (إنشاء/تعديل/حذف) أو تغذية راجعة على منطقة آلية */
export function shipZoneCase(c: {
  symbol: string;
  actor: 'zone_create' | 'zone_edit' | 'zone_delete' | 'zone_auto_feedback' | 'zone_auto_note';
  before?: Analysis | null;
  after?: Analysis | null;
  note?: string | null;
  zone?: LiquidityZone | null;
  zones?: LiquidityZone[];
  screenshots?: { tf: string; dataUrl: string }[];
}) {
  ship(buildBody({
    symbol: c.symbol, actor: c.actor,
    before: c.before ?? null, after: c.after ?? null,
    note: c.note ?? null, zone: c.zone ?? null, zones: c.zones ?? [],
    screenshots: c.screenshots ?? []
  }));
}

/** تعديل حقول تحليل — مختنق زمنياً (أقصى لقطة كل 30 ثانية لنفس العملة) */
export function shipAnalysisEdit(symbol: string, before: Analysis | null, after: Analysis | null) {
  const now = Date.now();
  if (!before && !after) return;
  if (before && after && JSON.stringify(before) === JSON.stringify(after)) return;
  const prev = lastShot.get(symbol) ?? 0;
  if (now - prev < MIN_GAP_MS) return;
  lastShot.set(symbol, now);
  ship(buildBody({ symbol, actor: 'analysis_edit', before, after }));
}

/** إضافة/إزالة عملة من اللوحة (بلا شارت مفتوح) */
export function shipCoinEvent(symbol: string, actor: 'coin_add' | 'coin_remove', before: Analysis | null, after: Analysis | null) {
  ship(buildBody({ symbol, actor, before, after, sendCharts: false }));
}