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
        resolve(me);
      } catch {
        window.location.href = "/login";
        reject();
      }
    });
  });
}

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
