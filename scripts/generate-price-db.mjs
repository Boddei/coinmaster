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

async function main() {
  console.log(`Lade BTC-Daten von ${START_DATE} bis ${END_DATE}...`);

  const [eurPoints, usdPoints] = await Promise.all([
    fetchRange('eur'),
    fetchRange('usd')
  ]);

  const eurDaily = pickDailyClose(eurPoints);
  const usdDaily = pickDailyClose(usdPoints);

  const allDates = [...new Set([...eurDaily.keys(), ...usdDaily.keys()])].sort();
  const rows = ['date,close_eur,close_usd'];

  for (const date of allDates) {
    const eur = eurDaily.get(date);
    const usd = usdDaily.get(date);
    if (eur == null || usd == null) continue;
    rows.push(`${date},${eur.toFixed(2)},${usd.toFixed(2)}`);
  }

  await mkdir('data', { recursive: true });
  await writeFile('data/btc_daily_prices.csv', `${rows.join('\n')}\n`, 'utf8');
  console.log(`Fertig: data/btc_daily_prices.csv (${rows.length - 1} Zeilen)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
