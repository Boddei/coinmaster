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
