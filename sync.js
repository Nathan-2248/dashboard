/* ============================================================
   SYNC (Firebase)
   Signs you in and keeps every section of the dashboard the same
   on your laptop and phone. Works offline: changes are queued and
   sent when you're back online. Each section is one record; if the
   same section is changed on two devices, the latest change wins.
   ============================================================ */
const FB_VERSION = '10.14.1';
const cfg = window.FIREBASE_CONFIG || {};
const $ = id => document.getElementById(id);

function setDot(state) { const d = $('sync-dot'); if (d) d.className = state; }
function setAccount(text, signedIn) {
  $('set-account-text').textContent = text;
  $('set-signout-btn').style.display = signedIn ? '' : 'none';
}

if (!cfg.apiKey) {
  setDot('off');
  setAccount('Sync isn\'t set up yet, so everything is saved on this device only. Part 2 of the setup guide switches on syncing between your phone and laptop.', false);
} else {
  start().catch(err => {
    console.error(err);
    setDot('err');
    setAccount('Couldn\'t start syncing (' + (err && err.message || err) + '). Your changes are still saved on this device.', false);
  });
}

async function start() {
  const base = `https://www.gstatic.com/firebasejs/${FB_VERSION}/`;
  let appM, authM, fs;
  try {
    [appM, authM, fs] = await Promise.all([
      import(base + 'firebase-app.js'),
      import(base + 'firebase-auth.js'),
      import(base + 'firebase-firestore.js')
    ]);
  } catch (e) {
    setDot('err');
    setAccount('You seem to be offline. Your changes are saved on this device and will sync next time you open the app online.', false);
    return;
  }

  const app = appM.initializeApp(cfg);
  const auth = authM.getAuth(app);
  let db;
  try {
    db = fs.initializeFirestore(app, { localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }) });
  } catch (e) {
    db = fs.getFirestore(app);
  }

  let user = null, unsub = null, col = null;
  const timers = {};

  function push(k) {
    if (!user || !col) return;
    const v = localStorage.getItem(k);
    if (v == null) return;
    const ts = SYNC.meta()[k] || Date.now();
    fs.setDoc(fs.doc(col, k), { value: v, updatedAt: ts }).catch(err => {
      console.error('sync push failed', k, err);
      setDot('err');
    });
  }
  function schedule(k) {
    clearTimeout(timers[k]);
    timers[k] = setTimeout(() => { delete timers[k]; push(k); }, 700);
  }
  function flush() {
    Object.keys(timers).forEach(k => { clearTimeout(timers[k]); delete timers[k]; push(k); });
  }
  window.__syncPush = k => { if (user) schedule(k); };
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
  window.addEventListener('pagehide', flush);

  function begin(u) {
    col = fs.collection(db, 'users', u.uid, 'kv');
    let first = true;
    unsub = fs.onSnapshot(col, snap => {
      const meta = SYNC.meta();
      const remote = {};
      let changed = false;
      snap.docs.forEach(d => {
        if (SYNC.KEYS.indexOf(d.id) === -1) return;
        const data = d.data();
        remote[d.id] = data.updatedAt || 0;
        if ((data.updatedAt || 0) > (meta[d.id] || 0)) {
          if (localStorage.getItem(d.id) !== data.value) { SYNC.setRaw(d.id, data.value); changed = true; }
          meta[d.id] = data.updatedAt;
        }
      });
      SYNC.setMeta(meta);
      if (first) {
        first = false;
        // send anything this device has that the cloud doesn't (or has an older copy of)
        SYNC.KEYS.forEach(k => {
          if (localStorage.getItem(k) == null) return;
          if (!(k in remote) || (meta[k] || 0) > remote[k]) push(k);
        });
      }
      if (changed && typeof reloadFromStorage === 'function') reloadFromStorage();
      setDot(snap.metadata.fromCache ? 'err' : 'ok');
      setAccount('Signed in as ' + u.email + '. ' + (snap.metadata.fromCache
        ? 'Offline right now: changes will sync when you\'re back online.'
        : 'Everything is synced between your devices.'), true);
    }, err => {
      console.error(err);
      setDot('err');
      setAccount('Signed in as ' + u.email + ', but syncing failed: ' + err.message +
        ' (check the Firestore rules step in the setup guide).', true);
    });
  }

  function clearLocalData() {
    SYNC.KEYS.forEach(k => SYNC.removeRaw(k));
    SYNC.removeRaw('ed_sync_meta');
    SYNC.removeRaw('ed_tt_cache');
    if (typeof reloadFromStorage === 'function') reloadFromStorage();
  }

  window.appSignOut = async () => {
    flush();
    if (unsub) { unsub(); unsub = null; }
    await authM.signOut(auth);
    clearLocalData();
    closeModal('settings-modal');
  };

  authM.onAuthStateChanged(auth, u => {
    if (u) {
      // a different person signing in on this device: start from a clean slate
      const last = localStorage.getItem('ed_sync_uid');
      if (last && last !== u.uid) clearLocalData();
      SYNC.setRaw('ed_sync_uid', u.uid);
      user = u;
      $('auth-screen').classList.remove('open');
      setAccount('Signed in as ' + u.email + '. Connecting…', true);
      begin(u);
    } else {
      user = null;
      if (unsub) { unsub(); unsub = null; }
      setDot('off');
      setAccount('Not signed in.', false);
      $('auth-screen').classList.add('open');
    }
  });

  /* ---------- sign-in screen ---------- */
  const errEl = $('auth-error');
  const email = () => $('auth-email').value.trim();
  const pass = () => $('auth-password').value;
  const friendly = e => ({
    'auth/invalid-credential': 'That email or password is wrong.',
    'auth/wrong-password': 'That email or password is wrong.',
    'auth/user-not-found': 'No account with that email yet. Tap "Create my account" the first time.',
    'auth/invalid-email': 'That email address doesn\'t look right.',
    'auth/missing-password': 'Please type your password.',
    'auth/weak-password': 'Please use a password of at least 6 characters.',
    'auth/email-already-in-use': 'You already have an account. Tap "Sign in" instead.',
    'auth/network-request-failed': 'No internet connection. Try again when you\'re online.',
    'auth/too-many-requests': 'Too many tries. Wait a few minutes and try again.',
    'auth/operation-not-allowed': 'Email sign-in isn\'t switched on in Firebase yet (see the setup guide).',
    'auth/admin-restricted-operation': 'New accounts are switched off for this app.'
  }[e.code] || ('Something went wrong: ' + (e.message || e.code)));

  async function run(btn, fn) {
    errEl.textContent = '';
    btn.disabled = true;
    try { await fn(); } catch (e) { errEl.textContent = friendly(e); } finally { btn.disabled = false; }
  }
  $('auth-signin').onclick = e => run(e.currentTarget, () => authM.signInWithEmailAndPassword(auth, email(), pass()));
  $('auth-signup').onclick = e => run(e.currentTarget, () => authM.createUserWithEmailAndPassword(auth, email(), pass()));
  $('auth-reset').onclick = e => run(e.currentTarget, async () => {
    if (!email()) { errEl.textContent = 'Type your email first, then tap "Forgot password?".'; return; }
    await authM.sendPasswordResetEmail(auth, email());
    errEl.textContent = 'A reset link is on its way to ' + email() + ' (check spam too).';
  });
  $('auth-password').addEventListener('keydown', e => { if (e.key === 'Enter') $('auth-signin').click(); });
}
