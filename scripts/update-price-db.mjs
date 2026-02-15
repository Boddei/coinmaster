import { mkdir, readFile, writeFile } from 'node:fs/promises';

const DB_PATH = 'data/btc_daily_prices.csv';
const POWERLAW_START_DATE = '2010-07-18';
const COIN = 'bitcoin';
const API_BASE = 'https://api.coingecko.com/api/v3';
const GENESIS_DATE = '2009-01-03';
const MS_PER_DAY = 1000 * 60 * 60 * 24;
const POWERLAW_SEEDS = {
  0.01: { alpha10: -17.2, beta: 5.775 },
  0.5: { alpha10: -15.78, beta: 5.47 },
  0.99: { alpha10: -13.905, beta: 5.165 }
};

function toUnix(dateStr) {
  return Math.floor(new Date(`${dateStr}T00:00:00Z`).getTime() / 1000);
}

function isoDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function daySinceGenesis(date) {
  const dayNumber = Math.floor((new Date(`${date}T00:00:00Z`).getTime() - new Date(`${GENESIS_DATE}T00:00:00Z`).getTime()) / MS_PER_DAY) + 1;
  return Math.max(dayNumber, 1);
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

function fitLogLogQuantileRegression(dates, prices, tau, options = {}) {
  const {
    iterations = 12000,
    learningRate = 0.02,
    epsilon = 1e-9
  } = options;

  const samples = dates.map((date, index) => {
    const dayNumber = daySinceGenesis(date);
    const price = prices[index];
    return {
      logX: Math.log(Math.max(dayNumber, 1)),
      logY: Math.log(Math.max(price, epsilon))
    };
  });

  const n = samples.length;
  const meanX = samples.reduce((acc, point) => acc + point.logX, 0) / n;
  const meanY = samples.reduce((acc, point) => acc + point.logY, 0) / n;
  const covariance = samples.reduce((acc, point) => acc + ((point.logX - meanX) * (point.logY - meanY)), 0);
  const varianceX = samples.reduce((acc, point) => acc + ((point.logX - meanX) ** 2), 0);

  const seed = POWERLAW_SEEDS[tau];
  let beta = varianceX === 0 ? 0 : covariance / varianceX;
  let alpha = meanY - (beta * meanX);

  if (seed) {
    alpha = seed.alpha10 * Math.log(10);
    beta = seed.beta;
  }

  let mAlpha = 0;
  let mBeta = 0;
  let vAlpha = 0;
  let vBeta = 0;
  const beta1 = 0.9;
  const beta2 = 0.999;

  for (let step = 1; step <= iterations; step += 1) {
    let gradAlpha = 0;
    let gradBeta = 0;

    for (const sample of samples) {
      const prediction = alpha + (beta * sample.logX);
      const residual = sample.logY - prediction;
      const psi = residual >= 0 ? tau : tau - 1;

      gradAlpha -= psi;
      gradBeta -= psi * sample.logX;
    }

    gradAlpha /= n;
    gradBeta /= n;

    mAlpha = (beta1 * mAlpha) + ((1 - beta1) * gradAlpha);
    mBeta = (beta1 * mBeta) + ((1 - beta1) * gradBeta);
    vAlpha = (beta2 * vAlpha) + ((1 - beta2) * gradAlpha * gradAlpha);
    vBeta = (beta2 * vBeta) + ((1 - beta2) * gradBeta * gradBeta);

    const mAlphaHat = mAlpha / (1 - (beta1 ** step));
    const mBetaHat = mBeta / (1 - (beta1 ** step));
    const vAlphaHat = vAlpha / (1 - (beta2 ** step));
    const vBetaHat = vBeta / (1 - (beta2 ** step));

    alpha -= learningRate * (mAlphaHat / (Math.sqrt(vAlphaHat) + epsilon));
    beta -= learningRate * (mBetaHat / (Math.sqrt(vBetaHat) + epsilon));
  }

  const predictedLogs = samples.map((sample) => alpha + (beta * sample.logX));
  const residuals = samples.map((sample, index) => sample.logY - predictedLogs[index]);
  const sortedResiduals = [...residuals].sort((a, b) => a - b);
  const quantileIndex = Math.min(Math.max(Math.ceil(tau * sortedResiduals.length) - 1, 0), sortedResiduals.length - 1);
  const interceptShift = sortedResiduals[quantileIndex];

  return { alpha: alpha + interceptShift, beta };
}

function predictPowerLaw(date, alpha, beta) {
  const dayNumber = daySinceGenesis(date);
  return Math.exp(alpha + (beta * Math.log(Math.max(dayNumber, 1))));
}

async function main() {
  const existing = await loadExistingRows();
  const lastDate = existing.length > 0 ? existing[existing.length - 1].date : '2010-01-01';

  let eurPoints = [];
  let usdPoints = [];

  try {
    [eurPoints, usdPoints] = await Promise.all([
      fetchRange('eur', lastDate),
      fetchRange('usd', lastDate)
    ]);
  } catch (error) {
    console.warn(`Konnte keine neuen API-Daten laden, berechne nur bestehende Daten neu: ${error.message}`);
  }

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

  const parsedNewRows = newRows.map((line) => {
    const [date, closeEur, closeUsd] = line.split(',');
    return { date, closeEur: Number(closeEur), closeUsd: Number(closeUsd) };
  });

  const mergedRows = [...existing, ...parsedNewRows].sort((a, b) => a.date.localeCompare(b.date));
  if (mergedRows.length === 0) {
    console.log('Keine Daten verfügbar.');
    return;
  }

  const eurSeries = mergedRows.map((row) => row.closeEur);
  const usdSeries = mergedRows.map((row) => row.closeUsd);
  const dateSeries = mergedRows.map((row) => row.date);
  const sma50Eur = rollingAverage(eurSeries, 50);
  const sma200Eur = rollingAverage(eurSeries, 200);
  const sma1400Eur = rollingAverage(eurSeries, 1400);
  const sma50Usd = rollingAverage(usdSeries, 50);
  const sma200Usd = rollingAverage(usdSeries, 200);
  const sma1400Usd = rollingAverage(usdSeries, 1400);
  const fitRows = mergedRows.filter((row) => row.date >= POWERLAW_START_DATE);
  const fitDates = fitRows.map((row) => row.date);
  const fitEurSeries = fitRows.map((row) => row.closeEur);
  const fitUsdSeries = fitRows.map((row) => row.closeUsd);
  const q01 = fitLogLogQuantileRegression(fitDates, fitEurSeries, 0.01);
  const q01Usd = fitLogLogQuantileRegression(fitDates, fitUsdSeries, 0.01);
  const q50 = fitLogLogQuantileRegression(fitDates, fitEurSeries, 0.5);
  const q50Usd = fitLogLogQuantileRegression(fitDates, fitUsdSeries, 0.5);
  const q99 = fitLogLogQuantileRegression(fitDates, fitEurSeries, 0.99);
  const q99Usd = fitLogLogQuantileRegression(fitDates, fitUsdSeries, 0.99);

  console.log(`EUR Power-Law Parameter: q01(alpha=${q01.alpha.toFixed(6)}, beta=${q01.beta.toFixed(6)}), q50(alpha=${q50.alpha.toFixed(6)}, beta=${q50.beta.toFixed(6)}), q99(alpha=${q99.alpha.toFixed(6)}, beta=${q99.beta.toFixed(6)})`);
  console.log(`USD Power-Law Parameter: q01(alpha=${q01Usd.alpha.toFixed(6)}, beta=${q01Usd.beta.toFixed(6)}), q50(alpha=${q50Usd.alpha.toFixed(6)}, beta=${q50Usd.beta.toFixed(6)}), q99(alpha=${q99Usd.alpha.toFixed(6)}, beta=${q99Usd.beta.toFixed(6)})`);

  const header = 'date,close_eur,close_usd,sma50d_eur,sma200d_eur,sma200w_eur,sma50d_usd,sma200d_usd,sma200w_usd,powerlaw_q01_eur,powerlaw_q50_eur,powerlaw_q99_eur,powerlaw_q01_usd,powerlaw_q50_usd,powerlaw_q99_usd';
  const serializedRows = mergedRows.map((row, index) => {
    const ma50Eur = sma50Eur[index] != null ? sma50Eur[index].toFixed(2) : '';
    const ma200Eur = sma200Eur[index] != null ? sma200Eur[index].toFixed(2) : '';
    const ma200wEur = sma1400Eur[index] != null ? sma1400Eur[index].toFixed(2) : '';
    const ma50Usd = sma50Usd[index] != null ? sma50Usd[index].toFixed(2) : '';
    const ma200Usd = sma200Usd[index] != null ? sma200Usd[index].toFixed(2) : '';
    const ma200wUsd = sma1400Usd[index] != null ? sma1400Usd[index].toFixed(2) : '';
    const plQ01Eur = predictPowerLaw(row.date, q01.alpha, q01.beta).toFixed(2);
    const plQ50Eur = predictPowerLaw(row.date, q50.alpha, q50.beta).toFixed(2);
    const plQ99Eur = predictPowerLaw(row.date, q99.alpha, q99.beta).toFixed(2);
    const plQ01Usd = predictPowerLaw(row.date, q01Usd.alpha, q01Usd.beta).toFixed(2);
    const plQ50Usd = predictPowerLaw(row.date, q50Usd.alpha, q50Usd.beta).toFixed(2);
    const plQ99Usd = predictPowerLaw(row.date, q99Usd.alpha, q99Usd.beta).toFixed(2);
    return `${row.date},${row.closeEur.toFixed(2)},${row.closeUsd.toFixed(2)},${ma50Eur},${ma200Eur},${ma200wEur},${ma50Usd},${ma200Usd},${ma200wUsd},${plQ01Eur},${plQ50Eur},${plQ99Eur},${plQ01Usd},${plQ50Usd},${plQ99Usd}`;
  });

  const merged = [header, ...serializedRows].join('\n') + '\n';

  await mkdir('data', { recursive: true });
  await writeFile(DB_PATH, merged, 'utf8');
  console.log(`Aktualisiert: ${newRows.length} neue Zeile(n), Indikatoren neu berechnet in ${DB_PATH}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
