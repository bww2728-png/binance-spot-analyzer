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

export interface Candle {
  time: number; // seconds
  open: number;
  high: number;
  low: number;
  close: number;
}
