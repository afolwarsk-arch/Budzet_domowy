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

async function authGetToken() {
  const user = _auth.currentUser;
  if (!user) throw new Error("Nie zalogowany");
  return user.getIdToken();
}

async function authLogout() {
  await _auth.signOut();
  window.location.href = "/login";
}

function _showProfileModal() {
  const current = (window._currentUser || {}).display_name || '';
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:9999;';
  overlay.innerHTML = `
    <div style="background:white;border-radius:12px;padding:28px;width:300px;box-shadow:0 8px 32px rgba(0,0,0,.2)">
      <h3 style="margin-bottom:16px;font-size:1.1rem;color:#1a1a1a">Twój pseudonim</h3>
      <input id="_mn" type="text" value="${current}" maxlength="30" placeholder="np. Adam, Ola, Mama"
        style="width:100%;padding:10px 12px;border:1px solid #dadce0;border-radius:8px;font-size:0.95rem;margin-bottom:12px;box-sizing:border-box;outline:none">
      <div style="display:flex;gap:8px">
        <button id="_ms" style="flex:1;padding:10px;background:#4361ee;color:white;border:none;border-radius:8px;cursor:pointer;font-size:0.9rem;font-weight:500">Zapisz</button>
        <button id="_mc" style="flex:1;padding:10px;background:#f1f3f5;color:#333;border:none;border-radius:8px;cursor:pointer;font-size:0.9rem">Anuluj</button>
      </div>
      <div id="_me" style="color:#d32f2f;font-size:0.8rem;margin-top:8px;display:none"></div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#_mn').focus();
  overlay.querySelector('#_mc').onclick = () => overlay.remove();
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
  if (_ADMIN_EMAILS.includes(me.email)) {
    const adminLink = document.createElement('a');
    adminLink.href = '/admin';
    adminLink.textContent = 'Admin';
    adminLink.style.cssText = 'font-size:0.85rem;color:#888;';
    const logoutBtn = nav.querySelector('button');
    if (logoutBtn) nav.insertBefore(adminLink, logoutBtn);
    else nav.appendChild(adminLink);
  }
  const help = document.createElement('button');
  help.textContent = '❓';
  help.title = 'Samouczek — jak korzystać z aplikacji';
  help.style.cssText = 'padding:6px 10px;cursor:pointer;border:1px solid #ccc;border-radius:6px;background:white;font-size:0.85rem;';
  help.onclick = () => pokazSamouczek(false);
  const logoutBtn0 = nav.querySelector('button');
  if (logoutBtn0) nav.insertBefore(help, logoutBtn0);
  else nav.appendChild(help);

  const btn = document.createElement('button');
  btn.id = 'nav-profile-btn';
  btn.textContent = me.display_name || me.name.split(' ')[0];
  btn.title = 'Zmień pseudonim';
  btn.style.cssText = 'padding:6px 14px;cursor:pointer;border:1px solid #4361ee;border-radius:6px;background:white;color:#4361ee;font-size:0.85rem;font-weight:500;';
  btn.onclick = _showProfileModal;
  const logoutBtn = nav.querySelector('button');
  if (logoutBtn) nav.insertBefore(btn, logoutBtn);
  else nav.appendChild(btn);
}

const _SAMOUCZEK_SLAJDY = [
  { emoji: '👋', tytul: 'Witaj w Budżecie domowym!',
    opis: 'Wspólny budżet Waszego gospodarstwa: paragony, konta, analizy i doradca AI. Ten krótki przewodnik pokaże najważniejsze możliwości — wrócisz do niego w każdej chwili przyciskiem ❓ na górnym pasku.',
    obraz: '/static/tutorial/1-dashboard.png' },
  { emoji: '📷', tytul: 'Dodawaj wydatki zdjęciem paragonu',
    opis: 'Zakładka „Dodaj wydatek": zrób zdjęcie paragonu (można kilka naraz) — Claude odczyta sklep, pozycje, ceny i przypisze kategorie. Możesz też wpisać wydatki zwykłą notatką. Przed zapisem wszystko da się poprawić.',
    obraz: '/static/tutorial/2-upload.png' },
  { emoji: '📊', tytul: 'Dashboard — wszystko na oku',
    opis: 'Filtruj po miesiącu, osobie i kategorii. Kliknij segment wykresu, aby zejść do podkategorii i konkretnych produktów. W tabeli wydatków edytujesz i usuwasz wpisy.',
    obraz: '/static/tutorial/1-dashboard.png' },
  { emoji: '💳', tytul: 'Konta, wpływy i wydatki cykliczne',
    opis: 'Strona „Konta": salda, wpływy, przelewy między kontami i inwentaryzacje. Subskrypcje i raty ustaw jako wydatki cykliczne — naliczą się same. Cykliczny przelew na oszczędności też ustawisz tutaj.',
    obraz: '/static/tutorial/4-konta.png' },
  { emoji: '🔔', tytul: 'Przypomnienia o płatnościach',
    opis: 'O ręcznych przelewach apka przypomina z wyprzedzeniem — po zrobieniu przelewu klikasz „Zrobione". Przy automatycznych dostaniesz znać, żeby zapewnić środki na koncie. Archiwum znajdziesz w „Powiadomieniach".',
    obraz: '/static/tutorial/5-powiadomienia.png' },
  { emoji: '🤖', tytul: 'Doradca budżetowy AI',
    opis: 'Na stronie „Analiza" Claude przeanalizuje Wasze wydatki i wskaże, gdzie realnie można zaoszczędzić — z konkretnymi kwotami. Odpowiadaj na jego pytania: buduje profil gospodarstwa i z każdą analizą zna Was lepiej.',
    obraz: '/static/tutorial/6-doradca.png' },
  { emoji: '📱', tytul: 'Miej budżet w kieszeni',
    opis: 'Na telefonie wybierz w przeglądarce „Dodaj do ekranu głównego" — apka działa jak zwykła aplikacja: dolny pasek nawigacji i aparat do paragonów zawsze pod ręką. Miłego oszczędzania! 🎉',
    obraz: '/static/tutorial/7-mobile.png' },
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
      <div style="background:#fff;border-radius:18px;max-width:560px;width:100%;max-height:92vh;overflow-y:auto;box-shadow:0 12px 48px rgba(0,0,0,.3)">
        <img src="${s.obraz}" alt="" style="width:100%;display:block;border-radius:18px 18px 0 0;border-bottom:1px solid #e5e9f0" onerror="this.remove()">
        <div style="padding:20px 26px 18px">
          <div style="font-size:28px;margin-bottom:4px">${s.emoji}</div>
          <h3 style="font-size:1.15rem;margin:0 0 8px;color:#1a1f2e">${s.tytul}</h3>
          <p style="font-size:14px;line-height:1.55;color:#444;margin:0 0 16px">${s.opis}</p>
          <div style="display:flex;justify-content:center;gap:6px;margin-bottom:14px">
            ${_SAMOUCZEK_SLAJDY.map((_, i) => `<span style="width:8px;height:8px;border-radius:50%;background:${i === idx ? '#4f7ef8' : '#dde3f0'}"></span>`).join('')}
          </div>
          <div style="display:flex;gap:8px;align-items:center">
            <button data-t="pomin" style="background:none;border:none;color:#98a0b3;cursor:pointer;font-size:13px;padding:8px 4px">Pomiń</button>
            <span style="flex:1"></span>
            ${idx > 0 ? '<button data-t="wstecz" style="background:#f0f2f8;border:none;border-radius:8px;padding:10px 18px;cursor:pointer;font-size:14px;color:#444">Wstecz</button>' : ''}
            <button data-t="dalej" style="background:#4f7ef8;border:none;border-radius:8px;padding:10px 22px;cursor:pointer;font-size:14px;color:#fff;font-weight:600">${ostatni ? 'Zaczynamy! 🎉' : 'Dalej'}</button>
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

const _BOTTOM_NAV_ITEMS = [
  { href: '/',              icon: '📊', label: 'Pulpit' },
  { href: '/upload',        icon: '➕', label: 'Dodaj' },
  { href: '/konta',         icon: '💳', label: 'Konta' },
  { href: '/kategorie',     icon: '🏷️', label: 'Kategorie' },
  { href: '/analiza',       icon: '📈', label: 'Analiza' },
  { href: '/powiadomienia', icon: '🔔', label: 'Alerty' },
];

function _injectBottomNav(me) {
  if (!document.querySelector('nav') || document.querySelector('.bottom-nav')) return;
  const items = [..._BOTTOM_NAV_ITEMS];
  if (me && authIsAdmin(me)) items.push({ href: '/admin', icon: '⚙️', label: 'Admin' });
  const bar = document.createElement('div');
  bar.className = 'bottom-nav';
  bar.innerHTML = items.map(i => `
    <a href="${i.href}" class="${location.pathname === i.href ? 'active' : ''}">
      <span class="bn-icon">${i.icon}</span>${i.label}
    </a>`).join('');
  document.body.appendChild(bar);
  // dosuń aktywną ikonę do widoku (pasek jest przewijany w poziomie)
  const act = bar.querySelector('a.active');
  if (act && act.scrollIntoView) act.scrollIntoView({ inline: 'center', block: 'nearest' });
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
        if (!res.ok) { window.location.href = "/login"; return reject(); }
        const me = await res.json();
        if (!me.household_id) {
          window.location.href = "/onboarding";
          return reject();
        }
        window._currentUser = me;
        _injectProfileButton(me);
        _injectBottomNav(me);
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
