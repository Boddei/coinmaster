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
let chartRequestId = 0;
let localPriceRows = [];
const maVisibility = {
    sma50d: true,
    sma200d: true,
    sma200w: true
};

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

        updateChart(enrichMarketPricesWithMovingAverages(data.prices, localPriceRows));
        
    } catch (error) {
        if (requestId !== chartRequestId) return;
        console.error('Fehler beim Laden der Chart-Daten:', error);
        const localPrices = localPriceRows.length > 0 ? localPriceRows : await fetchLocalCsvPrices();
        const fallbackSeries = buildFallbackChartSeries(localPrices, days);

        if (fallbackSeries.length > 0) {
            updateChart(fallbackSeries);
        } else {
            showError('Chart konnte nicht geladen werden');
        }
    }
}

function buildFallbackChartSeries(rows, days) {
    if (!Array.isArray(rows) || rows.length === 0) return [];

    const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
    const usableRows = days === 'max' ? sorted : sorted.slice(-days);
    return usableRows.map(row => ({
        timestamp: Date.parse(`${row.date}T00:00:00Z`),
        price: row.closeEur,
        sma50d: row.sma50dUsd,
        sma200d: row.sma200dUsd,
        sma200w: row.sma200wUsd
    }));
}

function enrichMarketPricesWithMovingAverages(priceData, rows) {
    const rowByDate = new Map(rows.map((row) => [row.date, row]));

    return priceData.map((point) => {
        const timestamp = point[0];
        const row = rowByDate.get(new Date(timestamp).toISOString().slice(0, 10));

        return {
            timestamp,
            price: point[1],
            sma50d: row?.sma50dUsd ?? null,
            sma200d: row?.sma200dUsd ?? null,
            sma200w: row?.sma200wUsd ?? null
        };
    });
}

function buildChartUrl(days) {
    const baseUrl = `${CONFIG.coingecko.baseUrl}/coins/${CONFIG.coingecko.coin}`;

    if (days === 'max') {
        return `${baseUrl}/market_chart?vs_currency=eur&days=max`;
    }

    // Für längere Zeiträume ist /market_chart/range robuster als days-Parameter.
    if (days > 365) {
        const now = Math.floor(Date.now() / 1000);
        const from = now - (days * 24 * 60 * 60);
        return `${baseUrl}/market_chart/range?vs_currency=eur&from=${from}&to=${now}`;
    }

    return `${baseUrl}/market_chart?vs_currency=eur&days=${days}`;
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
                    label: 'Bitcoin Preis (EUR)',
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
                    label: 'MA 50D (USD)',
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
                    label: 'MA 200D (USD)',
                    data: sma200d,
                    borderColor: '#f59e0b',
                    backgroundColor: 'transparent',
                    borderWidth: 2,
                    fill: false,
                    tension: 0.3,
                    pointRadius: 0,
                    spanGaps: true,
                    hidden: !maVisibility.sma200d
                },
                {
                    label: 'MA 200W (USD)',
                    data: sma200w,
                    borderColor: '#10b981',
                    backgroundColor: 'transparent',
                    borderWidth: 2,
                    fill: false,
                    tension: 0.3,
                    pointRadius: 0,
                    spanGaps: true,
                    hidden: !maVisibility.sma200w
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
                            const currency = context.dataset.label.includes('(USD)') ? 'USD' : 'EUR';
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
                            return formatCurrency(value, 'EUR', true);
                        }
                    }
                }
            }
        }
    });
}

function setupChartControls() {
    const timeframeButtons = document.querySelectorAll('.chart-btn[data-days]');
    const scaleButtons = document.querySelectorAll('.chart-btn[data-scale]');
    const maButtons = document.querySelectorAll('.ma-btn[data-ma]');

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
                sma200w: 3
            };

            const datasetIndex = datasetIndexMap[maKey];
            btcChart.data.datasets[datasetIndex].hidden = !maVisibility[maKey];
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
            const [date, closeEur, closeUsd, sma50dUsd, sma200dUsd, sma200wUsd] = lines[i].split(',');
            if (!date || !closeEur || !closeUsd) continue;

            rows.push({
                date,
                closeEur: Number(closeEur),
                closeUsd: Number(closeUsd),
                sma50dUsd: toNullableNumber(sma50dUsd),
                sma200dUsd: toNullableNumber(sma200dUsd),
                sma200wUsd: toNullableNumber(sma200wUsd)
            });
        }

        return rows.filter(row => Number.isFinite(row.closeEur) && Number.isFinite(row.closeUsd));
    } catch (error) {
        console.warn('Lokale CSV konnte nicht geladen werden:', error);
        return [];
    }
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
        // Get 200 weeks of data (approximately 1400 days)
        const response = await fetch(
            `${CONFIG.coingecko.baseUrl}/coins/${CONFIG.coingecko.coin}/market_chart?` +
            `vs_currency=eur&days=1400`
        );
        
        if (!response.ok) throw new Error('200WMA API Fehler');
        
        const data = await response.json();
        const prices = data.prices;
        
        // Calculate 200-week moving average
        // 200 weeks = 1400 days, we'll use weekly data points
        const weeklyPrices = [];
        for (let i = 0; i < prices.length; i += 7) {
            weeklyPrices.push(prices[i][1]);
        }
        
        if (weeklyPrices.length >= 200) {
            const last200Weeks = weeklyPrices.slice(-200);
            const wma200 = last200Weeks.reduce((sum, price) => sum + price, 0) / 200;
            
            // Get current price
            const currentPrice = prices[prices.length - 1][1];
            const distance = ((currentPrice - wma200) / wma200) * 100;
            
            // Update UI
            document.getElementById('wma200').innerHTML = formatCurrency(wma200, 'EUR');
            document.getElementById('wma200Distance').textContent = 
                `${distance >= 0 ? '+' : ''}${distance.toFixed(1)}%`;
            
            // Interpretation
            const interpretation = document.getElementById('wma200Interpretation');
            if (distance > 50) {
                interpretation.textContent = '🔥 Deutlich über historischem Support';
                interpretation.className = 'indicator-interpretation interpretation-bullish';
            } else if (distance > 0) {
                interpretation.textContent = '✅ Über 200W-MA Support';
                interpretation.className = 'indicator-interpretation interpretation-bullish';
            } else if (distance > -20) {
                interpretation.textContent = '⚠️ Nahe Support-Level';
                interpretation.className = 'indicator-interpretation interpretation-neutral';
            } else {
                interpretation.textContent = '📉 Unter historischem Support';
                interpretation.className = 'indicator-interpretation interpretation-bearish';
            }
        }
        
    } catch (error) {
        console.error('Fehler bei 200WMA Berechnung:', error);
        document.getElementById('wma200').innerHTML = '<span style="color: #ef4444;">Fehler</span>';
    }
}

function calculatePowerLaw() {
    // Power Law Model: Price = 10^(-17.01) * (days since genesis)^5.82
    // Genesis: 2009-01-03
    const genesisDate = new Date('2009-01-03');
    const today = new Date();
    const daysSinceGenesis = Math.floor((today - genesisDate) / (1000 * 60 * 60 * 24));
    
    // Calculate power law price (in USD, we'll approximate EUR)
    const powerLawPriceUSD = Math.pow(10, -17.01) * Math.pow(daysSinceGenesis, 5.82);
    const powerLawPriceEUR = powerLawPriceUSD * 0.92; // Approximate conversion
    
    // Get current price (we'll use a stored value from previous API call)
    // For now, we'll show the model price
    document.getElementById('powerLaw').innerHTML = 
        `<div style="font-size: 1rem; color: #a0a0a0;">Tage seit Genesis: ${daysSinceGenesis.toLocaleString('de-DE')}</div>`;
    document.getElementById('powerLawFair').textContent = 
        formatCurrency(powerLawPriceEUR, 'EUR');
    
    // Interpretation
    const interpretation = document.getElementById('powerLawInterpretation');
    interpretation.textContent = '📈 Langfristiges Wachstumsmodell';
    interpretation.className = 'indicator-interpretation interpretation-neutral';
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
