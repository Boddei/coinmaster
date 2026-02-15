// Bitcoin Dashboard - Main JavaScript

// Configuration
const CONFIG = {
    coingecko: {
        baseUrl: 'https://api.coingecko.com/api/v3',
        coin: 'bitcoin'
    },
    refreshInterval: 60000, // 1 minute
    chartDays: 7,
    localPriceDbPath: 'data/btc_daily_prices.csv'
};

// Global state
let btcChart = null;
let currentChartDays = 7;
let currentChartScale = 'linear';
let currentChartCurrency = 'eur';
let chartRequestId = 0;
let localPriceRows = [];
let projectionDate = '';
const maVisibility = {
    sma50d: false,
    sma200d: false,
    sma200w: false,
    powerlaw: false
};

const POWER_LAW_SERIES = [
    { key: 'powerLawQ01', color: '#ef4444', label: 'Q01' },
    { key: 'powerLawQ50', color: '#f59e0b', label: 'Q50' },
    { key: 'powerLawQ99', color: '#22c55e', label: 'Q99' }
];

const powerLawFormulaOverlayPlugin = {
    id: 'powerLawFormulaOverlay',
    afterDatasetsDraw(chart) {
        const formulas = chart?.config?.options?.plugins?.powerLawFormulaOverlay?.formulas;
        if (!Array.isArray(formulas) || formulas.length === 0) return;

        const { ctx, chartArea } = chart;
        if (!chartArea) return;

        const rightPadding = 12;
        const bottomPadding = 12;
        const lineHeight = 18;
        let y = chartArea.bottom - bottomPadding - ((formulas.length - 1) * lineHeight);

        ctx.save();
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.font = '12px Inter, Arial, sans-serif';

        formulas.forEach((formula) => {
            ctx.fillStyle = formula.color;
            ctx.fillText(formula.text, chartArea.right - rightPadding, y);
            y += lineHeight;
        });

        ctx.restore();
    }
};

Chart.register(powerLawFormulaOverlayPlugin);

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    initApp();
});

async function initApp() {
    console.log('Bitcoin Dashboard initialisiert...');
    localPriceRows = await fetchLocalCsvPrices();
    
    // Load initial data
    await loadBitcoinData();
    await loadChartData(currentChartDays);
    await loadFundamentalIndicators();

    // Setup chart controls
    setupChartControls();
    
    // Setup auto-refresh
    setInterval(async () => {
        await loadBitcoinData();
        await loadFundamentalIndicators();
    }, CONFIG.refreshInterval);
    
    // Update last update time
    updateLastUpdateTime();
    setInterval(updateLastUpdateTime, 30000);
}

// ============================================================================
// Bitcoin Price Data
// ============================================================================

async function loadBitcoinData() {
    try {
        const response = await fetch(
            `${CONFIG.coingecko.baseUrl}/coins/${CONFIG.coingecko.coin}?` +
            'localization=false&tickers=false&community_data=false&developer_data=false'
        );
        
        if (!response.ok) throw new Error('API Fehler');
        
        const data = await response.json();
        updatePriceDisplay(data);
        updateStats(data);
        
    } catch (error) {
        console.error('Fehler beim Laden der Bitcoin-Daten:', error);
        const fallbackRow = await getLatestLocalClose();
        if (fallbackRow) {
            document.getElementById('btcPrice').textContent = formatCurrency(fallbackRow.closeEur, 'EUR');
            document.getElementById('btcPriceUSD').textContent = formatCurrency(fallbackRow.closeUsd, 'USD');
            document.getElementById('btcPriceCHF').textContent = '—';
            const changeElement = document.getElementById('priceChange');
            changeElement.textContent = 'Offline-Modus (lokale CSV)';
            changeElement.className = 'price-change';
        } else {
            showError('Preisdaten konnten nicht geladen werden');
        }
    }
}

function updatePriceDisplay(data) {
    const price = data.market_data;
    
    // EUR price
    const eurPrice = price.current_price.eur;
    document.getElementById('btcPrice').textContent = 
        formatCurrency(eurPrice, 'EUR');
    
    // USD price
    const usdPrice = price.current_price.usd;
    document.getElementById('btcPriceUSD').textContent = 
        formatCurrency(usdPrice, 'USD');
    
    // CHF price
    const chfPrice = price.current_price.chf;
    document.getElementById('btcPriceCHF').textContent = 
        formatCurrency(chfPrice, 'CHF');
    
    // 24h change
    const change24h = price.price_change_percentage_24h;
    const changeElement = document.getElementById('priceChange');
    changeElement.textContent = `${change24h >= 0 ? '+' : ''}${change24h.toFixed(2)}%`;
    changeElement.className = `price-change ${change24h >= 0 ? 'positive' : 'negative'}`;
}

function updateStats(data) {
    const price = data.market_data;
    
    // 24h high/low
    document.getElementById('high24h').textContent = 
        formatCurrency(price.high_24h.eur, 'EUR');
    document.getElementById('low24h').textContent = 
        formatCurrency(price.low_24h.eur, 'EUR');
    
    // Market cap
    document.getElementById('marketCap').textContent = 
        formatLargeNumber(price.market_cap.eur) + ' €';
    
    // 24h volume
    document.getElementById('volume24h').textContent = 
        formatLargeNumber(price.total_volume.eur) + ' €';
}

// ============================================================================
// Chart
// ============================================================================

async function loadChartData(days) {
    const requestId = ++chartRequestId;

    try {
        const response = await fetch(buildChartUrl(days));
        
        if (!response.ok) throw new Error('Chart API Fehler');
        
        const data = await response.json();
        if (requestId !== chartRequestId) return;

        if (!Array.isArray(data.prices) || data.prices.length === 0) {
            throw new Error('Keine Chart-Daten erhalten');
        }

        const enrichedData = enrichMarketPricesWithMovingAverages(data.prices, localPriceRows);
        updateChart(extendSeriesWithProjection(enrichedData));
        
    } catch (error) {
        if (requestId !== chartRequestId) return;
        console.error('Fehler beim Laden der Chart-Daten:', error);
        const localPrices = localPriceRows.length > 0 ? localPriceRows : await fetchLocalCsvPrices();
        const fallbackSeries = buildFallbackChartSeries(localPrices, days);

        if (fallbackSeries.length > 0) {
            updateChart(extendSeriesWithProjection(fallbackSeries));
        } else {
            showError('Chart konnte nicht geladen werden');
        }
    }
}

function buildFallbackChartSeries(rows, days) {
    if (!Array.isArray(rows) || rows.length === 0) return [];

    const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
    const usableRows = days === 'max' ? sorted : sorted.slice(-days);

    const priceKey = currentChartCurrency === 'usd' ? 'closeUsd' : 'closeEur';
    const sma50Key = currentChartCurrency === 'usd' ? 'sma50dUsd' : 'sma50dEur';
    const sma200Key = currentChartCurrency === 'usd' ? 'sma200dUsd' : 'sma200dEur';
    const sma200wKey = currentChartCurrency === 'usd' ? 'sma200wUsd' : 'sma200wEur';
    const powerLawQ01Key = currentChartCurrency === 'usd' ? 'powerLawQ01Usd' : 'powerLawQ01Eur';
    const powerLawQ50Key = currentChartCurrency === 'usd' ? 'powerLawQ50Usd' : 'powerLawQ50Eur';
    const powerLawQ99Key = currentChartCurrency === 'usd' ? 'powerLawQ99Usd' : 'powerLawQ99Eur';

    return usableRows.map(row => ({
        timestamp: Date.parse(`${row.date}T00:00:00Z`),
        price: row[priceKey],
        sma50d: row[sma50Key],
        sma200d: row[sma200Key],
        sma200w: row[sma200wKey],
        powerLawQ01: row[powerLawQ01Key],
        powerLawQ50: row[powerLawQ50Key],
        powerLawQ99: row[powerLawQ99Key]
    }));
}

function enrichMarketPricesWithMovingAverages(priceData, rows) {
    const rowByDate = new Map(rows.map((row) => [row.date, row]));

    return priceData.map((point) => {
        const timestamp = point[0];
        const row = rowByDate.get(new Date(timestamp).toISOString().slice(0, 10));
        const sma50d = currentChartCurrency === 'usd' ? row?.sma50dUsd : row?.sma50dEur;
        const sma200d = currentChartCurrency === 'usd' ? row?.sma200dUsd : row?.sma200dEur;
        const sma200w = currentChartCurrency === 'usd' ? row?.sma200wUsd : row?.sma200wEur;
        const powerLawQ01 = currentChartCurrency === 'usd' ? row?.powerLawQ01Usd : row?.powerLawQ01Eur;
        const powerLawQ50 = currentChartCurrency === 'usd' ? row?.powerLawQ50Usd : row?.powerLawQ50Eur;
        const powerLawQ99 = currentChartCurrency === 'usd' ? row?.powerLawQ99Usd : row?.powerLawQ99Eur;

        return {
            timestamp,
            price: point[1],
            sma50d: sma50d ?? null,
            sma200d: sma200d ?? null,
            sma200w: sma200w ?? null,
            powerLawQ01: powerLawQ01 ?? null,
            powerLawQ50: powerLawQ50 ?? null,
            powerLawQ99: powerLawQ99 ?? null
        };
    });
}

function buildChartUrl(days) {
    const baseUrl = `${CONFIG.coingecko.baseUrl}/coins/${CONFIG.coingecko.coin}`;

    if (days === 'max') {
        return `${baseUrl}/market_chart?vs_currency=${currentChartCurrency}&days=max`;
    }

    // Für längere Zeiträume ist /market_chart/range robuster als days-Parameter.
    if (days > 365) {
        const now = Math.floor(Date.now() / 1000);
        const from = now - (days * 24 * 60 * 60);
        return `${baseUrl}/market_chart/range?vs_currency=${currentChartCurrency}&from=${from}&to=${now}`;
    }

    return `${baseUrl}/market_chart?vs_currency=${currentChartCurrency}&days=${days}`;
}

function extendSeriesWithProjection(priceData) {
    if (!projectionDate) return priceData;
    if (!Array.isArray(priceData) || priceData.length === 0) return priceData;

    const targetTimestamp = Date.parse(`${projectionDate}T00:00:00Z`);
    if (!Number.isFinite(targetTimestamp)) return priceData;

    const lastTimestamp = priceData[priceData.length - 1].timestamp;
    if (!Number.isFinite(lastTimestamp) || targetTimestamp <= lastTimestamp) return priceData;

    const projectionParams = Object.fromEntries(
        POWER_LAW_SERIES.map((series) => [series.key, getSingleTermPowerLawParams(series.key)])
    );

    const projected = [...priceData];
    const dayMs = 24 * 60 * 60 * 1000;
    for (let ts = lastTimestamp + dayMs; ts <= targetTimestamp; ts += dayMs) {
        const dateString = new Date(ts).toISOString().slice(0, 10);
        projected.push({
            timestamp: ts,
            price: null,
            sma50d: null,
            sma200d: null,
            sma200w: null,
            powerLawQ01: predictSingleTermPowerLaw(dateString, projectionParams.powerLawQ01),
            powerLawQ50: predictSingleTermPowerLaw(dateString, projectionParams.powerLawQ50),
            powerLawQ99: predictSingleTermPowerLaw(dateString, projectionParams.powerLawQ99),
            isProjected: true
        });
    }

    return projected;
}

function predictSingleTermPowerLaw(date, params) {
    const dayNumber = convertToBitcoinDayIndex(date);
    if (!Number.isFinite(dayNumber) || !params) return null;

    const { a, b } = params;
    if (![a, b].every(Number.isFinite)) return null;

    return a * Math.pow(Math.max(dayNumber, 1e-9), b);
}

function updateChart(priceData) {
    const ctx = document.getElementById('btcChart').getContext('2d');

    // Prepare data
    const labels = priceData.map(point => {
        const date = new Date(point.timestamp);
        if (currentChartDays <= 7) {
            return date.toLocaleDateString('de-DE', { month: 'short', day: 'numeric', hour: '2-digit' });
        } else if (currentChartDays <= 90) {
            return date.toLocaleDateString('de-DE', { month: 'short', day: 'numeric' });
        } else {
            return date.toLocaleDateString('de-DE', { year: 'numeric', month: 'short' });
        }
    });

    const prices = priceData.map(point => point.price);
    const sma50d = priceData.map(point => point.sma50d);
    const sma200d = priceData.map(point => point.sma200d);
    const sma200w = priceData.map(point => point.sma200w);
    const powerLawQ01 = priceData.map(point => point.powerLawQ01);
    const powerLawQ50 = priceData.map(point => point.powerLawQ50);
    const powerLawQ99 = priceData.map(point => point.powerLawQ99);
    const chartCurrency = currentChartCurrency.toUpperCase();
    const powerLawFormulas = maVisibility.powerlaw
        ? buildPowerLawFormulas()
        : [];

    // Destroy existing chart
    if (btcChart) {
        btcChart.destroy();
    }

    // Create new chart
    btcChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [
                {
                    label: `Bitcoin Preis (${chartCurrency})`,
                    data: prices,
                    borderColor: '#f7931a',
                    backgroundColor: 'rgba(247, 147, 26, 0.1)',
                    borderWidth: 2,
                    fill: true,
                    tension: 0.4,
                    pointRadius: 0,
                    pointHoverRadius: 6,
                    pointHoverBackgroundColor: '#f7931a',
                    pointHoverBorderColor: '#fff',
                    pointHoverBorderWidth: 2
                },
                {
                    label: `MA 50D (${chartCurrency})`,
                    data: sma50d,
                    borderColor: '#4a9eff',
                    backgroundColor: 'transparent',
                    borderWidth: 2,
                    fill: false,
                    tension: 0.3,
                    pointRadius: 0,
                    spanGaps: true,
                    hidden: !maVisibility.sma50d
                },
                {
                    label: `MA 200D (${chartCurrency})`,
                    data: sma200d,
                    borderColor: '#a855f7',
                    backgroundColor: 'transparent',
                    borderWidth: 2,
                    fill: false,
                    tension: 0.3,
                    pointRadius: 0,
                    spanGaps: true,
                    hidden: !maVisibility.sma200d
                },
                {
                    label: `MA 200W (${chartCurrency})`,
                    data: sma200w,
                    borderColor: '#10b981',
                    backgroundColor: 'transparent',
                    borderWidth: 2,
                    fill: false,
                    tension: 0.3,
                    pointRadius: 0,
                    spanGaps: true,
                    hidden: !maVisibility.sma200w
                },
                {
                    label: `Power Law 1% (${chartCurrency})`,
                    data: powerLawQ01,
                    borderColor: '#ef4444',
                    backgroundColor: 'transparent',
                    borderWidth: 1.5,
                    borderDash: [6, 4],
                    fill: false,
                    tension: 0.25,
                    pointRadius: 0,
                    spanGaps: true,
                    hidden: !maVisibility.powerlaw
                },
                {
                    label: `Power Law 50% (${chartCurrency})`,
                    data: powerLawQ50,
                    borderColor: '#f59e0b',
                    backgroundColor: 'transparent',
                    borderWidth: 2,
                    borderDash: [6, 4],
                    fill: false,
                    tension: 0.25,
                    pointRadius: 0,
                    spanGaps: true,
                    hidden: !maVisibility.powerlaw
                },
                {
                    label: `Power Law 99% (${chartCurrency})`,
                    data: powerLawQ99,
                    borderColor: '#22c55e',
                    backgroundColor: 'transparent',
                    borderWidth: 1.5,
                    borderDash: [6, 4],
                    fill: false,
                    tension: 0.25,
                    pointRadius: 0,
                    spanGaps: true,
                    hidden: !maVisibility.powerlaw
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                intersect: false,
                mode: 'index'
            },
            plugins: {
                legend: {
                    display: false
                },
                powerLawFormulaOverlay: {
                    formulas: powerLawFormulas
                },
                tooltip: {
                    backgroundColor: 'rgba(0, 0, 0, 0.8)',
                    titleColor: '#fff',
                    bodyColor: '#fff',
                    borderColor: '#f7931a',
                    borderWidth: 1,
                    padding: 12,
                    displayColors: true,
                    callbacks: {
                        label: function(context) {
                            if (context.parsed.y == null) return `${context.dataset.label}: -`;
                            const currency = currentChartCurrency.toUpperCase();
                            return `${context.dataset.label}: ${formatCurrency(context.parsed.y, currency)}`;
                        }
                    }
                }
            },
            scales: {
                x: {
                    grid: {
                        display: false,
                        color: '#333'
                    },
                    ticks: {
                        color: '#a0a0a0',
                        maxTicksLimit: 8
                    }
                },
                y: {
                    type: currentChartScale,
                    grid: {
                        color: '#333'
                    },
                    ticks: {
                        color: '#a0a0a0',
                        callback: function(value) {
                            return formatCurrency(value, currentChartCurrency.toUpperCase(), true);
                        }
                    }
                }
            }
        }
    });
}

function buildPowerLawFormulas() {
    return POWER_LAW_SERIES.map((series) => {
        const params = getSingleTermPowerLawParams(series.key);
        if (!params) return null;

        return {
            color: series.color,
            text: `${series.label}: P = ${params.a.toExponential(2)} · d^${params.b.toFixed(3)}`
        };
    }).filter(Boolean);
}

function getSingleTermPowerLawParams(seriesKey) {
    const rowKey = getPowerLawRowKey(seriesKey);
    const samples = localPriceRows
        .map((row) => ({
            day: convertToBitcoinDayIndex(row.date),
            value: row[rowKey]
        }))
        .filter((sample) => Number.isFinite(sample.day) && Number.isFinite(sample.value) && sample.value > 0);

    return fitSingleTermPowerLaw(samples);
}

function getPowerLawRowKey(seriesKey) {
    const currencySuffix = currentChartCurrency === 'usd' ? 'Usd' : 'Eur';
    const seriesSuffix = seriesKey.replace('powerLaw', '');
    return `powerLaw${seriesSuffix}${currencySuffix}`;
}

function fitSingleTermPowerLaw(samples) {
    if (!Array.isArray(samples) || samples.length < 4) return null;

    const transformed = samples
        .map(({ day, value }) => ({
            logX: Math.log(Math.max(day, 1e-9)),
            logY: Math.log(Math.max(value, 1e-9))
        }))
        .filter(({ logX, logY }) => Number.isFinite(logX) && Number.isFinite(logY));

    if (transformed.length < 4) return null;

    const meanX = transformed.reduce((sum, p) => sum + p.logX, 0) / transformed.length;
    const meanY = transformed.reduce((sum, p) => sum + p.logY, 0) / transformed.length;
    const covariance = transformed.reduce((sum, p) => sum + ((p.logX - meanX) * (p.logY - meanY)), 0);
    const variance = transformed.reduce((sum, p) => sum + ((p.logX - meanX) ** 2), 0);

    if (variance === 0) return null;

    const b = covariance / variance;
    const logA = meanY - (b * meanX);
    const a = Math.exp(logA);

    return Number.isFinite(a) && Number.isFinite(b) ? { a, b } : null;
}

function setupChartControls() {
    const timeframeButtons = document.querySelectorAll('.chart-btn[data-days]');
    const scaleButtons = document.querySelectorAll('.chart-btn[data-scale]');
    const currencyButtons = document.querySelectorAll('.chart-btn[data-currency]');
    const maButtons = document.querySelectorAll('.ma-btn[data-ma]');
    const futureDateInput = document.getElementById('futureDate');

    if (futureDateInput) {
        const today = new Date().toISOString().slice(0, 10);
        futureDateInput.min = today;
        futureDateInput.value = today;
        projectionDate = today;

        futureDateInput.addEventListener('change', async () => {
            projectionDate = futureDateInput.value || today;
            await loadChartData(currentChartDays);
        });
    }

    timeframeButtons.forEach(button => {
        button.addEventListener('click', async () => {
            timeframeButtons.forEach(btn => btn.classList.remove('active'));
            button.classList.add('active');

            const days = button.getAttribute('data-days');
            currentChartDays = days === 'max' ? 'max' : parseInt(days, 10);

            await loadChartData(currentChartDays);
        });
    });

    scaleButtons.forEach(button => {
        button.addEventListener('click', () => {
            scaleButtons.forEach(btn => btn.classList.remove('active'));
            button.classList.add('active');

            currentChartScale = button.getAttribute('data-scale') || 'linear';

            if (btcChart) {
                btcChart.options.scales.y.type = currentChartScale;
                btcChart.update();
            }
        });
    });

    currencyButtons.forEach((button) => {
        button.addEventListener('click', async () => {
            currencyButtons.forEach(btn => btn.classList.remove('active'));
            button.classList.add('active');

            currentChartCurrency = button.getAttribute('data-currency') || 'eur';
            await loadChartData(currentChartDays);
        });
    });

    maButtons.forEach((button) => {
        button.addEventListener('click', () => {
            const maKey = button.getAttribute('data-ma');
            if (!maKey || !(maKey in maVisibility)) return;

            maVisibility[maKey] = !maVisibility[maKey];
            button.classList.toggle('active', maVisibility[maKey]);

            if (!btcChart) return;

            const datasetIndexMap = {
                sma50d: 1,
                sma200d: 2,
                sma200w: 3,
                powerlaw: [4, 5, 6]
            };

            const datasetIndex = datasetIndexMap[maKey];
            if (Array.isArray(datasetIndex)) {
                datasetIndex.forEach((index) => {
                    btcChart.data.datasets[index].hidden = !maVisibility[maKey];
                });
            } else {
                btcChart.data.datasets[datasetIndex].hidden = !maVisibility[maKey];
            }

            btcChart.update();
        });
    });
}

function toNullableNumber(value) {
    if (value == null || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

async function fetchLocalCsvPrices() {
    try {
        const response = await fetch(CONFIG.localPriceDbPath, { cache: 'no-store' });
        if (!response.ok) return [];

        const csv = await response.text();
        const lines = csv.trim().split('\n');
        const rows = [];

        for (let i = 1; i < lines.length; i += 1) {
            const [
                date,
                closeEur,
                closeUsd,
                sma50dEur,
                sma200dEur,
                sma200wEur,
                sma50dUsd,
                sma200dUsd,
                sma200wUsd,
                powerLawQ01Eur,
                powerLawQ50Eur,
                powerLawQ99Eur,
                powerLawQ01Usd,
                powerLawQ50Usd,
                powerLawQ99Usd
            ] = lines[i].split(',');
            if (!date || !closeEur || !closeUsd) continue;

            rows.push({
                date,
                closeEur: Number(closeEur),
                closeUsd: Number(closeUsd),
                sma50dEur: toNullableNumber(sma50dEur),
                sma200dEur: toNullableNumber(sma200dEur),
                sma200wEur: toNullableNumber(sma200wEur),
                sma50dUsd: toNullableNumber(sma50dUsd),
                sma200dUsd: toNullableNumber(sma200dUsd),
                sma200wUsd: toNullableNumber(sma200wUsd),
                powerLawQ01Eur: toNullableNumber(powerLawQ01Eur),
                powerLawQ50Eur: toNullableNumber(powerLawQ50Eur),
                powerLawQ99Eur: toNullableNumber(powerLawQ99Eur),
                powerLawQ01Usd: toNullableNumber(powerLawQ01Usd),
                powerLawQ50Usd: toNullableNumber(powerLawQ50Usd),
                powerLawQ99Usd: toNullableNumber(powerLawQ99Usd)
            });
        }

        const validRows = rows.filter(row => Number.isFinite(row.closeEur) && Number.isFinite(row.closeUsd));
        return attachCalculatedMovingAverages(validRows);
    } catch (error) {
        console.warn('Lokale CSV konnte nicht geladen werden:', error);
        return [];
    }
}

function attachCalculatedMovingAverages(rows) {
    const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
    const eurWindow = { sma50dEur: 50, sma200dEur: 200, sma200wEur: 1400 };
    const usdWindow = { sma50dUsd: 50, sma200dUsd: 200, sma200wUsd: 1400 };

    let eurSum50 = 0;
    let eurSum200 = 0;
    let eurSum1400 = 0;
    let usdSum50 = 0;
    let usdSum200 = 0;
    let usdSum1400 = 0;

    const dateSeries = sorted.map((row) => row.date);
    const eurSeries = sorted.map((row) => row.closeEur);
    const usdSeries = sorted.map((row) => row.closeUsd);
    const eurQ01 = fitPowerLawQuantileRegression(dateSeries, eurSeries, 0.01);
    const eurQ50 = fitPowerLawQuantileRegression(dateSeries, eurSeries, 0.5);
    const eurQ99 = fitPowerLawQuantileRegression(dateSeries, eurSeries, 0.99);
    const usdQ01 = fitPowerLawQuantileRegression(dateSeries, usdSeries, 0.01);
    const usdQ50 = fitPowerLawQuantileRegression(dateSeries, usdSeries, 0.5);
    const usdQ99 = fitPowerLawQuantileRegression(dateSeries, usdSeries, 0.99);

    return sorted.map((row, index) => {
        eurSum50 += row.closeEur;
        eurSum200 += row.closeEur;
        eurSum1400 += row.closeEur;
        usdSum50 += row.closeUsd;
        usdSum200 += row.closeUsd;
        usdSum1400 += row.closeUsd;

        if (index >= eurWindow.sma50dEur) {
            eurSum50 -= sorted[index - eurWindow.sma50dEur].closeEur;
            usdSum50 -= sorted[index - usdWindow.sma50dUsd].closeUsd;
        }
        if (index >= eurWindow.sma200dEur) {
            eurSum200 -= sorted[index - eurWindow.sma200dEur].closeEur;
            usdSum200 -= sorted[index - usdWindow.sma200dUsd].closeUsd;
        }
        if (index >= eurWindow.sma200wEur) {
            eurSum1400 -= sorted[index - eurWindow.sma200wEur].closeEur;
            usdSum1400 -= sorted[index - usdWindow.sma200wUsd].closeUsd;
        }

        return {
            ...row,
            sma50dEur: row.sma50dEur ?? (index >= eurWindow.sma50dEur - 1 ? eurSum50 / eurWindow.sma50dEur : null),
            sma200dEur: row.sma200dEur ?? (index >= eurWindow.sma200dEur - 1 ? eurSum200 / eurWindow.sma200dEur : null),
            sma200wEur: row.sma200wEur ?? (index >= eurWindow.sma200wEur - 1 ? eurSum1400 / eurWindow.sma200wEur : null),
            sma50dUsd: row.sma50dUsd ?? (index >= usdWindow.sma50dUsd - 1 ? usdSum50 / usdWindow.sma50dUsd : null),
            sma200dUsd: row.sma200dUsd ?? (index >= usdWindow.sma200dUsd - 1 ? usdSum200 / usdWindow.sma200dUsd : null),
            sma200wUsd: row.sma200wUsd ?? (index >= usdWindow.sma200wUsd - 1 ? usdSum1400 / usdWindow.sma200wUsd : null),
            powerLawQ01Eur: row.powerLawQ01Eur ?? predictPowerLaw(row.date, eurQ01),
            powerLawQ50Eur: row.powerLawQ50Eur ?? predictPowerLaw(row.date, eurQ50),
            powerLawQ99Eur: row.powerLawQ99Eur ?? predictPowerLaw(row.date, eurQ99),
            powerLawQ01Usd: row.powerLawQ01Usd ?? predictPowerLaw(row.date, usdQ01),
            powerLawQ50Usd: row.powerLawQ50Usd ?? predictPowerLaw(row.date, usdQ50),
            powerLawQ99Usd: row.powerLawQ99Usd ?? predictPowerLaw(row.date, usdQ99)
        };
    });
}

function fitPowerLawQuantileRegression(dates, prices, tau, options = {}) {
    const {
        iterations = 8000,
        learningRate = 0.02,
        epsilon = 1e-9
    } = options;

    const rawSamples = dates.map((date, index) => {
        const day = convertToBitcoinDayIndex(date);
        return {
            day,
            value: Number(prices[index])
        };
    });

    const samples = rawSamples.filter((sample) => Number.isFinite(sample.day) && Number.isFinite(sample.value));
    if (samples.length < 4) {
        return { a: NaN, b: NaN, c: NaN, d: NaN };
    }

    const priceValues = samples.map((sample) => sample.value);
    const minPrice = Math.min(...priceValues);
    const maxPrice = Math.max(...priceValues);

    const dayValues = samples.map((sample) => Math.max(sample.day, epsilon));
    const logXMean = dayValues.reduce((sum, day) => sum + Math.log(day), 0) / dayValues.length;
    const logYMean = priceValues.reduce((sum, price) => sum + Math.log(Math.max(price, epsilon)), 0) / priceValues.length;
    const logCovariance = dayValues.reduce((sum, day, index) => {
        return sum + ((Math.log(day) - logXMean) * (Math.log(Math.max(priceValues[index], epsilon)) - logYMean));
    }, 0);
    const logVariance = dayValues.reduce((sum, day) => sum + ((Math.log(day) - logXMean) ** 2), 0);

    const dominantExponent = logVariance === 0 ? 1 : Math.max(logCovariance / logVariance, 0.05);
    let a = Math.max(Math.exp(logYMean - (dominantExponent * logXMean)) * 0.35, epsilon);
    let b = Math.max(dominantExponent * 0.65, 0.05);
    let c = Math.max(Math.exp(logYMean - (dominantExponent * logXMean)) * 0.65, epsilon);
    let d = Math.min(Math.max(dominantExponent * 1.35, 0.05), 12);

    let mA = 0;
    let mB = 0;
    let mC = 0;
    let mD = 0;
    let vA = 0;
    let vB = 0;
    let vC = 0;
    let vD = 0;
    const beta1 = 0.9;
    const beta2 = 0.999;

    for (let step = 1; step <= iterations; step += 1) {
        let gradA = 0;
        let gradB = 0;
        let gradC = 0;
        let gradD = 0;

        for (const sample of samples) {
            const dayBase = Math.max(sample.day, epsilon);
            const firstComponent = Math.pow(dayBase, b);
            const secondComponent = Math.pow(dayBase, d);
            const prediction = (a * firstComponent) + (c * secondComponent);
            const residual = sample.value - prediction;
            const psi = residual >= 0 ? tau : tau - 1;
            const dLossDPrediction = -psi;

            gradA += dLossDPrediction * firstComponent;
            gradB += dLossDPrediction * a * firstComponent * Math.log(dayBase);
            gradC += dLossDPrediction * secondComponent;
            gradD += dLossDPrediction * c * secondComponent * Math.log(dayBase);
        }

        const n = samples.length;
        gradA /= n;
        gradB /= n;
        gradC /= n;
        gradD /= n;

        mA = (beta1 * mA) + ((1 - beta1) * gradA);
        mB = (beta1 * mB) + ((1 - beta1) * gradB);
        mC = (beta1 * mC) + ((1 - beta1) * gradC);
        mD = (beta1 * mD) + ((1 - beta1) * gradD);

        vA = (beta2 * vA) + ((1 - beta2) * gradA * gradA);
        vB = (beta2 * vB) + ((1 - beta2) * gradB * gradB);
        vC = (beta2 * vC) + ((1 - beta2) * gradC * gradC);
        vD = (beta2 * vD) + ((1 - beta2) * gradD * gradD);

        const mAHat = mA / (1 - (beta1 ** step));
        const mBHat = mB / (1 - (beta1 ** step));
        const mCHat = mC / (1 - (beta1 ** step));
        const mDHat = mD / (1 - (beta1 ** step));

        const vAHat = vA / (1 - (beta2 ** step));
        const vBHat = vB / (1 - (beta2 ** step));
        const vCHat = vC / (1 - (beta2 ** step));
        const vDHat = vD / (1 - (beta2 ** step));

        a -= learningRate * (mAHat / (Math.sqrt(vAHat) + epsilon));
        b -= learningRate * (mBHat / (Math.sqrt(vBHat) + epsilon));
        c -= learningRate * (mCHat / (Math.sqrt(vCHat) + epsilon));
        d -= learningRate * (mDHat / (Math.sqrt(vDHat) + epsilon));

        if (!Number.isFinite(a)) a = minPrice * 0.1;
        if (!Number.isFinite(b)) b = 1;
        if (!Number.isFinite(c)) c = minPrice * 0.1;
        if (!Number.isFinite(d)) d = 2;

        a = Math.min(Math.max(a, epsilon), maxPrice * 10);
        c = Math.min(Math.max(c, epsilon), maxPrice * 10);
        b = Math.min(Math.max(b, 0.01), 12);
        d = Math.min(Math.max(d, 0.01), 12);
    }

    if (b > d) {
        [a, c] = [c, a];
        [b, d] = [d, b];
    }

    return { a, b, c, d };
}

function predictPowerLaw(date, params) {
    const dayNumber = convertToBitcoinDayIndex(date);

    const { a, b, c, d } = params || {};
    if (![a, b, c, d].every(Number.isFinite)) return null;

    const base = Math.max(dayNumber, 1e-9);
    return (a * Math.pow(base, b)) + (c * Math.pow(base, d));
}

function convertToBitcoinDayIndex(input) {
    const BITCOIN_GENESIS_DAY_MS = Date.parse('2009-01-03T00:00:00Z');
    const value = typeof input === 'number'
        ? input
        : Date.parse(`${input}T00:00:00Z`);

    if (!Number.isFinite(value)) return NaN;
    const timestamp = value > 1e11 ? value : value * 24 * 60 * 60 * 1000;
    return Math.max(Math.floor((timestamp - BITCOIN_GENESIS_DAY_MS) / (1000 * 60 * 60 * 24)) + 1, 1);
}

async function getLatestLocalClose() {
    const rows = await fetchLocalCsvPrices();
    if (rows.length === 0) return null;

    return rows.reduce((latest, row) => (row.date > latest.date ? row : latest), rows[0]);
}

// ============================================================================
// Fundamental Indicators
// ============================================================================

async function loadFundamentalIndicators() {
    // Since we're using free APIs, we'll calculate some indicators
    // and use placeholder data for others that require premium APIs
    
    await calculate200WMA();
    calculatePowerLaw();
    calculateStockToFlow();
    displayPlaceholderIndicators();
}

async function calculate200WMA() {
    try {
        const modelRows = localPriceRows
            .filter((row) => Number.isFinite(row.closeUsd) && Number.isFinite(row.sma200wUsd))
            .sort((a, b) => a.date.localeCompare(b.date));

        if (modelRows.length === 0) throw new Error('Keine 200WMA Modelldaten verfügbar');

        const latestRow = modelRows[modelRows.length - 1];
        const currentPriceUsd = latestRow.closeUsd;
        const current200WmaUsd = latestRow.sma200wUsd;
        const currentRatioPercent = (currentPriceUsd / current200WmaUsd) * 100;

        const ratioSeries = modelRows
            .map((row) => (row.closeUsd / row.sma200wUsd) * 100)
            .filter(Number.isFinite);

        const daysBelowCurrentRatio = ratioSeries.filter((ratio) => ratio < currentRatioPercent).length;
        const belowSharePercent = (daysBelowCurrentRatio / ratioSeries.length) * 100;
        const cheaperThanPercent = 100 - belowSharePercent;

        document.getElementById('wma200').innerHTML = formatCurrency(current200WmaUsd, 'USD');
        document.getElementById('wma200Distance').textContent = `${currentRatioPercent.toFixed(1)}%`;
        document.getElementById('wma200UnderRatio').textContent =
            `Günstiger als ${cheaperThanPercent.toFixed(1)}% der Zeit`;

        const interpretation = document.getElementById('wma200Interpretation');
        interpretation.textContent = '';
        interpretation.className = 'indicator-interpretation interpretation-neutral';

    } catch (error) {
        console.error('Fehler bei 200WMA Berechnung:', error);
        document.getElementById('wma200').innerHTML = '<span style="color: #ef4444;">Fehler</span>';
        document.getElementById('wma200Distance').textContent = '-';
        document.getElementById('wma200UnderRatio').textContent = '-';
        document.getElementById('wma200Interpretation').textContent = '';
    }
}

function calculatePowerLaw() {
    try {
        const modelRows = localPriceRows
            .filter((row) => (
                Number.isFinite(row.closeUsd)
                && Number.isFinite(row.powerLawQ01Usd)
                && Number.isFinite(row.powerLawQ99Usd)
                && row.powerLawQ99Usd > row.powerLawQ01Usd
            ))
            .sort((a, b) => a.date.localeCompare(b.date));

        if (modelRows.length === 0) throw new Error('Keine Power-Law-Modelldaten verfügbar');

        const latestRow = modelRows[modelRows.length - 1];
        const currentPriceUsd = latestRow.closeUsd;
        const q01 = latestRow.powerLawQ01Usd;
        const q50 = latestRow.powerLawQ50Usd;
        const q99 = latestRow.powerLawQ99Usd;
        const currentIndexPercent = Math.max(0, Math.min(100, ((currentPriceUsd - q01) / (q99 - q01)) * 100));

        const indexSeries = modelRows
            .map((row) => ((row.closeUsd - row.powerLawQ01Usd) / (row.powerLawQ99Usd - row.powerLawQ01Usd)) * 100)
            .filter(Number.isFinite)
            .map((value) => Math.max(0, Math.min(100, value)));

        const daysBelowCurrentIndex = indexSeries.filter((value) => value < currentIndexPercent).length;
        const belowSharePercent = (daysBelowCurrentIndex / indexSeries.length) * 100;
        const cheaperThanPercent = 100 - belowSharePercent;

        document.getElementById('powerLaw').innerHTML =
            `<div style="font-size: 1rem; color: #a0a0a0;">Index (0% = untere Linie, 100% = obere Linie): ${currentIndexPercent.toFixed(1)}%</div>`;
        document.getElementById('powerLawQ01').textContent = formatCurrency(q01, 'USD');
        document.getElementById('powerLawQ50').textContent = Number.isFinite(q50) ? formatCurrency(q50, 'USD') : '-';
        document.getElementById('powerLawQ99').textContent = formatCurrency(q99, 'USD');
        document.getElementById('powerLawPercentile').textContent =
            `Günstiger als ${cheaperThanPercent.toFixed(1)}% der Zeit`;

        const interpretation = document.getElementById('powerLawInterpretation');
        interpretation.textContent = '';
        interpretation.className = 'indicator-interpretation interpretation-neutral';
    } catch (error) {
        console.error('Fehler bei Power-Law-Berechnung:', error);
        document.getElementById('powerLaw').innerHTML = '<span style="color: #ef4444;">Fehler</span>';
        document.getElementById('powerLawQ01').textContent = '-';
        document.getElementById('powerLawQ50').textContent = '-';
        document.getElementById('powerLawQ99').textContent = '-';
        document.getElementById('powerLawPercentile').textContent = '-';
        document.getElementById('powerLawInterpretation').textContent = '';
    }
}

function calculateStockToFlow() {
    // Stock-to-Flow calculation
    // Current supply: ~19.8M BTC, Annual production: ~328,500 BTC (post-2024 halving)
    const currentSupply = 19800000;
    const annualProduction = 164250; // 900 BTC/day * 0.5 (after 2024 halving) * 365
    const s2f = currentSupply / annualProduction;
    
    // S2F Model: Price = 0.4 * S2F^3 (approximate formula)
    const s2fModelPriceUSD = 0.4 * Math.pow(s2f, 3);
    const s2fModelPriceEUR = s2fModelPriceUSD * 0.92;
    
    document.getElementById('stockToFlow').innerHTML = 
        `<div style="font-size: 1.5rem;">${s2f.toFixed(1)}</div>`;
    document.getElementById('s2fModelPrice').textContent = 
        formatCurrency(s2fModelPriceEUR, 'EUR');
    
    const interpretation = document.getElementById('s2fInterpretation');
    interpretation.textContent = '💎 Hohe Knappheit (Post-Halving 2024)';
    interpretation.className = 'indicator-interpretation interpretation-bullish';
}

function displayPlaceholderIndicators() {
    // Coin Days Destroyed
    document.getElementById('cdd').innerHTML = 
        '<div style="font-size: 1rem; color: #a0a0a0;">Premium Daten erforderlich</div>';
    document.getElementById('cddAvg').textContent = '-';
    const cddInterpretation = document.getElementById('cddInterpretation');
    cddInterpretation.textContent = '📊 Glassnode API erforderlich';
    cddInterpretation.className = 'indicator-interpretation interpretation-neutral';
    
    // MVRV Ratio
    document.getElementById('mvrv').innerHTML = 
        '<div style="font-size: 1rem; color: #a0a0a0;">Premium Daten erforderlich</div>';
    document.getElementById('mvrvZ').textContent = '-';
    const mvrvInterpretation = document.getElementById('mvrvInterpretation');
    mvrvInterpretation.textContent = '📊 Glassnode API erforderlich';
    mvrvInterpretation.className = 'indicator-interpretation interpretation-neutral';
    
    // Puell Multiple
    document.getElementById('puell').innerHTML = 
        '<div style="font-size: 1rem; color: #a0a0a0;">Premium Daten erforderlich</div>';
    document.getElementById('puellStatus').textContent = '-';
    const puellInterpretation = document.getElementById('puellInterpretation');
    puellInterpretation.textContent = '📊 Glassnode API erforderlich';
    puellInterpretation.className = 'indicator-interpretation interpretation-neutral';
}

// ============================================================================
// Utility Functions
// ============================================================================

function formatCurrency(value, currency = 'EUR', short = false) {
    if (short && value > 999) {
        return value.toLocaleString('de-DE', {
            style: 'currency',
            currency: currency,
            minimumFractionDigits: 0,
            maximumFractionDigits: 0
        });
    }
    
    return value.toLocaleString('de-DE', {
        style: 'currency',
        currency: currency,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
}

function formatLargeNumber(num) {
    if (num >= 1e12) {
        return (num / 1e12).toFixed(2) + ' Bio.';
    } else if (num >= 1e9) {
        return (num / 1e9).toFixed(2) + ' Mrd.';
    } else if (num >= 1e6) {
        return (num / 1e6).toFixed(2) + ' Mio.';
    }
    return num.toLocaleString('de-DE');
}

function updateLastUpdateTime() {
    const now = new Date();
    document.getElementById('lastUpdate').textContent = 
        now.toLocaleTimeString('de-DE', { 
            hour: '2-digit', 
            minute: '2-digit',
            second: '2-digit'
        });
}

function showError(message) {
    console.error(message);
    // Could add a toast notification here
}

// ============================================================================
// Export for testing
// ============================================================================

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        formatCurrency,
        formatLargeNumber,
        calculate200WMA,
        calculatePowerLaw
    };
}
