import { mkdir, writeFile } from 'node:fs/promises';

const OUTPUT_PATH = 'data/btc_real_value.csv';
const START_DATE = '2010-01-01';
const GOLD_API_BASE = 'https://fsapi.gold.org/api/goldprice/v13/chart/price';
const COINGECKO_API_BASE = 'https://api.coingecko.com/api/v3';
const BITCOIN_ID = 'bitcoin';
const ACWI_SYMBOL = '^892400-USD-STRD';
const ACWI_CHART_URL = 'https://query1.finance.yahoo.com/v8/finance/chart';
const DAY_MS = 24 * 60 * 60 * 1000;

function dateFromMs(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function toUnixSeconds(date) {
  return Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000);
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'coinmaster-dashboard/1.0 (daily historical data update)'
    }
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} while fetching ${url}`);
  }
  return response.json();
}

async function fetchGoldHistory() {
  const fromMs = new Date(`${START_DATE}T00:00:00Z`).getTime();
  const url = `${GOLD_API_BASE}/usd/oz/${fromMs},${Date.now()}?cache09092024`;
  const payload = await fetchJson(url);
  const points = payload?.chartData?.USD ?? [];
  const closes = new Map();

  for (const [timestamp, price] of points) {
    const value = Number(price);
    if (Number.isFinite(value) && value > 0) closes.set(dateFromMs(timestamp), value);
  }

  if (closes.size < 100) throw new Error('Gold feed returned too few daily observations.');
  return closes;
}

async function fetchAcwiHistory() {
  const period1 = toUnixSeconds(START_DATE);
  const period2 = Math.floor(Date.now() / 1000);
  const symbol = encodeURIComponent(ACWI_SYMBOL);
  const url = `${ACWI_CHART_URL}/${symbol}?period1=${period1}&period2=${period2}&interval=1d&events=history`;
  const payload = await fetchJson(url);
  const result = payload?.chart?.result?.[0];
  if (!result || result.meta?.symbol !== ACWI_SYMBOL) {
    throw new Error(`Yahoo Finance did not return the expected MSCI ACWI series (${ACWI_SYMBOL}).`);
  }

  const timestamps = result.timestamp ?? [];
  const closes = result.indicators?.quote?.[0]?.close ?? [];
  const values = new Map();

  timestamps.forEach((timestamp, index) => {
    const value = Number(closes[index]);
    if (Number.isFinite(value) && value > 0) values.set(dateFromMs(timestamp * 1000), value);
  });

  if (values.size < 100) throw new Error('MSCI ACWI feed returned too few daily observations.');
  return values;
}

async function fetchBitcoinHistory() {
  const from = toUnixSeconds(START_DATE);
  const to = Math.floor(Date.now() / 1000);
  const url = `${COINGECKO_API_BASE}/coins/${BITCOIN_ID}/market_chart/range?vs_currency=usd&from=${from}&to=${to}`;
  const payload = await fetchJson(url);
  const prices = new Map();

  for (const [timestamp, rawPrice] of payload?.prices ?? []) {
    const price = Number(rawPrice);
    if (Number.isFinite(price) && price > 0) prices.set(dateFromMs(timestamp), price);
  }

  // Drop the current UTC date because it is still an incomplete candle.
  const todayUtc = new Date().toISOString().slice(0, 10);
  prices.delete(todayUtc);

  if (prices.size < 1000) throw new Error('CoinGecko returned too few daily BTC observations.');
  const lastDate = [...prices.keys()].sort().at(-1);
  const ageDays = (Date.now() - new Date(`${lastDate}T00:00:00Z`).getTime()) / DAY_MS;
  if (ageDays > 7) throw new Error(`BTC history is stale; last available close is ${lastDate}.`);
  return prices;
}
function forwardFill(dates, observations) {
  const values = new Map();
  let lastValue = null;
  let observationDate = '';

  for (const date of dates) {
    if (observations.has(date)) {
      lastValue = observations.get(date);
      observationDate = date;
    }
    values.set(date, lastValue == null ? null : { value: lastValue, observationDate });
  }
  return values;
}

async function main() {
  const [btcUsd, goldUsdPerOz, acwiUsd] = await Promise.all([
    fetchBitcoinHistory(),
    fetchGoldHistory(),
    fetchAcwiHistory()
  ]);

  const dates = [...btcUsd.keys()].sort();
  const goldAsOf = forwardFill(dates, goldUsdPerOz);
  const acwiAsOf = forwardFill(dates, acwiUsd);
  const rows = dates.map((date) => {
    const gold = goldAsOf.get(date);
    const acwi = acwiAsOf.get(date);
    const btcGoldOz = gold ? btcUsd.get(date) / gold.value : null;
    return { date, btcUsd: btcUsd.get(date), gold, acwi, btcGoldOz };
  });

  const baseRow = rows.find((row) => Number.isFinite(row.btcGoldOz) && Number.isFinite(row.acwi?.value));
  if (!baseRow) throw new Error('No common BTC, gold and MSCI ACWI observation was found.');

  const header = [
    'date',
    'btc_usd_close',
    'gold_usd_per_troy_oz',
    'gold_observation_date',
    'btc_value_in_gold_oz',
    'msci_acwi_usd',
    'msci_acwi_observation_date',
    'btc_gold_index_100',
    'msci_acwi_index_100'
  ];
  const outputRows = rows.map((row) => {
    const btcIndex = Number.isFinite(row.btcGoldOz) ? (row.btcGoldOz / baseRow.btcGoldOz) * 100 : '';
    const acwiIndex = Number.isFinite(row.acwi?.value) ? (row.acwi.value / baseRow.acwi.value) * 100 : '';
    return [
      row.date,
      row.btcUsd.toFixed(8),
      row.gold ? row.gold.value.toFixed(2) : '',
      row.gold?.observationDate ?? '',
      Number.isFinite(row.btcGoldOz) ? row.btcGoldOz.toFixed(8) : '',
      row.acwi ? row.acwi.value.toFixed(4) : '',
      row.acwi?.observationDate ?? '',
      Number.isFinite(btcIndex) ? btcIndex.toFixed(8) : '',
      Number.isFinite(acwiIndex) ? acwiIndex.toFixed(8) : ''
    ].join(',');
  });

  await mkdir('data', { recursive: true });
  await writeFile(OUTPUT_PATH, [header.join(','), ...outputRows].join('\n') + '\n', 'utf8');
  console.log(`Updated ${OUTPUT_PATH}: ${outputRows.length} BTC dates; normalized comparison begins ${baseRow.date}.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
