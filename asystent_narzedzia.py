"""Narzędzia asystenta: definicje dla modelu i ich wykonanie.

Dwa rodzaje:
- ODCZYTOWE — czytają bazę, zawsze z gospodarstwem i użytkownikiem z sesji
  (z `Kontekst`), nigdy z argumentów modelu. Zadania czytamy funkcjami
  `task_db`, które filtrują przez `_WIDOCZNE` — prywatne zadania domowników
  nie trafiają do modelu.
- PROPOZYCJE (`zaproponuj_*`, `otworz_*`) — NICZEGO nie zapisują. Budują
  obiekt, który przeglądarka pokaże i ewentualnie wykona zwykłym endpointem.

Pola, które karta pokazuje jako fakty (projekt, wykonawca, termin, „cudze"),
bierzemy WYŁĄCZNIE z bazy — argumenty modelu mogły zostać podsunięte.
"""

import time
from dataclasses import dataclass, field
from datetime import datetime

import ai_processor
import database
import eat_db
import task_ai
import task_db
from asystent_reguly import (ETYKIETY_WIDOKOW, MAX_POZYCJI_LISTY, ZlaPropozycja,
                             nazwa_w_tekscie, obetnij, pora_posilku, sprawdz_dzien,
                             sprawdz_widok)
from task_dopasowanie import dopasuj_wykonawce, rozpoznane_miejsce, slowa

# Parser wołany z asystenta dostaje resztę budżetu polecenia (60 s) minus zapas
# na odpowiedź serwera; poniżej progu w ogóle nie startuje — i tak by nie zdążył,
# a zapłacilibyśmy za odpowiedź, której nikt nie zobaczy.
ZAPAS_S = 2.0
MIN_CZAS_PARSERA_S = 8.0
NAZWY_POSILKOW = {"sniadanie": "Śniadanie", "obiad": "Obiad", "kolacja": "Kolacja",
                  "przekaska": "Przekąska"}


@dataclass
class Kontekst:
    household_id: int
    user_id: int
    tekst: str                      # bieżąca wiadomość — jedyne źródło dla reguł „od razu"
    teraz: datetime                 # lokalny czas telefonu
    lista_domyslna_id: int | None = None
    propozycje: list = field(default_factory=list)
    pytanie: dict | None = None
    koszty: list = field(default_factory=list)     # [(etykieta, usage)]
    uwagi: list = field(default_factory=list)      # zdania dla użytkownika złożone przez narzędzia
    domownicy: list = field(default_factory=list)  # etykiety osób do promptu
    koniec: float | None = None                    # time.monotonic() końca budżetu polecenia


def _czas_parsera(k: Kontekst, domyslny: float) -> float:
    if k.koniec is None:
        return domyslny
    return min(domyslny, k.koniec - time.monotonic() - ZAPAS_S)


def _wylicz(nazwy: list[str]) -> str:
    """„mleko", „mleko i chleb", „mleko, chleb i masło"."""
    if len(nazwy) == 1:
        return nazwy[0]
    return ", ".join(nazwy[:-1]) + " i " + nazwy[-1]


def _osoby(household_id: int) -> tuple[dict, dict]:
    """(user_id → etykieta, virtual_id → etykieta) — te same etykiety, które
    pulpit pokazuje w filtrze osoby (`loadOsobaOptions` w auth.js)."""
    ludzie = {m["id"]: (m.get("display_name") or (m.get("name") or "").split(" ")[0] or None)
              for m in database.get_household_members(household_id)}
    wirtualni = {m["id"]: m.get("name") for m in database.get_virtual_members(household_id)}
    return ludzie, wirtualni


def etykiety_domownikow(household_id: int) -> list[str]:
    ludzie, wirtualni = _osoby(household_id)
    return [e for e in (*ludzie.values(), *wirtualni.values()) if e]


def _iso(v) -> str | None:
    return str(v)[:10] if v else None


def _wykonawca(z: dict, osoby: tuple[dict, dict]) -> str | None:
    ludzie, wirtualni = osoby
    if z.get("wykonawca_user_id"):
        return ludzie.get(z["wykonawca_user_id"])
    if z.get("wykonawca_virtual_id"):
        return wirtualni.get(z["wykonawca_virtual_id"])
    return None


def _osoby_jesli_trzeba(k: Kontekst, zadania: list[dict]) -> tuple[dict, dict]:
    if any(z.get("wykonawca_user_id") or z.get("wykonawca_virtual_id") for z in zadania):
        return _osoby(k.household_id)
    return {}, {}


def _nazwa_strefy(k: Kontekst):
    """Leniwy odczyt obszarów — jedno zapytanie, i to tylko gdy potrzebne."""
    pamiec = {}

    def nazwa(strefa_id):
        if "s" not in pamiec:
            pamiec["s"] = {s["id"]: s["nazwa"] for s in task_db.strefy(k.household_id, k.user_id)}
        return pamiec["s"].get(strefa_id)
    return nazwa


def _projekt(z: dict, rodzic_po_id, nazwa_strefy) -> str | None:
    """Nazwa sprawy, do której należy zadanie: najbliższy przodek-projekt,
    inaczej najwyższy przodek, inaczej obszar. Służy do odróżnienia dwóch
    „Prań" na kartach — nie do żadnej decyzji."""
    rodzic, najwyzszy = z.get("parent_id"), None
    for _ in range(6):
        if not rodzic:
            break
        r = rodzic_po_id(rodzic)
        if not r:
            break
        if r.get("projekt"):
            return r["tytul"]
        najwyzszy, rodzic = r["tytul"], r.get("parent_id")
    if najwyzszy:
        return najwyzszy
    return nazwa_strefy(z["strefa_id"]) if z.get("strefa_id") else None


def _int(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _liczba(v):
    try:
        f = float(str(v).replace(",", "."))
    except (TypeError, ValueError):
        return None
    return f if f == f and abs(f) != float("inf") else None


def _dodaj(k: Kontekst, typ: str, opis: str, dane: dict) -> str:
    k.propozycje.append({"typ": typ, "opis": opis, "dane": dane})
    return "Propozycja gotowa — użytkownik zobaczy ją na karcie."


# ── odczyt ──────────────────────────────────────────────────────────────────

def _szukaj_produktu(d: dict, k: Kontekst) -> str:
    fraza = str(d.get("fraza") or "").strip()[:80]
    if len(fraza) < 2:
        return "Podaj co najmniej 2 litery."
    wyniki = eat_db.szukaj_produktow(k.household_id, fraza, limit=10)
    return obetnij([{"id": p["id"], "nazwa": p["nazwa"], "kcal_100g": p.get("kcal"),
                     "porcja_g": p.get("porcja_g"), "opis_porcji": p.get("opis_porcji")}
                    for p in wyniki])


def _listy(d: dict, k: Kontekst) -> str:
    wynik = []
    for l in database.get_stan_list(k.household_id):
        wynik.append({"id": l["id"], "nazwa": l["nazwa"], "status": l.get("status"),
                      "domyslna": l["id"] == k.lista_domyslna_id,
                      "pozycje": [{"id": p["id"], "nazwa": p["nazwa"], "kupione": p["kupione"]}
                                  for p in l["pozycje"][:30]]})
    return obetnij(wynik)


def _drzewo(d: dict, k: Kontekst) -> str:
    return obetnij([{"id": z["id"], "tytul": z["tytul"], "parent_id": z["parent_id"],
                     "projekt": z["projekt"]}
                    for z in task_db.drzewo_do_wyboru(k.household_id, k.user_id)])


def _szukaj_zadania(d: dict, k: Kontekst) -> str:
    fraza = str(d.get("fraza") or "").strip()[:80]
    wyniki = task_db.szukaj(k.household_id, k.user_id, fraza, limit=20)
    if not wyniki:
        return "[]"
    # `szukaj` dokłada przodków znalezionych zadań — projekt liczymy bez
    # dodatkowych zapytań. Projekt, wykonawca i termin pozwalają modelowi
    # (i karcie) odróżnić dwa zadania o tym samym tytule.
    po_id = {z["id"]: z for z in wyniki}
    osoby = _osoby_jesli_trzeba(k, wyniki)
    strefa = _nazwa_strefy(k)
    return obetnij([{"id": z["id"], "tytul": z["tytul"], "status": z["status"],
                     "termin": _iso(z.get("termin")), "powtarzaj": z.get("powtarzaj"),
                     "projekt": _projekt(z, po_id.get, strefa),
                     "wykonawca": _wykonawca(z, osoby)}
                    for z in wyniki])


# ── propozycje ──────────────────────────────────────────────────────────────

def _pozycje_listy(d: dict, k: Kontekst) -> str:
    nazwy = [str(n).strip()[:200] for n in (d.get("nazwy") or []) if str(n).strip()]
    if not nazwy:
        return "Brak nazw do dopisania."
    if len(nazwy) > MAX_POZYCJI_LISTY:
        return f"Za dużo naraz — najwyżej {MAX_POZYCJI_LISTY} pozycji. Poproś o podział."
    listy = database.get_stan_list(k.household_id)
    if not listy:
        return "Gospodarstwo nie ma żadnej listy zakupów."
    # Tylko listy aktywne — dopisanie od razu nie może trafić na zamkniętą
    # albo wstrzymaną. Lista spoza gospodarstwa (zły id od modelu) nie istnieje
    # w `listy`, więc spadamy na domyślną — nigdy na cudzą.
    aktywne = [l for l in listy if l.get("status") == "aktywna"]
    if not aktywne:
        return "Gospodarstwo nie ma aktywnej listy zakupów."
    po_id = {l["id"]: l for l in aktywne}
    lista = po_id.get(_int(d.get("lista_id"))) or po_id.get(k.lista_domyslna_id) or aktywne[0]
    # Nazwa, która już stoi NIEKUPIONA na tej liście, nie idzie drugi raz.
    # Porównanie w obie strony (wszystkie słowa, odmiana) — „chleba" = „chleb",
    # ale „mleko" ≠ „mleko owsiane". Kupiona pozycja nie jest duplikatem: kto
    # dopisuje masło, które już kupił, chce je kupić znowu.
    otwarte = [p["nazwa"] for p in lista.get("pozycje") or [] if not p.get("kupione")]
    juz, na_liscie, nowe = [], [], []
    for n in nazwy:
        trafiona = next((o for o in otwarte if nazwa_w_tekscie(n, o) and nazwa_w_tekscie(o, n)), None)
        if trafiona is None:
            nowe.append(n)
        else:
            juz.append(n)
            if trafiona not in na_liscie:
                na_liscie.append(trafiona)
    if na_liscie:
        # W uwadze nazwa tak, jak stoi na liście — forma użytkownika bywa
        # w dopełniaczu („Chleba już jest…").
        t = _wylicz(na_liscie)
        k.uwagi.append(f"{t[:1].upper()}{t[1:]} już {'jest' if len(na_liscie) == 1 else 'są'} "
                       "na liście — nie dopisuję drugi raz.")
    if not nowe:
        return (f"Nic do dopisania — już są na liście „{lista['nazwa']}”: {', '.join(juz)}. "
                "Użytkownik dostał o tym wiadomość.")
    wynik = _dodaj(k, "lista_dopisz", f"Dopisz do listy „{lista['nazwa']}”: {', '.join(nowe)}",
                   {"lista_id": lista["id"], "lista_nazwa": lista["nazwa"], "nazwy": nowe})
    return wynik + (f" Pominięte, bo już są na liście: {', '.join(juz)}." if juz else "")


def _odhacz_liste(d: dict, k: Kontekst) -> str:
    pid = _int(d.get("pozycja_id"))
    for l in database.get_stan_list(k.household_id):
        for p in l["pozycje"]:
            if p["id"] == pid:
                if p["kupione"]:
                    return "Ta pozycja jest już odhaczona — nic nie robię."
                return _dodaj(k, "lista_odhacz", f"Odhacz „{p['nazwa']}” na liście „{l['nazwa']}”",
                              {"pozycja_id": pid, "nazwa": p["nazwa"],
                               "kupione_przed": False, "kupione_po": True})
    return "Nie ma takiej pozycji na listach tego gospodarstwa."


def _dopasuj_produkt(household_id: int, nazwa: str) -> dict | None:
    """Pozycja z opisu → produkt z bazy gospodarstwa. Muszą się zgadzać
    WSZYSTKIE słowa znaczące pozycji, a produkt może mieć najwyżej jedno słowo
    więcej: „chleb" → „Chleb żytni" tak, „banan" → „Banany suszone chipsy" nie
    (połowa słów łapała suszone chipsy jako banana). Przy kilku trafieniach
    wygrywa ten z najmniejszym nadmiarem. Szukamy po dwóch najdłuższych
    rdzeniach — LIKE po całej frazie nie trafiłby „jogurtu naturalnego"
    w „Jogurt naturalny Piątnica"."""
    szukane = slowa(nazwa)
    if not szukane:
        return None
    kandydaci = []
    for rdzen in sorted(szukane, key=len, reverse=True)[:2]:
        kandydaci += eat_db.szukaj_produktow(household_id, rdzen, limit=10)
    najlepszy, najmniejszy_nadmiar = None, None
    for p in kandydaci:
        if p.get("kcal") is None:
            # produkt z Open Food Facts bez kalorii — liczenie z niego dałoby
            # float(None) w /wpisy/grupa; taka pozycja zostaje szacunkiem
            continue
        jego = slowa(p["nazwa"])
        if not szukane <= jego:
            continue
        nadmiar = len(jego - szukane)
        if nadmiar > 1:
            continue
        if najmniejszy_nadmiar is None or nadmiar < najmniejszy_nadmiar:
            najlepszy, najmniejszy_nadmiar = p, nadmiar
    return najlepszy


def _wpis_jedzenia(d: dict, k: Kontekst) -> str:
    opis = str(d.get("opis") or "").strip()[:600]
    if len(opis) < 3:
        return "Za mało, żeby cokolwiek policzyć — zapytaj, co było w posiłku."
    posilek = d.get("posilek") if d.get("posilek") in eat_db.POSILKI else pora_posilku(k.teraz)
    # D2: inny dzień tylko 0–7 dni wstecz. Sprawdzamy PRZED parserem — zła data
    # nie może kosztować wywołania modelu.
    dzien = sprawdz_dzien(d.get("data"), k.teraz.date())
    czas = _czas_parsera(k, 40.0)
    if czas < MIN_CZAS_PARSERA_S:
        return "Zabrakło czasu na oszacowanie posiłku — poproś użytkownika, żeby powtórzył polecenie."
    pozycje, usage = ai_processor.szacuj_posilek(opis, timeout=czas, max_retries=0)
    k.koszty.append(("asystent-eat", usage))
    gotowe = []
    for p in (pozycje or [])[:20]:
        ilosc = _liczba(p.get("ilosc_g"))
        if not ilosc or ilosc <= 0:
            continue
        poz = {"nazwa": str(p.get("nazwa") or "").strip()[:120] or "Pozycja",
               "ilosc_g": round(ilosc, 1),
               "opis_porcji": (str(p.get("opis_porcji") or "").strip()[:40] or None)}
        produkt = _dopasuj_produkt(k.household_id, poz["nazwa"])
        if produkt:
            m = ilosc / 100.0
            poz.update(produkt_id=produkt["id"], produkt_nazwa=produkt["nazwa"], szacunek=False,
                       kcal=round(float(produkt["kcal"]) * m, 1),
                       bialko=round(float(produkt.get("bialko") or 0) * m, 1),
                       tluszcz=round(float(produkt.get("tluszcz") or 0) * m, 1),
                       wegle=round(float(produkt.get("wegle") or 0) * m, 1))
        else:
            poz.update(produkt_id=None, produkt_nazwa=None, szacunek=True,
                       **{m: round(_liczba(p.get(m)) or 0, 1)
                          for m in ("kcal", "bialko", "tluszcz", "wegle")})
        gotowe.append(poz)
    if not gotowe:
        return "Nie udało się nic oszacować — zapytaj o szczegóły posiłku."
    # Nazwa dania: krótka, w mianowniku, od modelu; bez niej nazwa posiłku
    # („Obiad"). Nigdy wycinek opisu — „na obiad był schabowy z ziem" w
    # dzienniku to śmieć, którego nikt potem nie poprawia.
    nazwa = str(d.get("nazwa") or "").strip()[:60] or NAZWY_POSILKOW[posilek]
    wiele = len(gotowe) > 1
    return _dodaj(k, "jedzenie", f"Wpis do dziennika: {nazwa if wiele else gotowe[0]['nazwa']}",
                  {"data": dzien, "posilek": posilek,
                   "nazwa_grupy": nazwa if wiele else None, "pozycje": gotowe})


def _skan(d: dict, k: Kontekst) -> str:
    posilek = d.get("posilek") if d.get("posilek") in eat_db.POSILKI else pora_posilku(k.teraz)
    dane = {"data": sprawdz_dzien(d.get("data"), k.teraz.date()), "posilek": posilek}
    # Porcja powiedziana w poleceniu („zjadłem dwa jogurty, zeskanuję") — karta
    # po skanie ustawi z niej gramaturę. Spoza zakresu = nie powiedziana.
    gramy, sztuk = _liczba(d.get("gramy")), _liczba(d.get("sztuk"))
    if gramy and 1 <= gramy <= 5000:
        dane["gramy"] = round(gramy, 1)
    if sztuk and 0.25 <= sztuk <= 20:
        dane["sztuk"] = round(sztuk, 2)
    return _dodaj(k, "skan", "Zeskanuj kod kreskowy produktu", dane)


def _zadanie(d: dict, k: Kontekst) -> str:
    opis = str(d.get("opis") or "").strip()
    czas = _czas_parsera(k, 30.0)
    if czas < MIN_CZAS_PARSERA_S:
        return "Zabrakło czasu na zrozumienie zadania — poproś użytkownika, żeby powtórzył polecenie."
    try:
        z, usage = task_ai.zrozum(opis, dzis=k.teraz.date(), timeout=czas, max_retries=0)
    except task_ai.MowaError as e:
        return str(e)
    k.koszty.append(("asystent-task", usage))
    wyk_user, wyk_virtual = dopasuj_wykonawce(k.household_id, z.get("wykonawca"))
    cel, obszar = rozpoznane_miejsce(k.household_id, k.user_id, z.get("gdzie"))
    miejsce = cel["tytul"] if cel else (obszar["nazwa"] if obszar else "bez projektu")
    return _dodaj(k, "zadanie", f"Nowe zadanie: {z['tytul']}", {
        "tytul": z["tytul"], "termin": z["termin"], "pora": z["pora"],
        "powtarzaj": z["powtarzaj"], "powtarzaj_co": z["powtarzaj_co"],
        "parent_id": cel["id"] if cel else None,
        "strefa_id": obszar["id"] if obszar else None,
        "wykonawca_user_id": wyk_user, "wykonawca_virtual_id": wyk_virtual,
        "wykonawca_opis": z.get("wykonawca") if (wyk_user or wyk_virtual) else None,
        "miejsce_opis": miejsce,
    })


def _odhacz_zadanie(d: dict, k: Kontekst) -> str:
    z = task_db.pobierz(k.household_id, k.user_id, _int(d.get("zadanie_id")))
    if not z:
        return "Nie ma takiego zadania."
    if z["status"] == "zrobione":
        return "To zadanie jest już zrobione — nic nie robię."
    uwagi = []
    if z.get("powtarzaj"):
        uwagi.append("Zadanie powtarzalne — odhaczenie utworzy kolejne wystąpienie.")
    if z["status"] == "wstrzymane":
        uwagi.append("Zadanie jest wstrzymane — po odhaczeniu nie wróci do wstrzymania.")
    if task_db.ma_otwarte_dzieci(k.household_id, z["id"]):
        uwagi.append("Podzadania zostaną otwarte.")
    # Projekt, wykonawca, termin i „cudze" — z bazy, nie z argumentów modelu.
    # Karta pokazuje z nich linię, która odróżnia dwa zadania o tym samym
    # tytule, i mówi wprost, czemu pyta przed odhaczeniem cudzego.
    cudze = (bool(z.get("wykonawca_virtual_id"))
             or z.get("wykonawca_user_id") not in (None, k.user_id))
    return _dodaj(k, "zadanie_odhacz", f"Odhacz zadanie „{z['tytul']}”", {
        "zadanie_id": z["id"], "tytul": z["tytul"], "zrobione_przed": False,
        "uwaga": " ".join(uwagi) or None,
        "wykonawca_user_id": z.get("wykonawca_user_id"),
        "wykonawca_virtual_id": z.get("wykonawca_virtual_id"),
        "projekt": _projekt(z, lambda i: task_db.pobierz(k.household_id, k.user_id, i),
                            _nazwa_strefy(k)),
        "wykonawca": _wykonawca(z, _osoby_jesli_trzeba(k, [z])),
        "termin": _iso(z.get("termin")),
        "cudze": cudze,
    })


def _widok(d: dict, k: Kontekst) -> str:
    # `typ="widok"` powstaje WYŁĄCZNIE tutaj i zawsze przez sprawdz_widok —
    # nazwa z białej listy, adres buduje przeglądarka.
    dane = sprawdz_widok(str(d.get("widok") or ""), d.get("filtry"))
    osoba = dane["filtry"].get("osoba")
    if osoba:
        # Ta sama etykieta co w filtrze pulpitu, inaczej pulpit po cichu
        # pokazałby wszystkich. Odmiana i pierwszy człon („Oli" → „Ola").
        znane = etykiety_domownikow(k.household_id)
        trafiona = next((e for e in znane
                         if nazwa_w_tekscie(e, osoba) or nazwa_w_tekscie(e.split(" ")[0], osoba)), None)
        if not trafiona:
            raise ZlaPropozycja(f"Nie ma w gospodarstwie osoby „{osoba}”. Domownicy: "
                                f"{', '.join(znane) or 'brak'}. Zaproponuj widok bez osoby albo zapytaj.")
        dane["filtry"]["osoba"] = trafiona
    # D3: przejście podsunięte przy odpowiedzi „tego nie umiem" — zawsze karta.
    dane["poza_zakresem"] = d.get("poza_zakresem") is True
    return _dodaj(k, "widok", f"Przejdź: {ETYKIETY_WIDOKOW[dane['widok']]}", dane)


def _aparat(d: dict, k: Kontekst) -> str:
    return _dodaj(k, "aparat", "Zrób zdjęcie paragonu", {})


def _zapytaj(d: dict, k: Kontekst) -> str:
    tekst = str(d.get("tekst") or "").strip()[:200]
    opcje = [str(o).strip()[:40] for o in (d.get("opcje") or []) if str(o).strip()][:4]
    if not tekst or len(opcje) < 2:
        return "Pytanie potrzebuje treści i co najmniej 2 opcji."
    k.pytanie = {"tekst": tekst, "opcje": opcje}
    return "Pytanie zadane — zakończ turę i czekaj na odpowiedź."


_WYKONAWCY = {
    "szukaj_produktu_eat": _szukaj_produktu,
    "listy_zakupow": _listy,
    "drzewo_zadan": _drzewo,
    "szukaj_zadania": _szukaj_zadania,
    "zaproponuj_pozycje_listy": _pozycje_listy,
    "zaproponuj_odhaczenie_listy": _odhacz_liste,
    "zaproponuj_wpis_jedzenia": _wpis_jedzenia,
    "zaproponuj_skan": _skan,
    "zaproponuj_zadanie": _zadanie,
    "zaproponuj_odhaczenie_zadania": _odhacz_zadanie,
    "otworz_widok": _widok,
    "otworz_aparat": _aparat,
    "zapytaj": _zapytaj,
}

# Narzędzia, które tylko proponują. Iteracja pętli, w której model wołał
# wyłącznie te i każde dało propozycję, pytanie albo uwagę, kończy rozmowę
# (asystent._rozmowa) — bez zamykającego wywołania modelu.
NARZEDZIA_PROPOZYCJI = frozenset(
    {n for n in _WYKONAWCY if n.startswith(("zaproponuj_", "otworz_"))} | {"zapytaj"})


def wykonaj(nazwa: str, dane: dict, k: Kontekst) -> str:
    funkcja = _WYKONAWCY.get(nazwa)
    if not funkcja:
        return "Nieznane narzędzie."
    try:
        return funkcja(dane if isinstance(dane, dict) else {}, k)
    except ZlaPropozycja as e:
        return str(e)
    except Exception as e:
        # Parser posiłku potrafi oddać nie-JSON, baza — chwilowo nie odpowiadać.
        # Jedno narzędzie nie może wywrócić całego polecenia: model dostaje
        # komunikat i może spróbować inaczej albo powiedzieć, że się nie udało.
        print(f"[asystent] narzedzie {nazwa} zawiodlo: {e!r}")
        return "Narzędzie zawiodło — spróbuj inaczej albo powiedz użytkownikowi, że się nie udało."


_POSILEK = {"type": "string", "enum": list(eat_db.POSILKI)}

TOOLS = [
    {"name": "szukaj_produktu_eat",
     "description": "Szuka produktu w bazie jedzenia gospodarstwa (kalorie na 100 g).",
     "input_schema": {"type": "object", "properties": {"fraza": {"type": "string"}},
                      "required": ["fraza"]}},
    {"name": "listy_zakupow",
     "description": "Listy zakupów gospodarstwa z pozycjami (id, nazwa, kupione).",
     "input_schema": {"type": "object", "properties": {}}},
    {"name": "drzewo_zadan",
     "description": "Otwarte zadania i projekty (id, tytul, parent_id, projekt).",
     "input_schema": {"type": "object", "properties": {}}},
    {"name": "szukaj_zadania",
     "description": "Szuka zadań po tytule — potrzebne do odhaczenia. Zwraca id, tytul, status, "
                    "termin, projekt i wykonawca (do odróżnienia zadań o tym samym tytule).",
     "input_schema": {"type": "object", "properties": {"fraza": {"type": "string"}},
                      "required": ["fraza"]}},
    {"name": "zaproponuj_pozycje_listy",
     "description": "Dopisuje pozycje do listy zakupów (najwyżej 10). WSZYSTKIE nazwy z polecenia "
                    "w JEDNYM wywołaniu. Nazwa = sam produkt, słowami i w formie użytkownika "
                    "(„jajek”, nie „jajka”), bez ilości, jednostek i przymiotników, których nie "
                    "powiedział. Nie sprawdzaj wcześniej list — duplikaty odsiewa serwer.",
     "input_schema": {"type": "object", "properties": {
         "lista_id": {"type": "integer"},
         "nazwy": {"type": "array", "items": {"type": "string"}, "maxItems": 10}},
         "required": ["nazwy"]}},
    {"name": "zaproponuj_odhaczenie_listy",
     "description": "Proponuje odhaczenie pozycji listy jako kupionej. Id weź z listy_zakupow. "
                    "Dokładna nazwa wygrywa z częściową; gdy kilka pasuje równie dobrze, wywołaj "
                    "dla KAŻDEJ — karty są wyborem, nie pytaj.",
     "input_schema": {"type": "object", "properties": {"pozycja_id": {"type": "integer"}},
                      "required": ["pozycja_id"]}},
    {"name": "zaproponuj_wpis_jedzenia",
     "description": "Proponuje wpis w dzienniku jedzenia z opisu słowami (jeden lub wiele "
                    "produktów). Nie szukaj wcześniej produktów — dopasowanie do bazy robi serwer.",
     "input_schema": {"type": "object", "properties": {
         "opis": {"type": "string", "description": "Co zjedzono, z ilościami, słowami użytkownika."},
         "nazwa": {"type": "string",
                   "description": "Krótka nazwa dania w mianowniku, np. „Owsianka z bananem”, "
                                  "„Kanapka z serem”; gdy nie ma czego nazwać — nazwa posiłku."},
         "posilek": _POSILEK,
         "data": {"type": "string",
                  "description": "RRRR-MM-DD — TYLKO gdy użytkownik powiedział inny dzień "
                                 "(„wczoraj”, „przedwczoraj”, „w niedzielę”); policz z TERAZ. "
                                 "Najwyżej 7 dni wstecz. Inaczej pomiń."}},
         "required": ["opis", "nazwa"]}},
    {"name": "zaproponuj_skan",
     "description": "Proponuje zeskanowanie kodu kreskowego zjedzonego produktu. Gramy albo "
                    "sztuki podaj tylko, jeśli użytkownik je powiedział.",
     "input_schema": {"type": "object", "properties": {
         "posilek": _POSILEK,
         "data": {"type": "string", "description": "RRRR-MM-DD — tylko inny dzień, jak w zaproponuj_wpis_jedzenia."},
         "gramy": {"type": "number"}, "sztuk": {"type": "number"}}}},
    {"name": "zaproponuj_zadanie",
     "description": "Proponuje nowe zadanie. Przekaż zdanie użytkownika (termin, projekt, osoba). "
                    "Nie pytaj o projekt — karta pozwala go zmienić.",
     "input_schema": {"type": "object", "properties": {"opis": {"type": "string"}},
                      "required": ["opis"]}},
    {"name": "zaproponuj_odhaczenie_zadania",
     "description": "Proponuje oznaczenie zadania jako zrobionego. Id weź z szukaj_zadania. "
                    "Dokładny tytuł wygrywa z częściowym; gdy kilka pasuje równie dobrze, wywołaj "
                    "dla KAŻDEGO — karty są wyborem, nie pytaj.",
     "input_schema": {"type": "object", "properties": {"zadanie_id": {"type": "integer"}},
                      "required": ["zadanie_id"]}},
    {"name": "otworz_widok",
     "description": "Przechodzi do strony aplikacji — tylko gdy użytkownik prosi o otwarcie strony "
                    "albo (poza_zakresem=true) gdy pyta o coś, czego nie umiesz, a odpowiedź jest "
                    "na tej stronie. Filtry month (YYYY-MM) i osoba (imię domownika) tylko dla pulpitu.",
     "input_schema": {"type": "object", "properties": {
         "widok": {"type": "string", "enum": ["pulpit", "lista", "analiza", "konta", "cele",
                                              "wplywy", "eat", "produkty", "przepisy",
                                              "statystyki", "task", "health", "waga"]},
         "filtry": {"type": "object", "properties": {
             "month": {"type": "string"}, "osoba": {"type": "string"}}},
         "poza_zakresem": {"type": "boolean",
                           "description": "true = podpowiedź przy odpowiedzi „tego nie umiem”."}},
         "required": ["widok"]}},
    {"name": "otworz_aparat",
     "description": "Pokazuje przycisk do zdjęcia paragonu.",
     "input_schema": {"type": "object", "properties": {}}},
    {"name": "zapytaj",
     "description": "Zadaje użytkownikowi pytanie z 2–4 odpowiedziami, gdy czegoś brakuje.",
     "input_schema": {"type": "object", "properties": {
         "tekst": {"type": "string"},
         "opcje": {"type": "array", "items": {"type": "string"}, "minItems": 2, "maxItems": 4}},
         "required": ["tekst", "opcje"]}},
]
