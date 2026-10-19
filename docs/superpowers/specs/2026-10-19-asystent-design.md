# Asystent wiem — specyfikacja etapu 1

Data: 2026-10-19 · Status: **ZATWIERDZONA przez Adama 2026-10-19** (po 3 recenzjach) · Makiety: https://claude.ai/artifact/QEzy79QwsTa2TmwuT1W7wH

## Cel

Jeden asystent (tekst + głos), który spina moduły aplikacji. Dwa zyski, w tej kolejności:

1. **Szybkość** — codzienne czynności jednym zdaniem zamiast kilku ekranów.
2. **Jedno wejście** — użytkownik nie musi pamiętać, w którym module coś leży.

Tryb pracy: **„zrób za mnie"** z dopytywaniem, gdy w poleceniu czegoś brakuje lub coś jest niejednoznaczne (nie „dla pewności").
Prowadzenie po ekranie (podświetlanie pól na stronie) — **odłożone**, poza etapem 1.

## Decyzje użytkownika (nie otwierać ponownie)

| Temat | Decyzja |
|---|---|
| Kto korzysta | tylko konto Adama (pilotaż) |
| Wywołanie | okrągły przycisk na stałe przy prawej krawędzi dolnego paska, wystający ponad pasek (telefon; wariant a2) / przycisk w górnym pasku (komputer) + skrót PWA „Asystent" (Android) |
| Zapis | drobiazgi od razu z „Cofnij"; poważniejsze — karta do potwierdzenia; asystent nie proponuje usuwania |
| Kto zapisuje | **model tylko proponuje, zapisuje przeglądarka** istniejącymi endpointami |
| Skan kodu kreskowego | w etapie 1, dla jedzenia |

## Zakres etapu 1

| Polecenie | Zachowanie | Endpoint (istniejący) |
|---|---|---|
| Dopisz do listy zakupów | od razu + „Cofnij" (limity — R2) | `POST /api/listy/{id}/pozycje` `{nazwa}`; cofnięcie `DELETE /api/pozycje/{id}` |
| Odhacz pozycję z listy | od razu + „Cofnij" | `PATCH /api/pozycje/{id}` `{kupione}` (cofnięcie: odwrotna wartość) |
| Przejdź do widoku (z filtrami) | od razu | nawigacja, bez zapisu |
| Paragon | karta z przyciskiem „Otwórz aparat" w oknie asystenta → obecny proces `/upload?zdjecie=1` (zdjęcie przez istniejący mechanizm IndexedDB z `auth.js`) | istniejący proces paragonu |
| Jedzenie — jeden produkt | karta do potwierdzenia | `POST /api/eat/wpis` (z `produkt_id`, gdy jest w bazie) |
| Jedzenie — posiłek z kilku produktów | **jedna** karta z listą pozycji (gramatura edytowalna, pozycję można usunąć z karty), jeden „Zapisz" | `POST /api/eat/wpisy/grupa` — **wymaga zmiany endpointu, patrz Z1** |
| Jedzenie — skan kodu | podgląd aparatu w oknie asystenta (`eat-skaner.js`) → karta: produkt + porcje → „Zapisz" | odczyt `GET /api/eat/produkt?kod=`, zapis `POST /api/eat/wpis` z `produkt_id` |
| Nowe zadanie (termin, projekt) | karta do potwierdzenia | `POST /api/task/zadania` |
| Odhacz zadanie — zwykłe | od razu + „Cofnij" | `PATCH /api/task/zadania/{id}/status` `{zrobione, kaskada:false}` |
| Odhacz zadanie — powtarzalne, wstrzymane albo z podzadaniami | **karta do potwierdzenia, bez „Cofnij"** (patrz R7) | jw. |

**Poza zakresem:** pieniądze (wydatki bez paragonu, przelewy, koperty, limity); health; waga; prowadzenie po ekranie; inni domownicy jako użytkownicy asystenta; czynności wielomodułowe w jednym poleceniu; skan przy liście zakupów.

**„Usuwania brak" — doprecyzowanie:** asystent nigdy nie proponuje usunięcia. Jedynym `DELETE` jest „Cofnij" świeżo dopisanej pozycji listy — zawsze inicjowane stuknięciem użytkownika i tylko dla id, które ta sama karta właśnie utworzyła.

## Zmiany w istniejącym kodzie (Adam zgodził się na Z1–Z4, 2026-10-19)

- **Z1. `POST /api/eat/wpisy/grupa`:** (a) przyjmuje opcjonalne `produkt_id` per pozycja i wtedy przelicza wartości z produktu jak `/wpis`; (b) waliduje wszystkie pozycje **przed** zapisem i zapisuje w jednej transakcji. Dziś pętla robi osobną transakcję na pozycję — błąd w 3. pozycji zostawia 1–2 w bazie (to istniejący błąd, dotyczy też dzisiejszego eat). Zmiana jest zgodna wstecz.
- **Z2. Dopasowanie miejsca i wykonawcy zadań** (`_dopasuj_miejsce`, `_dopasuj_wykonawce` z `task.py`) wydzielone do osobnego modułu bez routera, żeby asystent nie importował `task.py` (a z nim funkcji zapisu).
- **Z3. `database._MODUL_SQL`** — nowa gałąź: przedrostek `asystent-` → moduł `'asystent'`, żeby koszty nie lądowały w „finance".
- **Z1c.** Błąd walidacji w `/wpisy/grupa` zwraca indeks pozycji (`{"detail": "…", "pozycja": 2}`), żeby karta wskazała, która pozycja zawiodła.
- **Z4 (zgoda Adama 2026-10-19).** `task_ai.zrozum` przyjmuje opcjonalną datę „dziś" (dziś liczy ją w UTC — „jutro" powiedziane między 0:00 a 2:00 da zły dzień). Domyślnie bez zmian dla obecnych wywołań.

## Jedzenie — szczegóły

- Pora posiłku z **lokalnej godziny przeglądarki** (przesyłanej w żądaniu, strefa Europe/Warsaw) — Railway działa w UTC. Pokazana na karcie i zmienialna; podana w zdaniu ma pierwszeństwo.
- „Zjadłem posiłek z kilku produktów" bez wymienienia ich → pytanie „Co było w posiłku?", dopiero potem karta.
- Pozycja dopasowana do bazy produktów → kalorie liczy serwer z produktu (po Z1 także w posiłku wieloskładnikowym). Pozycja bez dopasowania → **szacunek modelu** (`szacuj_posilek`), oznaczony na karcie jako szacunek; serwer i tak sprawdza zakresy (`_sprawdz_wartosci`).
- Pozycja na karcie, która nie przejdzie walidacji → karta pokazuje błąd przy tej pozycji, nic nie jest zapisane (dzięki Z1b); użytkownik poprawia lub usuwa pozycję i zapisuje ponownie.
- **Skan kodu:** rozpoznaje przeglądarka (`BarcodeDetector`), wyszukuje istniejący endpoint; model uczestniczy tylko, gdy porcja jest powiedziana. Tylko Chrome/Android — na iPhonie ikona skanu się nie pokazuje (podobnie mikrofon: Web Speech nie działa na iOS w PWA; tam zostaje pole tekstowe). Kod nieznany → propozycja zdjęcia etykiety (istniejąca ścieżka eat). `GET /api/eat/produkt` przy trafieniu w Open Food Facts **zapisuje** produkt do bazy gospodarstwa — to efekt uboczny istniejącego endpointu, wołanego przez przeglądarkę po skanie użytkownika, nie przez model.

## Architektura

```
[okno asystenta] --tekst + lokalny czas--> POST /api/asystent --(narzędzia)--> model
       ^                          |   ODCZYTOWE: wykonuje serwer (gospodarstwo z sesji)
       |                          |   PROPOZYCJE: serwer ich NIE wykonuje, tylko waliduje
       +------ propozycje / pytanie / komunikat ------+
[karta] --„Zapisz" / od razu--> istniejący endpoint modułu (ten sam co formularz)
```

### Jednostki

- **`asystent.py`** (router `/api/asystent`) — przyjmuje tekst, lokalny czas i krótką historię bieżącej rozmowy; prowadzi pętlę narzędzi (**maks. 4 iteracje**); zwraca `{wiadomosc, propozycje[], pytanie?}`. Jedyne zapisy do bazy, jakie wykonuje: `api_usage` (koszty) i `asystent_log`.
- **`asystent_narzedzia.py`** — definicje narzędzi:
  - odczytowe: `szukaj_produktu_eat`, `listy_zakupow` (z pozycjami), `drzewo_zadan`, `szukaj_zadania`. Każde bierze `household_id`/`user_id` z sesji, nigdy z argumentów modelu.
  - propozycje: `zaproponuj_pozycje_listy`, `zaproponuj_odhaczenie_listy`, `zaproponuj_wpis_jedzenia` (jedna lub wiele pozycji), `zaproponuj_skan`, `zaproponuj_zadanie`, `zaproponuj_odhaczenie_zadania`, `otworz_widok`, `otworz_aparat`, `zapytaj` (pytanie z 2–4 opcjami). Serwer waliduje każdą propozycję (typy, zakresy, id należące do gospodarstwa, widok z białej listy) i **sam ustala, czy jest „od razu" czy „karta"** (R2, R7) — model o tym nie decyduje.
- **Ponowne użycie parserów:** `task_ai.zrozum` i `ai_processor.szacuj_posilek` wołane jako funkcje (nie przez endpointy), koszt logowany jako `asystent-task` / `asystent-eat`.
- **`static/asystent.js` + style** — okno (arkusz), mikrofon (`dyktowanie.js`), skaner (`eat-skaner.js`), karty, zapis przez istniejące endpointy, „Cofnij" (widoczne 8 s). Własna klasa ukrywania pola pliku (`.schowane` nie jest globalna). Wstrzykiwany z `auth.js` jak dolny pasek; przycisk tylko dla konta z białej listy.
- **Tabela `asystent_log`** — `id, household_id, user_id, created_at, polecenie, propozycje (jsonb), wynik` (`zapisano` / `odrzucono` / `cofnieto` / `blad`). Wynik dopisuje przeglądarka przez `POST /api/asystent/log/{id}` — endpoint sprawdza, że wpis należy do bieżącego użytkownika. Klucze obce z `ON DELETE CASCADE`. Retencja 90 dni: codzienne zadanie w istniejącym schedulerze (APScheduler w `main.py`) kasuje starsze wpisy. Pole `wynik` pochodzi z przeglądarki — służy do pomiaru trafności, nie do kontroli bezpieczeństwa.

### Kontrakty

**Żądanie** `POST /api/asystent`:
```json
{ "tekst": "…", "historia": [{"kto":"user|asystent","tekst":"…"}],   // ≤ 6 wymian
  "teraz": "2026-10-19T08:15:00+02:00",                              // lokalny czas przeglądarki
  "lista_domyslna_id": 12 }                                          // z localStorage `listaSel`, opcjonalne
```

**Odpowiedź:**
```json
{ "log_id": 345, "wiadomosc": "…",
  "pytanie": {"tekst": "Do którego projektu?", "opcje": ["Dom","Praca","Bez projektu"]},   // opcjonalne
  "propozycje": [ {"typ": "…", "tryb": "od_razu|karta", "opis": "tekst na karcie", "dane": {…}} ] }
```
`tryb` ustala serwer (R2, R7), nie model.

**Typy propozycji (`dane`):**

| `typ` | `dane` | Co robi przeglądarka |
|---|---|---|
| `lista_dopisz` | `{lista_id, lista_nazwa, nazwy: [≤10]}` | **jedna akcja**: kolejne `POST /api/listy/{id}/pozycje` `{nazwa}`; zapamiętuje zwrócone `id`; częściowa porażka → toast z nazwami, które nie weszły; „Cofnij" = `DELETE` wszystkich utworzonych `id` |
| `lista_odhacz` | `{pozycja_id, nazwa, kupione_przed, kupione_po}` | `PATCH /api/pozycje/{id}` `{kupione: kupione_po}`; „Cofnij" = `{kupione: kupione_przed}` |
| `jedzenie` | `{data, posilek, nazwa_grupy?, pozycje: [{nazwa, produkt_id?, ilosc_g, opis_porcji?, kcal?, bialko?, tluszcz?, wegle?, szacunek: bool}]}` | 1 pozycja → `POST /api/eat/wpis`; więcej → `POST /api/eat/wpisy/grupa` (po Z1) |
| `skan` | `{data, posilek}` | otwiera skaner w oknie; po kodzie `GET /api/eat/produkt?kod=` → karta `jedzenie` z porcjami produktu |
| `zadanie` | body `POST /api/task/zadania` (`tytul, termin, pora, parent_id, strefa_id, wykonawca_user_id, wykonawca_virtual_id`) + `miejsce_opis` | `POST /api/task/zadania` |
| `zadanie_odhacz` | `{zadanie_id, tytul, zrobione_przed, uwaga?}` | `PATCH …/status` `{zrobione: true, kaskada: false}`; „Cofnij" (tylko tryb `od_razu`) = `{zrobione: zrobione_przed, kaskada: false}` |
| `widok` | `{widok: <enum>, filtry: {month?, osoba?, …}}` | buduje adres z białej listy, nawiguje |
| `aparat` | `{}` | pokazuje przycisk „Otwórz aparat" (`<label for>`) → `zapiszZdjecieDoPrzekazania` → `/upload?zdjecie=1` |

Każdy zapis karty ustawia `data` z lokalnej daty przeglądarki (endpointy domyślnie biorą `date.today()` serwera = UTC).

**Przepływ parserów:** model nie woła parserów. Model wywołuje `zaproponuj_zadanie(opis)` / `zaproponuj_wpis_jedzenia(pozycje: [{nazwa, ilosc?}])`; **handler narzędzia** woła `task_ai.zrozum(opis, dzis=<lokalna data>)` + dopasowanie miejsca/wykonawcy (jak `/api/task/rozumiem`) albo szuka każdej nazwy w bazie produktów i dla niedopasowanych woła `szacuj_posilek`. Wynik handlera wraca do modelu i staje się propozycją.

**Front — wstrzyknięcie:** `/api/me` zwraca `asystent: true` dla konta z białej listy. Przycisk asystenta dokładany **po** odpowiedzi `me` (jak dziś „Admin"), **poza** przewijanym pasem stron modułu, przy prawej krawędzi, wystający ponad pasek (wariant a2); przewijany pas kończy się przed przyciskiem. **Na pulpicie finance** pływający aparat (`.aparat-plyw`) stoi nad asystentem: oba kółka 60 px, ta sama oś pionowa (`right: 14px`), 12 px odstępu; asystent ma dodatkowo miękką obwódkę 4 px w kolorze tła **na zewnątrz** ciemnego koła (jak w pozostałych makietach), więc ciemne koło dalej ma 60 px; aparat jasny z obwódką, asystent ciemny (makieta „a2 + aparat"). **Ikona asystenta: „iskra + kropka"** (wybór Adama 2026-10-19) — pełna, miękka czteroramienna iskra w kolorze kości `#f2efe9` + kropka w kolorze modułu (`--marka`: złoto w finance, kolor modułu w eat/task), ścieżka SVG w makiecie; trafia do `IKONY_SVG` w `auth.js`. Zmiana `.aparat-plyw` tylko w regule mobilnej i tylko gdy przycisk asystenta jest widoczny — inne konta bez zmian. `asystent.js` ładowany z `?v=<hash>` (jak reszta), `dyktowanie.js` i `eat-skaner.js` dociągane dynamicznie przy pierwszym otwarciu okna, z tą samą wersją.

**Limit dzienny:** liczba wierszy `asystent_log` użytkownika z bieżącego dnia w strefie Europe/Warsaw, sprawdzana i zapisywana w jednej transakcji przed wywołaniem modelu.

### Historia rozmowy

Klient przysyła ostatnie **6 wymian** bieżącej rozmowy (zamknięcie okna = nowa rozmowa). Traktowana jako dane niezaufane: serwer obcina długość, nie przyjmuje z niej żadnych id ani „zatwierdzeń" — każda propozycja jest walidowana od zera.

### Model, koszty, limity

- Model: `claude-sonnet-4-6`. Jedno polecenie to 1 wywołanie asystenta + ewentualnie 1 parser (zadanie / posiłek) — opóźnienie się sumuje; do zmierzenia w pilotażu. Tańszy model — po pilotażu.
- Koszt każdego wywołania logowany z przedrostkiem `asystent-` (Z3).
- Limit: **100 poleceń dziennie** na konto (stała); po przekroczeniu komunikat. Flaga `ai_zablokowane` sprawdzana **na wejściu `/api/asystent`** (nie wszystkie istniejące endpointy AI ją sprawdzają).
- Szacunek kosztu: kilka groszy za polecenie — **niezmierzone**.

### Dostęp

Endpoint i przycisk tylko dla kont z białej listy (zmienna środowiskowa z `user_id`). Inni: 403, brak przycisku. Skrót PWA w `manifest.json` jest wspólny dla wszystkich — prowadzi do `/?asystent=1`; dla konta spoza białej listy to zwykły pulpit (parametr ignorowany).

## Ryzyka i zabezpieczenia

| # | Ryzyko | Zabezpieczenie |
|---|---|---|
| R1 | Model źle zrozumie (data, ilość, produkt, projekt) | karta pokazuje moduł, datę, porę, ilość; poważniejsze wpisy przez „Zapisz"; kalorie z bazy liczy serwer; szacunki oznaczone |
| R2 | Wstrzyknięcie poleceń — tekst od innego domownika (tytuł zadania, pozycja listy) albo z Open Food Facts każe asystentowi coś zrobić | model nie zapisuje; akcje „od razu" ograniczone przez **serwer**: maks. 1 akcja „od razu" na polecenie (nawigacja też się liczy — nie łączy się z zapisem, bo przeładowanie zabiera „Cofnij"), maks. 10 pozycji; dopisywane / odhaczane nazwy muszą występować w **bieżącej wiadomości użytkownika** — nigdy w historii rozmowy ani w wynikach narzędzi (inaczej → karta); odhaczenie „od razu" tylko zadań bez wykonawcy lub przypisanych bieżącemu użytkownikowi; obiekt już w stanie docelowym → brak akcji „od razu" |
| R3 | Push do domowników | dopisanie do listy wysyła powiadomienie gospodarstwu (`_lista_push_zbierz`) tak samo jak ręczne; „Cofnij" go nie odwoła — zaakceptowane, bo to zachowanie formularza; limit R2 ogranicza skalę |
| R4 | Wyciek między gospodarstwami i prywatnych zadań domowników | odczyty z gospodarstwem z sesji; odczyty zadań **zawsze przez filtr widoczności `_WIDOCZNE`** z `task_db` (prywatne zadania innych osób nie trafiają do modelu); id w propozycjach sprawdzane względem gospodarstwa; zapis istniejącymi endpointami z ich kontrolą dostępu |
| R5 | Nawigacja pod dowolny adres | `otworz_widok` = nazwa widoku z białej listy + dozwolone filtry; adres buduje przeglądarka |
| R6 | Koszty AI | biała lista kont; 100 poleceń/dzień liczone **po stronie serwera** z `asystent_log` (wpis tworzony przed wywołaniem modelu); maks. 4 iteracje pętli; 6 wymian historii; wynik narzędzia odczytowego obcięty (maks. 50 elementów i 4000 znaków); twardy limit tokenów wejścia na polecenie |
| R7 | „Cofnij" nieodwracalne lub nadpisujące cudzą zmianę | „Cofnij" przywraca **zapamiętany stan sprzed akcji** (nie „odwrotną wartość"); odhaczenie zadania powtarzalnego tworzy kolejne wystąpienie (cofnięcie go nie usuwa); wstrzymane po cofnięciu wraca jako otwarte; zadanie z podzadaniami — przy `kaskada:false` podzadania zostają otwarte, co karta mówi wprost (`uwaga`) → takie zadania tylko przez kartę, bez „Cofnij"; zawsze `kaskada:false` |
| R8 | Aparat nie otworzy się po nawigacji | przycisk aparatu w oknie asystenta jako `<label for>`, pole ukryte własną klasą (nie `display:none`) |
| R9 | Ciche niepowodzenie | błąd z serwera pokazany przez `toast(…, 'blad')`; wynik `blad` w `asystent_log` |
| R10 | Model zgaduje / wymyśla | prompt: przy brakach `zapytaj`; produkty tylko z `szukaj_produktu_eat` albo jawnie jako szacunek |
| R11 | Mowa źle rozpoznana | rozpoznany tekst widoczny w polu przed wysłaniem |
| R12 | Dryf endpointów | zapis tymi samymi endpointami co formularze; test kontraktu propozycja → body endpointu |
| R13 | Niejednoznaczność danych | kilka list zakupów → domyślna (ostatnio używana, `lista_domyslna_id` od klienta) pokazana na karcie, inna na żądanie; duplikaty nazw przy „odhacz" → `zapytaj`; niepewne dopasowanie projektu → karta pokazuje wybrane miejsce z możliwością zmiany |

## Obsługa błędów

- Błąd modelu / sieci → komunikat w oknie, polecenie zostaje w polu.
- Polecenie poza zakresem (np. „przelej 200 zł") → asystent mówi, że tego jeszcze nie umie, nic nie proponuje.
- Limit dzienny → komunikat.

## Testy

- Narzędzia odczytowe: dane innego gospodarstwa niewidoczne.
- Granica zapisu: na mockowanym `get_db` podczas obsługi `/api/asystent` wykonują się tylko `SELECT` oraz `INSERT` do `api_usage` i `asystent_log` (biała lista wprost w teście). `asystent*.py` nie importują `task.py` ani `main.py` (routery).
- Walidacja propozycji: zakresy, id spoza gospodarstwa, widok spoza listy, reguły R2 (1 akcja od razu, ≤10 pozycji, nazwy z bieżącej wiadomości — **test: nazwa obecna tylko w historii → karta**; zadanie innej osoby → karta; obiekt już w stanie docelowym → brak akcji), reguła R7.
- Prywatne zadanie innego domownika niewidoczne w żadnym narzędziu odczytowym.
- Z1: posiłek z błędną pozycją nie zapisuje nic; pozycja z `produkt_id` ma kalorie z bazy.
- Kontrakt: propozycja zapisywalna → poprawne body istniejącego endpointu.
- ~15 przykładowych zdań na prawdziwym modelu, uruchamiane ręcznie, z kosztem podanym przed uruchomieniem.
- Przeglądarka: wdrożona apka, ctrl+shift+R; pomiar okna i dolnego paska przy 320/360/412 px.
- **Prawdziwy telefon (Android, Chrome):** mikrofon, skaner kodu, aparat paragonu, skrót PWA — tego nie da się sprawdzić w przeglądarce na komputerze.

## Otwarte (decyzje Adama przed planem)

- ~~O1. Położenie przycisku~~ **ROZSTRZYGNIĘTE 2026-10-19: wariant a2** — okrągły przycisk na stałe przy prawej krawędzi dolnego paska, tej samej wielkości co w makiecie C i wystający ponad linię paska; przewija się tylko część paska na lewo od niego (nic nie przejeżdża pod przyciskiem). Makieta: https://claude.ai/artifact/SVmzGMG8YaH6Y9EM2yAyfY (ostatni wariant).
- ~~O2. Z4~~ — **zgoda 2026-10-19**.

## Kryteria sukcesu pilotażu

- Polecenia z zakresu szybsze niż formularze (subiektywnie + liczba stuknięć).
- Odsetek propozycji zatwierdzonych bez poprawki w `asystent_log` po 2 tygodniach.
- Zero zapisów, których użytkownik nie zainicjował.
