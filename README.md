# coinmaster

Bitcoin Information Dashboard für den DACH-Raum.

## Lokale Preis-Datenbank (EUR/USD)

Du kannst eine **permanente Daily-Close-Datenbasis** ab dem 01.01.2010 erzeugen:

### Option A: Direkt im Dashboard (Excel-kompatible CSV)
1. Dashboard lokal starten (z. B. mit einem Static Server).
2. Im Abschnitt **„Lokale Preisdatenbank (Daily Close)”** auf **„CSV erzeugen & herunterladen”** klicken.
3. Die Datei `btc_daily_prices.csv` in Excel öffnen oder in dieses Repo einchecken.

CSV-Spalten:
- `date` (YYYY-MM-DD)
- `close_eur`
- `close_usd`

### Option B: Per Skript erzeugen
```bash
node scripts/generate-price-db.mjs
```

Das Skript erzeugt `data/btc_daily_prices.csv` mit täglichen BTC-Schlusskursen in EUR und USD.
