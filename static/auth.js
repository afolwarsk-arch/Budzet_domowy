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

window.authGetToken = authGetToken;
window.authLogout = authLogout;
window.authRequireHousehold = authRequireHousehold;
window.authFetch = authFetch;
