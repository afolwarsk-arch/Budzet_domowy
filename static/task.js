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
function dzisIso() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dz = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${dz}`;
}

// Polska odmiana przez liczbę: 1 forma pojedyncza, 2–4 „kilka", 5+ „wiele" —
// z wyjątkiem 12–14, które mimo końcówki 2–4 biorą formę mnogą (wzorzec
// z health.js).
function odmien(n, poj, kilka, wiele) {
  if (n === 1) return poj;
  const r10 = n % 10, r100 = n % 100;
  return (r10 >= 2 && r10 <= 4 && !(r100 >= 12 && r100 <= 14)) ? kilka : wiele;
}

let zakres = 'dzis';        // dzis | nadchodzace | zrobione
let zadania = [];           // płasko, jak z serwera
let korzen = null;          // null = widok listy; liczba = wejście w zadanie
let widok = 'lista';        // lista | szczegoly
let szczegolyId = null;     // id zadania otwartego w formularzu szczegółów
let nowyId = null;          // id ostatnio dodanego szybkim dodawaniem — przy nim pokazujemy „Szczegóły"
let household = null;       // {members, virtual_members} — wczytywane raz, przy pierwszym otwarciu formularza
let planZrobione = false;   // czy wykres pokazuje też zadania zamknięte
let planSkala = 1;          // 0 = ciasno (kwartał+), 1 = miesiąc, 2 = tydzień

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

// Postęp liczony z CAŁEGO poddrzewa, nie z bezpośrednich dzieci — inaczej
// zadanie z jednym krokiem, który ma pięć własnych kroków, pokazywałoby „0 z 1".
function postep(w) {
  let razem = 0, gotowe = 0;
  const zejdz = (x) => {
    for (const d of x.dzieci) {
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
    zadania = (await r.json()).zadania || [];
  } catch { zadania = []; toast('Nie udało się wczytać planu.', 'blad'); }
  rysuj();
}

window.addEventListener('DOMContentLoaded', () => authRequireHousehold().then(wczytaj));

function podepnijPtaszki() {
  const lista = document.querySelector('.zadania');
  if (!lista) return;
  lista.onclick = async (ev) => {
    const wejdz = ev.target.closest('[data-wejdz]');
    if (wejdz) {
      korzen = Number(wejdz.dataset.wejdz);
      nowyId = null;
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

const ZAKRESY = [['dzis', 'Dziś'], ['nadchodzace', 'Nadchodzące'],
                 ['plan', 'Plan'], ['zrobione', 'Zrobione']];

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

function rysujPlan() {
  const zDatami = zadania.filter(zakresZadania);
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
    zadania.filter((z) => !zakresZadania(z))));   // przodkowie bez dat trzymają strukturę
  const wiersze = drzewo.flatMap((w) => splaszczPlan(w, 0));

  box().innerHTML = naglowekPlanu() + `
    <div class="gantt" style="--szer:${szer}px">
      <div class="gantt-osie">${osCzasu(od, dni, px)}</div>
      <div class="gantt-body">
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
    <div class="gora"><h1>Zadania</h1></div>
    <div class="filtry" id="f-zakres">
      ${ZAKRESY.map(([k, l]) => `<button class="chip" type="button" data-z="${k}"
          aria-pressed="${k === zakres}">${l}</button>`).join('')}
    </div>
    <div class="filtry plan-narzedzia">
      <button class="chip" type="button" id="p-zrobione" aria-pressed="${planZrobione}">
        Pokaż zrobione</button>
      <div class="skala">
        <span>gęstość</span>
        <input type="range" id="p-skala" min="0" max="2" step="1" value="${planSkala}"
               aria-label="Gęstość osi czasu">
        <span>${SKALE_PLANU[planSkala].opis}</span>
      </div>
    </div>`;
}

function podepnijNaglowekPlanu() {
  document.getElementById('f-zakres').onclick = (ev) => {
    const b = ev.target.closest('[data-z]');
    if (!b) return;
    zakres = b.dataset.z;
    nowyId = null;
    wczytaj();
  };
  const zr = document.getElementById('p-zrobione');
  if (zr) zr.onclick = () => { planZrobione = !planZrobione; wczytajPlan(); };
  const sk = document.getElementById('p-skala');
  // Sama skala nie zmienia danych, więc przerysowujemy bez pytania serwera.
  if (sk) sk.oninput = (ev) => { planSkala = Number(ev.target.value); rysujPlan(); };
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
  if (z.kamien_milowy) klasy.push('kamien');

  const podpis = dlugosc * px > 54 ? `<span>${esc(dataKrotka(zakresZ.koniec))}</span>` : '';
  return `<div class="gantt-wiersz">${etykieta}
    <div class="gantt-tor" style="width:${szer}px">
      <div class="${klasy.join(' ')}" data-otworz="${z.id}"
           style="left:${Math.round(start * px)}px; width:${Math.round(dlugosc * px)}px"
           title="${esc(z.tytul)} — ${dataKrotka(zakresZ.start)} → ${dataKrotka(zakresZ.koniec)}">
        ${podpis}
      </div>
    </div></div>`;
}

function dataKrotka(d) {
  return d.toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit' });
}

function podepnijBelki() {
  const g = document.querySelector('.gantt');
  if (!g) return;
  g.onclick = (ev) => {
    const b = ev.target.closest('[data-otworz]');
    if (b) otworzSzczegoly(Number(b.dataset.otworz));
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
    ${aktualny ? nagKorzenia(aktualny) : ''}
    <form class="szybkie" id="szybkie">
      <input id="sz-tytul" placeholder="Co jest do zrobienia?" autocomplete="off">
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
  const korzenBtn = document.getElementById('korzen-szczegoly');
  if (korzenBtn) korzenBtn.onclick = () => otworzSzczegoly(aktualny.id);
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
    } else {
      toast('Nie udało się zapisać zadania.', 'blad');
    }
  };
  podepnijPtaszki();
}

function wiersz(w, poziom) {
  const p = postep(w);
  const nast = p.razem && w.status !== 'zrobione' ? nastepnyKrok(w) : {};
  const spozniony = w.termin && w.status === 'otwarte' &&
    w.termin.slice(0, 10) < dzisIso();
  // Wcięcia tylko do trzeciego poziomu — głębiej wchodzi się w zadanie.
  // Przy 412 px czwarty poziom zostawia na tytuł około 200 px. Liczone od
  // BIEŻĄCEGO korzenia (poziom startuje od 0 przy każdym wejściu w zadanie),
  // nie od korzenia całego drzewa.
  const wciecie = Math.min(poziom, 2) * 18;
  return `
    <div class="zad${w.status === 'zrobione' ? ' zrobione' : ''}" style="padding-left:${wciecie}px">
      <button class="ptaszek" type="button" data-ptaszek="${w.id}"
              aria-label="Odhacz zadanie">${w.status === 'zrobione' ? ikonaSvg('ptaszek') : ''}</button>
      <div class="zad-tresc">
        <div class="zad-tytul">${w.kamien_milowy ? '<span class="kamien"></span>' : ''}${esc(w.tytul)}</div>
        ${nast.tytul ? `<div class="zad-nast">następne: ${esc(nast.tytul)}</div>` : ''}
        ${w.id === nowyId ? `<button class="zad-szczegoly-btn" type="button" data-szczegoly="${w.id}">Szczegóły</button>` : ''}
      </div>
      ${w.termin ? `<span class="zad-termin${spozniony ? ' po-czasie' : ''}">${dataPl(w.termin)}</span>` : ''}
      ${p.razem && !w.kamien_milowy ? `<span class="zad-postep">${p.gotowe} z ${p.razem}</span>` : ''}
      <button class="zad-strzalka" type="button" data-wejdz="${w.id}" aria-label="Wejdź w zadanie">›</button>
    </div>
    ${w.dzieci.map((d) => wiersz(d, poziom + 1)).join('')}`;
}

function dataPl(iso) {
  const [r, m, d] = String(iso).slice(0, 10).split('-');
  return `${d}.${m}.${r}`;
}

// ── formularz szczegółów ─────────────────────────────────────────────────────

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
    <div class="pole-cb">
      <label><input type="checkbox" id="s-kamien" ${w.kamien_milowy ? 'checked' : ''}> Kamień milowy</label>
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
    };
    // Łapiemy zamianę pól po stronie klienta, żeby nie wysyłać żądania, które
    // i tak wróci z błędem — komunikat pada od razu przy przycisku.
    if (dane.data_start && dane.termin && dane.data_start > dane.termin) {
      toast('Początek nie może być późniejszy niż termin.', 'blad');
      return;
    }
    // `parent_id` NIGDY nie jest tu dodawany — formularz szczegółów nie
    // przenosi zadań, a wysłanie `parent_id: null` odczepiłoby je od rodzica.
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

async function zapiszSzczegoly(id, dane) {
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
    toast('Zapisano.', 'ok');
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
