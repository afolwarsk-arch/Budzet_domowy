"""Odczyt dokumentacji medycznej — zdjęcie albo PDF → struktura dla bazy.

Osobny plik, bo `ai_processor.py` obsługuje paragony i ma już swoje 900 linii.

DWIE DROGI, JEDEN PROMPT. Claude czyta PDF natywnie (blok `document`), więc
wynik z laboratorium i zdjęcie tego samego wyniku idą tym samym promptem —
różni się wyłącznie typ bloku w wiadomości.

JEDEN DOKUMENT MOŻE MIEĆ WIELE STRON. Wejściem jest lista plików, bo karta
wizyty czy wypis ze szpitala to kilka kartek, a każdą trzeba widzieć razem
z pozostałymi — patrz `czytaj_dokument`.

PDF JEST LEPSZĄ DROGĄ NIŻ ZDJĘCIE i warto do niego zachęcać. Wynik z ALAB-u
czy Diagnostyki ma warstwę tekstową, więc model czyta znaki, a nie piksele.
Znika cała klasa błędów, którą znamy z paragonów: zgubiony przecinek,
`0,05` odczytane jako `0,06`, zjedzony znak `<` przed liczbą. Przy TSH to
różnica między wynikiem a fikcją.
"""

import base64
import json
import re

import anthropic

MODEL = "claude-sonnet-4-6"

# Limity API dla bloku `document`: 32 MB na żądanie, 600 stron. Liczy się
# rozmiar PO zakodowaniu w base64, czyli o jedną trzecią większy niż plik —
# na surowe bajty zostaje z grubsza 20 MB. To limit na CAŁY komplet stron,
# nie na pojedynczy plik. Sprawdzamy go sami, żeby zamiast błędu 413 z API
# dać zrozumiały komunikat.
MAX_RAZEM = 20 * 1024 * 1024

# Wypis ze szpitala miewa kilka stron, ale kilkanaście to już cała teczka
# wrzucona naraz — a każda strona kosztuje tokeny i wydłuża odczyt.
MAX_STRON = 12

OBRAZY = {"image/jpeg", "image/png", "image/webp", "image/gif"}


class OdczytError(ValueError):
    """Nie da się odczytać pliku albo model nie zwrócił poprawnej struktury."""


_PROMPT = """Jesteś asystentem przepisującym polską dokumentację medyczną do bazy danych.

ZASADA NADRZĘDNA: PRZEPISUJESZ, NIE INTERPRETUJESZ.
Nie oceniasz, czy wynik jest dobry czy zły. Nie liczysz norm. Nie tłumaczysz
kodów ICD-10 na słowa. Nie dopisujesz zaleceń, których nie ma na dokumencie.
Jeśli czegoś nie ma — pomijasz pole. Puste pole jest poprawną odpowiedzią,
zmyślone nie jest.

Zwróć WYŁĄCZNIE JSON tej postaci:

{
  "rodzaj": "lab" | "obrazowe" | "wizyta" | "inne",
  "nazwa": "Morfologia krwi obwodowej",
  "data_badania": "2026-08-14",
  "data_do": null,
  "data_pobrania": "2026-08-13",
  "placowka": "ALAB Laboratoria",
  "numer_badania": "12345/26",
  "opis": "...",
  "rozpoznanie": "...",
  "kod_icd10": "E11.9",
  "zalecenia": "...",
  "data_nastepnego": "2026-11-14",
  "kontekst": "22 tydzień ciąży",
  "norma_wg": "WHO 2021",
  "wyniki": [
    {
      "nazwa": "Hemoglobina",
      "wartosc_liczba": 13.4,
      "wartosc_tekst": null,
      "jednostka": "g/dl",
      "operator": null,
      "norma_min": 12.0,
      "norma_max": 16.0,
      "norma_tekst": null,
      "flaga": null,
      "minuta": null,
      "moment": null,
      "strona": null,
      "lokalizacja": null,
      "grupa": null,
      "metoda": null,
      "wartosc_odniesienia": null,
      "komentarz": null
    }
  ]
}

RODZAJ DOKUMENTU:
- "lab" — wynik laboratoryjny z wartościami liczbowymi (morfologia, biochemia,
  hormony, mocz, posiew).
- "obrazowe" — RTG, USG, tomografia, rezonans, mammografia. Tu prawie cała
  treść idzie do "opis", a "wyniki" zwykle zostaje puste. NIE streszczaj opisu
  — przepisz go w całości, bo to jest właściwa treść badania.
- "wizyta" — karta wizyty, wypis ze szpitala, konsultacja. Wywiad i badanie
  przedmiotowe do "opis", rozpoznanie do "rozpoznanie", ICD-10 do "kod_icd10",
  zalecenia do "zalecenia".
- "inne" — cokolwiek innego (skierowanie, zwolnienie, szczepienie).

NAJWAŻNIEJSZE SZCZEGÓŁY:

1. OPERATOR. Gdy wynik ma postać "<0,005" albo ">1000", NIE wpisuj liczby do
   wartosc_liczba razem ze znakiem i NIE gub znaku. Rozdziel:
   operator: "<", wartosc_liczba: 0.005. Poniżej progu czułości metody wartości
   nie da się zmierzyć — da się tylko stwierdzić, że jest mniejsza.

2. NORMA I FLAGA SĄ PRZEPISANE Z DOKUMENTU, NIGDY WYLICZONE. Jeśli laboratorium
   podało zakres "12,0 - 16,0", wpisz norma_min i norma_max. Jeśli podało normę
   opisowo ("ujemny", "nie stwierdza się"), wpisz norma_tekst. Jeśli nie podało
   normy — zostaw puste. NIE licz sam, czy wynik jest poza normą.
   Do "flaga" przepisz DOKŁADNIE to, co jest na dokumencie: "H", "L", "HH",
   "LL", "*", klasa alergiczna "3", centyl "25", kategoria "BI-RADS 2".
   Jeśli nie ma żadnego oznaczenia — zostaw puste.

3. WARTOŚĆ LICZBOWA ALBO TEKSTOWA, NIE OBIE. Hemoglobina to liczba i idzie do
   wartosc_liczba. Posiew ("Escherichia coli"), grupa krwi ("A Rh+"), wynik
   jakościowy ("ujemny") to tekst i idą do wartosc_tekst. Nie próbuj zamieniać
   tekstu na liczbę.

4. KRZYWE (cukrowa, insulinowa). To jedno badanie i kilka pomiarów tego samego
   parametru, rozróżnianych wyłącznie czasem. Każdy pomiar to osobny wpis
   w "wyniki", z tą samą "nazwa" i wypełnioną "minuta": 0, 60, 120.
   Gdy dokument pisze słownie ("na czczo", "po 2h"), przepisz to do "moment"
   i wypełnij "minuta" liczbą, jeśli da się ją jednoznacznie wywnioskować.

5. METODA. Jeśli podana (FEU, DDU, metoda oznaczenia, aparat) — przepisz do
   "metoda". D-dimery w FEU i DDU różnią się dwukrotnie, więc bez tego dwa
   wyniki z różnych laboratoriów są nieporównywalne.

6. KONTEKST. Stan, w którym wykonano badanie, jeśli dokument go podaje:
   tydzień ciąży, doba życia noworodka, dni abstynencji, faza cyklu, "na czczo".
   Idzie do "kontekst" na poziomie dokumentu.

7. STRONA I LOKALIZACJA. Przy badaniach obrazowych i gęstości kości przepisz
   stronę ("lewa", "prawa") i miejsce ("szyjka kości udowej", "kręgosłup L1-L4").

8. GRUPA. Gdy wyniki dzielą się na sekcje — szczep w antybiogramie, panel
   alergenów, układ w badaniu ogólnym moczu — przepisz nagłówek sekcji do
   "grupa" przy każdym wyniku z tej sekcji.

9. WARTOŚĆ NALEŻNA. Spirometria i densytometria podają wynik zmierzony ORAZ
   oczekiwany dla wieku i wzrostu. Zmierzony do wartosc_liczba, oczekiwany do
   wartosc_odniesienia.

10. DATY w formacie RRRR-MM-DD. Jeśli na dokumencie jest tylko data wyniku,
    wpisz ją do data_badania i zostaw data_pobrania puste. Nie zgaduj roku.

DOKUMENT WIELOSTRONICOWY. Gdy dostajesz kilka stron, to JEST JEDEN dokument,
a nie kilka. Zwróć jeden JSON obejmujący całość:
- wyniki ze wszystkich stron w jednej tablicy "wyniki", w kolejności stron;
- nagłówek (nazwa badania, data, placówka, numer) bywa wyłącznie na pierwszej
  stronie — weź go stamtąd i nie zostawiaj pustych pól tylko dlatego, że dalsze
  strony go nie powtarzają;
- żywa pagina, stopka i podpis ("strona 2 z 3", adres laboratorium, dane
  diagnosty) NIE są wynikami;
- gdy tabela urywa się na jednej stronie i ma ciąg dalszy na następnej, wpisz
  każdy parametr RAZ — powtórzony wiersz nagłówkowy tabeli pomiń;
- sekcja z "grupa" potrafi przechodzić przez łamanie strony; przepisz nagłówek
  sekcji także przy wynikach z dalszej strony, choć tam już go nie widać;
- pola prozą ("opis", "zalecenia") sklej w ciągły tekst przez granicę stron,
  razem ze zdaniem przerwanym w połowie.

Kolejność wyników w tablicy musi być taka jak na dokumencie."""


def _blok_pliku(dane: bytes, mime: str) -> dict:
    """Zamienia plik na blok wiadomości — obraz albo dokument PDF."""
    b64 = base64.standard_b64encode(dane).decode("utf-8")
    if mime == "application/pdf":
        return {"type": "document",
                "source": {"type": "base64", "media_type": "application/pdf", "data": b64}}
    return {"type": "image",
            "source": {"type": "base64", "media_type": mime, "data": b64}}


def czytaj_dokument(strony: list[tuple[bytes, str]],
                    podpowiedz: str | None = None) -> tuple[dict, dict]:
    """Strony dokumentacji (zdjęcia albo PDF) → (struktura dokumentu, zużycie tokenów).

    WEJŚCIEM JEST LISTA STRON, BO PAPIER RZADKO MIEŚCI SIĘ NA JEDNEJ KARTCE.
    Karta wizyty czy wypis ze szpitala to dwie–trzy kartki, a rozbicie ich na
    osobne odczyty zniszczyłoby wynik: nazwa badania i data stoją wyłącznie na
    pierwszej stronie, tabela wyników urywa się w połowie, a model oglądający
    samą stronę drugą nie ma jak wiedzieć, czego dotyczy. Dlatego wszystkie
    strony idą w JEDNEJ wiadomości i wracają jako JEDEN dokument.

    PDF zostaje osobnym przypadkiem — jego wielostronicowość obsługuje samo API,
    więc trzystronicowy wynik z laboratorium to nadal jeden element listy.
    """
    if not strony:
        raise OdczytError("Nie wybrano pliku.")
    if len(strony) > MAX_STRON:
        raise OdczytError(f"Naraz czytam najwyżej {MAX_STRON} stron, "
                          f"a dostałem {len(strony)}. Podziel dokument na mniejsze części.")

    gotowe = []
    razem = 0
    for i, (dane, mime) in enumerate(strony, 1):
        if not dane:
            raise OdczytError(f"Strona {i} jest pusta." if len(strony) > 1 else "Pusty plik.")
        razem += len(dane)
        mime = (mime or "").lower().split(";")[0].strip()
        if mime not in OBRAZY and mime != "application/pdf":
            raise OdczytError(f"Nieobsługiwany typ pliku: {mime or 'nieznany'}. "
                              "Przyjmujemy PDF oraz zdjęcia JPG, PNG i WEBP.")
        gotowe.append((dane, mime))

    if razem > MAX_RAZEM:
        ile = "Plik ma" if len(gotowe) == 1 else f"{len(gotowe)} stron waży razem"
        raise OdczytError(f"{ile} {razem // (1024 * 1024)} MB, a maksimum to "
                          f"{MAX_RAZEM // (1024 * 1024)} MB na jeden odczyt.")

    # Etykieta przed każdą stroną, bo bez niej model dostaje ciąg obrazów bez
    # informacji, że to kolejność — a od kolejności zależy sklejenie urwanej
    # tabeli i przypisanie nagłówka z pierwszej kartki do reszty.
    tresc = []
    wiele = len(gotowe) > 1
    for i, (dane, mime) in enumerate(gotowe, 1):
        if wiele:
            rzecz = "PDF" if mime == "application/pdf" else "Strona"
            tresc.append({"type": "text", "text": f"{rzecz} {i} z {len(gotowe)}:"})
        tresc.append(_blok_pliku(dane, mime))

    polecenie = ("Przepisz ten dokument i zwróć JSON." if not wiele else
                 f"To jeden dokument złożony z {len(gotowe)} części pokazanych wyżej "
                 "w kolejności. Przepisz go w całości i zwróć JEDEN JSON.")
    if podpowiedz:
        # Podpowiedź użytkownika („to wynik Zosi", „badanie z maja") bywa
        # jedyną drogą do informacji, której na papierze nie ma.
        polecenie += f"\n\nDodatkowa informacja od użytkownika: {podpowiedz}"
    tresc.append({"type": "text", "text": polecenie})

    client = anthropic.Anthropic()
    msg = client.messages.create(
        model=MODEL,
        max_tokens=8000,
        system=_PROMPT,
        messages=[{"role": "user", "content": tresc}],
    )
    return _parsuj(msg.content[0].text), _usage(msg)


def _parsuj(surowy: str) -> dict:
    txt = re.sub(r"```(?:json)?|```", "", surowy or "").strip()
    try:
        dane = json.loads(txt)
    except json.JSONDecodeError as e:
        raise OdczytError(f"Model nie zwrócił poprawnego JSON-a: {e}") from e
    if not isinstance(dane, dict):
        raise OdczytError("Model zwrócił coś innego niż opis dokumentu.")

    dane["wyniki"] = [_czysc_wynik(w) for w in (dane.get("wyniki") or [])
                      if isinstance(w, dict) and (w.get("nazwa") or "").strip()]
    if not (dane.get("nazwa") or "").strip():
        dane["nazwa"] = "Badanie"
    if dane.get("rodzaj") not in ("lab", "obrazowe", "wizyta", "inne"):
        dane["rodzaj"] = "lab"
    return dane


def _czysc_wynik(w: dict) -> dict:
    """Sprowadza jeden wynik do postaci, którą przyjmuje baza.

    Model bywa uczynny i wpisuje '<0,005' do pola liczbowego mimo instrukcji —
    wtedy ratujemy znak zamiast tracić cały wynik.
    """
    out = dict(w)
    surowa = out.get("wartosc_liczba")
    if isinstance(surowa, str):
        tekst = surowa.strip().replace(",", ".")
        m = re.match(r"^(<=|>=|<|>)?\s*(-?\d+(?:\.\d+)?)$", tekst)
        if m:
            if m.group(1) and not out.get("operator"):
                out["operator"] = m.group(1)
            out["wartosc_liczba"] = float(m.group(2))
        else:
            # Nie liczba — przenosimy do pola tekstowego, żeby nie przepadła.
            out["wartosc_liczba"] = None
            if not out.get("wartosc_tekst"):
                out["wartosc_tekst"] = surowa.strip()

    for pole in ("norma_min", "norma_max", "wartosc_odniesienia"):
        v = out.get(pole)
        if isinstance(v, str):
            v = v.strip().replace(",", ".")
            out[pole] = float(v) if re.match(r"^-?\d+(\.\d+)?$", v) else None

    if out.get("operator") not in ("<", ">", "<=", ">="):
        out["operator"] = None
    if isinstance(out.get("minuta"), str):
        m = re.search(r"\d+", out["minuta"])
        out["minuta"] = int(m.group()) if m else None
    # Flaga zostaje TEKSTEM, jaki jest na dokumencie — H, LL, "3", "BI-RADS 2".
    if out.get("flaga") is not None:
        out["flaga"] = str(out["flaga"]).strip() or None
    return out


def _usage(msg) -> dict:
    u = getattr(msg, "usage", None)
    return {
        "input_tokens": getattr(u, "input_tokens", 0) or 0,
        "output_tokens": getattr(u, "output_tokens", 0) or 0,
        "model": MODEL,
    }
