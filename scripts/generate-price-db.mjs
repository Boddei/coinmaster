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

function fitLogLogQuantileRegression(dates, prices, tau, options = {}) {
  const {
    iterations = 12000,
    learningRate = 0.02,
    epsilon = 1e-9
  } = options;

  const samples = dates.map((date, index) => {
    const dayNumber = Math.floor(new Date(`${date}T00:00:00Z`).getTime() / (1000 * 60 * 60 * 24));
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

  let beta = varianceX === 0 ? 0 : covariance / varianceX;
  let alpha = meanY - (beta * meanX);

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

  return { alpha, beta };
}

function predictPowerLaw(date, alpha, beta) {
  const dayNumber = Math.floor(new Date(`${date}T00:00:00Z`).getTime() / (1000 * 60 * 60 * 24));
  return Math.exp(alpha + (beta * Math.log(Math.max(dayNumber, 1))));
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
  const rows = ['date,close_eur,close_usd,sma50d_eur,sma200d_eur,sma200w_eur,sma50d_usd,sma200d_usd,sma200w_usd,powerlaw_q01_eur,powerlaw_q50_eur,powerlaw_q99_eur'];
  const validDates = allDates.filter((date) => eurDaily.get(date) != null && usdDaily.get(date) != null);
  const eurSeries = validDates.map((date) => eurDaily.get(date));
  const usdSeries = validDates.map((date) => usdDaily.get(date));
  const sma50Eur = rollingAverage(eurSeries, 50);
  const sma200Eur = rollingAverage(eurSeries, 200);
  const sma1400Eur = rollingAverage(eurSeries, 1400);
  const sma50Usd = rollingAverage(usdSeries, 50);
  const sma200Usd = rollingAverage(usdSeries, 200);
  const sma1400Usd = rollingAverage(usdSeries, 1400);
  const q01 = fitLogLogQuantileRegression(validDates, eurSeries, 0.01);
  const q50 = fitLogLogQuantileRegression(validDates, eurSeries, 0.5);
  const q99 = fitLogLogQuantileRegression(validDates, eurSeries, 0.99);
  let validIndex = 0;

  console.log(`EUR Power-Law Parameter: q01(alpha=${q01.alpha.toFixed(6)}, beta=${q01.beta.toFixed(6)}), q50(alpha=${q50.alpha.toFixed(6)}, beta=${q50.beta.toFixed(6)}), q99(alpha=${q99.alpha.toFixed(6)}, beta=${q99.beta.toFixed(6)})`);

  for (const date of validDates) {
    const eur = eurDaily.get(date);
    const usd = usdDaily.get(date);
    const ma50Eur = sma50Eur[validIndex] != null ? sma50Eur[validIndex].toFixed(2) : '';
    const ma200Eur = sma200Eur[validIndex] != null ? sma200Eur[validIndex].toFixed(2) : '';
    const ma200wEur = sma1400Eur[validIndex] != null ? sma1400Eur[validIndex].toFixed(2) : '';
    const ma50Usd = sma50Usd[validIndex] != null ? sma50Usd[validIndex].toFixed(2) : '';
    const ma200Usd = sma200Usd[validIndex] != null ? sma200Usd[validIndex].toFixed(2) : '';
    const ma200wUsd = sma1400Usd[validIndex] != null ? sma1400Usd[validIndex].toFixed(2) : '';
    const plQ01Eur = predictPowerLaw(date, q01.alpha, q01.beta).toFixed(2);
    const plQ50Eur = predictPowerLaw(date, q50.alpha, q50.beta).toFixed(2);
    const plQ99Eur = predictPowerLaw(date, q99.alpha, q99.beta).toFixed(2);
    rows.push(`${date},${eur.toFixed(2)},${usd.toFixed(2)},${ma50Eur},${ma200Eur},${ma200wEur},${ma50Usd},${ma200Usd},${ma200wUsd},${plQ01Eur},${plQ50Eur},${plQ99Eur}`);
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
