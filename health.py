"""API sekcji wiem.health — badania, dokumentacja, historia leczenia.

Własny router, tak jak eat. `main.py` tylko go podpina.

Podział na dwa kroki, ten sam co przy paragonach: `/odczytaj` NIE zapisuje
niczego do bazy, tylko zwraca odczytaną strukturę do sprawdzenia. Zapis idzie
osobnym żądaniem, już po tym, jak człowiek zobaczył, co model przepisał.
Przy dokumentacji medycznej to nie jest wygoda, tylko warunek: wynik zapisany
błędnie i niezauważony jest gorszy niż brak wyniku.
"""

from datetime import date

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response

import health_ai
import health_db
from auth import get_current_user

router = APIRouter(prefix="/api/health", tags=["health"])


def _hid(current_user: dict) -> int:
    hid = current_user.get("household_id")
    if not hid:
        raise HTTPException(400, "Brak gospodarstwa")
    return hid


def _data(wartosc) -> str | None:
    """Data ISO albo None. Byle tekst poleciałby wprost do kolumny DATE
    i skończył się błędem 500 zamiast czytelnym komunikatem."""
    s = str(wartosc or "").strip()
    if not s:
        return None
    try:
        return date.fromisoformat(s[:10]).isoformat()
    except ValueError:
        return None


# ── osoby ───────────────────────────────────────────────────────────────────

@router.get("/osoby")
def lista_osob(current_user: dict = Depends(get_current_user)):
    return {"osoby": health_db.osoby(_hid(current_user))}


@router.post("/osoby")
def nowa_osoba(dane: dict, current_user: dict = Depends(get_current_user)):
    imie = (dane.get("imie") or "").strip()
    if not imie:
        raise HTTPException(400, "Podaj imię")
    oid = health_db.dodaj_osobe(_hid(current_user), imie, _data(dane.get("data_urodzenia")))
    return {"id": oid}


# ── odczyt dokumentu ────────────────────────────────────────────────────────

@router.post("/odczytaj")
async def odczytaj(
    plik: UploadFile = File(...),
    podpowiedz: str = Form(""),
    current_user: dict = Depends(get_current_user),
):
    """Zdjęcie albo PDF → struktura do sprawdzenia. NIC nie zapisuje.

    PDF wraca do przeglądarki bez zmian, żeby zapis mógł go odłożyć do bazy
    bez ponownego wysyłania pliku — zdjęcia natomiast po odczycie znikają,
    bo są kopią dokumentu, a nie dokumentem.
    """
    _hid(current_user)
    dane = await plik.read()
    mime = (plik.content_type or "").lower().split(";")[0].strip()
    # Przeglądarki telefonów potrafią przysłać PDF z pustym albo ogólnym typem —
    # wtedy rozstrzyga nazwa pliku, bo bez tego dokument poszedłby jako obraz.
    if mime in ("", "application/octet-stream") and (plik.filename or "").lower().endswith(".pdf"):
        mime = "application/pdf"

    try:
        odczyt, usage = await run_in_threadpool(
            health_ai.czytaj_dokument, dane, mime, podpowiedz.strip() or None)
    except health_ai.OdczytError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(502, f"Nie udało się odczytać dokumentu: {e}")

    return {"dokument": odczyt, "usage": usage, "pdf": mime == "application/pdf",
            "plik_nazwa": plik.filename or None}


# ── dokumenty ───────────────────────────────────────────────────────────────

@router.get("/dokumenty")
def lista_dokumentow(osoba_id: int | None = None, rodzaj: str | None = None,
                     current_user: dict = Depends(get_current_user)):
    return {"dokumenty": health_db.dokumenty(_hid(current_user), osoba_id, rodzaj)}


@router.get("/dokumenty/{dokument_id}")
def jeden_dokument(dokument_id: int, current_user: dict = Depends(get_current_user)):
    d = health_db.dokument(_hid(current_user), dokument_id)
    if not d:
        raise HTTPException(404, "Nie ma takiego dokumentu")
    return d


@router.post("/dokumenty")
async def zapisz(
    osoba_id: int = Form(...),
    dane: str = Form(...),
    plik: UploadFile | None = File(None),
    current_user: dict = Depends(get_current_user),
):
    """Zapisuje sprawdzony przez człowieka dokument wraz z wynikami.

    `dane` to JSON, bo formularz idzie multipart — inaczej nie dałoby się
    dołożyć pliku PDF w tym samym żądaniu.
    """
    import json

    hid = _hid(current_user)
    if not health_db.osoba_po_id(hid, osoba_id):
        raise HTTPException(400, "Nie ma takiej osoby")

    try:
        tresc = json.loads(dane)
    except json.JSONDecodeError:
        raise HTTPException(400, "Popsute dane dokumentu")

    for pole in ("data_badania", "data_do", "data_pobrania", "data_nastepnego"):
        tresc[pole] = _data(tresc.get(pole))

    bajty, nazwa = None, None
    if plik is not None:
        surowe = await plik.read()
        mime = (plik.content_type or "").lower().split(";")[0].strip()
        if mime in ("", "application/octet-stream") and (plik.filename or "").lower().endswith(".pdf"):
            mime = "application/pdf"
        # Trzymamy WYŁĄCZNIE PDF-y. Zdjęcie po odczycie jest kopią dokumentu,
        # waży kilka megabajtów i nie ma po co zajmować bazy.
        if mime == "application/pdf" and surowe:
            if len(surowe) > health_ai.MAX_PLIK:
                raise HTTPException(400, "Plik za duży")
            bajty, nazwa = surowe, (plik.filename or "wynik.pdf")

    dok_id = health_db.zapisz_dokument(
        hid, osoba_id, tresc, tresc.get("wyniki") or [],
        dodane_przez=current_user.get("pseudonim") or current_user.get("email"),
        plik=bajty, plik_nazwa=nazwa,
    )
    return {"id": dok_id}


@router.delete("/dokumenty/{dokument_id}")
def usun(dokument_id: int, current_user: dict = Depends(get_current_user)):
    if not health_db.usun_dokument(_hid(current_user), dokument_id):
        raise HTTPException(404, "Nie ma takiego dokumentu")
    return {"ok": True}


@router.get("/dokumenty/{dokument_id}/plik")
def pobierz_plik(dokument_id: int, current_user: dict = Depends(get_current_user)):
    got = health_db.plik_dokumentu(_hid(current_user), dokument_id)
    if not got:
        raise HTTPException(404, "Ten dokument nie ma załączonego pliku")
    bajty, nazwa = got
    # `inline` — telefon otworzy PDF w przeglądarce zamiast go pobierać.
    return Response(bajty, media_type="application/pdf",
                    headers={"Content-Disposition": f'inline; filename="{nazwa}"'})


# ── przebieg parametru ──────────────────────────────────────────────────────

@router.get("/przebieg")
def przebieg(osoba_id: int, nazwa: str, current_user: dict = Depends(get_current_user)):
    hid = _hid(current_user)
    return {"punkty": health_db.przebieg(hid, osoba_id, nazwa),
            "nazwa": nazwa}


@router.get("/parametry")
def parametry(osoba_id: int, current_user: dict = Depends(get_current_user)):
    return {"parametry": health_db.nazwy_parametrow(_hid(current_user), osoba_id)}
