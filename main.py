import asyncio
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

BASE_DIR = Path(__file__).parent
load_dotenv(BASE_DIR / ".env")

import ai_processor
import database

database.init_db()

app = FastAPI(title="Budżet domowy")

UPLOADS_DIR = Path(__file__).parent / "uploads"
UPLOADS_DIR.mkdir(exist_ok=True)

STATIC_DIR = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
def root():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/upload")
def upload_page():
    return FileResponse(STATIC_DIR / "upload.html")


# --- AI processing ---

@app.post("/api/process-image")
async def process_image(
    file: UploadFile = File(...),
    osoba: str = Form("Adam"),
    kontekst: str = Form(""),
):
    content = await file.read()
    mime = file.content_type or "image/jpeg"
    try:
        results = await asyncio.to_thread(ai_processor.process_image, content, mime, kontekst or None)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Błąd Claude API: {e}")
    for r in results:
        r["osoba"] = osoba
    return results


@app.post("/api/process-text")
async def process_text(payload: dict):
    text = payload.get("text", "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Brak tekstu")
    kontekst = payload.get("kontekst", "").strip() or None
    try:
        results = await asyncio.to_thread(ai_processor.process_text, text, kontekst)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Błąd Claude API: {e}")
    osoba = payload.get("osoba", "Adam")
    for r in results:
        r["osoba"] = osoba
    return results


# --- CRUD wydatki ---

class PozycjaIn(BaseModel):
    nazwa: str
    cena: float
    ilosc: float = 1
    kategoria_glowna: str = "Inne"
    kategoria: str


class WydatekIn(BaseModel):
    data: str
    sklep: str | None = None
    suma: float
    osoba: str = "Adam"
    notatki: str | None = None
    waluta: str = "PLN"
    kurs: float = 1.0
    pozycje: list[PozycjaIn]


@app.post("/api/wydatki", status_code=201)
def create_wydatek(body: WydatekIn):
    wid = database.create_wydatek(
        data=body.data,
        sklep=body.sklep,
        suma=body.suma,
        osoba=body.osoba,
        notatki=body.notatki,
        zdjecie=None,
        pozycje=[p.model_dump() for p in body.pozycje],
        waluta=body.waluta,
        kurs=body.kurs,
    )
    return {"id": wid}


@app.post("/api/wydatki-z-plikiem", status_code=201)
async def create_wydatek_z_plikiem(
    data: str = Form(...),
    sklep: str = Form(""),
    suma: float = Form(...),
    osoba: str = Form("Adam"),
    notatki: str = Form(""),
    waluta: str = Form("PLN"),
    kurs: float = Form(1.0),
    pozycje_json: str = Form(...),
    file: UploadFile | None = File(None),
):
    import json as _json

    pozycje = _json.loads(pozycje_json)
    zdjecie = None
    if file and file.filename:
        dest = UPLOADS_DIR / file.filename
        dest.write_bytes(await file.read())
        zdjecie = file.filename

    wid = database.create_wydatek(
        data=data,
        sklep=sklep or None,
        suma=suma,
        osoba=osoba,
        notatki=notatki or None,
        zdjecie=zdjecie,
        pozycje=pozycje,
        waluta=waluta,
        kurs=kurs,
    )
    return {"id": wid}


@app.get("/api/wydatki")
def list_wydatki(month: str | None = None, osoba: str | None = None,
                 kategoria: str | None = None):
    return database.get_wydatki(month=month, osoba=osoba, kategoria=kategoria)


@app.get("/api/wydatki/{wydatek_id}")
def get_wydatek(wydatek_id: int):
    row = database.get_wydatek(wydatek_id)
    if not row:
        raise HTTPException(status_code=404, detail="Nie znaleziono")
    return row


@app.put("/api/wydatki/{wydatek_id}")
def update_wydatek(wydatek_id: int, body: WydatekIn):
    ok = database.update_wydatek(
        wydatek_id=wydatek_id,
        data=body.data,
        sklep=body.sklep,
        suma=body.suma,
        osoba=body.osoba,
        notatki=body.notatki,
        pozycje=[p.model_dump() for p in body.pozycje],
    )
    if not ok:
        raise HTTPException(status_code=404, detail="Nie znaleziono")
    return {"ok": True}


@app.get("/api/admin/rekat-preview")
def rekat_preview(month: str | None = None, od: str | None = None, do: str | None = None):
    pozycje = database.get_pozycje_do_rekat(month=month, od=od, do=do)
    return {"liczba": len(pozycje), "szacowane_paczki": -(-len(pozycje) // 25)}


@app.post("/api/admin/rekategoryzuj")
async def rekategoryzuj(body: dict):
    month = body.get("month")
    od = body.get("od")
    do = body.get("do")
    pozycje = database.get_pozycje_do_rekat(month=month, od=od, do=do)
    if not pozycje:
        return {"zaktualizowane": 0}

    BATCH = 25
    wszystkie = []
    for i in range(0, len(pozycje), BATCH):
        paczka = pozycje[i:i + BATCH]
        wynik = await asyncio.to_thread(ai_processor.rekategoryzuj_batch, paczka)
        wszystkie.extend(wynik)

    zaktualizowane = database.update_pozycje_kategorie(wszystkie)
    return {"zaktualizowane": zaktualizowane, "przetworzone": len(wszystkie)}


@app.patch("/api/wydatki/{wydatek_id}/notatki")
def patch_notatki(wydatek_id: int, body: dict):
    ok = database.update_notatki(wydatek_id, body.get("notatki", ""))
    if not ok:
        raise HTTPException(status_code=404, detail="Nie znaleziono")
    return {"ok": True}


@app.delete("/api/wydatki/{wydatek_id}")
def delete_wydatek(wydatek_id: int):
    ok = database.delete_wydatek(wydatek_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Nie znaleziono")
    return {"ok": True}


# --- statystyki ---

@app.get("/api/stats/kategorie")
def stats_kategorie(month: str | None = None, osoba: str | None = None):
    return database.stats_kategorie(month=month, osoba=osoba)


@app.get("/api/stats/pozycje-subkat")
def stats_pozycje_subkat(kategoria: str, month: str | None = None, osoba: str | None = None):
    return database.stats_pozycje_subkat(kategoria=kategoria, month=month, osoba=osoba)


@app.get("/api/stats/subkategorie")
def stats_subkategorie(kategoria_glowna: str, month: str | None = None, osoba: str | None = None):
    return database.stats_subkategorie(kategoria_glowna=kategoria_glowna, month=month, osoba=osoba)


@app.get("/api/stats/miesiace")
def stats_miesiace(n: int = 6, osoba: str | None = None):
    return database.stats_miesiace(n=n, osoba=osoba)


@app.get("/api/stats/sklepy")
def stats_sklepy(month: str | None = None, osoba: str | None = None, limit: int = 10):
    return database.stats_sklepy(month=month, osoba=osoba, limit=limit)
