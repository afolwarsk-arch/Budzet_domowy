"""API sekcji wiem.health — badania, dokumentacja, historia leczenia.

Własny router, tak jak eat. `main.py` tylko go podpina.

Podział na dwa kroki, ten sam co przy paragonach: `/odczytaj` NIE zapisuje
niczego do bazy, tylko zwraca odczytaną strukturę do sprawdzenia. Zapis idzie
osobnym żądaniem, już po tym, jak człowiek zobaczył, co model przepisał.
Przy dokumentacji medycznej to nie jest wygoda, tylko warunek: wynik zapisany
błędnie i niezauważony jest gorszy niż brak wyniku.
"""

from datetime import date

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.concurrency import run_in_threadpool

import database
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
    pliki: list[UploadFile] | None = File(None),
    plik: UploadFile | None = File(None),
    podpowiedz: str = Form(""),
    current_user: dict = Depends(get_current_user),
):
    """Strony dokumentu (zdjęcia albo PDF) → struktura do sprawdzenia. NIC nie zapisuje.

    Pliki giną razem z żądaniem — i zdjęcia, i PDF-y. Zostają wyłącznie
    przepisane dane, które użytkownik za chwilę zatwierdzi. Patrz `zapisz`.

    Pole `plik` w liczbie pojedynczej zostaje dla kart otwartych przed tym
    wdrożeniem: karta wisząca w tle wysłałaby starą nazwę pola i dostała 422
    zamiast odczytu.
    """
    _hid(current_user)
    wejscie = list(pliki or [])
    if plik is not None:
        wejscie.append(plik)
    if not wejscie:
        raise HTTPException(400, "Nie wybrano pliku.")

    strony = []
    for u in wejscie:
        dane = await u.read()
        mime = (u.content_type or "").lower().split(";")[0].strip()
        # Przeglądarki telefonów potrafią przysłać PDF z pustym albo ogólnym typem —
        # wtedy rozstrzyga nazwa pliku, bo bez tego dokument poszedłby jako obraz.
        if mime in ("", "application/octet-stream") and (u.filename or "").lower().endswith(".pdf"):
            mime = "application/pdf"
        strony.append((dane, mime))

    # Zapisy już używane w tym gospodarstwie idą do modelu jako podpowiedź —
    # bez nich ta sama przychodnia zapisuje się przy każdym dokumencie inaczej
    # (adres na pieczątce stoi za każdym razem w innej kolejności) i filtry
    # zarastają wariantami tego samego miejsca.
    znane = health_db.slownik_gospodarstwa(_hid(current_user))
    try:
        odczyt, usage = await run_in_threadpool(
            health_ai.czytaj_dokument, strony, podpowiedz.strip() or None, znane)
    except health_ai.OdczytError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        print(f"[health] odczyt padl: {e}")
        raise HTTPException(502, "Nie udało się odczytać dokumentu. Spróbuj ponownie.")

    # Dziennik kosztów AI. Przedrostek `health-` decyduje o tym, do którego
    # modułu zaliczy je panel admina — patrz `_MODUL_SQL` w database.py.
    # Bez tego wywołania odczyt dokumentacji był jedynym miejscem w apce,
    # które woła model i nie zostawia śladu w kosztach.
    database.log_api_usage(
        _hid(current_user), "health-odczyt",
        usage.get("input_tokens", 0), usage.get("output_tokens", 0),
        current_user.get("user_id"),
    )
    return {"dokument": odczyt, "usage": usage}


# ── dokumenty ───────────────────────────────────────────────────────────────

@router.get("/dokumenty")
def lista_dokumentow(osoba_id: int | None = None,
                     rodzaj: list[str] | None = Query(None),
                     problem_id: int | None = None,
                     specjalizacja: list[str] | None = Query(None),
                     lekarz: list[str] | None = Query(None),
                     placowka: list[str] | None = Query(None),
                     current_user: dict = Depends(get_current_user)):
    """Pominięcie `osoba_id` daje oś czasu całego gospodarstwa.

    Filtry tekstowe przyjmują parametr POWTÓRZONY (`?specjalizacja=a&specjalizacja=b`)
    i łączą wartości przez LUB — patrz `health_db.dokumenty`. Stary adres
    z jedną wartością działa bez zmian.
    """
    return {"dokumenty": health_db.dokumenty(
        _hid(current_user), osoba_id, rodzaj, problem_id,
        specjalizacja, lekarz, placowka)}


@router.get("/filtry")
def wartosci_filtrow(osoba_id: int | None = None, problem_id: int | None = None,
                     rodzaj: list[str] | None = Query(None),
                     specjalizacja: list[str] | None = Query(None),
                     lekarz: list[str] | None = Query(None),
                     placowka: list[str] | None = Query(None),
                     current_user: dict = Depends(get_current_user)):
    """Wartości do wyboru w filtrach — zbierane z historii, nie ze słownika.

    Przyjmuje BIEŻĄCE filtry, bo liczniki są liczone w ich kontekście: licznik
    każdego pola uwzględnia wszystkie pozostałe pola, a pomija własne. Dzięki
    temu nie da się bez ostrzeżenia złożyć wyboru sprzecznego — wartości, które
    przy obecnym zestawie nic nie dają, wracają z zerem i interfejs je wyszarza.

    Zawężone do wskazanej osoby, bo lista specjalistów Adama nie ma czego
    szukać w filtrach ustawionych na dziecko.
    """
    return health_db.wartosci_filtrow(_hid(current_user), osoba_id, problem_id,
                                      rodzaj, specjalizacja, lekarz, placowka)


@router.post("/scal")
def scal_wartosci(dane: dict, current_user: dict = Depends(get_current_user)):
    """Scala kilka zapisów tej samej placówki, lekarza albo specjalizacji w jeden.

    Wywołanie ZMIENIA ZAPISANE DOKUMENTY, więc pole jest ograniczone do trzech
    kolumn opisowych — nigdy do wyników, dat ani rozpoznań.
    """
    pole = (dane.get("pole") or "").strip()
    warianty = dane.get("warianty") or []
    na = (dane.get("na") or "").strip()
    if not isinstance(warianty, list) or not warianty or not na:
        raise HTTPException(400, "Podaj warianty do scalenia i wartość docelową.")
    try:
        ile = health_db.scal_wartosci(_hid(current_user), pole, warianty, na,
                                      dane.get("gdzie_lekarz"))
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"zmienione": ile}


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
    current_user: dict = Depends(get_current_user),
):
    """Zapisuje sprawdzony przez człowieka dokument wraz z wynikami.

    ORYGINAŁÓW NIE PRZECHOWUJEMY — ani zdjęć, ani skanów, ani PDF-ów. Plik
    służy wyłącznie do odczytu w `/odczytaj` i po nim znika. Powód jest
    pojemnościowy: Postgres na Railway stoi na tym samym wolumenie, z którego
    żyje cały budżet domowy, więc kilkadziesiąt skanów po kilka megabajtów
    podgryzałoby apkę, z której korzystamy codziennie. Docelowe miejsce na
    oryginały to dysk Google użytkownika — jego miejsce, nie nasze.

    `dane` zostaje JSON-em w polu formularza, mimo że nie ma już drugiego
    pola: zmiana na zwykłe JSON-owe ciało żądania wymagałaby przepisania
    strony po stronie przeglądarki, a nic by nie dała.
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

    dok_id = health_db.zapisz_dokument(
        hid, osoba_id, tresc, tresc.get("wyniki") or [],
        dodane_przez=current_user.get("pseudonim") or current_user.get("email"),
    )
    return {"id": dok_id}


@router.patch("/dokumenty/{dokument_id}")
def popraw_dokument(dokument_id: int, dane: dict,
                    current_user: dict = Depends(get_current_user)):
    """Poprawia opis zapisanego badania — nazwę, datę, placówkę, a przy wizycie
    specjalizację, lekarza i formę.

    WYNIKÓW NIE RUSZAMY. Są przepisane z papieru i mają zostać takie, jakie
    wydało laboratorium; nagłówek to co innego — specjalizacji czy nazwiska
    lekarza często nie ma na dokumencie i dopisuje się je z pamięci.
    """
    hid = _hid(current_user)
    if not health_db.dokument(hid, dokument_id):
        raise HTTPException(404, "Nie ma takiego dokumentu")
    if not health_db.edytuj_dokument(hid, dokument_id, dane):
        raise HTTPException(400, "Nie ma czego zmienić")
    return {"ok": True}


@router.delete("/dokumenty/{dokument_id}")
def usun(dokument_id: int, current_user: dict = Depends(get_current_user)):
    if not health_db.usun_dokument(_hid(current_user), dokument_id):
        raise HTTPException(404, "Nie ma takiego dokumentu")
    return {"ok": True}


# ── problemy zdrowotne ──────────────────────────────────────────────────────

# Paleta ma osiem slotów (patrz `PALETA` w static/health.js) — indeks spoza
# zakresu zawijamy zamiast odrzucać: kolor jest ozdobą przy nazwie, nie danymi,
# i nie ma powodu, żeby psuł zapis problemu.
_ILE_KOLOROW = 8


def _kolor(wartosc) -> int:
    try:
        return int(wartosc) % _ILE_KOLOROW
    except (TypeError, ValueError):
        return 0


@router.get("/problemy")
def lista_problemow(osoba_id: int | None = None,
                    current_user: dict = Depends(get_current_user)):
    return {"problemy": health_db.problemy(_hid(current_user), osoba_id)}


@router.post("/problemy")
def nowy_problem(dane: dict, current_user: dict = Depends(get_current_user)):
    hid = _hid(current_user)
    nazwa = (dane.get("nazwa") or "").strip()
    osoba_id = dane.get("osoba_id")
    if not nazwa:
        raise HTTPException(400, "Podaj nazwę problemu")
    if not osoba_id or not health_db.osoba_po_id(hid, int(osoba_id)):
        raise HTTPException(400, "Nie ma takiej osoby")
    pid = health_db.dodaj_problem(hid, int(osoba_id), nazwa,
                                  _kolor(dane.get("kolor")), dane.get("opis"))
    return {"id": pid}


@router.put("/problemy/{problem_id}")
def zmien_problem(problem_id: int, dane: dict,
                  current_user: dict = Depends(get_current_user)):
    nazwa = (dane.get("nazwa") or "").strip()
    if not nazwa:
        raise HTTPException(400, "Podaj nazwę problemu")
    ok = health_db.edytuj_problem(_hid(current_user), problem_id, nazwa,
                                  _kolor(dane.get("kolor")), dane.get("opis"),
                                  bool(dane.get("zamkniety")))
    if not ok:
        raise HTTPException(404, "Nie ma takiego problemu")
    return {"ok": True}


@router.delete("/problemy/{problem_id}")
def skasuj_problem(problem_id: int, current_user: dict = Depends(get_current_user)):
    if not health_db.usun_problem(_hid(current_user), problem_id):
        raise HTTPException(404, "Nie ma takiego problemu")
    return {"ok": True}


@router.put("/dokumenty/{dokument_id}/problemy")
def przypnij_problemy(dokument_id: int, dane: dict,
                      current_user: dict = Depends(get_current_user)):
    """Podmienia cały zestaw problemów dokumentu na przysłany."""
    ids = dane.get("problem_ids")
    if not isinstance(ids, list):
        raise HTTPException(400, "Oczekuję listy problem_ids")
    ok = health_db.ustaw_problemy_dokumentu(
        _hid(current_user), dokument_id, [int(x) for x in ids])
    if not ok:
        raise HTTPException(404, "Nie ma takiego dokumentu")
    return {"ok": True}


# ── przebieg parametru ──────────────────────────────────────────────────────

@router.get("/przebieg")
def przebieg(osoba_id: int, nazwa: str, current_user: dict = Depends(get_current_user)):
    hid = _hid(current_user)
    return {"punkty": health_db.przebieg(hid, osoba_id, nazwa),
            "nazwa": nazwa}


@router.get("/parametry")
def parametry(osoba_id: int, current_user: dict = Depends(get_current_user)):
    return {"parametry": health_db.nazwy_parametrow(_hid(current_user), osoba_id)}
