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

### Option A: Direkt im Dashboard (Excel-kompatible CSV)
1. Dashboard lokal starten (z. B. mit einem Static Server).
2. Im Abschnitt **„Lokale Preisdatenbank (Daily Close)”** auf **„CSV erzeugen & herunterladen”** klicken.
3. Die Datei `btc_daily_prices.csv` in `data/` legen und ins Repo einchecken.

CSV-Spalten:
- `date` (YYYY-MM-DD)
- `close_eur`
- `close_usd`

### Option B: Per Skript erzeugen
```bash
node scripts/generate-price-db.mjs
```

Das Skript erzeugt `data/btc_daily_prices.csv` mit täglichen BTC-Schlusskursen in EUR und USD.

## Automatisch 1x pro Tag aktualisieren

Für das Anhängen des neuesten Schlusskurses gibt es zwei Wege:

1. Lokal:
```bash
node scripts/update-price-db.mjs
```

2. Automatisch via GitHub Actions:
- Workflow: `.github/workflows/update-price-db.yml`
- Läuft täglich (Cron) und commitet/pusht neue Zeilen automatisch.
