// wiem.eat — przepisy.
//
// Przepis to NIE produkt. Produkt ma wartości na 100 g; przepis ma sumę całego
// dania i liczbę porcji, na jaką wychodzi. Kalorie się nie gotują — woda nie
// dodaje energii, zmienia się tylko masa — więc „suma składników ÷ porcje"
// jest dokładne i nie wymaga ważenia czegokolwiek po ugotowaniu.

const POSILKI = [
  ['sniadanie', 'Śniadanie'],
  ['obiad', 'Obiad'],
  ['kolacja', 'Kolacja'],
  ['przekaska', 'Przekąski'],
];

let przepisy = [];
let arkusz = null;
let licznikSzukania = 0;

function e(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
const zaokr = (v) => Math.round(Number(v) || 0);
// Makro do dziesiątej części grama — tyle trzyma baza. Końcówka „,0" to szum.
const dziesietne = (v) => {
  const x = Math.round((Number(v) || 0) * 10) / 10;
  return Number.isInteger(x) ? String(x) : x.toFixed(1);
};
// Pola z ułamkami są type="text": w polu liczbowym wpisanie „1,5" na polskiej
// klawiaturze daje PUSTĄ wartość, a Number('') to zero.
const zPola = (el) => {
  if (!el) return 0;
  const x = parseFloat(String(el.value).replace(',', '.'));
  return Number.isFinite(x) ? x : 0;
};
const ladna = (v) => String(Math.round(Number(v) * 100) / 100).replace('.', ',');

// ── lista ───────────────────────────────────────────────────────────────────

async function wczytajListe(fraza) {
  const box = document.getElementById('lista');
  const moje = ++licznikSzukania;
  try {
    const r = await authFetch('/api/eat/przepisy?fraza=' + encodeURIComponent(fraza || ''));
    // Starsza, wolniejsza odpowiedź nie może nadpisać nowszej.
    if (moje !== licznikSzukania) return;
    if (!r.ok) throw new Error('brak');
    przepisy = (await r.json()).przepisy || [];
  } catch {
    box.innerHTML = '<div class="pusto"><b>Nie udało się wczytać</b>'
      + '<button class="cta cta-2" id="ponow" type="button" style="max-width:220px;margin:12px auto 0">Spróbuj ponownie</button></div>';
    const p = document.getElementById('ponow');
    if (p) p.onclick = () => wczytajListe(document.getElementById('szukaj').value);
    return;
  }
  rysujListe(fraza);
}

function rysujListe(fraza) {
  const box = document.getElementById('lista');
  if (!przepisy.length) {
    box.innerHTML = fraza
      ? '<div class="pusto"><b>Nic nie pasuje</b>Spróbuj innego słowa.</div>'
      : '<div class="pusto"><b>Jeszcze nie ma przepisów</b>'
        + 'Zapisz danie raz, a potem dodasz je do dnia dwoma stuknięciami.</div>';
    return;
  }
  box.innerHTML = przepisy.map((p) => {
    const porcje = Number(p.porcje) || 1;
    const naPorcje = Number(p.kcal || 0) / porcje;
    return `<button class="przepis" data-id="${p.id}" type="button">
      <span class="p-tresc">
        <span class="p-nazwa">${e(p.nazwa)}</span>
        <span class="p-pod">${ladna(porcje)} ${odmianaPorcji(porcje)}${p.uzyc > 0 ? ' · użyte ' + p.uzyc + '×' : ''}</span>
        <span class="p-makro">B ${dziesietne(Number(p.bialko || 0) / porcje)} ·
          T ${dziesietne(Number(p.tluszcz || 0) / porcje)} ·
          W ${dziesietne(Number(p.wegle || 0) / porcje)}</span>
      </span>
      <span class="p-kcal"><b>${zaokr(naPorcje)}</b><span>kcal / porcję</span></span>
    </button>`;
  }).join('');
  box.querySelectorAll('[data-id]').forEach((b) => {
    b.onclick = () => otworzPorcje(Number(b.dataset.id));
  });
}

function odmianaPorcji(n) {
  if (n === 1) return 'porcja';
  const setki = n % 100, dzies = n % 10;
  if (dzies >= 2 && dzies <= 4 && !(setki >= 12 && setki <= 14)) return 'porcje';
  return 'porcji';
}

// ── arkusz ──────────────────────────────────────────────────────────────────

function zamknijArkusz(zHistorii) {
  if (!arkusz) return;
  arkusz.remove();
  arkusz = null;
  if (!zHistorii && history.state && history.state.ark) {
    try { history.back(); } catch {}
  }
}
window.addEventListener('popstate', () => { if (arkusz) zamknijArkusz(true); });
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && arkusz) zamknijArkusz();
});

function nowyArkusz() {
  if (arkusz) return null;
  arkusz = document.createElement('div');
  arkusz.className = 'ark-tlo';
  arkusz.innerHTML = '<div class="ark"></div>';
  document.body.appendChild(arkusz);
  // W trybie aplikacji „wstecz" jest podstawowym gestem zamykania.
  try { history.pushState({ ark: 1 }, ''); } catch {}
  arkusz.addEventListener('click', (ev) => { if (ev.target === arkusz) zamknijArkusz(); });
  return arkusz.querySelector('.ark');
}

function komunikat(tekst, blad) {
  const box = arkusz && arkusz.querySelector('#ark-komunikat');
  if (box) box.innerHTML = `<div class="komunikat${blad ? ' blad' : ''}">${e(tekst)}</div>`;
}

// ── ile porcji (dodanie do dnia) ────────────────────────────────────────────

async function otworzPorcje(id) {
  const ark = nowyArkusz();
  if (!ark) return;
  ark.innerHTML = '<div class="laduje">Wczytuję przepis…</div>';
  let p;
  try {
    const r = await authFetch('/api/eat/przepisy/' + id);
    if (!r.ok) throw new Error('brak');
    p = await r.json();
  } catch {
    ark.innerHTML = '<div class="pusto"><b>Nie udało się wczytać przepisu</b></div>';
    return;
  }
  if (!arkusz) return;   // zamknięty, zanim odpowiedź doszła

  const porcjeDania = Number(p.porcje) || 1;
  // Waga odniesienia przychodzi z serwera: albo ręcznie wpisana waga gotowego
  // dania, albo suma składników, gdy nic nie odparowuje. Dzięki temu
  // odmierzanie w gramach działa przy KAŻDYM przepisie, nie tylko gotowanym.
  const waga = Number(p.waga_odniesienia_g) || 0;
  const wagaRecznie = !!Number(p.waga_gotowego_g);
  const naPorcje = Number(p.kcal || 0) / porcjeDania;
  let jednostka = 'porcje';
  let posilekDocelowy = domyslnyPosilek();

  ark.innerHTML = `
    <div class="ark-gl">
      <h2>${e(p.nazwa)}</h2>
      <button class="x" id="zamknij" type="button" aria-label="Zamknij">&times;</button>
    </div>
    <div class="suma" style="margin-top:0">
      <div class="suma-kc">${zaokr(naPorcje)} kcal<span style="font-size:13px;font-weight:400;color:var(--muted)"> / porcję</span></div>
      <div class="suma-mk">
        <span>B <b>${dziesietne(Number(p.bialko || 0) / porcjeDania)} g</b></span>
        <span>T <b>${dziesietne(Number(p.tluszcz || 0) / porcjeDania)} g</b></span>
        <span>W <b>${dziesietne(Number(p.wegle || 0) / porcjeDania)} g</b></span>
      </div>
      <div class="suma-pod">całe danie: ${ladna(porcjeDania)} ${odmianaPorcji(porcjeDania)}${waga ? ' · ' + dziesietne(waga) + ' g' + (wagaRecznie ? ' po ugotowaniu' : '') : ''}</div>
    </div>

    ${waga ? `<div class="jedn-przel" id="jedn">
      <button data-j="porcje" aria-pressed="true" type="button">W porcjach</button>
      <button data-j="gramy" aria-pressed="false" type="button">W gramach</button>
    </div>` : ''}

    <div class="sek-tyt" id="tyt-ile">Ile porcji</div>
    <div class="porcje-szyb" id="szybkie">
      <button data-p="0.5" type="button">½</button>
      <button data-p="1" aria-pressed="true" type="button">1</button>
      <button data-p="1.5" type="button">1½</button>
      <button data-p="2" type="button">2</button>
    </div>
    <input type="text" id="ile" value="1" inputmode="decimal" autocomplete="off">

    <div class="suma" id="wynik"></div>

    <div class="sek-tyt">Do którego posiłku</div>
    <div class="gdzie" id="gdzie">
      ${POSILKI.map(([k, n]) => `<button data-p="${k}" aria-pressed="${k === posilekDocelowy}" type="button">${n}</button>`).join('')}
    </div>
    <div id="ark-komunikat"></div>
    <button class="cta" id="dodaj" type="button">Dodaj do dnia</button>
    <button class="cta cta-2" id="edytuj" type="button" style="margin-top:8px">Edytuj przepis</button>`;

  const pole = (s) => ark.querySelector(s);

  function przelicz() {
    const ile = zPola(pole('#ile'));
    let udzial = 0;
    if (jednostka === 'gramy' && waga > 0) udzial = ile / waga;
    else udzial = ile / porcjeDania;
    pole('#wynik').innerHTML = `
      <div class="suma-kc">${zaokr(Number(p.kcal || 0) * udzial)} kcal</div>
      <div class="suma-mk">
        <span>B <b>${dziesietne(Number(p.bialko || 0) * udzial)} g</b></span>
        <span>T <b>${dziesietne(Number(p.tluszcz || 0) * udzial)} g</b></span>
        <span>W <b>${dziesietne(Number(p.wegle || 0) * udzial)} g</b></span>
      </div>`;
  }
  przelicz();

  pole('#ile').addEventListener('input', () => {
    ark.querySelectorAll('#szybkie button').forEach((x) => x.setAttribute('aria-pressed', 'false'));
    przelicz();
  });
  pole('#szybkie').onclick = (ev) => {
    const b = ev.target.closest('[data-p]');
    if (!b) return;
    ark.querySelectorAll('#szybkie button').forEach((x) => x.setAttribute('aria-pressed', 'false'));
    b.setAttribute('aria-pressed', 'true');
    pole('#ile').value = b.dataset.p.replace('.', ',');
    przelicz();
  };

  const przel = pole('#jedn');
  if (przel) przel.onclick = (ev) => {
    const b = ev.target.closest('[data-j]');
    if (!b) return;
    ark.querySelectorAll('#jedn button').forEach((x) => x.setAttribute('aria-pressed', 'false'));
    b.setAttribute('aria-pressed', 'true');
    jednostka = b.dataset.j;
    // Szybkie przyciski mają sens tylko w porcjach — w gramach wpisuje się wprost.
    pole('#szybkie').style.display = jednostka === 'gramy' ? 'none' : 'flex';
    pole('#tyt-ile').textContent = jednostka === 'gramy' ? 'Ile gramów' : 'Ile porcji';
    pole('#ile').value = jednostka === 'gramy' ? String(Math.round(waga / porcjeDania)) : '1';
    przelicz();
  };

  pole('#gdzie').onclick = (ev) => {
    const b = ev.target.closest('[data-p]');
    if (!b) return;
    ark.querySelectorAll('#gdzie [data-p]').forEach((x) => x.setAttribute('aria-pressed', 'false'));
    b.setAttribute('aria-pressed', 'true');
    posilekDocelowy = b.dataset.p;
  };

  pole('#zamknij').onclick = () => zamknijArkusz();
  pole('#edytuj').onclick = () => { zamknijArkusz(); otworzEdytor(p); };

  pole('#dodaj').onclick = async (ev) => {
    const ile = zPola(pole('#ile'));
    if (!ile || ile <= 0) { komunikat('Podaj ilość.', true); return; }
    ev.target.disabled = true;
    const cialo = { posilek: posilekDocelowy };
    if (jednostka === 'gramy') cialo.gramy = ile; else cialo.porcje = ile;
    try {
      const r = await authFetch('/api/eat/przepisy/' + p.id + '/do-dnia', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cialo),
      });
      if (!r.ok) {
        const x = await r.json().catch(() => ({}));
        komunikat(x.detail || 'Nie udało się dodać.', true);
        ev.target.disabled = false; return;
      }
      zamknijArkusz();
      location.href = '/eat';
    } catch { komunikat('Błąd połączenia.', true); ev.target.disabled = false; }
  };
}

// Podpowiadamy posiłek po porze dnia — o 13:00 najczęściej dodaje się obiad.
function domyslnyPosilek() {
  const g = new Date().getHours();
  if (g < 11) return 'sniadanie';
  if (g < 16) return 'obiad';
  if (g < 21) return 'kolacja';
  return 'przekaska';
}

// ── wybór drogi dodania przepisu ────────────────────────────────────────────

function otworzNowy() {
  const ark = nowyArkusz();
  if (!ark) return;
  ark.innerHTML = `
    <div class="ark-gl">
      <h2>Nowy przepis</h2>
      <button class="x" id="zamknij" type="button" aria-label="Zamknij">&times;</button>
    </div>
    <div class="sek-tyt">Skąd wziąć składniki</div>
    <div class="drogi">
      <button class="droga" data-d="opis" type="button">
        <b>Opisz słowami</b><span>Wklej albo podyktuj przepis — AI rozłoży go na składniki</span></button>
      <button class="droga" data-d="foto" type="button">
        <b>Zdjęcie przepisu</b><span>Z książki albo z ekranu</span></button>
      <button class="droga" data-d="recznie" type="button">
        <b>Wpisz ręcznie</b><span>Składnik po składniku, bez AI</span></button>
      <button class="droga" data-d="dzien" type="button">
        <b>Z dziennika</b><span>Przejdź do dziennika i użyj „Zapisz jako przepis"</span></button>
    </div>
    <input type="file" id="plik" accept="image/*" hidden>
    <div id="ark-komunikat"></div>`;

  ark.querySelector('#zamknij').onclick = () => zamknijArkusz();
  ark.querySelector('.drogi').onclick = (ev) => {
    const b = ev.target.closest('[data-d]');
    if (!b) return;
    if (b.dataset.d === 'opis') ekranOpisu();
    else if (b.dataset.d === 'foto') ark.querySelector('#plik').click();
    else if (b.dataset.d === 'recznie') otworzEdytor(null);
    else {
      // Ta droga NIE buduje przepisu tutaj — dzieje się to w dzienniku, przy
      // konkretnej grupie, bo dopiero tam wiadomo, które wpisy są tym daniem.
      // Wcześniej kafelek po prostu wyrzucał na /eat bez słowa wyjaśnienia
      // i wyglądał na zepsuty; teraz mówi, po co tam idziesz.
      komunikat('Otwieram dziennik — rozwiń danie i stuknij „Zapisz jako przepis".');
      setTimeout(() => { zamknijArkusz(); location.href = '/eat'; }, 1200);
    }
  };
  ark.querySelector('#plik').onchange = async (ev) => {
    const plik = ev.target.files && ev.target.files[0];
    if (!plik) return;
    komunikat('Odczytuję przepis ze zdjęcia…');
    const fd = new FormData();
    fd.append('file', plik);
    try {
      const r = await authFetch('/api/eat/przepisy/ze-zdjecia', { method: 'POST', body: fd });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { komunikat(d.detail || 'Nie udało się odczytać.', true); return; }
      otworzEdytor(zProponowanego(d));
    } catch { komunikat('Błąd połączenia.', true); }
  };
}

function ekranOpisu() {
  const ark = arkusz && arkusz.querySelector('.ark');
  if (!ark) return;
  ark.innerHTML = `
    <div class="ark-gl">
      <h2>Opisz przepis</h2>
      <button class="x" id="zamknij" type="button" aria-label="Zamknij">&times;</button>
    </div>
    <div class="sek-tyt">Składniki i ilości</div>
    <textarea id="opis" placeholder="Spaghetti bolognese na 4 porcje: 500 g makaronu, 400 g mielonej wołowiny, puszka pomidorów, cebula, 2 łyżki oliwy"></textarea>
    <div class="komunikat">Napisz, na ile porcji wychodzi danie — inaczej AI to oszacuje.</div>
    <div id="ark-komunikat"></div>
    <button class="cta" id="rozloz" type="button">Rozłóż na składniki</button>`;
  ark.querySelector('#zamknij').onclick = () => zamknijArkusz();
  ark.querySelector('#opis').focus();
  ark.querySelector('#rozloz').onclick = async (ev) => {
    const opis = ark.querySelector('#opis').value.trim();
    if (opis.length < 10) { komunikat('Opisz przepis dokładniej.', true); return; }
    ev.target.disabled = true;
    komunikat('Rozkładam na składniki…');
    try {
      const r = await authFetch('/api/eat/przepisy/z-opisu', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ opis }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { komunikat(d.detail || 'Nie udało się rozłożyć.', true); ev.target.disabled = false; return; }
      otworzEdytor(zProponowanego(d));
    } catch { komunikat('Błąd połączenia.', true); ev.target.disabled = false; }
  };
}

// Propozycja AI ma ten sam kształt co przepis z bazy, żeby edytor nie musiał
// wiedzieć, skąd pochodzi.
function zProponowanego(d) {
  return {
    id: null, nazwa: d.nazwa || '', porcje: d.porcje || 1, waga_gotowego_g: null,
    skladniki: (d.skladniki || []).map((s) => ({
      nazwa: s.nazwa, ilosc_g: s.ilosc_g, kcal: s.kcal,
      bialko: s.bialko, tluszcz: s.tluszcz, wegle: s.wegle, produkt_id: null,
    })),
  };
}

// ── edytor przepisu ─────────────────────────────────────────────────────────

function otworzEdytor(przepis) {
  const ark = (arkusz && arkusz.querySelector('.ark')) || nowyArkusz();
  if (!ark) return;
  // Kopia do pracy — dopóki nie zapiszesz, nic nie rusza ani listy, ani bazy.
  const stan = {
    id: przepis ? przepis.id : null,
    nazwa: przepis ? przepis.nazwa : '',
    porcje: przepis ? Number(przepis.porcje) || 1 : 1,
    waga: przepis && przepis.waga_gotowego_g ? Number(przepis.waga_gotowego_g) : '',
    // Czy wagę wpisał CZŁOWIEK. Bez tej flagi wystarczyło dodać drugi składnik,
    // żeby wartość policzona automatycznie została wzięta za ręczną i przestała
    // nadążać — patrz komentarz przy odswiezWage.
    wagaRecznie: !!(przepis && przepis.waga_gotowego_g),
    skladniki: przepis ? (przepis.skladniki || []).map((s) => ({
      produkt_id: s.produkt_id || null, nazwa: s.nazwa,
      ilosc_g: Number(s.ilosc_g) || 0, kcal: Number(s.kcal) || 0,
      bialko: Number(s.bialko) || 0, tluszcz: Number(s.tluszcz) || 0,
      wegle: Number(s.wegle) || 0,
    })) : [],
  };

  ark.innerHTML = `
    <div class="ark-gl">
      <h2>${stan.id ? 'Edytuj przepis' : 'Nowy przepis'}</h2>
      <button class="x" id="zamknij" type="button" aria-label="Zamknij">&times;</button>
    </div>
    <div class="sek-tyt">Nazwa dania</div>
    <input type="text" id="nazwa" maxlength="120" value="${e(stan.nazwa)}">

    <div class="sek-tyt">Składniki</div>
    <div id="skladniki"></div>
    <button class="cta cta-2" id="dodaj-skl" type="button" style="margin-top:6px">+ Dodaj składnik</button>

    <div class="suma" id="suma"></div>

    <div class="sek-tyt">Na ile porcji wychodzi</div>
    <input type="text" id="porcje" value="${ladna(stan.porcje)}" inputmode="decimal" autocomplete="off">

    <!-- Jawny wybór zamiast cichego założenia. Wcześniej stało tu samo pole
         wypełnione z góry sumą SUROWYCH składników pod etykietą „ile waży
         gotowe danie" — czyli apka sama z siebie twierdziła, że gulasz po
         dwóch godzinach duszenia waży tyle, ile ważył przed. Pole miało już
         liczbę, więc wyglądało na wypełnione i nikt go nie poprawiał:
         nie poprawia się odpowiedzi, której nie widać jako pytania. -->
    <div class="sek-tyt">Ile waży gotowe danie</div>
    <div class="gdzie" id="waga-tryb">
      <button data-tryb="tyle" type="button"
              aria-pressed="${stan.wagaRecznie ? 'false' : 'true'}">Tyle co składniki</button>
      <button data-tryb="gotowane" type="button"
              aria-pressed="${stan.wagaRecznie ? 'true' : 'false'}">Gotowało się</button>
    </div>
    <input type="text" id="waga" value="${stan.waga ? dziesietne(stan.waga) : ''}"
           inputmode="decimal" autocomplete="off"
           placeholder="waga garnka po ugotowaniu"
           aria-label="Waga gotowego dania w gramach"${stan.wagaRecznie ? '' : ' hidden'}>
    <div class="komunikat" id="waga-info"></div>

    <div id="ark-komunikat"></div>
    <button class="cta" id="zapisz" type="button">${stan.id ? 'Zapisz zmiany' : 'Zapisz przepis'}</button>
    ${stan.id ? '<button class="cta-usun" id="usun" type="button">Usuń przepis</button>' : ''}`;

  const pole = (s) => ark.querySelector(s);

  function rysujSkladniki() {
    const box = pole('#skladniki');
    if (!stan.skladniki.length) {
      box.innerHTML = '<div class="komunikat">Brak składników — dodaj pierwszy.</div>';
    } else {
      box.innerHTML = stan.skladniki.map((s, i) => `
        <div class="skl">
          <span class="skl-n" title="${e(s.nazwa)}">${e(s.nazwa)}</span>
          <input class="skl-g" type="text" data-g="${i}" value="${dziesietne(s.ilosc_g)}"
                 inputmode="decimal" autocomplete="off" aria-label="Gramy: ${e(s.nazwa)}">
          <span class="skl-kc" data-kc="${i}">${zaokr(s.kcal)} kcal</span>
          <button class="x" data-usun="${i}" type="button" aria-label="Usuń ${e(s.nazwa)}">&times;</button>
        </div>`).join('');
      box.querySelectorAll('[data-g]').forEach((inp) => {
        inp.addEventListener('input', () => {
          const i = Number(inp.dataset.g);
          const s = stan.skladniki[i];
          const noweG = zPola(inp);
          // Skalujemy od wartości BAZOWEJ na gram, żeby wielokrotne poprawki
          // nie kumulowały błędu zaokrągleń.
          if (s.ilosc_g > 0 && noweG > 0) {
            const m = noweG / s.ilosc_g;
            s.kcal *= m; s.bialko *= m; s.tluszcz *= m; s.wegle *= m;
            s.ilosc_g = noweG;
          } else if (noweG > 0) {
            s.ilosc_g = noweG;
          }
          const kc = box.querySelector(`[data-kc="${i}"]`);
          if (kc) kc.textContent = zaokr(s.kcal) + ' kcal';
          rysujSume();
        });
      });
      box.querySelectorAll('[data-usun]').forEach((b) => {
        b.onclick = () => {
          stan.skladniki.splice(Number(b.dataset.usun), 1);
          rysujSkladniki(); rysujSume();
        };
      });
    }
  }

  function sumy() {
    return stan.skladniki.reduce((a, s) => ({
      kcal: a.kcal + Number(s.kcal || 0), bialko: a.bialko + Number(s.bialko || 0),
      tluszcz: a.tluszcz + Number(s.tluszcz || 0), wegle: a.wegle + Number(s.wegle || 0),
      gramy: a.gramy + Number(s.ilosc_g || 0),
    }), { kcal: 0, bialko: 0, tluszcz: 0, wegle: 0, gramy: 0 });
  }

  function rysujSume() {
    const s = sumy();
    const porcje = zPola(pole('#porcje')) || 1;
    pole('#suma').innerHTML = `
      <div class="suma-kc">${zaokr(s.kcal / porcje)} kcal<span style="font-size:13px;font-weight:400;color:var(--muted)"> / porcję</span></div>
      <div class="suma-mk">
        <span>B <b>${dziesietne(s.bialko / porcje)} g</b></span>
        <span>T <b>${dziesietne(s.tluszcz / porcje)} g</b></span>
        <span>W <b>${dziesietne(s.wegle / porcje)} g</b></span>
      </div>
      <div class="suma-pod">całe danie: ${zaokr(s.kcal)} kcal · ${dziesietne(s.gramy)} g surowych składników</div>`;
    odswiezWage(s.gramy);
  }

  // Tryb „tyle co składniki" jest domyślny i przy sałatce, kanapce czy koktajlu
  // poprawny — nic tam nie odparowuje. Pole wagi pojawia się dopiero po
  // przełączeniu na „gotowało się" i wchodzi PUSTE, bo tylko wtedy jest
  // pytaniem. Wypełnione sumą surowych składników udawało odpowiedź.
  function odswiezWage(sumaG) {
    const inp = pole('#waga');
    if (!wagaRecznie) inp.value = sumaG ? dziesietne(sumaG) : '';
    const wpisana = zPola(inp);
    const info = pole('#waga-info');
    if (!sumaG) { info.textContent = 'Dodaj składniki, żeby policzyć wagę.'; return; }
    if (!wagaRecznie) {
      info.innerHTML = `Liczymy <b>${dziesietne(sumaG)} g</b> — tyle, ile ważą składniki. `
        + 'Tak jest przy sałatce, kanapce i koktajlu, bo nic nie odparowuje.';
    } else if (!(wpisana > 0)) {
      // Pole celowo puste: to jest PYTANIE, a nie wartość do poprawienia.
      info.innerHTML = 'Zważ garnek po ugotowaniu (bez garnka) i wpisz wynik. '
        + `Surowe składniki ważyły <b>${dziesietne(sumaG)} g</b>.`;
    } else if (wpisana > 0) {
      const ubytek = sumaG - wpisana;
      const proc = Math.round(ubytek / sumaG * 100);
      if (proc > 60) {
        // Ponad 60% ubytku to prawie zawsze waga JEDNEJ PORCJI wpisana zamiast
        // wagi całego garnka. Apka ma to zauważyć, a nie liczyć dalej.
        info.innerHTML = `To ubytek <b>${proc}%</b> — bardzo dużo jak na gotowanie. `
          + 'Sprawdź, czy wpisałeś wagę <b>całego dania</b>, a nie jednej porcji.';
      } else {
        info.innerHTML = ubytek > 0
          ? `Odparowuje ${dziesietne(ubytek)} g (${proc}%). `
            + 'Kalorie zostają te same — ubywa tylko wody.'
          : `Danie waży więcej niż składniki o ${dziesietne(-ubytek)} g — `
            + 'to normalne, gdy coś nasiąka wodą (kasza, makaron, ryż).';
      }
    }
  }

  // NIE `!!stan.waga`: pole bywa wypełnione automatycznie sumą składników, więc
  // sama obecność liczby nic nie mówi o tym, kto ją tam wpisał. Po dodaniu
  // pierwszego składnika pole miało już wartość, ekran składnika zapisywał ją do
  // stanu, a po powrocie wyglądała jak ręczna — waga zamarzała na sumie sprzed
  // dołożenia reszty i apka twierdziła, że brakująca różnica „odparowała".
  let wagaRecznie = !!stan.wagaRecznie;

  rysujSkladniki();
  rysujSume();
  pole('#porcje').addEventListener('input', rysujSume);

  // O tym, czy danie odparowuje, decyduje teraz przełącznik, a nie to, czy
  // ktoś przypadkiem dotknął pola. Samo pole tylko odświeża rachunek.
  pole('#waga-tryb').onclick = (ev) => {
    const b = ev.target.closest('[data-tryb]');
    if (!b) return;
    pole('#waga-tryb').querySelectorAll('[data-tryb]')
      .forEach((x) => x.setAttribute('aria-pressed', 'false'));
    b.setAttribute('aria-pressed', 'true');

    const gotowane = b.dataset.tryb === 'gotowane';
    wagaRecznie = gotowane;
    stan.wagaRecznie = gotowane;   // przetrwa przejście na ekran składnika i z powrotem
    const inp = pole('#waga');
    inp.hidden = !gotowane;
    // Czyścimy pole przy wejściu w tryb gotowania. Zostawiona suma składników
    // wyglądałaby na gotową odpowiedź i cały ten przełącznik nic by nie zmienił.
    if (gotowane) { inp.value = ''; stan.waga = ''; inp.focus(); }
    odswiezWage(sumy().gramy);
  };

  pole('#waga').addEventListener('input', () => odswiezWage(sumy().gramy));

  pole('#zamknij').onclick = () => zamknijArkusz();
  pole('#dodaj-skl').onclick = () => ekranSkladnika((s) => {
    stan.skladniki.push(s);
    otworzEdytorZeStanem(stan);
  }, stan);

  const usun = pole('#usun');
  if (usun) usun.onclick = async (ev) => {
    ev.target.disabled = true;
    try {
      const r = await authFetch('/api/eat/przepisy/' + stan.id, { method: 'DELETE' });
      if (!r.ok) { komunikat('Nie udało się usunąć.', true); ev.target.disabled = false; return; }
      zamknijArkusz();
      await wczytajListe(document.getElementById('szukaj').value);
    } catch { komunikat('Błąd połączenia.', true); ev.target.disabled = false; }
  };

  pole('#zapisz').onclick = async (ev) => {
    const nazwa = pole('#nazwa').value.trim();
    if (!nazwa) { komunikat('Podaj nazwę dania.', true); pole('#nazwa').focus(); return; }
    if (!stan.skladniki.length) { komunikat('Dodaj przynajmniej jeden składnik.', true); return; }
    const porcje = zPola(pole('#porcje'));
    if (!porcje || porcje <= 0) { komunikat('Podaj liczbę porcji.', true); return; }
    ev.target.disabled = true;
    const cialo = {
      nazwa, porcje,
      // Gdy nie nadpisałeś wagi, wysyłamy null i serwer bierze sumę składników
      // NA BIEŻĄCO. Zapisanie wyliczonej liczby zamroziłoby ją i po dołożeniu
      // składnika waga zostałaby stara.
      waga_gotowego_g: wagaRecznie ? (zPola(pole('#waga')) || null) : null,
      skladniki: stan.skladniki,
    };
    try {
      const r = await authFetch(stan.id ? '/api/eat/przepisy/' + stan.id : '/api/eat/przepisy', {
        method: stan.id ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cialo),
      });
      if (!r.ok) {
        const x = await r.json().catch(() => ({}));
        komunikat(x.detail || 'Nie udało się zapisać.', true);
        ev.target.disabled = false; return;
      }
      zamknijArkusz();
      await wczytajListe(document.getElementById('szukaj').value);
    } catch { komunikat('Błąd połączenia.', true); ev.target.disabled = false; }
  };
}

// Przerysowanie edytora po dołożeniu składnika — stan trzymamy poza DOM-em,
// więc nic nie ginie.
function otworzEdytorZeStanem(stan) {
  otworzEdytor({
    id: stan.id, nazwa: (document.getElementById('nazwa') || {}).value || stan.nazwa,
    porcje: stan.porcje, waga_gotowego_g: stan.waga || null, skladniki: stan.skladniki,
  });
}

// ── dokładanie składnika (wyszukiwarka jak w dzienniku) ─────────────────────

function ekranSkladnika(gotowe, stan) {
  const ark = arkusz && arkusz.querySelector('.ark');
  if (!ark) return;
  // Zapamiętujemy, co użytkownik zdążył wpisać, zanim podmienimy ekran.
  stan.nazwa = (ark.querySelector('#nazwa') || {}).value || stan.nazwa;
  stan.porcje = zPola(ark.querySelector('#porcje')) || stan.porcje;
  // Wagę przenosimy TYLKO wtedy, gdy wpisał ją człowiek. Wartość policzona
  // automatycznie ma się przeliczyć po powrocie, razem z nowym składnikiem.
  stan.waga = stan.wagaRecznie ? (zPola(ark.querySelector('#waga')) || '') : '';

  ark.innerHTML = `
    <div class="ark-gl">
      <button class="x" id="wroc" type="button" aria-label="Wróć">‹</button>
      <h2>Dodaj składnik</h2>
      <button class="x" id="zamknij" type="button" aria-label="Zamknij">&times;</button>
    </div>
    <input type="text" id="szukaj-skl" placeholder="Szukaj produktu" autocomplete="off">
    <div id="wyniki" style="margin-top:10px"></div>
    <div class="sek-tyt">Albo weź gotowe</div>
    <!-- Te same kafelki co na ekranie „Nowy przepis" — to jest w tej apce wzorzec
         na „wybierz drogę". Wcześniej stały tu cztery elementy w jednym rzędzie,
         z czego dwa były <button>, a dwa <label>, więc wyglądały jak z dwóch
         różnych stron internetu. -->
    <div class="drogi">
      <button class="droga" id="skl-skan" type="button">
        <b>Skanuj kod</b><span>Najszybsze przy wszystkim z opakowania</span>
      </button>
      <label class="droga" for="skl-plik-tyl" tabindex="0" role="button">
        <b>Zdjęcie tabeli</b><span>Wartości odżywcze z tyłu opakowania</span>
      </label>
      <label class="droga" for="skl-plik-przod" tabindex="0" role="button">
        <b>Zdjęcie przodu</b><span>Odczyta nazwę i poszuka w bazie</span>
      </label>
      <button class="droga" id="skl-przepis" type="button">
        <b>Inne Twoje danie</b><span>Złóż danie z dań, które już masz</span>
      </button>
    </div>
    <div id="skl-przepisy" style="display:none;margin-bottom:8px"></div>
    <div id="skl-skaner" style="display:none;margin-bottom:8px">
      <video id="skl-video" playsinline muted style="width:100%;border-radius:10px"></video>
      <div class="komunikat">Skieruj aparat na kod kreskowy.</div>
    </div>
    <!-- Pola plików: <label for>, a nie .click() ze skryptu — etykieta otwiera
         aparat natywnie i znosi całą klasę błędów, w których stuknięcie nie
         robiło nic i nawet nie zgłaszało błędu. Nie chowamy ich przez
         display:none, bo takie pole bywa traktowane jak nieistniejące. -->
    <input type="file" id="skl-plik-przod" accept="image/*" capture="environment"
           style="position:absolute;left:-9999px;width:1px;height:1px;opacity:0">
    <input type="file" id="skl-plik-tyl" accept="image/*" capture="environment"
           style="position:absolute;left:-9999px;width:1px;height:1px;opacity:0">
    <div class="sek-tyt">Albo wpisz wprost</div>
    <input type="text" id="r-nazwa" placeholder="Nazwa składnika" autocomplete="off">
    <div style="display:flex;gap:8px;margin-top:8px">
      <input type="text" id="r-gram" placeholder="gramy" inputmode="decimal" style="flex:1">
      <input type="text" id="r-kcal" placeholder="kcal" inputmode="decimal" style="flex:1">
    </div>
    <div style="display:flex;gap:8px;margin-top:8px">
      <input type="text" id="r-b" placeholder="białko" inputmode="decimal" style="flex:1">
      <input type="text" id="r-t" placeholder="tłuszcz" inputmode="decimal" style="flex:1">
      <input type="text" id="r-w" placeholder="węgle" inputmode="decimal" style="flex:1">
    </div>
    <div id="ark-komunikat"></div>
    <button class="cta" id="dodaj-r" type="button">Dodaj składnik</button>`;

  // Zatrzymanie kamery ORAZ schowanie podglądu. Sam Skaner.stop() gasi tylko
  // strumień — ramka z obrazem zostawała na ekranie i wisiała nad wszystkim,
  // nawet gdy przechodziłeś na wyszukiwanie albo na inną drogę. Dlatego woła
  // to KAŻDA droga, a nie tylko zamknięcie arkusza.
  const zatrzymaj = () => {
    if (window.Skaner) window.Skaner.stop();
    const podglad = ark.querySelector('#skl-skaner');
    if (podglad) podglad.style.display = 'none';
  };
  ark.querySelector('#zamknij').onclick = () => { zatrzymaj(); zamknijArkusz(); };
  ark.querySelector('#wroc').onclick = () => { zatrzymaj(); otworzEdytorZeStanem(stan); };

  // ── produkt z opakowania → składnik ──
  // Wartości produktów są na 100 g, więc domyślne 100 g czyni przeliczenie
  // tożsamością. Gramaturę poprawia się w edytorze, w wierszu składnika.
  const zProduktu = (p) => {
    zatrzymaj();
    gotowe({
      produkt_id: p.id || null,
      nazwa: [p.nazwa, p.marka].filter(Boolean).join(' · ').slice(0, 120),
      ilosc_g: 100,
      kcal: Number(p.kcal) || 0, bialko: Number(p.bialko) || 0,
      tluszcz: Number(p.tluszcz) || 0, wegle: Number(p.wegle) || 0,
    });
  };

  // ── danie jako składnik innego dania ──
  //
  // Wartości ZAMRAŻAMY w chwili dodania, tak jak resztę historii w tej apce.
  // Gdyby sos liczył się na żywo z przepisu na sos, poprawienie sosu zmieniłoby
  // wstecz każde danie, które go używa — a przy daniu z dania z dania trzeba by
  // jeszcze pilnować zapętleń. Zamrożona liczba nie ma żadnego z tych problemów.
  const zPrzepisu = async (id, nazwa) => {
    komunikat('Wczytuję danie…');
    let p;
    try {
      const r = await authFetch('/api/eat/przepisy/' + id);
      if (!r.ok) throw new Error('brak');
      p = await r.json();
    } catch { komunikat('Nie udało się wczytać dania.', true); return; }

    const porcjeDania = Number(p.porcje) || 1;
    const waga = Number(p.waga_odniesienia_g) || 0;
    komunikat('');

    // Pole w arkuszu, a nie prompt(): systemowe okienko wygląda na telefonie
    // obco, nie da się w nim pokazać podglądu kalorii i zatrzymuje całą stronę.
    const box = ark.querySelector('#skl-przepisy');
    box.innerHTML = `
      <div class="komunikat" style="text-align:left">
        <b>${e(nazwa)}</b> — całe danie to ${ladna(porcjeDania)} ${odmianaPorcji(porcjeDania)}.
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <input type="text" id="pp-ile" value="1" inputmode="decimal" style="flex:1"
               aria-label="Ile porcji">
        <button class="mini-btn" id="pp-dodaj" type="button">Dodaj</button>
        <button class="mini-btn" id="pp-wroc" type="button">Wróć</button>
      </div>
      <div class="komunikat" id="pp-podglad" style="margin-top:6px"></div>`;

    const polePorcji = box.querySelector('#pp-ile');
    const podglad = () => {
      const n = zPola(polePorcji);
      box.querySelector('#pp-podglad').innerHTML = n > 0
        ? `Wniesie <b>${zaokr(Number(p.kcal || 0) * n / porcjeDania)} kcal</b>`
          + (waga ? ` · ${dziesietne(waga * n / porcjeDania)} g` : '')
        : 'Podaj liczbę porcji większą od zera.';
    };
    polePorcji.addEventListener('input', podglad);
    podglad();
    box.querySelector('#pp-wroc').onclick = () => { box.style.display = 'none'; };
    box.querySelector('#pp-dodaj').onclick = () => {
      const porcje = zPola(polePorcji);
      if (!(porcje > 0)) { komunikat('Podaj liczbę porcji większą od zera.', true); return; }
      const udzial = porcje / porcjeDania;
      gotowe({
        produkt_id: null,
        nazwa: `${nazwa} (${ladna(porcje)} ${odmianaPorcji(porcje)})`.slice(0, 120),
        // Gdy danie nie ma znanej wagi, gramatura nie niesie treści — wstawiamy
        // liczbę porcji tylko po to, żeby pole nie było puste (serwer wymaga
        // wartości dodatniej), a kalorie i tak liczą się z pól obok.
        ilosc_g: Math.max(0.1, Math.round((waga ? waga * udzial : porcje) * 10) / 10),
        kcal: Math.round(Number(p.kcal || 0) * udzial * 10) / 10,
        bialko: Math.round(Number(p.bialko || 0) * udzial * 10) / 10,
        tluszcz: Math.round(Number(p.tluszcz || 0) * udzial * 10) / 10,
        wegle: Math.round(Number(p.wegle || 0) * udzial * 10) / 10,
      });
    };
  };

  ark.querySelector('#skl-przepis').onclick = async () => {
    zatrzymaj();                       // kamera nie ma wisieć nad listą dań
    const box = ark.querySelector('#skl-przepisy');
    if (box.style.display === 'block') { box.style.display = 'none'; return; }
    box.style.display = 'block';
    box.innerHTML = '<div class="komunikat">Wczytuję…</div>';
    let lista = [];
    try {
      const r = await authFetch('/api/eat/przepisy');
      lista = (await r.json()).przepisy || [];
    } catch { box.innerHTML = '<div class="komunikat blad">Nie udało się wczytać.</div>'; return; }
    // Danie nie może być składnikiem samego siebie — to jedyne zapętlenie,
    // które da się tu zrobić jednym kliknięciem.
    lista = lista.filter((x) => String(x.id) !== String(stan.id));
    if (!lista.length) {
      box.innerHTML = '<div class="komunikat">Nie masz innych dań do wstawienia.</div>';
      return;
    }
    box.innerHTML = lista.map((x, i) => {
      const naPorcje = Number(x.kcal || 0) / (Number(x.porcje) || 1);
      return `<button class="skl" data-p="${i}" type="button" style="width:100%;cursor:pointer">
        <span class="skl-n">${e(x.nazwa)}</span>
        <span class="skl-kc">${zaokr(naPorcje)} kcal/porcję</span>
      </button>`;
    }).join('');
    box.querySelectorAll('[data-p]').forEach((b) => {
      b.onclick = () => { const x = lista[Number(b.dataset.p)]; zPrzepisu(x.id, x.nazwa); };
    });
  };

  const poKodzie = async (kod) => {
    komunikat('Sprawdzam kod…');
    try {
      const r = await authFetch('/api/eat/produkt?kod=' + encodeURIComponent(kod));
      if (!r.ok) {
        komunikat('Nie znam tego kodu. Zrób zdjęcie tabeli z tyłu opakowania.', true);
        return;
      }
      const d = await r.json();
      komunikat('');
      zProduktu(d.produkt || d);
    } catch { komunikat('Błąd połączenia.', true); }
  };

  ark.querySelector('#skl-skan').onclick = () => {
    if (!window.Skaner) { komunikat('Skaner niedostępny — zrób zdjęcie tabeli.', true); return; }
    window.Skaner.start({
      video: ark.querySelector('#skl-video'),
      wrap: ark.querySelector('#skl-skaner'),
      onPodglad: () => komunikat(''),
      onKod: poKodzie,
      onBlad: (t) => komunikat(t, true),
      onCisza: () => komunikat('Nie widzę kodu. Podejdź bliżej albo zrób zdjęcie tabeli.', false),
    });
  };

  const wyslij = async (plik, adres, tekstCzekania) => {
    zatrzymaj();
    komunikat(tekstCzekania);
    const fd = new FormData();
    fd.append('file', plik);
    const r = await authFetch(adres, { method: 'POST', body: fd });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.detail || 'Nie udało się odczytać zdjęcia.');
    return d;
  };

  // TABELA Z TYŁU zawiera wartości odżywcze, więc od razu daje gotowy produkt.
  ark.querySelector('#skl-plik-tyl').onchange = async (ev) => {
    const plik = ev.target.files && ev.target.files[0];
    if (!plik) return;
    try {
      const d = await wyslij(plik, '/api/eat/etykieta', 'Czytam tabelę wartości odżywczych…');
      komunikat('');
      zProduktu(d.produkt || d);
    } catch (err) { komunikat(err.message || 'Błąd połączenia.', true); }
  };

  // PRZÓD nie ma tabeli — daje nazwę i markę, którymi szukamy w bazach.
  // Wybór zostawiamy człowiekowi: braniem pierwszego trafienia z brzegu łatwo
  // wstawić do przepisu zupełnie inny produkt.
  ark.querySelector('#skl-plik-przod').onchange = async (ev) => {
    const plik = ev.target.files && ev.target.files[0];
    if (!plik) return;
    try {
      const d = await wyslij(plik, '/api/eat/etykieta-przod', 'Czytam przód opakowania…');
      const lista = [].concat(d.wlasne || [], d.propozycje || []).slice(0, 20);
      const nazwaZOdczytu = (d.odczyt && d.odczyt.nazwa) || '';
      if (!lista.length) {
        komunikat(`Odczytałem „${nazwaZOdczytu}", ale nie znalazłem wartości odżywczych. `
          + 'Zrób zdjęcie tabeli z tyłu.', true);
        if (nazwaZOdczytu) ark.querySelector('#r-nazwa').value = nazwaZOdczytu;
        return;
      }
      komunikat(`Odczytano „${nazwaZOdczytu}" — wybierz właściwy produkt.`);
      szukajka.value = nazwaZOdczytu;
      rysujWyniki(lista, false);
    } catch (err) { komunikat(err.message || 'Błąd połączenia.', true); }
  };

  let licznik = 0;
  const szukajka = ark.querySelector('#szukaj-skl');

  const rysujWyniki = (lista, jeszczeSzuka) => {
    const box = ark.querySelector('#wyniki');
    if (!box) return;
    box.innerHTML = lista.length
      ? lista.map((p, i) => `<button class="skl" data-w="${i}" type="button" style="width:100%;cursor:pointer">
          <span class="skl-n">${e(p.nazwa)}${p.marka ? ' · ' + e(p.marka) : ''}</span>
          <span class="skl-kc">${p.kcal ? zaokr(p.kcal) + ' kcal/100 g' : 'brak wartości'}</span>
        </button>`).join('') + (jeszczeSzuka
          ? '<div class="komunikat">Szukam też wśród produktów z opakowań…</div>' : '')
      : `<div class="komunikat">${jeszczeSzuka ? 'Szukam…' : 'Nic nie znaleziono — wpisz wprost poniżej.'}</div>`;
    box.querySelectorAll('[data-w]').forEach((b) => {
      b.onclick = () => zProduktu(lista[Number(b.dataset.w)]);
    });
  };

  szukajka.addEventListener('input', async () => {
    zatrzymaj();                       // zacząłeś pisać — skanowanie przestaje mieć sens
    const fraza = szukajka.value.trim();
    const moje = ++licznik;
    if (fraza.length < 3) { ark.querySelector('#wyniki').innerHTML = ''; return; }
    let lokalne = [];
    try {
      const r = await authFetch('/api/eat/szukaj?fraza=' + encodeURIComponent(fraza));
      if (moje !== licznik || !r.ok) return;
      const d = await r.json();
      lokalne = [].concat(d.wlasne || [], d.podstawowe || []).slice(0, 12);
      rysujWyniki(lokalne, true);
    } catch { return; /* cisza — wpisanie wprost nadal działa */ }
    // Produkty z opakowań OSOBNYM żądaniem: Open Food Facts potrafi odpowiadać
    // kilkadziesiąt sekund albo odbić błędem, a wyniki lokalne są gotowe od razu
    // i nie mają na co czekać. Ta sama zasada co w dzienniku.
    try {
      const r2 = await authFetch('/api/eat/szukaj/off?fraza=' + encodeURIComponent(fraza));
      if (moje !== licznik || !r2.ok) { rysujWyniki(lokalne, false); return; }
      const d2 = await r2.json();
      rysujWyniki(lokalne.concat(d2.propozycje || []).slice(0, 20), false);
    } catch { rysujWyniki(lokalne, false); }
  });

  // Wpisywanie wprost też kończy skanowanie: bez tego kamera chodziła dalej po
  // opuszczeniu ekranu, bo `gotowe()` tylko podmienia zawartość arkusza.
  ark.querySelector('#r-nazwa').addEventListener('focus', zatrzymaj);

  ark.querySelector('#dodaj-r').onclick = () => {
    const nazwa = ark.querySelector('#r-nazwa').value.trim();
    const gram = zPola(ark.querySelector('#r-gram'));
    if (!nazwa) { komunikat('Podaj nazwę składnika.', true); return; }
    if (!gram) { komunikat('Podaj gramaturę.', true); return; }
    zatrzymaj();
    gotowe({
      produkt_id: null, nazwa, ilosc_g: gram,
      kcal: zPola(ark.querySelector('#r-kcal')),
      bialko: zPola(ark.querySelector('#r-b')),
      tluszcz: zPola(ark.querySelector('#r-t')),
      wegle: zPola(ark.querySelector('#r-w')),
    });
  };
}

// ── start ───────────────────────────────────────────────────────────────────

authRequireHousehold().then(() => {
  document.getElementById('btn-nowy').onclick = otworzNowy;
  let ticha = null;
  document.getElementById('szukaj').addEventListener('input', (ev) => {
    clearTimeout(ticha);
    const fraza = ev.target.value;
    ticha = setTimeout(() => wczytajListe(fraza), 200);
  });
  wczytajListe('');
});
