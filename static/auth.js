const FIREBASE_CONFIG = {
  apiKey: "AIzaSyAyrSgsNqGLopkZCsa2ZT0AVFBML9XdTgA",
  authDomain: "budzet-domowy-56761.firebaseapp.com",
  projectId: "budzet-domowy-56761",
  storageBucket: "budzet-domowy-56761.firebasestorage.app",
  messagingSenderId: "350559993272",
  appId: "1:350559993272:web:03a4e625c748d52a61234d",
};

firebase.initializeApp(FIREBASE_CONFIG);
const _auth = firebase.auth();

// PWA: rejestracja service workera daje instalację na ekranie głównym
// („Zainstaluj aplikację" na Androidzie, „Do ekranu głównego" na iOS),
// szybszy start z cache'owanej skorupy i ekran offline zamiast błędu
// przeglądarki. Błąd rejestracji nie może wywrócić strony — apka działa
// bez workera tak samo jak dotąd.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

async function authGetToken() {
  const user = _auth.currentUser;
  if (!user) throw new Error("Nie zalogowany");
  return user.getIdToken();
}

async function authLogout() {
  await _auth.signOut();
  window.location.href = "/login";
}

// ── motyw: auto (za systemem) / jasny / ciemny ──
// Wybór zapisany w localStorage, stosowany przed pierwszym malowaniem przez
// skrypt wstrzykiwany w main.py — tutaj tylko przełączanie i pasek statusu.
function _motywBiezacy() {
  try { return localStorage.getItem('motyw') || 'auto'; } catch { return 'auto'; }
}

function _ustawMotyw(m) {
  const root = document.documentElement;
  try {
    if (m === 'auto') localStorage.removeItem('motyw');
    else localStorage.setItem('motyw', m);
  } catch {}
  if (m === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', m === 'ciemny' ? 'dark' : 'light');
  _odswiezPasekStatusu();
  // wykresy nie czytaja zmiennych CSS — musza sie przerysowac same
  window.dispatchEvent(new Event('motyw-zmieniony'));
}

function _odswiezPasekStatusu() {
  // Pasek nawigacji jest atramentowy w obu motywach, więc pasek statusu
  // telefonu zostaje ciemny na stałe — inaczej nad ciemnym paskiem apki
  // świeciłby jasny pas systemu.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', '#1a1d20');
}

function _podepnijMotyw(overlay) {
  const box = overlay.querySelector('#_mtheme');
  if (!box) return;
  const zaznacz = () => {
    const akt = _motywBiezacy();
    box.querySelectorAll('button').forEach((b) => {
      const wybrany = b.dataset.motyw === akt;
      b.style.background = wybrany ? 'var(--primary)' : 'var(--surface)';
      b.style.color = wybrany ? 'var(--on-primary)' : 'var(--text)';
      b.style.fontWeight = wybrany ? '600' : '400';
    });
  };
  box.querySelectorAll('button').forEach((b) => {
    b.onclick = () => { _ustawMotyw(b.dataset.motyw); zaznacz(); };
  });
  zaznacz();
}

window.addEventListener('DOMContentLoaded', _odswiezPasekStatusu);

function _showProfileModal() {
  const current = (window._currentUser || {}).display_name || '';
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:9999;';
  overlay.innerHTML = `
    <div style="background:var(--surface);border-radius:12px;padding:28px;width:300px;box-shadow:0 8px 32px rgba(0,0,0,.2)">
      <h3 style="margin-bottom:16px;font-size:1.1rem;color:var(--text)">Twój pseudonim</h3>
      <input id="_mn" type="text" value="${current}" maxlength="30" placeholder="np. Adam, Ola, Mama"
        style="width:100%;padding:10px 12px;border:1px solid #dadce0;border-radius:8px;font-size:0.95rem;margin-bottom:12px;box-sizing:border-box;outline:none">
      <div style="display:flex;gap:8px">
        <button id="_ms" style="flex:1;padding:10px;background:var(--primary);color:var(--on-primary);border:none;border-radius:8px;cursor:pointer;font-size:0.9rem;font-weight:500">Zapisz</button>
        <button id="_mc" style="flex:1;padding:10px;background:var(--surface);color:var(--text);border:none;border-radius:8px;cursor:pointer;font-size:0.9rem">Anuluj</button>
      </div>
      <div id="_me" style="color:var(--danger);font-size:0.8rem;margin-top:8px;display:none"></div>
      <div style="border-top:1px solid var(--border);margin-top:16px;padding-top:12px">
        <div style="font-size:0.78rem;color:var(--muted);margin-bottom:7px">Wygląd</div>
        <div id="_mtheme" style="display:flex;gap:6px">
          <button data-motyw="auto" style="flex:1;padding:7px;border:1px solid var(--border);border-radius:7px;background:var(--surface);color:var(--text);cursor:pointer;font-size:0.8rem">Auto</button>
          <button data-motyw="jasny" style="flex:1;padding:7px;border:1px solid var(--border);border-radius:7px;background:var(--surface);color:var(--text);cursor:pointer;font-size:0.8rem">Jasny</button>
          <button data-motyw="ciemny" style="flex:1;padding:7px;border:1px solid var(--border);border-radius:7px;background:var(--surface);color:var(--text);cursor:pointer;font-size:0.8rem">Ciemny</button>
        </div>
      </div>
      <div style="border-top:1px solid var(--border);margin-top:16px;padding-top:12px;display:flex;flex-direction:column;gap:8px">
        <button id="_mleave" style="width:100%;padding:9px;background:var(--surface);color:var(--warn);border:1px solid #e8c07d;border-radius:8px;cursor:pointer;font-size:0.85rem">Wypisz się z gospodarstwa</button>
        <button id="_mdel" style="width:100%;padding:9px;background:var(--surface);color:var(--danger);border:1px solid #e6b0aa;border-radius:8px;cursor:pointer;font-size:0.85rem">Usuń moje konto</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  _podepnijMotyw(overlay);
  overlay.querySelector('#_mn').focus();
  overlay.querySelector('#_mc').onclick = () => overlay.remove();
  overlay.querySelector('#_mleave').onclick = async () => {
    let ilu = 0, nazwa = '';
    try {
      const h = await (await authFetch('/api/household')).json();
      ilu = (h.members || []).length;
      nazwa = h.name || '';
    } catch { alert('Nie udało się sprawdzić gospodarstwa.'); return; }

    const ostatni = ilu <= 1;
    const wstep = ostatni
      ? `Jesteś ostatnią osobą w gospodarstwie „${nazwa}". Po wyjściu nikt nie będzie miał dostępu do jego danych — wydatków, wpływów, kont i celów.\n\nDane poczekają 30 dni, po czym zostaną usunięte bezpowrotnie. Zanim wyjdziesz, pobierz kopię z menu „⋯" na dashboardzie („Pobierz kopię danych").\n\nWypisać się?`
      : `Wypisać się z gospodarstwa „${nazwa}"? Twoje konto zostanie — od razu będziesz mógł założyć własne gospodarstwo na tym samym mailu.\n\nWspólne dane zostają u pozostałych osób, a Twoje wydatki dalej będą podpisane Twoim pseudonimem.`;
    if (!confirm(wstep)) return;

    // domyślnie 30 dni karencji; natychmiastowe kasowanie tylko na wyraźne żądanie
    let natychmiast = false;
    if (ostatni) {
      natychmiast = confirm(
        'Usunąć dane OD RAZU, bez czekania 30 dni?\n\n' +
        'OK — kasuję teraz, nieodwracalnie.\n' +
        'Anuluj — zostawiam 30 dni na rozmyślenie się (zalecane).'
      );
      if (natychmiast && !confirm('Na pewno? Tej operacji nie da się cofnąć.')) return;
    }

    try {
      const res = await authFetch('/api/me/leave-household', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ natychmiast }),
      });
      if (!res.ok) { const e = await res.json().catch(() => ({})); alert(e.detail || 'Nie udało się wypisać.'); return; }
      window.location.href = '/onboarding';
    } catch { alert('Błąd połączenia.'); }
  };

  overlay.querySelector('#_mdel').onclick = async () => {
    if (!confirm('Usunąć Twoje konto? Stracisz dostęp do aplikacji (logowanie). Twoje wydatki ZOSTANĄ w gospodarstwie — staniesz się „osobą bez konta", więc dla pozostałych nic nie znika. Tej operacji nie da się cofnąć.')) return;
    try {
      const res = await authFetch('/api/me', { method: 'DELETE' });
      if (!res.ok) { const e = await res.json().catch(() => ({})); alert(e.detail || 'Nie udało się usunąć konta.'); return; }
      await _auth.signOut();
      window.location.href = '/login';
    } catch { alert('Błąd połączenia.'); }
  };
  overlay.querySelector('#_ms').onclick = async () => {
    const val = overlay.querySelector('#_mn').value.trim();
    if (!val) return;
    try {
      const res = await authFetch('/api/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ display_name: val }),
      });
      if (res.ok) { overlay.remove(); location.reload(); }
      else {
        const e = await res.json();
        const err = overlay.querySelector('#_me');
        err.textContent = e.detail; err.style.display = 'block';
      }
    } catch {
      const err = overlay.querySelector('#_me');
      err.textContent = 'Błąd połączenia'; err.style.display = 'block';
    }
  };
}

const _ADMIN_EMAILS = ['a.folwarsk@gmail.com'];

function authIsAdmin(me) {
  return me && _ADMIN_EMAILS.includes(me.email);
}
window.authIsAdmin = authIsAdmin;

function _injectProfileButton(me) {
  const nav = document.querySelector('nav');
  if (!nav) return;

  // Wszystko po prawej trafia do jednej grupy. Wcześniej każdy element
  // wstawiał się przed nav.querySelector('button') — a po dodaniu „❓" to on
  // stawał się pierwszym przyciskiem, więc kolejność wychodziła przypadkowa
  // i pseudonim lądował daleko od „Wyloguj".
  const wyloguj = nav.querySelector('button');
  const grupa = document.createElement('div');
  grupa.className = 'nav-prawa';
  nav.appendChild(grupa);

  if (_ADMIN_EMAILS.includes(me.email)) {
    const adminLink = document.createElement('a');
    adminLink.href = '/admin';
    adminLink.textContent = 'Admin';
    adminLink.style.cssText = 'font-size:0.85rem;color:var(--muted);';
    grupa.appendChild(adminLink);
  }

  // „❓" czytało się jak pomoc techniczna — to jest samouczek, więc mówimy
  // to wprost. Na wąskim ekranie zostaje sama książka (patrz .nav-etykieta).
  const help = document.createElement('button');
  help.className = 'nav-samouczek';
  help.innerHTML = ikonaSvg('ksiazka') + '<span class="nav-etykieta">Samouczek</span>';
  help.title = 'Samouczek — jak korzystać z aplikacji';
  help.onclick = () => pokazSamouczek(false);
  grupa.appendChild(help);

  const btn = document.createElement('button');
  btn.id = 'nav-profile-btn';
  btn.textContent = me.display_name || me.name.split(' ')[0];
  btn.title = 'Zmień pseudonim';
  btn.style.cssText = 'padding:6px 14px;cursor:pointer;border:1px solid var(--accent);border-radius:6px;background:var(--surface);color:var(--accent);font-size:0.85rem;font-weight:500;';
  btn.onclick = _showProfileModal;
  grupa.appendChild(btn);

  if (wyloguj) {
    wyloguj.style.marginLeft = '';   // odsuwanie robi teraz grupa
    grupa.appendChild(wyloguj);
  }
}

const _SAMOUCZEK_SLAJDY = [
  { znak: true, tytul: 'Witaj w <span class="logo">w<span class="lg-i">ı<i class="lg-kropka"></i></span>em<i class="lg-kropka"></i></span>',
    opis: 'To wspólny budżet całego gospodarstwa: dodajesz wydatki (zdjęciem paragonu, notatką albo ręcznie), a apka pokazuje statystyki, pilnuje płatności i podpowiada, gdzie oszczędzić. Ten przewodnik przejdzie przez wszystkie funkcje — wrócisz do niego kiedy chcesz przyciskiem „Samouczek" na górnym pasku.' },
  { ikona: 'aparat', tytul: 'Paragon = zdjęcie',
    opis: 'W „Dodaj wydatek" zrób zdjęcie paragonu — Claude AI sam odczyta sklep, datę, wszystkie pozycje z cenami i przypisze kategorie. Możesz wrzucić kilka paragonów naraz: każdy stanie się osobnym wydatkiem. Przed zapisem wszystko sprawdzisz i poprawisz.' },
  { ikona: 'recznie', tytul: 'Nie chcesz AI? Wpisz ręcznie',
    opis: 'W „Dodaj wydatek" jest zakładka „Ręcznie (bez AI)" — wpisujesz wydatek sam, bez wysyłania do Claude i bez kosztów. Jest też „Notatka tekstowa": wypisujesz wydatki listą, a AI rozbije je na osobne wpisy. Wybierasz to, co Ci pasuje.' },
  { ikona: 'pulpit', tytul: 'Dashboard — wszystko na oku',
    opis: 'Filtruj po miesiącu, osobie i kategorii (albo po dowolnym zakresie dat). Kliknij segment wykresu kołowego, żeby zejść do podkategorii, a potem do konkretnych produktów. Wykres trendów przełączysz na „Osobno / Łącznie", a każdy wydatek rozwiniesz do pozycji.' },
  { ikona: 'lupa', tytul: 'Wyszukiwarka i ceny produktów',
    opis: 'Pole 🔍 na dashboardzie przeszukuje CAŁĄ historię — produkt, sklep, notatkę („ile wydaliśmy na kawę?"). Po wyszukaniu produktu kliknij „📈 Pokaż zmiany cen": zobaczysz gdzie kupujesz taniej i jak cena rosła w czasie.' },
  { ikona: 'kategorie', tytul: 'Kategorie po Twojemu',
    opis: 'W „Kategorie" ułożysz własną hierarchię kategorii i podkategorii. Przy wydatku możesz dodać „okazję" (np. urodziny) — taki zakup nie zaburzy statystyk Waszych zwykłych nawyków. „Kontekst kategorii" wrzuci cały paragon do jednej kategorii (np. całą imprezę do Rozrywki).' },
  { ikona: 'konta', tytul: 'Konta i salda',
    opis: 'W „Konta" prowadzisz konta (bank, gotówka, oszczędności) z aktualnymi saldami. Robisz przelewy między nimi, a inwentaryzacją (spisem rzeczywistego stanu) pilnujesz, czy wszystko się zgadza. Przypisując wydatek do konta, saldo liczy się samo.' },
  { ikona: 'wplywy', tytul: 'Wpływy i płatności cykliczne',
    opis: 'Dodawaj wpływy (np. pensję), żeby bilans był pełny. Subskrypcje, rachunki i raty ustaw jako wydatki cykliczne — naliczą się automatycznie (z limitem naliczeń albo datą końca). Cykliczny przelew na oszczędności też ustawisz w Kontach.' },
  { ikona: 'alerty', tytul: 'Przypomnienia o płatnościach',
    opis: 'O ręcznych przelewach apka przypomni z wyprzedzeniem — po zrobieniu klikasz „✓ Zrobione". Przy automatycznych obciążeniach dostaniesz znać, żeby zapewnić środki. Całe archiwum jest w „Powiadomieniach", a pojedyncze przypomnienie schowasz ✕ na bieżącą sesję.' },
  { ikona: 'robot', tytul: 'Doradca budżetowy AI',
    opis: 'W „Analiza" Claude przeanalizuje Wasze wydatki i wskaże konkretnie, gdzie da się zaoszczędzić — z kwotami. Odpowiadaj na jego pytania: buduje profil gospodarstwa i z każdą analizą zna Was lepiej. Raporty zapisują się w historii.' },
  { ikona: 'lista', tytul: 'Listy zakupów na żywo',
    opis: 'W „Lista" tworzysz wiele nazwanych list (np. „Biedronka", „Leroy"). Są wspólne i synchronizują się NA ŻYWO — jak odhaczysz mleko, druga osoba w sklepie od razu to widzi. Tap = kupione, przeciągnij za ⠿ = kolejność (np. wg alejek), a listę wstrzymasz, zamkniesz lub usuniesz.' },
  { ikona: 'osoby', tytul: 'Wspólne gospodarstwo',
    opis: 'Zaproś drugą osobę do gospodarstwa linkiem (menu „⋯” na dashboardzie, pozycja „Zaproś osobę”) — budżet prowadzicie razem. Kogoś bez konta Google (np. dziecko) dodasz jako „osobę bez konta". Każdy może też usunąć własne konto — jego wydatki zostają, bo należą do gospodarstwa.' },
  { ikona: 'dysk', tytul: 'Twoje dane są bezpieczne',
    opis: 'Cały budżet pobierzesz w każdej chwili z menu „⋯" na dashboardzie — pozycja „Pobierz kopię danych". Statystyki, filtry i pseudonimy dostosujesz pod siebie — kliknij swój pseudonim na górnym pasku, żeby go zmienić.' },
  { ikona: 'telefon', tytul: 'Miej budżet w kieszeni',
    opis: 'Na telefonie wybierz w przeglądarce „Dodaj do ekranu głównego" — apka działa jak natywna: dolny pasek nawigacji i aparat do paragonów zawsze pod ręką. To wszystko — miłego oszczędzania! 🎉' },
];

function pokazSamouczek(pierwszyRaz) {
  let idx = 0;
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(15,20,40,.55);display:flex;align-items:center;justify-content:center;z-index:9999;padding:16px;';
  const zamknij = () => {
    overlay.remove();
    if (pierwszyRaz) authFetch('/api/me/samouczek', { method: 'POST' }).catch(() => {});
  };
  overlay.addEventListener('click', e => { if (e.target === overlay) zamknij(); });
  const render = () => {
    const s = _SAMOUCZEK_SLAJDY[idx];
    const ostatni = idx === _SAMOUCZEK_SLAJDY.length - 1;
    overlay.innerHTML = `
      <div class="sam-karta">
        <div class="sam-naglowek" style="--kat:${130 + idx * 7}deg"><span class="sam-emoji">${s.znak ? '<span class="sam-znak"><span class="logo">w<span class="lg-i">ı<i class="lg-kropka"></i></span>em<i class="lg-kropka"></i></span></span>' : ikonaSvg(s.ikona)}</span></div>
        <div style="padding:22px 26px 18px">
          <h3 style="font-size:1.15rem;margin:0 0 8px;color:var(--text)">${s.tytul}</h3>
          <p style="font-size:14px;line-height:1.6;color:var(--text);margin:0 0 16px">${s.opis}</p>
          <div style="display:flex;flex-wrap:wrap;justify-content:center;gap:6px;margin-bottom:14px">
            ${_SAMOUCZEK_SLAJDY.map((_, i) => `<span class="sam-kropka${i === idx ? ' jest' : ''}"></span>`).join('')}
          </div>
          <div style="display:flex;gap:8px;align-items:center">
            <button data-t="pomin" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:13px;padding:8px 4px">Pomiń</button>
            <span style="flex:1"></span>
            ${idx > 0 ? '<button data-t="wstecz" style="background:var(--surface-3);border:none;border-radius:8px;padding:10px 18px;cursor:pointer;font-size:14px;color:var(--text)">Wstecz</button>' : ''}
            <button data-t="dalej" style="background:var(--primary);border:none;border-radius:8px;padding:10px 22px;cursor:pointer;font-size:14px;color:var(--on-primary);font-weight:600">${ostatni ? 'Zaczynamy! 🎉' : 'Dalej'}</button>
          </div>
        </div>
      </div>`;
    overlay.querySelector('[data-t="pomin"]').onclick = zamknij;
    const w = overlay.querySelector('[data-t="wstecz"]');
    if (w) w.onclick = () => { idx--; render(); };
    overlay.querySelector('[data-t="dalej"]').onclick = () => { if (ostatni) zamknij(); else { idx++; render(); } };
  };
  render();
  document.body.appendChild(overlay);
}
window.pokazSamouczek = pokazSamouczek;

const IKONY_SVG = {
  pulpit: '<rect x="3" y="12" width="4.5" height="8" rx="1.4"/><rect x="9.7" y="7" width="4.5" height="13" rx="1.4"/><rect x="16.4" y="10" width="4.5" height="10" rx="1.4"/><circle class="kropka" cx="18.65" cy="5.4" r="1.9"/>',
  dodaj: '<circle cx="12" cy="12" r="8.6"/><path class="akc" d="M12 8.2v7.6M8.2 12h7.6"/>',
  lista: '<path d="M4.5 6.5h15M4.5 12h15M4.5 17.5h9"/><circle class="kropka" cx="18.6" cy="17.5" r="1.9"/>',
  konta: '<rect x="2.8" y="5.5" width="18.4" height="13" rx="2.4"/><path d="M2.8 10h18.4"/><circle class="kropka" cx="17.4" cy="14.6" r="1.7"/>',
  wplywy: '<circle cx="12" cy="12" r="8.6"/><path class="akc" d="M12 7.6v8.8M9.2 13.6l2.8 2.8 2.8-2.8"/>',
  cele: '<circle cx="12" cy="12" r="8.6"/><circle cx="12" cy="12" r="4.4"/><circle class="kropka" cx="12" cy="12" r="1.9"/>',
  kategorie: '<path d="M11.2 3.4H20v8.8l-8.8 8.4L3 12z"/><circle class="kropka" cx="16.1" cy="7.6" r="1.7"/>',
  analiza: '<path d="M3.4 3.6v17h17"/><path d="M6.6 16.4l4.4-5 3.9 3.3 4.3-5.9"/><circle class="kropka" cx="18.6" cy="8.4" r="1.9"/>',
  alerty: '<path d="M6.2 10.4a5.8 5.8 0 0111.6 0c0 4.2 1.6 5.6 1.6 5.6H4.6s1.6-1.4 1.6-5.6z"/><circle class="kropka" cx="12" cy="19.2" r="1.9"/>',
  admin: '<path d="M4 7.5h16M4 12h16M4 16.5h16"/><circle class="kropka" cx="9" cy="7.5" r="2"/><circle class="kropka" cx="15.6" cy="16.5" r="2"/>',
  osoby: '<circle cx="9.2" cy="8.4" r="3.4"/><path d="M3.4 19.4c0-3.2 2.6-5.4 5.8-5.4s5.8 2.2 5.8 5.4"/><path d="M16.6 6.2a3.2 3.2 0 010 6.2M17.6 14.6c2.1.6 3.4 2.4 3.4 4.8"/>',
  osoba_plus: '<circle cx="10" cy="8.4" r="3.4"/><path d="M4.2 19.4c0-3.2 2.6-5.4 5.8-5.4 1 0 2 .2 2.8.6"/><path class="akc" d="M17.6 13.4v6.2M14.5 16.5h6.2"/>',
  pobierz: '<path class="akc" d="M12 3.6v10.2M8.4 10.6l3.6 3.6 3.6-3.6"/><path d="M4.2 16.4v2.2a1.8 1.8 0 001.8 1.8h12a1.8 1.8 0 001.8-1.8v-2.2"/>',
  wczytaj: '<path class="akc" d="M12 14.2V4M8.4 7.2L12 3.6l3.6 3.6"/><path d="M4.2 16.4v2.2a1.8 1.8 0 001.8 1.8h12a1.8 1.8 0 001.8-1.8v-2.2"/>',
  telefon: '<rect x="6.6" y="2.6" width="10.8" height="18.8" rx="2.4"/><circle class="kropka" cx="12" cy="18.2" r="1.5"/>',
  przelicz: '<path d="M20 12a8 8 0 01-13.7 5.6M4 12a8 8 0 0113.7-5.6"/><path d="M4 6.4V12h5.6M20 17.6V12h-5.6"/><circle class="kropka" cx="12" cy="12" r="1.7"/>',
  powitanie: '<path d="M12 20.6a8.6 8.6 0 100-17.2 8.6 8.6 0 000 17.2z"/><path d="M8.4 14.2a4.6 4.6 0 007.2 0"/><circle class="kropka" cx="9" cy="9.8" r="1.4"/><circle class="kropka" cx="15" cy="9.8" r="1.4"/>',
  aparat: '<path d="M3.4 8.4a2 2 0 012-2h2.2l1.4-2.2h5.6l1.4 2.2h2.6a2 2 0 012 2v9.2a2 2 0 01-2 2H5.4a2 2 0 01-2-2z"/><circle cx="12" cy="12.6" r="3.8"/><circle class="kropka" cx="12" cy="12.6" r="1.4"/>',
  recznie: '<path d="M4 20l1.2-4.2L15.6 5.4a2.2 2.2 0 013.1 3.1L8.2 18.8z"/><path d="M14 7l3 3"/><circle class="kropka" cx="5.2" cy="18.8" r="1.5"/>',
  lupa: '<circle cx="10.8" cy="10.8" r="6.6"/><path d="M15.6 15.6l4.6 4.6"/><circle class="kropka" cx="10.8" cy="10.8" r="1.8"/>',
  robot: '<rect x="4" y="8" width="16" height="11.6" rx="2.6"/><path d="M12 8V4.6"/><circle class="kropka" cx="12" cy="3.4" r="1.5"/><circle class="kropka" cx="9" cy="13.4" r="1.5"/><circle class="kropka" cx="15" cy="13.4" r="1.5"/>',
  dysk: '<rect x="3.4" y="3.4" width="17.2" height="17.2" rx="2.4"/><path d="M7.6 3.4v6h8.8v-6"/><rect x="7.6" y="13" width="8.8" height="7.6" rx="1.2"/><circle class="kropka" cx="14.6" cy="6.2" r="1.3"/>',
  ksiazka: '<path d="M3.6 5.2A2 2 0 015.6 3.4H11v16.4H5.6a2 2 0 01-2-2z"/><path d="M20.4 5.2a2 2 0 00-2-1.8H13v16.4h5.4a2 2 0 002-2z"/><circle class="kropka" cx="12" cy="12" r="1.5"/>',
  limit: '<path d="M12 3.4v3M12 17.6v3M3.4 12h3M17.6 12h3"/><circle cx="12" cy="12" r="5.6"/><path class="akc" d="M12 9.2v3.4l2.4 1.4"/>',
  przeplyw: '<path d="M3 8.4c2.6-2.4 5.2-2.4 7.8 0s5.2 2.4 7.8 0"/><path d="M3 13.2c2.6-2.4 5.2-2.4 7.8 0s5.2 2.4 7.8 0"/><path class="akc" d="M3 18c2.6-2.4 5.2-2.4 7.8 0s5.2 2.4 7.8 0"/>',
  osiagniete: '<path d="M5.4 20.6V3.6"/><path d="M5.4 4.6h12.2l-2.4 3.8 2.4 3.8H5.4"/><circle class="kropka" cx="5.4" cy="20.6" r="1.6"/>',
};

// Wersje pelne — tylko do dolnego paska. Przy 23 px cienka kreska jest
// zbyt watla, a paska oglada sie w ruchu.
const IKONY_PELNE = {
  pulpit: '<rect x="3" y="12" width="4.5" height="8" rx="1.4"/><rect x="9.7" y="7" width="4.5" height="13" rx="1.4"/><rect x="16.4" y="10" width="4.5" height="10" rx="1.4"/><circle class="kropka" cx="18.65" cy="5.4" r="2.1"/>',
  dodaj: '<circle cx="12" cy="12" r="9"/><path class="pusto" d="M11 7.4h2v9.2h-2z"/><path class="pusto" d="M7.4 11h9.2v2H7.4z"/>',
  lista: '<rect x="4" y="5.4" width="16" height="2.2" rx="1.1"/><rect x="4" y="10.9" width="16" height="2.2" rx="1.1"/><rect x="4" y="16.4" width="9" height="2.2" rx="1.1"/><circle class="kropka" cx="18.4" cy="17.5" r="2.1"/>',
  konta: '<rect x="2.8" y="5.5" width="18.4" height="13" rx="2.4"/><rect class="pusto" x="2.8" y="9.2" width="18.4" height="2.1"/><circle class="kropka" cx="17.4" cy="14.8" r="1.9"/>',
  wplywy: '<circle cx="12" cy="12" r="9"/><path class="pusto" d="M11 7h2v6.6h-2z"/><path class="pusto" d="M12 17.4l-3.6-3.8h7.2z"/>',
  cele: '<circle cx="12" cy="12" r="9"/><circle class="pusto" cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="3.9"/><circle class="pusto" cx="12" cy="12" r="2.1"/><circle class="kropka" cx="12" cy="12" r="2.1"/>',
  kategorie: '<path d="M11.2 3.2H20.4v9.2l-9.2 8.8L2.6 12.4z"/><circle class="pusto" cx="16.3" cy="7.5" r="2.4"/><circle class="kropka" cx="16.3" cy="7.5" r="1.7"/>',
  analiza: '<path d="M3 19h18v2H3zM3 3h2v18H3z"/><path d="M6.6 15.4l4.4-5 3.9 3.3 4.3-5.7 1.6 1.2-5.6 7.4-4-3.4-3 3.4z"/><circle class="kropka" cx="18.6" cy="8" r="2.3"/>',
  alerty: '<path d="M12 3.2a6 6 0 016 6c0 4.4 1.7 5.9 1.7 5.9H4.3s1.7-1.5 1.7-5.9a6 6 0 016-6z"/><circle class="kropka" cx="12" cy="19" r="2.2"/>',
  admin: '<rect x="3.6" y="6.2" width="16.8" height="2.4" rx="1.2"/><rect x="3.6" y="15.4" width="16.8" height="2.4" rx="1.2"/><circle class="kropka" cx="9" cy="7.4" r="2.4"/><circle class="kropka" cx="15.6" cy="16.6" r="2.4"/>',
};

function ikonaPelna(nazwa) {
  return `<span class="ikona pelna"><svg viewBox="0 0 24 24" aria-hidden="true">${IKONY_PELNE[nazwa] || IKONY_SVG[nazwa] || ''}</svg></span>`;
}

function ikonaSvg(nazwa) {
  return `<span class="ikona"><svg viewBox="0 0 24 24" aria-hidden="true">${IKONY_SVG[nazwa] || ''}</svg></span>`;
}

const _BOTTOM_NAV_ITEMS = [
  { href: '/',              ikona: 'pulpit',    label: 'Pulpit' },
  { href: '/upload',        ikona: 'dodaj',     label: 'Dodaj' },
  { href: '/lista',         ikona: 'lista',     label: 'Lista' },
  { href: '/konta',         ikona: 'konta',     label: 'Konta' },
  { href: '/wplywy',        ikona: 'wplywy',    label: 'Wpływy' },
  { href: '/cele',          ikona: 'cele',      label: 'Cele' },
  { href: '/kategorie',     ikona: 'kategorie', label: 'Kategorie' },
  { href: '/analiza',       ikona: 'analiza',   label: 'Analiza' },
  { href: '/powiadomienia', ikona: 'alerty',    label: 'Alerty' },
];


function _injectBottomNav(me) {
  if (!document.querySelector('nav') || document.querySelector('.bottom-nav')) return;
  const items = [..._BOTTOM_NAV_ITEMS];
  if (me && authIsAdmin(me)) items.push({ href: '/admin', ikona: 'admin', label: 'Admin' });
  const bar = document.createElement('div');
  bar.className = 'bottom-nav';
  bar.innerHTML = items.map(i => `
    <a href="${i.href}" class="${location.pathname === i.href ? 'active' : ''}">
      ${ikonaPelna(i.ikona)}${i.label}
    </a>`).join('');
  document.body.appendChild(bar);
  // dosuń aktywną ikonę do widoku (pasek jest przewijany w poziomie)
  const act = bar.querySelector('a.active');
  if (act && act.scrollIntoView) act.scrollIntoView({ inline: 'center', block: 'nearest' });
}

// ── Wskazówki kontekstowe (różne per zakładka) ──
const _TIPS_OGOLNE = [
  'Samouczek jest zawsze pod przyciskiem „Samouczek" na górnym pasku — wrócisz do niego kiedy chcesz.',
  'Na telefonie wybierz „Dodaj do ekranu głównego" — apka działa jak natywna, z dolnym paskiem i aparatem.',
  'Kliknij swój pseudonim na górnym pasku, żeby go zmienić.',
  'Budżet prowadzicie wspólnie — zaproś drugą osobę przez menu „⋯" na dashboardzie, pozycja „Zaproś osobę".',
  'Osobę bez konta Google (np. dziecko) dodasz jako „członka bez konta".',
  'Kopię całego budżetu pobierzesz z menu „⋯" na dashboardzie — to plik, który możesz zachować.',
];
const _TIPS_STRONY = {
  '/': [
    'Kliknij segment wykresu kategorii → zejdziesz do podkategorii, a potem do konkretnych produktów.',
    'Wyszukiwarka u góry przeszukuje całą historię — wpisz produkt, sklep albo fragment notatki.',
    'Po wyszukaniu produktu kliknij „📈 Pokaż zmiany cen" — zobaczysz gdzie taniej i jak cena rosła w czasie.',
    'Przełącznik Pierwotne / Kontekstowe zmienia sposób liczenia kategorii dla wydatków z okazji.',
    'Filtruj po miesiącu, osobie i kategorii — jest też tryb dowolnego zakresu dat.',
    'Wykres trendów miesięcznych przełączysz między „Osobno" (per osoba) a „Łącznie".',
    'Przypomnienie o płatności możesz zamknąć ✕ na tę sesję — wróci następnym razem, aż je zrobisz.',
    '„Top sklepy" pokazują, gdzie zostawiacie najwięcej pieniędzy.',
  ],
  '/upload': [
    'Zrób zdjęcie paragonu — Claude odczyta sklep, pozycje, ceny i sam przypisze kategorie.',
    'Możesz wrzucić kilka zdjęć naraz — każde stanie się osobnym wydatkiem.',
    'Nie masz paragonu? Wpisz wydatki zwykłą notatką w drugiej zakładce.',
    'Zanim zapiszesz, wszystko poprawisz — pozycje, ceny, ilości i kategorie.',
    'Ustaw „okazję" (np. urodziny) — taki wydatek nie zaburzy statystyk Waszych zwykłych nawyków.',
    '„Kontekst kategorii" wrzuci cały paragon do jednej kategorii (np. całą imprezę do Rozrywki).',
    'Przypisz paragon do konta, żeby saldo tego konta samo się zgadzało.',
  ],
  '/lista': [
    'Tapnięcie na produkcie oznacza go jako kupiony i przenosi do koszyka na dole.',
    'Przeciągnij produkt za uchwyt ⠿, żeby ustawić kolejność — np. wg alejek w Twoim sklepie.',
    'Lista jest wspólna i działa na żywo — druga osoba widzi Twoje zmiany od razu.',
    'Po zakupach kliknij „Usuń kupione", żeby jednym ruchem wyczyścić koszyk.',
    'Zielona kropka = połączenie na żywo. Żółta = łączę ponownie (np. po słabym zasięgu).',
  ],
  '/konta': [
    'Dodaj konta (bank, gotówka, oszczędności) i miej salda zawsze pod ręką.',
    'Subskrypcje i raty ustaw jako wydatki cykliczne — naliczą się same.',
    'Cykliczny przelew na konto oszczędnościowe też ustawisz tutaj (Rodzaj: przelew).',
    'Przelewy między kontami i inwentaryzacje (spis rzeczywistego stanu) robisz na tej stronie.',
    'Dodawaj wpływy (np. pensję), żeby bilans gospodarstwa był pełny.',
    'Wpływ albo przelew edytujesz ikonką ✏ w historii konta — bez usuwania i dodawania od nowa.',
  ],
  '/kategorie': [
    'Dopasuj kategorie i podkategorie do swojego gospodarstwa — apka nie narzuca Ci sztywnej listy.',
    'Zmiany w kategoriach od razu wpływają na wykresy, filtry i analizy.',
  ],
  '/analiza': [
    'Doradca AI przeanalizuje Wasze wydatki i wskaże, gdzie realnie da się zaoszczędzić — z kwotami.',
    'Odpowiadaj na pytania doradcy — buduje profil gospodarstwa i z każdą analizą zna Was lepiej.',
    'Zapisane raporty znajdziesz w historii analiz — możesz wrócić do wcześniejszych wniosków.',
  ],
  '/powiadomienia': [
    'To jest archiwum płatności — potwierdzone ręczne przelewy i automatyczne naliczenia.',
    'Po zrobieniu ręcznego przelewu klikaj „✓ Zrobione", żeby zszedł z aktywnych.',
  ],
};

function _injectTip(me) {
  // stan wskazówek trzymany PER UŻYTKOWNIK — to, że jedna osoba je wyłączyła/widziała,
  // nie zabiera ich drugiej (nawet na współdzielonej przeglądarce)
  const uid = (me && me.user_id) ? me.user_id : 'x';
  const kOff = 'tipsOff_' + uid, kIdx = 'tipIdx_' + uid, kSes = 'tipShown_' + uid;
  if (localStorage.getItem(kOff) === '1') return;
  if (sessionStorage.getItem(kSes) === '1') return;  // najwyżej jedna wskazówka na sesję — nie nachalnie
  const main = document.querySelector('main');
  if (!main) return;
  sessionStorage.setItem(kSes, '1');
  const pula = [...(_TIPS_STRONY[location.pathname] || []), ..._TIPS_OGOLNE];
  if (!pula.length) return;
  const i = parseInt(localStorage.getItem(kIdx) || '0', 10) || 0;
  localStorage.setItem(kIdx, String(i + 1));
  const tekst = pula[i % pula.length];
  const el = document.createElement('div');
  el.id = 'tip-dnia';
  el.style.cssText = 'margin-bottom:14px';
  el.innerHTML = `<div style="display:flex;align-items:center;gap:10px;background:var(--surface-3);border:1px solid #d5e5fb;color:#2c5aa0;border-radius:10px;padding:9px 14px;font-size:13.5px">
      <span>💡 ${tekst}</span><span style="flex:1"></span>
      <button onclick="localStorage.setItem('${kOff}','1');this.closest('#tip-dnia').remove()" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:12px;white-space:nowrap">nie pokazuj więcej</button>
      <button onclick="this.closest('#tip-dnia').remove()" style="background:none;border:none;color:#2c5aa0;cursor:pointer;font-size:16px;line-height:1;padding:0 2px">✕</button>
    </div>`;
  main.insertBefore(el, main.firstChild);
}

async function authRequireHousehold() {
  return new Promise((resolve, reject) => {
    _auth.onAuthStateChanged(async (user) => {
      if (!user) {
        window.location.href = "/login";
        return reject();
      }
      try {
        const token = await user.getIdToken();
        const res = await fetch("/api/me", {
          headers: { Authorization: "Bearer " + token },
        });
        if (res.status === 403) {
          const d = await res.json().catch(() => ({}));
          document.body.innerHTML = `<div style="max-width:420px;margin:80px auto;padding:0 20px;text-align:center;font-family:system-ui">
            <div style="font-size:44px;margin-bottom:12px">🚫</div>
            <h2 style="margin:0 0 8px;color:var(--text)">Konto zawieszone</h2>
            <p style="color:var(--text);line-height:1.5">${d.detail || 'Twoje konto zostało zawieszone przez administratora.'}</p>
            <button onclick="authLogout()" style="margin-top:18px;padding:9px 18px;border:1px solid var(--border);border-radius:8px;background:var(--surface);cursor:pointer">Wyloguj</button>
          </div>`;
          return reject();
        }
        if (!res.ok) { window.location.href = "/login"; return reject(); }
        const me = await res.json();
        if (!me.household_id) {
          window.location.href = "/onboarding";
          return reject();
        }
        window._currentUser = me;
        _injectProfileButton(me);
        _injectBottomNav(me);
        _injectTip(me);
        if (me.samouczek === false) setTimeout(() => pokazSamouczek(true), 600);
        resolve(me);
      } catch {
        window.location.href = "/login";
        reject();
      }
    });
  });
}

// widoczny stan "Claude pracuje" z rotującymi komunikatami kroków;
// zwraca funkcję stop() czyszczącą interwał
function aiPracaStart(el, tytul, kroki, czasInfo) {
  let i = 0;
  el.innerHTML = `<div class="ai-praca">
      <div class="ai-spinner"></div>
      <div class="ai-tytul">${tytul}</div>
      <div class="ai-krok">${kroki[0]}</div>
      ${czasInfo ? `<div class="ai-czas">⏱ ${czasInfo}</div>` : ''}
    </div>`;
  const krokEl = el.querySelector('.ai-krok');
  const t = setInterval(() => {
    i = (i + 1) % kroki.length;
    krokEl.style.opacity = 0;
    setTimeout(() => { krokEl.textContent = kroki[i]; krokEl.style.opacity = 1; }, 250);
  }, 2800);
  if (el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  return () => clearInterval(t);
}
window.aiPracaStart = aiPracaStart;

async function authFetch(url, options = {}) {
  const token = await authGetToken();
  return fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: "Bearer " + token,
    },
  });
}

async function loadOsobaOptions(selectId, includeAll = false) {
  try {
    const data = await authFetch('/api/household').then(r => r.json());
    const sel = document.getElementById(selectId);
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = '';
    if (includeAll) sel.appendChild(new Option('Oboje', ''));
    (data.members || []).forEach(m => {
      const label = m.display_name || m.name.split(' ')[0];
      sel.appendChild(new Option(label, label));
    });
    (data.virtual_members || []).forEach(m => {
      const opt = new Option(m.name + ' *', m.name);
      sel.appendChild(opt);
    });
    if ([...sel.options].some(o => o.value === prev)) sel.value = prev;
  } catch {}
}

window.authGetToken = authGetToken;
window.authLogout = authLogout;
window.authRequireHousehold = authRequireHousehold;
window.authFetch = authFetch;
window.loadOsobaOptions = loadOsobaOptions;
