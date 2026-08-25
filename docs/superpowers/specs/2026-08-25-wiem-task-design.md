# wiem.task — specyfikacja etapu 1

Data: 2026-08-25
Status: zatwierdzona przez Adama, gotowa do planu wdrożenia

## Po co to jest

Czwarty moduł aplikacji Wiem: zadania i długofalowe przedsięwzięcia — „action plan"
dla gospodarstwa. Docelowo obsługuje jedno i drugie: bieżące sprawy („przegląd auta",
„oddać PIT") oraz projekty ciągnące się miesiącami („remont łazienki") z etapami
i wykresem Gantta.

**Etap 1 buduje zadania.** Projekty, Gantt, zależności i cykliczność wchodzą w etapie 2 —
model danych jest pod nie przygotowany, więc dołożenie ich nie wymaga migracji istniejących
rekordów.

## Decyzje podjęte przy projektowaniu

| Decyzja | Wybór | Dlaczego |
|---|---|---|
| Kolejność budowy | Najpierw zadania, potem projekty i Gantt | Zadania są użyteczne od pierwszego dnia; Gantt bez treści jest pusty |
| Widoczność | Wspólne domyślnie, przełącznik „tylko dla mnie" | Reszta apki jest gospodarstwowa, ale musi istnieć miejsce na sprawę prywatną |
| Cykliczność | Etap 2 | Nie blokuje etapu 1, a model ją przyjmie |
| Przypomnienia | Osobny push per zadanie, o wybranej godzinie | Decyzja Adama; alternatywę (jedno poranne podsumowanie) odrzucił świadomie |
| Zagnieżdżenie | Dowolna głębokość | Wymóg Adama — krok musi móc mieć własne kroki |
| Model | Jedna tabela z `parent_id`, drzewo składane w JS | Dowolna głębokość bez `WITH RECURSIVE` w ścieżce wyświetlania |
| Kolory | finance → złoty, task → koral `#ff6b6b` | Decyzja Adama, podjęta mimo zgłoszonych zastrzeżeń (patrz „Ryzyka") |

## Model danych

Jedna tabela. Krok to dziecko zadania; w etapie 2 projekt będzie korzeniem drzewa
z własną rozpiętością w czasie.

```sql
CREATE TABLE IF NOT EXISTS task_zadania (
    id                   SERIAL PRIMARY KEY,
    household_id         INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    parent_id            INTEGER REFERENCES task_zadania(id) ON DELETE CASCADE,
    tytul                TEXT NOT NULL,
    opis                 TEXT,
    termin               DATE,          -- NULL = zadanie bez terminu
    pora                 TIME,          -- godzina przypomnienia; NULL = bez przypomnienia
    przypomniano_at      TIMESTAMPTZ,   -- znacznik wysyłki, chroni przed dublem po restarcie
    wykonawca_user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    wykonawca_virtual_id INTEGER REFERENCES virtual_members(id) ON DELETE SET NULL,
    prywatne_dla         INTEGER REFERENCES users(id) ON DELETE CASCADE,  -- NULL = wspólne
    kamien_milowy        BOOLEAN NOT NULL DEFAULT FALSE,    -- punkt w czasie, bez trwania
    status               TEXT NOT NULL DEFAULT 'otwarte',   -- 'otwarte' | 'zrobione'
    zrobione_at          TIMESTAMPTZ,
    utworzyl             INTEGER REFERENCES users(id) ON DELETE SET NULL,
    kolejnosc            INTEGER NOT NULL DEFAULT 0,
    created_at           TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS task_zadania_dom ON task_zadania (household_id, status, termin);
CREATE INDEX IF NOT EXISTS task_zadania_parent ON task_zadania (parent_id);
CREATE INDEX IF NOT EXISTS task_zadania_przypomnienia
    ON task_zadania (termin, pora) WHERE status = 'otwarte' AND przypomniano_at IS NULL;
```

Migracja idzie tym samym mechanizmem co reszta (`CREATE TABLE IF NOT EXISTS`
przy starcie), w nowym pliku `task_db.py`.

### Dlaczego wykonawca na identyfikatorach, a nie tekstem

`wydatki.osoba` trzyma imię jako `TEXT`. Tu robimy inaczej **świadomie**: zadanie żyje
tygodniami, a zmiana pseudonimu nie może osierocić przypisania. Dwie kolumny, bo wykonawcą
może być domownik z kontem (`users`) albo osoba bez konta (`virtual_members`) — dokładnie
ten sam podział, co przy osobach w module zdrowia.

### Prywatność

Jedna kolumna i jeden warunek dokładany do **każdego** zapytania odczytu:

```sql
WHERE household_id = :hid AND (prywatne_dla IS NULL OR prywatne_dla = :ja)
```

Zadanie prywatne nie pojawia się nikomu innemu ani na liście, ani w przypomnieniach,
ani w postępie zadania nadrzędnego widzianym przez drugą osobę.

## Reguły spójności drzewa

Do wymuszenia w `task_db.py`, bo baza sama tego nie dopilnuje:

1. **`parent_id` musi należeć do tego samego gospodarstwa.** Bez tej kontroli da się
   podpiąć własne zadanie pod cudze drzewo, znając identyfikator.
2. **Zadanie nie może stać się swoim własnym potomkiem.** Przy zmianie rodzica trzeba
   sprawdzić, czy nowy rodzic nie leży w poddrzewie przenoszonego zadania — jedyne
   miejsce, gdzie `WITH RECURSIVE` jest uzasadnione.
3. **Dziecko dziedziczy prywatność rodzica.** Przy tworzeniu dziecka `prywatne_dla`
   kopiujemy z rodzica i ignorujemy to, co przyszło w żądaniu; zmiana prywatności zadania
   przepisuje ją na całe poddrzewo. Bez tego prywatne zadanie z publicznymi dziećmi
   wyciekałoby tylnymi drzwiami — tytuły dzieci zdradzają treść rodzica.

## API

Router `task.py`, wzorzec `health.py` (`APIRouter`, `Depends(get_current_user)`,
`_hid()` do gospodarstwa).

| Metoda | Ścieżka | Rola |
|---|---|---|
| GET | `/api/task/zadania?zakres=dzis\|nadchodzace\|zrobione&osoba=` | Płaska lista; drzewo składa front |
| POST | `/api/task/zadania` | Nowe zadanie (opcjonalnie z `parent_id`) |
| PUT | `/api/task/zadania/{id}` | Edycja pól |
| PATCH | `/api/task/zadania/{id}/status` | Odhaczenie; `kaskada: true` zamyka poddrzewo |
| DELETE | `/api/task/zadania/{id}` | Usuwa razem z poddrzewem (kaskada w bazie) |

Zakresy: **dzis** = `termin <= dzisiaj` i `status='otwarte'` (czyli razem z zaległymi),
**nadchodzace** = `termin > dzisiaj` albo `termin IS NULL`, **zrobione** = `status='zrobione'`
z ostatnich 30 dni.

Odpowiedź jest płaska — front buduje drzewo po `parent_id`. Gospodarstwo ma setki, nie
miliony zadań, więc to tańsze niż rekurencja w SQL-u i pozwala policzyć postęp poddrzewa
bez dodatkowego zapytania.

## Ekrany

Jedna strona `/task`, trzy zakładki: **Dziś**, **Nadchodzące**, **Zrobione**. Nad nimi
filtr osoby w formie chipów, jak na osi czasu w module zdrowia.

Wiersz zadania: ptaszek, tytuł, termin (kolorem `--danger`, gdy po czasie), awatar
wykonawcy, postęp „3 z 7" gdy ma dzieci, strzałka wejścia w środek.

**Głębokość na ekranie jest ograniczona, w bazie nie.** Wcięcia do trzeciego poziomu;
głębiej wchodzi się w zadanie jak w folder, z okruszkami u góry („Remont › Łazienka ›
Hydraulik"). Powód: przy 412 px czwarty poziom wcięcia zostawia na tytuł około 200 px.

Odhaczenie zadania, które ma nieskończone dzieci, **pyta**, czy zamknąć też je —
przez `potwierdz()`, nie po cichu. Komunikaty przez `toast()`.

**Główną drogą dodania zadania jest jedno pole na górze listy.** Wpisujesz treść,
naciskasz Enter, zadanie istnieje — bez terminu, bez wykonawcy, bez niczego. Szczegóły
dopisuje się później. To nie jest udogodnienie, tylko warunek używalności: jeśli dodanie
sprawy wymaga wypełnienia sześciu pól, po tygodniu nikt tego nie robi, a niezapisane
zadanie jest gorsze niż zapisane bez terminu.

Pełny formularz (tytuł, opis, termin, godzina przypomnienia, wykonawca, kamień milowy,
przełącznik „tylko dla mnie", kroki dopisywane Enterem) jest drugą drogą — z przycisku
i z wnętrza zadania.

**Zwinięte zadanie z dziećmi pokazuje następny nieskończony krok**, a nie całe poddrzewo:
„Remont łazienki → następne: zamówić płytki". Lista dwudziestu pozycji pod jednym zadaniem
nie mówi, co robić dzisiaj.

Kamień milowy wyróżnia się ikoną i nie ma paska postępu — to punkt, nie odcinek.

## Przypomnienia

Nowe zadanie w istniejącym harmonogramie (`main.py`, APScheduler, Europe/Warsaw),
tik **co minutę**, `misfire_grace_time` 120 s:

```
SELECT ... WHERE status = 'otwarte' AND przypomniano_at IS NULL
             AND termin IS NOT NULL AND pora IS NOT NULL
             AND (termin + pora) <= now()
```

Adresat: wykonawca, jeśli jest domownikiem z kontem; zadanie wspólne bez wykonawcy idzie
do całego gospodarstwa (`push.wyslij_do_gospodarstwa`); prywatne wyłącznie do właściciela.
Zadanie przypisane osobie bez konta trafia do gospodarstwa — taka osoba nie ma gdzie
odebrać powiadomienia.

Po wysyłce ustawiamy `przypomniano_at`. **Zmiana terminu albo godziny zeruje ten
znacznik**, więc przesunięte zadanie przypomni się ponownie.

Osobnych zadań w harmonogramie per przypomnienie NIE rejestrujemy — zniknęłyby przy
każdym restarcie kontenera, a Railway restartuje przy każdym wdrożeniu.

## Pliki

| Plik | Co robi |
|---|---|
| `task.py` | Router `/api/task/*` |
| `task_db.py` | Migracja tabeli, wszystkie zapytania, reguły spójności drzewa |
| `static/task.html` | Strona modułu |
| `static/task.js` | Widoki, drzewo, formularz |
| `main.py` | Trasa `/task`, `include_router`, zadanie w harmonogramie |
| `static/auth.js` | Wpis w `MODULY`, nowa ikona w `IKONY_SVG`, zestaw slajdów samouczka |
| `push.py` | `wyslij_przypomnienia_zadan()` |

Gotowe do użycia bez pisania: toasty i okno potwierdzenia, push z subskrypcjami, awatary,
gospodarstwa i osoby bez konta, dolny pasek nawigacji, przełącznik modułów, motywy.

## Zmiana kolorów modułów

Decyzja Adama: **finance przechodzi na złoty, task dostaje koral `#ff6b6b`.**

Do zrobienia razem z modułem:
1. `MODULY` w `auth.js` — nowy kolor finansów, wpis `task` z koralem.
2. Wartość zapasowa `--marka` w `style.css`.
3. **Kropki w ikonach PNG** (`icon-192`, `icon-512`, `icon-maskable-512`) przemalować
   na złoto — inaczej ikona na ekranie telefonu zostanie w kolorze zadań, choć `start_url`
   prowadzi do finansów.
4. Odcień złota dobrać pod kontrast: `--marka` jest kolorem pisma aktywnego linku
   w dolnym pasku (`style.css:745`), więc jasne złoto zrobi tam etykietę nieczytelną.
   Zweryfikować pomiarem, nie na oko, i pokazać Adamowi zrzut przed wdrożeniem.

## Metodyka — co bierzemy z zarządzania projektami, a czego nie

Przegląd praktyk (WBS, ścieżka krytyczna, GTD, macierz Eisenhowera, typy zależności)
zrobiony 2026-08-25. Wnioski, świadomie zawężone do gospodarstwa domowego:

**Bierzemy:**
- **Płytka struktura zamiast choinki** — praktyka WBS mówi o 3–7 dużych kawałkach i zadaniu
  na tyle małym, żeby jedna osoba zamknęła je w tydzień–dwa. Baza nie ogranicza głębokości,
  ale formularz dokłada krok do bieżącego poziomu, nie głębiej.
- **Kamienie milowe** — punkt bez trwania, w etapie 2 romb na Gantcie. To one odpowiadają
  na pytanie „czy zdążymy".
- **Szybkie łapanie zadania** (z GTD) — patrz sekcja „Ekrany".
- **Następny krok zamiast całego drzewa** (z GTD).

**Świadomie odrzucone:**
- **Ścieżka krytyczna liczona algorytmem** — wymaga rzetelnych oszacowań czasu trwania,
  których w domu nikt nie robi. Dałaby fałszywą precyzję. W etapie 2 najwyżej podświetlimy
  najdłuższy łańcuch zależności.
- **Priorytety i macierz Eisenhowera** — termin już porządkuje kolejność, a osobne pole
  „ważność" kończy się tym, że wszystko jest ważne.
- **Bufory czasowe, bilansowanie zasobów, linia bazowa** — narzędzia do rozliczania zespołu
  z planu. W domu nie ma kogo rozliczać.

## Etap 2 — ustalenia zapadłe z góry

Nie budujemy tego teraz, ale decyzje są podjęte, żeby model ich nie blokował:

1. **Projekty** jako korzenie drzewa z datą początku i końca, plus wykres Gantta.
2. **Zależności wyłącznie typu „skończ, zanim zaczniesz"** (finish-to-start). Pozostałe trzy
   typy z podręczników (SS, FF, SF) są rzadkie i mylące — nie wchodzą.
3. **Cotygodniowy przegląd jako push** — lista spraw bez terminu i takich, które stoją.
   Domyka pętlę GTD i jedzie na infrastrukturze przypomnień, którą już mamy.
4. **Cykliczność zadań** — osobna tabela reguł, wzorzec `wydatki_cykliczne`.

## Ryzyka i rzeczy do sprawdzenia

- **Usypianie kontenera na Railway.** Tik co minutę działa tylko wtedy, gdy proces żyje.
  Dotyczy to również dzisiejszych przypomnień o płatnościach (codziennie 9:00), więc jeśli
  coś jest nie tak, problem istnieje już teraz i trzeba go potwierdzić pomiarem.
- **Złoto ma skojarzenia**, które Adam sam odrzucił w sierpniu (Onet, Allegro, InPost).
  Zastrzeżenie zgłoszone, decyzja podtrzymana — zapisane, żeby nie wracać do tematu.
- **Push per zadanie może zacząć dzwonić kilka razy dziennie.** Alternatywa (jedno poranne
  podsumowanie) była proponowana i odrzucona; jeśli okaże się uciążliwe, dobudowanie trybu
  zbiorczego to zmiana wyłącznie w `push.py`.
- **Brak lokalnego uruchomienia** — baza stoi na Railway. Weryfikacja jak zwykle:
  `py_compile`, `node --check`, a potem test w przeglądarce na wdrożonej apce.

## Kryteria akceptacji

1. `/task` pokazuje trzy zakładki i listę zadań gospodarstwa z uwzględnieniem prywatnych.
2. Zadanie da się dodać **samym tytułem i Enterem**, bez otwierania formularza.
3. Pełnym formularzem da się utworzyć zadanie z terminem, godziną, wykonawcą i krokami.
4. Krok da się zagnieździć w kroku — baza nie ogranicza głębokości.
5. Zwinięte zadanie z dziećmi pokazuje następny nieskończony krok.
6. Zadanie oznaczone jako kamień milowy wyróżnia się i nie pokazuje paska postępu.
7. Odhaczenie rodzica pyta o dzieci i po potwierdzeniu zamyka poddrzewo.
8. Zadanie prywatne jest niewidoczne dla drugiego domownika (sprawdzone na dwóch kontach).
9. Przypomnienie przychodzi jako push o ustawionej godzinie, dokładnie raz.
10. Przesunięcie terminu powoduje ponowne przypomnienie.
11. Zadania nie da się podpiąć pod drzewo innego gospodarstwa ani pod własne poddrzewo.
12. Moduł ma własny samouczek, a nie samouczek finansów.

## Poza zakresem etapu 1

Projekty jako osobny byt, wykres Gantta, zależności między zadaniami, cykliczność,
załączniki, komentarze, synchronizacja na żywo przez WebSocket, integracja z kalendarzem.
