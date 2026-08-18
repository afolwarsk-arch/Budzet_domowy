// „Sprawdź produkt" — skanujesz kod i widzisz ocenę, bez dodawania czegokolwiek
// do dziennika. To odpowiedź na pytanie zadawane przy półce, nie przy talerzu.
//
// Wszystkie oceny są CUDZE i opublikowane. Nie liczymy własnego wskaźnika
// „zdrowe/niezdrowe": jedna liczba złożona z wag dobranych przeze mnie
// wyglądałaby poważnie, a nie dałoby się jej obronić ani sprawdzić.

const NS_KOLOR = { a: '#038141', b: '#85bb2f', c: '#fecb02', d: '#ee8100', e: '#e63e11' };
const NS_OPIS = { a: 'bardzo dobra', b: 'dobra', c: 'średnia', d: 'słaba', e: 'bardzo słaba' };
const NOVA_KOLOR = { 1: '#038141', 2: '#85bb2f', 3: '#ee8100', 4: '#e63e11' };
const NOVA_OPIS = { 1: 'nieprzetworzone', 2: 'składnik kulinarny',
                    3: 'przetworzone', 4: 'wysoko przetworzone' };

// Progi „świateł" z brytyjskiego oznaczenia na froncie opakowania (FSA), na 100 g.
// Publikowane i powszechnie używane — dlatego bierzemy je zamiast wymyślać własne.
// Tłuszczów NASYCONYCH nie mamy w bazie, więc ich nie pokazujemy zamiast zgadywać.
const PROGI = {
  tluszcz: { nazwa: 'Tłuszcz',       niski: 3.0,  wysoki: 17.5, jedn: 'g' },
  cukry:   { nazwa: 'Cukry',         niski: 5.0,  wysoki: 22.5, jedn: 'g' },
  sol:     { nazwa: 'Sól',           niski: 0.3,  wysoki: 1.5,  jedn: 'g' },
};

const zaokr = (v) => Math.round(Number(v) || 0);
const dziesietne = (v) => {
  const n = Number(v) || 0;
  return (Math.round(n * 10) / 10).toString().replace('.', ',');
};
const e = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function komunikat(tekst, blad) {
  const el = document.getElementById('komunikat');
  el.className = 'komunikat' + (blad ? ' blad' : '');
  el.textContent = tekst || '';
}

function swiatlo(wartosc, prog) {
  if (wartosc == null) return null;
  if (wartosc <= prog.niski) return { kolor: '#038141', slowo: 'mało' };
  if (wartosc > prog.wysoki) return { kolor: '#e63e11', slowo: 'dużo' };
  return { kolor: '#fecb02', slowo: 'średnio' };
}

function wierszOdzywczy(klucz, wartosc) {
  const prog = PROGI[klucz];
  const s = swiatlo(wartosc, prog);
  if (!s) return '';
  // Pasek pokazuje położenie wartości względem progu „dużo" — powyżej niego
  // wypełnia się do końca, bo dalsza skala już niczego nie różnicuje.
  const udzial = Math.min(100, (Number(wartosc) / prog.wysoki) * 100);
  return `<div class="odz">
    <span class="odz-pas"><i style="width:${Math.max(6, udzial)}%;background:${s.kolor}"></i></span>
    <span class="odz-n">${prog.nazwa}</span>
    <span class="odz-w">${dziesietne(wartosc)} ${prog.jedn}</span>
    <span class="odz-p">${s.slowo}</span>
  </div>`;
}

function pokazProdukt(p, skad) {
  const box = document.getElementById('wynik');
  const ns = (p.nutriscore || '').toLowerCase();
  const nova = Number(p.nova) || 0;
  const dodatki = p.dodatki;

  const kartaNS = ns
    ? `<div class="ocena" style="border-color:${NS_KOLOR[ns]}">
         <span class="duza" style="color:${NS_KOLOR[ns]}">${ns.toUpperCase()}</span>
         <span class="maly">Nutri-Score<br>${NS_OPIS[ns]} jakość odżywcza</span>
       </div>`
    : `<div class="ocena"><span class="duza" style="color:var(--muted)">—</span>
         <span class="maly">Nutri-Score<br>brak w bazie</span></div>`;

  const kartaNova = nova
    ? `<div class="ocena" style="border-color:${NOVA_KOLOR[nova]}">
         <span class="duza" style="color:${NOVA_KOLOR[nova]}">${nova}</span>
         <span class="maly">NOVA<br>${NOVA_OPIS[nova]}</span>
       </div>`
    : `<div class="ocena"><span class="duza" style="color:var(--muted)">—</span>
         <span class="maly">NOVA<br>brak w bazie</span></div>`;

  const kartaDodatki = (dodatki === null || dodatki === undefined)
    ? `<div class="ocena"><span class="duza" style="color:var(--muted)">—</span>
         <span class="maly">Dodatki<br>brak danych</span></div>`
    : `<div class="ocena">
         <span class="duza" style="color:${dodatki ? 'var(--text)' : '#038141'}">${dodatki}</span>
         <span class="maly">dodatków (E)<br>bez oceny szkodliwości</span>
       </div>`;

  const wiersze = ['tluszcz', 'cukry', 'sol'].map((k) => wierszOdzywczy(k, p[k])).join('');

  box.innerHTML = `
    <div class="prod">
      ${p.marka ? `<div class="prod-marka">${e(p.marka)}</div>` : ''}
      <h2>${e(p.nazwa)}</h2>
      ${p.kod ? `<div class="prod-kod">kod ${e(p.kod)}</div>` : ''}

      <div class="oceny">${kartaNS}${kartaNova}${kartaDodatki}</div>

      <div class="sek-tyt">Wartości na 100 g</div>
      <div class="odz">
        <span class="odz-pas"></span>
        <span class="odz-n">Kalorie</span>
        <span class="odz-w">${zaokr(p.kcal)} kcal</span><span class="odz-p"></span>
      </div>
      <div class="odz">
        <span class="odz-pas"></span>
        <span class="odz-n">Białko</span>
        <span class="odz-w">${dziesietne(p.bialko)} g</span><span class="odz-p"></span>
      </div>
      ${wiersze || '<div class="komunikat">Baza nie ma szczegółowych wartości dla tego produktu.</div>'}

      <div class="stopka">
        Nutri-Score i NOVA pochodzą z Open Food Facts — to cudze, opublikowane skale.
        Progi „mało / średnio / dużo" to brytyjskie oznaczenie na froncie opakowania (FSA)
        w przeliczeniu na 100 g.
        <br>Liczba dodatków to fakt z opakowania — <b>nie</b> oceniamy ich szkodliwości,
        bo takie klasyfikacje są autorskie i sporne.
        ${skad === 'wlasna' ? '<br>Produkt znaleziony w Waszej bazie.' : ''}
      </div>
    </div>`;
}

async function sprawdzKod(kod) {
  const czysty = String(kod || '').replace(/\D/g, '');
  if (czysty.length < 6) { komunikat('Kod ma co najmniej 6 cyfr.', true); return; }
  komunikat('Sprawdzam kod ' + czysty + '…');
  document.getElementById('wynik').innerHTML = '';
  try {
    const r = await authFetch('/api/eat/produkt?kod=' + encodeURIComponent(czysty));
    if (r.status === 404) {
      komunikat('Nie znam kodu ' + czysty + '. Nie ma go ani w Waszej bazie, ani w Open Food Facts.', true);
      return;
    }
    if (!r.ok) throw new Error('blad');
    const d = await r.json();
    komunikat('');
    pokazProdukt(d.produkt || d, d.skad);
  } catch {
    komunikat('Nie udało się sprawdzić kodu. Sprawdź połączenie.', true);
  }
}

authRequireHousehold().then(() => {
  const podglad = document.getElementById('podglad');

  document.getElementById('skanuj').onclick = () => {
    if (!window.Skaner) { komunikat('Skaner się nie wczytał. Wpisz cyfry ręcznie.', true); return; }
    komunikat('Uruchamiam aparat…');
    window.Skaner.start({
      video: document.getElementById('video'),
      wrap: podglad,
      onPodglad: () => komunikat(''),
      onKod: (kod) => sprawdzKod(kod),
      onBlad: (t) => komunikat(t, true),
      onCisza: () => komunikat('Nie widzę kodu. Podejdź bliżej albo wpisz cyfry ręcznie.'),
    });
  };

  const idz = () => {
    if (window.Skaner) window.Skaner.stop();
    podglad.style.display = 'none';
    sprawdzKod(document.getElementById('kod').value);
  };
  document.getElementById('szukaj').onclick = idz;
  document.getElementById('kod').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); idz(); }
  });
});
