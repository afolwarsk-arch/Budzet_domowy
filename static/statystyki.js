// Statystyki jedzenia — kalorie i białko w czasie plus rozkład ocen.
//
// Oceny są CUDZE i opublikowane: Nutri-Score (a–e, jakość odżywcza) i NOVA
// (1–4, stopień przetworzenia), obie z Open Food Facts. Własnego wskaźnika
// „zdrowe/niezdrowe" świadomie nie liczymy — bez definicji i bez recenzji byłaby
// to liczba, której nikt nie umie obronić, a wyglądająca poważnie. Liczbę
// dodatków pokazujemy jako fakt z opakowania, bez oceniania ich szkodliwości.

const NS_KOLOR = { a: '#038141', b: '#85bb2f', c: '#fecb02', d: '#ee8100', e: '#e63e11' };
const NOVA_KOLOR = { 1: '#038141', 2: '#85bb2f', 3: '#ee8100', 4: '#e63e11' };
const NOVA_OPIS = { 1: 'nieprzetworzone', 2: 'składniki kulinarne',
                    3: 'przetworzone', 4: 'wysoko przetworzone' };

const zaokr = (v) => Math.round(Number(v) || 0);
let okres = 7;

// Procenty liczymy od CAŁOŚCI zjedzonych kalorii, a nie od samych ocenionych,
// i „bez oceny" pokazujemy jako osobny, szary kawałek paska.
//
// Inaczej powstaje liczba alarmująca i nieprawdziwa: przy 17% ocenionych kalorii
// pasek NOVA pokazywał „wysoko przetworzone 97%", co czyta się jako „prawie
// wszystko, co jesz". Naprawdę znaczyło „97% z tych 17%" — a ocenione są głównie
// produkty paczkowane, czyli próbka z założenia przechylona w stronę
// przetworzonych, bo warzywa i dania domowe ocen nie mają.
function pasekOceny(mapa, kolory, opisy, bezOceny) {
  const ocenione = Object.values(mapa).reduce((s, v) => s + Number(v || 0), 0);
  const calosc = ocenione + Number(bezOceny || 0);
  if (!ocenione) return '<div class="stat-legenda">Nic jeszcze nie zostało ocenione.</div>';
  const klucze = Object.keys(mapa).sort();
  const kawalek = (kolor, wartosc) => `<i style="flex:${wartosc};background:${kolor}"></i>`;
  const proc = (v) => Math.round(v / calosc * 100);
  return `<div class="stat-ocena">
      ${klucze.map((k) => kawalek(kolory[k] || 'var(--border)', mapa[k])).join('')}
      ${bezOceny ? kawalek('var(--border)', bezOceny) : ''}
    </div>
    <div class="stat-legenda">${klucze.map((k) =>
      `<em><s style="background:${kolory[k] || 'var(--border)'}"></s>${
        opisy ? (opisy[k] || k) : String(k).toUpperCase()} · ${proc(mapa[k])}%</em>`
    ).join('')}${bezOceny
      ? `<em><s style="background:var(--border)"></s>bez oceny · ${proc(bezOceny)}%</em>` : ''}</div>`;
}

async function rysuj() {
  const box = document.getElementById('tresc');
  box.innerHTML = '<div class="laduje">Wczytuję…</div>';
  let d;
  try {
    const r = await authFetch('/api/eat/statystyki?dni=' + okres);
    if (!r.ok) throw new Error('brak');
    d = await r.json();
  } catch {
    box.innerHTML = '<div class="laduje">Nie udało się wczytać statystyk.</div>';
    return;
  }

  const cel = Number(d.cel_kcal) || 0;
  const maks = Math.max(cel, ...d.seria.map((s) => s.kcal)) || 1;
  const slupki = d.seria.map((s) => {
    const klasa = !s.kcal ? 'pusty' : (cel && s.kcal > cel ? 'ponad' : '');
    return `<div class="stat-slupek ${klasa}" style="height:${Math.max(2, s.kcal / maks * 100)}%"
                 title="${s.data}: ${zaokr(s.kcal)} kcal"></div>`;
  }).join('');

  const pierwszy = d.seria[0] ? d.seria[0].data.slice(8) + '.' + d.seria[0].data.slice(5, 7) : '';
  const suma = Object.values(d.nutriscore_kcal).reduce((s, v) => s + v, 0) + d.bez_oceny_kcal;
  const pokrycie = suma ? Math.round((suma - d.bez_oceny_kcal) / suma * 100) : 0;

  box.innerHTML = `
    <div class="stat-kafle">
      <div class="stat-kafel"><b>${zaokr(d.srednia_kcal)}</b><span>kcal średnio na dzień</span></div>
      <div class="stat-kafel"><b>${zaokr(d.srednia_bialko)}</b><span>g białka średnio</span></div>
      <div class="stat-kafel"><b>${d.dni_w_celu}/${d.dni_z_wpisami}</b><span>dni w celu (z zapisanych)</span></div>
    </div>

    <div class="stat-slupki">${slupki}</div>
    <div class="stat-osie">
      <span>${pierwszy}</span>
      <span>${cel ? 'czerwony = ponad ' + zaokr(cel) + ' kcal' : ''}</span>
      <span>dziś</span>
    </div>

    <div class="sek-tyt">Jakość odżywcza (Nutri-Score)</div>
    ${pasekOceny(d.nutriscore_kcal, NS_KOLOR, null, d.bez_oceny_kcal)}

    <div class="sek-tyt">Stopień przetworzenia (NOVA)</div>
    ${pasekOceny(d.nova_kcal, NOVA_KOLOR, NOVA_OPIS, d.bez_oceny_kcal)}

    <div class="stat-stopka">
      ${d.srednio_dodatkow !== null && d.srednio_dodatkow !== undefined
        ? `Średnio <b>${d.srednio_dodatkow}</b> dodatków (numerów E) na to, co jesz —
           liczba z opakowań, bez oceniania czy to źle.<br>` : ''}
      Oceniono <b>${pokrycie}%</b> kalorii. Reszta to dania z przepisu, pozycje z opisu
      i produkty z etykiety — te ocen nie mają i ich nie zgadujemy.
      <br><small>Nutri-Score i NOVA pochodzą z Open Food Facts. To cudze, opublikowane skale —
      nie liczymy własnego wskaźnika „zdrowe/niezdrowe".</small>
    </div>`;
}

authRequireHousehold().then(() => {
  document.getElementById('okres').onclick = (ev) => {
    const b = ev.target.closest('[data-dni]');
    if (!b) return;
    document.querySelectorAll('#okres [data-dni]')
      .forEach((x) => x.setAttribute('aria-pressed', 'false'));
    b.setAttribute('aria-pressed', 'true');
    okres = Number(b.dataset.dni);
    rysuj();
  };
  rysuj();
});
