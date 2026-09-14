import prisma from '../db.js';

const REF_HALAL = [
  'BTC', 'ETH', 'BNB', 'SOL', 'ADA', 'DOT', 'XRP', 'LTC', 'BCH', 'LINK',
  'AVAX', 'MATIC', 'UNI', 'ATOM', 'ETC', 'FIL', 'NEAR', 'ARB', 'OP', 'INJ',
  'AAVE', 'SAND', 'MANA', 'GRT', 'ENJ', 'ANKR', 'STORJ', 'SKL', 'CELO', 'ONE'
];

async function main() {
  // default settings
  await prisma.settings.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1, quote: 'USDT', notify_timeout_min: 30, sound_enabled: true, sort_config: '{}' }
  });

  // reference halal flags
  const existing = await prisma.coinFlag.findMany();
  const existingSet = new Set(existing.map(f => f.symbol));
  for (const symbol of REF_HALAL) {
    if (!existingSet.has(`${symbol}USDT`) && !existingSet.has(symbol)) {
      await prisma.coinFlag.upsert({
        where: { symbol: `${symbol}USDT` },
        update: {},
        create: { symbol: `${symbol}USDT`, halal: true, barcode: false }
      });
    }
  }
  console.log('[seed] done');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
