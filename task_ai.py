"""Zamiana wypowiedzianego zdania na zadanie — moduł wiem.task.

Osobny plik z tego samego powodu co `health_ai.py`: `ai_processor.py` obsługuje
paragony i nie ma po co wiedzieć o terminach zadań.

CAŁA ROBOTA POLEGA NA WYCIĄGNIĘCIU DATY Z MOWY POTOCZNEJ. „Jutro", „w przyszły
wtorek", „za dwa tygodnie", „pod koniec miesiąca" — tego nie da się rozebrać
wyrażeniem regularnym w sposób, który nie sypie się na pierwszym nietypowym
zdaniu. Model dostaje dzisiejszą datę i dzień tygodnia, bo bez nich nie ma
punktu odniesienia i „jutro" nic dla niego nie znaczy.
"""

import json
import re
from datetime import date

import anthropic

MODEL = "claude-sonnet-4-6"

OKRESY = ("dzien", "tydzien", "miesiac", "rok")

DNI_TYGODNIA = ["poniedziałek", "wtorek", "środa", "czwartek", "piątek",
                "sobota", "niedziela"]


class MowaError(ValueError):
    """Nie da się zrobić zadania z tego, co powiedziano."""


_PROMPT = """Zamieniasz wypowiedziane po polsku zdanie na zadanie do zrobienia.

ZWRÓĆ WYŁĄCZNIE JSON — jeden obiekt, bez słowa wstępu i bez komentarzy.
Odpowiedź czyta program, nie człowiek.

{
  "tytul": "Kupić mleko",
  "termin": "2026-08-29",
  "pora": "18:00",
  "powtarzaj": null,
  "powtarzaj_co": 1,
  "wykonawca": null,
  "gdzie": null
}

ZASADY:

TYTUŁ to sama czynność, BEZ okoliczności czasu. Ze zdania „kup mleko jutro
o osiemnastej" tytuł brzmi „Kupić mleko" — nie „Kupić mleko jutro o 18".
Data i godzina mają własne pola i powtarzanie ich w tytule zaśmieca listę.
Pierwsza litera wielka, bez kropki na końcu.

TERMIN w formacie RRRR-MM-DD albo null, gdy nie padła żadna wskazówka czasu.
Licz od DZISIEJSZEJ DATY podanej niżej:
- „dziś", „dzisiaj" → dzisiejsza data
- „jutro" → dzisiejsza + 1 dzień; „pojutrze" → + 2 dni
- „w poniedziałek" → NAJBLIŻSZY przyszły poniedziałek (jeśli dziś jest
  poniedziałek, chodzi o za tydzień, nie o dziś)
- „w przyszły wtorek" → wtorek w kolejnym tygodniu
- „za tydzień" → + 7 dni; „za dwa tygodnie" → + 14 dni
- „pod koniec miesiąca" → ostatni dzień bieżącego miesiąca
- „15 września" → najbliższy 15 września (jeśli już minął, przyszły rok)
Gdy nie ma ŻADNEJ wskazówki czasu, wpisz null. Nie zgaduj „dziś".

PORA w formacie GG:MM albo null. „O osiemnastej", „o szóstej wieczorem" → 18:00.
„Rano" → 08:00, „w południe" → 12:00, „wieczorem" → 19:00. Sama data bez
godziny zostawia porę pustą — godzina służy przypomnieniu, a nie ozdobie.

POWTARZAJ: null, "dzien", "tydzien", "miesiac" albo "rok". Wypełniaj TYLKO
przy wyraźnej wskazówce powtarzania: „co tydzień", „codziennie", „co dwa
tygodnie", „w każdy wtorek". Wtedy POWTARZAJ_CO to liczba jednostek (co dwa
tygodnie → "tydzien" i 2). Jednorazowe „w przyszły wtorek" NIE jest
powtarzaniem.

WYKONAWCA: imię osoby, jeśli padło („niech Ola kupi mleko" → "Ola"), w innym
razie null. Nie wymyślaj imion.

GDZIE: nazwa projektu albo zadania, do którego to należy, jeśli padła —
„dopisz do urlopu w Maladze kupno biletów" → "urlop w Maladze", „w zakupie
działki umów notariusza" → "zakup działki". Przepisz to, co usłyszałeś, nie
poprawiaj odmiany ani nie skracaj; dopasowaniem do istniejących projektów
zajmuje się program. Gdy nie padła żadna wskazówka przynależności, wpisz null
— NIE zgaduj po temacie. „Kupić bilety" bez wymienienia projektu to null,
nawet jeśli w apce istnieje projekt o biletach.

TYTUŁ nie zawiera nazwy projektu. Ze zdania „w zakupie działki umów notariusza"
tytuł brzmi „Umówić notariusza", a „zakup działki" idzie do GDZIE.

Gdy zdanie nie zawiera żadnej czynności do zrobienia (samo „yyy", cisza,
przypadkowe słowo), zwróć {"tytul": null}."""


def _dzis_kontekst() -> str:
    d = date.today()
    return (f"\n\nDZISIAJ JEST: {d.isoformat()} ({DNI_TYGODNIA[d.weekday()]}).\n"
            "Wszystkie wyrażenia względne licz od tej daty.")


def _wytnij_json(txt: str):
    """Wyłuskuje obiekt JSON z odpowiedzi — model bywa uczynny i dopisuje zdanie."""
    txt = txt.strip()
    if txt.startswith("```"):
        txt = re.sub(r"^```[a-z]*\s*|\s*```$", "", txt)
    poczatek = txt.find("{")
    if poczatek < 0:
        raise MowaError("Nie udało się zrozumieć polecenia.")
    glebokosc = 0
    w_tekscie = False
    ucieczka = False
    for i, znak in enumerate(txt[poczatek:], poczatek):
        if w_tekscie:
            if ucieczka:
                ucieczka = False
            elif znak == "\\":
                ucieczka = True
            elif znak == '"':
                w_tekscie = False
            continue
        if znak == '"':
            w_tekscie = True
        elif znak == "{":
            glebokosc += 1
        elif znak == "}":
            glebokosc -= 1
            if glebokosc == 0:
                return json.loads(txt[poczatek:i + 1])
    raise MowaError("Nie udało się zrozumieć polecenia.")


def _czysc(dane: dict) -> dict:
    """Przycina odpowiedź modelu do tego, co baza faktycznie przyjmie."""
    tytul = (dane.get("tytul") or "").strip()
    if not tytul:
        raise MowaError("Nie usłyszałem, co mam zapisać. Spróbuj jeszcze raz.")

    termin = (dane.get("termin") or "").strip() or None
    if termin and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", termin):
        termin = None
    pora = (dane.get("pora") or "").strip() or None
    if pora and not re.fullmatch(r"\d{2}:\d{2}", pora):
        pora = None
    # Godzina bez daty nie ma czego przypominać — przypomnienia opierają się
    # na parze (termin, pora), więc sama pora byłaby ustawieniem bez skutku.
    if pora and not termin:
        pora = None

    powtarzaj = dane.get("powtarzaj")
    powtarzaj = powtarzaj if powtarzaj in OKRESY else None
    # Powtarzanie bez terminu nie ma od czego liczyć następnej daty — ta sama
    # zasada co w `task_db.edytuj`.
    if not termin:
        powtarzaj = None
    try:
        co = int(dane.get("powtarzaj_co") or 1)
    except (TypeError, ValueError):
        co = 1

    return {
        "tytul": tytul[:300],
        "termin": termin,
        "pora": pora,
        "powtarzaj": powtarzaj,
        "powtarzaj_co": min(max(co, 1), 99),
        "wykonawca": (dane.get("wykonawca") or "").strip() or None,
        "gdzie": (dane.get("gdzie") or "").strip()[:120] or None,
    }


def zrozum(tekst: str) -> tuple[dict, dict]:
    """Wypowiedziane zdanie → (dane zadania, zużycie tokenów)."""
    tekst = (tekst or "").strip()
    if not tekst:
        raise MowaError("Nie usłyszałem nic do zapisania.")
    if len(tekst) > 500:
        # Dyktowane zadanie to jedno zdanie. Dłuższy tekst znaczy, że ktoś
        # nadyktował notatkę — model i tak zrobiłby z niej jedno zadanie
        # z absurdalnie długim tytułem.
        raise MowaError("To za długie jak na jedno zadanie. Powiedz krócej.")

    client = anthropic.Anthropic(timeout=30.0, max_retries=1)
    try:
        msg = client.messages.create(
            model=MODEL,
            max_tokens=400,
            system=_PROMPT + _dzis_kontekst(),
            messages=[{"role": "user", "content": tekst}],
        )
    except anthropic.APITimeoutError as e:
        raise MowaError("Zrozumienie polecenia trwało zbyt długo. Spróbuj ponownie.") from e
    except anthropic.APIStatusError as e:
        tresc = str(getattr(e, "message", "") or e).lower()
        if "credit balance" in tresc or "billing" in tresc:
            raise MowaError("Skończyły się środki na koncie Anthropic API.") from e
        raise MowaError("Nie udało się zrozumieć polecenia. Spróbuj ponownie.") from e

    dane = _czysc(_wytnij_json(msg.content[0].text))
    usage = {
        "input_tokens": msg.usage.input_tokens,
        "output_tokens": msg.usage.output_tokens,
        "model": MODEL,
    }
    return dane, usage
