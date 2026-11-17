import { mkdir, writeFile } from 'node:fs/promises';

const OUTPUT_PATH = 'data/btc_real_value.csv';
const START_DATE = '2010-01-01';
const GOLD_API_BASE = 'https://fsapi.gold.org/api/goldprice/v13/chart/price';
const COIN_METRICS_API_BASE = 'https://community-api.coinmetrics.io/v4';
const MSCI_WORLD_SYMBOL = '^990100-USD-STRD';
const YAHOO_CHART_URL = 'https://query1.finance.yahoo.com/v8/finance/chart';
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
  if (!response.ok) throw new Error(`HTTP ${response.status} while fetching ${url}`);
  return response.json();
}

function assertFresh(observations, label, maximumAgeDays = 7) {
  const lastDate = [...observations.keys()].sort().at(-1);
  if (!lastDate) throw new Error(`${label} feed returned no observations.`);
  const ageDays = (Date.now() - new Date(`${lastDate}T00:00:00Z`).getTime()) / DAY_MS;
  if (ageDays > maximumAgeDays) throw new Error(`${label} history is stale; last observation is ${lastDate}.`);
}

async function fetchGoldHistory() {
  const fromMs = new Date(`${START_DATE}T00:00:00Z`).getTime();
  const url = `${GOLD_API_BASE}/usd/oz/${fromMs},${Date.now()}?cache09092024`;
  const payload = await fetchJson(url);
  const points = payload?.chartData?.USD ?? [];
  const prices = new Map();

  for (const [timestamp, price] of points) {
    const value = Number(price);
    if (Number.isFinite(value) && value > 0) prices.set(dateFromMs(timestamp), value);
  }

  if (prices.size < 100) throw new Error('Gold feed returned too few daily observations.');
  assertFresh(prices, 'Gold');
  return prices;
}

async function fetchMsciWorldHistory() {
  const period1 = toUnixSeconds(START_DATE);
  const period2 = Math.floor(Date.now() / 1000);
  const symbol = encodeURIComponent(MSCI_WORLD_SYMBOL);
  const url = `${YAHOO_CHART_URL}/${symbol}?period1=${period1}&period2=${period2}&interval=1d&events=history`;
  const payload = await fetchJson(url);
  const result = payload?.chart?.result?.[0];
  if (!result || result.meta?.symbol !== MSCI_WORLD_SYMBOL) {
    throw new Error(`Yahoo Finance did not return the expected MSCI World series (${MSCI_WORLD_SYMBOL}).`);
  }

  const values = new Map();
  const timestamps = result.timestamp ?? [];
  const closes = result.indicators?.quote?.[0]?.close ?? [];
  timestamps.forEach((timestamp, index) => {
    const value = Number(closes[index]);
    if (Number.isFinite(value) && value > 0) values.set(dateFromMs(timestamp * 1000), value);
  });

  if (values.size < 100) throw new Error('MSCI World feed returned too few daily observations.');
  assertFresh(values, 'MSCI World');
  return values;
}

async function fetchBitcoinHistory() {
  const params = new URLSearchParams({
    assets: 'btc',
    metrics: 'PriceUSD',
    frequency: '1d',
    start_time: START_DATE,
    paging_from: 'start',
    page_size: '10000'
  });
  let nextUrl = `${COIN_METRICS_API_BASE}/timeseries/asset-metrics?${params}`;
  const prices = new Map();

  while (nextUrl) {
    const payload = await fetchJson(nextUrl);
    for (const point of payload?.data ?? []) {
      const date = new Date(point.time).toISOString().slice(0, 10);
      const price = Number(point.PriceUSD);
      if (Number.isFinite(price) && price > 0) prices.set(date, price);
    }
    nextUrl = payload?.next_page_url ?? null;
  }

  const todayUtc = new Date().toISOString().slice(0, 10);
  prices.delete(todayUtc);
  if (prices.size < 1000) throw new Error(`Coin Metrics returned only ${prices.size} daily BTC observations.`);
  assertFresh(prices, 'BTC');
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

function calculateSimpleMovingAverage(values, windowSize) {
  const averages = Array(values.length).fill(null);
  let sum = 0;
  let missingCount = 0;

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (Number.isFinite(value)) sum += value;
    else missingCount += 1;

    if (index >= windowSize) {
      const expired = values[index - windowSize];
      if (Number.isFinite(expired)) sum -= expired;
      else missingCount -= 1;
    }

    if (index >= windowSize - 1 && missingCount === 0) {
      averages[index] = sum / windowSize;
    }
  }

  return averages;
}

async function main() {
  const [btcUsd, goldUsdPerOz, msciWorldUsd] = await Promise.all([
    fetchBitcoinHistory(),
    fetchGoldHistory(),
    fetchMsciWorldHistory()
  ]);

  const dates = [...btcUsd.keys()].sort();
  const goldAsOf = forwardFill(dates, goldUsdPerOz);
  const worldAsOf = forwardFill(dates, msciWorldUsd);
  const header = [
    'date',
    'btc_usd_close',
    'gold_usd_per_troy_oz',
    'gold_observation_date',
    'btc_value_in_gold_oz',
    'msci_world_usd',
    'msci_world_observation_date',
    'btc_value_in_msci_world',
    'btc_value_in_gold_oz_sma50d',
    'btc_value_in_gold_oz_sma200d',
    'btc_value_in_gold_oz_sma200w',
    'btc_value_in_msci_world_sma50d',
    'btc_value_in_msci_world_sma200d',
    'btc_value_in_msci_world_sma200w'
  ];
  const dailyRows = dates.map((date) => {
    const btc = btcUsd.get(date);
    const gold = goldAsOf.get(date);
    const world = worldAsOf.get(date);
    return {
      date,
      btc,
      gold,
      world,
      btcInGold: gold ? btc / gold.value : null,
      btcInWorld: world ? btc / world.value : null
    };
  });
  const goldSma50 = calculateSimpleMovingAverage(dailyRows.map((row) => row.btcInGold), 50);
  const goldSma200 = calculateSimpleMovingAverage(dailyRows.map((row) => row.btcInGold), 200);
  const goldSma200w = calculateSimpleMovingAverage(dailyRows.map((row) => row.btcInGold), 1400);
  const worldSma50 = calculateSimpleMovingAverage(dailyRows.map((row) => row.btcInWorld), 50);
  const worldSma200 = calculateSimpleMovingAverage(dailyRows.map((row) => row.btcInWorld), 200);
  const worldSma200w = calculateSimpleMovingAverage(dailyRows.map((row) => row.btcInWorld), 1400);
  const formatSma = (value, precision) => Number.isFinite(value) ? value.toFixed(precision) : '';

  const rows = dailyRows.map((row, index) => [
    row.date,
    row.btc.toFixed(8),
    row.gold ? row.gold.value.toFixed(2) : '',
    row.gold?.observationDate ?? '',
    Number.isFinite(row.btcInGold) ? row.btcInGold.toFixed(8) : '',
    row.world ? row.world.value.toFixed(4) : '',
    row.world?.observationDate ?? '',
    Number.isFinite(row.btcInWorld) ? row.btcInWorld.toFixed(10) : '',
    formatSma(goldSma50[index], 8),
    formatSma(goldSma200[index], 8),
    formatSma(goldSma200w[index], 8),
    formatSma(worldSma50[index], 10),
    formatSma(worldSma200[index], 10),
    formatSma(worldSma200w[index], 10)
  ].join(','));

  await mkdir('data', { recursive: true });
  await writeFile(OUTPUT_PATH, [header.join(','), ...rows].join('\n') + '\n', 'utf8');
  console.log(`Updated ${OUTPUT_PATH}: ${rows.length} daily BTC dates with Gold, MSCI World and SMA values.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
