import { mkdir, writeFile } from 'node:fs/promises';

const START_DATE = '2010-01-01';
const END_DATE = new Date().toISOString().slice(0, 10);
const COIN = 'bitcoin';
const API_BASE = 'https://api.coingecko.com/api/v3';

function toUnix(dateStr) {
  return Math.floor(new Date(`${dateStr}T00:00:00Z`).getTime() / 1000);
}

function isoDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

async function fetchRange(vsCurrency) {
  const from = toUnix(START_DATE);
  const to = Math.floor(Date.now() / 1000);
  const url = `${API_BASE}/coins/${COIN}/market_chart/range?vs_currency=${vsCurrency}&from=${from}&to=${to}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`CoinGecko API Fehler (${vsCurrency}): ${response.status}`);
  }

  const data = await response.json();
  return data.prices ?? [];
}

function pickDailyClose(points) {
  const byDay = new Map();
  for (const [timestamp, price] of points) {
    const day = isoDate(timestamp);
    byDay.set(day, Number(price)); // keeps last point of the day as close
  }
  return byDay;
}

function rollingAverage(values, windowSize) {
  const result = new Array(values.length).fill(null);
  let sum = 0;

  for (let i = 0; i < values.length; i += 1) {
    sum += values[i];

    if (i >= windowSize) {
      sum -= values[i - windowSize];
    }

    if (i >= windowSize - 1) {
      result[i] = sum / windowSize;
    }
  }

  return result;
}

async function main() {
  console.log(`Lade BTC-Daten von ${START_DATE} bis ${END_DATE}...`);

  const [eurPoints, usdPoints] = await Promise.all([
    fetchRange('eur'),
    fetchRange('usd')
  ]);

  const eurDaily = pickDailyClose(eurPoints);
  const usdDaily = pickDailyClose(usdPoints);

  const allDates = [...new Set([...eurDaily.keys(), ...usdDaily.keys()])].sort();
  const rows = ['date,close_eur,close_usd,sma50d_eur,sma200d_eur,sma200w_eur,sma50d_usd,sma200d_usd,sma200w_usd'];
  const validDates = allDates.filter((date) => eurDaily.get(date) != null && usdDaily.get(date) != null);
  const eurSeries = validDates.map((date) => eurDaily.get(date));
  const usdSeries = validDates.map((date) => usdDaily.get(date));
  const sma50Eur = rollingAverage(eurSeries, 50);
  const sma200Eur = rollingAverage(eurSeries, 200);
  const sma1400Eur = rollingAverage(eurSeries, 1400);
  const sma50Usd = rollingAverage(usdSeries, 50);
  const sma200Usd = rollingAverage(usdSeries, 200);
  const sma1400Usd = rollingAverage(usdSeries, 1400);
  let validIndex = 0;

  for (const date of validDates) {
    const eur = eurDaily.get(date);
    const usd = usdDaily.get(date);
    const ma50Eur = sma50Eur[validIndex] != null ? sma50Eur[validIndex].toFixed(2) : '';
    const ma200Eur = sma200Eur[validIndex] != null ? sma200Eur[validIndex].toFixed(2) : '';
    const ma200wEur = sma1400Eur[validIndex] != null ? sma1400Eur[validIndex].toFixed(2) : '';
    const ma50Usd = sma50Usd[validIndex] != null ? sma50Usd[validIndex].toFixed(2) : '';
    const ma200Usd = sma200Usd[validIndex] != null ? sma200Usd[validIndex].toFixed(2) : '';
    const ma200wUsd = sma1400Usd[validIndex] != null ? sma1400Usd[validIndex].toFixed(2) : '';
    rows.push(`${date},${eur.toFixed(2)},${usd.toFixed(2)},${ma50Eur},${ma200Eur},${ma200wEur},${ma50Usd},${ma200Usd},${ma200wUsd}`);
    validIndex += 1;
  }

  await mkdir('data', { recursive: true });
  await writeFile('data/btc_daily_prices.csv', `${rows.join('\n')}\n`, 'utf8');
  console.log(`Fertig: data/btc_daily_prices.csv (${rows.length - 1} Zeilen)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
