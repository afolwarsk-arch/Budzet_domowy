// Ekran zadań — wiem.task.
//
// DRZEWO SKŁADAMY TUTAJ, nie w SQL-u (patrz nagłówek task_db.py). Serwer daje
// płaską listę, a `budujDrzewo` wiąże dzieci z rodzicami. Dzięki temu postęp
// poddrzewa liczy się bez dodatkowego zapytania.
//
// SZYBKIE DODAWANIE JEST GŁÓWNĄ DROGĄ, formularz drugą. Zadanie, którego
// dodanie wymaga sześciu pól, nie zostaje dodane wcale — a sprawa niezapisana
// jest gorsza niż zapisana bez terminu.
//
// DWA WIDOKI: lista (drzewo zadań, ewentualnie wejście w poddrzewo przez
// `korzen`) i szczegóły (pełny formularz jednego zadania — termin, godzina,
// wykonawca, kamień milowy, prywatność, usuwanie).

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Dzisiejsza data W CZASIE LOKALNYM. toISOString() daje UTC, więc między
// północą a drugą w nocy pokazywałby jeszcze wczoraj i zaległe zadanie nie
// zapalałoby się na czerwono.
function isoLokalne(d) {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dz = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${dz}`;
}

function dzisIso() {
  return isoLokalne(new Date());
}

// Polska odmiana przez liczbę: 1 forma pojedyncza, 2–4 „kilka", 5+ „wiele" —
// z wyjątkiem 12–14, które mimo końcówki 2–4 biorą formę mnogą (wzorzec
// z health.js).
function odmien(n, poj, kilka, wiele) {
  if (n === 1) return poj;
  const r10 = n % 10, r100 = n % 100;
  return (r10 >= 2 && r10 <= 4 && !(r100 >= 12 && r100 <= 14)) ? kilka : wiele;
}

// Plan ma własny adres (/plan), więc zakres bierzemy ze ścieżki. Dzięki temu
// odświeżenie strony albo wejście z paska nawigacji trafia tam, gdzie trzeba,
// zamiast zawsze na „Dziś".
const TRYB_PLANU = location.pathname.replace(/\/$/, '') === '/plan';
let zakres = TRYB_PLANU ? 'plan' : 'dzis';   // dzis | nadchodzace | zrobione | plan
let zadania = [];           // płasko, jak z serwera
let korzen = null;          // null = widok listy; liczba = wejście w zadanie
let widok = 'lista';        // lista | szczegoly
let szczegolyId = null;     // id zadania otwartego w formularzu szczegółów
let nowyId = null;          // id ostatnio dodanego szybkim dodawaniem — przy nim pokazujemy „Szczegóły"
let household = null;       // {members, virtual_members} — wczytywane raz, przy pierwszym otwarciu formularza
let planZrobione = false;   // czy wykres pokazuje też zadania zamknięte
let planSkala = 1;          // 0 = ciasno (kwartał+), 1 = miesiąc, 2 = tydzień
// Które projekty pokazywać na wykresie. Pusty zbiór = wszystko; inaczej tylko
// wskazane korzenie wraz z całą zawartością. Przy kilku przedsięwzięciach naraz
// (dom, wesele, remont) wspólna oś zamienia się w gąszcz, w którym nic nie widać.
let planProjekty = new Set();
// Szersza kolumna nazw na chwilę. Na telefonie ma ona 104 px i dłuższe tytuły
// („Księga wieczysta — właściciel, hipoteki…") urywają się w połowie, a wykres
// bez podpisów jest zbiorem kolorowych pasków.
let planSzerokieNazwy = false;
let planPanelOtwarty = false;   // czy rozwinięte są rzadziej używane ustawienia widoku
// Powiązania „skończ, zanim zaczniesz": [{zadanie_id, poprzednik_id}].
// Zadania bez powiązania są z definicji równoległe — brak wpisu TEŻ niesie
// informację i nie trzeba osobnego typu „może iść obok".
let zaleznosci = [];
// Kontekst osi zapamiętany przy rysowaniu — potrzebny przy przeciąganiu belek,
// żeby przeliczyć piksele z powrotem na dni.
let planOs = { od: null, px: 9 };

const box = () => document.getElementById('tresc');

function budujDrzewo(plaska) {
  const wg = new Map();
  for (const z of plaska) wg.set(z.id, Object.assign({ dzieci: [] }, z));
  const gora = [];
  for (const z of wg.values()) {
    const rodzic = z.parent_id != null ? wg.get(z.parent_id) : null;
    if (rodzic) rodzic.dzieci.push(z); else gora.push(z);
  }
  return gora;
}

// Postęp bierzemy Z SERWERA, a nie liczymy z widocznej listy. Liczenie po
// stronie przeglądarki obejmowało wyłącznie zadania z bieżącej zakładki,
// a zrobione kroki nie trafiają do „Nadchodzących" — projekt z dwoma
// zamkniętymi krokami pokazywał „0 z 12" zamiast „2 z 14". Licznik, który
// zaniża postęp, jest gorszy niż jego brak.
//
// Zapasowe liczenie z drzewa zostaje na wypadek starszej odpowiedzi serwera
// (np. karta otwarta przed wdrożeniem): lepiej pokazać liczbę niepełną niż
// zero przy zadaniu, które kroki ma.
function postep(w) {
  if (typeof w.krokow_razem === 'number') {
    return { razem: w.krokow_razem, gotowe: w.krokow_gotowych || 0 };
  }
  let razem = 0, gotowe = 0;
  const zejdz = (x) => {
    for (const d of x.dzieci || []) {
      razem++;
      if (d.status === 'zrobione') gotowe++;
      zejdz(d);
    }
  };
  zejdz(w);
  return { razem, gotowe };
}

// Pierwszy nieskończony krok — to jego pokazujemy przy zwiniętym zadaniu.
// Schodzimy najgłębiej jak się da: „następne: zamówić płytki" jest instrukcją,
// „następne: łazienka" nie jest.
function nastepnyKrok(w) {
  for (const d of w.dzieci) {
    if (d.status === 'zrobione') continue;
    const glebiej = nastepnyKrok(d);
    return glebiej.tytul ? glebiej : d;
  }
  return {};
}

function splaszcz(w) {
  return [w].concat(w.dzieci.flatMap(splaszcz));
}

// Droga od korzenia całego drzewa do zadania `id` — wejście dla okruszków.
function sciezkaDo(id) {
  const wg = new Map(zadania.map((z) => [z.id, z]));
  const droga = [];
  let x = wg.get(id);
  while (x) { droga.unshift(x); x = x.parent_id != null ? wg.get(x.parent_id) : null; }
  return droga;
}

function okruszki() {
  if (korzen == null) return '';
  const droga = sciezkaDo(korzen);
  return `<nav class="okruszki">
    <button type="button" data-okr="">Zadania</button>
    ${droga.map((z) => `<span>›</span><button type="button" data-okr="${z.id}">${esc(z.tytul)}</button>`).join('')}
  </nav>`;
}

// Karta bieżącego zadania nad jego krokami — tytuł, postęp i wejście do
// pełnego formularza. Bez niej wejście strzałką pokazywałoby wyłącznie listę
// dzieci, bez sposobu, żeby dobrać się do szczegółów SAMEGO zadania.
function nagKorzenia(w) {
  const p = postep(w);
  return `<div class="zad-korzen">
    <div>
      <div class="zad-korzen-tytul">${w.kamien_milowy ? '<span class="kamien"></span>' : ''}${esc(w.tytul)}</div>
      ${p.razem ? `<div class="zad-korzen-postep">${p.gotowe} z ${p.razem}</div>` : ''}
    </div>
    <button class="btn btn-outline" type="button" id="korzen-szczegoly">Szczegóły</button>
  </div>`;
}

async function wczytaj() {
  // Plan ma własne wejście: bierze zadania z JAKĄKOLWIEK datą, niezależnie od
  // tego, czy termin już minął — oś czasu pokazuje rozpiętość, a nie „co dziś".
  if (zakres === 'plan') return wczytajPlan();
  try {
    const r = await authFetch('/api/task/zadania?zakres=' + zakres);
    zadania = (await r.json()).zadania || [];
  } catch { zadania = []; toast('Nie udało się wczytać zadań.', 'blad'); }
  rysuj();
}

async function wczytajPlan() {
  try {
    const r = await authFetch('/api/task/plan' + (planZrobione ? '?zrobione=true' : ''));
    const d = await r.json();
    zadania = d.zadania || [];
    zaleznosci = d.zaleznosci || [];
  } catch { zadania = []; zaleznosci = []; toast('Nie udało się wczytać planu.', 'blad'); }
  rysuj();
}

// Domowników wczytujemy OD RAZU, nie dopiero przy otwarciu formularza:
// skrót wykonawcy przy każdym zadaniu potrzebuje ich do narysowania listy.
window.addEventListener('DOMContentLoaded', () =>
  authRequireHousehold().then(wczytajHousehold).then(wczytaj).then(lapPodepnij));

// Które zadanie ma otwarte pole dopisywania kroku. Trzymane poza rysowaniem,
// żeby przerwać ciszę po zapisie: lista przerysowuje się po każdym dodaniu,
// a bez tego pole znikałoby w środku serii wpisów.
let dopisywanieW = null;

// Które zadania mają zwinięte kroki. Trzymane poza rysowaniem, bo lista
// przerysowuje się po każdej zmianie — inaczej wszystko rozwijałoby się z
// powrotem po odhaczeniu jednego ptaszka.
const zwiniete = new Set();

// Plusik PRZEŁĄCZA: drugie kliknięcie zamyka pole. Bez tego jedyną drogą
// wyjścia było wpisanie czegoś albo Escape — czyli znowu wiedza tajemna.
function pokazDopisywanie(id) {
  const juzOtwarte = dopisywanieW === id;
  schowajDopisywanie();
  if (juzOtwarte) return;
  dopisywanieW = id;
  // Dopisywanie do zwiniętego zadania rozwija je — inaczej nowy krok wpadałby
  // w schowany pojemnik i wyglądałoby to, jakby zapis nie zadziałał.
  if (zwiniete.delete(id)) rysuj();
  const box = document.getElementById('dopisz-' + id);
  if (!box) return;
  box.hidden = false;
  const pole = box.querySelector('input');
  if (pole) pole.focus();
}

// ── dziennik zadania ────────────────────────────────────────────────────────
// Komentarze to LOGI: każdy wpis ma datę i zostaje na zawsze. Opis zadania mówi,
// co jest do zrobienia; dziennik mówi, co się po drodze wydarzyło. Przy sprawach
// ciągnących się miesiącami to on odpowiada na pytanie „czemu to się przesunęło".
async function przelaczDziennik(id) {
  const box = document.getElementById('dziennik-' + id);
  if (!box) return;
  // Stan czytamy Z DOM-u, nie ze zmiennej: lista przerysowuje się po każdym
  // dodanym kroku i zamyka dziennik, a zapamiętane „otwarte" kazałoby wtedy
  // pierwszemu kliknięciu zamykać coś, czego już nie widać.
  if (!box.hidden) { box.hidden = true; return; }
  document.querySelectorAll('.zad-dziennik').forEach((e) => { e.hidden = true; });
  box.hidden = false;
  box.innerHTML = '<div class="dz-laduje">Wczytuję…</div>';
  await odswiezDziennik(id);
}

async function odswiezDziennik(id) {
  const box = document.getElementById('dziennik-' + id);
  if (!box) return;
  let wpisy = [];
  try {
    const r = await authFetch(`/api/task/zadania/${id}/komentarze`);
    wpisy = r.ok ? ((await r.json()).komentarze || []) : [];
  } catch { /* pusty dziennik jest poprawnym stanem */ }

  odswiezLicznik(id, wpisy.length);
  box.innerHTML = `
    ${wpisy.length ? `<ol class="dz-lista">${wpisy.map((k) => `
      <li>
        <div class="dz-meta">${esc(dataCzas(k.created_at))}${
          k.autor ? ' · ' + esc(k.autor) : ''}
          <button type="button" class="dz-usun" data-usun-kom="${k.id}"
                  aria-label="Usuń wpis">✕</button>
        </div>
        <div class="dz-tresc">${esc(k.tresc)}</div>
      </li>`).join('')}</ol>` : '<p class="dz-pusto">Brak wpisów. Zapisz, co się wydarzyło.</p>'}
    <div class="dz-nowy">
      <input placeholder="Co się wydarzyło?" data-kom-pole="${id}" autocomplete="off">
      <button class="btn btn-primary btn-dopisz" type="button" data-kom-dodaj="${id}">Zapisz</button>
    </div>`;

  const pole = box.querySelector('[data-kom-pole]');
  const zapisz = async () => {
    const tresc = pole.value.trim();
    if (!tresc) return;
    pole.disabled = true;
    const r = await authFetch(`/api/task/zadania/${id}/komentarze`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tresc }),
    });
    pole.disabled = false;
    if (!r.ok) { toast('Nie udało się zapisać wpisu.', 'blad'); return; }
    await odswiezDziennik(id);
  };
  box.querySelector('[data-kom-dodaj]').onclick = zapisz;
  pole.onkeydown = (e) => { if (e.key === 'Enter') zapisz(); };
  box.querySelectorAll('[data-usun-kom]').forEach((b) => {
    b.onclick = async () => {
      if (!(await potwierdz({ tytul: 'Usunąć wpis?', tresc: 'Zniknie z historii zadania.',
                              tak: 'Usuń', groznie: true }))) return;
      await authFetch(`/api/task/komentarze/${b.dataset.usunKom}`, { method: 'DELETE' });
      await odswiezDziennik(id);
    };
  });
}

// Licznik przy ikonie odświeżamy PUNKTOWO, bez przerysowania listy — inaczej
// dziennik zamykałby się po każdym wpisie, a zwykle dopisuje się kilka naraz.
function odswiezLicznik(id, ile) {
  const z = zadania.find((w) => w.id === id);
  if (z) z.ile_komentarzy = ile;
  const btn = document.querySelector(`[data-komentarze="${id}"]`);
  if (!btn) return;
  btn.classList.toggle('jest', ile > 0);
  btn.innerHTML = ile > 0 ? String(ile) : ikonaSvg('notatka');
}

function dataCzas(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('pl-PL', { day: '2-digit', month: '2-digit', year: '2-digit',
                                     hour: '2-digit', minute: '2-digit' });
}

function schowajDopisywanie() {
  dopisywanieW = null;
  document.querySelectorAll('.zad-dopisz').forEach((b) => { b.hidden = true; });
}

function podepnijPtaszki() {
  // Po przerysowaniu przywracamy otwarte pole — inaczej dopisanie drugiego
  // kroku pod rząd wymagałoby ponownego szukania „+”.
  if (dopisywanieW != null) {
    const box = document.getElementById('dopisz-' + dopisywanieW);
    if (box) {
      box.hidden = false;
      const pole = box.querySelector('input');
      if (pole) pole.focus();
    } else {
      dopisywanieW = null;
    }
  }
  const lista = document.querySelector('.zadania');
  if (!lista) return;
  // Dopisywanie kroku w miejscu: Enter zapisuje, Escape zamyka. Pole zostaje
  // otwarte po zapisie, bo kroki dopisuje się seriami („kredyt", „notariusz",
  // „wypis") — zamykanie go po każdym wpisie zmuszałoby do klikania „+” za
  // każdym razem.
  lista.onkeydown = async (ev) => {
    const pole = ev.target.closest('[data-pole-dodaj]');
    if (!pole) return;
    if (ev.key === 'Escape') { schowajDopisywanie(); return; }
    if (ev.key !== 'Enter') return;
    const tytul = pole.value.trim();
    if (!tytul) { schowajDopisywanie(); return; }
    const parent = Number(pole.dataset.poleDodaj);
    pole.disabled = true;
    const r = await authFetch('/api/task/zadania', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tytul, parent_id: parent }),
    });
    pole.disabled = false;
    if (!r.ok) { toast('Nie udało się zapisać kroku.', 'blad'); return; }
    pole.value = '';
    dopisywanieW = parent;      // po przerysowaniu pole ma wrócić w to samo miejsce
    await wczytaj();
  };

  // Szybkie pola: termin i wykonawca zapisują się od razu po wyborze.
  lista.onchange = async (ev) => {
    const data = ev.target.closest('[data-termin]');
    if (data) {
      await zapiszSzybko(Number(data.dataset.termin), { termin: data.value || null });
      return;
    }
    const kto = ev.target.closest('[data-wykonawca]');
    if (kto) {
      const v = kto.value;
      await zapiszSzybko(Number(kto.dataset.wykonawca), {
        wykonawca_user_id: v.startsWith('u:') ? Number(v.slice(2)) : null,
        wykonawca_virtual_id: v.startsWith('v:') ? Number(v.slice(2)) : null,
      });
    }
  };

  lista.onclick = async (ev) => {
    const zatwierdz = ev.target.closest('[data-zatwierdz-dodaj]');
    if (zatwierdz) {
      const pole = document.querySelector(`[data-pole-dodaj="${zatwierdz.dataset.zatwierdzDodaj}"]`);
      if (pole) pole.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return;
    }
    const plus = ev.target.closest('[data-dodaj]');
    if (plus) {
      pokazDopisywanie(Number(plus.dataset.dodaj));
      return;
    }
    const dz = ev.target.closest('[data-komentarze]');
    if (dz) {
      przelaczDziennik(Number(dz.dataset.komentarze));
      return;
    }
    const zw = ev.target.closest('[data-zwin]');
    if (zw) {
      const id = Number(zw.dataset.zwin);
      if (zwiniete.has(id)) zwiniete.delete(id); else zwiniete.add(id);
      rysuj();
      return;
    }
    const szcz = ev.target.closest('[data-szczegoly]');
    if (szcz) {
      otworzSzczegoly(Number(szcz.dataset.szczegoly));
      return;
    }
    const b = ev.target.closest('[data-ptaszek]');
    if (!b) return;
    const id = Number(b.dataset.ptaszek);
    const w = budujDrzewo(zadania).flatMap(splaszcz).find((x) => x.id === id);
    if (!w) return;
    const zrobione = w.status !== 'zrobione';
    let kaskada = false;
    const p = postep(w);
    // Zamykanie poddrzewa PYTAMY, nie robimy po cichu: użytkownik odhacza
    // rodzica często dlatego, że sprawa odpadła, a nie dlatego, że zrobił
    // wszystkie kroki — a cicho zamknięte kroki znikają bez śladu.
    if (zrobione && p.razem - p.gotowe > 0) {
      const ile = p.razem - p.gotowe;
      kaskada = await potwierdz({
        tytul: 'Zamknąć też kroki?',
        tresc: `To zadanie ma ${ile} ${odmien(ile, 'nieskończony krok', 'nieskończone kroki', 'nieskończonych kroków')}.`,
        tak: 'Zamknij wszystko', nie: 'Tylko to zadanie',
      });
    }
    const r = await authFetch(`/api/task/zadania/${id}/status`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ zrobione, kaskada }),
    });
    if (!r.ok) { toast('Nie udało się zmienić zadania.', 'blad'); return; }
    wczytaj();
  };
}

// Bez „Plan": to nie jest zakres listy, tylko osobny widok pod własnym adresem.
const ZAKRESY = [['dzis', 'Dziś'], ['nadchodzace', 'Nadchodzące'], ['zrobione', 'Zrobione']];

const OKRESY = [['dzien', 'codziennie'], ['tydzien', 'co tydzień'],
                ['miesiac', 'co miesiąc'], ['rok', 'co rok']];

// Jednostka odmieniona przez liczbę — „co 2 tydzień" wygląda jak usterka.
function jednostkaOkresu(okres, n) {
  if (okres === 'dzien') return odmien(n, 'dzień', 'dni', 'dni');
  if (okres === 'tydzien') return odmien(n, 'tydzień', 'tygodnie', 'tygodni');
  if (okres === 'miesiac') return odmien(n, 'miesiąc', 'miesiące', 'miesięcy');
  return odmien(n, 'rok', 'lata', 'lat');
}

// Podpis powtarzania na liście: przy „co 1" mówimy po ludzku („co tydzień"),
// przy większych liczbach dopiero dokładamy liczebnik.
function opisPowtarzania(z) {
  if (!z.powtarzaj) return '';
  const co = Number(z.powtarzaj_co) || 1;
  if (co === 1) return (OKRESY.find(([k]) => k === z.powtarzaj) || [, ''])[1];
  return `co ${co} ${jednostkaOkresu(z.powtarzaj, co)}`;
}

function rysuj() {
  if (widok === 'szczegoly') return rysujSzczegoly();
  if (zakres === 'plan') return rysujPlan();
  return rysujLista();
}

// ── wykres Gantta ───────────────────────────────────────────────────────────
//
// Rysowany zwykłym HTML-em, bez biblioteki: belka to `div` o szerokości
// liczonej z liczby dni, a cała reszta to siatka. Wykres w tej apce ma pokazać
// kilkanaście zadań domowych, nie harmonogram budowy — biblioteka kosztowałaby
// więcej wagi strony niż daje.
//
// LEWA KOLUMNA JEST PRZYKLEJONA, oś przewija się pod nią w poziomie. Bez tego
// na telefonie przewinięcie do listopada gubi nazwy zadań i widać same belki,
// o których nie wiadomo, czego dotyczą.

const SKALE_PLANU = [
  { px: 3.2, opis: 'cały plan' },   // ~100 px na miesiąc
  { px: 9,   opis: 'miesiąc' },
  { px: 26,  opis: 'tydzień' },
];

const DZIEN_MS = 86400000;

function doDaty(x) {
  return x ? new Date(String(x).slice(0, 10) + 'T00:00:00') : null;
}

// Zadanie bez daty początku dostaje jednodniową belkę na terminie — inaczej
// nie dałoby się go w ogóle postawić na osi. Kamień milowy jest punktem
// z założenia, więc też ma jeden dzień.
function zakresZadania(z) {
  const koniec = doDaty(z.termin) || doDaty(z.data_start);
  const start = doDaty(z.data_start) || koniec;
  return start && koniec ? { start, koniec } : null;
}

// Zadania należące do wybranych projektów (razem z całą zawartością). Pusty
// wybór znaczy „wszystko" — filtr ma zawężać, a nie wymuszać wybór na starcie.
function wPlanieWidoczne(lista) {
  if (!planProjekty.size) return lista;
  const wg = new Map(lista.map((z) => [z.id, z]));
  const nalezy = (z) => {
    let x = z;
    const odwiedzone = new Set();
    while (x && !odwiedzone.has(x.id)) {
      if (planProjekty.has(x.id)) return true;
      odwiedzone.add(x.id);
      x = x.parent_id != null ? wg.get(x.parent_id) : null;
    }
    return false;
  };
  return lista.filter(nalezy);
}

function rysujPlan() {
  const zDatami = wPlanieWidoczne(zadania).filter(zakresZadania);
  if (!zDatami.length) {
    box().innerHTML = naglowekPlanu()
      + `<p class="pusto">Żadne zadanie nie ma jeszcze dat. Otwórz zadanie,
         ustaw termin (i opcjonalnie początek), a pojawi się na osi.</p>`;
    podepnijNaglowekPlanu();
    return;
  }

  // Okno czasu: od najwcześniejszego początku do najpóźniejszego terminu,
  // zawsze z dzisiejszym dniem w środku — plan bez „dziś" nie mówi, czy coś
  // jest już spóźnione.
  const dzis = new Date(new Date().toDateString());
  let od = new Date(Math.min(...zDatami.map((z) => zakresZadania(z).start), dzis));
  let doK = new Date(Math.max(...zDatami.map((z) => zakresZadania(z).koniec), dzis));
  od = new Date(od.getTime() - 3 * DZIEN_MS);
  doK = new Date(doK.getTime() + 3 * DZIEN_MS);
  const dni = Math.max(1, Math.round((doK - od) / DZIEN_MS));
  const px = SKALE_PLANU[planSkala].px;
  const szer = Math.round(dni * px);

  const drzewo = budujDrzewo(zDatami.concat(
    wPlanieWidoczne(zadania).filter((z) => !zakresZadania(z))));  // przodkowie bez dat trzymają strukturę
  const wiersze = drzewo.flatMap((w) => splaszczPlan(w, 0));
  planOs = { od, px };

  // Pozycje wierszy potrzebne do narysowania strzałek zależności — numer
  // wiersza mówi, na jakiej wysokości leży belka danego zadania.
  const rzedy = new Map(wiersze.map((w, i) => [w.z.id, i]));

  box().innerHTML = naglowekPlanu() + `
    <div class="gantt${planSzerokieNazwy ? ' szerokie-nazwy' : ''}" style="--szer:${szer}px">
      <!-- Pasek z danymi i oś siedzą we WSPÓLNYM przyklejanym nagłówku:
           przy przewijaniu długiego planu w dół trzeba dalej widzieć, jaki
           to miesiąc i co się właśnie zaznaczyło. -->
      <div class="gantt-gora">
        <div class="gantt-info" id="gantt-info" hidden></div>
        <!-- Miesiące w osobnej warstwie, żeby dało się ją przesuwać razem
             z wykresem: sama oś ma stałą pozycję i ucina to, co poza ekranem. -->
        <div class="gantt-osie"><div class="gantt-osie-tresc" style="width:${szer}px">${
          osCzasu(od, dni, px)}</div></div>
      </div>
      <div class="gantt-body">
        ${pasyWeekendow(od, dni, px)}
        ${strzalkiZaleznosci(wiersze, rzedy, od, px, szer)}
        ${wiersze.map((w) => wierszPlanu(w, od, px, szer, dzis)).join('')}
        <!-- Pionowa kreska „dziś" — bez niej nie widać, co jest już za nami.
             Rysowana raz na całą wysokość, nie w każdym wierszu z osobna. -->
        <div class="gantt-dzis" style="left:calc(var(--nazwa) + ${
          Math.round(((dzis - od) / DZIEN_MS) * px)}px)"><span>dziś</span></div>
      </div>
    </div>`;
  podepnijNaglowekPlanu();
  podepnijBelki();
}

// Spłaszczenie z zachowaniem poziomu zagnieżdżenia — na wykresie wcięcie
// zastępuje strzałki wchodzenia w głąb, bo cała struktura jest widoczna naraz.
function splaszczPlan(w, poziom) {
  return [{ z: w, poziom }].concat((w.dzieci || []).flatMap((d) => splaszczPlan(d, poziom + 1)));
}

function naglowekPlanu() {
  return `
    <div class="gora"><h1>Plan</h1></div>
    <!-- JEDEN rząd narzędzi zamiast trzech. Filtry i przełączniki zajmowały
         na telefonie połowę ekranu, zanim w ogóle było widać wykres — więc
         siedzą pod przyciskiem, a na wierzchu zostaje tylko gęstość, którą
         zmienia się najczęściej. -->
    <div class="filtry plan-narzedzia">
      <button class="chip${ileUstawienWidoku() ? ' wlaczony' : ''}" type="button" id="p-widok"
              aria-expanded="${planPanelOtwarty}">Widok${
        ileUstawienWidoku() ? ` (${ileUstawienWidoku()})` : ''} ${planPanelOtwarty ? '▴' : '▾'}</button>
      <div class="skala">
        <input type="range" id="p-skala" min="0" max="2" step="1" value="${planSkala}"
               aria-label="Gęstość osi czasu">
        <span>${SKALE_PLANU[planSkala].opis}</span>
      </div>
    </div>
    ${planPanelOtwarty ? panelWidoku() : ''}`;
}

// Ile ustawień odbiega od domyślnych — licznik przy przycisku mówi, że coś
// jest schowane, zanim użytkownik zacznie się zastanawiać, czemu wykres
// wygląda inaczej, niż pamięta.
function ileUstawienWidoku() {
  return planProjekty.size + (planZrobione ? 1 : 0) + (planSzerokieNazwy ? 1 : 0);
}

function panelWidoku() {
  const projekty = zadania.filter((z) => z.projekt && z.parent_id == null);
  return `
    <div class="panel-widoku">
      <div class="filtry">
        <button class="chip" type="button" id="p-zrobione" aria-pressed="${planZrobione}">
          Zrobione</button>
        <button class="chip" type="button" id="p-nazwy" aria-pressed="${planSzerokieNazwy}">
          Szersze nazwy</button>
      </div>
      ${projekty.length ? `
        <div class="filtry" id="p-projekty">
          <button class="chip" type="button" data-proj="" aria-pressed="${!planProjekty.size}">
            Wszystko</button>
          ${projekty.map((p) => `<button class="chip" type="button" data-proj="${p.id}"
              aria-pressed="${planProjekty.has(p.id)}">${esc(p.tytul)}</button>`).join('')}
        </div>` : ''}
    </div>`;
}


function podepnijNaglowekPlanu() {
  const widokBtn = document.getElementById('p-widok');
  if (widokBtn) widokBtn.onclick = () => { planPanelOtwarty = !planPanelOtwarty; rysujPlan(); };
  const zr = document.getElementById('p-zrobione');
  if (zr) zr.onclick = () => { planZrobione = !planZrobione; wczytajPlan(); };
  const nz = document.getElementById('p-nazwy');
  // Sama szerokość kolumny nie zmienia danych — przerysowujemy bez pytania serwera.
  if (nz) nz.onclick = () => { planSzerokieNazwy = !planSzerokieNazwy; rysujPlan(); };
  const fp = document.getElementById('p-projekty');
  if (fp) fp.onclick = (ev) => {
    const b = ev.target.closest('[data-proj]');
    if (!b) return;
    const id = b.dataset.proj;
    if (!id) planProjekty.clear();                  // „Wszystko" zdejmuje zawężenie
    else if (planProjekty.has(Number(id))) planProjekty.delete(Number(id));
    else planProjekty.add(Number(id));
    rysujPlan();                                     // filtr działa na już pobranych danych
  };
  const sk = document.getElementById('p-skala');
  // Sama skala nie zmienia danych, więc przerysowujemy bez pytania serwera.
  if (sk) sk.oninput = (ev) => { planSkala = Number(ev.target.value); rysujPlan(); };
}

// Delikatne pasy pod weekendami — dają rytm tygodnia, bez którego nie widać,
// czy termin nie wypada w sobotę. Rysowane jako tło, pod belkami i strzałkami.
//
// Przy najrzadszej skali (trzy piksele na dzień) pasy zlewałyby się w szarą
// kaszę i wykres stałby się mniej czytelny, nie bardziej — wtedy ich nie ma.
function pasyWeekendow(od, dni, px) {
  if (px < 6) return '';
  const pasy = [];
  const kursor = new Date(od);
  for (let i = 0; i < dni; i++) {
    const dzien = kursor.getDay();          // 0 = niedziela, 6 = sobota
    if (dzien === 6 || dzien === 0) {
      pasy.push(`<div class="gantt-weekend" style="left:calc(var(--nazwa) + ${
        Math.round(i * px)}px); width:${Math.round(px)}px"></div>`);
    }
    kursor.setDate(kursor.getDate() + 1);
  }
  return pasy.join('');
}

function osCzasu(od, dni, px) {
  // Podpisy miesięcy — przy gęstej skali dokładamy tygodnie, przy rzadkiej
  // zostają same miesiące, bo etykiety zlewałyby się w kreskę.
  const czesci = [];
  const kursor = new Date(od);
  kursor.setDate(1);
  while (kursor <= new Date(od.getTime() + dni * DZIEN_MS)) {
    const nast = new Date(kursor.getFullYear(), kursor.getMonth() + 1, 1);
    const start = Math.max(0, Math.round((kursor - od) / DZIEN_MS));
    const koniec = Math.min(dni, Math.round((nast - od) / DZIEN_MS));
    const szerokosc = Math.round((koniec - start) * px);
    if (szerokosc > 0) {
      const nazwa = kursor.toLocaleDateString('pl-PL', { month: 'short', year: '2-digit' });
      czesci.push(`<div class="gantt-miesiac" style="left:${Math.round(start * px)}px;
        width:${szerokosc}px">${szerokosc > 46 ? esc(nazwa) : ''}</div>`);
    }
    kursor.setMonth(kursor.getMonth() + 1);
  }
  return czesci.join('');
}

function wierszPlanu(poz, od, px, szer, dzis) {
  const z = poz.z;
  const zakresZ = zakresZadania(z);
  const wciecie = Math.min(poz.poziom, 3) * 12;
  const etykieta = `<div class="gantt-nazwa" style="padding-left:${8 + wciecie}px"
      data-otworz="${z.id}" title="${esc(z.tytul)}">${
    z.projekt ? '<span class="gantt-projekt"></span>' : ''}${esc(z.tytul)}</div>`;

  if (!zakresZ) {
    // Przodek bez własnych dat: pokazujemy nazwę, żeby dzieci miały kontekst,
    // ale nie rysujemy belki — nie byłoby jej gdzie postawić.
    return `<div class="gantt-wiersz">${etykieta}
      <div class="gantt-tor" style="width:${szer}px"></div></div>`;
  }

  const start = Math.round((zakresZ.start - od) / DZIEN_MS);
  const dlugosc = Math.max(1, Math.round((zakresZ.koniec - zakresZ.start) / DZIEN_MS) + 1);
  const spozniony = z.status === 'otwarte' && zakresZ.koniec < dzis;
  const klasy = ['gantt-belka'];
  if (z.status === 'zrobione') klasy.push('zrobiona');
  if (spozniony) klasy.push('po-czasie');
  if (z.projekt) klasy.push('projekt');
  // Kamień milowy to punkt w czasie, nie odcinek — rysujemy romb zamiast belki.
  // Klasa `gantt-kamien`, a NIE `kamien`: ta druga jest już zajęta przez mały
  // romb przy tytule na liście zadań i nadpisywała belce kolor oraz szerokość.
  if (z.kamien_milowy) klasy.push('gantt-kamien');

  const podpis = dlugosc * px > 54 ? `<span>${esc(dataKrotka(zakresZ.koniec))}</span>` : '';
  // Uchwyty krawędzi tylko tam, gdzie mają sens: kamień milowy jest punktem,
  // więc nie ma czego rozciągać, a zadanie zamknięte przesuwa się rzadko
  // i przypadkowe pociągnięcie zmieniałoby historię.
  const uchwyty = !z.kamien_milowy && z.status !== 'zrobione'
    ? '<i class="uchwyt lewy" data-uchwyt="start"></i><i class="uchwyt prawy" data-uchwyt="koniec"></i>'
    : '';
  // Kropka do wyciągania zależności. Osobny uchwyt, a NIE zwykłe przeciąganie
  // belki na belkę: to samo pociągnięcie musiałoby znaczyć dwie różne rzeczy
  // („przesuń w czasie" i „połącz"), a wtedy nigdy nie wiadomo, co się stanie.
  const lacznik = '<i class="lacznik" data-lacznik="' + z.id + '" title="Pociągnij na inne zadanie, żeby ustawić kolejność"></i>';
  return `<div class="gantt-wiersz">${etykieta}
    <div class="gantt-tor" style="width:${szer}px">
      <!-- Minimum 16 px szerokości: przy skali „cały plan" jeden dzień to
           trzy piksele, czyli kreska, której nie da się chwycić palcem ani
           nawet zauważyć. -->
      <div class="${klasy.join(' ')}" data-otworz="${z.id}" data-belka="${z.id}"
           style="left:${Math.round(start * px)}px; width:${Math.max(16, Math.round(dlugosc * px))}px"
           title="${esc(z.tytul)} — ${dataKrotka(zakresZ.start)} → ${dataKrotka(zakresZ.koniec)}">
        ${uchwyty}${lacznik}${podpis}
      </div>
    </div></div>`;
}

function dataKrotka(d) {
  return d.toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit' });
}

const WYS_WIERSZA = 38;

// Strzałki „skończ, zanim zaczniesz". Rysowane jako jedno SVG na całą siatkę,
// a nie element per para — przy kilkunastu powiązaniach osobne elementy
// zaczynają się rozjeżdżać przy przewijaniu.
//
// Powiązanie NARUSZONE (następnik zaczyna się przed końcem poprzednika)
// rysujemy na czerwono. To jedyny moment, w którym plan sam mówi, że się nie
// domyka — bez tego zależność byłaby ozdobą, a nie narzędziem.
function strzalkiZaleznosci(wiersze, rzedy, od, px, szer) {
  if (!zaleznosci.length) return '';
  const wg = new Map(wiersze.map((w) => [w.z.id, w.z]));
  // `zakresZadania` zwraca gotowe obiekty Date, więc NIE przepuszczamy ich
  // przez `doDaty` — ta oczekuje tekstu „RRRR-MM-DD" i z obiektu Date robiła
  // NaN, przez co wszystkie ścieżki miały współrzędne NaN i nic się nie rysowało.
  const x = (data) => Math.round(((data - od) / DZIEN_MS) * px);

  const linie = [];
  for (const zal of zaleznosci) {
    const po = wg.get(zal.zadanie_id);
    const przed = wg.get(zal.poprzednik_id);
    if (!po || !przed) continue;                 // poza bieżącym filtrem
    const zPrzed = zakresZadania(przed);
    const zPo = zakresZadania(po);
    if (!zPrzed || !zPo) continue;

    const y1 = rzedy.get(przed.id) * WYS_WIERSZA + WYS_WIERSZA / 2;
    const y2 = rzedy.get(po.id) * WYS_WIERSZA + WYS_WIERSZA / 2;
    const x1 = x(zPrzed.koniec) + px;             // koniec poprzednika
    const x2 = x(zPo.start);                      // początek następnika
    const naruszone = zPo.start < zPrzed.koniec;
    const klasa = naruszone ? 'zal naruszona' : 'zal';
    // Łamana: w bok od poprzednika, w pionie do wiersza następnika, w bok do niego.
    const srodek = naruszone ? Math.min(x1, x2) - 10 : (x1 + x2) / 2;
    const sciezka = `M${x1} ${y1} H${srodek} V${y2} H${x2}`;
    const opis = `${przed.tytul} → ${po.tytul}${naruszone ? ' (kolejność naruszona)' : ''}`;
    // Gruba przezroczysta ścieżka pod widoczną — sama kreska ma 2 px i nie da
    // się w nią trafić palcem. Rysunek zostaje cienki, pole trafienia jest szerokie.
    linie.push(`<g class="zal-grupa" data-zal="${po.id}:${przed.id}">
        <title>${esc(opis)} — kliknij, żeby usunąć powiązanie</title>
        <path class="zal-trafienie" d="${sciezka}"/>
        <path class="${klasa}" d="${sciezka}"/>
        <circle class="${klasa}-grot" cx="${x2}" cy="${y2}" r="3.5"/>
      </g>`);
  }
  if (!linie.length) return '';
  const wysokosc = wiersze.length * WYS_WIERSZA;
  return `<svg class="gantt-zaleznosci" width="${szer}" height="${wysokosc}"
    style="left:var(--nazwa)" aria-hidden="true">${linie.join('')}</svg>`;
}

// ── przeciąganie belek ──────────────────────────────────────────────────────
//
// Pointer Events, a NIE HTML5 drag-and-drop: to drugie nie działa na dotyku,
// a wykres ogląda się głównie na telefonie. Jedno API obsługuje mysz i palec.
//
// Chwyt za środek przesuwa całość (start i termin razem, długość bez zmian),
// chwyt za krawędź zmienia jeden koniec. Zapisujemy dopiero po puszczeniu —
// żądanie na każdy piksel ruchu zalałoby serwer i migało listą.
let ostatnioCiagnieto = 0;
let zaznaczonaBelka = null;
let czasZaznaczenia = 0;

// Pasek nad wykresem z danymi zaznaczonego zadania. Zastępuje dymek `title`,
// którego na dotyku nie da się wywołać, i mówi to samo co najechanie myszą:
// co to za zadanie, od kiedy do kiedy, kto je robi i na co czeka.
function zaznaczBelke(id) {
  zaznaczonaBelka = id;
  czasZaznaczenia = Date.now();
  document.querySelectorAll('.gantt-belka.zaznaczona')
    .forEach((e) => e.classList.remove('zaznaczona'));
  document.querySelector(`[data-belka="${id}"]`)?.classList.add('zaznaczona');
  pokazPasekInfo(id);
}

function odznaczBelke() {
  zaznaczonaBelka = null;
  document.querySelectorAll('.gantt-belka.zaznaczona')
    .forEach((e) => e.classList.remove('zaznaczona'));
  const pasek = document.getElementById('gantt-info');
  if (pasek) pasek.hidden = true;
}

function pokazPasekInfo(id) {
  const pasek = document.getElementById('gantt-info');
  const z = zadania.find((x) => x.id === id);
  if (!pasek || !z) return;
  const zakresZ = zakresZadania(z);
  const czesci = [];
  if (zakresZ) {
    const jeden = zakresZ.start.getTime() === zakresZ.koniec.getTime();
    czesci.push(jeden ? dataPl(z.termin || z.data_start)
      : `${dataKrotka(zakresZ.start)} → ${dataKrotka(zakresZ.koniec)}`);
  }
  const wykonawca = (household?.members || []).find((m) => m.id === z.wykonawca_user_id);
  if (wykonawca) czesci.push(wykonawca.display_name || wykonawca.name);
  if (z.kamien_milowy) czesci.push('kamień milowy');
  if (z.powtarzaj) czesci.push(opisPowtarzania(z));

  // Powiązania jako PLAKIETKI Z KRZYŻYKIEM, nie jako tekst. Kliknięcie w samą
  // kreskę na wykresie działa, ale po zwężeniu jej pola trafienia (żeby nie
  // kradła stuknięć belkom) na telefonie jest loterią. Tu cel ma rozmiar palca.
  const czekaNa = zaleznosci.filter((x) => x.zadanie_id === id)
    .map((x) => ({ id: x.poprzednik_id, tytul: zadania.find((y) => y.id === x.poprzednik_id)?.tytul }))
    .filter((x) => x.tytul);

  pasek.hidden = false;
  pasek.innerHTML = `
    <div class="gi-tytul">${esc(z.tytul)}</div>
    <div class="gi-dane">${esc(czesci.join(' · '))}</div>
    ${czekaNa.length ? `<div class="gi-po">
      <span class="gi-po-etykieta">zaczyna się po:</span>
      ${czekaNa.map((p) => `<span class="chip wlaczony gi-zal">${esc(p.tytul)}
        <button type="button" data-zdejmij="${p.id}"
                aria-label="Usuń powiązanie z: ${esc(p.tytul)}">✕</button></span>`).join('')}
    </div>` : ''}
    <button class="btn btn-outline gi-otworz" type="button" data-otworz-info="${id}">Otwórz</button>`;

  pasek.querySelector('[data-otworz-info]').onclick = (e) => {
    e.stopPropagation();
    otworzSzczegoly(id);
  };
  pasek.querySelectorAll('[data-zdejmij]').forEach((b) => {
    b.onclick = async (e) => {
      e.stopPropagation();
      const poprzednik = Number(b.dataset.zdejmij);
      const r = await authFetch(
        `/api/task/zaleznosci?zadanie_id=${id}&poprzednik_id=${poprzednik}`, { method: 'DELETE' });
      if (!r.ok) { toast('Nie udało się usunąć powiązania.', 'blad'); return; }
      await wczytajPlan();
      // Zaznaczenie zostaje — po zdjęciu jednego powiązania często zdejmuje się
      // kolejne, a zniknięcie paska kazałoby zaczynać od nowa.
      zaznaczBelke(id);
    };
  });
}

// GRANICE WYNIKAJĄCE Z ZALEŻNOŚCI. Skoro „B po A", to B nie ma prawa zacząć
// się przed końcem A — a skoro „C po B", to B nie ma prawa skończyć się po
// starcie C. Bez tego strzałki byłyby rysunkiem: pokazywałyby powiązanie,
// którego nic nie pilnuje.
//
// Zwraca daty graniczne (ISO) albo null, gdy z danej strony nic nie ogranicza.
function graniceZadania(id) {
  const wg = new Map(zadania.map((z) => [z.id, z]));
  let najwczesniejszyStart = null;
  let najpozniejszyKoniec = null;

  for (const zal of zaleznosci) {
    if (zal.zadanie_id === id) {
      const p = wg.get(zal.poprzednik_id);
      const zp = p && zakresZadania(p);
      if (!zp) continue;
      const dzien = isoLokalne(new Date(zp.koniec.getTime() + DZIEN_MS));
      if (!najwczesniejszyStart || dzien > najwczesniejszyStart) najwczesniejszyStart = dzien;
    }
    if (zal.poprzednik_id === id) {
      const n = wg.get(zal.zadanie_id);
      const zn = n && zakresZadania(n);
      if (!zn) continue;
      const dzien = isoLokalne(new Date(zn.start.getTime() - DZIEN_MS));
      if (!najpozniejszyKoniec || dzien < najpozniejszyKoniec) najpozniejszyKoniec = dzien;
    }
  }
  return { od: najwczesniejszyStart, do: najpozniejszyKoniec };
}

function przeciaganieBelek(g) {
  let stan = null;

  const dniZPikseli = (px) => Math.round(px / planOs.px);

  // ── łączenie zadań wprost na wykresie ────────────────────────────────────
  // Pociągnięcie z kropki na końcu belki na inną belkę ustawia kolejność:
  // „to drugie zacznie się dopiero, gdy pierwsze się skończy". Bez tego jedyną
  // drogą było wejście w szczegóły i szukanie zadania na liście rozwijanej.
  let laczenie = null;

  g.addEventListener('pointerdown', (ev) => {
    const start = ev.target.closest('[data-lacznik]');
    if (start) {
      ev.preventDefault();
      ev.stopPropagation();
      laczenie = { od: Number(start.dataset.lacznik), el: null };
      g.classList.add('laczy');
      return;
    }
    const belka = ev.target.closest('[data-belka]');
    if (!belka) return;
    const uchwyt = ev.target.closest('[data-uchwyt]');
    const id = Number(belka.dataset.belka);
    const z = zadania.find((x) => x.id === id);
    if (!z) return;
    // Bariery przeliczone na piksele — żeby belka zatrzymywała się już
    // w trakcie ciągnięcia, a nie dopiero odskakiwała po puszczeniu.
    const gr = graniceZadania(id);
    const naX = (data) => data ? Math.round(((doDaty(data) - planOs.od) / DZIEN_MS) * planOs.px) : null;
    stan = {
      id, belka, tryb: uchwyt ? uchwyt.dataset.uchwyt : 'calosc',
      startX: ev.clientX,
      lewo0: parseFloat(belka.style.left) || 0,
      szer0: parseFloat(belka.style.width) || 0,
      start0: z.data_start || z.termin,
      koniec0: z.termin || z.data_start,
      minLewo: naX(gr.od),
      maxPrawo: gr.do ? naX(gr.do) + planOs.px : null,
      ruszony: false,
    };
    belka.setPointerCapture(ev.pointerId);
    belka.classList.add('ciagniona');
  });

  g.addEventListener('pointermove', (ev) => {
    if (laczenie) {
      // Podświetlamy belkę pod kursorem — bez tego nie wiadomo, na co się celuje.
      const cel = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-belka]');
      if (laczenie.el !== cel) {
        laczenie.el?.classList.remove('cel-laczenia');
        laczenie.el = cel && Number(cel.dataset.belka) !== laczenie.od ? cel : null;
        laczenie.el?.classList.add('cel-laczenia');
      }
      return;
    }
    if (!stan) return;
    const dx = ev.clientX - stan.startX;
    // Próg kilku pikseli: bez niego zwykłe stuknięcie w belkę (otwarcie
    // szczegółów) liczyłoby się jako przeciągnięcie o zero dni i zapisywało.
    if (!stan.ruszony && Math.abs(dx) < 4) return;
    stan.ruszony = true;
    const przyBarierze = (jest) => stan.belka.classList.toggle('zablokowana', jest);
    if (stan.tryb === 'calosc') {
      let lewo = stan.lewo0 + dx;
      let blok = false;
      if (stan.minLewo != null && lewo < stan.minLewo) { lewo = stan.minLewo; blok = true; }
      if (stan.maxPrawo != null && lewo + stan.szer0 > stan.maxPrawo) {
        lewo = stan.maxPrawo - stan.szer0; blok = true;
      }
      stan.belka.style.left = lewo + 'px';
      przyBarierze(blok);
    } else if (stan.tryb === 'start') {
      // Belka nie może zniknąć: minimalna szerokość to jeden dzień.
      let lewo = stan.lewo0 + dx;
      let blok = false;
      if (stan.minLewo != null && lewo < stan.minLewo) { lewo = stan.minLewo; blok = true; }
      const prawo = stan.lewo0 + stan.szer0;
      if (lewo > prawo - planOs.px) lewo = prawo - planOs.px;
      stan.belka.style.left = lewo + 'px';
      stan.belka.style.width = (prawo - lewo) + 'px';
      przyBarierze(blok);
    } else {
      let prawo = stan.lewo0 + stan.szer0 + dx;
      let blok = false;
      if (stan.maxPrawo != null && prawo > stan.maxPrawo) { prawo = stan.maxPrawo; blok = true; }
      if (prawo < stan.lewo0 + planOs.px) prawo = stan.lewo0 + planOs.px;
      stan.belka.style.width = (prawo - stan.lewo0) + 'px';
      przyBarierze(blok);
    }
  });

  const puszczono = async (ev) => {
    if (laczenie) {
      const cel = laczenie.el;
      const od = laczenie.od;
      laczenie.el?.classList.remove('cel-laczenia');
      laczenie = null;
      g.classList.remove('laczy');
      ostatnioCiagnieto = Date.now();
      if (!cel) return;
      const doId = Number(cel.dataset.belka);
      const r = await authFetch('/api/task/zaleznosci', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ zadanie_id: doId, poprzednik_id: od }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        toast(e.detail || 'Nie udało się połączyć zadań.', 'blad');
        return;
      }
      toast('Ustawiono kolejność.', 'ok');
      await wczytajPlan();
      return;
    }
    if (!stan) return;
    const s = stan;
    stan = null;
    s.belka.classList.remove('ciagniona');
    if (!s.ruszony) return;              // to było stuknięcie, nie przeciągnięcie
    ostatnioCiagnieto = Date.now();

    const dx = ev.clientX - s.startX;
    const dni = dniZPikseli(dx);
    // `isoLokalne`, a NIE toISOString(): ta druga przelicza na UTC, więc
    // w naszej strefie zwracałaby dzień wcześniejszy i każde przeciągnięcie
    // przesuwałoby zadanie o dobę za daleko.
    const przesun = (data, o) => {
      if (!data) return null;
      const d = new Date(String(data).slice(0, 10) + 'T00:00:00');
      d.setDate(d.getDate() + o);
      return isoLokalne(d);
    };

    let nowyStart = s.start0;
    let nowyKoniec = s.koniec0;
    if (s.tryb === 'calosc') {
      nowyStart = przesun(s.start0, dni);
      nowyKoniec = przesun(s.koniec0, dni);
    } else if (s.tryb === 'start') {
      nowyStart = przesun(s.start0, dni);
      if (nowyStart > nowyKoniec) nowyStart = nowyKoniec;
    } else {
      nowyKoniec = przesun(s.koniec0, dni);
      if (nowyKoniec < nowyStart) nowyKoniec = nowyStart;
    }

    // Przycięcie do granic z zależności. Przy przesuwaniu CAŁOŚCI zachowujemy
    // długość — dosuwamy zadanie do bariery zamiast je ściskać, bo użytkownik
    // przesuwa termin, a nie skraca pracę.
    const gr = graniceZadania(s.id);
    let odbite = null;
    if (gr.od && nowyStart < gr.od) {
      const roznica = Math.round((doDaty(gr.od) - doDaty(nowyStart)) / DZIEN_MS);
      nowyStart = gr.od;
      if (s.tryb === 'calosc') nowyKoniec = przesun(nowyKoniec, roznica);
      odbite = 'poprzednik';
    }
    if (gr.do && nowyKoniec > gr.do) {
      const roznica = Math.round((doDaty(nowyKoniec) - doDaty(gr.do)) / DZIEN_MS);
      nowyKoniec = gr.do;
      if (s.tryb === 'calosc') nowyStart = przesun(nowyStart, -roznica);
      odbite = 'nastepnik';
    }
    // Skrajny przypadek: bariery z obu stron ciaśniejsze niż długość zadania.
    // Wtedy nie da się go zmieścić — mówimy o tym zamiast zapisywać bzdurę.
    if (nowyStart && nowyKoniec && nowyStart > nowyKoniec) {
      toast('Zadanie nie mieści się między zadaniami, z którymi jest powiązane.', 'blad');
      rysujPlan();
      return;
    }
    if (odbite) {
      toast(odbite === 'poprzednik'
        ? 'Nie może zacząć się przed końcem zadania, na które czeka.'
        : 'Nie może skończyć się po starcie zadania, które na nie czeka.', 'ok');
    }
    if (nowyStart === s.start0 && nowyKoniec === s.koniec0) { rysujPlan(); return; }

    const z = zadania.find((x) => x.id === s.id);
    const ok = await zapiszSzczegoly(s.id, {
      tytul: z.tytul, opis: z.opis || null,
      // Zadanie, które miało sam termin, po rozciągnięciu dostaje początek —
      // ale samo przesunięcie nie ma go dorabiać, bo punkt ma zostać punktem.
      data_start: s.tryb === 'calosc' && !z.data_start ? null : nowyStart,
      termin: nowyKoniec,
      pora: z.pora || null,
      wykonawca_user_id: z.wykonawca_user_id || null,
      wykonawca_virtual_id: z.wykonawca_virtual_id || null,
      kamien_milowy: !!z.kamien_milowy,
      projekt: !!z.projekt,
      powtarzaj: z.powtarzaj || null,
      powtarzaj_co: z.powtarzaj_co || 1,
    }, true);
    if (ok) await wczytajPlan(); else rysujPlan();
  };

  g.addEventListener('pointerup', puszczono);
  g.addEventListener('pointercancel', () => { if (stan) { stan.belka.classList.remove('ciagniona'); stan = null; rysujPlan(); } });
}

// Oś z miesiącami musi jechać RAZEM z wykresem. Stoi w osobnym pojemniku
// (żeby nie przewijała się w pionie razem z wierszami), więc jej przesunięcie
// trzeba dowiązać ręcznie — inaczej przy przewinięciu do listopada podpisy
// wciąż pokazują sierpień i wykres kłamie.
function zsynchronizujOs(g) {
  const body = g.querySelector('.gantt-body');
  const tresc = g.querySelector('.gantt-osie-tresc');
  if (!body || !tresc) return;
  const przesun = () => { tresc.style.transform = `translateX(${-body.scrollLeft}px)`; };
  body.addEventListener('scroll', przesun, { passive: true });
  przesun();
}

// Chwytanie TŁA i przeciąganie w bok. Na komputerze wykres nie miał żadnego
// oczywistego sposobu przewijania: pasek jest na dole długiej strony, a kółko
// myszy przewija stronę, nie oś. Teraz działa jak mapa.
function przeciaganieTla(g) {
  const body = g.querySelector('.gantt-body');
  if (!body) return;
  let start = null;

  body.addEventListener('pointerdown', (ev) => {
    // Belki, uchwyty i łączniki mają własną obsługę — tło to wszystko poza nimi.
    if (ev.target.closest('[data-belka], [data-lacznik], [data-zal]')) return;
    start = { x: ev.clientX, scroll: body.scrollLeft };
    body.classList.add('przesuwany');
  });
  body.addEventListener('pointermove', (ev) => {
    if (!start) return;
    body.scrollLeft = start.scroll - (ev.clientX - start.x);
  });
  const koniec = () => { start = null; body.classList.remove('przesuwany'); };
  body.addEventListener('pointerup', koniec);
  body.addEventListener('pointerleave', koniec);
  body.addEventListener('pointercancel', koniec);
}

function podepnijBelki() {
  const g = document.querySelector('.gantt');
  if (!g) return;
  zsynchronizujOs(g);
  przeciaganieTla(g);
  przeciaganieBelek(g);
  g.onclick = async (ev) => {
    // Kliknięcie tuż po przeciągnięciu nie ma otwierać szczegółów — przeglądarka
    // wysyła `click` po każdym `pointerup`, więc bez tego każde przesunięcie
    // belki kończyłoby się skokiem do formularza.
    if (Date.now() - ostatnioCiagnieto < 400) return;

    // BELKA MA PIERWSZEŃSTWO nad strzałką. Gdy stuknięcie trafia w oba
    // (linia przechodzi pod wąskim zadaniem), użytkownik prawie zawsze celuje
    // w zadanie — a przypadkowe pytanie o usunięcie powiązania jest znacznie
    // bardziej uciążliwe niż konieczność trafienia w linię obok belki.
    const belkaPodKursorem = ev.target.closest('[data-belka]');

    // Kliknięcie w strzałkę zdejmuje powiązanie — z pytaniem, bo to jedyny
    // ruch na wykresie, którego nie widać od razu po skutkach.
    const zal = !belkaPodKursorem && ev.target.closest('[data-zal]');
    if (zal) {
      const [doId, odId] = zal.dataset.zal.split(':').map(Number);
      const wg = new Map(zadania.map((z) => [z.id, z]));
      const czy = await potwierdz({
        tytul: 'Usunąć powiązanie?',
        tresc: `„${wg.get(odId)?.tytul || '?'}" przestanie blokować „${wg.get(doId)?.tytul || '?'}". `
             + 'Daty zostaną bez zmian.',
        tak: 'Usuń powiązanie', groznie: true,
      });
      if (!czy) return;
      const r = await authFetch(
        `/api/task/zaleznosci?zadanie_id=${doId}&poprzednik_id=${odId}`, { method: 'DELETE' });
      if (!r.ok) { toast('Nie udało się usunąć powiązania.', 'blad'); return; }
      await wczytajPlan();
      return;
    }

    const b = ev.target.closest('[data-otworz]');
    if (!b) { odznaczBelke(); return; }
    const id = Number(b.dataset.otworz);

    // PIERWSZE stuknięcie POKAZUJE, drugie OTWIERA. Na telefonie nie ma
    // najeżdżania kursorem, więc jedynym sposobem sprawdzenia, co to za belka,
    // było otwarcie formularza i wyjście z niego. Teraz stuknięcie zaznacza
    // zadanie i wypisuje jego dane nad wykresem, a formularz wymaga potwierdzenia
    // drugim stuknięciem.
    const teraz = Date.now();
    if (zaznaczonaBelka === id && teraz - czasZaznaczenia < 3000) {
      otworzSzczegoly(id);
      return;
    }
    zaznaczBelke(id);
  };
  // Widok startuje na dzisiejszym dniu, a nie na początku osi: plan zwykle
  // sięga wstecz, a interesuje to, co teraz i dalej.
  const tor = g.querySelector('.gantt-body');
  const dzisEl = g.querySelector('.gantt-dzis');
  if (tor && dzisEl) tor.scrollLeft = Math.max(0, dzisEl.offsetLeft - 120);
}

function rysujLista() {
  // Zadanie mogło zniknąć (usunięte albo wypadło z bieżącego zakresu) —
  // wtedy wracamy na korzeń całego drzewa zamiast pokazać pustkę bez wyjścia.
  if (korzen != null && !zadania.some((z) => z.id === korzen)) korzen = null;
  const drzewo = budujDrzewo(zadania);
  const aktualny = korzen != null ? drzewo.flatMap(splaszcz).find((x) => x.id === korzen) : null;
  if (korzen != null && !aktualny) korzen = null;
  const lista = aktualny ? aktualny.dzieci : drzewo;

  box().innerHTML = `
    <div class="gora"><h1>Zadania</h1></div>
    <div class="filtry" id="f-zakres">
      ${ZAKRESY.map(([k, l]) => `<button class="chip" type="button" data-z="${k}"
          aria-pressed="${k === zakres}">${l}</button>`).join('')}
    </div>
    ${okruszki()}
    ${korzen == null ? panelProjektow() : ''}
    ${aktualny ? nagKorzenia(aktualny) : ''}
    <!-- Pole mówi WPROST, gdzie trafi wpis. Wcześniej wyglądało tak samo
         niezależnie od tego, czy dodaje zadanie główne, czy krok w środku
         czegoś — i po wejściu w zadanie nie było wiadomo, co się właściwie
         stanie z wpisanym tekstem. -->
    <form class="szybkie${aktualny ? ' w-srodku' : ''}" id="szybkie">
      <input id="sz-tytul" autocomplete="off"
             placeholder="${aktualny ? `Nowy krok w: ${esc(aktualny.tytul)}` : 'Co jest do zrobienia?'}">
      ${mowaDostepna() ? `<button class="btn btn-outline btn-mikrofon" type="button"
          id="sz-mowa" title="Podyktuj zadanie" aria-label="Podyktuj zadanie">
          ${ikonaSvg('mikrofon')}</button>` : ''}
      <button class="btn btn-primary" type="submit">Dodaj</button>
    </form>
    <div class="zadania">${lista.map((w) => wiersz(w, 0)).join('') ||
      '<p class="pusto">Nic tu nie ma. Wpisz pierwsze zadanie powyżej.</p>'}</div>`;

  document.getElementById('f-zakres').onclick = (ev) => {
    const b = ev.target.closest('[data-z]');
    if (!b) return;
    zakres = b.dataset.z;
    nowyId = null;
    wczytaj();
  };
  const okr = document.querySelector('.okruszki');
  if (okr) okr.onclick = (ev) => {
    const b = ev.target.closest('[data-okr]');
    if (!b) return;
    korzen = b.dataset.okr ? Number(b.dataset.okr) : null;
    nowyId = null;
    rysuj();
  };
  const panel = document.querySelector('.projekty');
  if (panel) panel.onclick = (ev) => {
    const b = ev.target.closest('[data-projekt]');
    if (!b) return;
    korzen = Number(b.dataset.projekt);   // wejście w projekt, jak strzałką
    nowyId = null;
    rysuj();
  };
  const korzenBtn = document.getElementById('korzen-szczegoly');
  if (korzenBtn) korzenBtn.onclick = () => otworzSzczegoly(aktualny.id);
  const btnMowa = document.getElementById('sz-mowa');
  if (btnMowa) btnMowa.onclick = () => dyktuj(btnMowa);
  document.getElementById('szybkie').onsubmit = async (ev) => {
    ev.preventDefault();
    const pole = document.getElementById('sz-tytul');
    const t = pole.value;
    if (!t.trim()) return;
    const r = await authFetch('/api/task/zadania', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tytul: t.trim(), parent_id: korzen }),
    });
    if (r.ok) {
      const j = await r.json().catch(() => ({}));
      pole.value = '';
      nowyId = j.id || null;
      await wczytaj();
      // Zadanie bez terminu trafia do „Nadchodzących", więc dodane na zakładce
      // „Dziś" znikało bez śladu i wyglądało, jakby zapis się nie udał.
      // Przechodzimy tam, gdzie faktycznie wylądowało, i mówimy o tym.
      if (nowyId && !zadania.some((z) => z.id === nowyId)) {
        zakres = 'nadchodzace';
        await wczytaj();
        toast('Zadanie bez terminu — trafiło do „Nadchodzących".', 'ok');
      }
    } else {
      toast('Nie udało się zapisać zadania.', 'blad');
    }
  };
  podepnijPtaszki();
}

// STRUKTURA JEST ZAGNIEŻDŻONA, NIE PŁASKA. Wcześniej każdy wiersz dostawał
// tylko lewy odstęp i po dwóch poziomach wszystko wyglądało jak jedna lista —
// nie było widać, co jest częścią czego. Teraz dzieci siedzą w osobnym
// pojemniku z pionową linią, więc przynależność widać bez liczenia pikseli.
// Przegląd przedsięwzięć na górze listy. Bez niego projekt jest jednym
// z wielu wierszy i ginie między pojedynczymi sprawami, a najczęstsze pytanie
// brzmi „jak stoi remont", nie „co jest na liście".
//
// Pokazujemy tylko na najwyższym poziomie: w środku projektu byłby powtórzeniem
// tego, w czym użytkownik właśnie siedzi.
function panelProjektow() {
  const projekty = zadania.filter((z) => z.projekt && z.parent_id == null);
  if (!projekty.length) return '';
  const dzis = dzisIso();
  return `
    <div class="projekty">
      ${projekty.map((p) => {
        const post = postep(p);
        const proc = post.razem ? Math.round((post.gotowe / post.razem) * 100) : 0;
        // Ile kroków w środku jest już po terminie — to jedyna liczba, która
        // mówi, czy projekt wymaga uwagi DZIŚ, a nie kiedyś.
        const spoznione = zadania.filter((z) => z.status === 'otwarte' && z.termin
          && String(z.termin).slice(0, 10) < dzis && naleziDo(z, p.id)).length;
        return `
          <button class="projekt-kafel" type="button" data-projekt="${p.id}">
            <div class="pk-gora">
              <span class="pk-nazwa">${esc(p.tytul)}</span>
              ${p.termin ? `<span class="pk-termin">${dataPl(p.termin)}</span>` : ''}
            </div>
            <div class="pk-pasek"><i style="width:${proc}%"></i></div>
            <div class="pk-dol">
              <span>${post.gotowe} z ${post.razem} · ${proc}%</span>
              ${spoznione ? `<span class="pk-spoznione">${spoznione} po terminie</span>` : ''}
            </div>
          </button>`;
      }).join('')}
    </div>`;
}

// Czy zadanie leży w poddrzewie danego projektu.
function naleziDo(z, projektId) {
  const wg = new Map(zadania.map((x) => [x.id, x]));
  let x = z;
  const widziane = new Set();
  while (x && !widziane.has(x.id)) {
    if (x.id === projektId) return true;
    widziane.add(x.id);
    x = x.parent_id != null ? wg.get(x.parent_id) : null;
  }
  return false;
}

function wiersz(w, poziom) {
  const p = postep(w);
  const nast = p.razem && w.status !== 'zrobione' ? nastepnyKrok(w) : {};
  const spozniony = w.termin && w.status === 'otwarte' &&
    w.termin.slice(0, 10) < dzisIso();
  const maDzieci = (w.dzieci || []).length > 0;
  return `
    <div class="zad-galaz">
      <div class="zad${w.status === 'zrobione' ? ' zrobione' : ''}" data-zad="${w.id}">
        <!-- Nazwa dostaje CAŁĄ szerokość, kafelki idą pod nią. Ustawione obok
             siebie walczyły o miejsce: tytuł łamał się na trzy linijki, więc
             wiersz i tak był wysoki — tylko brzydziej. -->
        <div class="zad-glowna">
        <button class="ptaszek" type="button" data-ptaszek="${w.id}"
                aria-label="Odhacz zadanie">${w.status === 'zrobione' ? ikonaSvg('ptaszek') : ''}</button>
        <div class="zad-tresc">
          <div class="zad-tytul">${w.kamien_milowy ? '<span class="kamien"></span>' : ''}${esc(w.tytul)}${
            w.powtarzaj ? `<span class="zad-cykl" title="Po odhaczeniu wróci ${esc(opisPowtarzania(w))}">${
              esc(opisPowtarzania(w))}</span>` : ''}</div>
          ${nast.tytul ? `<div class="zad-nast">następne: ${esc(nast.tytul)}</div>` : ''}
        </div>
        <!-- Licznik postępu zwija i rozwija kroki. „2 z 5" samo mówi, że w
             środku coś jest, więc stuknięcie w nie po to, żeby to schować albo
             pokazać, nie wymaga tłumaczenia. Daszek pokazuje, w którą stronę. -->
        ${p.razem && !w.kamien_milowy ? `<button class="zad-postep${
            zwiniete.has(w.id) ? ' zwiniety' : ''}" type="button" data-zwin="${w.id}"
            title="${zwiniete.has(w.id) ? 'Pokaż kroki' : 'Zwiń kroki'}"
            >${p.gotowe} z ${p.razem}<span class="zad-daszek">›</span></button>` : ''}
        </div>
        <!-- SZYBKIE POLA bez wchodzenia w formularz. Termin i wykonawca to
             dwie rzeczy ustawiane najczęściej, a dotąd wymagały otwarcia
             szczegółów i przewijania. Data jest jednocześnie etykietą: gdy jest
             ustawiona, widać ją zamiast ikony. -->
        <div class="zad-akcje">
        <label class="zad-data${w.termin ? (spozniony ? ' po-czasie' : ' jest') : ''}"
               title="Termin">
          ${w.termin ? dataKrotka(w.termin) : ikonaSvg('kalendarz')}
          <input type="date" data-termin="${w.id}" value="${esc((w.termin || '').slice(0, 10))}">
        </label>
        <label class="zad-kto${w.wykonawca_user_id ? ' jest' : ''}" title="Wykonawca">
          ${skrotWykonawcy(w)}
          <select data-wykonawca="${w.id}">${opcjeWykonawcyKrotkie(w)}</select>
        </label>
        <!-- „+” dopisuje krok BEZ opuszczania listy. Wcześniej jedyną drogą
             było wejście strzałką w zadanie, co przy dopisywaniu trzech kroków
             pod rząd znaczyło trzy razy wejść i wyjść. -->
        <button class="zad-plus" type="button" data-dodaj="${w.id}"
                aria-label="Dodaj krok w tym zadaniu" title="Dodaj krok">+</button>
        <button class="zad-plus zad-komentarz${w.ile_komentarzy ? ' jest' : ''}" type="button"
                data-komentarze="${w.id}" title="Dziennik zadania"
                aria-label="Dziennik zadania">${
          w.ile_komentarzy ? w.ile_komentarzy : ikonaSvg('notatka')}</button>
        <!-- Trzy kropki, nie strzałka. Strzałka „›" obiecywała przejście dalej,
             a szczegóły to okno z formularzem — kropki nie obiecują kierunku,
             tylko „jest tu więcej". -->
        <button class="zad-kropki" type="button" data-szczegoly="${w.id}"
                aria-label="Szczegóły zadania" title="Szczegóły">${ikonaSvg('kropki')}</button>
        </div>
      </div>
      <div class="zad-dzieci${maDzieci ? '' : ' pusta'}">
        <!-- Pole dopisywania kroku wskakuje TUTAJ, czyli w miejscu, w którym
             krok faktycznie się pojawi — nie na górze ekranu. -->
        <!-- Przycisk obok pola, nie sam Enter: „wpisz i naciśnij Enter" to
             wiedza, której nikt nie ma, dopóki mu się nie powie. -->
        <div class="zad-dopisz" id="dopisz-${w.id}" hidden>
          <input placeholder="Nowy krok…" data-pole-dodaj="${w.id}" autocomplete="off">
          <button class="btn btn-primary btn-dopisz" type="button"
                  data-zatwierdz-dodaj="${w.id}">Dodaj</button>
        </div>
        <!-- Dziennik: wpisy z datami, od najstarszego. Treść dociągana przy
             otwarciu, żeby lista nie wołała serwera o komentarze wszystkich
             zadań naraz. -->
        <div class="zad-dziennik" id="dziennik-${w.id}" hidden></div>
        <!-- Kroki w osobnym pojemniku, bo zwijanie ma chować JE, a nie pole
             dopisywania i dziennik — te muszą działać także przy zwiniętym
             zadaniu. -->
        <div class="zad-podkroki"${zwiniete.has(w.id) ? ' hidden' : ''}>${
          (w.dzieci || []).map((d) => wiersz(d, poziom + 1)).join('')}</div>
      </div>
    </div>`;
}

// Inicjały wykonawcy albo ikona osoby, gdy nikt nie przypisany. Pełne imię
// nie mieści się w wierszu obok tytułu, a i tak najczęściej wystarczy wiedzieć,
// czy to Ty, czy ktoś inny.
function skrotWykonawcy(w) {
  const osoby = household?.members || [];
  const m = osoby.find((x) => x.id === w.wykonawca_user_id);
  if (m) {
    const nazwa = m.display_name || m.name || '';
    return esc(nazwa.trim().slice(0, 2).toUpperCase());
  }
  const v = (household?.virtual_members || []).find((x) => x.id === w.wykonawca_virtual_id);
  if (v) return esc((v.name || '').trim().slice(0, 2).toUpperCase());
  return ikonaSvg('osoby');
}

function opcjeWykonawcyKrotkie(w) {
  const h = household || { members: [], virtual_members: [] };
  const opcje = [`<option value=""${!w.wykonawca_user_id && !w.wykonawca_virtual_id ? ' selected' : ''}>— nikt —</option>`];
  for (const m of h.members || []) {
    opcje.push(`<option value="u:${m.id}"${m.id === w.wykonawca_user_id ? ' selected' : ''}>${
      esc(m.display_name || m.name)}</option>`);
  }
  for (const m of h.virtual_members || []) {
    opcje.push(`<option value="v:${m.id}"${m.id === w.wykonawca_virtual_id ? ' selected' : ''}>${
      esc(m.name)}</option>`);
  }
  return opcje.join('');
}

// Zapis pojedynczego pola bez otwierania formularza. Wysyłamy komplet, bo
// serwer nadpisuje wszystkie pola — pominięcie któregoś skasowałoby je.
async function zapiszSzybko(id, zmiany) {
  const z = zadania.find((x) => x.id === id);
  if (!z) return;
  const dane = {
    tytul: z.tytul, opis: z.opis || null,
    termin: z.termin || null, data_start: z.data_start || null, pora: z.pora || null,
    wykonawca_user_id: z.wykonawca_user_id || null,
    wykonawca_virtual_id: z.wykonawca_virtual_id || null,
    kamien_milowy: !!z.kamien_milowy, projekt: !!z.projekt,
    powtarzaj: z.powtarzaj || null, powtarzaj_co: z.powtarzaj_co || 1,
    ...zmiany,
  };
  if (await zapiszSzczegoly(id, dane, true)) await wczytaj();
}

function dataPl(iso) {
  const [r, m, d] = String(iso).slice(0, 10).split('-');
  return `${d}.${m}.${r}`;
}

// Kafelek terminu w liście: bez roku, dopóki termin jest w bieżącym roku.
// „12.09.2026" zajmowało dwa razy więcej szerokości niż reszta kafelków i to
// ono rozpychało rząd ikon, przez co tytuł łamał się na kolejne linijki.
function dataKrotka(iso) {
  const [r, m, d] = String(iso).slice(0, 10).split('-');
  return r === String(new Date().getFullYear()) ? `${d}.${m}` : `${d}.${m}.${r.slice(2)}`;
}

// ── formularz szczegółów ─────────────────────────────────────────────────────

// ── dyktowanie zadań ────────────────────────────────────────────────────────
//
// Rozpoznanie mowy robi PRZEGLĄDARKA (Web Speech API) — nic nie kosztuje i nie
// wymaga wysyłania dźwięku na serwer. Dopiero gotowy TEKST idzie do modelu,
// który wyciąga z niego termin, godzinę i powtarzanie. Sama zamiana mowy na
// tekst przez model byłaby wolniejsza i droższa, a nie dałaby nic więcej.
//
// Zapisujemy OD RAZU, bez ekranu potwierdzania: sensem dyktowania jest złapanie
// sprawy w sekundę. Potwierdzeniem jest toast mówiący, co apka zrozumiała.

function mowaDostepna() {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

let nasluch = null;

function dyktuj(btn) {
  // Drugie stuknięcie w trakcie nasłuchu przerywa — bez tego jedyną drogą
  // wyjścia byłoby odczekanie, aż przeglądarka sama się rozłączy.
  if (nasluch) { nasluch.stop(); return; }

  const Rozpoznawanie = window.SpeechRecognition || window.webkitSpeechRecognition;
  const r = new Rozpoznawanie();
  r.lang = 'pl-PL';
  r.interimResults = false;
  r.maxAlternatives = 1;

  const koniecNasluchu = () => {
    nasluch = null;
    btn.classList.remove('slucha');
  };

  r.onstart = () => { nasluch = r; btn.classList.add('slucha'); };
  r.onerror = (ev) => {
    koniecNasluchu();
    // „aborted" to skutek naszego własnego stop() — nie ma o czym informować.
    if (ev.error === 'aborted') return;
    toast(ev.error === 'not-allowed'
      ? 'Brak zgody na mikrofon. Zezwól na niego w ustawieniach strony.'
      : 'Nie udało się nagrać polecenia.', 'blad');
  };
  r.onend = koniecNasluchu;
  r.onresult = async (ev) => {
    const tekst = ev.results[0][0].transcript;
    koniecNasluchu();
    await zapiszZMowy(tekst);
  };

  try { r.start(); } catch { toast('Mikrofon jest już zajęty.', 'blad'); }
}

async function zapiszZMowy(tekst) {
  const pole = document.getElementById('sz-tytul');
  // Rozpoznany tekst ląduje w polu na czas przetwarzania — gdyby model nie
  // zrozumiał, słowa nie przepadają i da się je poprawić ręcznie.
  if (pole) { pole.value = tekst; pole.disabled = true; }
  try {
    const r = await authFetch('/api/task/z-mowy', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tekst, parent_id: korzen }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { toast(d.detail || 'Nie udało się zapisać zadania.', 'blad'); return; }
    if (pole) pole.value = '';
    nowyId = d.id || null;
    toast(opisZapisanego(d.zadanie), 'ok');
    await wczytaj();
  } catch {
    toast('Brak połączenia — zadanie nie zostało zapisane.', 'blad');
  } finally {
    if (pole) pole.disabled = false;
  }
}

// Potwierdzenie mówi, co apka ZROZUMIAŁA, a nie tylko „zapisano" — przy
// dyktowaniu to jedyny moment, w którym da się wyłapać pomyłkę w terminie.
function opisZapisanego(z) {
  if (!z) return 'Zadanie zapisane.';
  const czesci = [z.tytul];
  if (z.termin) {
    const d = new Date(z.termin + 'T00:00:00');
    const dzis = new Date(new Date().toDateString());
    const roznica = Math.round((d - dzis) / 86400000);
    const kiedy = roznica === 0 ? 'dziś' : roznica === 1 ? 'jutro' : dataPl(z.termin);
    czesci.push(kiedy + (z.pora ? ` ${z.pora}` : ''));
  }
  if (z.powtarzaj) czesci.push(opisPowtarzania(z));
  return czesci.join(' · ');
}

// ── łapanie zadania ─────────────────────────────────────────────────────────
//
// Osobna droga od pola „Co jest do zrobienia?" na górze listy, dla innej
// sytuacji: stoisz gdzieś, coś Ci się przypomina i masz wolny jeden kciuk.
// Pole na górze wymaga celowania i klawiatury; ten przepływ wymaga stuknięć.
//
// ZASADA: jeden krok = jedno pytanie = najwyżej dwa duże kafelki. Nigdzie nie
// ma formularza, bo wypełnianie formularza na stojąco jest dokładnie tym, przed
// czym ta droga ma uciec. Reszta pól zostaje w Szczegółach, dla spokojnej chwili.
//
// Zapis następuje DOPIERO po wskazaniu miejsca — inaczej niż w `/api/task/z-mowy`,
// które zapisuje od razu. Dlatego rozpoznanie idzie do `/api/task/rozumiem`,
// które niczego nie zapisuje.

const lap = {
  krok: 'jak',        // jak | pisz | slucham | mysli | gdzie | projekty | miejsce
  zadanie: null,      // rozpoznane pola z modelu
  wyk: {},            // dopasowany wykonawca (id-ki gotowe do zapisu)
  sciezka: [],        // [{id, tytul}] — droga w drzewie, ostatni to miejsce zapisu
  drzewo: [],         // płaska lista zadań do wybierania
  zapisuje: false,
};

function lapOtworz() {
  lap.krok = 'jak';
  lap.zadanie = null;
  lap.wyk = {};
  lap.sciezka = [];
  lap.zgadniete = false;
  lap.zapisuje = false;
  document.getElementById('lap-tlo').hidden = false;
  lapRysuj();
  // Drzewo ściągamy w tle już teraz: gdy dojdzie do wyboru projektu, ma być
  // gotowe, a nie dopiero wtedy zamawiane.
  lapWczytajDrzewo();
}

function lapZamknij() {
  if (window.Dyktowanie) Dyktowanie.stop();
  document.getElementById('lap-tlo').hidden = true;
}

async function lapWczytajDrzewo() {
  try {
    const r = await authFetch('/api/task/drzewo');
    lap.drzewo = (await r.json()).zadania || [];
  } catch { lap.drzewo = []; }
}

const lapProjekty = () => lap.drzewo.filter((z) => z.projekt);
const lapDzieci = (id) => lap.drzewo.filter((z) => z.parent_id === id);
const lapTeraz = () => lap.sciezka[lap.sciezka.length - 1] || null;

function lapRysuj() {
  const box = document.getElementById('lap-krok');
  const wroc = document.getElementById('lap-wroc');
  // Wracać nie ma z czego na pierwszym kroku ani w trakcie pracy modelu —
  // przerwanie w połowie zostawiłoby zapytanie bez odbiorcy.
  wroc.hidden = ['jak', 'mysli'].includes(lap.krok);
  lapRysujSciezke();
  box.innerHTML = {
    jak: lapKrokJak, pisz: lapKrokPisz, slucham: lapKrokSlucham,
    mysli: lapKrokMysli, gdzie: lapKrokGdzie, projekty: lapKrokProjekty,
    miejsce: lapKrokMiejsce,
  }[lap.krok]();
  const pole = box.querySelector('textarea');
  if (pole) pole.focus();
}

// Ścieżka pokazuje, gdzie zadanie wyląduje, i cofa do dowolnego poziomu.
// Pojawia się dopiero, gdy jest co pokazać — pusty pasek na pierwszym ekranie
// byłby ozdobą.
function lapRysujSciezke() {
  const el = document.getElementById('lap-sciezka');
  if (!['miejsce', 'projekty'].includes(lap.krok) || !lap.sciezka.length) {
    el.innerHTML = '';
    return;
  }
  el.innerHTML = lap.sciezka.map((w, i) => {
    const ostatni = i === lap.sciezka.length - 1;
    return `${i ? '<span class="strzal">›</span>' : ''}<button type="button"${
      ostatni ? ' class="teraz"' : ''} data-lap-poziom="${i}">${esc(w.tytul)}</button>`;
  }).join('');
}

function lapKrokJak() {
  return `
    <p class="lap-pyt">Złap zadanie</p>
    <div class="lap-kafle">
      <button type="button" class="lap-kafel" data-lap="mow">
        ${ikonaSvg('mikrofon')}Mów
        <small>powiedz jednym zdaniem</small>
      </button>
      <button type="button" class="lap-kafel" data-lap="pisz">
        ${ikonaSvg('olowek')}Pisz
        <small>wpisz z klawiatury</small>
      </button>
    </div>`;
}

function lapKrokPisz() {
  return `
    <p class="lap-pyt">Co jest do zrobienia?</p>
    <p class="lap-pod">Możesz od razu dopisać kiedy i dla kogo —
      „umówić notariusza w piątek o dziesiątej".</p>
    <div class="lap-pisz">
      <textarea id="lap-pole" placeholder="Umówić notariusza w piątek…"></textarea>
      <button type="button" class="lap-kafel pelny mocny" data-lap="rozumiem">Dalej</button>
    </div>`;
}

function lapKrokSlucham() {
  return `
    <div class="lap-mikrofon">
      <button type="button" class="lap-krag" data-lap="stop" aria-label="Zakończ nagrywanie">
        ${ikonaSvg('mikrofon')}
      </button>
      <div class="lap-stan">Słucham…</div>
      <p class="lap-pod">Powiedz, co masz zrobić. Stuknij mikrofon, gdy skończysz.</p>
    </div>`;
}

function lapKrokMysli() {
  return `
    <div class="lap-czeka">
      <div class="lap-kropki"><i></i><i></i><i></i></div>
      Zamieniam na zadanie…
    </div>`;
}

// Rozpoznane zdanie jest CYTATEM tego, co przed chwilą powiedziałeś — dlatego
// dostaje rozmiar i cudzysłów, a nie etykietę „Tytuł". To jedyny moment, w
// którym da się wyłapać, że model usłyszał co innego.
function lapCytat() {
  const z = lap.zadanie || {};
  const chipy = [];
  if (z.termin) {
    chipy.push(`<span class="lap-chip">${ikonaSvg('kalendarz')}${
      esc(dataKrotka(z.termin))}${z.pora ? ' ' + esc(z.pora) : ''}</span>`);
  }
  if (z.powtarzaj) {
    chipy.push(`<span class="lap-chip">${ikonaSvg('wymiana')}${esc(opisPowtarzania(z))}</span>`);
  }
  if (z.wykonawca) {
    chipy.push(`<span class="lap-chip">${ikonaSvg('osoby')}${esc(z.wykonawca)}${
      lap.wyk.wykonawca_user_id || lap.wyk.wykonawca_virtual_id ? '' : ' (nie znam)'}</span>`);
  }
  return `<p class="lap-cytat">${esc(z.tytul || '')}</p>${
    chipy.length ? `<div class="lap-chipy">${chipy.join('')}</div>` : ''}`;
}

function lapKrokGdzie() {
  const brakProjektow = !lapProjekty().length;
  return `
    ${lapCytat()}
    <p class="lap-pyt">Gdzie to zapisać?</p>
    <div class="lap-kafle">
      <button type="button" class="lap-kafel mocny" data-lap="osobno">
        Osobne zadanie
        <small>na wierzchu listy</small>
      </button>
      <button type="button" class="lap-kafel" data-lap="w-projekcie"${
        brakProjektow ? ' disabled style="opacity:.45;cursor:default"' : ''}>
        W projekcie
        <small>${brakProjektow ? 'nie masz jeszcze projektów' : 'jako krok większej sprawy'}</small>
      </button>
    </div>`;
}

function lapKrokProjekty() {
  const projekty = lapProjekty();
  if (!projekty.length) {
    return `${lapCytat()}
      <p class="lap-pyt">Nie masz jeszcze projektów</p>
      <p class="lap-pod">Projekt to zadanie oznaczone jako przedsięwzięcie
        w Szczegółach. Na razie zapiszę to osobno.</p>
      <button type="button" class="lap-kafel pelny mocny" data-lap="osobno">Zapisz osobno</button>`;
  }
  return `
    ${lapCytat()}
    <p class="lap-pyt">Który projekt?</p>
    <div class="lap-lista">
      ${projekty.map((p) => {
        const ile = lapDzieci(p.id).length;
        return `<button type="button" class="lap-poz" data-lap-wejdz="${p.id}">
          <span class="nazwa">${esc(p.tytul)}</span>
          ${ile ? `<span class="ile">${ile} ${ile === 1 ? 'krok' : 'kroków'}</span>` : ''}
        </button>`;
      }).join('')}
    </div>
    <button type="button" class="lap-inne" data-lap="osobno">Jednak osobne zadanie</button>`;
}

// Miejsce wskazane — zostaje pytanie „tutaj czy głębiej". Kafelek „głębiej"
// pokazujemy TYLKO wtedy, gdy naprawdę jest gdzie wejść: martwy przycisk uczy,
// że stukanie w kafelki bywa bez skutku.
function lapKrokMiejsce() {
  const teraz = lapTeraz();
  const dzieci = lapDzieci(teraz.id);
  return `
    ${lapCytat()}
    ${lap.zgadniete ? `<p class="lap-pod">Usłyszałem, że to należy do
      <strong>${esc(teraz.tytul)}</strong>.</p>` : ''}
    <p class="lap-pyt">Zapisać w „${esc(teraz.tytul)}"?</p>
    <div class="lap-kafle">
      <button type="button" class="lap-kafel mocny" data-lap="zapisz">
        Zapisz tutaj
        ${lap.zapisuje ? '<small>zapisuję…</small>' : ''}
      </button>
      ${dzieci.length ? `<button type="button" class="lap-kafel" data-lap="glebiej">
        Wejdź głębiej
        <small>${dzieci.length} ${dzieci.length === 1 ? 'krok' : 'kroków'} w środku</small>
      </button>` : ''}
    </div>
    ${dzieci.length ? `<div class="lap-lista" id="lap-glebiej" hidden>
      ${dzieci.map((d) => {
        const ile = lapDzieci(d.id).length;
        return `<button type="button" class="lap-poz" data-lap-wejdz="${d.id}">
          <span class="nazwa">${esc(d.tytul)}</span>
          ${ile ? `<span class="ile">${ile} w środku</span>` : ''}
        </button>`;
      }).join('')}
    </div>` : ''}
    <button type="button" class="lap-inne" data-lap="projekty">Wybierz inne miejsce</button>`;
}

// ── kroki przepływu ──

function lapMow() {
  if (!window.Dyktowanie || !Dyktowanie.dostepne()) {
    toast('Ta przeglądarka nie obsługuje dyktowania. Wybierz „Pisz".', 'blad');
    return;
  }
  lap.krok = 'slucham';
  lapRysuj();
  Dyktowanie.start({
    onTekst: (tekst) => lapRozumiem(tekst),
    onBlad: (t) => { toast(t, 'blad'); lap.krok = 'jak'; lapRysuj(); },
    // Koniec nasłuchu BEZ tekstu (cisza, przerwanie) wraca na start zamiast
    // zostawiać ekran „Słucham…", w którym nic już nie słucha.
    onStan: (slucha) => {
      if (!slucha && lap.krok === 'slucham') { lap.krok = 'jak'; lapRysuj(); }
    },
  });
}

async function lapRozumiem(tekst) {
  tekst = (tekst || '').trim();
  if (!tekst) { toast('Nie usłyszałem nic do zapisania.', 'blad'); return; }
  lap.krok = 'mysli';
  lapRysuj();
  let d;
  try {
    const r = await authFetch('/api/task/rozumiem', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tekst }),
    });
    d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.detail || 'Nie udało się zrozumieć polecenia.');
  } catch (e) {
    toast(e.message || 'Brak połączenia.', 'blad');
    lap.krok = 'jak';
    lapRysuj();
    return;
  }

  lap.zadanie = d.zadanie;
  lap.wyk = {
    wykonawca_user_id: d.wykonawca_user_id || null,
    wykonawca_virtual_id: d.wykonawca_virtual_id || null,
  };

  // Gdy w zdaniu padła nazwa projektu i dało się ją dopasować, pomijamy pytanie
  // „gdzie" i od razu stajemy w tym projekcie — ale POKAZUJEMY to i zostawiamy
  // wyjście. Ciche wrzucenie do źle dopasowanego projektu chowa zadanie tak, że
  // nikt go nie znajduje.
  if (d.cel) {
    if (!lap.drzewo.length) await lapWczytajDrzewo();
    lap.sciezka = [d.cel];
    lap.zgadniete = true;
    lap.krok = 'miejsce';
  } else {
    lap.zgadniete = false;
    lap.krok = 'gdzie';
  }
  lapRysuj();
}

async function lapZapisz() {
  if (lap.zapisuje) return;          // podwójne stuknięcie = jedno zadanie
  lap.zapisuje = true;
  lapRysuj();
  const z = lap.zadanie || {};
  const teraz = lapTeraz();
  try {
    const r = await authFetch('/api/task/zadania', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tytul: z.tytul, termin: z.termin, pora: z.pora,
        powtarzaj: z.powtarzaj, powtarzaj_co: z.powtarzaj_co,
        ...lap.wyk,
        parent_id: teraz ? teraz.id : null,
      }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { toast(d.detail || 'Nie udało się zapisać zadania.', 'blad'); return; }
    nowyId = d.id || null;
    // Potwierdzenie mówi i CO zapisano, i GDZIE — samo „zapisano" nie pozwala
    // wyłapać, że zadanie wylądowało w niewłaściwym projekcie.
    toast(opisZapisanego(z) + (teraz ? ` → ${teraz.tytul}` : ''), 'ok');
    lapZamknij();
    await wczytaj();
  } catch {
    toast('Brak połączenia — zadanie nie zostało zapisane.', 'blad');
  } finally {
    lap.zapisuje = false;
  }
}

function lapCofnij() {
  if (lap.krok === 'miejsce') {
    lap.sciezka.pop();
    lap.zgadniete = false;
    if (!lap.sciezka.length) lap.krok = lapProjekty().length ? 'projekty' : 'gdzie';
  } else if (lap.krok === 'projekty') {
    lap.krok = 'gdzie';
  } else {
    lap.krok = 'jak';
  }
  lapRysuj();
}

function lapPodepnij() {
  const tlo = document.getElementById('lap-tlo');
  if (!tlo) return;                  // strona planu nie ma tego arkusza
  document.getElementById('fab-lap').onclick = lapOtworz;
  document.getElementById('lap-zamknij').onclick = lapZamknij;
  document.getElementById('lap-wroc').onclick = lapCofnij;
  // Stuknięcie w tło zamyka — na telefonie to szybsze niż celowanie w ✕.
  tlo.onclick = (ev) => { if (ev.target === tlo) lapZamknij(); };
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !tlo.hidden) lapZamknij();
  });

  document.getElementById('lap-sciezka').onclick = (ev) => {
    const b = ev.target.closest('[data-lap-poziom]');
    if (!b) return;
    lap.sciezka = lap.sciezka.slice(0, Number(b.dataset.lapPoziom) + 1);
    lap.zgadniete = false;
    lap.krok = 'miejsce';
    lapRysuj();
  };

  document.getElementById('lap-krok').onclick = (ev) => {
    const wejdz = ev.target.closest('[data-lap-wejdz]');
    if (wejdz) {
      const id = Number(wejdz.dataset.lapWejdz);
      const z = lap.drzewo.find((x) => x.id === id);
      if (!z) return;
      lap.sciezka.push({ id: z.id, tytul: z.tytul });
      lap.zgadniete = false;
      lap.krok = 'miejsce';
      lapRysuj();
      return;
    }
    const b = ev.target.closest('[data-lap]');
    if (!b) return;
    ({
      mow: lapMow,
      pisz: () => { lap.krok = 'pisz'; lapRysuj(); },
      stop: () => Dyktowanie.stop(),
      rozumiem: () => lapRozumiem(document.getElementById('lap-pole').value),
      osobno: () => { lap.sciezka = []; lapZapisz(); },
      'w-projekcie': () => { lap.krok = 'projekty'; lapRysuj(); },
      projekty: () => { lap.sciezka = []; lap.zgadniete = false;
                        lap.krok = 'projekty'; lapRysuj(); },
      // „Głębiej" tylko odsłania listę kroków — bez przerysowania, żeby
      // pytanie i odpowiedź zostały na jednym ekranie.
      glebiej: () => {
        const lista = document.getElementById('lap-glebiej');
        if (lista) lista.hidden = !lista.hidden;
      },
      zapisz: lapZapisz,
    }[b.dataset.lap] || (() => {}))();
  };

  // Enter w polu pisania idzie dalej; Shift+Enter zostawiamy na nową linijkę.
  document.getElementById('lap-krok').addEventListener('keydown', (ev) => {
    if (ev.target.id === 'lap-pole' && ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      lapRozumiem(ev.target.value);
    }
  });
}

// Lista możliwych rodziców. WYKLUCZAMY SIEBIE I WŁASNE POTOMSTWO — zadanie
// wsunięte pod własny krok tworzy pętlę, po której drzewo nie ma korzenia.
// Baza i tak to odrzuca (`wykryj_cykl`), ale pokazywanie opcji, która kończy
// się błędem, jest gorsze niż jej brak.
function opcjeRodzica(w) {
  const drzewo = budujDrzewo(zadania);
  const wSrodku = new Set();
  const zbierz = (x) => { wSrodku.add(x.id); (x.dzieci || []).forEach(zbierz); };
  const ja = drzewo.flatMap(splaszcz).find((x) => x.id === w.id);
  if (ja) zbierz(ja);

  const opcje = ['<option value="">— osobne zadanie —</option>'];
  const dodaj = (x, poziom) => {
    if (!wSrodku.has(x.id)) {
      const wciecie = '  '.repeat(poziom);
      opcje.push(`<option value="${x.id}"${x.id === w.parent_id ? ' selected' : ''}>${
        wciecie}${esc(x.tytul)}</option>`);
    }
    (x.dzieci || []).forEach((d) => dodaj(d, poziom + 1));
  };
  drzewo.forEach((x) => dodaj(x, 0));
  return opcje.join('');
}

// Poprzedniki już ustawione — z krzyżykiem do zdjęcia. Bez tej listy jedynym
// śladem powiązania byłaby strzałka na wykresie, a zdjęcie go wymagałoby
// szukania w innym widoku.
function listaPoprzednikow(w) {
  const moje = zaleznosci.filter((z) => z.zadanie_id === w.id);
  if (!moje.length) return '';
  const wg = new Map(zadania.map((z) => [z.id, z]));
  return `<div class="poprzedniki">${moje.map((z) => {
    const p = wg.get(z.poprzednik_id);
    return `<span class="chip wlaczony">${esc(p ? p.tytul : 'zadanie usunięte')}
      <button type="button" data-zdejmij-zal="${z.poprzednik_id}"
              aria-label="Zdejmij powiązanie">✕</button></span>`;
  }).join('')}</div>`;
}

// Kandydaci na poprzednika: wszystko oprócz samego zadania i tych, które już
// są ustawione. Pętle odrzuca serwer — tu nie da się ich policzyć wiarygodnie,
// bo lista w przeglądarce bywa zawężona filtrem albo zakresem.
function opcjePoprzednika(w) {
  const juz = new Set(zaleznosci.filter((z) => z.zadanie_id === w.id)
    .map((z) => z.poprzednik_id));
  const opcje = ['<option value="">— wybierz zadanie —</option>'];
  for (const z of zadania) {
    if (z.id === w.id || juz.has(z.id)) continue;
    opcje.push(`<option value="${z.id}">${esc(z.tytul)}</option>`);
  }
  return opcje.join('');
}

// Zależności trzymamy niezależnie od listy zadań, bo ekran szczegółów bywa
// otwierany z zakładki, która ich nie pobiera (`/api/task/zadania` ich nie zna).
async function odswiezZaleznosci() {
  try {
    const r = await authFetch('/api/task/plan?zrobione=true');
    zaleznosci = r.ok ? ((await r.json()).zaleznosci || []) : [];
  } catch { /* brak powiązań to poprawny stan */ }
}

async function wczytajHousehold() {
  if (household) return household;
  try {
    const r = await authFetch('/api/household');
    household = r.ok ? await r.json() : { members: [], virtual_members: [] };
  } catch { household = { members: [], virtual_members: [] }; }
  return household;
}

async function otworzSzczegoly(id) {
  await wczytajHousehold();
  // Powiązania mogą być nieznane, jeśli przyszliśmy z zakładki innej niż Plan.
  if (!zaleznosci.length) await odswiezZaleznosci();
  szczegolyId = id;
  widok = 'szczegoly';
  rysuj();
}

function rysujSzczegoly() {
  const w = zadania.find((z) => z.id === szczegolyId);
  if (!w) { widok = 'lista'; rysujLista(); return; }
  // Zadanie z rodzicem dziedziczy po nim prywatność, a backend to wymusza —
  // dlatego przełącznik jest tu wyłączony, a nie tylko odradzany.
  const maRodzica = w.parent_id != null;
  const wykWartosc = w.wykonawca_user_id != null ? `u:${w.wykonawca_user_id}`
    : (w.wykonawca_virtual_id != null ? `v:${w.wykonawca_virtual_id}` : '');
  const czlonkowie = (household && household.members) || [];
  const wirtualni = (household && household.virtual_members) || [];
  const opcjeWykonawcy = `<option value="">— nikt —</option>`
    + czlonkowie.map((m) => `<option value="u:${m.id}"${wykWartosc === `u:${m.id}` ? ' selected' : ''}>${
        esc(m.display_name || m.name || m.email || 'Domownik')}</option>`).join('')
    + wirtualni.map((m) => `<option value="v:${m.id}"${wykWartosc === `v:${m.id}` ? ' selected' : ''}>${
        esc(m.name)}</option>`).join('');

  box().innerHTML = `
    <button class="wroc" type="button" id="s-wroc">← Wróć</button>
    <div class="gora"><h1>Szczegóły zadania</h1></div>
    <div class="pole">
      <label for="s-tytul">Tytuł</label>
      <input id="s-tytul" value="${esc(w.tytul)}">
    </div>
    <div class="pole">
      <label for="s-opis">Opis</label>
      <textarea id="s-opis">${esc(w.opis || '')}</textarea>
    </div>
    <div class="pola-2">
      <!-- Początek jest opcjonalny i stoi PRZED terminem: zadanie bez niego
           to punkt na osi, z nim — odcinek. Dopiero to daje belkę na wykresie. -->
      <div class="pole">
        <label for="s-start">Początek</label>
        <input id="s-start" type="date" value="${esc((w.data_start || '').slice(0, 10))}">
      </div>
      <div class="pole">
        <label for="s-termin">Termin</label>
        <input id="s-termin" type="date" value="${esc((w.termin || '').slice(0, 10))}">
      </div>
    </div>
    <div class="pole">
      <label for="s-pora">Godzina przypomnienia</label>
      <input id="s-pora" type="time" value="${esc((w.pora || '').slice(0, 5))}">
    </div>
    <div class="pole">
      <label for="s-wykonawca">Wykonawca</label>
      <select id="s-wykonawca">${opcjeWykonawcy}</select>
    </div>
    <!-- Przeniesienie pod inne zadanie. Baza obsługiwała to od początku
         (z wykrywaniem pętli), ale nie było na to żadnego wejścia — sprawa,
         która okazała się częścią większego przedsięwzięcia, wymagała
         usunięcia i wpisania od nowa. -->
    <div class="pole">
      <label for="s-rodzic">Część zadania</label>
      <select id="s-rodzic">${opcjeRodzica(w)}</select>
      <div class="uwaga">Przenosi to zadanie razem z jego krokami.</div>
    </div>
    <!-- Zależności: „skończ, zanim zaczniesz". Zadania bez powiązania idą
         równolegle — to stan domyślny i nie wymaga osobnego ustawienia. -->
    <div class="pole">
      <label for="s-poprzednik">Zacznij dopiero po</label>
      ${listaPoprzednikow(w)}
      <select id="s-poprzednik">${opcjePoprzednika(w)}</select>
      <div class="uwaga">Zadania bez takiego powiązania mogą iść równolegle.</div>
    </div>
    <div class="pole-cb">
      <label><input type="checkbox" id="s-kamien" ${w.kamien_milowy ? 'checked' : ''}> Kamień milowy</label>
    </div>
    <!-- Powtarzanie wymaga terminu — bez niego nie ma od czego liczyć kolejnej
         daty, więc pole jest wtedy wyłączone i mówi dlaczego. -->
    <div class="pole">
      <label for="s-powtarzaj">Powtarzaj</label>
      <div class="powtarzanie">
        <select id="s-powtarzaj" ${w.termin ? '' : 'disabled'}>
          <option value="">nie powtarza się</option>
          ${OKRESY.map(([k, l]) => `<option value="${k}"${
            w.powtarzaj === k ? ' selected' : ''}>${l}</option>`).join('')}
        </select>
        <label class="co-ile${w.powtarzaj ? '' : ' schowane'}" id="s-co-ile-wrap">
          co <input type="number" id="s-co-ile" min="1" max="99"
                    value="${Number(w.powtarzaj_co) || 1}"> <span id="s-co-ile-jedn"></span>
        </label>
      </div>
      ${w.termin ? '' : '<div class="uwaga">Najpierw ustaw termin — od niego liczy się kolejne powtórzenie.</div>'}
    </div>
    <div class="pole-cb">
      <!-- Projektem może być tylko zadanie bez rodzica: przedsięwzięcie
           w środku innego przedsięwzięcia to etap, nie projekt. -->
      <label class="${maRodzica ? 'wylaczone' : ''}">
        <input type="checkbox" id="s-projekt" ${w.projekt ? 'checked' : ''}
               ${maRodzica ? 'disabled' : ''}>
        To jest projekt
      </label>
      ${maRodzica
        ? '<div class="uwaga">Krok jest częścią projektu nadrzędnego.</div>'
        : '<div class="uwaga">Wyróżnia zadanie na osi planu jako całe przedsięwzięcie.</div>'}
    </div>
    <div class="pole-cb">
      <label class="${maRodzica ? 'wylaczone' : ''}">
        <input type="checkbox" id="s-prywatne" ${w.prywatne_dla != null ? 'checked' : ''}
               ${maRodzica ? 'disabled' : ''}>
        Tylko dla mnie
      </label>
      ${maRodzica ? '<div class="uwaga">Krok dziedziczy ustawienie po zadaniu nadrzędnym.</div>' : ''}
    </div>
    <div class="akcje">
      <button class="btn btn-danger" type="button" id="s-usun">Usuń</button>
      <button class="btn btn-primary" type="button" id="s-zapisz">Zapisz</button>
    </div>`;

  document.getElementById('s-wroc').onclick = () => { widok = 'lista'; rysuj(); };

  // Zależności zapisują się OD RAZU, nie razem z formularzem: to osobna
  // tabela, a mieszanie jej w zapis reszty pól kazałoby użytkownikowi
  // pamiętać, że dodanie powiązania wymaga jeszcze kliknięcia „Zapisz".
  const selPoprz = document.getElementById('s-poprzednik');
  if (selPoprz) selPoprz.onchange = async () => {
    const poprzednik = Number(selPoprz.value);
    selPoprz.value = '';
    if (!poprzednik) return;
    const r = await authFetch('/api/task/zaleznosci', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ zadanie_id: w.id, poprzednik_id: poprzednik }),
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      toast(e.detail || 'Nie udało się dodać powiązania.', 'blad');
      return;
    }
    await odswiezZaleznosci();
    rysujSzczegoly();
  };
  document.querySelectorAll('[data-zdejmij-zal]').forEach((b) => {
    b.onclick = async () => {
      const p = Number(b.dataset.zdejmijZal);
      await authFetch(`/api/task/zaleznosci?zadanie_id=${w.id}&poprzednik_id=${p}`,
                      { method: 'DELETE' });
      await odswiezZaleznosci();
      rysujSzczegoly();
    };
  });

  // Pole „co ile" ma sens dopiero, gdy wybrano okres — i musi odmieniać
  // jednostkę przez liczbę, bo „co 2 tydzień" wygląda jak usterka.
  const selPow = document.getElementById('s-powtarzaj');
  const wrapCo = document.getElementById('s-co-ile-wrap');
  const poleCo = document.getElementById('s-co-ile');
  const odswiezPowtarzanie = () => {
    const okres = selPow.value;
    wrapCo.classList.toggle('schowane', !okres);
    if (okres) {
      document.getElementById('s-co-ile-jedn').textContent =
        jednostkaOkresu(okres, Number(poleCo.value) || 1);
    }
  };
  selPow.onchange = odswiezPowtarzanie;
  poleCo.oninput = odswiezPowtarzanie;
  odswiezPowtarzanie();

  // Włączenie powtarzania bez terminu nie miałoby od czego liczyć następnej
  // daty — odblokowujemy pole dopiero, gdy termin się pojawi.
  document.getElementById('s-termin').onchange = (ev) => {
    selPow.disabled = !ev.target.value;
    if (!ev.target.value) { selPow.value = ''; odswiezPowtarzanie(); }
  };

  document.getElementById('s-zapisz').onclick = async () => {
    const tytul = document.getElementById('s-tytul').value.trim();
    if (!tytul) { document.getElementById('s-tytul').focus(); return; }
    const wyk = document.getElementById('s-wykonawca').value;
    const dane = {
      tytul,
      opis: document.getElementById('s-opis').value.trim() || null,
      termin: document.getElementById('s-termin').value || null,
      data_start: document.getElementById('s-start').value || null,
      pora: document.getElementById('s-pora').value || null,
      wykonawca_user_id: wyk.startsWith('u:') ? Number(wyk.slice(2)) : null,
      wykonawca_virtual_id: wyk.startsWith('v:') ? Number(wyk.slice(2)) : null,
      kamien_milowy: document.getElementById('s-kamien').checked,
      projekt: !maRodzica && document.getElementById('s-projekt').checked,
      powtarzaj: document.getElementById('s-powtarzaj').value || null,
      powtarzaj_co: Number(document.getElementById('s-co-ile').value) || 1,
    };
    // Łapiemy zamianę pól po stronie klienta, żeby nie wysyłać żądania, które
    // i tak wróci z błędem — komunikat pada od razu przy przycisku.
    if (dane.data_start && dane.termin && dane.data_start > dane.termin) {
      toast('Początek nie może być późniejszy niż termin.', 'blad');
      return;
    }
    // `parent_id` wysyłamy TYLKO gdy użytkownik faktycznie zmienił rodzica.
    // Backend rozpoznaje zamiar przeniesienia po samej OBECNOŚCI tego klucza,
    // więc wysyłanie go zawsze odczepiałoby zadanie przy każdej zmianie tytułu.
    const wybranyRodzic = document.getElementById('s-rodzic').value;
    const nowyRodzic = wybranyRodzic ? Number(wybranyRodzic) : null;
    if (nowyRodzic !== (w.parent_id ?? null)) dane.parent_id = nowyRodzic;
    // `prywatne` dokładamy tylko wtedy, gdy przełącznik w ogóle jest aktywny
    // (zadanie bez rodzica) — przy dziecku backend i tak by go zignorował.
    if (!maRodzica) dane.prywatne = document.getElementById('s-prywatne').checked;
    const btn = document.getElementById('s-zapisz');
    btn.disabled = true;
    const ok = await zapiszSzczegoly(w.id, dane);
    if (ok) { widok = 'lista'; await wczytaj(); } else { btn.disabled = false; }
  };

  document.getElementById('s-usun').onclick = () => {
    usunZadanie(w.id, w.tytul);
  };
}

// `cicho` przy przeciąganiu belek: przy przesuwaniu kilku zadań pod rząd toast
// „Zapisano" po każdym ruchu zasłaniałby wykres, na którym właśnie się pracuje.
// Błędy nadal są głośne — o nieudanym zapisie trzeba wiedzieć zawsze.
async function zapiszSzczegoly(id, dane, cicho = false) {
  try {
    const r = await authFetch(`/api/task/zadania/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dane),
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      toast(e.detail || 'Nie udało się zapisać.', 'blad');
      return false;
    }
    if (!cicho) toast('Zapisano.', 'ok');
    return true;
  } catch {
    toast('Błąd połączenia. Spróbuj ponownie.', 'blad');
    return false;
  }
}

async function usunZadanie(id, tytul) {
  // Nie liczymy dzieci z filtrowanej listy `zadania`, bo zawiera tylko zadania
  // z bieżącego zakresu (Dziś/Nadchodzące/Zrobione). Krok, który nie pasuje do
  // zakresu, nie będzie wykryty — wtedy pytanie nie ostrzega o nim, a kaskadowe
  // usuwanie go i tak skasuje. Zawsze ostrzegamy, że usunięcie zabiera kroki.
  if (!(await potwierdz({
    tytul: `Usunąć „${tytul}"?`,
    tresc: 'Usunie też wszystkie kroki w środku, łącznie z już zrobionymi.',
    tak: 'Usuń', groznie: true,
  }))) return;
  try {
    const r = await authFetch(`/api/task/zadania/${id}`, { method: 'DELETE' });
    if (!r.ok) { toast('Nie udało się usunąć.', 'blad'); return; }
    wczytaj();
  } catch {
    toast('Błąd połączenia. Spróbuj ponownie.', 'blad');
  }
}
