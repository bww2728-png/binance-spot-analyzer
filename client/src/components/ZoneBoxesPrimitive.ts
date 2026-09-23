import type { IChartApi, ISeriesApi, ISeriesPrimitive, SeriesAttachedParameter, PrimitivePaneViewZOrder, Time, UTCTimestamp } from 'lightweight-charts';

export interface ZoneBox {
  timeStart: number;
  timeEnd: number;
  priceLow: number;
  priceHigh: number;
  stopPrice: number;
  fill: string;
  edge: string;
  edgeWidth: number;
  touches: Array<{ time: number; price: number }>;
  trendline?: Array<{ time: number; price: number }>;
}

type Conv = { tx: (time: number) => number | null; py: (price: number) => number | null };

interface DrawRenderer {
  draw(target: { useMediaCoordinateSpace: (cb: (scope: { context: CanvasRenderingContext2D }) => void) => void }): void;
}

/**
 * Primitive رسم على canvas فوق سلسلة الشموع — النمط الرسمي من أمثلة lightweight-charts.
 * يرسم مستطيلات المناطق المظللة (zOrder=bottom) أو الحواف والنقاط ومقاطع الاتجاه (zOrder=top).
 * يعيد الحساب تلقائياً مع كل تكبير/تحريك عبر تحويل الزمن والسعر إلى إحداثيات لحظياً.
 */
class ZoneCanvasView {
  private _source: ZoneCanvasPrimitive;
  constructor(source: ZoneCanvasPrimitive) { this._source = source; }
  zOrder(): PrimitivePaneViewZOrder { return this._source.zOrder; }
  renderer(): DrawRenderer {
    const src = this._source;
    return {
      draw(target) {
        target.useMediaCoordinateSpace(scope => {
          const ctx = scope.context;
          src.drawFn(ctx, {
            tx: (time: number) => src.chart.timeScale().timeToCoordinate(time as UTCTimestamp),
            py: (price: number) => src.series.priceToCoordinate(price)
          });
        });
      }
    };
  }
}

class ZoneCanvasPrimitive implements ISeriesPrimitive<Time> {
  chart!: IChartApi;
  series!: ISeriesApi<'Candlestick'>;
  zOrder: PrimitivePaneViewZOrder;
  drawFn: (ctx: CanvasRenderingContext2D, conv: Conv) => void;
  private _view: ZoneCanvasView;
  constructor(zOrder: PrimitivePaneViewZOrder, drawFn: (ctx: CanvasRenderingContext2D, conv: Conv) => void) {
    this.zOrder = zOrder;
    this.drawFn = drawFn;
    this._view = new ZoneCanvasView(this);
  }
  attached(param: SeriesAttachedParameter<Time>): void {
    this.chart = param.chart;
    this.series = param.series as ISeriesApi<'Candlestick'>;
  }
  detached(): void {}
  paneViews(): ZoneCanvasView[] { return [this._view]; }
  updateAllViews(): void {}
}

export function attachZonePrimitive(
  series: ISeriesApi<'Candlestick'>,
  zOrder: PrimitivePaneViewZOrder,
  drawFn: (ctx: CanvasRenderingContext2D, conv: Conv) => void
): ISeriesPrimitive<Time> {
  const primitive = new ZoneCanvasPrimitive(zOrder, drawFn);
  series.attachPrimitive(primitive);
  return primitive;
}
