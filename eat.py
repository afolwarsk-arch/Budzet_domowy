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

import uuid
from datetime import date

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.concurrency import run_in_threadpool

import eat_db
from auth import get_current_user

router = APIRouter(prefix="/api/eat", tags=["eat"])

# Open Food Facts prosi o nazwę aplikacji w nagłówku — to ich jedyny warunek
# przy darmowym korzystaniu i nie ma powodu go nie spełnić.
_OFF_URL = "https://world.openfoodfacts.org/api/v2/product/{kod}.json"
# Szukanie po NAZWIE działa tylko na starszym punkcie /cgi/search.pl — v2 przyjmuje
# `search_terms`, ale je ignoruje i oddaje całą bazę kraju (sprawdzone: każde
# zapytanie zwracało te same 36 tys. produktów). Polska poddomena daje polskie nazwy.
_OFF_SZUKAJ = "https://pl.openfoodfacts.org/cgi/search.pl"
_OFF_POLA = ("product_name,product_name_pl,brands,quantity,product_quantity,"
             "serving_size,serving_quantity,nutriments")
_OFF_UA = "WiemApp/1.0 (budzetdomowy-production.up.railway.app)"


def _dzien(wartosc: str | None) -> str:
    """Data w formacie ISO albo dzisiaj. Bez tego byle tekst leciał wprost do
    kolumny DATE i kończył się błędem 500 zamiast czytelnym komunikatem."""
    s = (wartosc or "").strip()
    if not s:
        return date.today().isoformat()
    try:
        return date.fromisoformat(s).isoformat()
    except ValueError:
        raise HTTPException(400, "Nieprawidłowa data")


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


def _ladna(v: float) -> str:
    """Liczba bez zbędnej końcówki: 1,5 zostaje 1,5, ale 2,0 to po prostu 2.
    Trafia do opisu porcji widocznego w dzienniku."""
    return (f"{v:.2f}".rstrip("0").rstrip(".") or "0").replace(".", ",")


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
    return _z_produktu_off(dane.get("product") or {}, kod)


def _z_produktu_off(p: dict, kod: str) -> dict:
    """Zamienia rekord Open Food Facts na nasz kształt.

    UWAGA: produkt BEZ wartości kalorycznej przyjmujemy, a nie odrzucamy.
    Wcześniej odrzucałem takie wpisy jako bezużyteczne i przez to nie dało się
    zeskanować wody mineralnej — w bazie jest, ale z pustą tabelą wartości.
    Woda ma zero kalorii, więc odrzucanie jej było odwrotnością tego, co trzeba.
    Flaga `niepelne` mówi interfejsowi, żeby poprosił o sprawdzenie wartości."""
    n = p.get("nutriments") or {}
    kcal = _liczba(n.get("energy-kcal_100g"))
    nazwa = (p.get("product_name_pl") or p.get("product_name") or "").strip()

    # Wielkość PORCJI (łyżka majonezu ~15 g) i wielkość OPAKOWANIA to dwie różne
    # rzeczy, a w Open Food Facts wpisują je ludzie i regularnie mylą.
    # Zmierzone na majonezie Remia 8710448636939: product_quantity=15
    # i serving_quantity=15, czyli „opakowanie" wielkości jednej łyżki. Apka
    # pokazywała wtedy „całe opak. 15 g" jako fakt.
    #
    # Gdy obie liczby są RÓWNE, to znaczy, że ktoś wpisał porcję w pole
    # opakowania — wielkości opakowania po prostu nie znamy i lepiej nie
    # zmyślać. Porcja zostaje: jest prawdziwa i przydatna.
    porcja = _liczba(p.get("serving_quantity"))
    opak = _liczba(p.get("product_quantity"))
    if opak is not None and (opak < 5 or (porcja is not None and abs(opak - porcja) < 0.01)):
        opak = None

    return {
        "kod": kod,
        "nazwa": nazwa or f"Produkt {kod}",
        "marka": (p.get("brands") or "").split(",")[0].strip() or None,
        "opak_g": opak,
        "porcja_g": porcja,
        "opis_porcji": "porcja" if porcja else None,
        "kcal": kcal if kcal is not None else 0,
        "bialko": _liczba(n.get("proteins_100g")),
        "tluszcz": _liczba(n.get("fat_100g")),
        "wegle": _liczba(n.get("carbohydrates_100g")),
        "blonnik": _liczba(n.get("fiber_100g")),
        "cukry": _liczba(n.get("sugars_100g")),
        "sol": _liczba(n.get("salt_100g")),
        "zrodlo": "off",
        "niepelne": kcal is None,
    }


def _szukaj_w_off_ze_statusem(fraza: str, ile: int = 12,
                              proby: int = 2) -> tuple[list[dict], bool]:
    """Wyszukiwanie po nazwie. Zwraca (wyniki, czy_padlo).

    Serwer Open Food Facts odbija większość anonimowych zapytań błędem 503
    (zmierzone: dwa udane na osiem). Dlatego:
      - najpierw sprawdzamy własną pamięć podręczną,
      - przy 503 PONAWIAMY z odczekaniem, zamiast od razu się poddawać,
      - udany wynik zapisujemy, żeby druga próba tej samej frazy nie wracała
        już na ich serwer.
    `czy_padlo` mówi interfejsowi, że to była awaria, a nie brak wyników —
    wcześniej jedno i drugie wyglądało identycznie."""
    import time
    import urllib.parse
    import urllib.request
    import json as _json

    zapamietane = eat_db.cache_off_pobierz(fraza)
    if zapamietane is not None:
        return zapamietane, False

    parametry = urllib.parse.urlencode({
        "search_terms": fraza, "search_simple": 1, "action": "process",
        "json": 1, "page_size": ile,
        "fields": ("code,product_name,product_name_pl,brands,product_quantity,"
                   "serving_size,serving_quantity,nutriments"),
    })
    dane = None
    # Liczba prób zależy od tego, KTO czeka. Przy pisaniu w wyszukiwarce dwie —
    # człowiek pisze dalej i uparte ponawianie tylko opóźnia. Po zrobieniu
    # zdjęcia opakowania warto próbować dłużej: użytkownik świadomie coś zrobił,
    # stoi przed ekranem oczekiwania, a odmowa 503 przychodzi natychmiast, więc
    # kolejna próba kosztuje głównie odczekanie, nie czas oczekiwania na serwer.
    for proba in range(max(1, proby)):
        try:
            req = urllib.request.Request(f"{_OFF_SZUKAJ}?{parametry}",
                                         headers={"User-Agent": _OFF_UA})
            with urllib.request.urlopen(req, timeout=6) as odp:
                dane = _json.loads(odp.read().decode("utf-8"))
            break
        except Exception as e:
            kod = getattr(e, "code", None)
            # 503 znaczy „za dużo ruchu, spróbuj później" — warto odczekać.
            # Przy innych błędach ponawianie nic nie da.
            if kod != 503 or proba == proby - 1:
                print(f"[eat] wyszukiwanie w Open Food Facts padło ({kod}): {e!r}")
                return [], True
            # Odczekanie rośnie: 0,6 s, 1,2 s, 2,4 s. Ich serwer odmawia przy
            # natłoku, więc dokładanie się co pół sekundy niczego nie zmienia.
            time.sleep(0.6 * (2 ** proba))

    wynik = []
    for p in (dane.get("products") if dane else None) or []:
        kod = str(p.get("code") or "").strip()
        if kod:
            wynik.append(_z_produktu_off(p, kod))
    try:
        eat_db.cache_off_zapisz(fraza, wynik)
    except Exception as e:
        print(f"[eat] nie udało się zapamiętać wyniku wyszukiwania: {e!r}")
    return wynik, False


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
    # `niepelne` nie jest kolumną w bazie — przekazujemy je dalej, żeby ekran
    # potwierdzenia poprosił o sprawdzenie wartości, których baza nie miała.
    return {"produkt": zapisany, "skad": "off", "niepelne": z_off.get("niepelne", False)}


@router.get("/produkty")
def lista_produktow(current_user: dict = Depends(get_current_user)):
    """Baza produktów gospodarstwa — do przeglądu i sprzątania po błędnie
    odczytanej etykiecie."""
    return eat_db.lista_produktow(_hid(current_user))


@router.delete("/produkty/{produkt_id}")
def usun_produkt(produkt_id: int, current_user: dict = Depends(get_current_user)):
    if not eat_db.usun_produkt(produkt_id, _hid(current_user)):
        raise HTTPException(404, "Nie znaleziono produktu")
    return {"ok": True}


@router.get("/produkty/{produkt_id}")
def produkt_po_id(produkt_id: int, current_user: dict = Depends(get_current_user)):
    produkt = eat_db.produkt_po_id(produkt_id, _hid(current_user))
    if not produkt:
        raise HTTPException(404, "Nie znaleziono produktu")
    return produkt


@router.get("/ulubione")
def ulubione(current_user: dict = Depends(get_current_user)):
    """Przypięte produkty — pokazywane w arkuszu nad „ostatnio jadłeś"."""
    return eat_db.ulubione(_hid(current_user))


@router.patch("/produkty/{produkt_id}/ulubiony")
def ustaw_ulubiony(produkt_id: int, body: dict,
                   current_user: dict = Depends(get_current_user)):
    produkt = eat_db.ustaw_ulubiony(produkt_id, _hid(current_user),
                                    bool(body.get("ulubiony")))
    if not produkt:
        raise HTTPException(404, "Nie znaleziono produktu")
    return produkt


@router.get("/szukaj")
def szukaj(fraza: str = Query(""), current_user: dict = Depends(get_current_user)):
    """WYŁĄCZNIE źródła lokalne — odpowiada w kilka milisekund.

    Open Food Facts wyprowadzone do osobnego `/szukaj/off`, bo potrafiło
    zatrzymać tę odpowiedź na kilkadziesiąt sekund: trzy próby po dwanaście
    sekund plus przerwy między nimi. Użytkownik czekał na bazę zewnętrzną,
    mając gotowe wyniki u siebie."""
    hid = _hid(current_user)
    fraza = fraza.strip()
    if len(fraza) < 3:
        return {"przepisy": [], "wlasne": [], "podstawowe": []}

    # Przepisy PIERWSZE. Wpisując „capucino" szukasz swojej kawy z mlekiem
    # owsianym, a nie kapsułki z Open Food Facts — i nie masz obowiązku
    # pamiętać, czy zapisałeś to kiedyś jako produkt, czy jako przepis.
    przepisy = eat_db.lista_przepisow(hid, fraza)[:6]
    wlasne = eat_db.szukaj_produktow(hid, fraza)
    nazwy = {w["nazwa"].lower() for w in wlasne}
    podstawowe = [p for p in eat_db.szukaj_bazowych(fraza)
                  if p["nazwa"].lower() not in nazwy]
    return {"przepisy": przepisy, "wlasne": wlasne, "podstawowe": podstawowe}


@router.get("/szukaj/off")
def szukaj_off(fraza: str = Query(""), current_user: dict = Depends(get_current_user)):
    """Produkty z opakowań. Wołane OSOBNO, więc jego powolność nie blokuje
    wyników lokalnych — interfejs dokłada tę sekcję, gdy dojdzie."""
    hid = _hid(current_user)
    fraza = fraza.strip()
    if len(fraza) < 3:
        return {"propozycje": [], "off_padlo": False}

    wlasne = eat_db.szukaj_produktow(hid, fraza)
    znane = {w["kod"] for w in wlasne if w.get("kod")}
    z_off, padlo = _szukaj_w_off_ze_statusem(fraza)
    return {"propozycje": [p for p in z_off if p["kod"] not in znane],
            "off_padlo": padlo}


@router.post("/produkty/z-bazy/{bazowy_id}", status_code=201)
def z_bazy_podstawowej(bazowy_id: int, current_user: dict = Depends(get_current_user)):
    """Kopiuje produkt podstawowy do bazy gospodarstwa, żeby wpis w dzienniku
    mógł się do niego odwołać i żeby dało się go potem poprawić u siebie."""
    hid = _hid(current_user)
    b = eat_db.bazowy_po_id(bazowy_id)
    if not b:
        raise HTTPException(404, "Nie znam takiego produktu")
    # `porcja_g` z bazy surowców to waga JEDNEJ SZTUKI (pomidor ~120 g), a nie
    # opakowania — pomidor żadnego nie ma. Wcześniej szła do `opak_g` i ekran
    # dopisywał warzywu nieistniejące opakowanie zamiast dać przycisk „1 sztuka".
    produkt = eat_db.zapisz_produkt(hid, {
        "kod": None, "nazwa": b["nazwa"], "marka": None,
        "opak_g": None, "kcal": b["kcal"], "bialko": b.get("bialko"),
        "tluszcz": b.get("tluszcz"), "wegle": b.get("wegle"), "zrodlo": "baza",
        "porcja_g": b.get("porcja_g"), "opis_porcji": b.get("opis_porcji"),
    })
    return {"produkt": produkt, "skad": "baza"}


@router.post("/etykieta")
async def czytaj_etykiete(file: UploadFile = File(...),
                          current_user: dict = Depends(get_current_user),
                          kod: str = Query(default=""),
                          nazwa: str = Form(default=""),
                          marka: str = Form(default=""),
                          opak_g: str = Form(default=""),
                          sztuk: str = Form(default="")):
    """Zdjęcie tabeli wartości odżywczych → produkt w bazie gospodarstwa.

    Pola `nazwa`, `marka`, `opak_g` i `sztuk` przychodzą z wcześniejszego zdjęcia
    PRZODU opakowania, jeśli takie było. Tabela z tyłu żadnego z nich nie
    zawiera — bez nich produkt lądował w bazie jako „Produkt bez nazwy"."""
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
    database.log_api_usage(hid, "eat-etykieta", uzycie["input_tokens"], uzycie["output_tokens"],
                           current_user["user_id"])
    if dane.get("kcal") is None:
        raise HTTPException(422, "Na tym zdjęciu nie widzę tabeli wartości odżywczych.")
    if kod.strip().isdigit():
        dane["kod"] = kod.strip()
    # Odczyt z przodu ma pierwszeństwo tylko tam, gdzie tabela milczy: nazwa i
    # liczba sztuk. Wartości odżywcze zostają z tabeli — to ona jest źródłem.
    if nazwa.strip():
        dane["nazwa"] = nazwa.strip()
    if marka.strip():
        dane["marka"] = marka.strip()
    if opak_g.strip() and not dane.get("opak_g"):
        dane["opak_g"] = _liczba(opak_g)
    if sztuk.strip():
        dane["sztuk_w_opak"] = _liczba(sztuk)
    dane["zrodlo"] = "etykieta"
    return {"produkt": eat_db.zapisz_produkt(hid, dane), "skad": "etykieta"}


@router.post("/etykieta-przod")
async def etykieta_przod(file: UploadFile = File(...),
                         current_user: dict = Depends(get_current_user)):
    """Zdjęcie PRZODU opakowania → nazwa produktu i wyniki z bazy zewnętrznej.

    Tabela wartości jest z tyłu, ale nazwy produktu tam nie ma — a bez nazwy nie
    da się go wyszukać. Ten odczyt bierze z przodu to, czego tabela nie zawiera:
    jak produkt się nazywa, ile waży opakowanie i ile sztuk jest w środku.
    Liczba sztuk jest tu kluczowa: pudełko pralinek ma kod tylko na opakowaniu
    zbiorczym, a pojedyncza czekoladka żadnego."""
    if current_user.get("ai_zablokowane"):
        raise HTTPException(403, "Funkcje AI są wyłączone dla tego konta.")
    hid = _hid(current_user)
    import ai_processor
    import database
    zawartosc = await file.read()
    try:
        dane, uzycie = await run_in_threadpool(
            ai_processor.czytaj_przod, zawartosc, file.content_type or "image/jpeg")
    except Exception as e:
        print(f"[eat] odczyt przodu opakowania nie powiodl sie: {e!r}")
        raise HTTPException(502, "Nie udało się odczytać opakowania. Spróbuj ostrzejszego zdjęcia.")
    database.log_api_usage(hid, "eat-przod", uzycie["input_tokens"], uzycie["output_tokens"],
                           current_user["user_id"])

    nazwa = (dane.get("nazwa") or "").strip()
    if not nazwa:
        raise HTTPException(422, "To nie wygląda na opakowanie jedzenia.")

    fraza = (dane.get("fraza") or "").strip() or " ".join(
        x for x in [(dane.get("marka") or "").strip(), nazwa] if x)
    odczyt = {
        "nazwa": nazwa[:120],
        "marka": (dane.get("marka") or "").strip()[:80] or None,
        "opak_g": _liczba(dane.get("opak_g")),
        "sztuk": _liczba(dane.get("sztuk")),
        "fraza": fraza[:120],
    }

    # Nazwa z przodu idzie wprost do bazy zewnętrznej — po to było to zdjęcie.
    # Gdy nic nie znajdzie, użytkownik i tak ma odczytaną nazwę i gramaturę,
    # więc może dorobić wartości ze zdjęcia tabeli z tyłu.
    #
    # Przez pulę wątków, bo to zwykłe urllib: w `async def` zatrzymałoby całą
    # pętlę zdarzeń na tyle, ile trwa odpowiedź Open Food Facts — a ta potrafi
    # milczeć kilkanaście sekund i wtedy stanęłaby cała aplikacja, nie tylko
    # ten jeden użytkownik.
    #
    # Cztery próby, a nie dwie: ich serwer odbija większość anonimowych zapytań
    # błędem 503 (zmierzone: trzy odmowy na pięć zapytań), a odmowa przychodzi
    # natychmiast. Po zrobieniu zdjęcia użytkownik i tak stoi przed ekranem
    # oczekiwania, więc kilka sekund na ponowienie jest tańsze niż powiedzenie
    # mu, że produktu nie ma, gdy w rzeczywistości tam jest.
    trafienia, padlo = await run_in_threadpool(_szukaj_w_off_ze_statusem, fraza, 12, 4)

    # Gdy pełna fraza nic nie zwróciła, próbujemy krótszej — sama nazwa bez
    # marki. „Fizz Up napój gazowany typu cola zero cukru" nie trafia w nic,
    # a „cola zero" owszem.
    zapasowa = None
    if not trafienia and not padlo:
        # Marka ZOSTAJE — bez niej „Cola Zero" wraca trzydziestoma butelkami
        # Coca-Coli, a szukamy konkretnego produktu ze sklepowej półki.
        # Skracamy tylko nazwę, bo to ona bywa rozdmuchana opisem smaku.
        czesci = [odczyt["marka"] or "", " ".join(odczyt["nazwa"].split()[:2])]
        krotsza = " ".join(x for x in czesci if x).strip()
        if krotsza and krotsza.lower() != fraza.lower():
            zapasowa = krotsza
            trafienia, padlo = await run_in_threadpool(
                _szukaj_w_off_ze_statusem, krotsza, 12, 3)

    wlasne = eat_db.szukaj_produktow(hid, nazwa)
    return {"odczyt": odczyt, "wlasne": wlasne[:6], "szukano": fraza,
            "szukano_zapasowo": zapasowa,
            "propozycje": trafienia[:8], "off_padlo": padlo}


@router.patch("/produkty/{produkt_id}/sztuk")
def ustaw_sztuk(produkt_id: int, body: dict, current_user: dict = Depends(get_current_user)):
    """Ile sztuk w opakowaniu — żeby dało się zapisać „zjadłem jedną pralinkę",
    gdy kod kreskowy jest tylko na pudełku."""
    sztuk = _liczba(body.get("sztuk"))
    if sztuk is not None and not 2 <= sztuk <= 200:
        raise HTTPException(400, "Liczba sztuk poza zakresem (2–200)")
    p = eat_db.ustaw_sztuk_w_opak(produkt_id, _hid(current_user),
                                  int(sztuk) if sztuk else None)
    if not p:
        raise HTTPException(404, "Nie znam takiego produktu")
    return p


@router.post("/opis")
def z_opisu(body: dict, current_user: dict = Depends(get_current_user)):
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
        pozycje, uzycie = ai_processor.szacuj_posilek(opis)
    except Exception as e:
        print(f"[eat] szacowanie posilku nie powiodlo sie: {e!r}")
        raise HTTPException(502, "Nie udało się oszacować. Spróbuj opisać prościej.")
    database.log_api_usage(hid, "eat-opis", uzycie["input_tokens"], uzycie["output_tokens"],
                           current_user["user_id"])
    if not pozycje:
        raise HTTPException(422, "Za mało informacji, żeby cokolwiek policzyć.")
    return {"pozycje": pozycje}


# ── dziennik ────────────────────────────────────────────────────────────────

@router.get("/dzien")
def dzien(data: str = Query(default=""), current_user: dict = Depends(get_current_user)):
    hid = _hid(current_user)
    dzien_str = _dzien(data)
    wynik = eat_db.get_dzien(hid, current_user["user_id"], dzien_str)
    cele = eat_db.get_cele(current_user["user_id"])
    # Interfejs musi odróżnić „Adam wybrał 2000" od „nikt nic nie ustawił" —
    # inaczej pierwszego dnia paski udają realny cel.
    cele["domyslne"] = not eat_db.ma_wlasny_cel(current_user["user_id"])
    wynik["cele"] = cele
    return wynik


@router.get("/ostatnie")
def ostatnie(current_user: dict = Depends(get_current_user)):
    return eat_db.ostatnio_jadl(_hid(current_user), current_user["user_id"])


def _sprawdz_wartosci(body: dict) -> dict:
    """Kalorie i makro podane wprost przez klienta.

    Bez tego dało się wpisać przez formularz wartość ujemną (obniżała sumę
    dnia) albo tak dużą, że przekraczała zakres kolumny — a wtedy zamiast
    komunikatu wracał błąd 500. Wspólne dla dodawania i edycji, żeby jedno
    wejście nie zostało kiedyś poprawione bez drugiego."""
    kcal = _liczba(body.get("kcal"))
    if kcal is None:
        raise HTTPException(400, "Brak wartości kalorycznej")
    if not 0 <= kcal <= 9000:
        raise HTTPException(400, "Kalorie poza sensownym zakresem (0–9000)")
    wynik = {"kcal": round(kcal, 1)}
    for pole, etykieta in (("bialko", "Białko"), ("tluszcz", "Tłuszcz"), ("wegle", "Węglowodany")):
        v = _liczba(body.get(pole)) or 0
        if not 0 <= v <= 900:
            raise HTTPException(400, f"{etykieta}: wartość poza zakresem (0–900 g)")
        wynik[pole] = round(v, 1)
    return wynik


def _sprawdz_ilosc(wartosc) -> float:
    ilosc = _liczba(wartosc)
    if not ilosc or ilosc <= 0 or ilosc > 5000:
        raise HTTPException(400, "Podaj sensowną ilość w gramach")
    return round(ilosc, 1)


@router.post("/wpis", status_code=201)
def dodaj_wpis(body: dict, current_user: dict = Depends(get_current_user)):
    """Wartości odżywcze przelicza SERWER, nie przeglądarka — inaczej wpis
    zależałby od tego, co klient sobie policzył."""
    hid = _hid(current_user)
    posilek = body.get("posilek")
    if posilek not in eat_db.POSILKI:
        raise HTTPException(400, "Nieznany posiłek")
    ilosc = _sprawdz_ilosc(body.get("ilosc_g"))

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
            "data": _dzien(body.get("data")),
            "posilek": posilek,
            "produkt_id": produkt["id"],
            # nazwa z ekranu ma pierwszeństwo — pole jest edytowalne, więc
            # poprawka użytkownika nie może przepadać na rzecz nazwy z bazy
            "nazwa": (body.get("nazwa") or "").strip()[:120] or produkt["nazwa"],
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
        wartosci = _sprawdz_wartosci(body)
        wpis = {
            "data": _dzien(body.get("data")),
            "posilek": posilek,
            "produkt_id": None,
            "nazwa": nazwa[:120],
            "opis_porcji": (body.get("opis_porcji") or "").strip()[:40] or None,
            "ilosc_g": round(ilosc, 1),
            **wartosci,
        }
    return eat_db.dodaj_wpis(hid, current_user["user_id"], wpis)


@router.patch("/wpis/{wpis_id}")
def zmien_wpis(wpis_id: int, body: dict, current_user: dict = Depends(get_current_user)):
    """Poprawka pozycji już wpisanej do dnia — zwykle gramatury.

    Wartości przychodzą wprost z ekranu, bo tam użytkownik je widzi i mógł
    poprawić ręcznie. Nie przeliczamy ich z `produkt_id`: pozycja ma zostać
    taka, jaką zatwierdził, nawet gdyby ktoś w międzyczasie zmienił produkt
    w bazie."""
    hid = _hid(current_user)
    biezacy = eat_db.get_wpis(wpis_id, hid, current_user["user_id"])
    if not biezacy:
        raise HTTPException(404, "Nie znaleziono wpisu")

    posilek = body.get("posilek", biezacy["posilek"])
    if posilek not in eat_db.POSILKI:
        raise HTTPException(400, "Nieznany posiłek")
    nazwa = (body.get("nazwa") or "").strip() or biezacy["nazwa"]

    # Danie z przepisu poprawia się W PORCJACH, nie w gramach. Skalujemy wszystko
    # od BIEŻĄCEGO wpisu, a nie od przepisu: przepis mógł się w międzyczasie
    # zmienić albo zniknąć, a ta pozycja ma dalej opisywać ten talerz. Razem
    # z wartościami jedzie liczba porcji i rozpiska składników — bez tego
    # dziennik pokazywałby dwie porcje nad rozpiską opisującą jedną.
    if body.get("porcje") is not None and biezacy.get("przepis_id"):
        teraz = _liczba(biezacy.get("porcje_zjedzone")) or 0
        nowe = _liczba(body.get("porcje"))
        if nowe is None or not 0.05 <= nowe <= 20:
            raise HTTPException(400, "Liczba porcji poza zakresem (0,05–20)")
        if teraz <= 0:
            raise HTTPException(400, "Ten wpis nie ma zapisanej liczby porcji")
        wsp = nowe / teraz
        dane = {
            "posilek": posilek,
            "nazwa": nazwa[:120],
            "opis_porcji": (f"{_ladna(nowe)} porcji" if nowe != 1 else "1 porcja")[:40],
            "ilosc_g": max(0.1, round(float(biezacy["ilosc_g"] or 0) * wsp, 1)),
            "kcal": round(float(biezacy["kcal"] or 0) * wsp, 1),
            "bialko": round(float(biezacy["bialko"] or 0) * wsp, 1),
            "tluszcz": round(float(biezacy["tluszcz"] or 0) * wsp, 1),
            "wegle": round(float(biezacy["wegle"] or 0) * wsp, 1),
            "porcje_zjedzone": round(nowe, 2),
        }
        rozpiska = biezacy.get("skladniki_json")
        if rozpiska:
            import json as _json
            try:
                pozycje = _json.loads(rozpiska) if isinstance(rozpiska, str) else rozpiska
                dane["skladniki_json"] = _json.dumps([{
                    "nazwa": s.get("nazwa"),
                    "ilosc_g": round(float(s.get("ilosc_g") or 0) * wsp, 1),
                    "kcal": round(float(s.get("kcal") or 0) * wsp, 1),
                } for s in pozycje], ensure_ascii=False)
            except (ValueError, TypeError, AttributeError) as e:
                # Nieczytelna rozpiska nie ma prawa zablokować poprawki ilości —
                # zostaje wtedy stara, a reszta wpisu i tak się aktualizuje.
                print(f"[eat] wpis {wpis_id}: nie przeskalowalem rozpiski — {e!r}")
        wynik = eat_db.aktualizuj_wpis(wpis_id, hid, current_user["user_id"], dane)
        if not wynik:
            raise HTTPException(404, "Nie znaleziono wpisu")
        return wynik

    dane = {
        "posilek": posilek,
        "nazwa": nazwa[:120],
        "opis_porcji": (body.get("opis_porcji") or "").strip()[:40] or None,
        "ilosc_g": _sprawdz_ilosc(body.get("ilosc_g")),
        **_sprawdz_wartosci(body),
    }
    wynik = eat_db.aktualizuj_wpis(wpis_id, hid, current_user["user_id"], dane)
    if not wynik:
        raise HTTPException(404, "Nie znaleziono wpisu")
    return wynik


@router.post("/wpisy/grupa", status_code=201)
def dodaj_grupe(body: dict, current_user: dict = Depends(get_current_user)):
    """Kilka składników zapisanych JAKO JEDNO danie.

    „Kanapka z serem" to pieczywo i ser — osobne wpisy, każdy z własną
    gramaturą do poprawienia, ale w dzienniku pokazane pod wspólną nazwą.

    Jedno wywołanie zamiast pętli po stronie przeglądarki: wcześniej każda
    pozycja szła osobnym żądaniem i przerwanie w połowie zostawiało pół
    posiłku, bez żadnego śladu, że reszta nie doszła."""
    hid = _hid(current_user)
    posilek = body.get("posilek")
    if posilek not in eat_db.POSILKI:
        raise HTTPException(400, "Nieznany posiłek")
    pozycje = body.get("pozycje") or []
    if not pozycje:
        raise HTTPException(400, "Brak pozycji")
    if len(pozycje) > 40:
        raise HTTPException(400, "Za dużo pozycji naraz")

    dzien = _dzien(body.get("data"))
    nazwa_grupy = (body.get("nazwa_grupy") or "").strip()[:120] or None
    # Grupę wiąże wspólny identyfikator. Nadaje go SERWER — gdyby dawał go
    # klient, dwie osoby mogłyby trafić w ten sam i zlepić swoje posiłki.
    grupa_id = uuid.uuid4().hex if nazwa_grupy and len(pozycje) > 1 else None

    zapisane = []
    for p in pozycje:
        nazwa = (p.get("nazwa") or "").strip()
        if not nazwa:
            raise HTTPException(400, "Pozycja bez nazwy")
        zapisane.append(eat_db.dodaj_wpis(hid, current_user["user_id"], {
            "data": dzien,
            "posilek": posilek,
            "produkt_id": None,
            "nazwa": nazwa[:120],
            "opis_porcji": (p.get("opis_porcji") or "").strip()[:40] or None,
            "ilosc_g": _sprawdz_ilosc(p.get("ilosc_g")),
            "grupa_id": grupa_id,
            "grupa_nazwa": nazwa_grupy if grupa_id else None,
            **_sprawdz_wartosci(p),
        }))
    return {"grupa_id": grupa_id, "wpisy": zapisane}


@router.post("/wpisy/scal", status_code=201)
def scal_wpisy(body: dict, current_user: dict = Depends(get_current_user)):
    """Kilka pojedynczych pozycji w dzienniku → jedno danie.

    Nie zakładamy z góry, że coś jest daniem: wrzucasz składniki po kolei tak,
    jak je skanujesz, a dopiero potem zaznaczasz te, które poszły na jeden
    talerz. Powstaje zwykła grupa — ta sama, którą tworzy AI przy „opisz
    słowami" — więc „Zapisz jako przepis" działa na tym bez żadnej nowej drogi.
    """
    surowe = body.get("ids") or []
    if not isinstance(surowe, list) or len(surowe) < 2:
        raise HTTPException(400, "Zaznacz co najmniej dwie pozycje")
    if len(surowe) > 60:
        raise HTTPException(400, "Za dużo pozycji naraz")
    try:
        ids = [int(x) for x in surowe]
    except (TypeError, ValueError):
        raise HTTPException(400, "Nieprawidłowe identyfikatory pozycji")

    nazwa = (body.get("nazwa") or "").strip()[:120] or "Danie"
    grupa_id = uuid.uuid4().hex
    ile = eat_db.scal_wpisy(_hid(current_user), current_user["user_id"],
                            ids, grupa_id, nazwa)
    if not ile:
        raise HTTPException(404, "Nie znaleziono tych pozycji")
    return {"grupa_id": grupa_id, "nazwa": nazwa, "scalono": ile}


@router.post("/grupa/{grupa_id}/rozlacz")
def rozlacz_grupe(grupa_id: str, current_user: dict = Depends(get_current_user)):
    """Rozbija danie z powrotem na osobne pozycje — nic nie kasuje, więc
    pomyłka przy scalaniu nie kosztuje wpisów."""
    ile = eat_db.rozlacz_grupe(grupa_id, _hid(current_user), current_user["user_id"])
    if not ile:
        raise HTTPException(404, "Nie znaleziono grupy")
    return {"ok": True, "rozlaczono": ile}


@router.delete("/grupa/{grupa_id}")
def usun_grupe(grupa_id: str, current_user: dict = Depends(get_current_user)):
    """Kasuje całe danie naraz — po rozłożeniu na składniki nikt nie chce
    usuwać ich pojedynczo."""
    ile = eat_db.usun_grupe(grupa_id, _hid(current_user), current_user["user_id"])
    if not ile:
        raise HTTPException(404, "Nie znaleziono grupy")
    return {"ok": True, "usunieto": ile}


@router.delete("/wpis/{wpis_id}")
def usun_wpis(wpis_id: int, current_user: dict = Depends(get_current_user)):
    if not eat_db.usun_wpis(wpis_id, _hid(current_user), current_user["user_id"]):
        raise HTTPException(404, "Nie znaleziono wpisu")
    return {"ok": True}


# ── przepisy ────────────────────────────────────────────────────────────────

def _skladniki_z_ciala(body: dict) -> list[dict]:
    surowe = body.get("skladniki") or []
    if not surowe:
        raise HTTPException(400, "Przepis bez składników")
    if len(surowe) > 60:
        raise HTTPException(400, "Za dużo składników")
    wynik = []
    for s in surowe:
        nazwa = (s.get("nazwa") or "").strip()
        if not nazwa:
            raise HTTPException(400, "Składnik bez nazwy")
        wynik.append({
            "produkt_id": s.get("produkt_id") or None,
            "nazwa": nazwa[:120],
            "ilosc_g": _sprawdz_ilosc(s.get("ilosc_g")),
            **_sprawdz_wartosci(s),
        })
    return wynik


def _porcje_z_ciala(body: dict, domyslnie: float = 1) -> float:
    porcje = _liczba(body.get("porcje", domyslnie))
    if porcje is None or not 0.25 <= porcje <= 50:
        raise HTTPException(400, "Liczba porcji poza zakresem (0,25–50)")
    return round(porcje, 2)


def _waga_z_ciala(body: dict) -> float | None:
    """Waga gotowego dania jest OPCJONALNA.

    Kalorie się nie gotują — woda nie dodaje energii, zmienia się tylko masa.
    Dlatego „suma składników ÷ liczba porcji" jest dokładne bez ważenia
    czegokolwiek. Waga przydaje się wyłącznie temu, kto woli odmierzać porcję
    na wadze zamiast na oko."""
    if body.get("waga_gotowego_g") in (None, "", 0):
        return None
    waga = _liczba(body.get("waga_gotowego_g"))
    if waga is None or not 1 <= waga <= 20000:
        raise HTTPException(400, "Waga gotowego dania poza zakresem")
    return round(waga, 1)


@router.get("/przepisy")
def przepisy(fraza: str = Query(""), current_user: dict = Depends(get_current_user)):
    return {"przepisy": eat_db.lista_przepisow(_hid(current_user), fraza)}


@router.get("/przepisy/{przepis_id}")
def przepis(przepis_id: int, current_user: dict = Depends(get_current_user)):
    p = eat_db.get_przepis(przepis_id, _hid(current_user))
    if not p:
        raise HTTPException(404, "Nie znaleziono przepisu")
    return p


@router.post("/przepisy", status_code=201)
def dodaj_przepis(body: dict, current_user: dict = Depends(get_current_user)):
    nazwa = (body.get("nazwa") or "").strip()
    if not nazwa:
        raise HTTPException(400, "Podaj nazwę przepisu")
    return eat_db.zapisz_przepis(_hid(current_user), current_user["user_id"], {
        "nazwa": nazwa[:120],
        "opis": (body.get("opis") or "").strip()[:2000] or None,
        "porcje": _porcje_z_ciala(body),
        "waga_gotowego_g": _waga_z_ciala(body),
        "skladniki": _skladniki_z_ciala(body),
    })


@router.patch("/przepisy/{przepis_id}")
def zmien_przepis(przepis_id: int, body: dict, current_user: dict = Depends(get_current_user)):
    """Poprawka przepisu NIE przepisuje historii — wpisy w dzienniku mają
    własne, zamrożone wartości i zostają takie, jakie były w dniu zjedzenia."""
    hid = _hid(current_user)
    biezacy = eat_db.get_przepis(przepis_id, hid)
    if not biezacy:
        raise HTTPException(404, "Nie znaleziono przepisu")
    nazwa = (body.get("nazwa") or "").strip() or biezacy["nazwa"]
    wynik = eat_db.zapisz_przepis(hid, current_user["user_id"], {
        "nazwa": nazwa[:120],
        "opis": (body.get("opis") or "").strip()[:2000] or None,
        "porcje": _porcje_z_ciala(body, float(biezacy["porcje"])),
        "waga_gotowego_g": _waga_z_ciala(body),
        "skladniki": _skladniki_z_ciala(body),
    }, przepis_id=przepis_id)
    if not wynik:
        raise HTTPException(404, "Nie znaleziono przepisu")
    return wynik


@router.delete("/przepisy/{przepis_id}")
def usun_przepis(przepis_id: int, current_user: dict = Depends(get_current_user)):
    if not eat_db.usun_przepis(przepis_id, _hid(current_user)):
        raise HTTPException(404, "Nie znaleziono przepisu")
    return {"ok": True}


@router.post("/przepisy/{przepis_id}/do-dnia", status_code=201)
def przepis_do_dnia(przepis_id: int, body: dict,
                    current_user: dict = Depends(get_current_user)):
    """Danie wchodzi do dziennika jako JEDEN wpis o nazwie przepisu.

    Rozbijanie ćwiartki porcji na „31,3 g mięsa mielonego" byłoby szumem —
    rozpiska składników mieszka w przepisie. Ilość podajesz w porcjach albo,
    jeśli przy przepisie zapisana jest waga gotowego dania, w gramach."""
    hid = _hid(current_user)
    p = eat_db.get_przepis(przepis_id, hid)
    if not p:
        raise HTTPException(404, "Nie znaleziono przepisu")

    posilek = body.get("posilek")
    if posilek not in eat_db.POSILKI:
        raise HTTPException(400, "Nieznany posiłek")

    porcje_dania = float(p["porcje"]) or 1
    # Masa, względem której przelicza się porcję odmierzoną na wadze. Gdy nic
    # nie odparowuje (sałatka, kanapka, koktajl), gotowe danie waży dokładnie
    # tyle, co suma składników — dlatego gramy działają ZAWSZE, a nie tylko przy
    # przepisach z ręcznie wpisaną wagą.
    waga_odniesienia = float(p["waga_odniesienia_g"]) or 1

    if body.get("gramy") not in (None, "", 0):
        gramy = _sprawdz_ilosc(body.get("gramy"))
        udzial = gramy / waga_odniesienia
        porcje_zjedzone = round(udzial * porcje_dania, 2)
        ilosc_g = gramy
        opis = f"{_ladna(gramy)} g"
    else:
        porcje_zjedzone = _liczba(body.get("porcje"))
        if porcje_zjedzone is None or not 0.05 <= porcje_zjedzone <= 20:
            raise HTTPException(400, "Liczba porcji poza zakresem (0,05–20)")
        porcje_zjedzone = round(porcje_zjedzone, 2)
        udzial = porcje_zjedzone / porcje_dania
        ilosc_g = round(waga_odniesienia * udzial, 1)
        opis = f"{_ladna(porcje_zjedzone)} porcji" if porcje_zjedzone != 1 else "1 porcja"

    # Rozpiska ZAMROŻONA w chwili zjedzenia. Podglądając za miesiąc „bigos"
    # w dzienniku masz zobaczyć, co było w tym talerzu — nawet jeśli przepis
    # został w międzyczasie poprawiony albo skasowany.
    import json as _json
    rozpiska = _json.dumps([{
        "nazwa": s["nazwa"],
        "ilosc_g": round(float(s["ilosc_g"] or 0) * udzial, 1),
        "kcal": round(float(s["kcal"] or 0) * udzial, 1),
    } for s in p["skladniki"]], ensure_ascii=False)

    wpis = eat_db.dodaj_wpis(hid, current_user["user_id"], {
        "skladniki_json": rozpiska,
        "data": _dzien(body.get("data")),
        "posilek": posilek,
        "produkt_id": None,
        "nazwa": p["nazwa"],
        "opis_porcji": opis,
        "ilosc_g": max(0.1, ilosc_g),
        "kcal": round(float(p["kcal"]) * udzial, 1),
        "bialko": round(float(p["bialko"] or 0) * udzial, 1),
        "tluszcz": round(float(p["tluszcz"] or 0) * udzial, 1),
        "wegle": round(float(p["wegle"] or 0) * udzial, 1),
        "przepis_id": przepis_id,
        "porcje_zjedzone": porcje_zjedzone,
    })
    eat_db.policz_uzycie(przepis_id, hid)
    return wpis


def _przepis_z_ai(dane: dict) -> dict:
    """Wspólne domknięcie dla obu dróg AI — z opisu i ze zdjęcia.

    Nic nie zapisujemy: użytkownik ma zobaczyć, co Claude wyliczył, i móc to
    poprawić, zanim przepis powstanie."""
    skladniki = [s for s in (dane.get("skladniki") or []) if (s.get("nazwa") or "").strip()]
    if not skladniki:
        raise HTTPException(422, "Nie widzę tu składników, z których dałoby się złożyć przepis.")
    porcje = _liczba(dane.get("porcje")) or 0
    return {
        "nazwa": (dane.get("nazwa") or "").strip()[:120] or "Nowy przepis",
        # Model czasem pomija liczbę porcji albo daje 0 — wtedy jedna porcja
        # jest bezpieczniejsza niż dzielenie przez zero.
        "porcje": round(porcje, 2) if 0.25 <= porcje <= 50 else 1,
        "skladniki": skladniki[:60],
    }


@router.post("/przepisy/z-opisu")
def przepis_z_opisu(body: dict, current_user: dict = Depends(get_current_user)):
    """Przepis wpisany albo podyktowany słowami → składniki do zatwierdzenia."""
    if current_user.get("ai_zablokowane"):
        raise HTTPException(403, "Funkcje AI są wyłączone dla tego konta.")
    hid = _hid(current_user)
    opis = (body.get("opis") or "").strip()
    if len(opis) < 10:
        raise HTTPException(400, "Opisz przepis dokładniej — składniki i ilości")
    import ai_processor
    import database
    try:
        dane, uzycie = ai_processor.szacuj_przepis(opis)
    except Exception as e:
        print(f"[eat] rozlozenie przepisu nie powiodlo sie: {e!r}")
        raise HTTPException(502, "Nie udało się rozłożyć przepisu. Spróbuj opisać prościej.")
    database.log_api_usage(hid, "eat-przepis", uzycie["input_tokens"], uzycie["output_tokens"],
                           current_user["user_id"])
    return _przepis_z_ai(dane)


@router.post("/przepisy/ze-zdjecia")
async def przepis_ze_zdjecia(file: UploadFile = File(...),
                             current_user: dict = Depends(get_current_user)):
    """Zdjęcie przepisu z książki albo z ekranu."""
    if current_user.get("ai_zablokowane"):
        raise HTTPException(403, "Funkcje AI są wyłączone dla tego konta.")
    hid = _hid(current_user)
    import ai_processor
    import database
    zawartosc = await file.read()
    try:
        dane, uzycie = await run_in_threadpool(
            ai_processor.przepis_ze_zdjecia, zawartosc, file.content_type or "image/jpeg")
    except Exception as e:
        print(f"[eat] odczyt przepisu ze zdjecia nie powiodl sie: {e!r}")
        raise HTTPException(502, "Nie udało się odczytać przepisu. Spróbuj ostrzejszego zdjęcia.")
    # Wywołanie z obrazem jest kilkukrotnie droższe od tekstowego, więc ma
    # własną etykietę — inaczej w panelu kosztów zlałoby się z opisem.
    database.log_api_usage(hid, "eat-przepis-foto", uzycie["input_tokens"],
                           uzycie["output_tokens"], current_user["user_id"])
    return _przepis_z_ai(dane)


@router.post("/przepisy/z-grupy/{grupa_id}", status_code=201)
def przepis_z_grupy(grupa_id: str, body: dict,
                    current_user: dict = Depends(get_current_user)):
    """„Zapisz jako przepis" z tego, co już zjadłeś.

    Najtańsza droga do przepisu i najpewniejsza: gramatury i wartości są już
    przez Ciebie sprawdzone, więc nie ma tu ani zgadywania, ani kosztu AI."""
    hid = _hid(current_user)
    wpisy = eat_db.get_grupe(grupa_id, hid, current_user["user_id"])
    if not wpisy:
        raise HTTPException(404, "Nie znaleziono dania")
    nazwa = ((body.get("nazwa") or "").strip()
             or (wpisy[0].get("grupa_nazwa") or "").strip())
    if not nazwa:
        raise HTTPException(400, "Podaj nazwę przepisu")
    porcje = _porcje_z_ciala(body)

    # Ile porcji reprezentuje to, co siedzi w dzienniku. Przepis opisuje CAŁE
    # danie, więc zapisane wpisy trzeba przeskalować do całości: mnożnik to
    # porcje / zapisane_porcje.
    #   - zapisałeś cały garnek dzielony na 4  → zapisane_porcje=4 → mnożnik 1
    #   - zapisałeś jedną porcję z czterech    → zapisane_porcje=1 → mnożnik 4
    # Domyślne 1 zachowuje zachowanie starszych klientów, które tego nie wysyłały.
    zapisane = _liczba(body.get("zapisane_porcje", 1)) or 1
    if not 0.05 <= zapisane <= 50:
        raise HTTPException(400, "Liczba zapisanych porcji poza zakresem (0,05–50)")
    mnoznik = porcje / zapisane

    return eat_db.zapisz_przepis(hid, current_user["user_id"], {
        "nazwa": nazwa[:120],
        "opis": None,
        "porcje": porcje,
        "waga_gotowego_g": _waga_z_ciala(body),
        "skladniki": [{
            "produkt_id": w.get("produkt_id"),
            "nazwa": w["nazwa"],
            "ilosc_g": round(float(w["ilosc_g"]) * mnoznik, 1),
            "kcal": round(float(w["kcal"] or 0) * mnoznik, 1),
            "bialko": round(float(w["bialko"] or 0) * mnoznik, 1),
            "tluszcz": round(float(w["tluszcz"] or 0) * mnoznik, 1),
            "wegle": round(float(w["wegle"] or 0) * mnoznik, 1),
        } for w in wpisy],
    })


# ── cele ────────────────────────────────────────────────────────────────────

@router.get("/cele")
def cele(current_user: dict = Depends(get_current_user)):
    return eat_db.get_cele(current_user["user_id"])


@router.put("/cele")
def zapisz_cele(body: dict, current_user: dict = Depends(get_current_user)):
    biezace = eat_db.get_cele(current_user["user_id"])
    granice = {"kcal": (800, 6000, "Kalorie"), "bialko": (20, 400, "Białko"),
               "tluszcz": (10, 300, "Tłuszcz"), "wegle": (20, 800, "Węglowodany")}
    nowe = {}
    for pole, (lo, hi, etykieta) in granice.items():
        v = _liczba(body.get(pole, biezace[pole]))
        if v is None or not lo <= v <= hi:
            # nazwa pola z kodu nic użytkownikowi nie mówi
            raise HTTPException(400, f"{etykieta}: wartość poza zakresem ({lo}–{hi})")
        nowe[pole] = int(v)
    eat_db.set_cele(current_user["user_id"], **nowe)
    return nowe
