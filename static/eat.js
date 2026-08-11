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

function wiersz(w, wSrodku) {
  // Treść wiersza to prawdziwy <button>, a nie div z role="button": krzyżyk
  // obok jest osobnym przyciskiem, a przycisk w przycisku to nieprawidłowy
  // HTML i klawiatura gubi się w nim. Kliknięcie w treść otwiera edycję —
  // najczęstsza poprawka to gramatura („dodałem 100 g, a zjadłem 180").
  return `<div class="poz${wSrodku ? ' poz-skl' : ''}">
    <button class="poz-tresc" data-edytuj="${w.id}" type="button" title="Stuknij, żeby poprawić">
      <span class="nz">${e(w.nazwa)}</span>
      <span class="il">${e(w.opis_porcji || dziesietne(w.ilosc_g) + ' g')}</span>
      <span class="kc">${zaokr(w.kcal)}</span>
    </button>
    <button class="x" data-usun="${w.id}" title="Usuń">&times;</button>
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
              type="button" style="margin:4px 0 2px 12px">Zapisz jako przepis</button>
    </div>
  </div>`;
}

// Które grupy są rozwinięte — poza DOM-em, żeby przerysowanie dnia po edycji
// nie zwijało wszystkiego z powrotem.
const grupyOtwarte = new Set();

function rysujPosilki() {
  const box = document.getElementById('posilki');
  box.innerHTML = POSILKI.map(([klucz, nazwa]) => {
    const wpisy = (stanDnia.posilki && stanDnia.posilki[klucz]) || [];
    const suma = wpisy.reduce((s, w) => s + Number(w.kcal || 0), 0);
    // Treść wiersza to prawdziwy <button>, a nie div z role="button": krzyżyk
    // obok jest osobnym przyciskiem, a przycisk w przycisku to nieprawidłowy
    // HTML i klawiatura gubi się w nim. Kliknięcie w treść otwiera edycję —
    // najczęstsza poprawka to gramatura („dodałem 100 g, a zjadłem 180"),
    // więc nie chowamy jej pod dodatkową ikonką.
    const wiersze = pogrupuj(wpisy).map((el) => (el.grupa ? kartaGrupy(el) : wiersz(el.wpis))).join('');
    return `<div class="posilek">
      <div class="pgl"><b>${nazwa}</b><span class="sum">${suma ? zaokr(suma) + ' kcal' : '—'}</span></div>
      ${wiersze}
      <button class="dodaj-mini" data-dodaj="${klucz}" type="button">+ Dodaj</button>
    </div>`;
  }).join('');

  box.querySelectorAll('[data-dodaj]').forEach((b) => {
    b.onclick = () => otworzArkusz(b.dataset.dodaj);
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
    b.onclick = () => zapiszJakoPrzepis(b.dataset.przepis, b.dataset.nazwa);
  });
}

// „Zapisz jako przepis" z tego, co już zjedzone. Najtańsza droga do przepisu:
// gramatury i wartości są sprawdzone, więc nie ma tu ani zgadywania, ani AI.
// Pytamy tylko o to, czego z dziennika nie da się wywnioskować — na ile porcji
// danie wychodziło, skoro zjadłeś jedną.
function zapiszJakoPrzepis(grupaId, nazwa) {
  if (arkusz) return;
  arkusz = document.createElement('div');
  arkusz.className = 'ark-tlo';
  arkusz.innerHTML = `<div class="ark">
    <div class="ark-gl">
      <h2 style="font-size:1rem">Zapisz jako przepis</h2>
      <button class="x" id="zamknij3" type="button" aria-label="Zamknij">&times;</button>
    </div>
    <div class="sek-tyt">Nazwa dania</div>
    <input type="text" id="pp-nazwa" maxlength="120" value="${e(nazwa)}" style="width:100%">
    <div class="sek-tyt">Na ile porcji wychodziło całe danie</div>
    <input type="text" id="pp-porcje" value="1" inputmode="decimal" autocomplete="off" style="width:100%">
    <div class="komunikat">Jeśli to, co zjadłeś, było całym daniem — zostaw 1.
      Jeśli ugotowałeś na cztery osoby, a zjadłeś jedną porcję, wpisz 4:
      składniki zostaną wtedy przeliczone na cały garnek.</div>
    <div id="ark-komunikat"></div>
    <button class="cta" id="pp-zapisz" type="button">Zapisz przepis</button>
  </div>`;
  document.body.appendChild(arkusz);
  try { history.pushState({ ark: 1 }, ''); } catch {}
  arkusz.addEventListener('click', (ev) => { if (ev.target === arkusz) zamknijArkusz(); });
  arkusz.querySelector('#zamknij3').onclick = () => zamknijArkusz();

  arkusz.querySelector('#pp-zapisz').onclick = async (ev) => {
    const nazwaP = arkusz.querySelector('#pp-nazwa').value.trim();
    const porcje = zPola(arkusz.querySelector('#pp-porcje'));
    if (!nazwaP) { komunikat('Podaj nazwę dania.', true); return; }
    if (!porcje || porcje <= 0) { komunikat('Podaj liczbę porcji.', true); return; }
    ev.target.disabled = true;
    try {
      const r = await authFetch('/api/eat/przepisy/z-grupy/' + grupaId, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nazwa: nazwaP, porcje }),
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
  if (arkusz) {
    arkusz.remove();
    arkusz = null;
    if (!zHistorii && history.state && history.state.ark) {
      try { history.back(); } catch {}
    }
  }
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
        <button class="droga" id="d-etykieta" type="button">
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="6" width="17" height="13" rx="2.5"/><circle cx="12" cy="12.5" r="3.4"/><path d="M8.5 6l1.4-2.2h4.2L15.5 6"/></svg>
          <span class="t">Zdjęcie etykiety</span><span class="o">Gdy kodu nie ma albo produkt nieznany</span>
        </button>
        <button class="droga" id="d-opis" type="button">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 6.5h15M4.5 12h15M4.5 17.5h9"/></svg>
          <span class="t">Opisz słowami</span><span class="o">Domowy obiad bez kodu</span>
        </button>
      </div>

      <div class="sek-tyt">Ostatnio jadłeś</div>
      <div id="ark-ostatnie"><div class="komunikat">Wczytuję…</div></div>
      <input type="file" id="ark-plik" accept="image/*" capture="environment" style="display:none">
    </div>`;
  document.body.appendChild(arkusz);
  // W trybie aplikacji „wstecz" jest podstawowym gestem zamykania. Bez wpisu w
  // historii wychodziło z modułu i kasowało wypełniony formularz.
  try { history.pushState({ ark: 1 }, ''); } catch {}
  arkusz.addEventListener('click', (ev) => { if (ev.target === arkusz) zamknijArkusz(); });
  arkusz.querySelector('#ark-x').onclick = zamknijArkusz;
  arkusz.querySelector('#d-skan').onclick = uruchomSkaner;
  arkusz.querySelector('#d-etykieta').onclick = () => arkusz.querySelector('#ark-plik').click();
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

// Powtórka z „ostatnio jadłeś" też idzie przez ekran potwierdzenia — nic nie
// wpada do dziennika, zanim zobaczysz i ewentualnie poprawisz wartości.
function dodajGotowy(p) {
  ekranPotwierdzenia({
    nazwa: p.nazwa,
    opis_porcji: p.opis_porcji,
    ilosc_g: Number(p.ilosc_g) || 100,
    kcal: Number(p.kcal) || 0,
    bialko: Number(p.bialko) || 0,
    tluszcz: Number(p.tluszcz) || 0,
    wegle: Number(p.wegle) || 0,
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

  rysujWyniki(fraza, d.wlasne || [], d.podstawowe || [], [], false, true);
  dociagnijZOpakowan(fraza, mojeZadanie, d.wlasne || [], d.podstawowe || []);
}

// Produkty z opakowań dociągamy OSOBNYM żądaniem. Wcześniej cała odpowiedź
// czekała na Open Food Facts — do kilkudziesięciu sekund — mimo że wyniki
// lokalne były gotowe od razu.
async function dociagnijZOpakowan(fraza, mojeZadanie, wlasne, podstawowe) {
  let d;
  try {
    d = await (await authFetch('/api/eat/szukaj/off?fraza=' + encodeURIComponent(fraza))).json();
  } catch { return; }
  if (mojeZadanie !== licznikSzukania || !arkusz) return;
  rysujWyniki(fraza, wlasne, podstawowe, d.propozycje || [], d.off_padlo, false);
}

function rysujWyniki(fraza, wlasne, podstawowe, propozycje, offPadlo, jeszczeSzuka) {
  const uwagaOff = offPadlo
    ? '<div class="komunikat blad">Baza produktów markowych nie odpowiada (bywa przeciążona). '
      + 'Spróbuj za chwilę albo zeskanuj kod kreskowy.</div>'
    : '';

  if (!wlasne.length && !podstawowe.length && !propozycje.length) {
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

  pokazWyniki(uwagaOff
    + (wlasne.length ? '<div class="sek-tyt">Wasza baza</div>' + wlasne.map((p) => wiersz(p, 'wlasna')).join('') : '')
    + (podstawowe.length ? '<div class="sek-tyt">Produkty podstawowe</div>' + podstawowe.map((p) => wiersz(p, 'baza')).join('') : '')
    + (propozycje.length ? '<div class="sek-tyt">Produkty z opakowań</div>' + propozycje.map((p) => wiersz(p, 'off')).join('') : '')
    + (jeszczeSzuka ? '<div class="komunikat">Szukam też wśród produktów z opakowań…</div>' : '')
  );

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
  komunikat('Odczytuję etykietę…');
  const fd = new FormData();
  fd.append('file', plik);
  try {
    const url = '/api/eat/etykieta' + (ostatniKod ? '?kod=' + encodeURIComponent(ostatniKod) : '');
    const r = await authFetch(url, { method: 'POST', body: fd });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { komunikat(d.detail || 'Nie udało się odczytać.', true); return; }
    ostatniKod = '';
    komunikat('');
    ekranProduktu(d.produkt, 'etykieta');
  } catch { komunikat('Błąd połączenia.', true); }
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
  if (!Rozpoznawanie) { komunikat('Ta przeglądarka nie obsługuje dyktowania. Wpisz z klawiatury.', true); return; }
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
  r.onerror = () => komunikat('Nie usłyszałem. Spróbuj jeszcze raz.', true);
  r.onend = () => { sluchacz = null; btn.classList.remove('slucha'); };
  r.start();
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
function ekranPotwierdzenia(poz, na100, produktId, naglowekDodatkowy, edycja) {
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
  if (wroc) wroc.onclick = () => { zamknijArkusz(); otworzArkusz(posilekDocelowy); };
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
      <div class="op">${p.opak_g ? 'opakowanie ' + zaokr(p.opak_g) + ' g · ' : ''}${zaokr(p.kcal)} kcal / 100 g</div>
      <div class="zrodlo">${e(zrodla[skad] || 'Wasza baza')}</div>
    </div>${ostrzezenie}`;
  // Domyślnie 100 g. Wcześniej domyślną porcją było CAŁE opakowanie —
  // zeskanowanie kilograma ryżu i szybkie „Dodaj" zapisywało 3500 kcal.
  // Całe opakowanie ma sens tylko przy małych (jogurt, batonik).
  const opak = Number(p.opak_g) || 0;
  const domyslna = (opak && opak <= 250) ? opak : 100;
  ekranPotwierdzenia(
    { nazwa: p.nazwa, ilosc_g: domyslna, opis_porcji: p.opis_porcji || null,
      kcal: 0, bialko: 0, tluszcz: 0, wegle: 0 },
    { kcal: Number(p.kcal) || 0, bialko: Number(p.bialko) || 0,
      tluszcz: Number(p.tluszcz) || 0, wegle: Number(p.wegle) || 0,
      opak_g: Number(p.opak_g) || 0 },
    p.id,
    naglowek,
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
  ark.querySelector('#wroc').onclick = () => { zamknijArkusz(); otworzArkusz(posilekDocelowy); };
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
