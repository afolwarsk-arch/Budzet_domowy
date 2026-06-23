# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Budżet domowy** — home budget tracker. Users upload receipt photos or text notes; Claude Vision extracts structured expense data; statistics and charts are displayed in a web dashboard.

## Running the app

Python 3.14 is installed at `C:\Users\adam.folwarski\AppData\Local\Programs\Python\Python314\` (not in system PATH).

```powershell
# First-time setup (already done)
C:\Users\adam.folwarski\AppData\Local\Programs\Python\Python314\python.exe -m pip install -r requirements.txt

# Start dev server (run from project directory)
C:\Users\adam.folwarski\AppData\Local\Programs\Python\Python314\Scripts\uvicorn.exe main:app --reload

# Open http://localhost:8000
```

## Architecture

**Backend** (`main.py`): FastAPI with two categories of routes:
- `/api/process-image` and `/api/process-text` — call Claude API, return JSON preview (no DB write yet)
- `/api/wydatki` CRUD + `/api/stats/*` — read/write SQLite

**AI layer** (`ai_processor.py`): Sends image (base64) or text to `claude-sonnet-4-6`. Returns a dict with `sklep`, `data`, `suma`, and `pozycje[]` (each item has `nazwa`, `cena`, `ilosc`, `kategoria`). Categories are constrained to a fixed list of 10 Polish categories defined in `KATEGORIE`.

**Database** (`database.py`): Two tables — `wydatki` (receipt header) and `pozycje` (line items, FK cascade delete). All queries live here; `main.py` never writes SQL directly.

**Frontend** (`static/`): Vanilla JS — no build step, no framework.
- `index.html` — dashboard with Chart.js doughnut + bar charts, expense table, top-store bars
- `upload.html` — two-tab UI (photo upload / text note), calls `/api/process-*`, shows editable form, saves via `/api/wydatki`
- `app.js` — detects which page is active by checking for a known element ID, then runs the appropriate init block

## Data model

```
wydatki: id, data, sklep, suma, osoba (Adam|Ola), notatki, zdjecie, created_at
pozycje: id, wydatek_id→wydatki.id (CASCADE), nazwa, cena, ilosc, kategoria
```

Fixed category list (must match `KATEGORIE` in `ai_processor.py`):
`Jedzenie`, `Higiena i kosmetyki`, `Dom i gospodarstwo`, `Transport`, `Zdrowie i leki`, `Odzież i obuwie`, `Rozrywka`, `Edukacja`, `Elektronika`, `Inne`

## Key patterns

- Stats endpoints accept `?month=YYYY-MM&osoba=Adam` query params — both optional.
- `process-image` endpoint accepts multipart form (file + osoba field); `process-text` accepts JSON body.
- Edit mode on upload page is triggered by `?edit=<id>` query param — JS fetches the expense and pre-fills the form.
- `budget.db` and `uploads/` are gitignored and created on first run.
