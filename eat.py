"""Sekcja wiem.eat — API dziennika jedzenia.

Pierwszy moduł w tym projekcie zbudowany na `APIRouter` zamiast dokładania do
`main.py`. Nowe dziedziny mają iść tą drogą.

Produkty biorą się z trzech źródeł, w tej kolejności:
  1. własna baza gospodarstwa (natychmiast, bez internetu),
  2. Open Food Facts po kodzie kreskowym — wynik ZAPISUJEMY u siebie,
  3. zdjęcie etykiety odczytane przez Claude — też zapisujemy.

Dzięki temu Open Food Facts jest zasiewem, a nie zależnością: po kilku
tygodniach codzienne zakupy rozpoznają się lokalnie.
"""

from datetime import date

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.concurrency import run_in_threadpool

import eat_db
from auth import get_current_user

router = APIRouter(prefix="/api/eat", tags=["eat"])

# Open Food Facts prosi o nazwę aplikacji w nagłówku — to ich jedyny warunek
# przy darmowym korzystaniu i nie ma powodu go nie spełnić.
_OFF_URL = "https://world.openfoodfacts.org/api/v2/product/{kod}.json"
_OFF_POLA = "product_name,product_name_pl,brands,quantity,product_quantity,nutriments"
_OFF_UA = "WiemApp/1.0 (budzetdomowy-production.up.railway.app)"


def _hid(current_user: dict) -> int:
    hid = current_user.get("household_id")
    if not hid:
        raise HTTPException(400, "Brak gospodarstwa")
    return hid


def _liczba(v):
    try:
        f = float(str(v).replace(",", "."))
    except (TypeError, ValueError):
        return None
    return f if f == f and abs(f) != float("inf") else None


# ── Open Food Facts ─────────────────────────────────────────────────────────

def _z_open_food_facts(kod: str) -> dict | None:
    """Zwraca produkt w naszym kształcie albo None. Każdy błąd — brak sieci,
    limit, dziwny JSON — traktujemy jak „nie znaleziono": użytkownik ma wtedy
    drogę przez zdjęcie etykiety, więc nic się nie blokuje."""
    import urllib.request
    import json as _json

    try:
        req = urllib.request.Request(
            _OFF_URL.format(kod=kod) + f"?fields={_OFF_POLA}",
            headers={"User-Agent": _OFF_UA},
        )
        with urllib.request.urlopen(req, timeout=8) as odp:
            dane = _json.loads(odp.read().decode("utf-8"))
    except Exception as e:
        print(f"[eat] Open Food Facts nie odpowiedziało dla {kod}: {e!r}")
        return None

    if dane.get("status") != 1:
        return None
    p = dane.get("product") or {}
    n = p.get("nutriments") or {}
    kcal = _liczba(n.get("energy-kcal_100g"))
    if kcal is None:
        # Produkt jest w bazie, ale bez wartości odżywczych — dla nas
        # bezużyteczny, więc odsyłamy do etykiety zamiast zapisywać pustkę.
        return None

    nazwa = (p.get("product_name_pl") or p.get("product_name") or "").strip()
    opak = _liczba(p.get("product_quantity"))
    return {
        "kod": kod,
        "nazwa": nazwa or f"Produkt {kod}",
        "marka": (p.get("brands") or "").split(",")[0].strip() or None,
        "opak_g": opak,
        "kcal": kcal,
        "bialko": _liczba(n.get("proteins_100g")),
        "tluszcz": _liczba(n.get("fat_100g")),
        "wegle": _liczba(n.get("carbohydrates_100g")),
        "blonnik": _liczba(n.get("fiber_100g")),
        "cukry": _liczba(n.get("sugars_100g")),
        "sol": _liczba(n.get("salt_100g")),
        "zrodlo": "off",
    }


# ── produkty ────────────────────────────────────────────────────────────────

@router.get("/produkt")
def produkt_po_kodzie(kod: str = Query(...), current_user: dict = Depends(get_current_user)):
    """Skan kodu kreskowego. Najpierw własna baza, potem Open Food Facts."""
    hid = _hid(current_user)
    kod = kod.strip()
    if not kod.isdigit() or not 6 <= len(kod) <= 14:
        raise HTTPException(400, "To nie wygląda na kod kreskowy")

    wlasny = eat_db.produkt_po_kodzie(hid, kod)
    if wlasny:
        return {"produkt": wlasny, "skad": "wlasna"}

    z_off = _z_open_food_facts(kod)
    if not z_off:
        raise HTTPException(404, "Nie znam tego kodu. Zrób zdjęcie etykiety, "
                                 "a zapamiętam produkt na przyszłość.")
    zapisany = eat_db.zapisz_produkt(hid, z_off)
    return {"produkt": zapisany, "skad": "off"}


@router.get("/szukaj")
def szukaj(fraza: str = Query(""), current_user: dict = Depends(get_current_user)):
    fraza = fraza.strip()
    if len(fraza) < 2:
        return []
    return eat_db.szukaj_produktow(_hid(current_user), fraza)


@router.post("/etykieta")
async def czytaj_etykiete(file: UploadFile = File(...),
                          current_user: dict = Depends(get_current_user),
                          kod: str = Query(default="")):
    """Zdjęcie tabeli wartości odżywczych → produkt w bazie gospodarstwa."""
    if current_user.get("ai_zablokowane"):
        raise HTTPException(403, "Funkcje AI są wyłączone dla tego konta.")
    hid = _hid(current_user)
    import ai_processor
    import database
    zawartosc = await file.read()
    try:
        dane, uzycie = await run_in_threadpool(
            ai_processor.czytaj_etykiete, zawartosc, file.content_type or "image/jpeg")
    except Exception as e:
        print(f"[eat] odczyt etykiety nie powiódł się: {e!r}")
        raise HTTPException(502, "Nie udało się odczytać etykiety. Spróbuj ostrzejszego zdjęcia.")
    # Koszty AI lecą do tego samego dziennika co finansowe, z własną etykietą —
    # dzięki temu panel admina rozbija je per moduł bez żadnych zmian.
    database.log_api_usage(hid, "eat-etykieta", uzycie["input_tokens"], uzycie["output_tokens"])
    if dane.get("kcal") is None:
        raise HTTPException(422, "Na tym zdjęciu nie widzę tabeli wartości odżywczych.")
    if kod.strip().isdigit():
        dane["kod"] = kod.strip()
    dane["zrodlo"] = "etykieta"
    return {"produkt": eat_db.zapisz_produkt(hid, dane), "skad": "etykieta"}


@router.post("/opis")
async def z_opisu(body: dict, current_user: dict = Depends(get_current_user)):
    """„Dwa jajka i kromka chleba" → lista pozycji do zatwierdzenia.

    Nie zapisujemy niczego od razu — użytkownik ma zobaczyć, co Claude
    oszacował, zanim to wyląduje w dzienniku."""
    if current_user.get("ai_zablokowane"):
        raise HTTPException(403, "Funkcje AI są wyłączone dla tego konta.")
    hid = _hid(current_user)
    opis = (body.get("opis") or "").strip()
    if len(opis) < 3:
        raise HTTPException(400, "Napisz, co zjadłeś")
    import ai_processor
    import database
    try:
        pozycje, uzycie = await run_in_threadpool(ai_processor.szacuj_posilek, opis)
    except Exception as e:
        print(f"[eat] szacowanie posilku nie powiodlo sie: {e!r}")
        raise HTTPException(502, "Nie udało się oszacować. Spróbuj opisać prościej.")
    database.log_api_usage(hid, "eat-opis", uzycie["input_tokens"], uzycie["output_tokens"])
    if not pozycje:
        raise HTTPException(422, "Za mało informacji, żeby cokolwiek policzyć.")
    return {"pozycje": pozycje}


# ── dziennik ────────────────────────────────────────────────────────────────

@router.get("/dzien")
def dzien(data: str = Query(default=""), current_user: dict = Depends(get_current_user)):
    hid = _hid(current_user)
    dzien_str = data.strip() or date.today().isoformat()
    wynik = eat_db.get_dzien(hid, current_user["user_id"], dzien_str)
    wynik["cele"] = eat_db.get_cele(current_user["user_id"])
    return wynik


@router.get("/ostatnie")
def ostatnie(current_user: dict = Depends(get_current_user)):
    return eat_db.ostatnio_jadl(_hid(current_user), current_user["user_id"])


@router.post("/wpis", status_code=201)
def dodaj_wpis(body: dict, current_user: dict = Depends(get_current_user)):
    """Wartości odżywcze przelicza SERWER, nie przeglądarka — inaczej wpis
    zależałby od tego, co klient sobie policzył."""
    hid = _hid(current_user)
    posilek = body.get("posilek")
    if posilek not in eat_db.POSILKI:
        raise HTTPException(400, "Nieznany posiłek")
    ilosc = _liczba(body.get("ilosc_g"))
    if not ilosc or ilosc <= 0 or ilosc > 5000:
        raise HTTPException(400, "Podaj sensowną ilość w gramach")

    # Produkt bierzemy z bazy po id, żeby klient nie mógł podać własnych kalorii.
    produkt_id = body.get("produkt_id")
    produkt = None
    if produkt_id:
        from database import get_db
        with get_db() as cur:
            cur.execute("SELECT * FROM eat_produkty WHERE id=%s AND household_id=%s",
                        (produkt_id, hid))
            row = cur.fetchone()
            produkt = dict(row) if row else None
        if not produkt:
            raise HTTPException(404, "Nie znam takiego produktu")

    if produkt:
        mnoznik = ilosc / 100.0
        wpis = {
            "data": body.get("data") or date.today().isoformat(),
            "posilek": posilek,
            "produkt_id": produkt["id"],
            "nazwa": produkt["nazwa"],
            "opis_porcji": (body.get("opis_porcji") or "").strip()[:40] or None,
            "ilosc_g": round(ilosc, 1),
            "kcal": round(float(produkt["kcal"]) * mnoznik, 1),
            "bialko": round(float(produkt["bialko"] or 0) * mnoznik, 1),
            "tluszcz": round(float(produkt["tluszcz"] or 0) * mnoznik, 1),
            "wegle": round(float(produkt["wegle"] or 0) * mnoznik, 1),
        }
    else:
        # Wpis bez produktu — np. powtórka z „ostatnio jadłeś" albo pozycja
        # oszacowana z opisu. Wtedy wartości przychodzą gotowe.
        nazwa = (body.get("nazwa") or "").strip()
        if not nazwa:
            raise HTTPException(400, "Podaj nazwę")
        kcal = _liczba(body.get("kcal"))
        if kcal is None:
            raise HTTPException(400, "Brak wartości kalorycznej")
        wpis = {
            "data": body.get("data") or date.today().isoformat(),
            "posilek": posilek,
            "produkt_id": None,
            "nazwa": nazwa[:120],
            "opis_porcji": (body.get("opis_porcji") or "").strip()[:40] or None,
            "ilosc_g": round(ilosc, 1),
            "kcal": round(kcal, 1),
            "bialko": round(_liczba(body.get("bialko")) or 0, 1),
            "tluszcz": round(_liczba(body.get("tluszcz")) or 0, 1),
            "wegle": round(_liczba(body.get("wegle")) or 0, 1),
        }
    return eat_db.dodaj_wpis(hid, current_user["user_id"], wpis)


@router.delete("/wpis/{wpis_id}")
def usun_wpis(wpis_id: int, current_user: dict = Depends(get_current_user)):
    if not eat_db.usun_wpis(wpis_id, _hid(current_user), current_user["user_id"]):
        raise HTTPException(404, "Nie znaleziono wpisu")
    return {"ok": True}


# ── cele ────────────────────────────────────────────────────────────────────

@router.get("/cele")
def cele(current_user: dict = Depends(get_current_user)):
    return eat_db.get_cele(current_user["user_id"])


@router.put("/cele")
def zapisz_cele(body: dict, current_user: dict = Depends(get_current_user)):
    biezace = eat_db.get_cele(current_user["user_id"])
    granice = {"kcal": (800, 6000), "bialko": (20, 400), "tluszcz": (10, 300), "wegle": (20, 800)}
    nowe = {}
    for pole, (lo, hi) in granice.items():
        v = _liczba(body.get(pole, biezace[pole]))
        if v is None or not lo <= v <= hi:
            raise HTTPException(400, f"Wartość {pole} poza sensownym zakresem ({lo}-{hi})")
        nowe[pole] = int(v)
    eat_db.set_cele(current_user["user_id"], **nowe)
    return nowe
