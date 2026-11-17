# coinmaster

Bitcoin Information Dashboard für den DACH-Raum.

## Problem "Fehler beim Laden der CSV"

Die Website unterstützt jetzt eine **statische lokale Datenbank** unter:

- `data/btc_daily_prices.csv`

Wenn CoinGecko ausfällt oder geblockt wird, nutzt das Dashboard automatisch diese lokale CSV als Fallback für:

- aktuelle EUR/USD-Anzeige (letzter verfügbarer Tag)
- Chart-Daten (aus lokalen historischen Tages-Schlusskursen)

## Lokale Preis-Datenbank (EUR/USD)

Du kannst eine **permanente Daily-Close-Datenbasis** ab dem 01.01.2010 erzeugen:

### Per Skript erzeugen
```bash
node scripts/generate-price-db.mjs
```

Das Skript erzeugt `data/btc_daily_prices.csv` mit täglichen BTC-Schlusskursen, 50d/200d/200w gleitenden Durchschnitten (EUR/USD) sowie drei EUR-Power-Law-Quantilkurven (`powerlaw_q01_eur`, `powerlaw_q50_eur`, `powerlaw_q99_eur`).

## Automatisch 1x pro Tag aktualisieren

Für das Anhängen des neuesten Schlusskurses gibt es zwei Wege:

1. Lokal:
```bash
node scripts/update-price-db.mjs
```

2. Automatisch via GitHub Actions:
- Workflow: `.github/workflows/update-price-db.yml`
- Läuft täglich (Cron) und commitet/pusht neue Zeilen automatisch.


## Smart Money (Whales / Hedge Funds / ETFs)

Die Website enthält einen zusätzlichen Abschnitt **"Smart Money"** mit 3 kompakten Zeilen:

- Whales
- Hedge Funds
- ETFs

Dazu werden jeweils 1-2 Sätze plus 1-2 Quellenlinks aus `data/smart_money.json` angezeigt.

### Tägliches Update via LLM

Manuell aktualisieren:

```bash
node scripts/update-smart-money.mjs
```

Benötigte Umgebungsvariablen:

- `OPENAI_API_KEY` (erforderlich für LLM-Aufruf)
- `OPENAI_MODEL` (optional, Default: `gpt-4o-mini`)
- `OPENAI_BASE_URL` (optional, Default: `https://api.openai.com/v1`)

Ablauf des Skripts:

1. Holt aktuelle Artikel aus Google News RSS für Whales/Hedge Funds/ETFs.
2. Fragt ein LLM nach einer neutralen 1-2-Satz-Zusammenfassung pro Kategorie.
3. Schreibt das Ergebnis in `data/smart_money.json`.

Automatisch via GitHub Actions:

- Workflow: `.github/workflows/update-smart-money.yml`
- Läuft täglich und committed Änderungen an `data/smart_money.json`.


## Vergleichsdaten: Bitcoin in Gold und MSCI World

Die unabhängige tägliche Vergleichsdatei liegt unter `data/btc_real_value.csv`. Sie wird von `scripts/update-real-value-db.mjs` erzeugt und durch denselben täglichen GitHub-Actions-Workflow gepflegt.

Die CSV enthält den BTC-Tageskurs in USD, Gold in USD je Feinunze und den MSCI World USD Price Return Index. Daraus berechnet sie:
- BTC-Kaufkraft in Feinunzen Gold
- BTC geteilt durch den MSCI-World-Indexstand (Indexpunkte pro BTC)
- Simple Moving Averages beider BTC-Verhältnisse: SMA 50 Tage, 200 Tage und 200 Wochen (1.400 tägliche Werte)

Die sechs SMA-Spalten werden täglich aus den jeweiligen Verhältnisreihen berechnet und bei jedem Lauf der CSV-Aktualisierung neu geschrieben. Ein SMA wird erst eingetragen, wenn das vollständige Fenster gültige Tageswerte enthält. MSCI-World-Handelsschlusskurse werden über Wochenenden und Marktschließungen als letzter verfügbarer Stand fortgeschrieben. `msci_world_observation_date` zeigt den zugehörigen Handelstag. Die beigefügte Tabelle wurde zur Plausibilisierung der MSCI-World-Reihe und der beiden BTC-Verhältnisse herangezogen; für die tägliche Aktualisierung nutzt der Workflow den Yahoo-Finance-Ticker `^990100-USD-STRD`. Das ist die Price-Return-Variante ohne Dividenden. Die BTC- und Goldreihen stammen weiterhin aus Coin Metrics `PriceUSD` und World Gold Council/FastMarkets.

Für kurze Chart-Zeiträume lädt das Dashboard zusätzlich Intraday-Daten: 1 Tag mit 5-Minutenwerten, 7 Tage und 1 Monat mit Stundenwerten. BTC kommt primär von CoinGecko; bei Rate-Limits wird Yahoo `BTC-EUR` bzw. `BTC-USD` verwendet. Gold kommt intraday aus dem COMEX-Gold-Futures-Ticker `GC=F`, MSCI World aus `^990100-USD-STRD`. Yahoo liefert keine Browser-CORS-Freigabe, deshalb werden diese öffentlichen Kursabfragen über `proxy.cors.dev` geleitet. Wenn ein Intraday-Endpunkt ausfällt, zeigt der Chart die täglichen CSV-Werte. Zeitreihen werden anhand ihrer UTC-Zeitstempel zusammengeführt; wenn ein Markt geschlossen ist, bleibt sein letzter Stand gültig.

Datenquellen: [Coin Metrics Community API, täglicher BTC-Schlusskurs `PriceUSD`](https://docs.coinmetrics.io/network-data/network-data-overview/market/price); [CoinGecko: historische Auflösung](https://support.coingecko.com/articles/5723073761-what-granularity-do-you-support-for-historical-data); [World Gold Council/FastMarkets, Goldpreis-Methodik](https://www.gold.org/data/gold-price/methodology); [Yahoo Finance: MSCI World USD Index](https://finance.yahoo.com/quote/%5E990100-USD-STRD/); [MSCI World Index](https://www.msci.com/indexes/index/990100). Die Coin-Metrics-Community-Daten stehen unter CC BY-NC (Namensnennung, nicht-kommerzielle Nutzung). Der Workflow bricht ab, wenn eine Quelle keine ausreichende Historie liefert, statt eine unvollständige Datei zu schreiben.
