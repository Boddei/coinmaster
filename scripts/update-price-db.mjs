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

  const parsedNewRows = newRows.map((line) => {
    const [date, closeEur, closeUsd] = line.split(',');
    return { date, closeEur: Number(closeEur), closeUsd: Number(closeUsd) };
  });

  const mergedRows = [...existing, ...parsedNewRows].sort((a, b) => a.date.localeCompare(b.date));
  const eurSeries = mergedRows.map((row) => row.closeEur);
  const usdSeries = mergedRows.map((row) => row.closeUsd);
  const sma50Eur = rollingAverage(eurSeries, 50);
  const sma200Eur = rollingAverage(eurSeries, 200);
  const sma1400Eur = rollingAverage(eurSeries, 1400);
  const sma50Usd = rollingAverage(usdSeries, 50);
  const sma200Usd = rollingAverage(usdSeries, 200);
  const sma1400Usd = rollingAverage(usdSeries, 1400);

  const header = 'date,close_eur,close_usd,sma50d_eur,sma200d_eur,sma200w_eur,sma50d_usd,sma200d_usd,sma200w_usd';
  const serializedRows = mergedRows.map((row, index) => {
    const ma50Eur = sma50Eur[index] != null ? sma50Eur[index].toFixed(2) : '';
    const ma200Eur = sma200Eur[index] != null ? sma200Eur[index].toFixed(2) : '';
    const ma200wEur = sma1400Eur[index] != null ? sma1400Eur[index].toFixed(2) : '';
    const ma50Usd = sma50Usd[index] != null ? sma50Usd[index].toFixed(2) : '';
    const ma200Usd = sma200Usd[index] != null ? sma200Usd[index].toFixed(2) : '';
    const ma200wUsd = sma1400Usd[index] != null ? sma1400Usd[index].toFixed(2) : '';
    return `${row.date},${row.closeEur.toFixed(2)},${row.closeUsd.toFixed(2)},${ma50Eur},${ma200Eur},${ma200wEur},${ma50Usd},${ma200Usd},${ma200wUsd}`;
  });

  const merged = [header, ...serializedRows].join('\n') + '\n';

  await mkdir('data', { recursive: true });
  await writeFile(DB_PATH, merged, 'utf8');
  console.log(`Angehängt: ${newRows.length} neue Zeile(n) in ${DB_PATH}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
