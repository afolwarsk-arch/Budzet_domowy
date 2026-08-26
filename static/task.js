// Ekran zadań — wiem.task.
//
// DRZEWO SKŁADAMY TUTAJ, nie w SQL-u (patrz nagłówek task_db.py). Serwer daje
// płaską listę, a `budujDrzewo` wiąże dzieci z rodzicami. Dzięki temu postęp
// poddrzewa liczy się bez dodatkowego zapytania.
//
// SZYBKIE DODAWANIE JEST GŁÓWNĄ DROGĄ, formularz drugą. Zadanie, którego
// dodanie wymaga sześciu pól, nie zostaje dodane wcale — a sprawa niezapisana
// jest gorsza niż zapisana bez terminu.

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

let zakres = 'dzis';        // dzis | nadchodzace | zrobione
let zadania = [];           // płasko, jak z serwera
let korzen = null;          // null = widok listy; liczba = wejście w zadanie

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

async function wczytaj() {
  try {
    const r = await authFetch('/api/task/zadania?zakres=' + zakres);
    zadania = (await r.json()).zadania || [];
  } catch { zadania = []; toast('Nie udało się wczytać zadań.', 'blad'); }
  rysuj();
}

window.addEventListener('DOMContentLoaded', () => authRequireHousehold().then(wczytaj));

function podepnijPtaszki() {
  const lista = document.querySelector('.zadania');
  if (!lista) return;
  lista.onclick = async (ev) => {
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
      kaskada = await potwierdz({
        tytul: 'Zamknąć też kroki?',
        tresc: `To zadanie ma ${p.razem - p.gotowe} nieskończonych kroków.`,
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

function splaszcz(w) {
  return [w].concat(w.dzieci.flatMap(splaszcz));
}

const ZAKRESY = [['dzis', 'Dziś'], ['nadchodzace', 'Nadchodzące'], ['zrobione', 'Zrobione']];

function rysuj() {
  const drzewo = budujDrzewo(zadania);
  box().innerHTML = `
    <div class="gora"><h1>Zadania</h1></div>
    <div class="filtry" id="f-zakres">
      ${ZAKRESY.map(([k, l]) => `<button class="chip" type="button" data-z="${k}"
          aria-pressed="${k === zakres}">${l}</button>`).join('')}
    </div>
    <form class="szybkie" id="szybkie">
      <input id="sz-tytul" placeholder="Co jest do zrobienia?" autocomplete="off">
      <button class="btn btn-primary" type="submit">Dodaj</button>
    </form>
    <div class="zadania">${drzewo.map((w) => wiersz(w, 0)).join('') ||
      '<p class="pusto">Nic tu nie ma. Wpisz pierwsze zadanie powyżej.</p>'}</div>`;

  document.getElementById('f-zakres').onclick = (ev) => {
    const b = ev.target.closest('[data-z]');
    if (!b) return;
    zakres = b.dataset.z;
    wczytaj();
  };
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
      pole.value = '';
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
  // Przy 412 px czwarty poziom zostawia na tytuł około 200 px.
  const wciecie = Math.min(poziom, 2) * 18;
  return `
    <div class="zad${w.status === 'zrobione' ? ' zrobione' : ''}" style="padding-left:${wciecie}px">
      <button class="ptaszek" type="button" data-ptaszek="${w.id}"
              aria-label="Odhacz zadanie">${w.status === 'zrobione' ? ikonaSvg('ptaszek') : ''}</button>
      <div class="zad-tresc">
        <div class="zad-tytul">${w.kamien_milowy ? '<span class="kamien"></span>' : ''}${esc(w.tytul)}</div>
        ${nast.tytul ? `<div class="zad-nast">następne: ${esc(nast.tytul)}</div>` : ''}
      </div>
      ${w.termin ? `<span class="zad-termin${spozniony ? ' po-czasie' : ''}">${dataPl(w.termin)}</span>` : ''}
      ${p.razem && !w.kamien_milowy ? `<span class="zad-postep">${p.gotowe} z ${p.razem}</span>` : ''}
    </div>
    ${w.dzieci.map((d) => wiersz(d, poziom + 1)).join('')}`;
}

function dataPl(iso) {
  const [r, m, d] = String(iso).slice(0, 10).split('-');
  return `${d}.${m}.${r}`;
}
