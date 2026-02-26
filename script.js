// Bitcoin Dashboard - Main JavaScript

// Configuration
const CONFIG = {
    coingecko: {
        baseUrl: 'https://api.coingecko.com/api/v3',
        coin: 'bitcoin'
    },
    refreshInterval: 60000, // 1 minute
    chartDays: 7,
    localPriceDbPath: 'data/btc_daily_prices.csv',
    totalCoinsEver: 20999999.9769,
    estimatedLostCoins: 4_000_000,
    treasuryCompanies: [
        {
            key: 'strategy',
            displayName: 'Strategy',
            quoteSymbol: 'MSTR',
            aliases: ['strategy', 'microstrategy'],
            fallbackBtcHoldings: 499226,
            fallbackSharesOutstanding: 20_900_000,
            satsPerShare1yAgo: 1_750_000,
            satsPerShareNow: null,
            fallbackNmav: null,
            fallbackAmplification: null,
            sourceUrl: 'https://www.strategy.com/'
        },
        {
            key: 'metaplanet',
            displayName: 'Metaplanet',
            quoteSymbol: '3350.T',
            aliases: ['metaplanet'],
            fallbackBtcHoldings: 2235,
            fallbackSharesOutstanding: 539_200_000,
            satsPerShare1yAgo: 78,
            satsPerShareNow: null,
            fallbackNmav: null,
            fallbackAmplification: null,
            sourceUrl: 'https://analytics.metaplanet.jp/?tab=home'
        },
        {
            key: 'capitalb',
            displayName: 'Capital B',
            quoteSymbol: 'CAPB.PA',
            aliases: ['capital b', 'capitalb'],
            fallbackBtcHoldings: null,
            fallbackSharesOutstanding: 2_930_000,
            satsPerShare1yAgo: 8_000,
            satsPerShareNow: null,
            fallbackNmav: null,
            fallbackAmplification: null,
            sourceUrl: 'https://cptlb.com/analytics/'
        }
    ]
};

// Global state
let btcChart = null;
let currentChartDays = 7;
let currentChartScale = 'linear';
let currentChartCurrency = 'eur';
let currentKpiCurrency = 'usd';
let chartRequestId = 0;
let localPriceRows = [];
let localPriceRowsPromise = null;
let projectionDate = '';
let latestBitcoinPriceUsd = null;
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

const ASSET_CLASSES_BASE = [
    { key: 'realEstate', name: 'Immobilien (global)', marketCapUsd: 380e12, color: '#7c7c7c' },
    { key: 'equities', name: 'Aktien (global)', marketCapUsd: 125e12, color: '#3b82f6' },
    { key: 'privateBusinesses', name: 'Unternehmen (privat)', marketCapUsd: 60e12, color: '#6366f1' },
    { key: 'sovereignBonds', name: 'Anleihen (Staat)', marketCapUsd: 85e12, color: '#8b5cf6' },
    { key: 'corporateBonds', name: 'Anleihen (Unternehmen)', marketCapUsd: 45e12, color: '#a855f7' },
    { key: 'cash', name: 'Cash (M2, global)', marketCapUsd: 110e12, color: '#16a34a' },
    // Gold + Silber (companiesmarketcap.com/assets-by-market-cap)
    { key: 'preciousMetals', name: 'Gold + Silber', marketCapUsd: 38e12, color: '#d4af37' },
    { key: 'art', name: 'Kunst', marketCapUsd: 2.2e12, color: '#ec4899' },
    { key: 'bitcoin', name: 'Bitcoin', marketCapUsd: 2.1e12, color: '#f7931a' }
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
    prepareStagedSections();
    localPriceRowsPromise = ensureLocalPriceRows();

    // Setup controls immediately so UI can react while data streams in
    setupChartControls();
    setupKpiCurrencyControls();
    renderAssetClassTreemap();

    // Smart-Money bewusst nicht blockierend laden
    loadSmartMoneyDigest().finally(() => {
        revealSection('smart-money');
    });

    loadTreasuryCompanies().finally(() => {
        revealSection('treasury');
    });

    // Stage 1: top KPIs first
    await loadBitcoinData();
    revealSection('price');
    revealSection('assets');

    // Stage 2 + 3: chart first, then calculations/indicators
    requestAnimationFrame(async () => {
        await localPriceRowsPromise;
        await loadChartData(currentChartDays);
        revealSection('chart');

        setTimeout(async () => {
            await loadFundamentalIndicators();
            revealSection('indicators');
        }, 0);
    });
    
    // Setup auto-refresh
    setInterval(async () => {
        await loadBitcoinData();
        await loadFundamentalIndicators();
        await loadTreasuryCompanies();
    }, CONFIG.refreshInterval);

    // Smart-Money-Update reicht täglich, wir pollen nur sehr selten neu
    setInterval(loadSmartMoneyDigest, 60 * 60 * 1000);
    
    // Update last update time
    updateLastUpdateTime();
    setInterval(updateLastUpdateTime, 30000);
}

function prepareStagedSections() {
    document.querySelectorAll('[data-stage]').forEach((section) => {
        section.classList.add('section-staged', 'is-loading');
        if (!section.querySelector('.section-loader')) {
            const loader = document.createElement('div');
            loader.className = 'section-loader';
            loader.innerHTML = '<span class="section-loader-icon" aria-hidden="true">₿</span>';
            loader.setAttribute('aria-label', 'Ladeindikator');
            section.appendChild(loader);
        }
    });
}

function revealSection(stageName) {
    const section = document.querySelector(`[data-stage="${stageName}"]`);
    if (!section) return;
    section.classList.remove('is-loading');
    section.classList.add('is-visible');
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
        updateNetworkStats(data).catch((error) => {
            console.error('Fehler beim Laden der Netzwerkdaten:', error);
            clearNetworkStats();
        });
        
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
            clearNetworkStats();
        } else {
            showError('Preisdaten konnten nicht geladen werden');
            clearNetworkStats();
        }
    }
}

async function ensureLocalPriceRows() {
    if (localPriceRows.length > 0) return localPriceRows;
    const rows = await fetchLocalCsvPrices();
    localPriceRows = rows;
    return rows;
}

function updatePriceDisplay(data) {
    const price = data.market_data;
    
    // EUR price
    const eurPrice = price.current_price.eur;
    document.getElementById('btcPrice').textContent = 
        formatCurrency(eurPrice, 'EUR');
    
    // USD price
    const usdPrice = price.current_price.usd;
    latestBitcoinPriceUsd = Number.isFinite(usdPrice) ? usdPrice : latestBitcoinPriceUsd;
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

    renderAssetClassTreemap({
        bitcoinMarketCapUsd: price.market_cap.usd,
        bitcoinPriceEur: price.current_price.eur,
        bitcoinPriceUsd: price.current_price.usd,
        circulatingSupply: price.circulating_supply
    });
}

async function updateNetworkStats(data) {
    const circulatingSupply = data?.market_data?.circulating_supply;
    document.getElementById('circulatingSupply').textContent =
        Number.isFinite(circulatingSupply) ? `${formatBtcAmount(circulatingSupply)} BTC` : '-';
    document.getElementById('totalCoinsEver').textContent =
        `Jemals: ${formatBtcAmount(CONFIG.totalCoinsEver)} BTC`;

    let blockHeight = null;
    let hashrateEh = null;

    try {
        const [heightResponse, hashrateResponse] = await Promise.all([
            fetch('https://mempool.space/api/blocks/tip/height'),
            fetch('https://mempool.space/api/v1/mining/hashrate/1m')
        ]);

        if (heightResponse.ok) {
            const heightText = await heightResponse.text();
            blockHeight = Number.parseInt(heightText, 10);
        }

        if (hashrateResponse.ok) {
            const hashrateData = await hashrateResponse.json();
            if (Number.isFinite(hashrateData?.currentHashrate)) {
                hashrateEh = hashrateData.currentHashrate / 1e18;
            }
        }
    } catch (error) {
        console.error('Fehler beim Laden der Netzwerkdaten:', error);
    }

    document.getElementById('blockHeight').textContent =
        Number.isFinite(blockHeight) ? blockHeight.toLocaleString('de-DE') : '-';

    document.getElementById('networkHashrate').textContent =
        Number.isFinite(hashrateEh) ? `${hashrateEh.toFixed(1)} EH/s` : '-';

    const blockSubsidy = calculateBlockSubsidy(blockHeight);
    const annualInflation = (Number.isFinite(blockSubsidy) && Number.isFinite(circulatingSupply) && circulatingSupply > 0)
        ? ((blockSubsidy * 144 * 365.25) / circulatingSupply) * 100
        : null;

    document.getElementById('annualInflation').textContent =
        Number.isFinite(annualInflation) ? `${annualInflation.toFixed(2)}%` : '-';
}

function calculateBlockSubsidy(blockHeight) {
    if (!Number.isFinite(blockHeight) || blockHeight < 0) return null;
    const halvings = Math.floor(blockHeight / 210000);
    if (halvings >= 64) return 0;
    return 50 / (2 ** halvings);
}

function clearNetworkStats() {
    ['blockHeight', 'circulatingSupply', 'totalCoinsEver', 'annualInflation', 'networkHashrate']
        .forEach((id) => {
            document.getElementById(id).textContent = '-';
        });
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


function setupKpiCurrencyControls() {
    const kpiCurrencyButtons = document.querySelectorAll('.chart-btn[data-kpi-currency]');
    const indicatorsTitle = document.getElementById('indicatorsTitle');

    const updateTitle = () => {
        if (indicatorsTitle) {
            indicatorsTitle.textContent = `Kurs-Indikatoren (${currentKpiCurrency.toUpperCase()})`;
        }
    };

    updateTitle();

    kpiCurrencyButtons.forEach((button) => {
        button.addEventListener('click', async () => {
            kpiCurrencyButtons.forEach((btn) => btn.classList.remove('active'));
            button.classList.add('active');
            currentKpiCurrency = button.getAttribute('data-kpi-currency') || 'usd';
            updateTitle();
            await loadFundamentalIndicators();
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
        const header = lines[0].split(',');
        const columnIndex = new Map(header.map((name, index) => [name, index]));
        const readColumn = (columns, name) => {
            const index = columnIndex.get(name);
            if (!Number.isInteger(index)) return undefined;
            return columns[index];
        };

        for (let i = 1; i < lines.length; i += 1) {
            const columns = lines[i].split(',');
            const date = readColumn(columns, 'date');
            const closeEur = readColumn(columns, 'close_eur');
            const closeUsd = readColumn(columns, 'close_usd');
            if (!date || !closeEur || !closeUsd) continue;

            rows.push({
                date,
                closeEur: Number(closeEur),
                closeUsd: Number(closeUsd),
                sma50dEur: toNullableNumber(readColumn(columns, 'sma50d_eur')),
                sma200dEur: toNullableNumber(readColumn(columns, 'sma200d_eur')),
                sma200wEur: toNullableNumber(readColumn(columns, 'sma200w_eur')),
                sma200wFactorEur: toNullableNumber(readColumn(columns, 'sma200w_factor_eur')),
                sma50dUsd: toNullableNumber(readColumn(columns, 'sma50d_usd')),
                sma200dUsd: toNullableNumber(readColumn(columns, 'sma200d_usd')),
                sma200wUsd: toNullableNumber(readColumn(columns, 'sma200w_usd')),
                sma200wFactorUsd: toNullableNumber(readColumn(columns, 'sma200w_factor_usd')),
                powerLawQ01Eur: toNullableNumber(readColumn(columns, 'powerlaw_q01_eur')),
                powerLawQ50Eur: toNullableNumber(readColumn(columns, 'powerlaw_q50_eur')),
                powerLawQ99Eur: toNullableNumber(readColumn(columns, 'powerlaw_q99_eur')),
                powerLawFactorEur: toNullableNumber(readColumn(columns, 'powerlaw_factor_eur')),
                powerLawQ01Usd: toNullableNumber(readColumn(columns, 'powerlaw_q01_usd')),
                powerLawQ50Usd: toNullableNumber(readColumn(columns, 'powerlaw_q50_usd')),
                powerLawQ99Usd: toNullableNumber(readColumn(columns, 'powerlaw_q99_usd')),
                powerLawFactorUsd: toNullableNumber(readColumn(columns, 'powerlaw_factor_usd'))
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

        const sma200wEur = row.sma200wEur ?? (index >= eurWindow.sma200wEur - 1 ? eurSum1400 / eurWindow.sma200wEur : null);
        const sma200wUsd = row.sma200wUsd ?? (index >= usdWindow.sma200wUsd - 1 ? usdSum1400 / usdWindow.sma200wUsd : null);
        const powerLawQ01Eur = row.powerLawQ01Eur ?? predictPowerLaw(row.date, eurQ01);
        const powerLawQ99Eur = row.powerLawQ99Eur ?? predictPowerLaw(row.date, eurQ99);
        const powerLawQ01Usd = row.powerLawQ01Usd ?? predictPowerLaw(row.date, usdQ01);
        const powerLawQ99Usd = row.powerLawQ99Usd ?? predictPowerLaw(row.date, usdQ99);

        return {
            ...row,
            sma50dEur: row.sma50dEur ?? (index >= eurWindow.sma50dEur - 1 ? eurSum50 / eurWindow.sma50dEur : null),
            sma200dEur: row.sma200dEur ?? (index >= eurWindow.sma200dEur - 1 ? eurSum200 / eurWindow.sma200dEur : null),
            sma200wEur,
            sma200wFactorEur: Number.isFinite(sma200wEur) && sma200wEur !== 0 ? row.closeEur / sma200wEur : null,
            sma50dUsd: row.sma50dUsd ?? (index >= usdWindow.sma50dUsd - 1 ? usdSum50 / usdWindow.sma50dUsd : null),
            sma200dUsd: row.sma200dUsd ?? (index >= usdWindow.sma200dUsd - 1 ? usdSum200 / usdWindow.sma200dUsd : null),
            sma200wUsd,
            sma200wFactorUsd: Number.isFinite(sma200wUsd) && sma200wUsd !== 0 ? row.closeUsd / sma200wUsd : null,
            powerLawQ01Eur,
            powerLawQ50Eur: row.powerLawQ50Eur ?? predictPowerLaw(row.date, eurQ50),
            powerLawQ99Eur,
            powerLawFactorEur: Number.isFinite(powerLawQ99Eur) && Number.isFinite(powerLawQ01Eur) && powerLawQ99Eur !== powerLawQ01Eur ? (row.closeEur - powerLawQ01Eur) / (powerLawQ99Eur - powerLawQ01Eur) : null,
            powerLawQ01Usd,
            powerLawQ50Usd: row.powerLawQ50Usd ?? predictPowerLaw(row.date, usdQ50),
            powerLawQ99Usd,
            powerLawFactorUsd: Number.isFinite(powerLawQ99Usd) && Number.isFinite(powerLawQ01Usd) && powerLawQ99Usd !== powerLawQ01Usd ? (row.closeUsd - powerLawQ01Usd) / (powerLawQ99Usd - powerLawQ01Usd) : null
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

    await ensureLocalPriceRows();

    await calculate200WMA(currentKpiCurrency);
    calculatePowerLaw(currentKpiCurrency);
    calculateRsi(currentKpiCurrency);
    await loadFearAndGreedIndex();
}


function setIndicatorLightState(elementId, state = 'neutral') {
    const light = document.getElementById(elementId);
    if (!light) return;

    light.classList.remove(
        'indicator-traffic-light--green',
        'indicator-traffic-light--yellow',
        'indicator-traffic-light--red'
    );

    if (state === 'green') light.classList.add('indicator-traffic-light--green');
    if (state === 'yellow') light.classList.add('indicator-traffic-light--yellow');
    if (state === 'red') light.classList.add('indicator-traffic-light--red');
}

function getAmpelStateByThresholds(value, { greenMax, yellowMax }) {
    if (!Number.isFinite(value)) return 'neutral';
    if (value <= greenMax) return 'green';
    if (value <= yellowMax) return 'yellow';
    return 'red';
}

function calculateRsi(currency = 'usd') {
    try {
        const isUsd = currency === 'usd';
        const priceKey = isUsd ? 'closeUsd' : 'closeEur';
        const closes = localPriceRows
            .map((row) => row[priceKey])
            .filter(Number.isFinite);

        const rsi7 = calculateRsiForPeriod(closes, 7);
        const rsi14 = calculateRsiForPeriod(closes, 14);
        const rsi30 = calculateRsiForPeriod(closes, 30);

        const weightedRsi = (rsi7 + (2 * rsi14) + rsi30) / 4;
        const { signal } = getRsiInterpretation(weightedRsi);

        document.getElementById('rsiValue').innerHTML = `<div style="font-size: 1.5rem;">${weightedRsi.toFixed(1)}</div>`;
        document.getElementById('rsi7d').textContent = rsi7.toFixed(1);
        document.getElementById('rsi14d').textContent = rsi14.toFixed(1);
        document.getElementById('rsi30d').textContent = rsi30.toFixed(1);
        document.getElementById('rsiSignal').textContent = signal;

        setIndicatorLightState('rsiLight', getAmpelStateByThresholds(weightedRsi, { greenMax: 25, yellowMax: 75 }));

    } catch (error) {
        console.error('Fehler bei RSI-Berechnung:', error);
        document.getElementById('rsiValue').innerHTML = '<span style="color: #ef4444;">Fehler</span>';
        document.getElementById('rsi7d').textContent = '-';
        document.getElementById('rsi14d').textContent = '-';
        document.getElementById('rsi30d').textContent = '-';
        document.getElementById('rsiSignal').textContent = '-';
        setIndicatorLightState('rsiLight', 'neutral');
    }
}

function calculateRsiForPeriod(closes, period) {
    if (!Array.isArray(closes) || closes.length <= period) {
        throw new Error(`Zu wenige Daten für RSI ${period}D`);
    }

    const recent = closes.slice(-(period + 1));
    let gains = 0;
    let losses = 0;

    for (let i = 1; i < recent.length; i += 1) {
        const delta = recent[i] - recent[i - 1];
        if (delta >= 0) gains += delta;
        else losses += Math.abs(delta);
    }

    const averageGain = gains / period;
    const averageLoss = losses / period;
    const rs = averageLoss === 0 ? Infinity : averageGain / averageLoss;
    return 100 - (100 / (1 + rs));
}

function getRsiInterpretation(rsi) {
    if (!Number.isFinite(rsi)) {
        return {
            signal: '-',
        };
    }

    if (rsi >= 70) {
        return {
            signal: 'Überkauft',
        };
    }

    if (rsi <= 30) {
        return {
            signal: 'Überverkauft',
        };
    }

    return {
        signal: 'Neutral',
    };
}

async function loadFearAndGreedIndex() {
    try {
        const [latestResponse, historyResponse] = await Promise.all([
            fetch('https://api.alternative.me/fng/?limit=1&format=json'),
            fetch('https://api.alternative.me/fng/?limit=0&format=json')
        ]);

        if (!latestResponse.ok || !historyResponse.ok) throw new Error('Fear & Greed API Fehler');

        const payload = await latestResponse.json();
        const historyPayload = await historyResponse.json();
        const latest = payload?.data?.[0];
        const history = Array.isArray(historyPayload?.data) ? historyPayload.data : [];
        const value = Number(latest?.value);
        const classification = latest?.value_classification;
        const timestampSeconds = Number(latest?.timestamp);

        if (!Number.isFinite(value) || !classification) {
            throw new Error('Ungültige Fear & Greed Daten');
        }

        const updated = Number.isFinite(timestampSeconds)
            ? new Date(timestampSeconds * 1000).toLocaleDateString('de-DE', { year: 'numeric', month: '2-digit', day: '2-digit' })
            : '-';

        document.getElementById('fngValue').innerHTML = `<div style="font-size: 1.5rem;">${value}</div>`;
        document.getElementById('fngClassification').textContent = classification;
        document.getElementById('fngUpdated').textContent = updated;

        setIndicatorLightState('fngLight', getAmpelStateByThresholds(value, { greenMax: 25, yellowMax: 75 }));

        const historicalValues = history
            .map((entry) => Number(entry?.value))
            .filter(Number.isFinite);

        if (historicalValues.length > 0) {
            const higherCount = historicalValues.filter((historicalValue) => historicalValue > value).length;
            const higherThanPercent = (higherCount / historicalValues.length) * 100;
            const higherThanPercentFormatted = higherThanPercent.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
            document.getElementById('fngPercentile').textContent = `Niedriger als ${higherThanPercentFormatted}% der Zeit`;
        } else {
            document.getElementById('fngPercentile').textContent = '-';
        }
    } catch (error) {
        console.error('Fehler beim Laden des Fear & Greed Index:', error);
        document.getElementById('fngValue').innerHTML = '<span style="color: #ef4444;">Fehler</span>';
        document.getElementById('fngClassification').textContent = '-';
        document.getElementById('fngUpdated').textContent = '-';
        document.getElementById('fngPercentile').textContent = '-';
        setIndicatorLightState('fngLight', 'neutral');
    }
}

async function calculate200WMA(currency = 'usd') {
    try {
        const isUsd = currency === 'usd';
        const priceKey = isUsd ? 'closeUsd' : 'closeEur';
        const maKey = isUsd ? 'sma200wUsd' : 'sma200wEur';
        const fiat = isUsd ? 'USD' : 'EUR';

        const modelRows = localPriceRows
            .filter((row) => Number.isFinite(row[priceKey]) && Number.isFinite(row[maKey]) && Number.isFinite(getSma200wFactor(row, currency)))
            .sort((a, b) => a.date.localeCompare(b.date));

        if (modelRows.length === 0) throw new Error('Keine 200WMA Modelldaten verfügbar');

        const latestRow = modelRows[modelRows.length - 1];
        const current200Wma = latestRow[maKey];
        const currentFactor = getSma200wFactor(latestRow, currency);
        const currentRatioPercent = currentFactor * 100;

        const factorSeries = modelRows.map((row) => getSma200wFactor(row, currency)).filter(Number.isFinite);
        const daysWithLargerFactor = factorSeries.filter((factor) => factor > currentFactor).length;
        const cheaperThanPercent = (daysWithLargerFactor / factorSeries.length) * 100;

        document.getElementById('wma200').innerHTML = formatCurrency(current200Wma, fiat);
        document.getElementById('wma200Distance').textContent = `${currentRatioPercent.toFixed(1)}%`;
        document.getElementById('wma200UnderRatio').textContent =
            `Günstiger als ${cheaperThanPercent.toFixed(1)}% der Zeit`;

        setIndicatorLightState('wma200Light', getAmpelStateByThresholds(currentFactor, { greenMax: 1.25, yellowMax: 2 }));

    } catch (error) {
        console.error('Fehler bei 200WMA Berechnung:', error);
        document.getElementById('wma200').innerHTML = '<span style="color: #ef4444;">Fehler</span>';
        document.getElementById('wma200Distance').textContent = '-';
        document.getElementById('wma200UnderRatio').textContent = '-';
        setIndicatorLightState('wma200Light', 'neutral');
    }
}

function calculatePowerLaw(currency = 'usd') {
    try {
        const isUsd = currency === 'usd';
        const priceKey = isUsd ? 'closeUsd' : 'closeEur';
        const q01Key = isUsd ? 'powerLawQ01Usd' : 'powerLawQ01Eur';
        const q50Key = isUsd ? 'powerLawQ50Usd' : 'powerLawQ50Eur';
        const q99Key = isUsd ? 'powerLawQ99Usd' : 'powerLawQ99Eur';
        const fiat = isUsd ? 'USD' : 'EUR';

        const modelRows = localPriceRows
            .filter((row) => (
                Number.isFinite(row[priceKey])
                && Number.isFinite(row[q01Key])
                && Number.isFinite(row[q99Key])
                && Number.isFinite(getPowerLawFactor(row, currency))
                && row[q99Key] > row[q01Key]
            ))
            .sort((a, b) => a.date.localeCompare(b.date));

        if (modelRows.length === 0) throw new Error('Keine Power-Law-Modelldaten verfügbar');

        const latestRow = modelRows[modelRows.length - 1];
        const q01 = latestRow[q01Key];
        const q50 = latestRow[q50Key];
        const q99 = latestRow[q99Key];
        const currentFactor = getPowerLawFactor(latestRow, currency);
        const currentIndexPercent = Math.max(0, Math.min(100, currentFactor * 100));

        const factorSeries = modelRows
            .map((row) => getPowerLawFactor(row, currency))
            .filter(Number.isFinite);

        const daysWithLargerFactor = factorSeries.filter((value) => value > currentFactor).length;
        const cheaperThanPercent = (daysWithLargerFactor / factorSeries.length) * 100;

        document.getElementById('powerLawQ01').textContent = formatCurrency(q01, fiat);
        document.getElementById('powerLawQ50').textContent = Number.isFinite(q50) ? formatCurrency(q50, fiat) : '-';
        document.getElementById('powerLawQ99').textContent = formatCurrency(q99, fiat);

        document.getElementById('powerLaw').innerHTML =
            `<div style="font-size: 1.5rem;">${currentIndexPercent.toFixed(1)}% des PL-Bereichs</div>`;
        document.getElementById('powerLawPercentile').textContent =
            `Günstiger als ${cheaperThanPercent.toFixed(1)}% der Zeit`;

        setIndicatorLightState('powerLawLight', getAmpelStateByThresholds(currentIndexPercent, { greenMax: 20, yellowMax: 50 }));

    } catch (error) {
        console.error('Fehler bei Power-Law-Berechnung:', error);
        document.getElementById('powerLaw').innerHTML = '<span style="color: #ef4444;">Fehler</span>';
        document.getElementById('powerLawQ01').textContent = '-';
        document.getElementById('powerLawQ50').textContent = '-';
        document.getElementById('powerLawQ99').textContent = '-';
        document.getElementById('powerLawPercentile').textContent = '-';
        setIndicatorLightState('powerLawLight', 'neutral');
    }
}

function getSma200wFactor(row, currency = 'usd') {
    if (!row) return null;
    const isUsd = currency === 'usd';
    const price = isUsd ? row.closeUsd : row.closeEur;
    const ma200w = isUsd ? row.sma200wUsd : row.sma200wEur;

    if (!Number.isFinite(price) || !Number.isFinite(ma200w) || ma200w === 0) return null;
    return price / ma200w;
}

function getPowerLawFactor(row, currency = 'usd') {
    if (!row) return null;
    const isUsd = currency === 'usd';
    const price = isUsd ? row.closeUsd : row.closeEur;
    const q01 = isUsd ? row.powerLawQ01Usd : row.powerLawQ01Eur;
    const q99 = isUsd ? row.powerLawQ99Usd : row.powerLawQ99Eur;

    if (!Number.isFinite(price) || !Number.isFinite(q01) || !Number.isFinite(q99) || q99 === q01) return null;
    return (price - q01) / (q99 - q01);
}

async function loadSmartMoneyDigest() {
    try {
        const response = await fetch('data/smart_money.json', { cache: 'no-store' });
        if (!response.ok) throw new Error(`Smart-Money-Daten nicht erreichbar (${response.status})`);

        const payload = await response.json();
        renderSmartMoneyDigest(payload);
    } catch (error) {
        console.error('Fehler beim Laden von Smart Money:', error);
        renderSmartMoneyDigest(null);
    }
}

function renderSmartMoneyDigest(payload) {
    const defaults = {
        whales: {
            summary: 'Keine aktuellen Daten verfügbar.',
            links: []
        },
        hedgeFunds: {
            summary: 'Keine aktuellen Daten verfügbar.',
            links: []
        },
        etfs: {
            summary: 'Keine aktuellen Daten verfügbar.',
            links: []
        }
    };

    const data = {
        ...defaults,
        ...(payload?.segments ?? {})
    };

    const updatedLabel = payload?.updatedAt
        ? new Date(payload.updatedAt).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' })
        : 'Unbekannt';

    const updatedElement = document.getElementById('smartMoneyUpdated');
    if (updatedElement) {
        const modelText = payload?.meta?.model ? ` (LLM: ${payload.meta.model})` : '';
        updatedElement.textContent = `${updatedLabel}${modelText}`;
    }

    updateSmartMoneyRow('smartMoneyWhales', 'smartMoneyWhalesLinks', data.whales);
    updateSmartMoneyRow('smartMoneyHedgeFunds', 'smartMoneyHedgeFundsLinks', data.hedgeFunds);
    updateSmartMoneyRow('smartMoneyEtfs', 'smartMoneyEtfsLinks', data.etfs);
}

function updateSmartMoneyRow(textId, linksId, rowData = {}) {
    const textEl = document.getElementById(textId);
    const linksEl = document.getElementById(linksId);

    if (textEl) {
        textEl.textContent = rowData.summary || 'Keine aktuellen Daten verfügbar.';
    }

    if (!linksEl) return;

    const links = Array.isArray(rowData.links) ? rowData.links.slice(0, 2) : [];
    if (links.length === 0) {
        linksEl.innerHTML = '<span class="detail-label">Keine Quellen verlinkt.</span>';
        return;
    }

    linksEl.innerHTML = links.map((link) => {
        const title = escapeHtml(link?.title || 'Quelle');
        const href = typeof link?.url === 'string' ? link.url : '#';
        return `<a href="${href}" target="_blank" rel="noopener noreferrer">${title}</a>`;
    }).join('');
}

function escapeHtml(value = '') {
    const htmlEscapes = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    };

    return String(value).replace(/[&<>"']/g, (char) => htmlEscapes[char] || char);
}


async function loadTreasuryCompanies() {
    try {
        const [quoteResult, treasuryResult] = await Promise.allSettled([
            fetch(getYahooQuoteUrl(CONFIG.treasuryCompanies.map((company) => company.quoteSymbol))),
            fetch(`${CONFIG.coingecko.baseUrl}/companies/public_treasury/bitcoin`)
        ]);

        const quoteResponse = quoteResult.status === 'fulfilled' ? quoteResult.value : null;
        const treasuryResponse = treasuryResult.status === 'fulfilled' ? treasuryResult.value : null;

        if (quoteResult.status === 'rejected') {
            console.warn('Yahoo Quote API nicht erreichbar:', quoteResult.reason);
        }

        if (treasuryResult.status === 'rejected') {
            console.warn('CoinGecko Treasury API nicht erreichbar:', treasuryResult.reason);
        }

        const quotePayload = (quoteResponse && quoteResponse.ok) ? await quoteResponse.json() : null;
        const treasuryPayload = (treasuryResponse && treasuryResponse.ok) ? await treasuryResponse.json() : null;

        const quoteMap = mapQuotesBySymbol(quotePayload?.quoteResponse?.result || []);
        const holdingsMap = mapHoldingsByName(treasuryPayload?.companies || []);

        CONFIG.treasuryCompanies.forEach((company) => {
            const quote = quoteMap.get(company.quoteSymbol.toUpperCase()) || null;
            const holdings = resolveHoldings(holdingsMap, company);
            renderTreasuryCompany(company, quote, holdings);
        });

        const updatedElement = document.getElementById('treasuryUpdated');
        if (updatedElement) {
            updatedElement.textContent = new Date().toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
        }
    } catch (error) {
        console.error('Fehler beim Laden der Treasury-Unternehmen:', error);
        renderTreasuryFallback();
    }
}

function getYahooQuoteUrl(symbols = []) {
    const encodedSymbols = symbols.join(',');
    return `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(encodedSymbols)}`;
}

function mapQuotesBySymbol(quotes = []) {
    const map = new Map();
    quotes.forEach((quote) => {
        const symbol = quote?.symbol;
        if (typeof symbol !== 'string') return;
        map.set(symbol.toUpperCase(), quote);
    });
    return map;
}

function mapHoldingsByName(companies = []) {
    const map = new Map();
    companies.forEach((company) => {
        const normalizedName = normalizeCompanyName(company?.name || company?.symbol || '');
        if (!normalizedName) return;
        map.set(normalizedName, company);
    });
    return map;
}

function resolveHoldings(holdingsMap, companyConfig) {
    const aliases = [companyConfig.displayName, ...(companyConfig.aliases || [])];
    for (const alias of aliases) {
        const normalized = normalizeCompanyName(alias);
        if (!normalized) continue;
        const entry = holdingsMap.get(normalized);
        if (entry && Number.isFinite(entry.total_holdings)) {
            return entry.total_holdings;
        }
    }

    return Number.isFinite(companyConfig.fallbackBtcHoldings) ? companyConfig.fallbackBtcHoldings : null;
}

function normalizeCompanyName(value = '') {
    return String(value)
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
}

function renderTreasuryCompany(company, quote, btcHoldings) {
    const suffix = toDomSuffix(company.key);
    const priceEl = document.getElementById(`treasuryPrice${suffix}`);
    const btcEl = document.getElementById(`treasuryBtc${suffix}`);
    const nmavEl = document.getElementById(`treasuryNmav${suffix}`);
    const amplificationEl = document.getElementById(`treasuryAmplification${suffix}`);
    const yieldEl = document.getElementById(`treasuryYield${suffix}`);
    if (!priceEl || !btcEl || !nmavEl || !amplificationEl || !yieldEl) return;

    const regularMarketPrice = Number(quote?.regularMarketPrice);
    const changePercent = Number(quote?.regularMarketChangePercent);
    const currency = quote?.currency || 'USD';

    if (Number.isFinite(regularMarketPrice)) {
        const priceLabel = formatCurrency(regularMarketPrice, currency);
        const hasChange = Number.isFinite(changePercent);
        const changeLabel = hasChange
            ? `${changePercent >= 0 ? '+' : ''}${changePercent.toFixed(2)}%`
            : '-';
        const changeClass = hasChange
            ? `treasury-price-change ${changePercent >= 0 ? 'positive' : 'negative'}`
            : 'treasury-price-change';

        priceEl.innerHTML = `${priceLabel}<div class="${changeClass}">${changeLabel}</div>`;
    } else {
        priceEl.textContent = 'Nicht verfügbar';
    }

    btcEl.textContent = Number.isFinite(btcHoldings)
        ? `${formatBtcAmount(btcHoldings)} BTC`
        : 'Nicht verfügbar';

    const sharesOutstanding = Number.isFinite(Number(quote?.sharesOutstanding))
        ? Number(quote.sharesOutstanding)
        : company.fallbackSharesOutstanding;
    const marketCapFromShares = Number.isFinite(regularMarketPrice) && Number.isFinite(sharesOutstanding) && sharesOutstanding > 0
        ? regularMarketPrice * sharesOutstanding
        : null;
    const marketCap = Number.isFinite(Number(quote?.marketCap))
        ? Number(quote.marketCap)
        : marketCapFromShares;
    const bitcoinNavUsd = Number.isFinite(btcHoldings) && Number.isFinite(latestBitcoinPriceUsd)
        ? btcHoldings * latestBitcoinPriceUsd
        : null;

    const computedMnav = Number.isFinite(marketCap) && Number.isFinite(bitcoinNavUsd) && bitcoinNavUsd > 0
        ? marketCap / bitcoinNavUsd
        : null;
    const mnav = Number.isFinite(computedMnav) ? computedMnav : Number(company.fallbackNmav);

    nmavEl.textContent = Number.isFinite(mnav) ? `${mnav.toFixed(2)}x` : 'Nicht verfügbar';

    const btcPerShare = Number.isFinite(btcHoldings) && Number.isFinite(sharesOutstanding) && sharesOutstanding > 0
        ? btcHoldings / sharesOutstanding
        : null;
    const satsPerShareNow = Number.isFinite(Number(company.satsPerShareNow))
        ? Number(company.satsPerShareNow)
        : (Number.isFinite(btcPerShare) ? btcPerShare * 100_000_000 : null);
    const satsPerShare1yAgo = Number(company.satsPerShare1yAgo);
    const btcYield = Number.isFinite(satsPerShareNow) && Number.isFinite(satsPerShare1yAgo) && satsPerShare1yAgo > 0
        ? ((satsPerShareNow / satsPerShare1yAgo) - 1) * 100
        : null;

    if (Number.isFinite(btcYield)) {
        const yieldClass = btcYield >= 0 ? 'positive' : 'negative';
        yieldEl.innerHTML = `<span class="treasury-price-change ${yieldClass}">${btcYield >= 0 ? '+' : ''}${btcYield.toFixed(1)}%</span>`;
    } else {
        yieldEl.textContent = 'Nicht verfügbar';
    }

    const computedAmplification = Number.isFinite(mnav) && Number.isFinite(btcYield)
        ? mnav * (1 + (btcYield / 100))
        : null;
    const amplification = Number.isFinite(computedAmplification) ? computedAmplification : Number(company.fallbackAmplification);
    amplificationEl.textContent = Number.isFinite(amplification) ? `${amplification.toFixed(2)}x` : 'Nicht verfügbar';
}

function renderTreasuryFallback() {
    CONFIG.treasuryCompanies.forEach((company) => {
        renderTreasuryCompany(company, null, company.fallbackBtcHoldings);
    });

    const updatedElement = document.getElementById('treasuryUpdated');
    if (updatedElement) {
        updatedElement.textContent = 'Datenfeed nicht erreichbar';
    }
}

function toDomSuffix(key = '') {
    if (key === 'capitalb') return 'CapitalB';
    return key.charAt(0).toUpperCase() + key.slice(1);
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

function formatBtcAmount(value) {
    return value.toLocaleString('de-DE', {
        minimumFractionDigits: 0,
        maximumFractionDigits: 4
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

function renderAssetClassTreemap(runtimeData = {}) {
    const container = document.getElementById('assetTreemap');
    const subtitle = document.getElementById('assetClassesScenarioSubtitle');
    if (!container) return;

    const assets = ASSET_CLASSES_BASE.map((asset) => ({ ...asset }));
    if (Number.isFinite(runtimeData.bitcoinMarketCapUsd) && runtimeData.bitcoinMarketCapUsd > 0) {
        const bitcoinAsset = assets.find((asset) => asset.key === 'bitcoin');
        if (bitcoinAsset) bitcoinAsset.marketCapUsd = runtimeData.bitcoinMarketCapUsd;
    }

    const total = assets.reduce((sum, asset) => sum + asset.marketCapUsd, 0);
    if (!Number.isFinite(total) || total <= 0) {
        container.innerHTML = '<div class="loading">Assetdaten werden geladen...</div>';
        return;
    }

    const sorted = [...assets].sort((a, b) => a.marketCapUsd - b.marketCapUsd);
    const layout = rebalanceSmallestTiles(
        computeTreemapLayout(sorted, { x: 0, y: 0, width: 100, height: 100 }, total)
    );

    const eurPerUsd = Number.isFinite(runtimeData.bitcoinPriceUsd) && runtimeData.bitcoinPriceUsd > 0 && Number.isFinite(runtimeData.bitcoinPriceEur)
        ? runtimeData.bitcoinPriceEur / runtimeData.bitcoinPriceUsd
        : null;
    const totalEur = Number.isFinite(eurPerUsd) ? total * eurPerUsd : null;
    const effectiveSupply = Number.isFinite(runtimeData.circulatingSupply)
        ? runtimeData.circulatingSupply - CONFIG.estimatedLostCoins
        : null;

    if (subtitle) {
        const bearPrice = calculateScenarioBtcPrice(totalEur, 0.10, effectiveSupply);
        const realisticPrice = calculateScenarioBtcPrice(totalEur, 0.21, effectiveSupply);
        const bullPrice = calculateScenarioBtcPrice(totalEur, 0.50, effectiveSupply);
        subtitle.textContent =
            `Total = ${formatEuroTrillion(totalEur)}, bear 10% BTC → ${formatScenarioPrice(bearPrice)}, realistisch 21% BTC → ${formatScenarioPrice(realisticPrice)}, bull 50% BTC → ${formatScenarioPrice(bullPrice)}`;
    }

    const tinyTileThreshold = 7;

    const tilesHtml = layout
        .map(({ asset, rect }) => {
            const valueLabel = formatUsdMarketCap(asset.marketCapUsd);
            const isTinyTile = rect.width < tinyTileThreshold || rect.height < tinyTileThreshold;
            return `
                <div
                    class="asset-tile${isTinyTile ? ' asset-tile--tiny' : ''}"
                    style="left:${rect.x}%;top:${rect.y}%;width:${rect.width}%;height:${rect.height}%;background:${asset.color};"
                    title="${asset.name}: ${valueLabel}"
                >
                    <div class="asset-tile-name">${asset.name}</div>
                    <div class="asset-tile-value">${valueLabel}</div>
                </div>
            `;
        })
        .join('');

    container.innerHTML = tilesHtml;
}

function rebalanceSmallestTiles(layout) {
    if (!Array.isArray(layout) || layout.length < 2) return layout;

    const byArea = layout
        .map((entry, index) => ({ index, entry, area: entry.rect.width * entry.rect.height }))
        .sort((a, b) => a.area - b.area);

    const first = byArea[0];
    const second = byArea[1];
    if (!first || !second) return layout;

    const almostSameX = Math.abs(first.entry.rect.x - second.entry.rect.x) < 0.75
        && Math.abs(first.entry.rect.width - second.entry.rect.width) < 0.75;
    const almostSameY = Math.abs(first.entry.rect.y - second.entry.rect.y) < 0.75
        && Math.abs(first.entry.rect.height - second.entry.rect.height) < 0.75;

    if (almostSameY || !almostSameX) return layout;

    const x = Math.min(first.entry.rect.x, second.entry.rect.x);
    const y = Math.min(first.entry.rect.y, second.entry.rect.y);
    const width = Math.max(first.entry.rect.x + first.entry.rect.width, second.entry.rect.x + second.entry.rect.width) - x;
    const height = Math.max(first.entry.rect.y + first.entry.rect.height, second.entry.rect.y + second.entry.rect.height) - y;

    const gap = Math.min(0.4, width * 0.03);
    const tileWidth = (width - gap) / 2;

    const reordered = [...layout];
    reordered[first.index] = {
        ...first.entry,
        rect: { x, y, width: tileWidth, height }
    };
    reordered[second.index] = {
        ...second.entry,
        rect: { x: x + tileWidth + gap, y, width: tileWidth, height }
    };

    return reordered;
}

function calculateScenarioBtcPrice(totalEur, btcShare, effectiveSupply) {
    if (!Number.isFinite(totalEur) || totalEur <= 0) return null;
    if (!Number.isFinite(btcShare) || btcShare <= 0) return null;
    if (!Number.isFinite(effectiveSupply) || effectiveSupply <= 0) return null;
    return (btcShare * totalEur) / effectiveSupply;
}

function formatEuroTrillion(value) {
    if (!Number.isFinite(value) || value <= 0) return '-';
    return `${(value / 1e12).toFixed(1)} Bio.€`;
}

function formatScenarioPrice(value) {
    if (!Number.isFinite(value) || value <= 0) return '-';
    return value.toLocaleString('de-DE', {
        style: 'currency',
        currency: 'EUR',
        minimumFractionDigits: 0,
        maximumFractionDigits: 0
    });
}

function computeTreemapLayout(assets, rect, totalValue) {
    if (!Array.isArray(assets) || assets.length === 0 || totalValue <= 0) return [];

    if (assets.length === 1) {
        return [{ asset: assets[0], rect }];
    }

    let groupValue = 0;
    let splitIndex = 0;
    for (let i = 0; i < assets.length; i += 1) {
        const next = groupValue + assets[i].marketCapUsd;
        if (next <= totalValue / 2 || i === 0) {
            groupValue = next;
            splitIndex = i + 1;
        } else {
            break;
        }
    }

    const firstGroup = assets.slice(0, splitIndex);
    const secondGroup = assets.slice(splitIndex);
    const firstRatio = groupValue / totalValue;

    if (rect.width >= rect.height) {
        const firstWidth = rect.width * firstRatio;
        return [
            ...computeTreemapLayout(firstGroup, { ...rect, width: firstWidth }, groupValue),
            ...computeTreemapLayout(
                secondGroup,
                { x: rect.x + firstWidth, y: rect.y, width: rect.width - firstWidth, height: rect.height },
                totalValue - groupValue
            )
        ];
    }

    const firstHeight = rect.height * firstRatio;
    return [
        ...computeTreemapLayout(firstGroup, { ...rect, height: firstHeight }, groupValue),
        ...computeTreemapLayout(
            secondGroup,
            { x: rect.x, y: rect.y + firstHeight, width: rect.width, height: rect.height - firstHeight },
            totalValue - groupValue
        )
    ];
}

function formatUsdMarketCap(value) {
    if (!Number.isFinite(value)) return '-';
    if (value >= 1e12) return `$${(value / 1e12).toFixed(1)} Bio.`;
    if (value >= 1e9) return `$${(value / 1e9).toFixed(1)} Mrd.`;
    return `$${value.toLocaleString('de-DE')}`;
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
