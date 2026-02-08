import { mkdir, readFile, writeFile } from 'node:fs/promises';

const DB_PATH = 'data/btc_daily_prices.csv';
const COIN = 'bitcoin';
const API_BASE = 'https://api.coingecko.com/api/v3';

function toUnix(dateStr) {
  return Math.floor(new Date(`${dateStr}T00:00:00Z`).getTime() / 1000);
}

function isoDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

async function fetchRange(vsCurrency, fromDate) {
  const from = toUnix(fromDate);
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
    byDay.set(isoDate(timestamp), Number(price));
  }
  return byDay;
}

async function loadExistingRows() {
  try {
    const csv = await readFile(DB_PATH, 'utf8');
    const rows = csv.trim().split('\n');
    if (rows.length <= 1) return [];

    return rows.slice(1).map((line) => {
      const [date, closeEur, closeUsd] = line.split(',');
      return { date, closeEur: Number(closeEur), closeUsd: Number(closeUsd) };
    }).filter((row) => row.date && Number.isFinite(row.closeEur) && Number.isFinite(row.closeUsd));
  } catch {
    return [];
  }
}

async function main() {
  const existing = await loadExistingRows();
  const lastDate = existing.length > 0 ? existing[existing.length - 1].date : '2010-01-01';

  const [eurPoints, usdPoints] = await Promise.all([
    fetchRange('eur', lastDate),
    fetchRange('usd', lastDate)
  ]);

  const eurDaily = pickDailyClose(eurPoints);
  const usdDaily = pickDailyClose(usdPoints);

  const newRows = [...new Set([...eurDaily.keys(), ...usdDaily.keys()])]
    .sort()
    .filter((date) => date > lastDate)
    .map((date) => {
      const eur = eurDaily.get(date);
      const usd = usdDaily.get(date);
      if (eur == null || usd == null) return null;
      return `${date},${eur.toFixed(2)},${usd.toFixed(2)}`;
    })
    .filter(Boolean);

  if (newRows.length === 0) {
    console.log('Keine neuen Tages-Schlusskurse zum Anhängen.');
    return;
  }

  const header = 'date,close_eur,close_usd';
  const existingRows = existing.map((row) => `${row.date},${row.closeEur.toFixed(2)},${row.closeUsd.toFixed(2)}`);
  const merged = [header, ...existingRows, ...newRows].join('\n') + '\n';

  await mkdir('data', { recursive: true });
  await writeFile(DB_PATH, merged, 'utf8');
  console.log(`Angehängt: ${newRows.length} neue Zeile(n) in ${DB_PATH}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
