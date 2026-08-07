"""Powiadomienia Web Push (VAPID).

Klucze siedzą w zmiennych środowiskowych `VAPID_PUBLIC_KEY` i `VAPID_PRIVATE_KEY`.
Generuje się je RAZ i zostają na zawsze — ich podmiana unieważnia wszystkie
zapisane subskrypcje i każdy musi włączyć powiadomienia od nowa.

Zasada obowiązująca w całym module: brak kluczy, brak biblioteki albo błąd
usługi dostarczającej NIGDY nie wywala żądania ani zadania schedulera. Funkcja
po prostu nic nie wysyła i mówi o tym w logu — dokładnie tak, jak zachowuje się
scheduler auto-raportu w `main.py`.

Treści są celowo suche: bez wykrzykników, bez eskalacji („zaległe od 5 dni"),
bez liczenia serii. Powiadomienie ma przypomnieć, a nie zawstydzić.
"""

import json
import os
from datetime import date

import database

_PUBLICZNY = (os.getenv("VAPID_PUBLIC_KEY") or "").strip()
_PRYWATNY = (os.getenv("VAPID_PRIVATE_KEY") or "").strip()
# RFC 8292 wymaga kontaktu do właściciela serwera — usługa dostarczająca użyje
# go, gdyby nasze wysyłki zaczęły sprawiać kłopoty. Nie może być pusty: bez
# claimu `sub` biblioteka odrzuci wysyłkę, więc trzymamy sensowną wartość
# domyślną zamiast liczyć na jeszcze jedną zmienną na Railway.
_KONTAKT = (os.getenv("VAPID_KONTAKT") or "mailto:a.folwarsk@gmail.com").strip()


def skonfigurowane() -> bool:
    return bool(_PUBLICZNY and _PRYWATNY)


def klucz_publiczny() -> str | None:
    """Klucz podawany przeglądarce przy zapisie na powiadomienia."""
    return _PUBLICZNY or None


# ── formatowanie ────────────────────────────────────────────────────────────

def _zl(kwota) -> str:
    try:
        s = f"{float(kwota):,.2f}".replace(",", " ").replace(".", ",")
    except (TypeError, ValueError):
        return "—"
    return s.replace(",00", "") + " zł"


def _odmiana(n: int, jeden: str, kilka: str, wiele: str) -> str:
    """Polska liczba mnoga: 1 sprawa, 2-4 sprawy, 5+ spraw (z wyjątkiem 12-14)."""
    if n == 1:
        return jeden
    reszta10, reszta100 = n % 10, n % 100
    if 2 <= reszta10 <= 4 and not (12 <= reszta100 <= 14):
        return kilka
    return wiele


def _kiedy(dni: int) -> str:
    if dni < 0:
        return "termin minął"
    return {0: "dziś", 1: "jutro"}.get(dni, f"za {dni} {_odmiana(dni, 'dzień', 'dni', 'dni')}")


def _opis(p: dict) -> str:
    czynnosc = "Przelew" if p.get("typ") == "reczny" else "Pobranie"
    return f"{czynnosc}: {p.get('nazwa')} {_zl(p.get('kwota'))} — {_kiedy(p.get('dni_do', 0))}"


# ── wysyłka ─────────────────────────────────────────────────────────────────

def wyslij_do_uzytkownika(user_id: int, tytul: str, tresc: str, url: str = "/",
                          tag: str | None = None) -> int:
    """Wysyła jedno powiadomienie na WSZYSTKIE urządzenia użytkownika.

    Zwraca liczbę urządzeń, do których dotarło. Subskrypcje odrzucone przez
    usługę jako wygasłe (404/410 — odinstalowana apka, wyczyszczone dane
    przeglądarki) kasujemy od razu, żeby tabela nie puchła martwymi wpisami."""
    if not skonfigurowane():
        return 0
    try:
        from pywebpush import WebPushException, webpush
    except Exception as e:                      # biblioteki brak — nie przewracamy apki
        print(f"[push] pywebpush niedostępny: {e!r}")
        return 0

    subskrypcje = database.get_push_subskrypcje(user_id)
    if not subskrypcje:
        return 0

    ladunek = json.dumps({"tytul": tytul, "tresc": tresc, "url": url, "tag": tag or "wiem"},
                         ensure_ascii=False)
    dostarczone = 0
    for s in subskrypcje:
        try:
            webpush(
                subscription_info={
                    "endpoint": s["endpoint"],
                    "keys": {"p256dh": s["p256dh"], "auth": s["auth"]},
                },
                data=ladunek,
                vapid_private_key=_PRYWATNY,
                vapid_claims={"sub": _KONTAKT},
                ttl=86400,          # dobę — po tym czasie przypomnienie jest nieaktualne
            )
            dostarczone += 1
        except WebPushException as e:
            kod = getattr(getattr(e, "response", None), "status_code", None)
            if kod in (404, 410):
                database.usun_push_subskrypcje(s["endpoint"])
                print(f"[push] subskrypcja wygasła ({kod}) — usunięta, user {user_id}")
            else:
                print(f"[push] błąd wysyłki do usera {user_id}: {e!r}")
        except Exception as e:
            print(f"[push] nieoczekiwany błąd wysyłki do usera {user_id}: {e!r}")
    return dostarczone


def wyslij_do_gospodarstwa(household_id: int, tytul: str, tresc: str, url: str = "/",
                           tag: str | None = None, pomin: set[int] | None = None) -> int:
    """To samo, ale do wszystkich domowników. `pomin` = osoby, które same wywołały
    zdarzenie — nie zawiadamiamy kogoś o jego własnym działaniu."""
    pomin = pomin or set()
    razem = 0
    for czlonek in database.get_household_members(household_id):
        if czlonek["id"] in pomin:
            continue
        razem += wyslij_do_uzytkownika(czlonek["id"], tytul, tresc, url, tag)
    return razem


# ── zadanie dzienne (scheduler, 9:00) ───────────────────────────────────────

def _klucz_terminu(p: dict) -> str:
    """Identyfikator zdarzenia, żeby to samo powiadomienie nie poszło dwa razy.
    Automatyczne nie mają id w bazie (liczą się w locie), więc sklejamy z nazwy
    i daty terminu."""
    if p.get("id"):
        return f"termin:p{p['id']}"
    return f"termin:a:{p.get('nazwa')}:{p.get('termin')}"


def wyslij_przypomnienia_dzienne() -> None:
    """Raz dziennie o 9:00. Dwa rodzaje powiadomień:

    - rzeczy z terminem DZIŚ — każda dostaje własne, raz w życiu (klucz w
      `push_wyslane`), bo to moment, w którym trzeba działać;
    - cała reszta (nadchodzące i te po terminie) — jedno zbiorcze na dzień.

    Świadomie NIE ponawiamy powiadomień o rzeczach po terminie codziennie:
    wpadają do zbiorczego i tyle. Codzienne dobijanie się o tę samą zaległość to
    maszyna do wstydu, nie przypomnienie."""
    if not skonfigurowane():
        print("[push] brak kluczy VAPID — pomijam przypomnienia dzienne")
        return

    dzis = date.today().isoformat()
    print(f"[push] start przypomnień dziennych {dzis}")
    for hid in database.get_all_household_ids():
        try:
            # KONIECZNE: oczekujące płatności powstają dopiero przy naliczeniu
            # cyklicznych, a to leci normalnie z wejścia na pulpit. Bez tego
            # kroku push nigdy by nie zawiadomił kogoś, kto akurat nie zagląda
            # do apki — czyli dokładnie tej osoby, dla której go robimy.
            database.naliczaj_cykliczne(hid)
            przypomnienia = database.get_przypomnienia(hid)
            if not przypomnienia:
                continue
            na_dzis = [p for p in przypomnienia if p.get("dni_do") == 0]
            reszta = [p for p in przypomnienia if p.get("dni_do") != 0]

            for czlonek in database.get_household_members(hid):
                uid = czlonek["id"]
                if not database.ma_push_subskrypcje(uid):
                    continue

                for p in na_dzis:
                    klucz = _klucz_terminu(p)
                    if database.push_juz_wyslany(uid, klucz):
                        continue
                    czynnosc = "Przelew" if p.get("typ") == "reczny" else "Pobranie"
                    konto = p.get("konto_nazwa")
                    wyslij_do_uzytkownika(
                        uid,
                        f"Dziś termin: {p.get('nazwa')}",
                        _zl(p.get("kwota")) + (f" z konta {konto}" if konto else ""),
                        url="/powiadomienia",
                        tag=klucz,
                    )
                    database.oznacz_push_wyslany(uid, klucz)

                if reszta:
                    klucz = f"dzienny:{dzis}"
                    if database.push_juz_wyslany(uid, klucz):
                        continue
                    n = len(reszta)
                    if n == 1:
                        tytul, tresc = "Do zrobienia", _opis(reszta[0])
                    else:
                        tytul = f"Do zrobienia: {n} {_odmiana(n, 'sprawa', 'sprawy', 'spraw')}"
                        widoczne = [_opis(p) for p in reszta[:2]]
                        if n > 2:
                            widoczne.append(f"i {n - 2} więcej")
                        tresc = " · ".join(widoczne)
                    wyslij_do_uzytkownika(uid, tytul, tresc, url="/powiadomienia", tag=klucz)
                    database.oznacz_push_wyslany(uid, klucz)
        except Exception as e:
            print(f"[push] gosp {hid}: BŁĄD — {e!r}")
    print("[push] koniec przypomnień dziennych")


if __name__ == "__main__":
    from dotenv import load_dotenv
    from pathlib import Path
    load_dotenv(Path(__file__).parent / ".env")
    wyslij_przypomnienia_dzienne()
