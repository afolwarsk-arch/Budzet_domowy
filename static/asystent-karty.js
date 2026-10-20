// Karty propozycji asystenta — JEDYNE miejsce, które zapisuje.
//
// Serwer asystenta niczego nie zapisuje: oddaje propozycje, a tutaj
// przeglądarka wykonuje je tymi samymi endpointami, których używają zwykłe
// formularze (ta sama walidacja, te same uprawnienia). Tryb („od_razu" albo
// „karta") ustala serwer — tu go tylko wykonujemy.
(function () {
  const COFNIJ_MS = 8000;
  const MAX_DNI_WSTECZ = 7;            // to samo co asystent_reguly.MAX_DNI_WSTECZ (D2)
  // Biała lista widoków — te same klucze i ścieżki co WIDOKI w asystent_reguly.py,
  // nazwy jak ETYKIETY_WIDOKOW (+ dopełniacz do przycisku „Przejdź do …").
  // Adres buduje przeglądarka; widok spoza listy nie zostanie otwarty.
  const WIDOKI = {
    pulpit: ['/', 'Pulpit', 'Pulpitu'], lista: ['/lista', 'Lista zakupów', 'Listy zakupów'],
    analiza: ['/analiza', 'Analiza', 'Analizy'], konta: ['/konta', 'Konta', 'Kont'],
    cele: ['/cele', 'Cele', 'Celów'], wplywy: ['/wplywy', 'Wpływy', 'Wpływów'],
    eat: ['/eat', 'Dziennik jedzenia', 'Dziennika jedzenia'],
    produkty: ['/produkty', 'Produkty', 'Produktów'], przepisy: ['/przepisy', 'Przepisy', 'Przepisów'],
    statystyki: ['/statystyki', 'Statystyki jedzenia', 'Statystyk jedzenia'],
    task: ['/task', 'Zadania', 'Zadań'], health: ['/health', 'Zdrowie', 'Zdrowia'],
    waga: ['/waga', 'Masa ciała', 'Masy ciała'],
  };
  const MODUL = {
    lista_dopisz: 'lista zakupów', lista_odhacz: 'lista zakupów', jedzenie: 'wiem.eat',
    skan: 'wiem.eat', zadanie: 'wiem.task', zadanie_odhacz: 'wiem.task',
    widok: 'przejście', aparat: 'paragon',
  };
  const POSILKI = { sniadanie: 'Śniadanie', obiad: 'Obiad', kolacja: 'Kolacja', przekaska: 'Przekąska' };
  // Główny przycisk karty — mówi, co się stanie, nie „OK"/„Zapisz".
  const NAPIS = {
    lista_dopisz: 'Dopisz', lista_odhacz: 'Odhacz', zadanie_odhacz: 'Odhacz',
    zadanie: 'Dodaj zadanie', jedzenie: 'Zapisz w dzienniku',
  };
  // Kilka kart odhaczenia z jednego polecenia bywa WYBOREM („odhacz pranie" →
  // dwa pasujące zadania) albo RÓŻNYMI rzeczami („kupiłem mleko i chleb").
  // Przeglądarka tego nie odróżni, więc każda karta zostaje czynna; po zapisie
  // jednej pozostałe tylko przestają się liczyć jako niezałatwione (D1).
  const ODHACZENIA = ['zadanie_odhacz', 'lista_odhacz'];
  const BEZ_COFANIA = 'Tego nie cofnę z asystenta.';
  const DNI_KR = ['nd', 'pn', 'wt', 'śr', 'cz', 'pt', 'sb'];
  const MIES_KR = ['sty', 'lut', 'mar', 'kwi', 'maj', 'cze', 'lip', 'sie', 'wrz', 'paź', 'lis', 'gru'];
  const BRAK_SIECI = 'Brak połączenia — nic nie zapisałem. Spróbuj jeszcze raz.';
  const ZAPIS_MS = 20000;              // dłużej nie czekamy na zapis (U6)
  const MAX_GRAM = 5000;
  // Powody zablokowanego „Zapisz" — zawsze widoczne pod kartą (U9), w tej kolejności.
  const POWODY = [
    ['nazwa', 'Wpisz nazwę, żeby zapisać.'],
    ['kcal', 'Wpisz kcal na 100 g, żeby zapisać.'],
    ['gramy', 'Popraw gramy (1–5000 g), żeby zapisać.'],
    ['tytul', 'Wpisz nazwę zadania, żeby zapisać.'],
    ['obszar', 'Wybierz obszar, żeby zapisać.'],
  ];
  const BEZ_DETEKTORA = 'Ta przeglądarka nie umie czytać kodów. Zrób zdjęcie etykiety albo wpisz cyfry spod kodu kreskowego.';

  function el(tag, klasa, tekst) {
    const e = document.createElement(tag);
    if (klasa) e.className = klasa;
    if (tekst != null) e.textContent = tekst;
    return e;
  }

  function guzik(klasa, tekst) {
    const b = el('button', klasa, tekst);
    b.type = 'button';
    return b;
  }

  // Błąd sieci (`siec`) i przekroczony czas (`czas`) są oznaczone osobno:
  // po pierwszym na pewno nic się nie zapisało, po drugim — nie wiadomo.
  async function api(url, metoda, cialo) {
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const zegar = ctrl ? setTimeout(() => ctrl.abort(), ZAPIS_MS) : null;
    let r;
    let d;
    try {
      r = await authFetch(url, {
        method: metoda,
        headers: cialo ? { 'Content-Type': 'application/json' } : undefined,
        body: cialo ? JSON.stringify(cialo) : undefined,
        signal: ctrl ? ctrl.signal : undefined,
      });
      d = await r.json().catch(() => ({}));
    } catch {
      if (ctrl && ctrl.signal.aborted) {
        const lista = url.startsWith('/api/listy/') || url.startsWith('/api/pozycje/');
        const e = new Error('Nie zdążyłem zapisać — '
          + (lista ? 'sprawdź listę, zanim spróbujesz ponownie.' : 'sprawdź, zanim spróbujesz ponownie.'));
        e.czas = true;
        throw e;
      }
      const e = new Error(BRAK_SIECI);  // fetch rzuca TypeError („Failed to fetch")
      e.siec = true;
      throw e;
    } finally {
      if (zegar) clearTimeout(zegar);
    }
    if (!r.ok) {
      const blad = new Error(typeof d.detail === 'string' ? d.detail : 'Nie udało się zapisać.');
      blad.status = r.status;
      blad.pozycja = r.headers.get('X-Pozycja');
      throw blad;
    }
    return d;
  }

  // Cofnięcie kilku utworzonych rzeczy (pozycje listy, wpisy dziennika).
  // Każdy udany DELETE od razu skreśla id — ponowne „Cofnij" po częściowej
  // porażce nie usuwa drugi raz tego samego; 404 = już tego nie ma, czyli sukces.
  async function usunWszystkie(ids, adres) {
    for (const id of [...ids]) {
      try { await api(adres(id), 'DELETE'); }
      catch (e) { if (e.status !== 404) throw e; }
      const i = ids.indexOf(id);
      if (i >= 0) ids.splice(i, 1);
    }
  }

  function zapiszWynik(logId, wynik) {
    if (!logId) return;
    // keepalive: wynik „zapisano" przy przejściu na inną stronę nie może zginąć
    authFetch('/api/asystent/log/' + logId, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wynik }), keepalive: true,
    }).catch(() => {});
  }

  // Strony modułów (eat, task) słuchają tego zdarzenia i przeładowują swoje
  // dane — inaczej pod oknem wisiałby stan sprzed zapisu.
  function zapisano(typ) {
    window.dispatchEvent(new CustomEvent('asystent:zapisano', { detail: { typ } }));
  }

  function poraPosilku(d) {
    const g = d.getHours();
    if (g >= 4 && g < 11) return 'sniadanie';
    if (g >= 11 && g < 16) return 'obiad';
    if (g >= 16 && g < 22) return 'kolacja';
    return 'przekaska';
  }

  function wylicz(nazwy) {
    if (nazwy.length === 1) return nazwy[0];
    return nazwy.slice(0, -1).join(', ') + ' i ' + nazwy[nazwy.length - 1];
  }

  const dzienISO = (d) => d.toLocaleDateString('sv-SE');       // YYYY-MM-DD lokalnie
  const dzisISO = () => dzienISO(new Date());
  function dzienMinus(n) { const d = new Date(); d.setDate(d.getDate() - n); return dzienISO(d); }

  function dzienSlownie(iso) {
    const dl = new Date(iso + 'T12:00').toLocaleDateString('pl-PL',
      { weekday: 'long', day: 'numeric', month: 'long' });
    if (iso === dzisISO()) return 'dziś, ' + dl;
    if (iso === dzienMinus(1)) return 'wczoraj, ' + dl;
    if (iso === dzienMinus(2)) return 'przedwczoraj, ' + dl;
    return dl;
  }

  function terminKrotko(iso) {
    const d = new Date(iso + 'T12:00');
    return `${DNI_KR[d.getDay()]} ${d.getDate()} ${MIES_KR[d.getMonth()]}`;   // „pt 24 paź"
  }

  function adresWidoku(d) {
    const w = WIDOKI[d.widok];
    if (!w || w[0] !== d.sciezka) throw new Error('Nie znam takiego widoku.');
    const q = new URLSearchParams();
    if (d.filtry && d.filtry.month) q.set('asystent_month', d.filtry.month);
    if (d.filtry && d.filtry.osoba) q.set('asystent_osoba', d.filtry.osoba);
    const s = q.toString();
    return d.sciezka + (s ? '?' + s : '');
  }

  // Wstawia element karty NAD rzędem przycisków (U4) — pod nimi ginąłby
  // za krawędzią okna.
  function nadPrzyciskami(karta, e) {
    const pr = karta.querySelector(':scope > .ast-karta-przyciski');
    if (pr) karta.insertBefore(e, pr); else karta.append(e);
  }

  function komunikatKarty(karta, tekst) {
    let k = karta.querySelector('.ast-karta-blad');
    if (!k) { k = el('div', 'ast-karta-blad'); k.setAttribute('role', 'alert'); nadPrzyciskami(karta, k); }
    k.textContent = tekst;
    if (k.scrollIntoView) k.scrollIntoView({ block: 'nearest' });
  }

  // Wyłączone „Zapisz" zawsze mówi, czego brakuje (U9).
  function pokazPowod(karta) {
    const s = karta._blokady || new Set();
    const z = karta.querySelector('.ast-karta-przyciski .ast-zapisz');
    const przycisk = z && z.tagName === 'BUTTON' ? z : null;
    let w = karta.querySelector(':scope > .ast-powod');
    const tekst = (POWODY.find(([k]) => s.has(k)) || [])[1];
    if (!tekst || !przycisk) {
      if (w) w.remove();
      if (przycisk) przycisk.removeAttribute('aria-describedby');
      return;
    }
    if (!w) {
      w = el('div', 'ast-powod');
      w.id = 'ast-powod-' + Math.random().toString(36).slice(2);
      nadPrzyciskami(karta, w);
    }
    w.textContent = tekst;
    przycisk.setAttribute('aria-describedby', w.id);
  }

  // Zapis zablokowany, dopóki karta nie ma kompletu danych (pusty tytuł,
  // pusta nazwa produktu, brak kcal produktu ze skanu) — 0 kcal nie może się
  // zapisać po cichu. Powodów bywa kilka naraz, więc liczymy je osobno:
  // usunięcie jednego nie może odblokować karty, której brakuje czegoś innego.
  function blokada(karta, powod, wlacz) {
    const s = karta._blokady || (karta._blokady = new Set());
    if (wlacz) s.add(powod); else s.delete(powod);
    karta.dataset.blokada = s.size ? '1' : '';
    const z = karta.querySelector('.ast-karta-przyciski .ast-zapisz');
    if (z && z.tagName === 'BUTTON') z.disabled = !!s.size;
    pokazPowod(karta);
  }

  // Każdy wykonawca zwraca funkcję cofającą albo null (gdy cofnąć się nie da).
  // Cofnięcie przywraca STAN SPRZED akcji, a nie „odwrotną wartość".
  const WYKONAJ = {
    async lista_dopisz(d) {
      const utworzone = [];
      d._dopisane = [];
      d._nieudane = [];
      d._niewiadome = [];      // limit czasu: serwer mógł zapisać — nie wiadomo
      for (const nazwa of d.nazwy) {
        try {
          const id = (await api(`/api/listy/${d.lista_id}/pozycje`, 'POST', { nazwa })).id;
          if (id != null) utworzone.push(id);
          d._dopisane.push(nazwa);
        } catch (e) {
          // Brak sieci / czas na samym początku: nic nie weszło — ten błąd
          // (z flagą) idzie do wiersza, który zaproponuje ponowienie.
          if (!utworzone.length && (e.siec || e.czas)) throw e;
          (e.czas ? d._niewiadome : d._nieudane).push(nazwa);
        }
      }
      if (!utworzone.length) throw new Error('Nic nie trafiło na listę.');
      return () => usunWszystkie(utworzone, (id) => `/api/pozycje/${id}`);
    },
    async lista_odhacz(d) {
      await api(`/api/pozycje/${d.pozycja_id}`, 'PATCH', { kupione: d.kupione_po });
      return () => api(`/api/pozycje/${d.pozycja_id}`, 'PATCH', { kupione: d.kupione_przed });
    },
    async zadanie_odhacz(d) {
      await api(`/api/task/zadania/${d.zadanie_id}/status`, 'PATCH', { zrobione: true, kaskada: false });
      return () => api(`/api/task/zadania/${d.zadanie_id}/status`, 'PATCH',
        { zrobione: d.zrobione_przed, kaskada: false });
    },
    async zadanie(d) {
      await api('/api/task/zadania', 'POST', {
        tytul: d.tytul, termin: d.termin, pora: d.pora, powtarzaj: d.powtarzaj,
        powtarzaj_co: d.powtarzaj_co, parent_id: d.parent_id, strefa_id: d.strefa_id,
        wykonawca_user_id: d.wykonawca_user_id, wykonawca_virtual_id: d.wykonawca_virtual_id,
      });
      return null;
    },
    async jedzenie(d) {
      const czyste = d.pozycje.map((p) => ({
        nazwa: p.nazwa, produkt_id: p.produkt_id || null, ilosc_g: p.ilosc_g,
        opis_porcji: p.opis_porcji, kcal: p.kcal, bialko: p.bialko, tluszcz: p.tluszcz, wegle: p.wegle,
      }));
      // Oba endpointy oddają utworzone wpisy z id (RETURNING *) — „Cofnij"
      // usuwa je tym samym DELETE co kosz w dzienniku (U3).
      let ids;
      if (czyste.length === 1) {
        ids = [(await api('/api/eat/wpis', 'POST', { data: d.data, posilek: d.posilek, ...czyste[0] })).id];
      } else {
        const odp = await api('/api/eat/wpisy/grupa', 'POST',
          { data: d.data, posilek: d.posilek, nazwa_grupy: d.nazwa_grupy, pozycje: czyste });
        ids = (odp.wpisy || []).map((w) => w.id);
      }
      ids = ids.filter((id) => id != null);
      return ids.length ? () => usunWszystkie(ids, (id) => `/api/eat/wpis/${id}`) : null;
    },
    async widok(d) {
      location.href = adresWidoku(d);
      return null;
    },
  };

  // Teksty wiersza wyniku dobiera PRZEGLĄDARKA, po zapisie i z typu
  // propozycji — serwer nie wie, czy zapis się udał, więc nie może pisać
  // w czasie przeszłym. Stan jest w tekście, nie tylko w kolorze.
  const PO_ZAPISIE = {
    lista_dopisz: (d) => `Dopisane do „${d.lista_nazwa}”: ${wylicz(d._dopisane && d._dopisane.length ? d._dopisane : d.nazwy)}`
      + (d._nieudane && d._nieudane.length ? ' · nie weszło: ' + wylicz(d._nieudane) : '')
      + (d._niewiadome && d._niewiadome.length ? ' · nie wiem, czy weszło: ' + wylicz(d._niewiadome) : ''),
    lista_odhacz: (d) => `Odhaczone: ${d.nazwa}`,
    zadanie_odhacz: (d) => `Odhaczone: ${d.tytul}`,
    zadanie: (d) => `Zadanie dodane: ${d.tytul}`,
    jedzenie: (d) => `Zapisane w dzienniku: ${POSILKI[d.posilek] || d.posilek}, ${dzienSlownie(d.data)}`
      + ` · ≈ ${Math.round(d.pozycje.reduce((s, p) => s + (Number(p.kcal) || 0), 0))} kcal`,
    widok: (d) => 'Otwieram: ' + ((WIDOKI[d.widok] || [])[1] || d.widok),
  };
  const PO_COFNIECIU = {
    lista_dopisz: (d) => {
      const n = d._dopisane && d._dopisane.length ? d._dopisane : d.nazwy;
      return n.length === 1 ? `Cofnięte — usunięte z listy: ${n[0]}.` : `Cofnięte — ${wylicz(n)} zniknęły z listy.`;
    },
    lista_odhacz: (d) => `Cofnięte — „${d.nazwa}” znów do kupienia.`,
    zadanie_odhacz: (d) => `Cofnięte — „${d.tytul}” znów otwarte.`,
    jedzenie: () => 'Cofnięte — wpis usunięty z dziennika.',
  };
  // Po 8 s „Cofnij" znika — wiersz mówi, gdzie zmienić to ręcznie.
  const PO_CZASIE = {
    lista_dopisz: ' · zmienisz na liście', lista_odhacz: ' · zmienisz na liście',
    zadanie_odhacz: ' · cofniesz w Zadaniach', jedzenie: ' · usuniesz w dzienniku',
  };

  // „Cofnij" przy wierszu wyniku: 8 s, cienki pasek odliczania, cel ≥ 44 × 72 px.
  function wierszCofnij(p, wiersz, opis, cofnij, logId) {
    const btn = guzik('ast-cofnij', 'Cofnij');
    const pasek = el('span', 'ast-odliczanie');
    pasek.setAttribute('aria-hidden', 'true');
    wiersz.append(btn, pasek);
    const wygas = () => {
      btn.remove(); pasek.remove();
      opis.textContent += PO_CZASIE[p.typ] || '';
    };
    let zegar = setTimeout(wygas, COFNIJ_MS);
    btn.addEventListener('click', async () => {
      clearTimeout(zegar);
      btn.disabled = true;
      try {
        await cofnij();
      } catch (e) {
        btn.disabled = false;
        toast(e.siec ? 'Nie udało się cofnąć — brak połączenia.'
          : e.czas ? 'Nie zdążyłem cofnąć — sprawdź, zanim spróbujesz ponownie.'
            : 'Nie udało się cofnąć: ' + e.message, 'blad');
        zegar = setTimeout(wygas, COFNIJ_MS);   // druga szansa, potem znika
        return;
      }
      wiersz.classList.remove('ok');
      wiersz.classList.add('cofniete');
      opis.textContent = (PO_COFNIECIU[p.typ] || (() => 'Cofnięte.'))(p.dane);
      btn.remove(); pasek.remove();
      zapiszWynik(logId, 'cofnieto');
      zapisano(p.typ);
    });
  }

  // ── tryb „od razu" ─────────────────────────────────────────────────────
  // `wiersz` podany = ponowienie po braku sieci w tym samym wierszu (U5).
  async function odRazu(p, kontener, logId, wiersz) {
    let opis;
    if (wiersz) {
      wiersz.className = 'ast-wynik';
      opis = wiersz.querySelector('.ast-wynik-opis');
      opis.textContent = p.opis;
    } else {
      wiersz = el('div', 'ast-wynik');
      wiersz.setAttribute('role', 'status');
      opis = el('span', 'ast-wynik-opis', p.opis);
      wiersz.append(opis);
      kontener.append(wiersz);
    }
    let cofnij;
    try {
      cofnij = await WYKONAJ[p.typ](p.dane);
    } catch (e) {
      wiersz.classList.add('blad');
      zapiszWynik(logId, 'blad');
      if (e.siec) {
        // Prawie na pewno nic się nie zapisało — ponowienie jest bezpieczne.
        opis.textContent = 'Nie zapisane — brak połączenia. Spróbuj jeszcze raz.';
        const ponow = guzik('ast-ponow', 'Spróbuj ponownie');
        ponow.addEventListener('click', () => { ponow.remove(); odRazu(p, kontener, logId, wiersz); });
        wiersz.append(ponow);
      } else if (e.czas) {
        opis.textContent = e.message;       // mogło się zapisać — bez „Nie zapisane"
      } else {
        opis.textContent = 'Nie zapisane — ' + e.message;
      }
      return;
    }
    wiersz.classList.add('ok');
    opis.textContent = (PO_ZAPISIE[p.typ] || (() => p.opis))(p.dane);
    zapiszWynik(logId, 'zapisano');
    zapisano(p.typ);
    if (cofnij) wierszCofnij(p, wiersz, opis, cofnij, logId);
  }

  // ── karta do potwierdzenia ─────────────────────────────────────────────
  // Karta odrzucona: pola nie udają, że coś jeszcze zmienią.
  function zamknijKarte(karta, stan) {
    karta.classList.remove('czeka');
    karta.classList.add('zamknieta');
    const przyciski = karta.querySelector('.ast-karta-przyciski');
    if (przyciski) przyciski.remove();
    karta.querySelectorAll('input, select, button, label').forEach((x) => { x.disabled = true; });
    karta.append(el('div', 'ast-karta-stan', stan));
  }

  function odrzucenie(karta, przyciski, logId) {
    const odrzuc = guzik('ast-odrzuc', 'Odrzuć');
    odrzuc.addEventListener('click', () => {
      // Kamera jest jedna: gasimy ją tylko, gdy to TA karta skanuje (K6).
      if (skan && skan.karta === karta) zatrzymajSkan();
      zamknijKarte(karta, 'Odrzucone.');
      zapiszWynik(logId, 'odrzucono');
    });
    return odrzuc;
  }

  // Po zapisie jednej karty odhaczenia pozostałe karty tego samego typu z TEJ
  // SAMEJ odpowiedzi zostają czynne (mogą to być różne rzeczy), ale przestają
  // się liczyć jako niezałatwione — tło znów zamyka okno. Karty bez logId
  // mogą pochodzić z różnych odpowiedzi, więc ich nie łączymy (K3).
  function zwolnijRodzenstwo(karta, typ, logId) {
    if (!ODHACZENIA.includes(typ) || logId == null || !karta.parentNode) return;
    karta.parentNode.querySelectorAll('.ast-karta.czeka').forEach((k) => {
      if (k !== karta && k.dataset.typ === typ && k.dataset.log === String(logId)) k.classList.remove('czeka');
    });
  }

  function przyciskiZapisu(p, karta, przyciski, logId) {
    const { typ, dane } = p;
    const napis = typ === 'widok'
      ? 'Przejdź do ' + ((WIDOKI[dane.widok] || [])[2] || 'strony')
      : (NAPIS[typ] || 'Zapisz');
    const zapisz = guzik('ast-zapisz', napis);
    const odrzuc = odrzucenie(karta, przyciski, logId);
    przyciski.replaceChildren(zapisz, odrzuc);
    karta.classList.add('czeka');
    zapisz.disabled = !!karta.dataset.blokada;
    pokazPowod(karta);
    zapisz.addEventListener('click', async () => {
      if (karta.dataset.blokada) return;
      zapisz.disabled = odrzuc.disabled = true;
      karta.querySelectorAll('.ast-poz.blad').forEach((w) => w.classList.remove('blad'));
      let cofnij;
      try {
        cofnij = await WYKONAJ[typ](dane);
      } catch (e) {
        zapisz.disabled = !!karta.dataset.blokada;
        odrzuc.disabled = false;
        const wiersze = karta.querySelectorAll('.ast-poz');
        let tekst = e.message;
        if (e.pozycja != null) {
          if (wiersze[+e.pozycja]) wiersze[+e.pozycja].classList.add('blad');
          // U4: błąd pozycji z nazwą pozycji zamiast numeru („Pozycja 2: …").
          const poz = dane.pozycje && dane.pozycje[+e.pozycja];
          if (poz && poz.nazwa && e.status >= 400 && e.status < 500) {
            tekst = poz.nazwa + ': ' + tekst.replace(/^Pozycja \d+:\s*/, '');
          }
        }
        komunikatKarty(karta, tekst);
        zapiszWynik(logId, 'blad');
        return;
      }
      zapiszWynik(logId, 'zapisano');
      zapisano(typ);
      przyciski.remove();
      for (const s of karta.querySelectorAll(':scope > .ast-karta-blad, :scope > .ast-powod')) s.remove();
      karta.classList.remove('czeka');
      karta.classList.add('zapisana');
      zwolnijRodzenstwo(karta, typ, logId);
      // Karta jest już faktem — pola nie udają, że coś jeszcze zmienią.
      karta.querySelectorAll('input, select, button, label').forEach((x) => { x.disabled = true; });
      const wiersz = el('div', 'ast-wynik ok');
      wiersz.setAttribute('role', 'status');
      const opis = el('span', 'ast-wynik-opis', (PO_ZAPISIE[typ] || (() => 'Zapisane.'))(dane));
      wiersz.append(opis);
      karta.append(wiersz);
      // „Cofnij" tylko tam, gdzie da się wrócić do stanu sprzed akcji (R7):
      // lista i odhaczenie zadania bez uwagi (powtarzalne/wstrzymane/z
      // podzadaniami — bez „Cofnij").
      if (cofnij && !(typ === 'zadanie_odhacz' && dane.uwaga)) wierszCofnij(p, wiersz, opis, cofnij, logId);
    });
    return zapisz;
  }

  // Notka pod kartą, której zapisu nie cofnie „Cofnij" — mówi, gdzie to zrobić.
  // Jedzenie ma „Cofnij" (U3), więc notki nie dostaje.
  function notkaBezCofania(p) {
    if (p.typ === 'zadanie') return 'Usuniesz je w Zadaniach.';
    if (p.typ === 'zadanie_odhacz' && p.dane.uwaga) return BEZ_COFANIA;
    return null;
  }

  // Dzień wpisu (D2): zawsze widoczny i edytowalny, 0–7 dni wstecz; inny niż
  // dziś — wyróżniony, żeby wczorajsza kolacja nie wpadła po cichu w dziś.
  // `inny_dzien` liczy serwer z „teraz" klienta; dopóki data jest ta, którą
  // przysłał, jego zdanie wygrywa (północ między wysłaniem a odpowiedzią).
  function poleDnia(d) {
    if (d._dataSerwera === undefined) d._dataSerwera = d.data;
    const pole = el('label', 'ast-pole-dnia');
    pole.append(el('span', 'ast-pole-etyk', 'Dzień'));
    const data = el('input');
    data.type = 'date';
    data.min = dzienMinus(MAX_DNI_WSTECZ);
    data.max = dzisISO();
    data.value = d.data;
    const slownie = el('span', 'ast-dzien-slownie', dzienSlownie(d.data));
    const oznacz = () => pole.classList.toggle('inny',
      d.data !== dzisISO() || (!!d.inny_dzien && d.data === d._dataSerwera));
    // U15: data spoza zakresu wraca do poprzedniej, ale nie po cichu.
    let uwaga = null;
    const powiedz = (tekst) => {
      if (!tekst) { if (uwaga) { uwaga.remove(); uwaga = null; } return; }
      if (!uwaga) { uwaga = el('span', 'ast-pole-blad'); uwaga.setAttribute('role', 'alert'); pole.append(uwaga); }
      uwaga.textContent = tekst;
    };
    data.addEventListener('change', () => {
      if (!data.value) { data.value = d.data; powiedz(null); return; }
      if (data.value < data.min) { data.value = d.data; powiedz('Najwyżej 7 dni wstecz.'); return; }
      if (data.value > data.max) { data.value = d.data; powiedz('Najpóźniej dziś.'); return; }
      powiedz(null);
      d.data = data.value;
      slownie.textContent = dzienSlownie(d.data);
      oznacz();
    });
    oznacz();
    pole.append(data, slownie);
    return pole;
  }

  // Posiłek zgadnięty z godziny (model go nie usłyszał) — wyróżniony, żeby
  // człowiek wybrał sam; wyróżnienie znika po pierwszym wyborze.
  function polePosilku(d) {
    const pole = el('label', 'ast-pole-posilku' + (d.posilek_zgadniety ? ' zgadniety' : ''));
    pole.append(el('span', 'ast-pole-etyk', 'Posiłek'));
    const wybor = el('select');
    for (const [k, v] of Object.entries(POSILKI)) {
      const o = el('option', null, v);
      o.value = k;
      o.selected = k === d.posilek;
      wybor.append(o);
    }
    const podpowiedz = d.posilek_zgadniety ? el('span', 'ast-dzien-slownie', 'dobrany po godzinie — sprawdź') : null;
    wybor.addEventListener('change', () => {
      d.posilek = wybor.value;
      d.posilek_zgadniety = false;
      pole.classList.remove('zgadniety');
      if (podpowiedz) podpowiedz.remove();
    });
    pole.append(wybor);
    if (podpowiedz) pole.append(podpowiedz);
    return pole;
  }

  const MAKRO = ['kcal', 'bialko', 'tluszcz', 'wegle'];

  function przelicz(p) {
    for (const m of MAKRO) p[m] = Math.round(p._naGram[m] * p.ilosc_g * 10) / 10;
  }

  const brakujeKcal = (d) => d.pozycje.some((p) => p._brakKcal && !(p._naGram.kcal > 0));

  // M3: pozycje rysujemy we WŁASNYM pojemniku — ponowne rysowanie (chip
  // porcji, usunięcie pozycji) nie może zmieść dopisanych pod spodem notek
  // („Tego nie cofnę…", „Baza nie ma kalorii…", przycisk zdjęcia etykiety).
  function rysujJedzenie(d, sz, przyciski, karta) {
    let box = sz.querySelector(':scope > .ast-jedzenie');
    if (!box) { box = el('div', 'ast-jedzenie'); sz.append(box); }
    box.replaceChildren(poleDnia(d), polePosilku(d));
    const razem = el('div', 'ast-razem');
    const odswiezRazem = () => {
      const suma = d.pozycje.reduce((s, p) => s + (p.kcal || 0), 0);
      razem.textContent = 'Razem ' + (d.pozycje.some((p) => p.szacunek) ? '≈ ' : '') + Math.round(suma) + ' kcal';
    };
    d.pozycje.forEach((p, i) => {
      // Proporcje na gram zapamiętane raz, z propozycji — zmiana gramatury
      // przelicza kalorie i makro bez pytania serwera.
      if (!p._naGram) {
        p._naGram = {};
        for (const m of MAKRO) p._naGram[m] = (p[m] || 0) / p.ilosc_g;
      }
      const w = el('div', 'ast-poz');
      const nazwa = el('div', 'ast-poz-nazwa');
      nazwa.append(el('span', 'ast-poz-tekst', p.nazwa));
      // Pod nazwą — z jakim produktem z bazy pozycja się połączyła.
      if (p.produkt_nazwa && p.produkt_nazwa !== p.nazwa) nazwa.append(el('span', 'ast-poz-baza', 'z bazy: ' + p.produkt_nazwa));
      w.append(nazwa);
      const ile = el('input');
      ile.type = 'number'; ile.min = '1'; ile.max = String(MAX_GRAM); ile.inputMode = 'decimal';
      ile.value = p.ilosc_g;
      ile.setAttribute('aria-label', 'Gramy: ' + p.nazwa);
      const kcal = el('span', 'ast-poz-kcal');
      const zakres = el('span', 'ast-poz-zakres', '1–5000 g');   // U10: widoczne tylko przy złej wartości
      p._zleGramy = false;
      const odswiez = () => {
        kcal.textContent = p._brakKcal && !(p._naGram.kcal > 0)
          ? '— kcal' : (p.szacunek ? '≈ ' : '') + Math.round(p.kcal) + ' kcal';
        odswiezRazem();
      };
      ile.addEventListener('input', () => {
        const g = parseFloat(String(ile.value).replace(',', '.'));
        const dobre = g > 0 && g <= MAX_GRAM;
        p._zleGramy = !dobre;
        ile.setAttribute('aria-invalid', dobre ? 'false' : 'true');
        if (dobre) {
          zakres.remove();
          p.ilosc_g = g;
          przelicz(p);
          odswiez();
        } else if (!zakres.parentNode) {
          w.insertBefore(zakres, kcal);
        }
        if (karta) blokada(karta, 'gramy', d.pozycje.some((q) => q._zleGramy));
      });
      w.append(ile, el('span', 'ast-poz-g', 'g'), kcal);
      if (p.szacunek) w.append(el('span', 'ast-znaczek', 'szacunek'));
      if (d.pozycje.length > 1) {
        const x = guzik('ast-poz-usun', '✕');
        x.setAttribute('aria-label', 'Usuń z wpisu: ' + p.nazwa);
        x.addEventListener('click', () => { d.pozycje.splice(i, 1); rysujJedzenie(d, sz, przyciski, karta); });
        w.append(x);
      }
      // Porcje produktu ze skanu: porcja / sztuka / 100 g — stuknięcie
      // ustawia gramaturę zamiast liczenia w pamięci.
      if (p._porcje && p._porcje.length) {
        const chipy = el('div', 'ast-chipy');
        for (const o of p._porcje) {
          const c = guzik('ast-chip' + (o.g === p.ilosc_g ? ' wybrany' : ''), `${o.opis} · ${o.g} g`);
          c.setAttribute('aria-pressed', o.g === p.ilosc_g ? 'true' : 'false');
          c.addEventListener('click', () => {
            p.ilosc_g = o.g;
            p.opis_porcji = o.opis === '100 g' ? null : o.opis;
            przelicz(p);
            rysujJedzenie(d, sz, przyciski, karta);
          });
          chipy.append(c);
        }
        w.append(chipy);
      }
      // Produkt bez kalorii (Open Food Facts nie miał danych): pole „kcal na
      // 100 g" i zapis zablokowany, dopóki go nie ma — inaczej 0 kcal.
      if (p._brakKcal) {
        const pole = el('label', 'ast-pole-kcal');
        pole.append(el('span', 'ast-pole-etyk', 'kcal na 100 g'));
        const wart = el('input');
        wart.type = 'text'; wart.inputMode = 'decimal';
        wart.value = p._naGram.kcal > 0 ? String(Math.round(p._naGram.kcal * 1000) / 10) : '';
        wart.addEventListener('input', () => {
          const v = parseFloat(String(wart.value).replace(',', '.'));
          p._naGram.kcal = v > 0 && v <= 900 ? v / 100 : 0;
          przelicz(p);
          if (karta) blokada(karta, 'kcal', brakujeKcal(d));
          odswiez();
        });
        pole.append(wart);
        w.append(pole);
      }
      odswiez();
      box.append(w);
    });
    box.append(razem);
    odswiezRazem();
    if (karta) {
      blokada(karta, 'kcal', brakujeKcal(d));
      blokada(karta, 'gramy', false);       // przerysowane pola pokazują ostatnie dobre gramy
    }
  }

  async function wczytajProjekty() {
    try {
      const r = await authFetch('/api/task/drzewo');
      if (!r.ok) return [];
      return ((await r.json()).zadania || []).filter((z) => z.projekt);
    } catch { return []; }
  }

  async function wczytajObszary() {
    try {
      const r = await authFetch('/api/task/strefy');
      if (!r.ok) return [];
      const wszystkie = (await r.json()).strefy || [];
      const moje = wszystkie.filter((s) => s.moja);
      return moje.length ? moje : wszystkie;
    } catch { return []; }
  }

  // Nowe zadanie: tytuł, termin i projekt poprawia się NA KARCIE — model nie
  // dopytuje o projekt (każde pytanie to kolejne wywołanie i kilka sekund).
  function rysujZadanie(d, sz, przyciski, karta) {
    sz.replaceChildren();
    const pTytul = el('label', 'ast-pole-pelne');
    pTytul.append(el('span', 'ast-pole-etyk', 'Zadanie'));
    const tytul = el('input');
    tytul.type = 'text'; tytul.maxLength = 200; tytul.value = d.tytul;
    tytul.addEventListener('input', () => {
      d.tytul = tytul.value.trim();
      blokada(karta, 'tytul', !d.tytul);
    });
    pTytul.append(tytul);

    const pTermin = el('label', 'ast-pole-dnia');
    pTermin.append(el('span', 'ast-pole-etyk', 'Termin'));
    const termin = el('input');
    termin.type = 'date'; termin.value = d.termin || '';
    const godz = d.pora ? el('span', 'ast-dzien-slownie', 'godz. ' + d.pora) : null;
    termin.addEventListener('change', () => {
      d.termin = termin.value || null;
      // U11: godzina bez dnia nic nie znaczy — wyczyszczony termin zabiera ją ze sobą.
      if (!d.termin) { d.pora = null; if (godz) godz.remove(); }
    });
    pTermin.append(termin);
    if (godz) pTermin.append(godz);

    sz.append(pTytul, pTermin);
    const OKRES = { dzien: 'dzień', tydzien: 'tydzień', miesiac: 'miesiąc', rok: 'rok' };
    if (d.powtarzaj) {
      sz.append(el('div', 'ast-linia', 'Powtarza się: co '
        + (d.powtarzaj_co > 1 ? d.powtarzaj_co + ' × ' : '') + (OKRES[d.powtarzaj] || d.powtarzaj)));
    }
    // Etykieta domownika z gospodarstwa („Ola"), ustalona przez serwer.
    if (d.wykonawca_opis) sz.append(el('div', 'ast-linia', 'Kto: ' + d.wykonawca_opis));

    // Projekt: najpierw to, co rozpoznał serwer, potem „Bez projektu",
    // potem projekty z drzewa zadań (ten sam endpoint co szybkie łapanie w /task).
    const pProjekt = el('label', 'ast-pole-pelne');
    pProjekt.append(el('span', 'ast-pole-etyk', 'Projekt'));
    const wybor = el('select');
    const pierwotne = { parent_id: d.parent_id, strefa_id: d.strefa_id, miejsce_opis: d.miejsce_opis };
    const opcja = (wartosc, tekst) => { const o = el('option', null, tekst); o.value = wartosc; return o; };
    if (pierwotne.parent_id || pierwotne.strefa_id) wybor.append(opcja('rozpoznane', pierwotne.miejsce_opis));
    wybor.append(opcja('', 'Bez projektu'));

    // Zadanie bez projektu i bez obszaru znikało z zakładek Praca/Dom (trafiało
    // tylko do „Inne”) — karta dopytuje wtedy o obszar i nie zapisze bez niego.
    // Projekt niesie własny obszar (task_db.dodaj), więc przy nim pytania nie ma.
    const pObszar = el('div', 'ast-pole-pelne');
    pObszar.append(el('span', 'ast-pole-etyk', 'Do którego obszaru?'));
    const chipy = el('div', 'ast-chipy');
    pObszar.append(chipy);
    let wybranyObszar = null;
    let obszaryWczytane = false;
    const trzebaObszaru = () => !d.parent_id && !d.strefa_id;
    const odswiezObszar = () => {
      const pokaz = obszaryWczytane && chipy.childElementCount > 0 && (trzebaObszaru() || wybranyObszar);
      pObszar.hidden = !pokaz || !!d.parent_id;
      // Bez listy obszarów (błąd sieci) nie blokujemy — lepiej „Inne” niż brak zapisu.
      blokada(karta, 'obszar', !!pokaz && trzebaObszaru());
    };

    wybor.addEventListener('change', () => {
      if (wybor.value === 'rozpoznane') Object.assign(d, pierwotne);
      else if (!wybor.value) Object.assign(d, { parent_id: null, strefa_id: wybranyObszar, miejsce_opis: 'bez projektu' });
      else {
        const o = wybor.selectedOptions[0];
        // Obszar dziedziczy się po projekcie (task_db.dodaj) — własnego nie podajemy.
        Object.assign(d, { parent_id: +wybor.value, strefa_id: null, miejsce_opis: o.textContent });
      }
      odswiezObszar();
    });
    pProjekt.append(wybor);
    pObszar.hidden = true;
    sz.append(pObszar, pProjekt);

    if (trzebaObszaru()) {
      // Od razu, nie po wczytaniu — szybkie stuknięcie zapisałoby bez obszaru.
      blokada(karta, 'obszar', true);
      wczytajObszary().then((obszary) => {
        for (const s of obszary) {
          const b = guzik('ast-chip', s.nazwa);
          b.setAttribute('aria-pressed', 'false');
          b.addEventListener('click', () => {
            wybranyObszar = s.id;
            chipy.querySelectorAll('.ast-chip').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
            if (!d.parent_id) d.strefa_id = s.id;
            odswiezObszar();
          });
          chipy.append(b);
        }
        obszaryWczytane = true;
        odswiezObszar();
      });
    }
    wczytajProjekty().then((projekty) => {
      for (const z of projekty) {
        if (z.id === pierwotne.parent_id) continue;
        wybor.append(opcja(String(z.id), z.tytul));
      }
    });
  }

  // Odhaczenie zadania: duży tytuł (na karcie), jedna linia, która odróżnia
  // dwa zadania o tym samym tytule, i powód, dla którego karta pyta.
  function rysujOdhaczenie(d, sz) {
    const linia = [d.termin ? 'termin: ' + terminKrotko(d.termin) : null, d.projekt, d.wykonawca]
      .filter(Boolean).join(' · ');
    if (linia) sz.append(el('div', 'ast-linia', linia));
    if (d.cudze) {
      // Imienia nie odmieniamy (to dane z bazy), stąd forma z dwukropkiem.
      sz.append(el('p', 'ast-notka', `Przypisane: ${d.wykonawca || 'innej osobie'} — dlatego pytam przed odhaczeniem.`));
    }
    if (d.uwaga) sz.append(el('p', 'ast-uwaga', d.uwaga));
  }

  // Odhaczenie z listy: nazwa duża (jak przy zadaniu), lista pod spodem —
  // przy dwóch pasujących pozycjach to ona je odróżnia.
  function rysujOdhaczenieListy(d, sz) {
    if (d.lista_nazwa) sz.append(el('div', 'ast-linia', 'Lista: ' + d.lista_nazwa));
  }

  function rysujWidok(d, sz) {
    const f = d.filtry || {};
    const czesci = [];
    if (f.month) {
      const [r, m] = f.month.split('-').map(Number);
      czesci.push('Miesiąc: ' + new Date(r, m - 1, 15).toLocaleDateString('pl-PL', { month: 'long', year: 'numeric' }));
    }
    if (f.osoba) czesci.push('Osoba: ' + f.osoba);
    if (czesci.length) sz.append(el('div', 'ast-linia', czesci.join(' · ')));
  }

  function rysujAparat(d, sz, przyciski, karta, logId) {
    // <label for> zamiast pole.click() i pole schowane klasą, nie display:none —
    // oba błędy kosztowały już w apce niedziałający aparat.
    const id = 'ast-plik-' + Math.random().toString(36).slice(2);
    const pole = el('input', 'ast-schowane');
    pole.type = 'file'; pole.accept = 'image/*'; pole.id = id;
    pole.setAttribute('capture', 'environment');
    const etykieta = el('label', 'ast-zapisz ast-etykieta', 'Otwórz aparat');
    etykieta.htmlFor = id;
    pole.addEventListener('change', async () => {
      if (!pole.files || !pole.files.length) return;
      etykieta.classList.add('czeka');
      try {
        await zapiszZdjecieDoPrzekazania(pole.files[0]);
        // K7: wynik przed przejściem (keepalive) — paragon dokończy /upload.
        zapiszWynik(logId, 'zapisano');
        location.href = '/upload?zdjecie=1';
      } catch {
        etykieta.classList.remove('czeka');
        toast('Nie udało się przekazać zdjęcia. Spróbuj przez „Dodaj wydatek".', 'blad');
      }
    });
    przyciski.replaceChildren(pole, etykieta, odrzucenie(karta, przyciski, logId));
    karta.classList.add('czeka');
  }

  // ── skan kodu ───────────────────────────────────────────────────────────
  // I5: kamera jest jedna, a `Skaner.start` czeka na zgodę/`getUserMedia`.
  // Przerwanie w tym czasie (Przerwij, schowanie okna, Nowa rozmowa) trafiało
  // w pustkę — strumień jeszcze nie istniał — i kamera zapalała się po
  // chwili sama. Dlatego każda sesja ma flagę `koniec`, sprawdzaną po starcie.
  let skan = null;                        // bieżąca sesja: { koniec, zakoncz }
  let startTrwa = Promise.resolve();      // poprzedni start (z ewentualnym stop) — nowy czeka na niego
  function zatrzymajSkan() { if (skan) skan.zakoncz(); }

  function porcjeProduktu(pr) {
    const wynik = [];
    const porcja = Number(pr.porcja_g);
    const opak = Number(pr.opak_g);
    const sztuk = Number(pr.sztuk_w_opak);
    if (porcja > 0) wynik.push({ opis: pr.opis_porcji || '1 porcja', g: Math.round(porcja * 10) / 10 });
    if (opak > 0 && sztuk > 1) wynik.push({ opis: '1 szt.', g: Math.round((opak / sztuk) * 10) / 10 });
    wynik.push({ opis: '100 g', g: 100 });
    return wynik;
  }

  // Zdjęcie tabeli z tyłu — ten sam endpoint co w eat, z kodem ze skanu, więc
  // produkt zapisze się pod tym kodem i następny skan znajdzie go od razu.
  // I4: tabela z tyłu nie zawiera nazwy, więc nazwę (znaną albo wpisaną)
  // wysyłamy polem `nazwa` — bez niej produkt lądowałby jako „Produkt bez nazwy".
  // U8: przycisk zostaje czynny; bez nazwy stuknięcie nie otwiera aparatu,
  // tylko mówi, czego brakuje, i przenosi do pola nazwy.
  // `kodFn` — kod bywa jeszcze nieznany (cyfry wpisywane ręcznie, K4); pusty
  // kod endpoint przyjmuje (produkt zapisze się bez kodu).
  function przyciskEtykiety(kodFn, karta, poOdczycie, nazwaFn) {
    const id = 'ast-ety-' + Math.random().toString(36).slice(2);
    const pole = el('input', 'ast-schowane');
    pole.type = 'file'; pole.accept = 'image/*'; pole.id = id;
    pole.setAttribute('capture', 'environment');
    const etykieta = el('label', 'ast-zapisz ast-etykieta', 'Zdjęcie etykiety');
    etykieta.htmlFor = id;
    const brakNazwy = (ev) => {
      if (String(nazwaFn() || '').trim()) return;
      ev.preventDefault();
      komunikatKarty(karta, 'Wpisz nazwę produktu.');
      const we = karta.querySelector('.ast-pole-nazwy input');
      if (we && we.focus) we.focus();
    };
    etykieta.addEventListener('click', brakNazwy);
    pole.addEventListener('click', brakNazwy);
    pole.addEventListener('change', async () => {
      const plik = pole.files && pole.files[0];
      if (!plik) return;
      const nazwa = String(nazwaFn() || '').trim();
      if (!nazwa) { pole.value = ''; komunikatKarty(karta, 'Wpisz nazwę produktu.'); return; }
      etykieta.classList.add('czeka');
      etykieta.textContent = 'Czytam tabelę…';
      const fd = new FormData();
      fd.append('file', plik);
      fd.append('nazwa', nazwa);
      try {
        let r;
        try {
          r = await authFetch('/api/eat/etykieta?kod=' + encodeURIComponent(kodFn() || ''), { method: 'POST', body: fd });
        } catch { throw new Error('Brak połączenia — spróbuj jeszcze raz.'); }
        const odp = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(typeof odp.detail === 'string' ? odp.detail : 'Nie udało się odczytać etykiety.');
        poOdczycie(odp.produkt);
      } catch (e) {
        etykieta.classList.remove('czeka');
        etykieta.textContent = 'Zdjęcie etykiety';
        komunikatKarty(karta, e.message);
      } finally { pole.value = ''; }
    });
    const box = el('span', 'ast-etykieta-box');
    box.append(pole, etykieta);
    return box;
  }

  // Pole „Nazwa produktu" (I4) — wymagane przy nieznanym kodzie, edytowalne
  // na karcie produktu. `zmiana(nazwa)` dostaje wartość po przycięciu.
  function poleNazwy(wartosc, zmiana) {
    const pole = el('label', 'ast-pole-pelne ast-pole-nazwy');
    pole.append(el('span', 'ast-pole-etyk', 'Nazwa produktu'));
    const we = el('input');
    we.type = 'text'; we.maxLength = 120; we.value = wartosc || '';
    we.autocomplete = 'off';
    we.addEventListener('input', () => zmiana(we.value.trim()));
    pole.append(we);
    return pole;
  }

  function usunBlad(karta) {
    const b = karta.querySelector('.ast-karta-blad');
    if (b) b.remove();
  }

  // Karta skanu ma trzy drogi do produktu: kamera, cyfry wpisane ręcznie
  // (gdy przeglądarka nie czyta kodów albo kamera zawiodła — K4) i zdjęcie
  // etykiety. Stan wspólny tych dróg trzyma `c`.
  function rysujSkan(d, sz, przyciski, karta, logId) {
    if (d.data !== dzisISO()) sz.append(poleDnia(d));
    if (d.gramy || d.sztuk) sz.append(el('div', 'ast-linia', 'W poleceniu: ' + (d.gramy ? d.gramy + ' g' : d.sztuk + ' szt.')));
    const c = {
      d, sz, przyciski, karta, logId,
      start: guzik('ast-zapisz', 'Skanuj kod'),
      odrzuc: odrzucenie(karta, przyciski, logId),
      // Bez czytnika kodów „Skanuj kod" byłby ślepym przyciskiem — nie ma go wcale.
      bezDetektora: !('BarcodeDetector' in window),
      reczny: false,
    };
    c.przyciskiStartu = () => {
      c.start.disabled = false;
      if (c.bezDetektora) przyciski.replaceChildren(c.odrzuc);
      else przyciski.replaceChildren(c.start, c.odrzuc);
    };
    // Powrót po nieudanym wyszukaniu: do przycisków startu i — jeśli człowiek
    // był już na ręcznej drodze — z powrotem do pola cyfr.
    c.wroc = () => { c.przyciskiStartu(); if (c.reczny) rysujReczny(c, null); };
    c.ponow = () => { usunBlad(karta); if (c.reczny) c.wroc(); else uruchomSkan(c); };
    c.start.addEventListener('click', () => uruchomSkan(c));
    c.przyciskiStartu();
    karta.classList.add('czeka');
    if (c.bezDetektora) rysujReczny(c, BEZ_DETEKTORA);
  }

  // K4: cyfry spod kodu wpisane ręcznie idą tą samą drogą co zeskanowany kod
  // (/api/eat/produkt?kod=), a obok jest zdjęcie etykiety — bez ślepego zaułka.
  function rysujReczny(c, komunikat) {
    c.reczny = true;
    const stary = c.sz.querySelector(':scope > .ast-reczny');
    if (stary) stary.remove();
    const box = el('div', 'ast-reczny');
    if (komunikat) box.append(el('p', 'ast-uwaga', komunikat));
    const pCyfry = el('label', 'ast-pole-pelne ast-pole-cyfr');
    pCyfry.append(el('span', 'ast-pole-etyk', 'Cyfry spod kodu'));
    const cyfry = el('input');
    cyfry.type = 'text'; cyfry.inputMode = 'numeric'; cyfry.autocomplete = 'off'; cyfry.maxLength = 14;
    pCyfry.append(cyfry);
    const kodFn = () => {
      const v = String(cyfry.value || '').replace(/\s+/g, '');
      return /^\d{6,14}$/.test(v) ? v : '';
    };
    const szukaj = guzik('ast-szukaj', 'Szukaj');
    szukaj.addEventListener('click', () => {
      const kod = kodFn();
      if (!kod) {
        komunikatKarty(c.karta, 'Wpisz od 6 do 14 cyfr spod kodu.');
        if (cyfry.focus) cyfry.focus();
        return;
      }
      usunBlad(c.karta);
      box.remove();
      poKodzie(kod, c);
    });
    let nazwa = '';
    const poOdczycie = (produkt) => kartaProduktu(produkt, kodFn(), c, poOdczycie);
    box.append(pCyfry, szukaj, poleNazwy('', (n) => { nazwa = n; }),
      przyciskEtykiety(kodFn, c.karta, poOdczycie, () => nazwa));
    c.sz.append(box);
  }

  async function uruchomSkan(c) {
    const { sz, przyciski, karta } = c;
    zatrzymajSkan();
    c.start.disabled = true;
    // Sesja istnieje od stuknięcia, nie od zapalenia kamery: schowanie okna
    // albo Odrzuć w czasie wczytywania skanera też musi ją przerwać.
    const sesja = { koniec: false, karta, sprzataj: () => {} };
    const skoncz = () => {
      sesja.koniec = true;
      sesja.sprzataj();
      if (skan === sesja) skan = null;
    };
    sesja.zakoncz = () => { if (sesja.koniec) return; skoncz(); c.przyciskiStartu(); };
    skan = sesja;
    try { await zaladujSkrypt('eat-skaner.js'); }
    catch (e) {
      if (sesja.koniec) return;
      skoncz(); c.przyciskiStartu(); komunikatKarty(karta, e.message); return;
    }
    await startTrwa;                     // poprzednia kamera na pewno zgaszona
    if (sesja.koniec) return;
    // K5: kamerę trzyma inny skaner tej strony (np. arkusz w eat) — mówimy to
    // wprost, zamiast po cichu nic nie zrobić (Skaner.start odmawia drugiego startu).
    if (window.Skaner.dziala && window.Skaner.dziala()) {
      skoncz(); c.przyciskiStartu();
      komunikatKarty(karta, 'Aparat jest już używany na tej stronie — zamknij tamten skaner.');
      return;
    }
    usunBlad(karta);
    const reczny = sz.querySelector(':scope > .ast-reczny');
    if (reczny) reczny.remove();
    const wrap = el('div', 'ast-kamera');
    const video = el('video');
    video.setAttribute('playsinline', ''); video.muted = true;
    wrap.append(video);
    const info = el('div', 'ast-linia', 'Skieruj aparat na kod kreskowy.');
    sz.append(wrap, info);
    const przerwij = guzik('ast-odrzuc', 'Przerwij');
    przyciski.replaceChildren(przerwij);
    sesja.sprzataj = () => { window.Skaner.stop(); wrap.remove(); info.remove(); };
    przerwij.addEventListener('click', () => sesja.zakoncz());
    startTrwa = (async () => {
      try {
        await window.Skaner.start({
          video, wrap,
          onKod: (kod) => {
            if (sesja.koniec) return;      // przerwane — kod z ostatniej klatki nie liczy się
            skoncz();
            poKodzie(kod, c);
          },
          // Kamera albo czytnik zawiodły — komunikat skanera i od razu droga
          // ręczna (cyfry, zdjęcie etykiety); „Skanuj kod" zostaje do ponowienia.
          onBlad: (t) => { if (sesja.koniec) return; sesja.zakoncz(); rysujReczny(c, t); },
          onCisza: () => { if (!sesja.koniec) info.textContent = 'Nie widzę kodu — przybliż telefon albo popraw światło.'; },
        });
      } catch { /* błędy startu zgłasza onBlad */ }
      // Przerwane w trakcie startu: strumień powstał dopiero teraz — gasimy.
      if (sesja.koniec) window.Skaner.stop();
    })();
  }

  async function poKodzie(kod, c) {
    const { sz, przyciski, karta } = c;
    const info = el('div', 'ast-linia', 'Szukam produktu…');
    sz.append(info);
    let r;
    let odp = {};
    try {
      r = await authFetch('/api/eat/produkt?kod=' + encodeURIComponent(kod));
      odp = await r.json().catch(() => ({}));
    } catch {
      info.remove();
      c.wroc();
      komunikatKarty(karta, 'Brak połączenia — spróbuj jeszcze raz.');
      return;
    }
    info.remove();
    const poOdczycie = (produkt) => kartaProduktu(produkt, kod, c, poOdczycie);
    if (r.status === 404) {
      // Ślepego zaułka nie ma: od razu droga naprzód, w tym samym oknie.
      // Nazwy na tabeli z tyłu nie ma — człowiek ją wpisuje, zanim zrobi zdjęcie.
      const box = el('div', 'ast-nieznany');
      box.append(el('p', 'ast-uwaga',
        'Nie znam tego kodu. Wpisz nazwę produktu i zrób zdjęcie etykiety — zapamiętam go na następny raz.'));
      let nazwa = '';
      box.append(poleNazwy('', (n) => { nazwa = n; }));
      sz.append(box);
      // U9: po nieznanym kodzie także droga wstecz — inny kod.
      const ponow = guzik('ast-ponow', c.reczny ? 'Wpisz inny kod' : 'Skanuj ponownie');
      ponow.addEventListener('click', () => { box.remove(); c.ponow(); });
      przyciski.replaceChildren(przyciskEtykiety(() => kod, karta, poOdczycie, () => nazwa), ponow, c.odrzuc);
      return;
    }
    if (!r.ok) {
      c.wroc();
      komunikatKarty(karta, typeof odp.detail === 'string' ? odp.detail : 'Nie udało się sprawdzić kodu.');
      return;
    }
    kartaProduktu(odp.produkt, kod, c, poOdczycie);
  }

  function kartaProduktu(produkt, kod, c, poOdczycie) {
    const { d, sz, przyciski, karta, logId } = c;
    const brak = produkt.kcal == null;
    const porcje = porcjeProduktu(produkt);
    const sztukaG = (porcje.find((o) => o.opis === '1 szt.') || porcje.find((o) => o.opis !== '100 g') || {}).g;
    // Porcja powiedziana w poleceniu ma pierwszeństwo przed porcją z bazy.
    let g = porcje[0].g;
    let opisPorcji = porcje[0].opis === '100 g' ? null : porcje[0].opis;
    if (d.gramy) { g = d.gramy; opisPorcji = null; }
    else if (d.sztuk && sztukaG) { g = Math.round(d.sztuk * sztukaG * 10) / 10; opisPorcji = d.sztuk + ' szt.'; }
    const naGram = {};
    for (const m of MAKRO) naGram[m] = (Number(produkt[m]) || 0) / 100;
    const poz = {
      // Bez kalorii produktu wpis idzie BEZ produkt_id: /api/eat/wpis liczyłby
      // z produktu (float(None) → 500); kcal z pola „kcal na 100 g" od człowieka.
      nazwa: produkt.nazwa || '', produkt_id: brak ? null : produkt.id, produkt_nazwa: null,
      ilosc_g: g, opis_porcji: opisPorcji, szacunek: false,
      _naGram: naGram, _porcje: porcje, _brakKcal: brak,
    };
    przelicz(poz);
    // Po zdjęciu etykiety karta rysuje się od nowa — dzień i posiłek wybrane
    // na poprzedniej wersji karty nie mogą wrócić do wartości z propozycji.
    const poprz = d._dane;
    const dane = {
      data: poprz ? poprz.data : d.data, posilek: poprz ? poprz.posilek : d.posilek,
      posilek_zgadniety: poprz ? !!poprz.posilek_zgadniety : !!d.posilek_zgadniety,
      nazwa_grupy: null, pozycje: [poz],
    };
    d._dane = dane;
    const tytul = karta.querySelector('.ast-karta-tytul');
    tytul.textContent = poz.nazwa || 'Produkt';
    usunBlad(karta);
    karta._blokady = new Set();
    sz.replaceChildren();
    // I4: nazwa produktu do poprawienia (wpis bierze nazwę z ekranu przed nazwą
    // z bazy); pusta blokuje zapis (zdjęcie etykiety mówi wtedy, czego brakuje).
    sz.append(poleNazwy(poz.nazwa, (n) => {
      poz.nazwa = n;
      tytul.textContent = n || 'Produkt';
      const t = sz.querySelector('.ast-poz-tekst');
      if (t) t.textContent = n;
      blokada(karta, 'nazwa', !n);
    }));
    rysujJedzenie(dane, sz, przyciski, karta);
    if (brak) {
      sz.append(el('p', 'ast-uwaga', 'Baza nie ma kalorii tego produktu. Wpisz kcal na 100 g albo zrób zdjęcie etykiety.'));
      sz.append(przyciskEtykiety(() => kod, karta, poOdczycie, () => poz.nazwa));
    }
    przyciskiZapisu({ typ: 'jedzenie', dane }, karta, przyciski, logId);
    blokada(karta, 'nazwa', !poz.nazwa);
  }

  const RYSUJ = {
    jedzenie: rysujJedzenie, zadanie: rysujZadanie, zadanie_odhacz: rysujOdhaczenie,
    lista_odhacz: rysujOdhaczenieListy,
    widok: rysujWidok, aparat: rysujAparat, skan: rysujSkan,
  };

  function karta(p, kontener, logId) {
    const k = el('div', 'ast-karta');
    k.dataset.typ = p.typ;
    k.dataset.log = String(logId);
    // Odhaczenie: tytuł zadania / nazwa pozycji duża, bez „Odhacz…" — karta to
    // jedno stuknięcie, a przy kilku pasujących tytuł jest tym, co się wybiera.
    const duzy = p.typ === 'zadanie_odhacz' || p.typ === 'lista_odhacz';
    // U11: nagłówek nowego zadania stały — tytuł poprawia się w polu niżej,
    // a nagłówek z „opisem" serwera rozjeżdżałby się z polem.
    const tytul = p.typ === 'zadanie_odhacz' ? p.dane.tytul : p.typ === 'lista_odhacz' ? p.dane.nazwa
      : p.typ === 'zadanie' ? 'Nowe zadanie' : p.opis;
    k.append(el('div', 'ast-karta-modul', MODUL[p.typ] || ''),
      el('div', 'ast-karta-tytul' + (duzy ? ' duzy' : ''), tytul || p.opis));
    const sz = el('div', 'ast-karta-szczeg');
    const przyciski = el('div', 'ast-karta-przyciski');
    k.append(sz, przyciski);
    kontener.append(k);
    if (RYSUJ[p.typ]) RYSUJ[p.typ](p.dane, sz, przyciski, k, logId);
    if (p.typ === 'aparat' || p.typ === 'skan') return;   // mają własne przyciski
    const notka = notkaBezCofania(p);
    if (notka) sz.append(el('p', 'ast-notka', notka));
    przyciskiZapisu(p, k, przyciski, logId);
  }

  function pokaz(p, kontener, logId) {
    if (!WYKONAJ[p.typ] && !RYSUJ[p.typ]) return;
    if (p.tryb === 'od_razu' && WYKONAJ[p.typ]) odRazu(p, kontener, logId);
    else karta(p, kontener, logId);
  }

  // Czy w oknie żyje „Cofnij" albo stoi niezapisana karta — wtedy stuknięcie
  // w tło nie zamyka okna (D1).
  function cosCzeka(kontener) {
    return !!kontener.querySelector('.ast-cofnij:not([disabled]), .ast-karta.czeka');
  }

  window.AsystentKarty = { pokaz, poraPosilku, cosCzeka, zatrzymajSkan, WIDOKI };
})();
