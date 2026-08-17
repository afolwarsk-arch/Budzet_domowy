// wiem.eat — dziennik jedzenia.
//
// Cała logika strony /eat. Osobny plik, nie doklejamy do app.js (1400 linii
// finansów) — sekcje mają się nie mieszać.

const POSILKI = [
  ['sniadanie', 'Śniadanie'],
  ['obiad', 'Obiad'],
  ['kolacja', 'Kolacja'],
  ['przekaska', 'Przekąski'],
];

let dzienISO = new Date().toLocaleDateString('sv-SE');   // sv-SE daje YYYY-MM-DD lokalnie
let stanDnia = null;
// Kod z nieudanego skanu — dokleja sie do zdjecia etykiety, zeby produkt zapisal
// sie pod wlasciwym kodem. Czyszczony przy otwarciu i zamknieciu arkusza, bo
// inaczej potrafil przylgnac do zupelnie innego produktu.
let ostatniKod = '';
// Odczyt z PRZODU opakowania czekający na doklejenie do tabeli z tyłu. Tabela
// nie zawiera ani nazwy produktu, ani liczby sztuk — jedno i drugie stoi
// z przodu. Czyszczony razem z kodem, żeby nie przylgnął do innego produktu.
let odczytZPrzodu = null;
// Numer ostatniego wyszukiwania — starsza, wolniejsza odpowiedź nie może
// nadpisać nowszej.
let licznikSzukania = 0;

function e(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
const zaokr = (v) => Math.round(Number(v) || 0);
// Makro do dziesiątej części grama — tyle trzyma baza (NUMERIC(7,1)) i tyle
// podaje Open Food Facts. Końcówka „,0" jest szumem, więc ją ucinamy:
// 4.9 zostaje 4.9, ale 12.0 pokazujemy jako 12.
const dziesietne = (v) => {
  const x = Math.round((Number(v) || 0) * 10) / 10;
  return Number.isInteger(x) ? String(x) : x.toFixed(1);
};
// Pola z ułamkami są type="text", nie type="number". W polu liczbowym
// wpisanie „4,9" na polskiej klawiaturze daje PUSTĄ wartość — przeglądarka
// uznaje ją za niepoprawną — a Number('') to zero. Po cichu wyzerowałoby to
// makro. Tutaj bierzemy przecinek i kropkę tak samo; serwer też oba przyjmuje.
// „1 porcja", ale „2 porcje" i „1,5 porcji" — bez tego przyciski mówiłyby
// „0,5 porcja". Wspólne dla ekranu przepisu i dla edycji wpisu z przepisu.
const slowoPorcji = (n) => {
  if (n === 1) return 'porcja';
  if (Number.isInteger(n) && n >= 2 && n <= 4) return 'porcje';
  return 'porcji';
};
const etykPorcji = (n) => ({ 0.5: '½ porcji', 1.5: '1½ porcji' })[n]
  || `${dziesietne(n)} ${slowoPorcji(n)}`;

const zPola = (el) => {
  if (!el) return 0;
  const x = parseFloat(String(el.value).replace(',', '.'));
  return Number.isFinite(x) ? x : 0;
};

function etykietaDnia(iso) {
  const dzis = new Date().toLocaleDateString('sv-SE');
  if (iso === dzis) return 'Dziś';
  const wczoraj = new Date(Date.now() - 86400000).toLocaleDateString('sv-SE');
  if (iso === wczoraj) return 'Wczoraj';
  return new Date(iso + 'T12:00:00').toLocaleDateString('pl-PL',
    { weekday: 'long', day: 'numeric', month: 'long' });
}

// ── ekran dnia ──────────────────────────────────────────────────────────────

async function wczytajDzien() {
  document.getElementById('tytul-dnia').textContent = etykietaDnia(dzienISO);
  try {
    const r = await authFetch('/api/eat/dzien?data=' + dzienISO);
    if (!r.ok) throw new Error();
    stanDnia = await r.json();
  } catch {
    // Komunikat bez wyjścia jest ślepym zaułkiem — dajemy drogę naprzód.
    document.getElementById('posilki').innerHTML =
      '<p class="komunikat blad">Nie udało się wczytać dnia. '
      + '<button type="button" id="d-ponow" class="mini-btn">Spróbuj ponownie</button></p>';
    const b = document.getElementById('d-ponow');
    if (b) b.onclick = wczytajDzien;
    return;
  }
  rysujPosilki();
  rysujBilans();
}

// Wpisy z tym samym `grupa_id` to jedno danie rozłożone na składniki. Kolejność
// zachowujemy — grupa siada tam, gdzie stoi jej pierwszy składnik.
function pogrupuj(wpisy) {
  const wynik = [];
  const gdzie = {};
  wpisy.forEach((w) => {
    if (!w.grupa_id) { wynik.push({ wpis: w }); return; }
    if (gdzie[w.grupa_id] === undefined) {
      gdzie[w.grupa_id] = wynik.length;
      wynik.push({ grupa: w.grupa_id, nazwa: w.grupa_nazwa || 'Danie', skladniki: [] });
    }
    wynik[gdzie[w.grupa_id]].skladniki.push(w);
  });
  return wynik;
}

// Formy dla 2–4 sztuk („2 sztuki", nie „2 sztuka"). Lista pokrywa wszystkie
// jednostki z bazy surowców; dla czegokolwiek spoza niej wypisujemy „2 × …",
// co jest brzydsze, ale nigdy nie jest błędem językowym.
// [forma dla 2–4, dopełniacz po „½"] — „2 sztuki" i „½ sztuki", nie „2 sztuka"
// ani „½ sztuka". Lista pokrywa wszystkie 20 jednostek z bazy surowców.
const JEDN_ODMIANY = {
  'porcja': ['porcje', 'porcji'],          'sztuka': ['sztuki', 'sztuki'],
  'łyżka': ['łyżki', 'łyżki'],             'garść': ['garście', 'garści'],
  'szklanka': ['szklanki', 'szklanki'],    'kromka': ['kromki', 'kromki'],
  'puszka': ['puszki', 'puszki'],          'plaster': ['plastry', 'plastra'],
  'łyżeczka': ['łyżeczki', 'łyżeczki'],    'kubek': ['kubki', 'kubka'],
  'talerz': ['talerze', 'talerza'],        'kawałek': ['kawałki', 'kawałka'],
  'połówka': ['połówki', 'połówki'],       'opakowanie': ['opakowania', 'opakowania'],
  'kieliszek': ['kieliszki', 'kieliszka'], 'ząbek': ['ząbki', 'ząbka'],
  'trójkącik': ['trójkąciki', 'trójkącika'], 'filiżanka': ['filiżanki', 'filiżanki'],
  'butelka': ['butelki', 'butelki'],       'plastry': ['plastry', 'plastra'],
};

function etykJednostki(n, jedn) {
  const nazwa = jedn || 'porcja';
  const formy = JEDN_ODMIANY[nazwa.toLowerCase()];
  if (n === 1) return '1 ' + nazwa;
  // Nieznana jednostka: „2 × słoiczek" jest brzydsze, ale nigdy nie jest błędem.
  if (n < 1) return '½ ' + (formy ? formy[1] : nazwa);
  return formy ? n + ' ' + formy[0] : n + ' × ' + nazwa;
}

// Podpis wielkości pod nazwą produktu. Opakowanie wolno wspomnieć TYLKO wtedy,
// gdy produkt naprawdę je ma — pomidor z bazy surowców żadnego nie ma, a mimo to
// dostawał dopisek „opakowanie 120 g", bo waga sztuki szła do pola opak_g.
function podpisWielkosci(p) {
  const porcja = Number(p.porcja_g) || 0;
  if (porcja) {
    return '1 ' + e(p.opis_porcji || 'porcja') + ' ≈ ' + zaokr(porcja) + ' g · ';
  }
  return p.opak_g ? 'opakowanie ' + zaokr(p.opak_g) + ' g · ' : '';
}

// Rozpiska składników zamrożona przy zjedzeniu dania z przepisu. Nie czytamy
// jej z przepisu na żywo — ten mógł zostać potem poprawiony albo skasowany,
// a w dzienniku ma stać to, co było w TAMTYM talerzu.
function parsujRozpiske(json) {
  if (!json) return null;
  try {
    const x = JSON.parse(json);
    return Array.isArray(x) && x.length ? x : null;
  } catch { return null; }
}

function wiersz(w, wSrodku) {
  // Treść wiersza to prawdziwy <button>, a nie div z role="button": krzyżyk
  // obok jest osobnym przyciskiem, a przycisk w przycisku to nieprawidłowy
  // HTML i klawiatura gubi się w nim. Kliknięcie w treść otwiera edycję —
  // najczęstsza poprawka to gramatura („dodałem 100 g, a zjadłem 180").
  const rozpiska = parsujRozpiske(w.skladniki_json);
  const klucz = 'w' + w.id;
  const otwarta = !!rozpiska && grupyOtwarte.has(klucz);
  const sam = `<div class="poz${wSrodku ? ' poz-skl' : ''}">
    ${rozpiska ? `<button class="strzalka-btn" data-rozpiska="${klucz}" type="button"
        aria-expanded="${otwarta}" aria-label="Pokaż składniki"><span class="strzalka">›</span></button>` : ''}
    <button class="poz-tresc" data-edytuj="${w.id}" type="button" title="Stuknij, żeby poprawić">
      <span class="nz">${e(w.nazwa)}</span>
      <span class="il">${e(w.opis_porcji || dziesietne(w.ilosc_g) + ' g')}</span>
      <span class="kc">${zaokr(w.kcal)}</span>
    </button>
    <button class="x" data-usun="${w.id}" title="Usuń">&times;</button>
  </div>`;
  if (!rozpiska) return sam;
  return `<div class="z-rozpiska${otwarta ? ' rozwinieta' : ''}">
    ${sam}
    <div class="rozpiska"${otwarta ? '' : ' hidden'}>
      ${rozpiska.map((s) => `<div class="rz">
        <span class="rz-n">${e(s.nazwa)}</span>
        <span class="rz-g">${dziesietne(s.ilosc_g)} g</span>
        <span class="rz-k">${zaokr(s.kcal)} kcal</span>
      </div>`).join('')}
      <div class="rz-stopka">Tyle poszło na tę porcję. Zapisane w chwili zjedzenia —
        późniejsze poprawki przepisu tego nie zmieniają.</div>
    </div>
  </div>`;
}

function kartaGrupy(g) {
  const suma = g.skladniki.reduce((s, w) => s + Number(w.kcal || 0), 0);
  const otwarta = grupyOtwarte.has(g.grupa);
  return `<div class="grupa${otwarta ? ' rozwinieta' : ''}">
    <div class="poz grupa-gl">
      <button class="poz-tresc" data-grupa="${g.grupa}" type="button"
              aria-expanded="${otwarta}" title="Pokaż składniki">
        <span class="strzalka" aria-hidden="true">›</span>
        <span class="nz">${e(g.nazwa)}</span>
        <span class="il">${g.skladniki.length} skł.</span>
        <span class="kc">${zaokr(suma)}</span>
      </button>
      <button class="x" data-usun-grupa="${g.grupa}" title="Usuń całe danie">&times;</button>
    </div>
    <div class="grupa-srodek"${otwarta ? '' : ' hidden'}>
      ${g.skladniki.map((w) => wiersz(w, true)).join('')}
      <button class="mini-btn" data-przepis="${g.grupa}" data-nazwa="${e(g.nazwa)}"
              data-kcal="${Math.round(suma)}"
              type="button" style="margin:4px 0 2px 12px">Zapisz jako przepis</button>
      <button class="mini-btn" data-rozlacz="${g.grupa}"
              type="button" style="margin:4px 0 2px 6px">Rozłącz</button>
    </div>
  </div>`;
}

// Które grupy są rozwinięte — poza DOM-em, żeby przerysowanie dnia po edycji
// nie zwijało wszystkiego z powrotem.
const grupyOtwarte = new Set();

// Tryb scalania: { posilek, zazn: Set(id) }. Nie zakładamy z góry, że coś jest
// daniem — wrzucasz składniki tak, jak je skanujesz, a dopiero potem zaznaczasz
// te, które poszły na jeden talerz.
let trybScalania = null;

function wierszDoScalenia(w, zaznaczony) {
  return `<label class="poz" style="cursor:pointer">
    <input type="checkbox" data-scal="${w.id}" ${zaznaczony ? 'checked' : ''}
           style="margin-right:10px;width:20px;height:20px;flex:0 0 auto">
    <span class="nz">${e(w.nazwa)}</span>
    <span class="il">${e(w.opis_porcji || dziesietne(w.ilosc_g) + ' g')}</span>
    <span class="kc">${zaokr(w.kcal)}</span>
  </label>`;
}

function rysujPosilki() {
  const box = document.getElementById('posilki');
  box.innerHTML = POSILKI.map(([klucz, nazwa]) => {
    const wpisy = (stanDnia.posilki && stanDnia.posilki[klucz]) || [];
    const suma = wpisy.reduce((s, w) => s + Number(w.kcal || 0), 0);

    if (trybScalania && trybScalania.posilek === klucz) {
      // Scalać da się tylko pozycje luźne — te, które już są w daniu, mają
      // własną grupę i najpierw trzeba je rozłączyć.
      const luzne = wpisy.filter((w) => !w.grupa_id);
      const zazn = trybScalania.zazn;
      const wybrane = luzne.filter((w) => zazn.has(String(w.id)));
      const kcalWybranych = wybrane.reduce((s, w) => s + Number(w.kcal || 0), 0);
      return `<div class="posilek">
        <div class="pgl"><b>${nazwa}</b><span class="sum">Zaznacz składniki dania</span></div>
        ${luzne.map((w) => wierszDoScalenia(w, zazn.has(String(w.id)))).join('')}
        <div style="padding:10px 12px">
          <input type="text" id="scal-nazwa" maxlength="120" style="width:100%;margin-bottom:8px"
                 placeholder="Nazwa dania, np. Obiad z kurczakiem"
                 value="${e(trybScalania.nazwa || '')}">
          <div class="komunikat" style="margin:0 0 8px">
            ${wybrane.length ? `Wybrano ${wybrane.length} — razem <b>${zaokr(kcalWybranych)} kcal</b>.`
              : 'Zaznacz co najmniej dwie pozycje.'}
          </div>
          <button class="mini-btn" id="scal-ok" type="button"
                  ${wybrane.length < 2 ? 'disabled' : ''}>Scal w danie</button>
          <button class="mini-btn" id="scal-anuluj" type="button">Anuluj</button>
        </div>
      </div>`;
    }
    // Treść wiersza to prawdziwy <button>, a nie div z role="button": krzyżyk
    // obok jest osobnym przyciskiem, a przycisk w przycisku to nieprawidłowy
    // HTML i klawiatura gubi się w nim. Kliknięcie w treść otwiera edycję —
    // najczęstsza poprawka to gramatura („dodałem 100 g, a zjadłem 180"),
    // więc nie chowamy jej pod dodatkową ikonką.
    const wiersze = pogrupuj(wpisy).map((el) => (el.grupa ? kartaGrupy(el) : wiersz(el.wpis))).join('');
    // „Scal" pokazujemy dopiero, gdy jest co scalać — przy jednej pozycji
    // przycisk tylko zabierałby miejsce.
    const luznych = wpisy.filter((w) => !w.grupa_id).length;
    return `<div class="posilek">
      <div class="pgl"><b>${nazwa}</b><span class="sum">${suma ? zaokr(suma) + ' kcal' : '—'}</span></div>
      ${wiersze}
      <button class="dodaj-mini" data-dodaj="${klucz}" type="button">+ Dodaj</button>
      ${luznych > 1 ? `<button class="mini-btn" data-scalaj="${klucz}" type="button"
              style="margin:2px 0 8px 12px">Scal w danie</button>` : ''}
    </div>`;
  }).join('');

  box.querySelectorAll('[data-dodaj]').forEach((b) => {
    b.onclick = () => otworzArkusz(b.dataset.dodaj);
  });

  // ── scalanie pozycji w danie ──
  box.querySelectorAll('[data-scalaj]').forEach((b) => {
    b.onclick = () => {
      trybScalania = { posilek: b.dataset.scalaj, zazn: new Set(), nazwa: '' };
      rysujPosilki();
    };
  });
  box.querySelectorAll('[data-scal]').forEach((c) => {
    c.onchange = () => {
      if (!trybScalania) return;
      // Nazwę czytamy PRZED przerysowaniem, inaczej to, co wpisałeś, znika
      // przy pierwszym stuknięciu w kratkę.
      const polaN = document.getElementById('scal-nazwa');
      if (polaN) trybScalania.nazwa = polaN.value;
      const id = c.dataset.scal;
      if (c.checked) trybScalania.zazn.add(id); else trybScalania.zazn.delete(id);
      rysujPosilki();
    };
  });
  const anuluj = document.getElementById('scal-anuluj');
  if (anuluj) anuluj.onclick = () => { trybScalania = null; rysujPosilki(); };
  const nazwaPole = document.getElementById('scal-nazwa');
  if (nazwaPole) {
    nazwaPole.oninput = () => { if (trybScalania) trybScalania.nazwa = nazwaPole.value; };
  }
  const scalOk = document.getElementById('scal-ok');
  if (scalOk) {
    scalOk.onclick = async () => {
      if (!trybScalania || trybScalania.zazn.size < 2) return;
      scalOk.disabled = true;
      const ids = [...trybScalania.zazn].map(Number);
      const nazwa = (trybScalania.nazwa || '').trim();
      try {
        const r = await authFetch('/api/eat/wpisy/scal', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids, nazwa }),
        });
        if (!r.ok) { scalOk.disabled = false; return; }
        const d = await r.json();
        trybScalania = null;
        // Świeżo scalone danie otwieramy — widać od razu, co się w nim znalazło.
        if (d.grupa_id) grupyOtwarte.add(d.grupa_id);
        await wczytajDzien();
      } catch { scalOk.disabled = false; }
    };
  }
  box.querySelectorAll('[data-rozlacz]').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      try {
        const r = await authFetch('/api/eat/grupa/' + b.dataset.rozlacz + '/rozlacz',
                                  { method: 'POST' });
        if (r.ok) await wczytajDzien(); else b.disabled = false;
      } catch { b.disabled = false; }
    };
  });
  box.querySelectorAll('[data-usun]').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      try {
        const r = await authFetch('/api/eat/wpis/' + b.dataset.usun, { method: 'DELETE' });
        if (r.ok) await wczytajDzien(); else b.disabled = false;
      } catch { b.disabled = false; }
    };
  });
  const poId = {};
  Object.values(stanDnia.posilki || {}).forEach((lista) => {
    (lista || []).forEach((w) => { poId[w.id] = w; });
  });
  box.querySelectorAll('[data-edytuj]').forEach((el) => {
    const wpis = poId[el.dataset.edytuj];
    if (wpis) el.onclick = () => edytujWpis(wpis);
  });

  box.querySelectorAll('[data-rozpiska]').forEach((b) => {
    b.onclick = () => {
      const k = b.dataset.rozpiska;
      if (grupyOtwarte.has(k)) grupyOtwarte.delete(k); else grupyOtwarte.add(k);
      rysujPosilki();
    };
  });
  box.querySelectorAll('[data-grupa]').forEach((b) => {
    b.onclick = () => {
      const id = b.dataset.grupa;
      if (grupyOtwarte.has(id)) grupyOtwarte.delete(id); else grupyOtwarte.add(id);
      rysujPosilki();
    };
  });
  box.querySelectorAll('[data-usun-grupa]').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      try {
        const r = await authFetch('/api/eat/grupa/' + b.dataset.usunGrupa, { method: 'DELETE' });
        if (r.ok) { grupyOtwarte.delete(b.dataset.usunGrupa); await wczytajDzien(); }
        else b.disabled = false;
      } catch { b.disabled = false; }
    };
  });
  box.querySelectorAll('[data-przepis]').forEach((b) => {
    b.onclick = () => zapiszJakoPrzepis(b.dataset.przepis, b.dataset.nazwa, b.dataset.kcal);
  });
}

// „Zapisz jako przepis" z tego, co już zjedzone. Najtańsza droga do przepisu:
// gramatury i wartości są sprawdzone, więc nie ma tu ani zgadywania, ani AI.
// Pytamy tylko o to, czego z dziennika nie da się wywnioskować — na ile porcji
// danie wychodziło, skoro zjadłeś jedną.
function zapiszJakoPrzepis(grupaId, nazwa, kcalZapisane) {
  if (arkusz) return;
  const kcalGrupy = Number(kcalZapisane) || 0;
  arkusz = document.createElement('div');
  arkusz.className = 'ark-tlo';
  arkusz.innerHTML = `<div class="ark">
    <div class="ark-gl">
      <h2 style="font-size:1rem">Zapisz jako przepis</h2>
      <button class="x" id="zamknij3" type="button" aria-label="Zamknij">&times;</button>
    </div>
    <div class="sek-tyt">Nazwa dania</div>
    <input type="text" id="pp-nazwa" maxlength="120" value="${e(nazwa)}" style="width:100%">
    <div class="sek-tyt">Co masz zapisane w dzienniku</div>
    <div class="gdzie" id="pp-co">
      <button data-co="calosc" aria-pressed="true" type="button">Całe danie</button>
      <button data-co="porcja" aria-pressed="false" type="button">Jedną porcję</button>
    </div>
    <div class="sek-tyt">Na ile porcji dzieli się całe danie</div>
    <input type="text" id="pp-porcje" value="1" inputmode="decimal" autocomplete="off" style="width:100%">
    <div class="komunikat" id="pp-podglad"></div>
    <div id="ark-komunikat"></div>
    <button class="cta" id="pp-zapisz" type="button">Zapisz przepis</button>
  </div>`;
  document.body.appendChild(arkusz);
  try { history.pushState({ ark: 1 }, ''); } catch {}
  arkusz.addEventListener('click', (ev) => { if (ev.target === arkusz) zamknijArkusz(); });
  arkusz.querySelector('#zamknij3').onclick = () => zamknijArkusz();

  // Czy to, co w dzienniku, to cały garnek czy jeden talerz. Bez tego pytania
  // „na ile porcji" znaczyło dwie różne rzeczy naraz i przy zapisanym całym
  // daniu wychodziło, że jedna porcja to całe danie.
  let co = 'calosc';
  const podglad = () => {
    const porcje = zPola(arkusz.querySelector('#pp-porcje')) || 1;
    const naPorcje = co === 'calosc' ? kcalGrupy / porcje : kcalGrupy;
    arkusz.querySelector('#pp-podglad').innerHTML = kcalGrupy
      ? `Jedna porcja wyjdzie <b>${zaokr(naPorcje)} kcal</b>, całe danie
         <b>${zaokr(co === 'calosc' ? kcalGrupy : kcalGrupy * porcje)} kcal</b>.`
      : 'Wybierz, czy w dzienniku masz cały garnek, czy jeden talerz.';
  };
  arkusz.querySelector('#pp-co').onclick = (ev) => {
    const b = ev.target.closest('[data-co]');
    if (!b) return;
    arkusz.querySelectorAll('#pp-co [data-co]').forEach((x) => x.setAttribute('aria-pressed', 'false'));
    b.setAttribute('aria-pressed', 'true');
    co = b.dataset.co;
    podglad();
  };
  arkusz.querySelector('#pp-porcje').addEventListener('input', podglad);
  podglad();

  arkusz.querySelector('#pp-zapisz').onclick = async (ev) => {
    const nazwaP = arkusz.querySelector('#pp-nazwa').value.trim();
    const porcje = zPola(arkusz.querySelector('#pp-porcje'));
    if (!nazwaP) { komunikat('Podaj nazwę dania.', true); return; }
    if (!porcje || porcje <= 0) { komunikat('Podaj liczbę porcji.', true); return; }
    ev.target.disabled = true;
    try {
      const r = await authFetch('/api/eat/przepisy/z-grupy/' + grupaId, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        // całe danie w dzienniku → reprezentuje wszystkie porcje, mnożnik 1
        body: JSON.stringify({ nazwa: nazwaP, porcje, zapisane_porcje: co === 'calosc' ? porcje : 1 }),
      });
      if (!r.ok) {
        const x = await r.json().catch(() => ({}));
        komunikat(x.detail || 'Nie udało się zapisać.', true);
        ev.target.disabled = false; return;
      }
      zamknijArkusz();
      location.href = '/przepisy';
    } catch { komunikat('Błąd połączenia.', true); ev.target.disabled = false; }
  };
}

// Poprawka pozycji już wpisanej do dnia. Podstawę „na 100 g" odtwarzamy z
// SAMEGO WPISU, nie z produktu: wartości zamrożone przy zapisie są tym, co
// zatwierdziłeś, i zmiana gramatury nie ma po cichu wciągnąć innych liczb,
// gdyby ktoś w międzyczasie poprawił produkt w bazie.
function edytujWpis(w) {
  if (arkusz) return;
  posilekDocelowy = w.posilek;
  arkusz = document.createElement('div');
  arkusz.className = 'ark-tlo';
  arkusz.innerHTML = '<div class="ark"></div>';
  document.body.appendChild(arkusz);
  try { history.pushState({ ark: 1 }, ''); } catch {}
  arkusz.addEventListener('click', (ev) => { if (ev.target === arkusz) zamknijArkusz(); });

  const g = Number(w.ilosc_g) || 0;
  const na100 = g > 0 ? {
    kcal: Number(w.kcal || 0) / g * 100,
    bialko: Number(w.bialko || 0) / g * 100,
    tluszcz: Number(w.tluszcz || 0) / g * 100,
    wegle: Number(w.wegle || 0) / g * 100,
    opak_g: 0,
  } : null;
  // Poprawianie ILOŚCI to niemal wszystko, po co się tu wchodzi, więc ekran ma
  // wyglądać tak samo jak przy dodawaniu. Ręczna korekta liczb i usunięcie
  // czekają pod zwijaną linijką. Bez `na100` (wpis bez gramatury) nie ma czego
  // skalować — wtedy od razu stary formularz.
  // Danie z przepisu poprawia się w PORCJACH — „100 g jajecznicy" nic nie znaczy,
  // a przy okazji trzeba ruszyć liczbę porcji i zamrożoną rozpiskę, czym zajmuje
  // się serwer.
  const porcjeTeraz = Number(w.porcje_zjedzone) || 0;
  if (w.przepis_id && porcjeTeraz > 0) {
    ekranPorcji(w, na100 || { kcal: 0, opak_g: 0 }, null, null,
                { id: w.id, wpis: w }, { teraz: porcjeTeraz });
    return;
  }
  if (na100) {
    ekranPorcji(w, na100, w.produkt_id || null,
                { g: g, etyk: 'jak teraz', opis: w.opis_porcji || null },
                { id: w.id, wpis: w });
    return;
  }
  ekranPotwierdzenia(w, na100, w.produkt_id || null, '', { id: w.id });
}

// Paski na dole: skala bierze się z celu, więc bez ustawionego celu nie mają
// sensu — dlatego cel da się zmienić jednym przyciskiem obok daty.
function rysujBilans() {
  const c = stanDnia.cele || {};
  const s = stanDnia.suma || {};
  // Kalorie biorą kolor modułu (zieleń), reszta ma własne barwy ze zwalidowanej
  // palety wykresów. Nie używamy tu `--good`, bo po przemalowaniu modułu na
  // zielono białko zlewało się z kaloriami.
  const wiersze = [
    ['Kalorie', s.kcal, c.kcal, 'kcal', 'var(--accent)'],
    ['Białko', s.bialko, c.bialko, 'g', '#2a78d6'],
    ['Tłuszcz', s.tluszcz, c.tluszcz, 'g', '#eb6834'],
    ['Węgle', s.wegle, c.wegle, 'g', '#8e44c4'],
  ];
  document.getElementById('bilans-in').innerHTML = wiersze.map(([n, jest, cel, jedn, kolor]) => {
    const z = Number(jest || 0);
    const k = Number(cel || 0);
    // Przekroczenie ma być WIDOCZNE — przy zwykłym Math.min 2000/2000 i
    // 2900/2000 wyglądały identycznie. Bez czerwieni i bez wykrzykników:
    // apka informuje, nie robi wyrzutów.
    const nad = k > 0 && z > k;
    // Pasek pokazuje większą z dwóch wartości, więc po przekroczeniu oba
    // odcinki sumują się dokładnie do 100% i nic nie wychodzi poza tor.
    const skala = Math.max(z, k);
    const pct = skala > 0 ? (Math.min(z, k) / skala) * 100 : 0;
    const pctNad = nad ? ((z - k) / skala) * 100 : 0;
    // „ile zostało" zamiast „ile zjadłem" — przy odchudzaniu to jest ta liczba,
    // której się szuka, a odejmowanie w pamięci pięć razy dziennie to podatek.
    // Kalorie w pełnych jednostkach, makro do 0,1 g — w sumie dnia dziesiąte
    // części kilku pozycji potrafią złożyć się na pełny gram.
    const licz = jedn === 'g' ? dziesietne : zaokr;
    const glowna = nad ? '+' + licz(z - k) : licz(Math.max(0, k - z));
    return `<div>
      <div class="bl-n">${n}</div>
      <div class="bl-w">${glowna}<small> ${nad ? 'ponad cel' : 'zostało'}</small></div>
      <div class="bl-d">${licz(z)} / ${zaokr(k)} ${jedn}</div>
      <div class="pas"><span style="width:${pct.toFixed(1)}%;background:${kolor}"></span>
        ${nad ? `<span class="pas-nad" style="width:${pctNad.toFixed(1)}%;background:${kolor}"></span>` : ''}</div>
    </div>`;
  }).join('');

  // Dopóki nikt nie ustawił celu, paski mierzą wobec wartości domyślnej —
  // trzeba to powiedzieć, zamiast udawać, że to czyjś wybór.
  const stopka = document.getElementById('bilans-uwaga');
  if (stopka) {
    stopka.innerHTML = c.domyslne
      ? 'Cel jest domyślny — <button type="button" id="b-cel" class="mini-btn">ustaw swój</button>'
      : '';
    const b = document.getElementById('b-cel');
    if (b) b.onclick = oknoCeli;
  }
  odstepPodBilans();
}

// Pasek bilansu jest przyklejony do dołu i zasłaniałby ostatni posiłek, więc
// pod treścią musi zostać dokładnie tyle miejsca, ile pasek zajmuje. Sztywna
// liczba w CSS rozjeżdżała się przy każdej zmianie zawartości paska (doszedł
// wiersz „zjedzone / cel" i uwaga o celu domyślnym), a na dodatek pasek jest
// wyższy przy większej czcionce systemowej. Mierzymy zamiast zgadywać.
function odstepPodBilans() {
  const pasek = document.querySelector('.bilans');
  if (!pasek) return;
  // Liczymy od GÓRY paska do dołu okna, nie samą jego wysokość: na telefonie
  // pasek stoi 64 px nad dołem (nad dolną nawigacją), więc trzeba zostawić
  // miejsce także na to, co jest pod nim.
  const g = pasek.getBoundingClientRect();
  const zajete = Math.ceil(window.innerHeight - g.top);
  document.querySelector('main').style.paddingBottom = (zajete + 24) + 'px';
}

// Obrót telefonu i wejście klawiatury zmieniają wysokość okna, a razem z nią
// zawijanie się paska — wtedy odstęp trzeba przeliczyć.
window.addEventListener('resize', odstepPodBilans);

// ── arkusz dodawania ────────────────────────────────────────────────────────

let posilekDocelowy = 'sniadanie';
let arkusz = null;
let sluchacz = null;

function zamknijArkusz(zHistorii) {
  zatrzymajSkaner();
  // Wynik dyktowania docierający po zamknięciu arkusza wywoływał błąd i gubił
  // odpowiedź AI, za którą już zapłaciliśmy.
  if (sluchacz) { try { sluchacz.abort(); } catch {} sluchacz = null; }
  ostatniKod = '';
  odczytZPrzodu = null;
  if (arkusz) {
    arkusz.remove();
    arkusz = null;
    if (!zHistorii && history.state && history.state.ark) {
      try { history.back(); } catch {}
    }
  }
}

// Powrót z podekranu (porcje, przepisy, historia) do listy dróg.
//
// NIE wolno tu użyć zamknijArkusz() + otworzArkusz(): zamknijArkusz woła
// history.back(), które działa ASYNCHRONICZNIE. Nowy arkusz zdążył się otworzyć
// i zrobić pushState, a spóźniony popstate trafiał w niego i gasił wszystko —
// strzałka „wróć" zamykała cały ekran zamiast cofać o krok.
function wrocDoArkusza() {
  const posilek = posilekDocelowy;
  zamknijArkusz(true);      // bez ruszania historii
  otworzArkusz(posilek);    // pushState pominie, bo wpis {ark:1} nadal stoi
}

window.addEventListener('popstate', () => { if (arkusz) zamknijArkusz(true); });
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && arkusz) zamknijArkusz();
});

function otworzArkusz(posilek) {
  // Podwojne stukniecie w ,+ Dodaj' tworzylo drugi arkusz; pierwszy zostawal
  // w DOM na stale i zaslanial ekran po zamknieciu drugiego.
  if (arkusz) return;
  ostatniKod = '';   // kod z poprzedniego, nieudanego skanu nie moze tu przeciec
  posilekDocelowy = posilek;
  const nazwa = (POSILKI.find((p) => p[0] === posilek) || [, 'Posiłek'])[1];
  arkusz = document.createElement('div');
  arkusz.className = 'ark-tlo';
  arkusz.innerHTML = `
    <div class="ark">
      <div class="ark-gl">
        <h2>${nazwa}</h2>
        <button class="x" id="ark-x" type="button" aria-label="Zamknij">&times;</button>
      </div>

      <div class="szukaj">
        <input type="text" id="ark-szukaj" placeholder="Szukaj albo opisz, co zjadłeś" autocomplete="off">
        <button class="mik" id="ark-mik" type="button" aria-label="Podyktuj">
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3"/></svg>
        </button>
      </div>
      <div id="ark-komunikat"></div>

      <div id="ark-wyniki" style="display:none;margin-bottom:14px"></div>

      <div id="skaner-wrap">
        <video id="skaner" playsinline muted></video>
        <div class="komunikat">Skieruj aparat na kod kreskowy.</div>
      </div>

      <div class="drogi">
        <button class="droga glowna" id="d-skan" type="button">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7.5V5a1.5 1.5 0 0 1 1.5-1.5h2.5M16.5 3.5H19A1.5 1.5 0 0 1 20.5 5v2.5M20.5 16.5V19a1.5 1.5 0 0 1-1.5 1.5h-2.5M7.5 20.5H5A1.5 1.5 0 0 1 3.5 19v-2.5"/><path d="M7 8v8M10 8v8M13.5 8v8M17 8v8"/></svg>
          <span><span class="t">Skanuj kod kreskowy</span><span class="o">Najszybsze przy wszystkim z opakowania</span></span>
        </button>
        <!-- <label for>, a NIE przycisk wołający .click() w skrypcie. Etykieta
             otwiera aparat natywnie, bez pośrednictwa JS — to znosi całą klasę
             błędów, w której kliknięcie nic nie robiło i nawet nie zgłaszało
             błędu. Pola plików leżą poniżej, poza tą siatką. -->
        <label class="droga" for="ark-plik-przod" tabindex="0" role="button">
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5.5" y="3.5" width="13" height="17" rx="2"/><path d="M8.5 8h7M8.5 11.5h7M8.5 15h4"/></svg>
          <span class="t">Zdjęcie przodu</span><span class="o">Odczyta nazwę i poszuka w bazie</span>
        </label>
        <label class="droga" for="ark-plik" tabindex="0" role="button">
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="6" width="17" height="13" rx="2.5"/><circle cx="12" cy="12.5" r="3.4"/><path d="M8.5 6l1.4-2.2h4.2L15.5 6"/></svg>
          <span class="t">Zdjęcie tabeli z tyłu</span><span class="o">Gdy trzeba odczytać wartości odżywcze</span>
        </label>
        <button class="droga" id="d-opis" type="button">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 6.5h15M4.5 12h15M4.5 17.5h9"/></svg>
          <span class="t">Opisz słowami</span><span class="o">Domowy obiad bez kodu</span>
        </button>
        <button class="droga" id="d-przepisy" type="button">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.6 5.2A2 2 0 0 1 5.6 3.4H11v16.4H5.6a2 2 0 0 1-2-2z"/><path d="M20.4 5.2a2 2 0 0 0-2-1.8H13v16.4h5.4a2 2 0 0 0 2-2z"/></svg>
          <span class="t">Twoje przepisy</span><span class="o">Dania, które już zapisałeś</span>
        </button>
        <button class="droga" id="d-historia" type="button">
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 9.5h17M8 3.5v3M16 3.5v3"/><path d="M12 12.5v3l2 1.2"/></svg>
          <span class="t">Z dziennika</span><span class="o">Przejrzyj, co jadłeś w inne dni</span>
        </button>
      </div>

      <div id="ark-ulubione-sek" hidden>
        <div class="sek-tyt">Ulubione</div>
        <div id="ark-ulubione"></div>
      </div>
      <div class="sek-tyt">Ostatnio jadłeś</div>
      <div id="ark-ostatnie"><div class="komunikat">Wczytuję…</div></div>
      <!-- „schowane", a nie display:none. Pole z display:none bywa przez
           przeglądarki traktowane jak nieistniejące i odmawia otwarcia aparatu
           — bez błędu, po prostu nic się nie dzieje. Tu pole nadal jest
           renderowane, tylko niewidoczne. -->
      <input type="file" id="ark-plik" accept="image/*" capture="environment" class="schowane">
      <input type="file" id="ark-plik-przod" accept="image/*" capture="environment" class="schowane">
    </div>`;
  document.body.appendChild(arkusz);
  // W trybie aplikacji „wstecz" jest podstawowym gestem zamykania. Bez wpisu w
  // historii wychodziło z modułu i kasowało wypełniony formularz.
  //
  // Wpis dokładamy tylko wtedy, gdy jeszcze go nie ma. Przy powrocie z podekranu
  // (wrocDoArkusza) arkusz jest przebudowywany, a jego wpis w historii cały czas
  // stoi — drugi pushState zostawiłby martwy wpis i „wstecz" trzeba by klikać
  // tyle razy, przez ile podekranów się przeszło.
  try {
    if (!(history.state && history.state.ark)) history.pushState({ ark: 1 }, '');
  } catch {}
  arkusz.addEventListener('click', (ev) => { if (ev.target === arkusz) zamknijArkusz(); });
  arkusz.querySelector('#ark-x').onclick = zamknijArkusz;
  arkusz.querySelector('#d-skan').onclick = uruchomSkaner;
  arkusz.querySelector('#d-przepisy').onclick = () => ekranListyPrzepisow('');
  arkusz.querySelector('#d-historia').onclick = () => ekranHistorii(dzienISO, '');
  // Etykiety otwierają aparat same z siebie; skryptu potrzeba tylko po to, żeby
  // działały także z klawiatury — na <label> Enter nic nie robi.
  arkusz.querySelectorAll('label.droga[for]').forEach((l) => {
    l.onkeydown = (ev) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      ev.preventDefault();
      const cel = document.getElementById(l.getAttribute('for'));
      if (cel) cel.click();
    };
  });
  arkusz.querySelector('#ark-plik-przod').onchange = (ev) => {
    const plik = ev.target.files && ev.target.files[0];
    if (plik) wyslijPrzod(plik);
    ev.target.value = '';   // ten sam plik dwa razy z rzędu też ma zadziałać
  };
  arkusz.querySelector('#d-opis').onclick = () => {
    const pole = arkusz.querySelector('#ark-szukaj');
    // Stuknięcie w „Opisz słowami" przy pustym polu to prośba o miejsce na opis,
    // a nie błąd — wcześniej witało czerwonym komunikatem.
    if (!pole.value.trim()) {
      pole.placeholder = 'np. dwa jajka i kromka chleba';
      pole.focus();
      return;
    }
    wyslijOpis(pole.value);
  };
  arkusz.querySelector('#ark-plik').onchange = wyslijEtykiete;
  arkusz.querySelector('#ark-mik').onclick = dyktuj;
  // Wpisywanie szuka produktów po nazwie (własna baza + Open Food Facts).
  // Dopiero gdy nic nie ma, proponujemy oszacowanie opisu przez AI.
  let czekaSzukanie = null;
  const poleSzukaj = arkusz.querySelector('#ark-szukaj');
  poleSzukaj.addEventListener('input', () => {
    clearTimeout(czekaSzukanie);
    const fraza = poleSzukaj.value.trim();
    if (fraza.length < 3) { pokazWyniki(null); return; }
    // odczekujemy pół sekundy, żeby nie odpytywać bazy przy każdej literze
    czekaSzukanie = setTimeout(() => szukajProduktow(fraza), 500);
  });
  poleSzukaj.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { clearTimeout(czekaSzukanie); szukajProduktow(poleSzukaj.value.trim()); }
  });
  wczytajOstatnie();
  wczytajUlubione();
}

// Ulubione są PRZYPIĘTE ręcznie, więc stoją nad „ostatnio jadłeś", które tylko
// zgaduje po dacie. Sekcja jest ukryta, dopóki nikt nic nie przypiął — pusty
// nagłówek „Ulubione" uczyłby, że funkcja nie działa.
//
// Kliknięcie prowadzi do ekranu porcji, a nie zapisuje od razu: ulubiony to
// PRODUKT, a nie zapamiętana porcja — ilość wciąż trzeba wskazać.
async function wczytajUlubione() {
  const sek = arkusz && arkusz.querySelector('#ark-ulubione-sek');
  const box = arkusz && arkusz.querySelector('#ark-ulubione');
  if (!sek || !box) return;
  try {
    const lista = await (await authFetch('/api/eat/ulubione')).json();
    if (!Array.isArray(lista) || !lista.length) return;
    box.innerHTML = lista.map((p, i) => `
      <button class="szybka" data-i="${i}" type="button">
        <span class="nz"><b>${e(p.nazwa)}</b><span>${p.marka ? e(p.marka) + ' · ' : ''}${zaokr(p.kcal)} kcal/100 g</span></span>
      </button>`).join('');
    box.querySelectorAll('[data-i]').forEach((b) => {
      b.onclick = () => ekranProduktu(lista[b.dataset.i], 'wlasna');
    });
    sek.hidden = false;
  } catch { /* brak ulubionych nie ma prawa zepsuć całego arkusza */ }
}

function komunikat(tekst, blad) {
  const el = arkusz && arkusz.querySelector('#ark-komunikat');
  if (el) el.innerHTML = tekst ? `<div class="komunikat${blad ? ' blad' : ''}">${e(tekst)}</div>` : '';
}

async function wczytajOstatnie() {
  const box = arkusz.querySelector('#ark-ostatnie');
  try {
    const lista = await (await authFetch('/api/eat/ostatnie')).json();
    if (!lista.length) {
      box.innerHTML = '<div class="komunikat">Jeszcze nic tu nie ma. Zeskanuj pierwszy produkt — kolejne wpisy pójdą stąd jednym stuknięciem.</div>';
      return;
    }
    box.innerHTML = lista.map((p, i) => `
      <button class="szybka" data-i="${i}" type="button">
        <span class="nz"><b>${e(p.nazwa)}</b><span>${e(p.opis_porcji || dziesietne(p.ilosc_g) + ' g')}${p.ile > 1 ? ' · ' + p.ile + '×' : ''}</span></span>
        <span class="kc">${zaokr(p.kcal)}</span>
      </button>`).join('');
    box.querySelectorAll('[data-i]').forEach((b) => {
      b.onclick = () => dodajGotowy(lista[b.dataset.i]);
    });
  } catch {
    box.innerHTML = '<div class="komunikat blad">Nie udało się wczytać.</div>';
  }
}

// Powtórka z „ostatnio jadłeś" dostaje TEN SAM ekran porcji co świeżo wyszukany
// produkt. Wcześniej trafiała na stary formularz i najczęstsza droga w całej
// apce wyglądała inaczej niż każda inna.
//
// Wpis w dzienniku zna tylko zjedzoną gramaturę i wartości dla NIEJ, więc na 100
// g przeliczamy sami. Wielkość opakowania i liczba sztuk siedzą przy produkcie,
// nie przy wpisie — dlatego, gdy wpis ma `produkt_id`, dociągamy produkt, żeby
// wróciły warianty „całe opak." i „1 szt.".
async function dodajGotowy(p) {
  const g = Number(p.ilosc_g) || 0;
  if (!(g > 0)) {          // wpis bez gramatury: nie ma czego skalować
    ekranPotwierdzenia({
      nazwa: p.nazwa, opis_porcji: p.opis_porcji, ilosc_g: 100,
      kcal: Number(p.kcal) || 0, bialko: Number(p.bialko) || 0,
      tluszcz: Number(p.tluszcz) || 0, wegle: Number(p.wegle) || 0,
    });
    return;
  }
  const na100 = {
    kcal: Number(p.kcal || 0) / g * 100,
    bialko: Number(p.bialko || 0) / g * 100,
    tluszcz: Number(p.tluszcz || 0) / g * 100,
    wegle: Number(p.wegle || 0) / g * 100,
    opak_g: 0, sztuk: 0,
  };
  const poz = { nazwa: p.nazwa, ilosc_g: g, marka: null, ulubiony: false };

  if (p.produkt_id) {
    // Dociągnięcie produktu to podróż do serwera. Bez tego stuknięcie w owsiankę
    // przez ułamek sekundy nie robi nic i wygląda jak niedziałający przycisk.
    komunikat('Chwila…');
    try {
      const r = await authFetch('/api/eat/produkty/' + p.produkt_id);
      if (r.ok) {
        const prod = await r.json();
        na100.opak_g = Number(prod.opak_g) || 0;
        na100.sztuk = Number(prod.sztuk_w_opak) || 0;
        na100.porcja_g = Number(prod.porcja_g) || 0;
        na100.opis_porcji = prod.opis_porcji || null;
        poz.marka = prod.marka || null;
        poz.ulubiony = !!prod.ulubiony;
      }
    } catch { /* bez produktu zostają porcje wyliczone z samego wpisu */ }
  }
  // Poprzednia porcja idzie pierwsza — po to się tu w ogóle wraca.
  // `etyk` to napis na przycisku, `opis` to TEKST ZAPISYWANY przy wpisie. Muszą
  // być rozdzielone: gdyby do dziennika poszło „jak ostatnio", kolejna powtórka
  // pokazałaby „jak ostatnio · jak ostatnio" i tak w kółko.
  ekranPorcji(poz, na100, p.produkt_id || null, {
    g: g,
    etyk: p.opis_porcji ? p.opis_porcji + ' · jak ostatnio' : 'jak ostatnio',
    opis: p.opis_porcji || null,
  });
}

// ── szukanie po nazwie ──────────────────────────────────────────────────────

function pokazWyniki(html) {
  const box = arkusz && arkusz.querySelector('#ark-wyniki');
  if (!box) return;
  box.innerHTML = html || '';
  box.style.display = html ? 'block' : 'none';
}

async function szukajProduktow(fraza) {
  zatrzymajSkaner();
  if (!fraza || fraza.length < 3) return;
  const mojeZadanie = ++licznikSzukania;
  pokazWyniki('<div class="komunikat">Szukam…</div>');

  let d;
  try {
    d = await (await authFetch('/api/eat/szukaj?fraza=' + encodeURIComponent(fraza))).json();
  } catch {
    pokazWyniki(`<div class="komunikat blad">Nie udało się poszukać.
      <button type="button" id="w-ponow" class="mini-btn">Spróbuj ponownie</button>
      <button type="button" id="w-opis" class="mini-btn">Oszacuj z opisu</button></div>`);
    const p = arkusz && arkusz.querySelector('#w-ponow');
    if (p) p.onclick = () => szukajProduktow(fraza);
    const o = arkusz && arkusz.querySelector('#w-opis');
    if (o) o.onclick = () => wyslijOpis(fraza);
    return;
  }
  // starsza, wolniejsza odpowiedź nie może nadpisać nowszej
  if (mojeZadanie !== licznikSzukania || !arkusz) return;

  rysujWyniki(fraza, d.przepisy || [], d.wlasne || [], d.podstawowe || [], [], false, true);
  dociagnijZOpakowan(fraza, mojeZadanie, d.przepisy || [], d.wlasne || [], d.podstawowe || []);
}

// Produkty z opakowań dociągamy OSOBNYM żądaniem. Wcześniej cała odpowiedź
// czekała na Open Food Facts — do kilkudziesięciu sekund — mimo że wyniki
// lokalne były gotowe od razu.
async function dociagnijZOpakowan(fraza, mojeZadanie, przepisy, wlasne, podstawowe) {
  let d;
  try {
    d = await (await authFetch('/api/eat/szukaj/off?fraza=' + encodeURIComponent(fraza))).json();
  } catch { return; }
  if (mojeZadanie !== licznikSzukania || !arkusz) return;
  rysujWyniki(fraza, przepisy, wlasne, podstawowe, d.propozycje || [], d.off_padlo, false);
}

function rysujWyniki(fraza, przepisy, wlasne, podstawowe, propozycje, offPadlo, jeszczeSzuka) {
  const uwagaOff = offPadlo
    ? '<div class="komunikat blad">Baza produktów markowych nie odpowiada (bywa przeciążona). '
      + 'Spróbuj za chwilę albo zeskanuj kod kreskowy.</div>'
    : '';

  if (!przepisy.length && !wlasne.length && !podstawowe.length && !propozycje.length) {
    if (jeszczeSzuka) { pokazWyniki('<div class="komunikat">Szukam…</div>'); return; }
    pokazWyniki(uwagaOff + `<div class="komunikat">Nic takiego nie znalazłem.
      <button type="button" id="w-opis" class="mini-btn">Oszacuj z opisu</button></div>`);
    const b = arkusz.querySelector('#w-opis');
    if (b) b.onclick = () => wyslijOpis(fraza);
    return;
  }

  const wiersz = (p, rodzaj) => {
    const podpis = rodzaj === 'baza'
      ? (p.opis_porcji ? e(p.opis_porcji) + ' · ' : '') + zaokr(p.kcal) + ' kcal/100 g'
      : (p.marka ? e(p.marka) + ' · ' : '')
        + (p.kcal ? zaokr(p.kcal) + ' kcal/100 g' : 'brak wartości w bazie');
    return `<button class="szybka" data-rodzaj="${rodzaj}" data-kod="${e(p.kod || '')}"
              data-id="${p.id || ''}" type="button">
      <span class="nz"><b>${e(p.nazwa)}</b><span>${podpis}</span></span>
    </button>`;
  };

  // Przepisy PIERWSZE i z własnym podpisem — „capucino" ma znaleźć Twoją kawę
  // z mlekiem owsianym, zanim pokaże cokolwiek z opakowania.
  const wierszPrzepisu = (p) => {
    const porcje = Number(p.porcje) || 1;
    return `<button class="szybka" data-przepis="${p.id}" type="button">
      <span class="nz"><b>${e(p.nazwa)}</b><span>Twój przepis · ${zaokr(Number(p.kcal || 0) / porcje)} kcal / porcję</span></span>
    </button>`;
  };

  pokazWyniki(uwagaOff
    + (przepisy.length ? '<div class="sek-tyt">Twoje przepisy</div>' + przepisy.map(wierszPrzepisu).join('') : '')
    + (wlasne.length ? '<div class="sek-tyt">Wasza baza</div>' + wlasne.map((p) => wiersz(p, 'wlasna')).join('') : '')
    + (podstawowe.length ? '<div class="sek-tyt">Produkty podstawowe</div>' + podstawowe.map((p) => wiersz(p, 'baza')).join('') : '')
    + (propozycje.length ? '<div class="sek-tyt">Produkty z opakowań</div>' + propozycje.map((p) => wiersz(p, 'off')).join('') : '')
    + (jeszczeSzuka ? '<div class="komunikat">Szukam też wśród produktów z opakowań…</div>' : '')
  );

  arkusz.querySelectorAll('#ark-wyniki [data-przepis]').forEach((b) => {
    b.onclick = () => ekranPrzepisu(b.dataset.przepis);
  });

  arkusz.querySelectorAll('#ark-wyniki [data-rodzaj]').forEach((b) => {
    b.onclick = async () => {
      const rodzaj = b.dataset.rodzaj;
      if (rodzaj === 'wlasna') {
        const p = wlasne.find((x) => String(x.id) === b.dataset.id);
        if (p) ekranProduktu(p, 'wlasna');
      } else if (rodzaj === 'baza') {
        komunikat('Dodaję do Waszej bazy…');
        try {
          const r = await authFetch('/api/eat/produkty/z-bazy/' + b.dataset.id, { method: 'POST' });
          const x = await r.json().catch(() => ({}));
          if (!r.ok) { komunikat(x.detail || 'Nie udało się.', true); return; }
          komunikat('');
          ekranProduktu(x.produkt, 'baza');
        } catch { komunikat('Błąd połączenia.', true); }
      } else if (b.dataset.kod) {
        poKodzie(b.dataset.kod);
      }
    };
  });
}

// ── skanowanie kodu ─────────────────────────────────────────────────────────

let strumien = null, skanujeDalej = false;
// Bez tego druga próba w czasie pytania o zgodę na aparat tworzyła drugi
// strumień, a pierwszy nigdy nie był zatrzymywany.
let uruchamiamSkaner = false;

function zatrzymajSkaner() {
  skanujeDalej = false;
  if (strumien) { strumien.getTracks().forEach((t) => t.stop()); strumien = null; }
}

async function uruchomSkaner() {
  // Straż przed drugim uruchomieniem. Pierwsze stuknięcie nie daje natychmiast
  // efektu (czeka na zgodę na aparat), więc ludzie klikają drugi raz — a wtedy
  // poprzedni strumień gubił się bez zatrzymania i kamera zostawała zajęta.
  if (strumien || skanujeDalej || uruchamiamSkaner) return;
  uruchamiamSkaner = true;
  try {
    await _uruchomSkaner();
  } finally {
    uruchamiamSkaner = false;
  }
}

async function _uruchomSkaner() {

  if (!('BarcodeDetector' in window)) {
    komunikat('Ta przeglądarka nie umie czytać kodów. Zrób zdjęcie etykiety albo wpisz cyfry spod kreskówki.', true);
    pokazReczneWpisanie();
    return;
  }

  // Sam fakt, że BarcodeDetector istnieje, nie znaczy, że działa na tym
  // telefonie ani że obsłuży wybrane formaty. Konstruktor rzuca — wcześniej
  // stał poza try i wyjątek przepadał, zostawiając włączoną kamerę.
  let detektor;
  try {
    let obslugiwane = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];
    if (BarcodeDetector.getSupportedFormats) {
      const dostepne = await BarcodeDetector.getSupportedFormats();
      obslugiwane = obslugiwane.filter((f) => dostepne.includes(f));
    }
    if (!obslugiwane.length) throw new Error('brak formatów');
    detektor = new BarcodeDetector({ formats: obslugiwane });
  } catch {
    komunikat('Ten telefon nie umie czytać kodów kreskowych w przeglądarce. Zrób zdjęcie etykiety albo wpisz cyfry ręcznie.', true);
    pokazReczneWpisanie();
    return;
  }

  const wrap = arkusz.querySelector('#skaner-wrap');
  const video = arkusz.querySelector('#skaner');
  try {
    strumien = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch {
    komunikat('Nie mam dostępu do aparatu. Sprawdź uprawnienia strony.', true);
    pokazReczneWpisanie();
    return;
  }
  wrap.style.display = 'block';
  video.srcObject = strumien;
  await video.play().catch(() => {});
  komunikat('');

  // Po dziesięciu sekundach bez trafienia proponujemy wpisanie cyfr — bez tego
  // przy słabym świetle albo pogniecionym opakowaniu zostaje wpatrywanie się
  // w podgląd bez końca.
  const ratunek = setTimeout(() => {
    if (skanujeDalej) { komunikat('Nie widzę kodu. Podejdź bliżej albo wpisz cyfry spod kreskówki.', false); pokazReczneWpisanie(); }
  }, 10000);

  skanujeDalej = true;
  (async function petla() {
    let bledy = 0;
    while (skanujeDalej) {
      try {
        const kody = await detektor.detect(video);
        // Na opakowaniach obok EAN-13 bywa drugi kod (partia, waga). Bierzemy
        // pierwszy, który wygląda na kod produktu, a nie pierwszy z brzegu.
        const trafienie = kody.find((k) => /^\d{6,14}$/.test(String(k.rawValue || '').trim()));
        if (trafienie) {
          clearTimeout(ratunek);
          zatrzymajSkaner();
          wrap.style.display = 'none';
          await poKodzie(String(trafienie.rawValue).trim());
          return;
        }
      } catch {
        // Gdy detect() sypie przy każdej klatce, nie kręcimy się w nieskończoność
        if (++bledy > 20) {
          clearTimeout(ratunek);
          zatrzymajSkaner();
          wrap.style.display = 'none';
          komunikat('Odczyt kodu nie działa na tym telefonie. Wpisz cyfry albo zrób zdjęcie etykiety.', true);
          pokazReczneWpisanie();
          return;
        }
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    clearTimeout(ratunek);
  })();
}

// Najtańsza droga ratunkowa: cyfry spod kreskówki da się przepisać zawsze.
function pokazReczneWpisanie() {
  const box = arkusz && arkusz.querySelector('#ark-wyniki');
  if (!box || box.querySelector('#kod-reczny')) return;
  box.style.display = 'block';
  box.insertAdjacentHTML('afterbegin', `
    <div class="szukaj" style="margin-bottom:10px">
      <input type="text" id="kod-reczny" inputmode="numeric" placeholder="Wpisz cyfry spod kreskówki">
      <button class="mini-btn" id="kod-reczny-ok" type="button" style="padding:8px 14px">Szukaj</button>
    </div>`);
  const idz = () => {
    const v = (box.querySelector('#kod-reczny').value || '').replace(/\D/g, '');
    if (v.length >= 6) poKodzie(v);
    else komunikat('Kod ma co najmniej 6 cyfr.', true);
  };
  box.querySelector('#kod-reczny-ok').onclick = idz;
  box.querySelector('#kod-reczny').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); idz(); }
  });
}

async function poKodzie(kod) {
  zatrzymajSkaner();               // z każdej drogi wchodzimy z wyłączoną kamerą
  komunikat('Szukam produktu ' + kod + '…');
  try {
    const r = await authFetch('/api/eat/produkt?kod=' + encodeURIComponent(kod));
    if (r.status === 404) {
      komunikat('Nie znam tego kodu. Zrób zdjęcie etykiety — zapamiętam produkt na przyszłość.', true);
      ostatniKod = kod;
      return;
    }
    if (!r.ok) {
      // Serwer potrafi powiedzieć, co jest nie tak (zły kod, zablokowane AI) —
      // wcześniej każdy błąd wyglądał tak samo i nie dało się z tego nic wyczytać.
      const x = await r.json().catch(() => ({}));
      komunikat(x.detail || 'Nie udało się sprawdzić kodu.', true);
      return;
    }
    const d = await r.json();
    komunikat('');
    ekranProduktu(d.produkt, d.skad, d.niepelne);
  } catch { komunikat('Błąd połączenia.', true); }
}

// ── zdjęcie etykiety ────────────────────────────────────────────────────────

async function wyslijEtykiete(ev) {
  zatrzymajSkaner();
  const plik = ev.target.files && ev.target.files[0];
  if (!plik) return;
  ekranCzekania('Czytam tabelę…', 'Przepisuję wartości odżywcze z etykiety.');
  const fd = new FormData();
  fd.append('file', plik);
  // Nazwę, gramaturę i liczbę sztuk odczytane z PRZODU doklejamy do produktu
  // z tabeli — z tyłu opakowania nie ma żadnej z tych rzeczy, a bez nazwy
  // produkt lądowałby w bazie jako „Produkt bez nazwy".
  const zPrzodu = odczytZPrzodu;
  if (zPrzodu) {
    if (zPrzodu.nazwa) fd.append('nazwa', zPrzodu.nazwa);
    if (zPrzodu.marka) fd.append('marka', zPrzodu.marka);
    if (zPrzodu.opak_g) fd.append('opak_g', String(zPrzodu.opak_g));
    if (zPrzodu.sztuk) fd.append('sztuk', String(zPrzodu.sztuk));
  }
  try {
    const url = '/api/eat/etykieta' + (ostatniKod ? '?kod=' + encodeURIComponent(ostatniKod) : '');
    const r = await authFetch(url, { method: 'POST', body: fd });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { ekranBledu(d.detail || 'Nie udało się odczytać etykiety.'); return; }
    ostatniKod = '';
    odczytZPrzodu = null;
    ekranProduktu(d.produkt, 'etykieta');
  } catch { ekranBledu('Błąd połączenia.'); }
  finally { ev.target.value = ''; }
}

// ── opis słowami ────────────────────────────────────────────────────────────

async function wyslijOpis(tekst) {
  zatrzymajSkaner();
  const opis = (tekst || '').trim();
  if (opis.length < 3) { komunikat('Napisz, co zjadłeś.', true); return; }
  komunikat('Szacuję…');
  try {
    const r = await authFetch('/api/eat/opis', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ opis }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { komunikat(d.detail || 'Nie udało się oszacować.', true); return; }
    komunikat('');
    ekranPozycji(d.pozycje, opis);
  } catch { komunikat('Błąd połączenia.', true); }
}

// Dyktowanie działa na Androidzie w Chrome; gdzie indziej po prostu chowamy
// przycisk zamiast obiecywać coś, co nie zadziała.
function dyktuj() {
  zatrzymajSkaner();
  if (sluchacz) return;   // drugie stuknięcie nie tworzy drugiego nasłuchu
  const Rozpoznawanie = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Rozpoznawanie) {
    komunikat('Ta przeglądarka nie obsługuje dyktowania. Na iPhonie działa tylko '
      + 'klawiaturowy mikrofon iOS — stuknij pole i użyj go. Na Androidzie użyj Chrome.', true);
    return;
  }
  const btn = arkusz.querySelector('#ark-mik');
  const pole = arkusz.querySelector('#ark-szukaj');
  const r = new Rozpoznawanie();
  r.lang = 'pl-PL';
  r.interimResults = false;
  sluchacz = r;
  btn.classList.add('slucha');
  komunikat('Słucham…');
  r.onresult = (ev) => {
    pole.value = ev.results[0][0].transcript;
    komunikat('');
    wyslijOpis(pole.value);
  };
  // Jeden komunikat na wszystko znaczył, że „nie działa" mogło być pięcioma
  // różnymi rzeczami naraz: brakiem zgody na mikrofon, ciszą, brakiem sieci
  // albo zablokowaną usługą rozpoznawania. Bez rozróżnienia nie da się tego
  // naprawić po stronie użytkownika.
  // Bez „kłódki przy adresie": na Androidzie jej nie ma, a z ekranu początkowego
  // nie ma nawet paska adresu. Podajemy drogę, która działa wszędzie.
  const POWODY = {
    'not-allowed': 'Brak zgody na mikrofon. Chrome → ⋮ → Ustawienia → Ustawienia witryn → '
      + 'Mikrofon → ta strona → Zezwalaj. Sprawdź też, czy sam Chrome ma zgodę na mikrofon '
      + 'w ustawieniach telefonu.',
    'service-not-allowed': 'System nie zezwolił na rozpoznawanie mowy. Sprawdź w ustawieniach '
      + 'telefonu, czy Chrome ma dostęp do mikrofonu.',
    'no-speech': 'Nic nie usłyszałem. Stuknij mikrofon i mów wyraźniej.',
    'audio-capture': 'Nie znalazłem mikrofonu.',
    'network': 'Rozpoznawanie mowy wymaga internetu i właśnie go nie ma.',
    'aborted': '',
  };
  r.onerror = (ev) => {
    const kod = (ev && ev.error) || '';
    if (kod === 'aborted') return;          // sami przerwaliśmy, to nie błąd
    komunikat(POWODY[kod] || ('Dyktowanie nie zadziałało (' + (kod || 'nieznany błąd') + ').'), true);
  };
  r.onend = () => { sluchacz = null; btn.classList.remove('slucha'); };
  try {
    r.start();
  } catch (err) {
    sluchacz = null;
    btn.classList.remove('slucha');
    komunikat('Nie udało się uruchomić dyktowania: ' + (err && err.message || err), true);
  }
}

// ── ekran potwierdzenia (wspólny dla wszystkich dróg) ───────────────────────
// Nic nie ląduje w dzienniku bez tego kroku: widzisz kalorie i makro, możesz
// poprawić każdą liczbę i dopiero wtedy zatwierdzasz.
//
// `poz` opisuje pozycję dla PODANEJ ilości gramów. Gdy przyjdzie `na100`
// (produkt z bazy), zmiana gramatury przelicza wartości z niego; bez tego
// skalujemy proporcjonalnie od wartości wyjściowych.
// `edycja` = { id } zmienia ten sam ekran w poprawianie istniejącej pozycji:
// inny tytuł, zapis przez PATCH i przycisk usunięcia zamiast drogi powrotnej
// do wyszukiwarki (przy edycji nie ma dokąd wracać).
// ── wybór porcji dla produktu o znanych wartościach ─────────────────────────

// Produkt z bazy ma zdefiniowaną tabelę wartości, więc nie ma tu czego wpisywać
// — jedyne pytanie brzmi ILE go zjadłeś. Stąd brak pól makro: pokazujemy je
// tylko do odczytu, na dole. Każdy wiersz od razu mówi, ile to gramów i ile
// kalorii, i sam jest przyciskiem zapisu — wybór i zatwierdzenie to jedna
// czynność. Zasada „zobacz, zanim zapiszesz" zostaje spełniona, bo skutek
// stoi w wierszu, zanim go dotkniesz.
//
// Drogi, na których wartości są OSZACOWANIEM (opis, niepełna etykieta) oraz
// edycja wpisu idą dalej przez ekranPotwierdzenia — tam pola muszą być
// edytowalne, bo model mógł się pomylić.
// `naglowekDodatkowy` z ekranPotwierdzenia jest tu świadomie pominięty: niósł
// blok z nazwą i marką, a te przeniosły się do paska tytułu.
// `produktId` bywa NULL — przy powtórce wpisu oszacowanego z opisu nie ma za
// czym stać produkt w bazie. Wtedy znika serce (nie ma czego przypiąć), a zapis
// idzie z wartościami wprost zamiast z `produkt_id`.
// `poprzednia` (opcjonalna) to porcja, którą już raz zjadłeś — ląduje jako
// pierwszy wiersz.
// `edycja` = { id, wpis } przełącza ekran w tryb poprawki: wiersze wysyłają
// PATCH zamiast POST, a pod zwijaną linijką dochodzi ręczna korekta wartości
// i usunięcie z dnia. Przy edycji też najczęściej zmienia się ILOŚĆ, więc
// szybka droga ma wyglądać tak samo jak przy dodawaniu — ale poprawianie liczb
// musi zostać dostępne, bo przy pozycjach z AI to jedyny ratunek na złe
// oszacowanie.
function ekranPorcji(poz, na100, produktId, poprzednia, edycja, trybPorcji) {
  zatrzymajSkaner();
  const ark = arkusz && arkusz.querySelector('.ark');
  if (!ark) return;

  const opak = Number(na100.opak_g) || 0;
  const sztuk = Number(na100.sztuk) || 0;
  const jednaSzt = (opak && sztuk > 1) ? opak / sztuk : 0;
  const na100kcal = Number(na100.kcal) || 0;
  const g1 = (x) => Math.round(x * 10) / 10;
  const kcalZa = (g) => na100kcal * g / 100;

  // Danie z przepisu poprawia się W PORCJACH — „100 g jajecznicy" nic nie znaczy.
  // Skalujemy od BIEŻĄCEGO wpisu (`trybPorcji.teraz` = ile porcji tam stoi),
  // nie od przepisu: przepis mógł się zmienić albo zniknąć, a ta pozycja ma
  // dalej opisywać ten talerz.
  const wPorcjach = !!(trybPorcji && trybPorcji.teraz > 0);
  const teraz = wPorcjach ? Number(trybPorcji.teraz) : 0;

  const warianty = [];
  if (wPorcjach) {
    [0.5, 1, 1.5, 2].forEach((n) => {
      if (Math.abs(n - teraz) < 0.001) return;   // „jak teraz" doklei się niżej
      warianty.push({ etyk: etykPorcji(n), porcje: n,
                      g: g1(Number(poz.ilosc_g || 0) * n / teraz),
                      kcal: Number(poz.kcal || 0) * n / teraz });
    });
    warianty.unshift({ etyk: 'jak teraz', porcje: teraz,
                       g: g1(Number(poz.ilosc_g || 0)),
                       kcal: Number(poz.kcal || 0) });
  } else {
    // Kolejność jak w starych chipach: sztuka przed opakowaniem, bo przy pudełku
    // pralinek to jedyna porcja, którą ktokolwiek je.
    if (jednaSzt) {
      warianty.push({ etyk: '1 szt.', g: g1(jednaSzt) });
      warianty.push({ etyk: '2 szt.', g: g1(jednaSzt * 2) });
    }
    // Surowiec bez opakowania: pomidor, marchewka, cebula. Nikt ich nie waży,
    // więc bez orientacyjnej wagi sztuki zostaje wpisywanie gramów z palca.
    const porcjaG = Number(na100.porcja_g) || 0;
    if (porcjaG) {
      const nazwaJedn = na100.opis_porcji || 'porcja';
      warianty.push({ etyk: etykJednostki(1, nazwaJedn), g: g1(porcjaG) });
      warianty.push({ etyk: etykJednostki(2, nazwaJedn), g: g1(porcjaG * 2) });
      warianty.push({ etyk: etykJednostki(0.5, nazwaJedn), g: g1(porcjaG / 2) });
    }
    if (opak) {
      warianty.push({ etyk: 'całe opak.', g: g1(opak) });
      warianty.push({ etyk: '½ opak.', g: g1(opak / 2) });
    }
    warianty.push({ etyk: '100 g', g: 100 }, { etyk: '50 g', g: 50 });

    // Poprzednia porcja na samą górę, a wygenerowany duplikat o tej samej
    // gramaturze wypada — dwa wiersze z tą samą liczbą gramów tylko myliłyby.
    if (poprzednia && poprzednia.g > 0) {
      const ta = g1(poprzednia.g);
      for (let i = warianty.length - 1; i >= 0; i--) {
        if (g1(warianty[i].g) === ta) warianty.splice(i, 1);
      }
      warianty.unshift({ etyk: poprzednia.etyk || 'jak ostatnio', g: ta,
                         opis: poprzednia.opis || null });
    }
  }

  // Etykiety z „×" z przodu, bo czyta się je razem z polem obok: „2 × opak.".
  const jednostki = wPorcjach ? [{ k: 'porcje', n: '× porcja' }] : [{ k: 'g', n: 'g' }];
  if (!wPorcjach && opak) jednostki.push({ k: 'opak', n: '× opak.' });
  if (!wPorcjach && jednaSzt) jednostki.push({ k: 'szt', n: '× szt.' });

  // W trybie porcji kalorie są policzone przy wariancie (skalowane od wpisu),
  // w trybie gramów wynikają z tabeli na 100 g.
  const wiersz = (w, i) => `
    <button class="porcja-w" data-i="${i}" type="button">
      <span class="pw-e">${e(w.etyk)}</span>
      <span class="pw-g">${dziesietne(w.g)} g</span>
      <span class="pw-k">${zaokr(w.kcal !== undefined ? w.kcal : kcalZa(w.g))} kcal</span>
      <span class="pw-s" aria-hidden="true">›</span>
    </button>`;

  // Nazwa produktu idzie w pasek tytułu, a nie w osobny nagłówek nad listą —
  // dzięki temu wiersze zaczynają się od razu pod paskiem i cały ekran mieści
  // się bez przewijania także przy 320 px.
  ark.innerHTML = `
    <div class="ark-gl">
      <button class="x" id="wroc" type="button" style="margin:0" aria-label="Wróć">‹</button>
      <h2 class="ark-nazwa">${e(poz.nazwa)}${poz.marka
        ? `<span class="ark-marka">${e(poz.marka)}</span>` : ''}</h2>
      ${(produktId && !edycja) ? `<button class="serce" id="p-serce" type="button"
              aria-pressed="${poz.ulubiony ? 'true' : 'false'}"
              aria-label="Ulubiony">&#9829;</button>` : ''}
      <button class="x" id="zamknij2" type="button" aria-label="Zamknij">&times;</button>
    </div>
    <div class="porcje-lista" id="porcje">
      ${warianty.map(wiersz).join('')}
      <div class="porcja-w porcja-wlasna">
        <input type="text" id="p-krotnosc" inputmode="decimal" autocomplete="off"
               value="${wPorcjach ? dziesietne(teraz) : '1'}" aria-label="Ile">
        <select id="p-jednostka" aria-label="Jednostka">
          ${jednostki.map((j) => `<option value="${j.k}">${e(j.n)}</option>`).join('')}
        </select>
        <span class="pw-wynik">
          <span class="pw-g" id="pw-g"></span>
          <span class="pw-k" id="pw-k"></span>
        </span>
        <button class="pw-s" id="p-wlasna-ok" type="button" aria-label="Dodaj tę ilość">›</button>
      </div>
    </div>
    <div id="ark-komunikat"></div>
    <button class="zwin" id="p-zwin" type="button" aria-expanded="false" aria-controls="p-szczegoly">
      <span id="p-zwin-tekst"></span><span class="zwin-strzalka" aria-hidden="true">⌄</span>
    </button>
    <div class="zwin-tresc" id="p-szczegoly" hidden>
      <div class="sek-tyt">Do którego posiłku</div>
      <div class="gdzie" id="gdzie">
        ${POSILKI.map(([k, n]) => `<button data-p="${k}" aria-pressed="${k === posilekDocelowy}" type="button">${n}</button>`).join('')}
      </div>
      ${edycja ? `
      ${wPorcjach ? '' : '<button class="zwin-akcja" id="p-recznie" type="button">Popraw wartości ręcznie</button>'}
      <button class="cta-usun" id="p-usun" type="button">Usuń z dnia</button>` : ''}
    </div>
    ${wPorcjach ? `<div class="na100">1 porcja: <b>${zaokr(Number(poz.kcal || 0) / teraz)}</b> kcal ·
      B <b>${dziesietne(Number(poz.bialko || 0) / teraz)}</b> ·
      T <b>${dziesietne(Number(poz.tluszcz || 0) / teraz)}</b> ·
      W <b>${dziesietne(Number(poz.wegle || 0) / teraz)}</b></div>` : `
    <div class="na100">W 100 g: <b>${zaokr(na100kcal)}</b> kcal ·
      B <b>${dziesietne(na100.bialko || 0)}</b> ·
      T <b>${dziesietne(na100.tluszcz || 0)}</b> ·
      W <b>${dziesietne(na100.wegle || 0)}</b></div>`}`;

  ark.querySelector('#wroc').onclick = () => { wrocDoArkusza(); };
  ark.querySelector('#zamknij2').onclick = zamknijArkusz;

  // Zwinięta linijka musi mówić, DO CZEGO trafi wpis — inaczej ukrycie wyboru
  // posiłku znaczyłoby tyle, co jego brak. Wartości odżywcze pod nią NIE są
  // chowane: to jedyna liczba, którą sprawdza się przed wyborem porcji.
  const zwinTekst = () => {
    const nazwaP = (POSILKI.find((p) => p[0] === posilekDocelowy) || [, 'Posiłek'])[1];
    ark.querySelector('#p-zwin-tekst').textContent =
      `${nazwaP} · ${etykietaDnia(dzienISO).toLowerCase()}`
      + (edycja ? ' · popraw albo usuń' : '');
  };
  zwinTekst();

  const zwin = ark.querySelector('#p-zwin');
  zwin.onclick = () => {
    const otw = zwin.getAttribute('aria-expanded') === 'true';
    zwin.setAttribute('aria-expanded', otw ? 'false' : 'true');
    ark.querySelector('#p-szczegoly').hidden = otw;
  };

  ark.querySelector('#gdzie').onclick = (ev) => {
    const b = ev.target.closest('[data-p]');
    if (!b) return;
    ark.querySelectorAll('#gdzie [data-p]').forEach((x) => x.setAttribute('aria-pressed', 'false'));
    b.setAttribute('aria-pressed', 'true');
    posilekDocelowy = b.dataset.p;
    zwinTekst();
  };

  // ── tryb edycji: ręczna korekta i usuwanie ──
  const recznie = ark.querySelector('#p-recznie');
  // Ucieczka do starego formularza. Wiersze wyżej zmieniają ILOŚĆ, a to jest
  // droga do poprawienia samych LICZB — rozdzielone, bo jeden ekran robiący
  // obie rzeczy naraz musiałby zgadywać, którą wartość skalować od której.
  if (recznie) recznie.onclick = () => {
    ekranPotwierdzenia(edycja.wpis, na100, produktId, '', { id: edycja.id });
  };

  const usun = ark.querySelector('#p-usun');
  if (usun) usun.onclick = async (ev) => {
    ev.currentTarget.disabled = true;
    try {
      const r = await authFetch('/api/eat/wpis/' + edycja.id, { method: 'DELETE' });
      if (!r.ok) { komunikat('Nie udało się usunąć.', true); ev.currentTarget.disabled = false; return; }
      zamknijArkusz();
      await wczytajDzien();
    } catch { komunikat('Błąd połączenia.', true); ev.currentTarget.disabled = false; }
  };

  // ── serce ──
  // Stan przestawiamy OD RAZU, a cofamy dopiero gdy serwer odmówi. Przypięcie
  // to drobiazg, a czekanie na odpowiedź sieci przy stuknięciu w serce wygląda
  // jak zepsuty przycisk.
  const serce = ark.querySelector('#p-serce');
  if (serce) serce.onclick = async () => {
    const bylo = serce.getAttribute('aria-pressed') === 'true';
    serce.setAttribute('aria-pressed', bylo ? 'false' : 'true');
    try {
      const r = await authFetch('/api/eat/produkty/' + produktId + '/ulubiony', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ulubiony: !bylo }),
      });
      if (!r.ok) throw new Error('odmowa');
      poz.ulubiony = !bylo;
    } catch {
      serce.setAttribute('aria-pressed', bylo ? 'true' : 'false');
      komunikat('Nie udało się zapisać ulubionego.', true);
    }
  };

  // ── wiersz z własną krotnością ──
  const poleN = ark.querySelector('#p-krotnosc');
  const poleJ = ark.querySelector('#p-jednostka');
  const wlasnaG = () => {
    const n = zPola(poleN);
    if (!(n > 0)) return 0;
    if (wPorcjach) return g1(Number(poz.ilosc_g || 0) * n / teraz);
    const j = poleJ.value;
    return g1(n * (j === 'opak' ? opak : j === 'szt' ? jednaSzt : 1));
  };
  const wlasnyOpis = () => {
    const j = poleJ.value;
    if (j === 'g') return null;
    const n = dziesietne(zPola(poleN));
    return n + ' × ' + (j === 'opak' ? 'opak.' : 'szt.');
  };
  const odswiezWlasna = () => {
    const g = wlasnaG();
    const n = zPola(poleN);
    // Przy jednostce „g" gramatura powtarzalaby to, co wlasnie wpisales — wtedy
    // zostaje sama kaloryczność.
    const pokazG = g && poleJ.value !== 'g';
    ark.querySelector('#pw-g').textContent = pokazG ? dziesietne(g) + ' g' : '';
    const kcal = wPorcjach ? Number(poz.kcal || 0) * n / teraz : kcalZa(g);
    ark.querySelector('#pw-k').textContent = (wPorcjach ? n > 0 : g > 0)
      ? zaokr(kcal) + ' kcal' : '—';
  };
  poleN.addEventListener('input', odswiezWlasna);
  poleJ.addEventListener('change', odswiezWlasna);
  // Domyślnie gramy, więc startowa krotność 1 dałaby bezsensowny 1 g. Startujemy
  // od porcji, którą wyliczył ekranProduktu — tej samej, którą i tak podpowiadał.
  const startG = Number(poz.ilosc_g) || 100;
  poleN.value = dziesietne(startG);
  odswiezWlasna();

  ark.querySelector('#porcje').onclick = (ev) => {
    const b = ev.target.closest('.porcja-w[data-i]');
    if (!b) return;
    const w = warianty[b.dataset.i];
    // `opis` bywa jawnie ustawiony na null (powtórka bez opisu porcji) — stąd
    // sprawdzenie przez `undefined`, a nie zwykłe `||`.
    zapiszPorcje(w.g, w.opis !== undefined ? w.opis : w.etyk, b, w.porcje);
  };
  ark.querySelector('#p-wlasna-ok').onclick = (ev) => {
    if (wPorcjach) {
      const n = zPola(poleN);
      if (!(n > 0)) { komunikat('Podaj ilość większą od zera.', true); return; }
      zapiszPorcje(wlasnaG(), null, ev.currentTarget, n);
      return;
    }
    const g = wlasnaG();
    if (!g) { komunikat('Podaj ilość większą od zera.', true); return; }
    zapiszPorcje(g, wlasnyOpis(), ev.currentTarget);
  };

  async function zapiszPorcje(g, opis, przycisk, porcje) {
    if (przycisk) przycisk.disabled = true;
    komunikat('');
    try {
      // Z produktem wartości liczy SERWER z jego tabeli — klient nie ma prawa
      // podać własnych kalorii. Bez produktu (powtórka wpisu z opisu) oraz przy
      // EDYCJI nie ma z czego liczyć — trasa PATCH świadomie nie przelicza
      // z `produkt_id`, żeby pozycja została taka, jaką zatwierdziłeś — więc
      // skalujemy tu i wysyłamy wprost.
      const m = g / 100;
      const wprost = {
        nazwa: poz.nazwa, ilosc_g: g, opis_porcji: opis, posilek: posilekDocelowy,
        kcal: na100kcal * m, bialko: (na100.bialko || 0) * m,
        tluszcz: (na100.tluszcz || 0) * m, wegle: (na100.wegle || 0) * m,
      };
      // Danie z przepisu: wysyłamy samą liczbę porcji, a serwer skaluje wartości,
      // liczbę porcji I zamrożoną rozpiskę składników. Klient nie ma czym
      // przeskalować rozpiski, bo jej nie widzi.
      const cialo = porcje !== undefined && wPorcjach
        ? { posilek: posilekDocelowy, nazwa: poz.nazwa, porcje: porcje }
        : edycja ? wprost
        : produktId
          ? { data: dzienISO, posilek: posilekDocelowy, produkt_id: produktId,
              nazwa: poz.nazwa, ilosc_g: g, opis_porcji: opis }
          : Object.assign({ data: dzienISO }, wprost);
      const r = await authFetch(
        edycja ? '/api/eat/wpis/' + edycja.id : '/api/eat/wpis',
        { method: edycja ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(cialo) },
      );
      const x = await r.json().catch(() => ({}));
      if (!r.ok) {
        komunikat(x.detail || (edycja ? 'Nie udało się zapisać.' : 'Nie udało się dodać.'), true);
        if (przycisk) przycisk.disabled = false;
        return;
      }
      zamknijArkusz();
      await wczytajDzien();
      // Przy edycji nie ma paska „Cofnij": cofnięcie musiałoby przywrócić
      // poprzednie wartości, a nie skasować wpis — to dwie różne rzeczy i
      // pomylenie ich kosztowałoby dane.
      if (!edycja) pasekCofnij(poz.nazwa, x.id);
    } catch {
      komunikat('Błąd połączenia.', true);
      if (przycisk) przycisk.disabled = false;
    }
  }
}

// Zapis bez pytania jest szybki tylko wtedy, gdy pomyłka też jest tania.
// Pasek żyje kilka sekund i znika sam — świadomie nie blokuje ekranu.
function pasekCofnij(nazwa, wpisId) {
  document.querySelectorAll('.pasek-cofnij').forEach((x) => x.remove());
  if (!wpisId) return;
  const pas = document.createElement('div');
  pas.className = 'pasek-cofnij';
  pas.innerHTML = `<span>Dodano: ${e(nazwa)}</span><button type="button">Cofnij</button>`;
  document.body.appendChild(pas);
  const zdejmij = () => { clearTimeout(zegar); pas.remove(); };
  const zegar = setTimeout(zdejmij, 6000);
  pas.querySelector('button').onclick = async () => {
    zdejmij();
    try {
      await authFetch('/api/eat/wpis/' + wpisId, { method: 'DELETE' });
      await wczytajDzien();
    } catch { /* dzień odświeży się przy następnej akcji */ }
  };
}

function ekranPotwierdzenia(poz, na100, produktId, naglowekDodatkowy, edycja, wartosciStale) {
  // Produkt o znanych wartościach dostaje prostszy ekran — sam wybór ilości.
  // Edycja wpisu nigdy tam nie trafia: tam poprawianie wartości jest sensem
  // ekranu, a nie odstępstwem.
  if (wartosciStale && na100 && produktId && !edycja) {
    ekranPorcji(poz, na100, produktId);
    return;
  }
  // Bez tego strumien zyl dalej po podmianie ekranu i kolejne trafienie skanera
  // nadpisywalo formularz, ktory user wlasnie wypelnial.
  zatrzymajSkaner();
  const ark = arkusz && arkusz.querySelector('.ark');
  if (!ark) return;
  const bazowe = { g: Number(poz.ilosc_g) || 100, kcal: Number(poz.kcal) || 0,
                   bialko: Number(poz.bialko) || 0, tluszcz: Number(poz.tluszcz) || 0,
                   wegle: Number(poz.wegle) || 0 };
  let recznie = false;   // gdy sam poprawisz makro, przestajemy je przeliczać

  const porcje = [];
  // „1 sztuka" idzie PIERWSZA, bo przy pudełku pralinek to jedyna sensowna
  // porcja: kod kreskowy jest tylko na opakowaniu zbiorczym, a pojedyncza
  // czekoladka nie ma żadnego i nikt jej nie waży.
  if (na100 && na100.opak_g && na100.sztuk > 1) {
    const jedna = na100.opak_g / na100.sztuk;
    porcje.push({ etyk: '1 szt.', g: Math.round(jedna * 10) / 10 });
    porcje.push({ etyk: '2 szt.', g: Math.round(jedna * 2 * 10) / 10 });
  }
  // Surowiec bez opakowania: pomidor, marchewka, cebula. Waga sztuki jest
  // orientacyjna i po to, żeby nie ważyć pomidora — gramaturę zawsze da się
  // poprawić w polu niżej.
  if (na100 && na100.porcja_g) {
    const j = Number(na100.porcja_g);
    const nazwaJ = na100.opis_porcji || 'porcja';
    porcje.push({ etyk: etykJednostki(1, nazwaJ), g: Math.round(j * 10) / 10 });
    porcje.push({ etyk: etykJednostki(2, nazwaJ), g: Math.round(j * 2 * 10) / 10 });
    porcje.push({ etyk: etykJednostki(0.5, nazwaJ), g: Math.round(j / 2 * 10) / 10 });
  }
  if (na100 && na100.opak_g) {
    porcje.push({ etyk: 'całe opak.', g: Math.round(na100.opak_g) });
    porcje.push({ etyk: '½ opak.', g: Math.round(na100.opak_g / 2) });
  }
  porcje.push({ etyk: '100 g', g: 100 }, { etyk: '50 g', g: 50 });

  ark.innerHTML = `
    <div class="ark-gl">
      ${edycja ? '' : '<button class="x" id="wroc" type="button" style="margin:0" aria-label="Wróć">‹</button>'}
      <h2 style="font-size:1rem">${edycja ? 'Edytuj pozycję' : 'Sprawdź i dodaj'}</h2>
      <button class="x" id="zamknij2" type="button" aria-label="Zamknij">&times;</button>
    </div>
    ${naglowekDodatkowy || ''}
    <div class="sek-tyt">Nazwa</div>
    <input type="text" id="p-nazwa" value="${e(poz.nazwa)}" maxlength="120" style="width:100%;margin-bottom:12px">
    ${na100 ? `<div class="sek-tyt">Porcja</div><div class="porcje" id="porcje">
      ${porcje.map((x) => `<button class="porcja" data-g="${x.g}" aria-pressed="${Math.round(x.g) === Math.round(bazowe.g)}" type="button">${x.etyk}</button>`).join('')}
    </div>` : ''}
    ${(na100 && na100.opak_g && !na100.sztuk && na100.produkt_id) ? `
      <div class="komunikat" id="p-sztuk-wiersz">Opakowanie zbiorcze?
        <button type="button" id="p-sztuk-btn" class="mini-btn">Podaj liczbę sztuk</button></div>` : ''}
    <div class="sek-tyt">Ile gramów</div>
    <input type="text" id="p-gram" value="${dziesietne(bazowe.g)}" inputmode="decimal"
           autocomplete="off" style="width:100%;margin-bottom:12px">
    <div class="sek-tyt">Wartości — możesz poprawić</div>
    <div class="makro-siatka">
      <label>kcal<input type="number" id="p-kcal" min="0" max="9000" step="1" inputmode="numeric"></label>
      <label>Białko<input type="text" id="p-b" inputmode="decimal" autocomplete="off"></label>
      <label>Tłuszcz<input type="text" id="p-t" inputmode="decimal" autocomplete="off"></label>
      <label>Węgle<input type="text" id="p-w" inputmode="decimal" autocomplete="off"></label>
    </div>
    <div id="p-zgodnosc" class="komunikat"></div>
    <div class="sek-tyt">Do którego posiłku</div>
    <div class="gdzie" id="gdzie">
      ${POSILKI.map(([k, n]) => `<button data-p="${k}" aria-pressed="${k === posilekDocelowy}" type="button">${n}</button>`).join('')}
    </div>
    <div id="ark-komunikat"></div>
    <button class="cta" id="dodaj" type="button">${edycja ? 'Zapisz zmiany' : 'Dodaj do dnia'}</button>
    ${edycja ? '<button class="cta-usun" id="usun-wpis" type="button">Usuń z dnia</button>' : ''}`;

  const pole = (id) => ark.querySelector(id);
  const wartosci = () => ({
    g: zPola(pole('#p-gram')),
    kcal: zPola(pole('#p-kcal')),
    bialko: zPola(pole('#p-b')),
    tluszcz: zPola(pole('#p-t')),
    wegle: zPola(pole('#p-w')),
  });

  function wstaw(v) {
    // Kalorie w pełnych jednostkach — nikt nie liczy siódmych dziesiątych
    // kilokalorii. Makro z dokładnością do 0,1 g, bo przy 30 g produktu
    // zaokrąglenie do pełnych gramów potrafi zjeść jedną trzecią wartości.
    pole('#p-kcal').value = Math.round(v.kcal);
    pole('#p-b').value = dziesietne(v.bialko);
    pole('#p-t').value = dziesietne(v.tluszcz);
    pole('#p-w').value = dziesietne(v.wegle);
  }

  let poprzednieGramy = bazowe.g;

  function przelicz() {
    const gTeraz = zPola(pole('#p-gram'));
    // Po ręcznej korekcie makro nadal skalujemy przy zmianie gramatury — tylko
    // od TWOICH wartości, nie od wyjściowych. Wcześniej przeliczanie milkło
    // całkiem i dało się zapisać 30 g z kaloriami wpisanymi dla 100 g.
    if (recznie) {
      // Pole chwilowo puste (kasowanie przed wpisaniem nowej liczby) nie może
      // zerwać powiązania — inaczej wpis szedł z gramaturą jedną, a kaloriami
      // z zupełnie innej.
      if (gTeraz <= 0) { sprawdzZgodnosc(); return; }
      if (poprzednieGramy > 0 && gTeraz !== poprzednieGramy) {
        const m = gTeraz / poprzednieGramy;
        const v = wartosci();
        wstaw({ kcal: v.kcal * m, bialko: v.bialko * m, tluszcz: v.tluszcz * m, wegle: v.wegle * m });
      }
      poprzednieGramy = gTeraz;
      sprawdzZgodnosc();
      return;
    }
    poprzednieGramy = gTeraz;
    const g = gTeraz;
    if (na100) {
      const m = g / 100;
      wstaw({ kcal: na100.kcal * m, bialko: (na100.bialko || 0) * m,
              tluszcz: (na100.tluszcz || 0) * m, wegle: (na100.wegle || 0) * m });
    } else if (bazowe.g > 0) {
      const m = g / bazowe.g;
      wstaw({ kcal: bazowe.kcal * m, bialko: bazowe.bialko * m,
              tluszcz: bazowe.tluszcz * m, wegle: bazowe.wegle * m });
    }
    sprawdzZgodnosc();
  }

  // 1 g białka i węgli = 4 kcal, 1 g tłuszczu = 9 kcal. Jeśli wpisane makro
  // rozjeżdża się z kaloriami, mówimy o tym wprost zamiast po cichu zapisać
  // niespójną pozycję.
  function sprawdzZgodnosc() {
    const v = wartosci();
    const zMakro = v.bialko * 4 + v.tluszcz * 9 + v.wegle * 4;
    const box = ark.querySelector('#p-zgodnosc');
    if (!v.kcal || !zMakro) { box.textContent = ''; return; }
    const roznica = Math.abs(zMakro - v.kcal) / v.kcal;
    box.className = roznica > 0.15 ? 'komunikat blad' : 'komunikat';
    box.textContent = roznica > 0.15
      ? `Z makroskładników wychodzi ${Math.round(zMakro)} kcal, a wpisane jest ${Math.round(v.kcal)}.`
      : '';
  }

  przelicz();

  ark.querySelectorAll('#p-kcal, #p-b, #p-t, #p-w').forEach((i) => {
    i.addEventListener('input', () => { recznie = true; sprawdzZgodnosc(); });
  });
  pole('#p-gram').addEventListener('input', () => {
    // Ręczne wpisanie gramatury odznacza przycisk porcji — inaczej wpis dostawał
    // podpis „całe opak." przy 37 gramach i tak widniał w dzienniku.
    ark.querySelectorAll('.porcja').forEach((x) => x.setAttribute('aria-pressed', 'false'));
    przelicz();
  });

  // Liczba sztuk w opakowaniu — jedyny sposób, żeby zapisać „zjadłem jedną
  // pralinkę", gdy kod kreskowy jest tylko na pudełku. Zapisujemy ją przy
  // produkcie, więc pytamy raz w życiu.
  const sztukBtn = ark.querySelector('#p-sztuk-btn');
  if (sztukBtn) sztukBtn.onclick = () => {
    const wiersz = ark.querySelector('#p-sztuk-wiersz');
    wiersz.innerHTML = 'Ile sztuk w opakowaniu? '
      + '<input type="text" id="p-sztuk" inputmode="numeric" autocomplete="off" '
      + 'style="width:64px;text-align:center"> '
      + '<button type="button" id="p-sztuk-ok" class="mini-btn">Zapisz</button>';
    const inp = ark.querySelector('#p-sztuk');
    inp.focus();
    ark.querySelector('#p-sztuk-ok').onclick = async () => {
      const n = Math.round(zPola(inp));
      if (!(n >= 2 && n <= 200)) { wiersz.classList.add('blad'); return; }
      try {
        const r = await authFetch('/api/eat/produkty/' + produktId + '/sztuk', {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sztuk: n }),
        });
        if (!r.ok) { wiersz.classList.add('blad'); return; }
        const p = await r.json();
        // Przerysowujemy ekran, żeby doszły przyciski „1 szt." i „2 szt.".
        wrocDoArkusza();
        ekranProduktu(p, 'wlasna');
      } catch { wiersz.classList.add('blad'); }
    };
  };

  const listaPorcji = ark.querySelector('#porcje');
  if (listaPorcji) listaPorcji.onclick = (ev) => {
    const b = ev.target.closest('.porcja');
    if (!b) return;
    ark.querySelectorAll('.porcja').forEach((x) => x.setAttribute('aria-pressed', 'false'));
    b.setAttribute('aria-pressed', 'true');
    pole('#p-gram').value = b.dataset.g;
    recznie = false;
    przelicz();
  };

  ark.querySelector('#gdzie').onclick = (ev) => {
    const b = ev.target.closest('[data-p]');
    if (!b) return;
    ark.querySelectorAll('#gdzie [data-p]').forEach((x) => x.setAttribute('aria-pressed', 'false'));
    b.setAttribute('aria-pressed', 'true');
    posilekDocelowy = b.dataset.p;
  };
  const wroc = ark.querySelector('#wroc');
  if (wroc) wroc.onclick = () => { wrocDoArkusza(); };
  ark.querySelector('#zamknij2').onclick = zamknijArkusz;

  const kasuj = ark.querySelector('#usun-wpis');
  if (kasuj) kasuj.onclick = async (ev) => {
    ev.target.disabled = true;
    try {
      const r = await authFetch('/api/eat/wpis/' + edycja.id, { method: 'DELETE' });
      if (!r.ok) { komunikat('Nie udało się usunąć.', true); ev.target.disabled = false; return; }
      zamknijArkusz();
      await wczytajDzien();
    } catch { komunikat('Błąd połączenia.', true); ev.target.disabled = false; }
  };

  ark.querySelector('#dodaj').onclick = async (ev) => {
    ev.target.disabled = true;
    const v = wartosci();
    const nazwa = pole('#p-nazwa').value.trim();
    if (!nazwa || !v.g) { komunikat('Podaj nazwę i ilość.', true); ev.target.disabled = false; return; }
    const etyk = ark.querySelector('.porcja[aria-pressed="true"]');
    const opis = (etyk ? etyk.textContent : poz.opis_porcji) || null;
    // Przy edycji zawsze wysyłamy wartości wprost z ekranu — pozycja ma zostać
    // taka, jaką widzisz, niezależnie od tego, co dziś stoi w bazie produktów.
    // Przy dodawaniu nietkniętych wartości liczy serwer z `produkt_id`.
    const cialo = edycja
      ? { posilek: posilekDocelowy, nazwa, opis_porcji: opis, ilosc_g: v.g,
          kcal: v.kcal, bialko: v.bialko, tluszcz: v.tluszcz, wegle: v.wegle }
      : (produktId && !recznie)
        ? { data: dzienISO, posilek: posilekDocelowy, produkt_id: produktId,
            nazwa, ilosc_g: v.g, opis_porcji: etyk ? etyk.textContent : null }
        : { data: dzienISO, posilek: posilekDocelowy, nazwa, opis_porcji: opis,
            ilosc_g: v.g, kcal: v.kcal, bialko: v.bialko, tluszcz: v.tluszcz, wegle: v.wegle };
    try {
      const r = await authFetch(edycja ? '/api/eat/wpis/' + edycja.id : '/api/eat/wpis', {
        method: edycja ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cialo),
      });
      if (!r.ok) {
        const x = await r.json().catch(() => ({}));
        komunikat(x.detail || (edycja ? 'Nie udało się zapisać.' : 'Nie udało się dodać.'), true);
        ev.target.disabled = false; return;
      }
      zamknijArkusz();
      await wczytajDzien();
    } catch { komunikat('Błąd połączenia.', true); ev.target.disabled = false; }
  };
}

// ── ekran oczekiwania ───────────────────────────────────────────────────────

// Aparat systemowy zamyka się natychmiast po zdjęciu i użytkownik zostaje przed
// niezmienionym ekranem — wygląda to tak, jakby zdjęcie nic nie wywołało.
// Odczyt trwa kilka sekund, więc musi być widać, że coś się dzieje.
function ekranCzekania(tytul, podpis) {
  const ark = arkusz && arkusz.querySelector('.ark');
  if (!ark) return;
  zatrzymajSkaner();
  ark.innerHTML = `
    <div class="czekaj">
      <div class="czekaj-znak" aria-hidden="true"><i></i><i></i></div>
      <div class="czekaj-t">${e(tytul)}</div>
      <div class="czekaj-o">${e(podpis || '')}</div>
    </div>`;
}

// Po nieudanym odczycie nie zostawiamy pustego ekranu oczekiwania — musi być
// wyjście z powrotem, inaczej jedyną drogą jest zamknięcie arkusza.
function ekranBledu(tekst) {
  const ark = arkusz && arkusz.querySelector('.ark');
  if (!ark) return;
  ark.innerHTML = `
    <div class="ark-gl">
      <h2 style="font-size:1rem">Nie udało się</h2>
      <button class="x" id="zamknij-b" type="button" aria-label="Zamknij">&times;</button>
    </div>
    <div class="komunikat blad">${e(tekst)}</div>
    <button class="cta" id="wroc-b" type="button">Spróbuj inaczej</button>`;
  ark.querySelector('#zamknij-b').onclick = () => zamknijArkusz();
  ark.querySelector('#wroc-b').onclick = () => { wrocDoArkusza(); };
}

// ── dziennik jako źródło: chodzenie po dniach ───────────────────────────────

// „Ostatnio jadłeś" to płaskie dwanaście pozycji bez dat — nie da się w tym
// znaleźć obiadu sprzed dwóch tygodni. Tu chodzi się po dniach i bierze wprost
// z talerza z tamtego dnia. Wybrana pozycja trafia do DZISIEJSZEGO posiłku
// (dzienISO + posilekDocelowy), a nie z powrotem tam, skąd ją wzięto.
let licznikHistorii = 0;

async function ekranHistorii(iso, filtr) {
  const ark = arkusz && arkusz.querySelector('.ark');
  if (!ark) return;
  zatrzymajSkaner();
  const moje = ++licznikHistorii;
  const dzis = new Date().toLocaleDateString('sv-SE');

  // Szkielet rysujemy raz, żeby pole filtru nie znikało pod palcem przy
  // przerysowaniu listy — tak samo jak w liście przepisów.
  if (!ark.querySelector('#h-filtr')) {
    ark.innerHTML = `
      <div class="ark-gl">
        <button class="x" id="wroc" type="button" style="margin:0" aria-label="Wróć">‹</button>
        <h2 style="font-size:1rem">Z dziennika</h2>
        <button class="x" id="zamknij2" type="button" aria-label="Zamknij">&times;</button>
      </div>
      <div class="gdzie" id="h-nawigacja" style="margin-bottom:8px">
        <button id="h-poprz" type="button" aria-label="Poprzedni dzień">‹</button>
        <button id="h-etykieta" type="button" style="flex:1"></button>
        <button id="h-nast" type="button" aria-label="Następny dzień">›</button>
      </div>
      <input type="date" id="h-data" style="width:100%;margin-bottom:8px" max="${dzis}">
      <div class="szukaj"><input type="text" id="h-filtr" placeholder="Zawęź w tym dniu" autocomplete="off"></div>
      <div id="h-lista"><div class="komunikat">Wczytuję…</div></div>
      <div id="ark-komunikat"></div>`;
    ark.querySelector('#wroc').onclick = () => { wrocDoArkusza(); };
    ark.querySelector('#zamknij2').onclick = () => zamknijArkusz();
    ark.querySelector('#h-filtr').addEventListener('input', (ev) => {
      // Filtr działa na już pobranym dniu, więc bez opóźnienia i bez żądania.
      ekranHistorii(ark.dataset.iso || iso, ev.target.value);
    });
    ark.querySelector('#h-data').addEventListener('change', (ev) => {
      if (ev.target.value) ekranHistorii(ev.target.value, '');
    });
    const skok = (o) => {
      const d = new Date((ark.dataset.iso || iso) + 'T12:00:00');
      d.setDate(d.getDate() + o);
      const nowy = d.toLocaleDateString('sv-SE');
      if (nowy > dzis) return;          // w przyszłość nie ma po co iść
      ekranHistorii(nowy, '');
    };
    ark.querySelector('#h-poprz').onclick = () => skok(-1);
    ark.querySelector('#h-nast').onclick = () => skok(1);
  }
  ark.dataset.iso = iso;
  ark.querySelector('#h-etykieta').textContent = etykietaDnia(iso);
  ark.querySelector('#h-data').value = iso;
  ark.querySelector('#h-nast').disabled = iso >= dzis;
  if (ark.querySelector('#h-filtr').value !== (filtr || '')) {
    ark.querySelector('#h-filtr').value = filtr || '';
  }

  let d;
  try {
    const r = await authFetch('/api/eat/dzien?data=' + encodeURIComponent(iso));
    if (!r.ok) throw new Error('brak');
    d = await r.json();
  } catch {
    const box = ark.querySelector('#h-lista');
    if (box) box.innerHTML = '<div class="komunikat blad">Nie udało się wczytać tego dnia.</div>';
    return;
  }
  // starsza odpowiedź nie może nadpisać nowszej (szybkie stukanie w strzałki)
  if (moje !== licznikHistorii || !arkusz) return;

  const szukane = (filtr || '').trim().toLowerCase();
  const box = ark.querySelector('#h-lista');
  if (!box) return;

  // Wpisy trzymamy poza HTML-em: przekazanie całego wpisu przez data-* wymagałoby
  // wciskania JSON-a w atrybut, a stąd bierze się połowa błędów z cudzysłowami.
  const doWziecia = [];
  let html = '';
  POSILKI.forEach(([klucz, nazwaP]) => {
    const wpisy = (d.posilki && d.posilki[klucz] || [])
      .filter((w) => !szukane || (w.nazwa || '').toLowerCase().includes(szukane));
    if (!wpisy.length) return;
    html += `<div class="sek-tyt">${nazwaP}</div>`;
    wpisy.forEach((w) => {
      const i = doWziecia.push(w) - 1;
      html += `<button class="szybka" data-h="${i}" type="button">
        <span class="nz"><b>${e(w.nazwa)}</b><span>${e(w.opis_porcji || dziesietne(w.ilosc_g) + ' g')} · ${zaokr(w.kcal)} kcal</span></span>
      </button>`;
    });
  });

  box.innerHTML = html || `<div class="komunikat">${szukane
    ? 'Nic takiego w tym dniu.'
    : 'W tym dniu nic nie zapisałeś. Przejdź strzałkami do innego dnia.'}</div>`;

  box.querySelectorAll('[data-h]').forEach((b) => {
    b.onclick = () => dodajGotowy(doWziecia[Number(b.dataset.h)]);
  });
}

// ── lista własnych przepisów w arkuszu ──────────────────────────────────────

// Osobna droga obok skanowania i opisu. Wyszukiwarka i tak podpowiada przepisy,
// ale tylko po wpisaniu frazy — a często chce się po prostu zobaczyć, co się ma.
let licznikListyPrzepisow = 0;

async function ekranListyPrzepisow(fraza) {
  const ark = arkusz && arkusz.querySelector('.ark');
  if (!ark) return;
  zatrzymajSkaner();
  const moje = ++licznikListyPrzepisow;

  // Szkielet rysujemy OD RAZU, żeby pole wyszukiwania nie znikało pod palcem
  // przy każdym wczytaniu — przerysowujemy tylko listę pod spodem.
  if (!ark.querySelector('#lp-szukaj')) {
    ark.innerHTML = `
      <div class="ark-gl">
        <button class="x" id="wroc" type="button" style="margin:0" aria-label="Wróć">‹</button>
        <h2 style="font-size:1rem">Twoje przepisy</h2>
        <button class="x" id="zamknij2" type="button" aria-label="Zamknij">&times;</button>
      </div>
      <div class="szukaj"><input type="text" id="lp-szukaj" placeholder="Szukaj wśród przepisów" autocomplete="off"></div>
      <div id="lp-lista"><div class="komunikat">Wczytuję…</div></div>
      <div id="ark-komunikat"></div>`;
    ark.querySelector('#wroc').onclick = () => { wrocDoArkusza(); };
    ark.querySelector('#zamknij2').onclick = () => zamknijArkusz();
    let cisza = null;
    ark.querySelector('#lp-szukaj').addEventListener('input', (ev) => {
      clearTimeout(cisza);
      const f = ev.target.value;
      cisza = setTimeout(() => ekranListyPrzepisow(f), 200);
    });
  }

  let lista;
  try {
    const r = await authFetch('/api/eat/przepisy?fraza=' + encodeURIComponent(fraza || ''));
    if (!r.ok) throw new Error('brak');
    lista = (await r.json()).przepisy || [];
  } catch {
    const box = ark.querySelector('#lp-lista');
    if (box) box.innerHTML = '<div class="komunikat blad">Nie udało się wczytać przepisów.</div>';
    return;
  }
  // starsza, wolniejsza odpowiedź nie może nadpisać nowszej
  if (moje !== licznikListyPrzepisow || !arkusz) return;

  const box = ark.querySelector('#lp-lista');
  if (!box) return;
  if (!lista.length) {
    box.innerHTML = fraza
      ? '<div class="komunikat">Nic nie pasuje do tej nazwy.</div>'
      : '<div class="komunikat">Nie masz jeszcze przepisów. '
        + '<a href="/przepisy">Zapisz pierwszy</a> — potem dodasz go tu dwoma stuknięciami.</div>';
    return;
  }
  box.innerHTML = lista.map((p) => {
    const porcje = Number(p.porcje) || 1;
    return `<button class="szybka" data-przepis="${p.id}" type="button">
      <span class="nz"><b>${e(p.nazwa)}</b><span>${zaokr(Number(p.kcal || 0) / porcje)} kcal / porcję${
        p.uzyc > 0 ? ' · użyte ' + p.uzyc + '×' : ''}</span></span>
    </button>`;
  }).join('');
  box.querySelectorAll('[data-przepis]').forEach((b) => {
    // `true` — „wstecz" ma wrócić do listy, z której się przyszło, a nie na
    // ekran startowy arkusza.
    b.onclick = () => ekranPrzepisu(b.dataset.przepis, true);
  });
}

// ── zdjęcie przodu opakowania ───────────────────────────────────────────────

// Tabela wartości jest z tyłu, ale nazwy produktu tam nie ma — a bez nazwy nie
// da się go wyszukać. To zdjęcie bierze z przodu to, czego tabela nie zawiera.
async function wyslijPrzod(plik) {
  ekranCzekania('Czytam opakowanie…', 'Odczytuję nazwę i szukam jej w bazie produktów.');
  const fd = new FormData();
  fd.append('file', plik);
  let d;
  try {
    const r = await authFetch('/api/eat/etykieta-przod', { method: 'POST', body: fd });
    d = await r.json().catch(() => ({}));
    if (!r.ok) { ekranBledu(d.detail || 'Nie udało się odczytać opakowania.'); return; }
  } catch { ekranBledu('Błąd połączenia.'); return; }
  if (!arkusz) return;
  ekranZPrzodu(d);
}

function ekranZPrzodu(d) {
  const ark = arkusz && arkusz.querySelector('.ark');
  if (!ark) return;
  zatrzymajSkaner();
  const o = d.odczyt || {};
  const wlasne = d.wlasne || [];
  const propozycje = d.propozycje || [];

  const wiersz = (p, rodzaj) => `<button class="szybka" data-rodzaj="${rodzaj}"
      data-kod="${e(p.kod || '')}" data-id="${p.id || ''}" type="button">
    <span class="nz"><b>${e(p.nazwa)}</b><span>${(p.marka ? e(p.marka) + ' · ' : '')
      + (p.kcal ? zaokr(p.kcal) + ' kcal/100 g' : 'brak wartości w bazie')}</span></span>
  </button>`;

  ark.innerHTML = `
    <div class="ark-gl">
      <button class="x" id="wroc" type="button" style="margin:0" aria-label="Wróć">‹</button>
      <h2 style="font-size:1rem">Odczytane z opakowania</h2>
      <button class="x" id="zamknij2" type="button" aria-label="Zamknij">&times;</button>
    </div>
    <div class="prod-gora">
      <div class="marka">${e(o.marka || '')}</div>
      <h3>${e(o.nazwa || '')}</h3>
      <div class="op">${o.opak_g ? 'opakowanie ' + zaokr(o.opak_g) + ' g' : 'gramatury nie widać'}${
        o.sztuk ? ' · ' + zaokr(o.sztuk) + ' szt.' : ''}</div>
    </div>
    ${d.off_padlo ? '<div class="komunikat blad">Baza produktów markowych odmówiła odpowiedzi '
      + '(odbija większość zapytań przy natłoku). To NIE znaczy, że produktu tam nie ma — '
      + 'spróbuj poszukać jeszcze raz.</div>' : ''}
    ${wlasne.length ? '<div class="sek-tyt">Macie już u siebie</div>'
      + wlasne.map((p) => wiersz(p, 'wlasna')).join('') : ''}
    <div class="sek-tyt">Znalezione w bazie zewnętrznej</div>
    <div id="p-wyniki">${propozycje.length
      ? propozycje.map((p) => wiersz(p, 'off')).join('')
      : `<div class="komunikat">${d.off_padlo ? 'Nie udało się sprawdzić.'
        : 'Nic nie znalazłem pod tą nazwą.'}</div>`}</div>
    <div class="szukaj" style="margin-top:8px">
      <input type="text" id="p-fraza" value="${e(d.szukano_zapasowo || d.szukano || o.nazwa || '')}"
             autocomplete="off" aria-label="Czego szukać w bazie">
      <button class="mini-btn" id="p-szukaj" type="button" style="margin:0">Szukaj</button>
    </div>
    <div class="komunikat">Możesz poprawić hasło i poszukać ponownie — bez robienia
      zdjęcia od nowa.</div>
    <div class="sek-tyt">Albo dokończ ręcznie</div>
    <!-- Etykieta, nie przycisk: aparat otwiera się natywnie, bez .click() ze
         skryptu. Pole jest WŁASNE — ten ekran podmienia całą zawartość arkusza,
         więc pole z ekranu startowego już nie istnieje. -->
    <label class="cta" for="p-plik-tyl" id="p-tabela" tabindex="0" role="button"
           style="display:block;text-align:center">Zdjęcie tabeli z tyłu</label>
    <input type="file" id="p-plik-tyl" accept="image/*" capture="environment" class="schowane">
    <div id="ark-komunikat"></div>`;

  ark.querySelector('#zamknij2').onclick = () => zamknijArkusz();
  ark.querySelector('#wroc').onclick = () => { wrocDoArkusza(); };
  // Nazwa i liczba sztuk z przodu doklejają się do produktu odczytanego z tyłu —
  // tamta tabela nie zawiera ani jednego, ani drugiego.
  odczytZPrzodu = o;
  ark.querySelector('#p-plik-tyl').onchange = wyslijEtykiete;
  ark.querySelector('#p-tabela').onkeydown = (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    ev.preventDefault();
    ark.querySelector('#p-plik-tyl').click();
  };

  function podepnijWyniki() {
    ark.querySelectorAll('[data-rodzaj]').forEach((b) => {
      b.onclick = () => {
        if (b.dataset.rodzaj === 'wlasna') {
          const p = wlasne.find((x) => String(x.id) === b.dataset.id);
          if (p) ekranProduktu(p, 'wlasna');
        } else if (b.dataset.kod) {
          poKodzie(b.dataset.kod);
        }
      };
    });
  }
  podepnijWyniki();

  // Powtórne szukanie BEZ ponownego zdjęcia. Open Food Facts odbija większość
  // anonimowych zapytań i wtedy „nic nie znalazłem" jest nieprawdą — produkt
  // często tam jest, tylko serwer odmówił odpowiedzi.
  const szukajPonownie = async () => {
    const fraza = ark.querySelector('#p-fraza').value.trim();
    if (fraza.length < 3) return;
    const box = ark.querySelector('#p-wyniki');
    box.innerHTML = '<div class="komunikat">Szukam…</div>';
    try {
      const r = await authFetch('/api/eat/szukaj/off?fraza=' + encodeURIComponent(fraza));
      const x = await r.json().catch(() => ({}));
      const lista = x.propozycje || [];
      box.innerHTML = lista.length
        ? lista.map((p) => wiersz(p, 'off')).join('')
        : `<div class="komunikat${x.off_padlo ? ' blad' : ''}">${x.off_padlo
          ? 'Baza znowu odmówiła. Spróbuj jeszcze raz za chwilę.'
          : 'Nic nie znalazłem pod tym hasłem.'}</div>`;
      podepnijWyniki();
    } catch { box.innerHTML = '<div class="komunikat blad">Błąd połączenia.</div>'; }
  };
  ark.querySelector('#p-szukaj').onclick = szukajPonownie;
  ark.querySelector('#p-fraza').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); szukajPonownie(); }
  });
}

// ── ekran przepisu w dzienniku ──────────────────────────────────────────────

// Przepis wybrany z wyszukiwarki dziennika. Pełne dane dociągamy osobno, bo
// lista wyszukiwania nie niesie składników ani wagi odniesienia.
async function ekranPrzepisu(id, zListy) {
  const ark = arkusz && arkusz.querySelector('.ark');
  if (!ark) return;
  zatrzymajSkaner();
  ark.innerHTML = '<div class="komunikat">Wczytuję przepis…</div>';
  let p;
  try {
    const r = await authFetch('/api/eat/przepisy/' + id);
    if (!r.ok) throw new Error('brak');
    p = await r.json();
  } catch {
    ark.innerHTML = '<div class="komunikat blad">Nie udało się wczytać przepisu.</div>';
    return;
  }
  if (!arkusz) return;

  const porcjeDania = Number(p.porcje) || 1;
  // Waga odniesienia: ręcznie wpisana waga gotowego dania albo suma składników,
  // gdy nic nie odparowuje. Dzięki temu gramy działają przy każdym przepisie.
  const waga = Number(p.waga_odniesienia_g) || 0;
  // Ten sam wzorzec co przy produkcie: wiersz mówi, ile to porcji i ile kalorii,
  // i sam zapisuje wpis. Gramy przestały być osobnym przełącznikiem — weszły
  // jako druga jednostka do wiersza z własną ilością.
  const kcalDania = Number(p.kcal || 0);
  const gramyZa = (n) => (waga ? Math.round(waga * n / porcjeDania * 10) / 10 : 0);

  const warianty = [0.5, 1, 1.5, 2].map((n) => ({ n: n, etyk: etykPorcji(n) }));

  const wiersz = (w, i) => `
    <button class="porcja-w" data-i="${i}" type="button">
      <span class="pw-e">${e(w.etyk)}</span>
      <span class="pw-g">${gramyZa(w.n) ? dziesietne(gramyZa(w.n)) + ' g' : ''}</span>
      <span class="pw-k">${zaokr(kcalDania * w.n / porcjeDania)} kcal</span>
      <span class="pw-s" aria-hidden="true">›</span>
    </button>`;

  const jednostki = [{ k: 'porcje', n: '× porcja' }];
  if (waga) jednostki.push({ k: 'gramy', n: 'g' });

  ark.innerHTML = `
    <div class="ark-gl">
      <button class="x" id="wroc" type="button" style="margin:0" aria-label="Wróć">‹</button>
      <h2 class="ark-nazwa">${e(p.nazwa)}<span class="ark-marka">Twój przepis</span></h2>
      <button class="x" id="zamknij2" type="button" aria-label="Zamknij">&times;</button>
    </div>
    <div class="porcje-lista" id="porcje">
      ${warianty.map(wiersz).join('')}
      <div class="porcja-w porcja-wlasna">
        <input type="text" id="p-krotnosc" inputmode="decimal" autocomplete="off" value="1"
               aria-label="Ile">
        <select id="p-jednostka" aria-label="Jednostka">
          ${jednostki.map((j) => `<option value="${j.k}">${e(j.n)}</option>`).join('')}
        </select>
        <span class="pw-wynik">
          <span class="pw-g" id="pw-g"></span>
          <span class="pw-k" id="pw-k"></span>
        </span>
        <button class="pw-s" id="p-wlasna-ok" type="button" aria-label="Dodaj tę ilość">›</button>
      </div>
    </div>
    <div id="ark-komunikat"></div>
    <button class="zwin" id="p-zwin" type="button" aria-expanded="false" aria-controls="p-szczegoly">
      <span id="p-zwin-tekst"></span><span class="zwin-strzalka" aria-hidden="true">⌄</span>
    </button>
    <div class="zwin-tresc" id="p-szczegoly" hidden>
      <div class="sek-tyt">Do którego posiłku</div>
      <div class="gdzie" id="gdzie">
        ${POSILKI.map(([k, n]) => `<button data-p="${k}" aria-pressed="${k === posilekDocelowy}" type="button">${n}</button>`).join('')}
      </div>
    </div>
    <div class="na100">1 porcja: <b>${zaokr(kcalDania / porcjeDania)}</b> kcal ·
      B <b>${dziesietne(Number(p.bialko || 0) / porcjeDania)}</b> ·
      T <b>${dziesietne(Number(p.tluszcz || 0) / porcjeDania)}</b> ·
      W <b>${dziesietne(Number(p.wegle || 0) / porcjeDania)}</b></div>`;

  const pole = (s) => ark.querySelector(s);

  const zwinTekst = () => {
    const nazwaP = (POSILKI.find((x) => x[0] === posilekDocelowy) || [, 'Posiłek'])[1];
    pole('#p-zwin-tekst').textContent =
      `${nazwaP} · ${etykietaDnia(dzienISO).toLowerCase()}`;
  };
  zwinTekst();

  const zwin = pole('#p-zwin');
  zwin.onclick = () => {
    const otw = zwin.getAttribute('aria-expanded') === 'true';
    zwin.setAttribute('aria-expanded', otw ? 'false' : 'true');
    pole('#p-szczegoly').hidden = otw;
  };

  pole('#gdzie').onclick = (ev) => {
    const b = ev.target.closest('[data-p]');
    if (!b) return;
    ark.querySelectorAll('#gdzie [data-p]').forEach((x) => x.setAttribute('aria-pressed', 'false'));
    b.setAttribute('aria-pressed', 'true');
    posilekDocelowy = b.dataset.p;
    zwinTekst();
  };
  pole('#wroc').onclick = () => {
    if (zListy) { ekranListyPrzepisow(''); return; }
    wrocDoArkusza();
  };
  pole('#zamknij2').onclick = () => zamknijArkusz();

  // ── wiersz z własną ilością ──
  const poleN = pole('#p-krotnosc');
  const poleJ = pole('#p-jednostka');
  const odswiezWlasna = () => {
    const ile = zPola(poleN);
    const wGramach = poleJ.value === 'gramy';
    const udzial = ile > 0 ? (wGramach ? ile / (waga || 1) : ile / porcjeDania) : 0;
    // Przy jednostce „g" gramatura powtarzałaby to, co właśnie wpisałeś.
    pole('#pw-g').textContent = (udzial && !wGramach && waga)
      ? dziesietne(Math.round(waga * udzial * 10) / 10) + ' g' : '';
    pole('#pw-k').textContent = udzial ? zaokr(kcalDania * udzial) + ' kcal' : '—';
  };
  poleN.addEventListener('input', odswiezWlasna);
  poleJ.addEventListener('change', () => {
    // Po przełączeniu na gramy „1" znaczyłoby jeden gram — podstawiamy porcję.
    poleN.value = poleJ.value === 'gramy' ? String(Math.round(waga / porcjeDania)) : '1';
    odswiezWlasna();
  });
  odswiezWlasna();

  pole('#porcje').onclick = (ev) => {
    const b = ev.target.closest('.porcja-w[data-i]');
    if (!b) return;
    zapiszPorcje({ porcje: warianty[b.dataset.i].n }, b);
  };
  pole('#p-wlasna-ok').onclick = (ev) => {
    const ile = zPola(poleN);
    if (!(ile > 0)) { komunikat('Podaj ilość większą od zera.', true); return; }
    zapiszPorcje(poleJ.value === 'gramy' ? { gramy: ile } : { porcje: ile }, ev.currentTarget);
  };

  // Opis porcji („1 porcja", „250 g") układa SERWER — tu wysyłamy samą ilość.
  async function zapiszPorcje(ilosc, przycisk) {
    if (przycisk) przycisk.disabled = true;
    komunikat('');
    try {
      const r = await authFetch('/api/eat/przepisy/' + p.id + '/do-dnia', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ data: dzienISO, posilek: posilekDocelowy }, ilosc)),
      });
      const x = await r.json().catch(() => ({}));
      if (!r.ok) {
        komunikat(x.detail || 'Nie udało się dodać.', true);
        if (przycisk) przycisk.disabled = false;
        return;
      }
      zamknijArkusz();
      await wczytajDzien();
      pasekCofnij(p.nazwa, x.id);
    } catch {
      komunikat('Błąd połączenia.', true);
      if (przycisk) przycisk.disabled = false;
    }
  }
}

// ── ekran produktu (wybór porcji) ───────────────────────────────────────────

// Ekran produktu to teraz tylko nagłówek — resztą zajmuje się wspólny ekran
// potwierdzenia, żeby każda droga dodawania kończyła się tak samo.
function ekranProduktu(p, skad, niepelne) {
  const zrodla = { off: 'Open Food Facts · zapisano u Was', wlasna: 'Wasza baza',
                   etykieta: 'Odczytane z etykiety', baza: 'Produkt podstawowy' };
  // Część produktów siedzi w bazie bez tabeli wartości — typowo woda mineralna.
  // Nie odrzucamy ich (woda ma zero kalorii i to poprawna wartość), ale mówimy
  // wprost, że liczby trzeba sprawdzić.
  const ostrzezenie = niepelne
    ? '<div class="komunikat blad">Baza nie ma dla tego produktu wartości odżywczych. '
      + 'Przy wodzie zero kalorii jest poprawne — przy czymkolwiek innym wpisz je poniżej '
      + 'albo wróć i zrób zdjęcie etykiety.</div>'
    : '';
  const naglowek = `
    <div class="prod-gora">
      <div class="marka">${e(p.marka || '')}</div>
      <h3>${e(p.nazwa)}</h3>
      <div class="op">${podpisWielkosci(p)}${zaokr(p.kcal)} kcal / 100 g</div>
      <div class="zrodlo">${e(zrodla[skad] || 'Wasza baza')}</div>
    </div>${ostrzezenie}`;
  // Domyślnie 100 g. Wcześniej domyślną porcją było CAŁE opakowanie —
  // zeskanowanie kilograma ryżu i szybkie „Dodaj" zapisywało 3500 kcal.
  // Całe opakowanie ma sens tylko przy małych (jogurt, batonik).
  const opak = Number(p.opak_g) || 0;
  const sztuk = Number(p.sztuk_w_opak) || 0;
  const porcjaG = Number(p.porcja_g) || 0;
  // Gdy wiadomo, ile sztuk jest w opakowaniu, domyślną porcją jest JEDNA —
  // przy pudełku pralinek nikt nie zjada całego naraz. Przy surowcu bez
  // opakowania (pomidor, marchewka) domyślna to jedna sztuka. W przeciwnym
  // razie 100 g; całe opakowanie tylko przy małych, bo zeskanowanie kilograma
  // ryżu i szybkie „Dodaj" zapisywało 3500 kcal.
  const domyslna = (opak && sztuk > 1) ? Math.round(opak / sztuk * 10) / 10
    : porcjaG ? porcjaG
    : (opak && opak <= 250) ? opak : 100;
  ekranPotwierdzenia(
    { nazwa: p.nazwa, ilosc_g: domyslna, opis_porcji: p.opis_porcji || null,
      kcal: 0, bialko: 0, tluszcz: 0, wegle: 0,
      // tylko dla ekranu porcji: marka trafia pod nazwę w pasku tytułu,
      // a serce musi znać stan przypięcia od pierwszego renderu
      marka: p.marka || null, ulubiony: !!p.ulubiony },
    { kcal: Number(p.kcal) || 0, bialko: Number(p.bialko) || 0,
      tluszcz: Number(p.tluszcz) || 0, wegle: Number(p.wegle) || 0,
      opak_g: opak, sztuk: sztuk, produkt_id: p.id,
      porcja_g: porcjaG, opis_porcji: p.opis_porcji || null },
    p.id,
    naglowek,
    undefined,
    // Produkt bez tabeli wartości musi zostać na starym ekranie — ostrzeżenie
    // wyżej wprost każe wpisać liczby, więc pola nie mogą zniknąć.
    !niepelne,
  );
}

// ── ekran pozycji z opisu ───────────────────────────────────────────────────

// Lista pozycji z opisu — kazda z wlasna gramatura do poprawienia. Wartosci
// skaluja sie proporcjonalnie, bo Claude podal je dla oszacowanej ilosci.
function ekranPozycji(pozycje, opis) {
  const ark = arkusz && arkusz.querySelector('.ark');
  if (!ark) return;
  ark.innerHTML = `
    <div class="ark-gl"><button class="x" id="wroc" type="button" style="margin:0" aria-label="Wróć">‹</button>
      <h2 style="font-size:1rem">Sprawdź i popraw</h2>
      <button class="x" id="zamknij2" type="button" aria-label="Zamknij">&times;</button></div>
    <div class="komunikat">Z opisu „${e(opis)}". Odznacz, czego nie jadłeś, popraw gramatury.</div>
    <div id="lista-poz">
      ${pozycje.map((p, i) => `
        <div class="poz-edyt" data-i="${i}">
          <input type="checkbox" data-zazn="${i}" checked>
          <div style="flex:1;min-width:0">
            <div class="pe-nazwa">${e(p.nazwa)}</div>
            <div class="pe-linia">
              <input type="text" data-gram="${i}" value="${dziesietne(p.ilosc_g)}"
                     inputmode="decimal" autocomplete="off"> g
              <span class="pe-kcal" data-kcal="${i}">${zaokr(p.kcal)} kcal</span>
            </div>
          </div>
        </div>`).join('')}
    </div>
    <div class="sek-tyt" style="margin-top:12px">Razem</div>
    <div class="wynik" id="poz-suma"></div>
    <div class="sek-tyt">Do którego posiłku</div>
    <div class="gdzie" id="gdzie">
      ${POSILKI.map(([k, n]) => `<button data-p="${k}" aria-pressed="${k === posilekDocelowy}" type="button">${n}</button>`).join('')}
    </div>
    <div id="ark-komunikat"></div>
    <button class="cta" id="dodaj-wsz" type="button">Dodaj do dnia</button>`;

  const bazowe = pozycje.map((p) => ({
    g: Number(p.ilosc_g) || 100, kcal: Number(p.kcal) || 0, bialko: Number(p.bialko) || 0,
    tluszcz: Number(p.tluszcz) || 0, wegle: Number(p.wegle) || 0,
  }));

  function biezaca(i) {
    const g = zPola(ark.querySelector(`[data-gram="${i}"]`));
    const b = bazowe[i];
    const m = b.g > 0 ? g / b.g : 0;
    return { g, kcal: b.kcal * m, bialko: b.bialko * m, tluszcz: b.tluszcz * m, wegle: b.wegle * m };
  }

  function przelicz() {
    const suma = { kcal: 0, bialko: 0, tluszcz: 0, wegle: 0 };
    pozycje.forEach((_, i) => {
      const v = biezaca(i);
      ark.querySelector(`[data-kcal="${i}"]`).textContent = zaokr(v.kcal) + ' kcal';
      if (ark.querySelector(`[data-zazn="${i}"]`).checked) {
        suma.kcal += v.kcal; suma.bialko += v.bialko; suma.tluszcz += v.tluszcz; suma.wegle += v.wegle;
      }
    });
    ark.querySelector('#poz-suma').innerHTML = `
      <div class="wynik-kc">${zaokr(suma.kcal)} kcal</div>
      <div class="wynik-mk"><span>B <b>${dziesietne(suma.bialko)} g</b></span>
        <span>T <b>${dziesietne(suma.tluszcz)} g</b></span>
        <span>W <b>${dziesietne(suma.wegle)} g</b></span></div>`;
  }
  przelicz();

  ark.querySelectorAll('[data-gram], [data-zazn]').forEach((el) => {
    el.addEventListener('input', przelicz);
    el.addEventListener('change', przelicz);
  });

  ark.querySelector('#gdzie').onclick = (ev) => {
    const b = ev.target.closest('[data-p]');
    if (!b) return;
    ark.querySelectorAll('#gdzie [data-p]').forEach((x) => x.setAttribute('aria-pressed', 'false'));
    b.setAttribute('aria-pressed', 'true');
    posilekDocelowy = b.dataset.p;
  };
  ark.querySelector('#wroc').onclick = () => { wrocDoArkusza(); };
  ark.querySelector('#zamknij2').onclick = zamknijArkusz;

  ark.querySelector('#dodaj-wsz').onclick = async (ev) => {
    ev.target.disabled = true;
    const wybrane = pozycje
      .map((p, i) => ({ p, i }))
      .filter(({ i }) => ark.querySelector(`[data-zazn="${i}"]`).checked);
    if (!wybrane.length) { zamknijArkusz(); return; }
    komunikat('Zapisuję…');
    // Jedno wywołanie zamiast pętli po pozycjach. Wcześniej każdy składnik szedł
    // osobnym żądaniem i przerwanie w połowie zostawiało pół posiłku w dzienniku.
    // Serwer nadaje wspólny identyfikator grupy, dzięki czemu „kanapka z serem"
    // pokazuje się jako jedno danie, choć składniki są osobnymi wpisami.
    const nazwaGrupy = (opis || '').trim().slice(0, 120);
    try {
      const r = await authFetch('/api/eat/wpisy/grupa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          data: dzienISO, posilek: posilekDocelowy, nazwa_grupy: nazwaGrupy,
          pozycje: wybrane.map(({ p, i }) => {
            const v = biezaca(i);
            return { nazwa: p.nazwa, opis_porcji: p.opis_porcji, ilosc_g: v.g,
                     kcal: v.kcal, bialko: v.bialko, tluszcz: v.tluszcz, wegle: v.wegle };
          }),
        }),
      });
      if (!r.ok) {
        const x = await r.json().catch(() => ({}));
        komunikat(x.detail || 'Nie udało się zapisać.', true);
        ev.target.disabled = false;
        return;
      }
    } catch {
      komunikat('Błąd połączenia.', true);
      ev.target.disabled = false;
      return;
    }
    zamknijArkusz();
    await wczytajDzien();
  };
}

// ── cel dzienny ─────────────────────────────────────────────────────────────

// Kaloryczność makroskładników — to z niej bierze się cała arytmetyka celu.
const KCAL_NA_G = { bialko: 4, tluszcz: 9, wegle: 4 };

// Gotowe rozkłady w procentach: białko / tłuszcz / węglowodany.
const ROZKLADY = [
  ['Zbilansowany', 25, 30, 45],
  ['Wysokobiałkowy', 35, 30, 35],
  ['Mniej węglowodanów', 30, 45, 25],
];

function oknoCeli() {
  const c = (stanDnia && stanDnia.cele) || {};
  let tryb = 'procenty';

  const o = document.createElement('div');
  o.className = 'ark-tlo';
  o.innerHTML = `
    <div class="ark" style="max-width:430px">
      <div class="ark-gl"><h2 style="font-size:1.05rem">Cel dzienny</h2>
        <button class="x" id="c-x" type="button" aria-label="Zamknij">&times;</button></div>
      <div class="komunikat">Od celu zależy skala pasków na dole. Cel jest Twój — Ola ma własny.</div>

      <div class="sek-tyt">Kalorie na dzień</div>
      <input id="c-kcal" type="number" min="800" max="6000" value="${zaokr(c.kcal)}" style="width:100%;margin-bottom:14px">

      <div class="sek-tyt">Rozkład makroskładników</div>
      <div class="gdzie" id="c-tryb" style="margin-bottom:10px">
        <button data-tryb="procenty" aria-pressed="true" type="button">Procentami</button>
        <button data-tryb="gramy" aria-pressed="false" type="button">Gramami</button>
      </div>

      <div id="c-wiersze"></div>
      <div id="c-status" class="komunikat"></div>

      <div class="sek-tyt">Gotowe rozkłady</div>
      <div class="porcje" id="c-rozklady">
        ${ROZKLADY.map((r, i) => `<button class="porcja" data-rozklad="${i}" type="button">${r[0]}</button>`).join('')}
      </div>

      <div id="c-blad" class="komunikat blad"></div>
      <button class="cta" id="c-zapisz" type="button" style="margin-top:8px">Zapisz</button>
    </div>`;
  document.body.appendChild(o);
  o.addEventListener('click', (ev) => { if (ev.target === o) o.remove(); });
  o.querySelector('#c-x').onclick = () => o.remove();

  // Stan trzymamy w GRAMACH — to one idą do bazy. Procenty są tylko sposobem
  // wpisywania, przeliczanym w obie strony.
  const gramy = {
    bialko: Number(c.bialko) || 0,
    tluszcz: Number(c.tluszcz) || 0,
    wegle: Number(c.wegle) || 0,
  };
  const kcalCelu = () => Number(o.querySelector('#c-kcal').value) || 0;
  const zMakro = () => Object.keys(KCAL_NA_G).reduce((s, k) => s + gramy[k] * KCAL_NA_G[k], 0);

  const OPISY = [['bialko', 'Białko'], ['tluszcz', 'Tłuszcz'], ['wegle', 'Węglowodany']];

  function rysuj() {
    const cel = kcalCelu();
    o.querySelector('#c-wiersze').innerHTML = OPISY.map(([k, nazwa]) => {
      const pct = cel > 0 ? (gramy[k] * KCAL_NA_G[k] / cel) * 100 : 0;
      const wartosc = tryb === 'procenty' ? Math.round(pct) : Math.round(gramy[k]);
      const obok = tryb === 'procenty'
        ? `${Math.round(gramy[k])} g`
        : `${Math.round(pct)}%`;
      return `<div class="cel-row">
        <label for="c-${k}">${nazwa}</label>
        <input id="c-${k}" data-makro="${k}" type="number" min="0" max="900" value="${wartosc}">
        <span class="cel-jedn">${tryb === 'procenty' ? '%' : 'g'}</span>
        <span class="cel-obok">${obok}</span>
      </div>`;
    }).join('');

    o.querySelectorAll('[data-makro]').forEach((i) => {
      i.addEventListener('input', () => {
        const k = i.dataset.makro;
        const v = Number(i.value) || 0;
        const cel2 = kcalCelu();
        gramy[k] = tryb === 'procenty' ? (cel2 * (v / 100)) / KCAL_NA_G[k] : v;
        odswiezStatus();
        // przeliczoną wartość obok pokazujemy od razu, bez przerysowania pola
        const wiersz = i.closest('.cel-row').querySelector('.cel-obok');
        const pct = cel2 > 0 ? (gramy[k] * KCAL_NA_G[k] / cel2) * 100 : 0;
        wiersz.textContent = tryb === 'procenty' ? Math.round(gramy[k]) + ' g' : Math.round(pct) + '%';
      });
    });
    odswiezStatus();
  }

  function odswiezStatus() {
    const cel = kcalCelu();
    const z = zMakro();
    const box = o.querySelector('#c-status');
    if (!cel) { box.textContent = ''; return; }
    const roznica = Math.round(z - cel);
    const proc = Math.abs(roznica) / cel;
    if (proc <= 0.02) {
      box.className = 'komunikat';
      box.innerHTML = `Makroskładniki dają <b>${Math.round(z)} kcal</b> — zgadza się z celem.`;
    } else {
      box.className = 'komunikat blad';
      box.innerHTML = `Makroskładniki dają <b>${Math.round(z)} kcal</b>, czyli
        ${roznica > 0 ? 'o ' + roznica + ' za dużo' : 'o ' + (-roznica) + ' za mało'}.
        <button type="button" id="c-wyrownaj" class="mini-btn">Wyrównaj</button>`;
      const b = box.querySelector('#c-wyrownaj');
      if (b) b.onclick = () => {
        // skalujemy wszystkie trzy proporcjonalnie, żeby zachować rozkład
        const wsp = z > 0 ? cel / z : 0;
        Object.keys(gramy).forEach((k) => { gramy[k] = gramy[k] * wsp; });
        rysuj();
      };
    }
  }

  o.querySelector('#c-kcal').addEventListener('input', () => {
    // Skasowanie zawartości pola (normalny sposób wpisania nowej liczby) dawało
    // współczynnik zero i trwale zerowało wszystkie trzy makroskładniki.
    if (!kcalCelu()) return;
    // przy zmianie kalorii trzymamy ROZKŁAD, nie gramy — inaczej podniesienie
    // celu o 200 kcal cicho psułoby proporcje
    const z = zMakro();
    if (z > 0) {
      const wsp = kcalCelu() / z;
      Object.keys(gramy).forEach((k) => { gramy[k] = gramy[k] * wsp; });
    }
    rysuj();
  });

  o.querySelector('#c-tryb').onclick = (ev) => {
    const b = ev.target.closest('[data-tryb]');
    if (!b) return;
    o.querySelectorAll('#c-tryb [data-tryb]').forEach((x) => x.setAttribute('aria-pressed', 'false'));
    b.setAttribute('aria-pressed', 'true');
    tryb = b.dataset.tryb;
    rysuj();
  };

  o.querySelector('#c-rozklady').onclick = (ev) => {
    const b = ev.target.closest('[data-rozklad]');
    if (!b) return;
    const [, pb, pt, pw] = ROZKLADY[b.dataset.rozklad];
    const cel = kcalCelu();
    gramy.bialko = (cel * pb / 100) / 4;
    gramy.tluszcz = (cel * pt / 100) / 9;
    gramy.wegle = (cel * pw / 100) / 4;
    rysuj();
  };

  rysuj();

  o.querySelector('#c-zapisz').onclick = async () => {
    const cialo = {
      kcal: kcalCelu(),
      bialko: Math.round(gramy.bialko),
      tluszcz: Math.round(gramy.tluszcz),
      wegle: Math.round(gramy.wegle),
    };
    try {
      const r = await authFetch('/api/eat/cele', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cialo),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { o.querySelector('#c-blad').textContent = d.detail || 'Nie udało się zapisać.'; return; }
      o.remove();
      await wczytajDzien();
    } catch { o.querySelector('#c-blad').textContent = 'Błąd połączenia.'; }
  };
}

// ── start ───────────────────────────────────────────────────────────────────

function przesunDzien(o) {
  const d = new Date(dzienISO + 'T12:00:00');
  d.setDate(d.getDate() + o);
  dzienISO = d.toLocaleDateString('sv-SE');
  wczytajDzien();
}

authRequireHousehold().then(() => {
  document.getElementById('poprz').onclick = () => przesunDzien(-1);
  document.getElementById('nast').onclick = () => przesunDzien(1);
  document.getElementById('btn-cele').onclick = oknoCeli;
  wczytajDzien();
});
