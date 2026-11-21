/* ============================================================
   SYNC SHIM
   Notices every save the dashboard makes to localStorage and
   remembers when each section last changed, so sync.js can send
   it to your other devices. Loaded before everything else.
   ============================================================ */
(function () {
  const KEYS = ['ed_tasks', 'ed_deadlines', 'ed_events', 'ed_notes', 'ed_settings',
                'ed_italy_words', 'ed_italy_phrases', 'ed_italy_notes', 'ed_italy_budget',
                'ed_italy_grammar'];
  const META = 'ed_sync_meta';
  const proto = Storage.prototype;
  const origSet = proto.setItem, origGet = proto.getItem, origRemove = proto.removeItem;

  function meta() {
    try { return JSON.parse(origGet.call(localStorage, META) || '{}'); } catch (e) { return {}; }
  }
  function setMeta(m) { try { origSet.call(localStorage, META, JSON.stringify(m)); } catch (e) {} }

  proto.setItem = function (k, v) {
    const watched = this === window.localStorage && KEYS.indexOf(k) !== -1;
    const prev = watched ? origGet.call(this, k) : null;
    origSet.call(this, k, v);
    if (watched && prev !== String(v)) {
      const m = meta(); m[k] = Date.now(); setMeta(m);
      if (window.__syncPush) window.__syncPush(k);
    }
  };

  window.SYNC = {
    KEYS,
    meta,
    setMeta,
    // write without counting it as a local change (used for data arriving from another device)
    setRaw: (k, v) => origSet.call(localStorage, k, v),
    removeRaw: k => origRemove.call(localStorage, k)
  };
})();
