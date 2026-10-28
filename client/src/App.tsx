import { useEffect, useState } from 'react';
import { useStore } from './store/useStore';
import ChartModal from './components/ChartModal';
import ServerBadge from './components/ServerStatusBadge';
import ScreensHost from './components/ScreensHost';
import TopStatusBar from './components/TopStatusBar';
import { useVisiblePoll } from './lib/useVisiblePoll';

export default function App() {
  const screen = useStore(s => s.screen);
  const setScreen = useStore(s => s.setScreen);

  // زر الرجوع/التقدم في المتصفح يبدل التبويب (الرابط مرآة للشاشة)
  // «#/syscheck» هو الفحص المخفي: صفحة صحة النظام بلا تبويب في القوائم
  useEffect(() => {
    const onHash = () => {
      const h = location.hash.replace('#/', '');
      const target = h === 'syscheck' ? 'dashboard' : h;
      if ((['liquidityZones', 'liquidityV2', 'customLiquidity', 'liveOpportunities', 'strategy2', 'dashboard'] as const).includes(target as never) && target !== screen) {
        setScreen(target as never);
      }
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [screen, setScreen]);

  // حالة اتصال السوق الحية: هل وصل أي سعر خلال آخر 10 ثوانٍ؟
  const prices = useStore(s => s.prices);
  const [live, setLive] = useState(false);
  const [lastTick, setLastTick] = useState(0);

  useEffect(() => {
    const count = Object.keys(prices).length;
    if (count > 0) setLastTick(Date.now());
  }, [prices]);

  // فحص دوري واعٍ بالإخفاء: يتوقف عند إخفاء التبويب ولا يتراكب مع نفسه
  useVisiblePoll(() => { setLive(Date.now() - lastTick < 10000); }, { intervalMs: 3000 });

  const tabs = [
    { id: 'liveOpportunities', label: 'الفرص الحية', shortLabel: 'حية', count: null },
    { id: 'strategy2', label: 'الفرص الحية — استراتيجيتي', shortLabel: 'استراتيجيتي', count: null },
    { id: 'liquidityZones', label: 'مناطق السيولة القديمة', shortLabel: 'القديم', count: null },
    { id: 'liquidityV2', label: 'محرك السيولة الجديد (عرض)', shortLabel: 'الجديد', count: null },
    { id: 'customLiquidity', label: 'جولة مخصصة', shortLabel: 'جولة', count: null }
  ] as const;

  const chartModal = useStore(s => s.chartModal);

  return (
    <div className="h-full flex flex-col" style={{ background: 'var(--surface-0)' }}>
      <h1 className="sr-only">محلل العملات — Binance Spot Strategy Board</h1>
      <header
        className="flex items-center gap-1 px-3 sm:px-5 pt-2.5 sticky top-0 z-30"
        style={{ background: 'var(--surface-glass)', backdropFilter: 'blur(10px)', borderBottom: '1px solid var(--border-1)' }}
      >
        {/* الشعار */}
        <div className="flex items-center gap-2 sm:gap-2.5 ml-2 sm:ml-6">
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center font-bold text-sm flex-shrink-0"
            style={{ background: 'linear-gradient(135deg, var(--accent), #8b5cf6)', color: '#fff', boxShadow: 'var(--shadow-sm)' }}
          >
            B
          </div>
          <div className="leading-tight">
            <div className="text-sm font-bold hidden sm:block" style={{ color: 'var(--text-1)' }}>محلل العملات</div>
            <div className="text-[10px] hidden md:block" style={{ color: 'var(--text-3)' }}>Binance Spot Strategy Board</div>
          </div>
        </div>

        {/* التبويبات */}
        <nav className="flex items-center gap-0.5 sm:gap-1 flex-1 overflow-x-auto">
          {tabs.map(t => {
            const active = screen === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setScreen(t.id)}
                className="relative px-2.5 sm:px-4 py-2.5 text-[12px] sm:text-[13px] font-semibold whitespace-nowrap flex-shrink-0"
                style={{ color: active ? 'var(--accent)' : 'var(--text-2)', transition: 'color var(--transition)' }}
                onMouseEnter={e => { if (!active) (e.currentTarget as HTMLElement).style.color = 'var(--text-1)'; }}
                onMouseLeave={e => { if (!active) (e.currentTarget as HTMLElement).style.color = 'var(--text-2)'; }}
              >
                <span className="hidden sm:inline">{t.label}</span>
                <span className="sm:hidden">{t.shortLabel}</span>
                {t.count !== null && t.count > 0 && (
                  <span className="num mr-1.5 text-[10px] px-1.5 py-0.5 rounded-full" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
                    {t.count}
                  </span>
                )}
                {active && (
                  <span
                    className="absolute bottom-0 inset-x-2 h-0.5 rounded-full"
                    style={{ background: 'var(--accent)', boxShadow: '0 0 8px var(--accent-ring)' }}
                  />
                )}
              </button>
            );
          })}
        </nav>

        {/* حالة النظام: تُقرأ من الخادم نفسه لا من بث المتصفح وحده (B10) */}
        <div className="flex items-center gap-1.5">
          <ServerBadge />
          <div
            className="hidden md:flex items-center gap-2 px-3 py-1.5 rounded-full text-[11px] font-medium"
            style={{
              background: live ? 'var(--up-soft)' : 'var(--warn-soft)',
              color: live ? '#0a7f6a' : '#b45309',
              border: `1px solid ${live ? 'rgba(8,153,129,0.35)' : 'rgba(245,158,11,0.35)'}`
            }}
            title={live ? 'شارت المتصفح يتلقى أسعاراً مباشرة' : 'شارت المتصفح بانتظار أسعار…'}
          >
            <span
              className={`w-2 h-2 rounded-full ${live ? 'live-dot' : ''}`}
              style={{ background: live ? 'var(--up)' : 'var(--warn)' }}
            />
            {live ? 'شارت' : 'انتظار'}
          </div>
        </div>
      </header>

      {/* شريط الحالة العلوي: صحة النظام + آخر تحديث + الفرص + الاقتباس + الصوت */}
      <TopStatusBar />

      <ScreensHost />
      {chartModal && <ChartModal />}
    </div>
  );
}
