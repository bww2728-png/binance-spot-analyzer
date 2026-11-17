/**
 * عقد التخزين الفعلي للنظام. لا تعرف المحركات مزوّد القاعدة أو صيغة REST.
 * كل عمليات `server/db.js` الحالية مشمولة صراحةً، بما فيها عمليات events المشتقة.
 */
export const STORAGE_GROUPS = Object.freeze([
  'analyses', 'coinFlags', 'barcodeScans', 'coinShariah', 'settings', 'health',
  'cases', 'engineState', 'events', 'zones', 'symbols',
  'manualLiquidityDrawings', 'liquidityWorkbench'
]);

export const STORAGE_METHODS = Object.freeze({
  analyses: ['list', 'create', 'update', 'remove'],
  coinFlags: ['list', 'upsert'],
  barcodeScans: ['list', 'get', 'upsert'],
  coinShariah: ['list', 'listVerdicts', 'upsert', 'upsertChunk', 'remove'],
  settings: ['get', 'create', 'update'],
  health: ['append', 'recent', 'count', 'deleteBefore', 'deleteOldest'],
  cases: ['save', 'list', 'get', 'imagesSave', 'imagesList'],
  engineState: ['get', 'getStrict', 'put', 'keys'],
  events: [
    'list', 'get', 'create', 'countByType', 'listByType', 'deleteBefore',
    'deleteByIds', 'clearImagesBefore', 'opportunityHistoryPage',
    'opportunityHistorySummary', 'opportunityOutcomeEventsPage',
    'rejectedEventsPage', 'rejectedSummary', 'liveOppEvents',
    'liveOppEventsPage', 'liveLifecycle', 'liveLifecyclePage',
    'strategy2Events', 'strategy2EventsPage', 'strategy2Calibration',
    'strategy2FeedbackSave', 'strategy2FeedbackEvents',
    'strategy2FeedbackEventsPage', 'strategy2DirectionEvents',
    'strategy2DirectionEventsPage'
  ],
  zones: [
    'list', 'listAuto', 'listAll', 'history', 'append', 'appendFeedback',
    'getAutoSnapshot', 'appendAutoSnapshot', 'getCalibration', 'autoHistory',
    'appendZoneScreenshot', 'listZoneScreenshots', 'appendCalibration'
  ],
  symbols: ['list', 'lastUpdated', 'upsertChunk'],
  manualLiquidityDrawings: ['list', 'upsert', 'remove'],
  liquidityWorkbench: [
    'listScans', 'listEvents', 'listCandles', 'upsertCandles', 'upsertScan',
    'upsertPoints', 'upsertPointLinks', 'listPointLinks', 'listPoints',
    'insertZoneEvent', 'insertSample', 'pruneRaw'
  ]
});

export class StorageContractError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StorageContractError';
  }
}

export function assertStorageContract(adapter, { groups = STORAGE_GROUPS } = {}) {
  if (!adapter || (typeof adapter !== 'object' && typeof adapter !== 'function')) {
    throw new StorageContractError('Storage adapter must be an object');
  }
  const missing = [];
  for (const group of groups) {
    const object = adapter[group];
    if (!object || typeof object !== 'object') {
      missing.push(group);
      continue;
    }
    for (const method of STORAGE_METHODS[group]) {
      if (typeof object[method] !== 'function') missing.push(`${group}.${method}`);
    }
  }
  if (missing.length) throw new StorageContractError(`Storage adapter is incomplete: ${missing.join(', ')}`);
  return adapter;
}

export function storageContractSnapshot(adapter) {
  assertStorageContract(adapter);
  return Object.fromEntries(STORAGE_GROUPS.map(group => [group, [...STORAGE_METHODS[group]]]));
}
