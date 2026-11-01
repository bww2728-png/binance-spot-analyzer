/**
 * أنواع نموذج الشارت التاريخي — تُطابق shared/historyModel.mjs حرفياً.
 */

export type HistoryEngine = 'legacy' | 'v2';

export interface HistoryPoint {
  index: number | null;
  time: number;
  price: number;
  availableAt: number | null;
}

export interface HistoryTrend {
  points: Array<{ index: number | null; time: number; price: number }>;
  slope: number | null;
  projected: number | null;
  errorAtr: number | null;
}

export interface HistoryBreak {
  time: number;
  price: number;
}

export interface HistoryElement {
  id: string;
  typeId: string;
  shape: 'box' | 'band' | 'level' | 'trendline' | 'event' | 'marker';
  zoneId: string | null;
  label: string;
  color: string;
  rgb: string;
  state: string | null;
  createdAt: number | null;
  availableAt: number | null;
  confirmedAt: number | null;
  confirmedBasis: string;
  sweptAt: number | null;
  invalidatedAt: number | null;
  endAt: number | null;
  untimed: boolean;
  high: number | null;
  low: number | null;
  bodyHigh: number | null;
  bodyLow: number | null;
  price: number | null;
  priceAlt: number | null;
  liquidity: number | null;
  retailStop: number | null;
  points: HistoryPoint[];
  trend: HistoryTrend | null;
  touches: number | null;
  confidence: number | null;
  atr: number | null;
  distanceAtr: number | null;
  formation: string | null;
  fvgs: Array<{ index?: number; time?: number; kind?: string; top: number; bottom: number; availableAt?: number | null; invalidatedAt?: number | null }>;
  breaks: HistoryBreak[];
  eventKeys: string[];
  spanFrom?: number | null;
  marker?: string;
  fvgKind?: string | null;
  raw: Record<string, unknown>;
}

export interface HistoryMeta {
  engine: HistoryEngine;
  engineTypes: string[];
  typesPresent: string[];
  statesPresent: string[];
  formationsPresent: string[];
  gaps: string[];
  untimedCount: number;
}

export interface HistoryAppearance {
  opacity: number;
  lineWidth: number;
  labels: boolean;
  touchPoints: boolean;
  alt: boolean;
  fvg: boolean;
  extend: boolean;
  body: boolean;
}

export interface HistoryFilters {
  types: Record<string, boolean>;
  states: Record<string, boolean>;
  formations: Record<string, boolean>;
  minTouches: number;
  minConfidence: number;
  timeFrom: number | null;
  timeTo: number | null;
  side: 'all' | 'above' | 'below';
  priceMin: number | null;
  priceMax: number | null;
  withinView: boolean;
  atrDistance: number | null;
  showHistory: boolean;
  confirmedOnly: boolean;
  untimed: boolean;
  appearance: HistoryAppearance;
}

export interface HiddenCounts {
  replay: number;
  untimed: number;
  type: number;
  state: number;
  formation: number;
  strength: number;
  time: number;
  price: number;
  history: number;
}

export interface SelectionCounts {
  total: number;
  visible: number;
  hidden: HiddenCounts;
}

export interface Selection {
  visible: HistoryElement[];
  counts: SelectionCounts;
  filters: HistoryFilters;
}

export interface LayoutRect {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fill: string;
  stroke: string;
  strokeAlpha: number;
  lineWidth: number;
  dashed: boolean | 'dot';
}

export interface LayoutSegment {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  width: number;
  alpha: number;
  dashed: boolean | 'dot';
}

export interface LayoutMarker {
  id: string;
  kind: string;
  shape: 'circle' | 'cross' | 'diamond' | 'triangle_up' | 'triangle_down';
  x: number;
  y: number;
  color: string;
  alpha: number;
  size: number;
}

export interface LayoutLabel {
  text: string;
  x: number;
  y: number;
  color: string;
  align: 'left' | 'right';
}

export interface HistoryLayout {
  rects: LayoutRect[];
  segments: LayoutSegment[];
  markers: LayoutMarker[];
  labels: LayoutLabel[];
  drawn: number;
  culled: number;
  labelSkips: number;
}

export type HistoryState = 'pending' | 'candidate' | 'confirmed' | 'swept' | 'invalidated';

export const ENGINE_TYPES: Record<HistoryEngine, string[]>;
export const STRUCTURE_TYPES: string[];
export const TYPE_META: Record<string, { label: string; short: string; color: string; rgb: string; shape: string; group: string }>;
export const STATE_META: Record<string, { label: string; order: number }>;
export const TYPE_ORDER: string[];
export const FORMATION_LABELS: Record<string, string>;

export function toSeconds(v: unknown): number | null;
export function buildElements(input: { engine: HistoryEngine; zones: unknown[]; structureEvents?: unknown[] }): { elements: HistoryElement[]; meta: HistoryMeta };
export function stateAt(element: HistoryElement, t: number | null): HistoryState;
export function isKnownAt(element: HistoryElement, t: number | null): boolean;
export function defaultFilters(): HistoryFilters;
export function mergeFilters(saved: unknown): HistoryFilters;
export function filterOptions(elements: HistoryElement[]): {
  types: Array<{ id: string; label: string; color: string; count: number }>;
  states: Array<{ id: string; label: string }>;
  formations: Array<{ id: string; label: string }>;
};
export function selectElements(
  elements: HistoryElement[],
  ctx: { filters: HistoryFilters | null | undefined; cursorTime: number | null; replay: boolean; cursorPrice?: number | null; atrRef?: number | null }
): Selection;
export function hiddenTotal(counts: SelectionCounts): number;
export function layoutElements(p: {
  elements: HistoryElement[];
  tx: (t: number) => number | null;
  py: (price: number) => number | null;
  timeAtIndex: (i: number) => number | null;
  indexAtTime: (t: number) => number | null;
  width: number;
  height: number;
  cursorTime: number | null;
  cursorIndex: number | null;
  style: HistoryAppearance | null | undefined;
  replay: boolean;
  selectedId?: string | null;
  hoverId?: string | null;
  /** إظهار المرجع البديل (بلا زمن تكوّن) في وضع التتبع — يمنع إيحاء معرفة سابقة */
  altAllowed?: boolean;
  /** أول/آخر زمن مرئي في النطاق — لاقتصاص العناصر الممتدة من خارج الشاشة بدل استبعادها */
  viewStartTime?: number | null;
  viewEndTime?: number | null;
}): HistoryLayout;
export function fmtPrice(p: number | null | undefined): string;
export function hitTest(layout: HistoryLayout | null, point: { x: number; y: number } | null, tol?: number): string | null;
export function clampIndex(i: number, length: number): number;
export function stepIndex(i: number, delta: number, length: number): number;
export function replaySnapshot(
  elements: HistoryElement[],
  ctx: { cursorTime: number | null; replay: boolean; filters: HistoryFilters; cursorPrice?: number | null; atrRef?: number | null }
): Selection & { states: Array<{ id: string; state: HistoryState }>; known: string[] };
