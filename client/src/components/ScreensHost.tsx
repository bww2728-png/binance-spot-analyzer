import { lazy, Suspense, useEffect, useMemo, useRef, type ComponentType } from 'react';
import { useStore, type Screen } from '../store/useStore';
import { ScreenVisibilityContext } from '../lib/screenVisibility';
import ErrorBoundary from './ErrorBoundary';
import Skeleton from './ui/Skeleton';

/**
 * حاضن الشاشات — يُبقي آخر 3 شاشات مزارة محمّلة (LRU) ويعرض واحدة ويخفي البقية
 * بـ`display: none` بدل الهدم. الغرض أن لا تضيع الحالة المحلية (الفلاتر، الرمز،
 * الفريم، التبويب الداخلي، التمرير، الشارت) ولا تُعاد الطلبات عند كل تنقل.
 *
 * الشاشات المتجاوزة سقف الثلاثة تُهدَم فعلاً، لكن حالتها محفوظة في شريحة المخزن
 * (`screenStates`) فتُستعاد عند إعادة فتحها.
 */

const SCREEN_LABELS: Record<Screen, string> = {
  liveOpportunities: 'الفرص الحية',
  strategy2: 'الفرص الحية — استراتيجيتي',
  liquidityZones: 'مناطق السيولة القديمة',
  liquidityV2: 'محرك السيولة الجديد',
  customLiquidity: 'جولة مخصصة',
  /* صفحة الفحص المخفي — تُفتح برابط #/syscheck فقط ولا تظهر في القوائم */
  dashboard: 'فحص النظام (مخفي)'
};

/* استيراد كسول لكل شاشة — يقسّم الحزمة ويُحمّل الشاشة عند أول زيارة فقط */
const LOADERS: Record<Screen, () => Promise<{ default: ComponentType }>> = {
  liveOpportunities: () => import('./LiveOpportunitiesScreen'),
  strategy2: () => import('./StrategyScreen'),
  liquidityZones: () => import('./LiquidityZonesScreen'),
  liquidityV2: () => import('./LiquidityV2Screen'),
  customLiquidity: () => import('./CustomLiquidityScreen'),
  dashboard: () => import('./Dashboard')
};

const LazyScreens = Object.fromEntries(
  (Object.keys(LOADERS) as Screen[]).map(s => [s, lazy(LOADERS[s])])
) as unknown as Record<Screen, ComponentType>;

const MAX_MOUNTED = 3;

function ScreenFallback() {
  return (
    <div className="p-4 space-y-3">
      {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} height={72} />)}
    </div>
  );
}

export default function ScreensHost() {
  const screen = useStore(s => s.screen);
  const scrollRefs = useRef<Partial<Record<Screen, HTMLDivElement | null>>>({});
  const mountedRef = useRef<Screen[]>([screen]);

  // LRU محسوب أثناء الرسم: الشاشة الحالية في المقدمة، وسقف الثلاثة يهدم الأقدم.
  // الحساب هنا (لا في effect) يمنع وميض شاشة غير محمّلة عند أول تنقل.
  const mounted = useMemo(() => {
    const next = [screen, ...mountedRef.current.filter(s => s !== screen)];
    const capped = next.slice(0, MAX_MOUNTED);
    mountedRef.current = capped;
    return capped;
  }, [screen]);

  // استعادة موضع التمرير عند إظهار الشاشة، وحفظه عند إخفائها
  useEffect(() => {
    const el = scrollRefs.current[screen];
    if (!el) return;
    const saved = useStore.getState().getScreenState(screen)?.scrollTop ?? 0;
    el.scrollTop = saved;
    return () => {
      useStore.getState().saveScreenState(screen, { scrollTop: el.scrollTop });
    };
  }, [screen]);

  return (
    <main className="flex-1 overflow-hidden scroll-contain">
      {mounted.map(s => {
        const active = s === screen;
        const Comp = LazyScreens[s];
        return (
          <div
            key={s}
            ref={el => { scrollRefs.current[s] = el; }}
            className="h-full overflow-auto"
            style={{ display: active ? 'block' : 'none' }}
            aria-hidden={!active}
            inert={!active}
          >
            {/* السياق يُخبر كل استقصاء داخل الشاشة أن محتواها مخفي فيتوقف */}
            <ScreenVisibilityContext.Provider value={active}>
              <ErrorBoundary label={SCREEN_LABELS[s]}>
                <Suspense fallback={<ScreenFallback />}>
                  <Comp />
                </Suspense>
              </ErrorBoundary>
            </ScreenVisibilityContext.Provider>
          </div>
        );
      })}
    </main>
  );
}
