import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeOpportunityHistory } from '../services/opportunityHistorySummary.mjs';

test('opportunity history summary separates publication events from unique opportunities', () => {
  const summary = summarizeOpportunityHistory([
    { meta: { opportunity: { id: 'opp-1' } } },
    { meta: JSON.stringify({ opportunity: { id: 'opp-1' } }) },
    { meta: { opportunity: { id: 'opp-2' } } }
  ], 3);

  assert.deepEqual(summary, {
    eventCount: 3,
    uniqueOpportunityCount: 2,
    uniqueCountComplete: true,
    scannedEvents: 3
  });
});

test('opportunity history summary reports lower bounds for truncated or invalid reads', () => {
  const truncated = summarizeOpportunityHistory([
    { meta: { opportunity: { id: 'opp-1' } } },
    { meta: { opportunity: { id: 'opp-2' } } }
  ], 3, { truncated: true });
  const invalid = summarizeOpportunityHistory([
    { meta: { opportunity: { id: 'opp-1' } } },
    { meta: '{invalid' }
  ], 2);

  assert.equal(truncated.uniqueOpportunityCount, 2);
  assert.equal(truncated.uniqueCountComplete, false);
  assert.equal(invalid.uniqueOpportunityCount, 1);
  assert.equal(invalid.uniqueCountComplete, false);
});

test('opportunity history summary recognizes an actually empty complete history', () => {
  assert.deepEqual(summarizeOpportunityHistory([], 0), {
    eventCount: 0,
    uniqueOpportunityCount: 0,
    uniqueCountComplete: true,
    scannedEvents: 0
  });
});
