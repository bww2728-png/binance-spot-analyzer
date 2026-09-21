export type Trend = 'up' | 'down';
export type ChochUp = 'yes' | 'no';

export const TIMEFRAMES = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w'] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

export interface Analysis {
  id: number;
  symbol: string;
  trend_lower: Trend | null;
  tf_lower: Timeframe | null;
  trend_upper: Trend | null;
  tf_upper: Timeframe | null;
  ext_bsl_sweep: 0 | 1 | null;
  ext_supply_touch: 0 | 1 | null;
  int_bsl_sweep: 0 | 1 | null;
  sellers_induced: 0 | 1 | null;
  int_ssl_sweep: 0 | 1 | null;
  ssl_price: number | null;
  bsl_price: number | null;
  bsl_touched: 0 | 1 | null;
  ssl_touched: 0 | 1 | null;
  passed_bsl_after_ssl: 0 | 1 | null;
  choch_up: ChochUp | null;
  notes: string | null;
  notify_enabled: 0 | 1 | null;
  created_at: number;
  updated_at: number;
}

export interface CoinFlag {
  symbol: string;
  halal: 0 | 1;
  barcode: 0 | 1;
  updated_at: number;
}

export interface BarcodeScan {
  symbol: string;
  is_barcode: boolean;
  score: number;
  gap_count: number;
  big_wick_count: number;
  candles_count: number;
  threshold: number;
  reason: string;
  status: 'success' | 'failed';
  source: string | null;
  scanned_at: number;
}

export interface FactExtract {
  value: boolean | null;
  confidence: number;
  source: string;
}

export interface ShariahResearch {
  status: 'documented' | 'insufficient' | 'not_found' | 'failed';
  coinName: string | null;
  geckoId: string | null;
  facts: Record<string, FactExtract>;
  gated: Record<string, boolean | null>;
  confidence: number;
  summary: { resolvedRaw: number; resolvedGated: number };
  sources: string[];
  message: string;
}

export interface LiquidityZone {
  id: string;
  symbol: string;
  type: 'BSL' | 'SSL';
  price: number;
  timeframe: string;
  note: string;
  created_at: number;
  expires_at: number | null;
  active: boolean;
  /* مناطق الكشف الآلي */
  source?: 'auto' | 'manual';
  score?: number;
  reasons?: string[];
  clusterCount?: number;
  swept?: boolean;
  bandPct?: number | null;
  anchorTime?: number | null;
  feedback?: 'confirm' | 'reject' | null;
  updated_at?: number;
}

/** تقرير مطابقة الكشف الآلي مع مناطق التعليم اليدوي */
export interface ZonesAccuracy {
  symbols: { symbol: string; manualCount: number; autoCount: number; matchedManual: number; matchedAuto: number; precision: number | null; recall: number | null }[];
  totals: { manualCount: number; autoCount: number; matchedManual: number; matchedAuto: number; precision: number | null; recall: number | null };
  calibration: { minScore: number; eqhTolerancePct: number; matchTolerancePct: number; updated_at: number };
}

export interface LiquidityZoneEvent {
  type: 'zone_near' | 'zone_swept';
  symbol: string;
  zone: LiquidityZone;
  price: number;
}

export interface ShariahResearchStatus {
  pending: number;
  documented: number;
  autoDocumented: number;
  insufficient: number;
  notFound: number;
  lastRunAt: number;
  changes: { symbol: string; message: string; meta: { from?: string; to?: string; source?: string } | null; ts: number }[];
}

/** صف التصنيف الشرعي المخزن لكل عملة */
export interface CoinShariahRow {
  symbol: string;
  verdict: 'halal' | 'haram' | 'uncertain';
  facts: Record<string, unknown>;
  reasons: string[];
  evidence: { id: string; text: string; ref: string; grade: string; type: string }[];
  source: string | null;
  notes: string | null;
  updated_at: number;
}

export interface Settings {
  id: number;
  quote: string;
  notify_timeout_min: number;
  sound_enabled: 0 | 1;
  sort_config: string;
}

export interface EventLog {
  id: number;
  ts: number;
  symbol: string;
  type: string;
  message: string;
  meta: string | null;
}

export interface CaseImage {
  id: number;
  case_id: number;
  tf: string;
  data_url: string;
  captured_at: number;
}

export interface ZoneHistoryVersion {
  eventId: number;
  ts: number;
  action: 'create' | 'edit' | 'delete';
  zone: LiquidityZone;
}

export interface ZoneHistoryGroup {
  zoneId: string;
  symbol: string;
  versions: ZoneHistoryVersion[];
  deleted: boolean;
  lastVersion: ZoneHistoryVersion;
}

export interface Candle {
  time: number; // seconds
  open: number;
  high: number;
  low: number;
  close: number;
}

/* ================= سجل القرارات (Case Ledger) ================= */

export type CaseActor =
  | 'zone_create' | 'zone_edit' | 'zone_delete'
  | 'zone_auto_feedback' | 'zone_auto_note'
  | 'analysis_edit' | 'coin_add' | 'coin_remove';

export interface CaseChartView {
  tf: string;
  tfSec: number;
  decidedAtSec: number;
  candles: Candle[];
  stats: {
    closedCount: number;
    lastClose: number | null;
    stats: {
      zones: { type: string; price: number; clusterCount: number; swept: boolean; fvgNear: boolean; bandPct: number }[];
      eqh: { price: number; count: number }[];
      eql: { price: number; count: number }[];
      fvgs: { time: number; top: number; bottom: number; dir: string }[];
      refHigh: number | null;
      refLow: number | null;
      pivots: { time: number; price: number; kind: string }[];
    } | null;
  };
}

export interface CaseThermal {
  funding: { last: number; markPrice: number } | null;
  oi: { changePct: number; latest: number } | null;
  longShort: { last: number } | null;
  cvd: { recentSum: number; buyRatioPct: number | null; window: number } | null;
  book: { book: number | null; icebergs: { price: number; hits: number; totalQty: number; sizeConsistency: number }[]; spoofs: { price: number; qty: number; traded: number }[] } | null;
  liqClusters: { side: string; lev: number; price: number; magnitude: number }[] | null;
  fearGreed: { available: boolean; value?: number; classification?: string | null; ts?: number | null } | null;
  stables: { available: boolean; totalMcapUsd?: number; pegged?: { symbol: string; mcapUsd: number }[] } | null;
  decidedAt?: number;
}

export interface CasePayload {
  meta: { symbol: string; actor: CaseActor; decided_at: number; livePrice: number | null };
  chart: Record<string, CaseChartView>;
  zones: LiquidityZone[];
  analysisBefore: Analysis | null;
  analysisAfter: Analysis | null;
  note: string | null;
  zone: LiquidityZone | null;
  thermal: CaseThermal;
}

export interface CaseRow {
  id: number;
  symbol: string;
  actor: CaseActor;
  decided_at: number;
  payload: CasePayload;
}

/* ================= السجل التاريخي للتحديد الآلي ================= */

/** صف مسطح من لقطة الكشف الآلي — يخدم جدول السجل الآلي */
export interface AutoHistoryRow {
  zoneKey: string;
  snapshotTs: number;
  computedAt: number;
  eventId: number;
  symbol: string;
  id: string;
  type: 'BSL' | 'SSL';
  price: number;
  timeframe: string;
  score: number | null;
  reasons: string[];
  clusterCount: number | null;
  swept: boolean;
  sweptAt: number | null;
  bandPct: number | null;
  anchorTime: number | null;
  feedback: 'confirm' | 'reject' | null;
  note: string;
  meta: string;
  side: string | null;
}

export interface AutoHistoryResponse {
  rows: AutoHistoryRow[];
  total: number;
  limit: number;
  offset: number;
  fabioOnly: boolean;
}

/** صورة شارت محفوظة لحظة التحديد الآلي — مرتبطة بمنطقة عبر zoneKey (ts يُضاف عند القراءة) */
export interface AutoZoneScreenshot {
  zoneKey: string;
  symbol: string;
  timeframe: string;
  type: 'BSL' | 'SSL';
  price: number | null;
  dataUrl: string;
  capturedAt: number;
  ts?: number;
}

// ==================== الباك تيست ====================
export interface BacktestTrade {
  symbol: string;
  timeframe: string;
  zoneType: 'BSL' | 'SSL';
  zoneId?: string;
  zonePrice: number;
  score: number;
  reasons: string[];
  clusterCount?: number;
  swept?: boolean;
  bandPct?: number;
  ts: number | null;
  detectTime?: number;
  entry: number;
  protectedPrice: number;
  win: 0 | 1 | undefined;
  exit: number;
  bars: number;
  undecided?: boolean;
  rr: number;
  kelly: number;
  fF: number;
  units: number;
}

export interface BacktestPair {
  symbol: string;
  timeframe: string;
  trades: BacktestTrade[];
  reason?: string;
}

export interface BacktestLearn {
  enough: boolean;
  message?: string;
  trainCount?: number;
  validationCount?: number;
  rules?: { minScore: number; allowSwept: boolean; requireCluster: boolean; requireBubble: boolean; kept: number; winRate: number } | null;
  weights?: Record<string, number>;
  evalBefore?: { kept: number; winRate: number | null; avgRR: number | null };
  evalAfter?: { kept: number; winRate: number | null; avgRR: number | null };
  winRate?: number;
}

export interface BacktestFrameStat {
  timeframe: string;
  decided: number;
  wins: number;
}

export interface BacktestSummary {
  total: number;
  decided: number;
  wins: number;
  winRate: number | null;
  avgRR: number | null;
  avgBars: number | null;
  perFrame: BacktestFrameStat[];
}

export interface BacktestCustomRun {
  symbol: string;
  timeframe: string;
  fromTs: number | null;
  toTs: number | null;
  at: number;
  result: { symbol: string; timeframe: string; trades: BacktestTrade[]; reason?: string };
}

export interface BacktestResults {
  exists: boolean;
  message?: string;
  cycle?: number;
  startedAt?: number;
  lastRunAt?: number;
  total?: number;
  results: BacktestPair[];
  summary?: BacktestSummary;
  learn: BacktestLearn | null;
  custom?: BacktestCustomRun | null;
}

export interface LiveOpportunity {
  symbol: string;
  timeframe: string;
  zoneType: 'BSL' | 'SSL';
  zoneId?: string;
  zonePrice: number;
  score: number;
  reasons: string[];
  clusterCount?: number;
  swept?: boolean;
  bandPct?: number;
  ts: number;
  price: number;
  entry: number;
  stop: number;
  tp: number;
  protectedPrice: number;
  distPct: number;
  rr: number;
  kelly: number;
  fF: number;
  units: number;
  rotation: number;
  targets?: number[];
  decision: { action: string; reason: string; freeEnergy?: number };
}

export interface LiveOpportunitiesResponse {
  busy: boolean;
  rotation: number;
  pairsDone: number;
  pairsTotal: number;
  opportunities: LiveOpportunity[];
  total: number;
  updatedAt: number | null;
  error: string | null;
}

export type LiquidityZoneKind =
  | 'horizontal_bsl'
  | 'horizontal_ssl'
  | 'trendline_bsl'
  | 'trendline_ssl';

export type LiquidityZoneState = 'potential' | 'candidate' | 'confirmed' | 'swept';

export interface LiquidityDetection {
  id: string;
  symbol: string;
  timeframe: string;
  kind: LiquidityZoneKind;
  referenceLevel: number;
  liquidityLevel: number;
  retailStop: number;
  state: LiquidityZoneState;
  createdAt: number;
  confirmedAt: number | null;
  sweptAt: number | null;
  confidence: number;
  touches: number;
  touchPoints: { index: number; time: number; price: number }[];
  staircase: { valid: boolean; breaks: { index: number; time: number; reactionPrice: number }[]; missingAt: number } | null;
  finalBreak: { breakTime: number | null; reactionPrice: number } | null;
  prominenceAtr: number;
  atr: number;
  distanceAtr: number;
  reasons: string[];
  premium: { low: number; high: number; position: number; premium: boolean; fib: { low: number; high: number; midpoint: number } } | null;
  trendline: { points: { time: number; price: number }[]; slope: number; errorAtr: number; projected: number } | null;
  invalidation: string;
  lastPrice: number | null;
  detectedAt: number;
  source: string;
  mode?: 'live' | 'history';
  rotation?: number;
  workOrder?: number;
  review?: { verdict: string; note: string; correction?: unknown; ts: number };
  reviewVersion?: number;
}

export interface LiquidityZoneEngineStatus {
  live: { busy: boolean; rotation: number; pairsDone: number; pairsTotal: number; total: number };
  history: { busy: boolean; rotation: number; pairsDone: number; pairsTotal: number; total: number };
  adjustment: { tolerancePct: number; examples: number; updatedAt?: number };
  updatedAt: number | null;
  error: string | null;
}

export interface BacktestStatus {
  busy: boolean;
  continuous?: boolean;
  cycle?: number;
  startedAt: number | null;
  lastRunAt: number | null;
  pairsDone: number;
  pairsTotal: number;
  targetsCount: number;
  targets: string[];
  customBusy?: boolean;
  error: string | null;
}