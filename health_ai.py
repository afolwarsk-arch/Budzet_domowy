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

ZWRÓĆ WYŁĄCZNIE JSON — jeden obiekt, bez ani jednego słowa przed nim i po nim,
bez tablicy na wierzchu, bez komentarzy. Odpowiedź jest czytana przez program,
nie przez człowieka: każde zdanie wstępu psuje odczyt.

Jeśli dostajesz kilka stron i widzisz, że pochodzą z RÓŻNYCH dokumentów (inne
daty, inni lekarze, inne badania), NIE łącz ich i NIE zwracaj tablicy. Zwróć
obiekt opisujący pierwszy dokument i dodaj do niego pole "rozne_dokumenty": true.
Program pokaże wtedy użytkownikowi, żeby wgrał je osobno.

CUDZYSŁOWY: wewnątrz tekstu NIE UŻYWAJ prostego cudzysłowa ("). Jeśli dokument
zawiera cytat albo wyrażenie w cudzysłowie, zapisz go polskimi cudzysłowami
drukarskimi: „tak”. Prosty cudzysłów kończy łańcuch w JSON-ie i rozbija całą
odpowiedź w połowie zdania — zdarzyło się to na zdaniu „częste »strzały bólowe«
języka". Nie wstawiaj też surowych znaków nowej linii — użyj \\n.

JSON ma mieć tę postać:

{
  "rodzaj": "lab" | "obrazowe" | "wizyta" | "skierowanie" | "recepta" | "inne",
  "nazwa": "Morfologia krwi obwodowej",
  "data_badania": "2026-08-14",
  "data_do": null,
  "data_pobrania": "2026-08-13",
  "placowka": "ALAB Laboratoria",
  "kod_eskierowania": "2885",
  "wazne_do": null,
  "tryb": null,
  "specjalizacja": "stomatolog",
  "lekarz": "dr n. med. Anna Kowalska",
  "forma": "stacjonarna",
  "numer_badania": "12345/26",
  "opis": "...",
  "wywiad": "...",
  "badanie": "...",
  "pouczenia": "...",
  "rozpoznanie": "...",
  "kod_icd10": "E11.9",
  "zalecenia": "...",
  "leki": [
    {
      "nazwa": "Pregabalin Accord",
      "dawka": "25 mg",
      "dawkowanie": "1 x 2 kaps. wieczorem",
      "odplatnosc": "100%"
    }
  ],
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
- "wizyta" — karta wizyty, wypis ze szpitala, konsultacja. Treść rozdziel na
  osobne pola — patrz „ROZBICIE WIZYTY" niżej. Pola "opis" przy wizycie NIE
  wypełniaj.
- "skierowanie" — skierowanie do poradni, na badanie, do szpitala albo na
  rehabilitację. Opisuje coś, co ma się DOPIERO wydarzyć, więc wypełnij:
  "specjalizacja" (dokąd kieruje: "neurolog", "rezonans magnetyczny",
  "rehabilitacja"), "kod_eskierowania" (czterocyfrowy kod, z którym rejestruje
  się wizytę — NIE mylić z kilkudziesięciocyfrowym kluczem), "wazne_do" (termin
  ważności, jeśli podany), "tryb" ("pilny" albo "stabilny", jeśli zaznaczony),
  "lekarz" (kto skierował), "rozpoznanie" i "kod_icd10" (powód skierowania).
  Data wystawienia idzie do "data_badania". Wyniki zostają puste — skierowanie
  niczego nie mierzy.
- "recepta" — recepta albo wydruk informacyjny e-recepty. Sercem dokumentu są
  LEKI: wypisz każdy do tablicy "leki". Poza tym wypełnij "kod_eskierowania"
  (czterocyfrowy kod dostępowy, którym wykupuje się lek w aptece — to samo pole
  co przy skierowaniu, bo rola jest ta sama), "wazne_do" (termin realizacji,
  jeśli podany — recepta zwykle traci ważność po 30 dniach, antybiotyk po 7),
  "lekarz" (kto wystawił) i "data_badania" (data wystawienia). Wyniki zostają
  puste. Jeśli na dokumencie jest też rozpoznanie, przepisz je normalnie.
- "inne" — cokolwiek innego (zwolnienie, szczepienie, zaświadczenie).

ROZBICIE WIZYTY NA CZĘŚCI. Karta wizyty sama podaje ten podział nagłówkami —
idź za nimi, nie sklejaj wszystkiego w jedno pole:
- "wywiad" — co powiedział pacjent i co lekarz o nim odnotował (sekcja „Wywiad
  lekarski"): objawy, od kiedy trwają, choroby przewlekłe, alergie, przyjmowane
  leki. To jest właściwa treść wizyty.
- "badanie" — sekcja „Badanie przedmiotowe": co lekarz stwierdził badając.
  Przy teleporadzie bywa to samo zdanie o braku możliwości zbadania — przepisz je,
  bo brak badania jest informacją.
- "pouczenia" — STANDARDOWE FORMUŁY, które wyglądają tak samo na każdym takim
  dokumencie: co robić przy pogorszeniu, numer 112, SOR, izba przyjęć,
  informacje o ograniczeniach teleporady, o możliwości wizyty stacjonarnej,
  potwierdzenia weryfikacji tożsamości i PESEL-u. Wrzuć je TUTAJ, nie do wywiadu.
  Powód jest praktyczny: w jednej konsultacji realna medycyna to cztery linijki,
  a te formuły potrafią zająć trzy czwarte tekstu i całkowicie ją przykryć.
  Nie skracaj ich i nie streszczaj — po prostu trzymaj osobno.

LEKI wypisz do tablicy "leki", każdy osobno, a nie w prozie zaleceń.
Dla każdego: "nazwa" (sama nazwa preparatu, bez „Rp."), "dawka" (moc, np. „25 mg”),
"dawkowanie" (jak brać, np. „1 x 2 kaps. wieczorem"), "odplatnosc" jeśli podana.
Bierz zarówno leki z recepty, jak i te zalecane bez recepty, jeśli są wymienione
z nazwy. Powód: „co pan przyjmuje?" to pytanie padające przy każdej kolejnej
wizycie, a odpowiedź wyciągnięta z prozy wymaga czytania całej karty.

CZEGO NIE PRZEPISYWAĆ: klucza recepty (kilkudziesięciocyfrowy ciąg przy leku)
ani identyfikatorów dokumentu w postaci „ID 2.16.840...". To jednorazowe kody
techniczne, po tygodniu bezużyteczne, a zaśmiecają zalecenia. Czterocyfrowy
kod dostępowy eRecepty zostaw — z nim wykupuje się lek.

ROZPOZNANIE bez kodu: do "rozpoznanie" wpisz sam opis („Zaburzenia nerwu
trójdzielnego"), a kod do "kod_icd10" („G50"). Nie powtarzaj kodu w obu polach.

PRZY WIZYCIE WYPEŁNIJ TAKŻE:
- "specjalizacja" — jakim specjalistą jest lekarz albo czego dotyczy poradnia:
  "stomatolog", "neurolog", "dermatolog", "internista". Szukaj W TEJ KOLEJNOŚCI:
    1. pieczątka lekarza — pole „Specjalizacje" przy nazwisku;
    2. rodzaj działalności poradni — „Poradnia chorób wewnętrznych" daje
       "internista", „Poradnia neurologiczna" daje "neurolog";
    3. nazwa miejsca wystawienia, jeśli mówi o dziedzinie.
  UWAGA NA PUSTĄ PIECZĄTKĘ: jeśli w polu „Specjalizacje" stoi samo „Lekarz",
  to znaczy, że specjalizacji NIE PODANO — nie zapisuj wtedy "lekarz", tylko
  zejdź do punktu 2. „Lekarz" w tym polu jest niczym.
  Zapisz małą literą, w mianowniku, jako nazwę specjalisty a nie poradni
  ("neurolog", nie "poradnia neurologiczna"). Nie zgaduj po treści wizyty —
  jeśli żaden z trzech punktów nic nie daje, zostaw puste.
- "lekarz" — imię i nazwisko razem z tytułem, tak jak na pieczątce.
- "forma" — "zdalna", jeśli dokument mówi o teleporadzie, telekonsultacji albo
  poradzie na odległość; "stacjonarna", jeśli wprost pisze o wizycie w gabinecie
  albo osobistej. Gdy nie ma o tym ani słowa, zostaw puste — teleporada bywa
  nieoznaczona, ale zgadywanie zrobiłoby z braku informacji fałszywą pewność.

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

    client = anthropic.Anthropic(timeout=_limit_czasu(len(gotowe)), max_retries=1)
    try:
        msg = _zapytaj(client, tresc)
    except anthropic.APITimeoutError as e:
        raise OdczytError(
            "Odczyt trwał zbyt długo i został przerwany. Dokument nie został "
            "nigdzie zapisany. Spróbuj ponownie — a jeśli wgrywasz kilka stron "
            "naraz, podziel je na mniejsze porcje.") from e
    except anthropic.APIStatusError as e:
        raise OdczytError(_komunikat_api(e)) from e
    if getattr(msg, "stop_reason", None) == "max_tokens":
        raise OdczytError(
            "Dokument jest za długi, żeby przepisać go w całości. Wgraj go "
            "w mniejszych częściach — na przykład osobno wyniki i osobno opis.")
    return _parsuj(msg.content[0].text), _usage(msg)


def _limit_czasu(ile_stron: int) -> float:
    """Ile sekund czekamy na model, zanim uznamy odczyt za przepadły.

    POWÓD JEST PO STRONIE PRZEGLĄDARKI, NIE MODELU. Bez limitu biblioteka
    czeka domyślnie dziesięć minut i po cichu ponawia żądanie, gdy API jest
    przeciążone. Proxy zrywa wtedy połączenie na długo przedtem, a użytkownik
    dostaje gołe „Failed to fetch" — bo serwer nie zdążył powiedzieć niczego.
    Lepiej odpuścić wcześniej i odpowiedzieć zdaniem, które coś znaczy.

    Zmierzone na jednostronicowym zdjęciu 2,92 MB: 18 s. Zapas jest spory,
    bo czas rośnie z liczbą stron — model przepisuje je w jednym przebiegu.
    `max_retries=1` zamiast domyślnych dwóch: przy trzech podejściach nawet
    krótki limit sumuje się do minut.
    """
    return min(45 + 25 * ile_stron, 240)


def _komunikat_api(e) -> str:
    """Zamienia błąd API na zdanie po polsku.

    SUROWA ODPOWIEDŹ API NIE MA PRAWA TRAFIĆ NA EKRAN. Użytkownik zobaczył
    kiedyś „Error code: 400 - {'type': 'error', 'error': {...}}" i nie miał
    z tego żadnej informacji — a chodziło po prostu o wyczerpane środki.
    """
    tresc = str(getattr(e, "message", "") or e).lower()
    if "credit balance" in tresc or "billing" in tresc:
        return ("Skończyły się środki na koncie Anthropic API — odczyt dokumentów "
                "jest chwilowo niemożliwy. Doładuj konto w Plans & Billing na "
                "console.anthropic.com. To osobny portfel niż subskrypcja Claude.")
    if getattr(e, "status_code", None) == 429:
        return ("Za dużo zapytań naraz — odczekaj chwilę i spróbuj ponownie.")
    if getattr(e, "status_code", 0) >= 500:
        return ("Usługa odczytu chwilowo nie odpowiada. Spróbuj za kilka minut — "
                "plik nie został nigdzie zapisany.")
    return "Nie udało się odczytać dokumentu. Spróbuj ponownie."


def _zapytaj(client, tresc):
    return client.messages.create(
        model=MODEL,
        # 16000, nie 8000: przy dokumencie wielostronicowym doszły wywiad,
        # badanie, pouczenia i lista leków. Ucięta odpowiedź kończy się urwanym
        # JSON-em, a błąd składni w niczym nie przypomina prawdziwej przyczyny.
        max_tokens=16000,
        system=_PROMPT,
        messages=[{"role": "user", "content": tresc}],
    )


def _wytnij_json(txt: str):
    """Wyłuskuje pierwszą kompletną strukturę JSON z odpowiedzi modelu.

    NIE ZAKŁADAMY, ŻE ODPOWIEDŹ JEST GOŁYM JSON-em. Model bywa uczynny i pisze
    zdanie wstępu („Mam dwa osobne dokumenty, zwrócę tablicę…"), zwłaszcza gdy
    dostanie strony, które do siebie nie pasują. Zdarzyło się to na produkcji
    i wywalało odczyt komunikatem o błędzie składni, który niczego nie tłumaczył.

    Liczymy nawiasy z uwzględnieniem łańcuchów znakowych — inaczej klamra
    w środku opisu badania przerwałaby zliczanie w połowie.
    """
    start = None
    for i, z in enumerate(txt):
        if z in "{[":
            start = i
            break
    if start is None:
        return None
    otwarcie = txt[start]
    zamkniecie = "}" if otwarcie == "{" else "]"
    glebokosc = 0
    w_lancuchu = False
    ucieczka = False
    for i in range(start, len(txt)):
        z = txt[i]
        if w_lancuchu:
            if ucieczka:
                ucieczka = False
            elif z == "\\":
                ucieczka = True
            elif z == '"':
                w_lancuchu = False
            continue
        if z == '"':
            w_lancuchu = True
        elif z == otwarcie:
            glebokosc += 1
        elif z == zamkniecie:
            glebokosc -= 1
            if glebokosc == 0:
                return txt[start:i + 1]
    return txt[start:]          # niedomknięte — niech zdecyduje parser


def _napraw_cudzyslowy(txt: str) -> str:
    """Escapuje cudzysłowy, które są TREŚCIĄ, a nie końcem łańcucha.

    NAJCZĘSTSZA PRZYCZYNA POPSUTEJ ODPOWIEDZI. Dokumentacja medyczna cytuje
    słowa pacjenta („częste »strzały bólowe« języka"), a model potrafi otworzyć
    cytat polskim cudzysłowem i zamknąć prostym. Prosty kończy łańcuch w JSON-ie
    i cała struktura urywa się w połowie zdania.

    Rozstrzygamy po tym, co następuje PO cudzysłowie: jeśli pierwszy niebiały
    znak to `,` `}` `]` albo `:`, to był koniec łańcucha; cokolwiek innego znaczy,
    że cudzysłów należy do tekstu i trzeba go zabezpieczyć. Poprawny JSON
    przechodzi przez tę funkcję bez zmian.
    """
    wynik = []
    w_lancuchu = False
    ucieczka = False
    for i, z in enumerate(txt):
        if not w_lancuchu:
            wynik.append(z)
            if z == '"':
                w_lancuchu = True
            continue
        if ucieczka:
            wynik.append(z)
            ucieczka = False
            continue
        if z == "\\":
            wynik.append(z)
            ucieczka = True
            continue
        if z == '"':
            dalej = txt[i + 1:i + 40].lstrip()
            if dalej[:1] in (",", "}", "]", ":", ""):
                w_lancuchu = False
                wynik.append(z)
            else:
                wynik.append('\\"')      # cudzysłów w treści — zabezpieczamy
            continue
        wynik.append(z)
    return "".join(wynik)


def _parsuj(surowy: str) -> dict:
    txt = re.sub(r"```(?:json)?|```", "", surowy or "").strip()
    wyciety = _wytnij_json(txt) or txt
    try:
        dane = json.loads(wyciety)
    except json.JSONDecodeError:
        # Druga szansa: najczęstsza usterka to niezaescapowany cudzysłów
        # w cytacie z dokumentu. Naprawiamy i próbujemy jeszcze raz, zamiast
        # kazać użytkownikowi wgrywać wszystko od nowa i płacić za drugi odczyt.
        try:
            dane = json.loads(_napraw_cudzyslowy(wyciety))
            print("[health_ai] JSON naprawiony — cudzyslow w tresci dokumentu")
        except json.JSONDecodeError as e:
            # Do logów idzie surowa odpowiedź, bo bez niej takiego błędu nie da
            # się zdiagnozować po fakcie — użytkownik widzi tylko komunikat.
            print(f"[health_ai] niepoprawny JSON ({e}); odpowiedz modelu:\n{txt[:4000]}")
            raise OdczytError(
                "Nie udało się odczytać dokumentu — odpowiedź modelu była uszkodzona. "
                "Spróbuj jeszcze raz; jeśli wgrywasz kilka stron, sprawdź, czy wszystkie "
                "należą do tego samego badania.") from e

    # Tablica znaczy, że model uznał strony za ODRĘBNE dokumenty. Nie sklejamy
    # ich na siłę: dwie wizyty z różnych dni scalone w jeden wpis to gorsza
    # szkoda niż odmowa — w dokumentacji medycznej data i lekarz muszą się zgadzać.
    if isinstance(dane, list):
        raise OdczytError(
            "To wyglądają na kilka RÓŻNYCH dokumentów, a nie kolejne strony jednego. "
            "Wgraj każdy osobno.")
    if not isinstance(dane, dict):
        raise OdczytError("Model zwrócił coś innego niż opis dokumentu.")
    if dane.get("rozne_dokumenty"):
        raise OdczytError(
            "To wyglądają na kilka RÓŻNYCH dokumentów, a nie kolejne strony jednego. "
            "Wgraj każdy osobno.")

    dane["wyniki"] = [_czysc_wynik(w) for w in (dane.get("wyniki") or [])
                      if isinstance(w, dict) and (w.get("nazwa") or "").strip()]
    # Lek bez nazwy to nie lek, tylko resztka po nieudanym odczycie.
    dane["leki"] = [{k: (str(v).strip() if isinstance(v, str) else v)
                     for k, v in l.items() if k in ("nazwa", "dawka", "dawkowanie", "odplatnosc")}
                    for l in (dane.get("leki") or [])
                    if isinstance(l, dict) and (l.get("nazwa") or "").strip()]
    if not (dane.get("nazwa") or "").strip():
        dane["nazwa"] = "Badanie"
    if dane.get("rodzaj") not in ("lab", "obrazowe", "wizyta", "skierowanie", "recepta", "inne"):
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
