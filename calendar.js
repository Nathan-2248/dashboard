/* ============================================================
   CALENDAR
   Month / week / day views, your own events, deadlines, and the
   read-only university timetable (.ics subscription).
   Uses globals from the main script: calEvents, deadlines, save(),
   escHtml(), closeModal(), switchView(), uid(), currentView.
   ============================================================ */

const CV_HOUR_H = 48;              // pixel height of one hour (matches --hour-h)
const CV_TT_CACHE = 'ed_tt_cache'; // timetable copy kept on each device
const CV_TT_MAX_AGE = 2 * 3600e3;  // refresh the timetable every 2 hours
// module colours come from calendar.css (--m-<module>) so they can be darker on cream
const CV_MODULE_COLORS = Object.fromEntries(
  ['BOIL','CrimJust','CrimLaw','FinAcc','CivProc','Contracts','CrimProc','Evidence','ManAcc','PIL','Tutoring','Admin']
    .map(m => [m, 'var(--m-' + m + ')']));
const CV_DAYNAMES = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];

let cvView = (function () {
  try { const v = localStorage.getItem('ed_cal_view'); if (v) return v; } catch (e) {}
  return window.innerWidth < 560 ? 'day' : 'week';
})();
let cvCursor = cvStartOfDay(new Date());
let cvItems = [];          // items currently on screen, looked up by index on click
let cvLastRangeKey = '';   // used to keep the scroll position between re-renders
let cvLastVisible = false;
let cvEditId = null;
let cvDurMs = 3600e3;
let cvDeleteArmed = false;

/* ---------- date helpers ---------- */
function cvStartOfDay(d) { const x = new Date(d); x.setHours(0,0,0,0); return x; }
function cvAddDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function cvStartOfWeek(d) { const x = cvStartOfDay(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; }
function isoDate(d) {
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}
function cvHM(d) { return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0'); }
function cvParseLocal(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(s || '');
  if (!m) return null;
  return new Date(+m[1], +m[2]-1, +m[3], +(m[4]||0), +(m[5]||0));
}
function cvEsc(s) { return escHtml(String(s == null ? '' : s)); }
function cvSameDay(a, b) { return a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate(); }
function cvFmtDate(d, opts) { return d.toLocaleDateString('en-ZA', opts); }

/* ---------- settings (synced between devices) ---------- */
function cvGetSettings() {
  try { return Object.assign({ icsUrl:'', proxyUrl:'', showTT:true }, JSON.parse(localStorage.getItem('ed_settings') || '{}')); }
  catch (e) { return { icsUrl:'', proxyUrl:'', showTT:true }; }
}

/* ============================================================
   COLLECT EVERYTHING THAT FALLS IN A DATE RANGE
   ============================================================ */
function cvNormalizeEvent(e) {
  if (e.start) return e;
  // older format: { title, date, time }
  const start = e.date + 'T' + (e.time || '09:00');
  const s = cvParseLocal(start);
  return Object.assign({}, e, { start, end: e.date + 'T' + cvHM(new Date(s.getTime() + 3600e3)), allDay: !e.time });
}

function cvCollect(from, to) {
  const out = [];
  const f = from.getTime(), t = to.getTime();
  const overlaps = (s, e) => s < t && (e > f || (e === s && s >= f));

  // My events
  Object.entries(calEvents).forEach(([id, raw]) => {
    const ev = cvNormalizeEvent(raw);
    let s = cvParseLocal(ev.start), e = cvParseLocal(ev.end) || s;
    if (!s) return;
    if (ev.allDay) { s = cvStartOfDay(s); e = cvAddDays(cvStartOfDay(e), 1); }
    if (e < s) e = s;
    if (!overlaps(s.getTime(), e.getTime())) return;
    out.push({ kind:'event', id, title: ev.title, s: s.getTime(), e: e.getTime(), allDay: !!ev.allDay,
      location: ev.location, notes: ev.notes, color: CV_MODULE_COLORS[ev.module] || 'var(--accent-blue)' });
  });

  // Deadlines
  Object.entries(deadlines).forEach(([id, d]) => {
    const s = new Date(d.datetime).getTime();
    if (isNaN(s) || !overlaps(s, s + 1)) return;
    out.push({ kind:'deadline', id, title: d.name, icon: '⏰', s, e: s, allDay: false, color: 'var(--accent-red)' });
  });

  // University timetable
  if (cvGetSettings().showTT !== false) {
    cvTimetableOccurrences(f, t).forEach(o => out.push(o));
  }
  return out.sort((a, b) => a.s - b.s || (b.e - b.s) - (a.e - a.s));
}

/* ============================================================
   RENDER
   ============================================================ */
function renderCalendar() {
  const body = document.getElementById('cv-body');
  if (!body) return;
  document.querySelectorAll('#cv-seg button').forEach(b => b.classList.toggle('active', b.dataset.v === cvView));
  const prevBody = document.getElementById('cv-tg-body');
  const prevScroll = prevBody ? prevBody.scrollTop : null;
  let rangeKey;

  if (cvView === 'month') {
    rangeKey = cvRenderMonth(body);
  } else {
    rangeKey = cvRenderTimeGrid(body, cvView === 'week' ? 7 : 1);
    const tb = document.getElementById('cv-tg-body');
    if (prevScroll != null && rangeKey === cvLastRangeKey && cvLastVisible) tb.scrollTop = prevScroll;
    else {
      const now = new Date();
      tb.scrollTop = Math.max(0, (Math.min(now.getHours(), 17) - 1) * CV_HOUR_H);
      if (now.getHours() < 7) tb.scrollTop = 7 * CV_HOUR_H;
    }
    cvLastVisible = tb.clientHeight > 0; // scrolling only sticks once the calendar is on screen
  }
  cvLastRangeKey = rangeKey;
  cvUpdateTTStatus();
  refreshTimetable(false);
}

function cvName(it) { return (it.icon ? `<span class="ic">${it.icon} </span>` : '') + cvEsc(it.title); }

function cvItemAttrs(item) {
  cvItems.push(item);
  return `data-k="${cvItems.length - 1}" onclick="event.stopPropagation();cvOpenItem(${cvItems.length - 1})"`;
}

/* ---------- Month ---------- */
function cvRenderMonth(body) {
  const first = new Date(cvCursor.getFullYear(), cvCursor.getMonth(), 1);
  const start = cvStartOfWeek(first);
  const end = cvAddDays(start, 42);
  document.getElementById('cv-title').textContent = cvFmtDate(first, { month:'long', year:'numeric' });
  const items = cvCollect(start, end);
  const today = cvStartOfDay(new Date());
  const maxShow = window.innerWidth < 560 ? 3 : 4;
  cvItems = [];

  let html = '<div class="cv-month"><div class="cv-mhead">' + CV_DAYNAMES.map(n => `<div>${n}</div>`).join('') + '</div><div class="cv-mgrid">';
  for (let i = 0; i < 42; i++) {
    const d = cvAddDays(start, i), dEnd = cvAddDays(d, 1);
    const iso = isoDate(d);
    const dayItems = items.filter(it => it.s < dEnd.getTime() && (it.e > d.getTime() || (it.e === it.s && it.s >= d.getTime())))
      .sort((a, b) => (b.allDay - a.allDay) || a.s - b.s);
    const cls = 'cv-mcell' + (d.getMonth() !== first.getMonth() ? ' other' : '') + (d.getTime() === today.getTime() ? ' today' : '');
    html += `<div class="${cls}" onclick="calGoDay('${iso}')" ondblclick="openEventModal('${iso}')">`;
    html += `<span class="cv-mnum">${d.getDate()}</span>`;
    dayItems.slice(0, maxShow).forEach(it => {
      if (it.allDay) {
        html += `<div class="cv-chip allday" style="background:${it.color}" ${cvItemAttrs(it)}><span class="n">${cvName(it)}</span></div>`;
      } else {
        html += `<div class="cv-chip" ${cvItemAttrs(it)}><span class="dot" style="background:${it.color}"></span><span class="t">${cvHM(new Date(it.s))}</span><span class="n">${cvName(it)}</span></div>`;
      }
    });
    if (dayItems.length > maxShow) html += `<div class="cv-more">+${dayItems.length - maxShow} more</div>`;
    html += '</div>';
  }
  body.innerHTML = html + '</div></div>';
  return 'm' + isoDate(start);
}

/* ---------- Week & Day ---------- */
function cvRenderTimeGrid(body, nDays) {
  const start = nDays === 7 ? cvStartOfWeek(cvCursor) : cvStartOfDay(cvCursor);
  const end = cvAddDays(start, nDays);
  const days = Array.from({ length: nDays }, (_, i) => cvAddDays(start, i));
  const last = days[nDays - 1];
  const title = document.getElementById('cv-title');
  if (nDays === 1) {
    title.textContent = cvFmtDate(start, { weekday:'long', day:'numeric', month:'long', year:'numeric' });
  } else {
    const sameMonth = start.getMonth() === last.getMonth();
    title.textContent = (sameMonth ? start.getDate() : cvFmtDate(start, { day:'numeric', month:'short' })) +
      ' – ' + cvFmtDate(last, { day:'numeric', month:'short', year:'numeric' });
  }

  const items = cvCollect(start, end);
  const now = new Date();
  cvItems = [];

  let head = '<div></div>', allday = '<div class="lab">all-day</div>', cols = '';
  days.forEach(d => {
    const iso = isoDate(d);
    const isToday = cvSameDay(d, now);
    const ds = d.getTime(), de = cvAddDays(d, 1).getTime();
    head += `<div class="cv-dh${isToday ? ' today' : ''}" onclick="calGoDay('${iso}')"><span class="dn">${CV_DAYNAMES[(d.getDay() + 6) % 7]}</span><span class="dd">${d.getDate()}</span></div>`;

    // all-day row
    const ad = items.filter(it => it.allDay && it.s < de && it.e > ds);
    allday += '<div class="cv-adcell">' + ad.map(it =>
      `<div class="cv-chip allday" style="background:${it.color}" ${cvItemAttrs(it)}><span class="n">${cvName(it)}</span></div>`).join('') + '</div>';

    // timed events, split at midnight and laid out side by side when they overlap
    const segs = items.filter(it => !it.allDay && it.s < de && (it.e > ds || (it.e === it.s && it.s >= ds)))
      .map(it => {
        const s = Math.max(it.s, ds), e = Math.min(Math.max(it.e, it.s), de);
        return { it, s, e: Math.max(e, s + 30 * 60e3) }; // at least 30 minutes tall
      });
    cvLayout(segs);
    let col = `<div class="cv-col${isToday ? ' today' : ''}" onclick="cvColClick(event,'${iso}')">`;
    segs.forEach(g => {
      const top = (g.s - ds) / 3600e3 * CV_HOUR_H;
      const h = Math.max(18, (g.e - g.s) / 3600e3 * CV_HOUR_H - 2);
      const left = g.col / g.ncols * 100, width = 100 / g.ncols;
      const it = g.it;
      const time = it.kind === 'deadline' ? cvHM(new Date(it.s)) : cvHM(new Date(it.s)) + ' – ' + cvHM(new Date(it.e));
      col += `<div class="cv-ev${h < 34 ? ' short' : ''}" style="top:${top}px;height:${h}px;left:calc(${left}% + 1px);width:calc(${width}% - 3px);--c:${it.color}" ${cvItemAttrs(it)}>` +
        `<span class="n">${cvName(it)}</span><span class="t">${time}</span>` +
        (it.location ? `<span class="l">${cvEsc(it.location)}</span>` : '') + '</div>';
    });
    if (isToday) col += `<div class="cv-now" style="top:${(now - ds) / 3600e3 * CV_HOUR_H}px"></div>`;
    cols += col + '</div>';
  });

  let gutter = '<div class="cv-gutter">';
  for (let h = 0; h < 24; h++) gutter += `<div class="cv-hlabel">${h ? String(h).padStart(2,'0') + ':00' : ''}</div>`;
  gutter += '</div>';

  body.innerHTML = `<div class="cv-tg${nDays === 7 ? ' cv-week' : ''}" style="--cols:${nDays}">
    <div class="cv-tg-head">${head}</div>
    <div class="cv-tg-allday">${allday}</div>
    <div class="cv-tg-body" id="cv-tg-body"><div class="cv-tg-body-inner">${gutter}${cols}</div></div>
  </div>`;
  return nDays + isoDate(start);
}

// Places overlapping events in columns (like Apple Calendar)
function cvLayout(segs) {
  segs.sort((a, b) => a.s - b.s || b.e - a.e);
  let cluster = [], colsEnd = [], clusterEnd = -Infinity;
  const finish = () => { cluster.forEach(g => g.ncols = colsEnd.length); cluster = []; colsEnd = []; };
  segs.forEach(g => {
    if (g.s >= clusterEnd) { finish(); clusterEnd = -Infinity; }
    let c = colsEnd.findIndex(end => end <= g.s);
    if (c === -1) { c = colsEnd.length; colsEnd.push(g.e); } else colsEnd[c] = g.e;
    g.col = c;
    cluster.push(g);
    clusterEnd = Math.max(clusterEnd, g.e);
  });
  finish();
}

function cvColClick(e, iso) {
  const rect = e.currentTarget.getBoundingClientRect();
  const mins = Math.max(0, Math.min(23 * 60 + 30, Math.floor((e.clientY - rect.top) / CV_HOUR_H * 2) * 30));
  openEventModal(iso, String(Math.floor(mins / 60)).padStart(2,'0') + ':' + String(mins % 60).padStart(2,'0'));
}

/* ---------- navigation ---------- */
function calSetView(v) {
  cvView = v;
  try { localStorage.setItem('ed_cal_view', v); } catch (e) {}
  renderCalendar();
}
function calStep(n) {
  if (cvView === 'month') cvCursor = new Date(cvCursor.getFullYear(), cvCursor.getMonth() + n, 1);
  else cvCursor = cvAddDays(cvCursor, n * (cvView === 'week' ? 7 : 1));
  renderCalendar();
}
function calToday() { cvCursor = cvStartOfDay(new Date()); renderCalendar(); }
function calGoDay(iso) { cvCursor = cvParseLocal(iso); calSetView('day'); }

// keep the red "now" line moving
setInterval(() => {
  if (typeof currentView !== 'undefined' && currentView === 'calendar' && cvView !== 'month' &&
      !document.querySelector('.modal-overlay.open')) renderCalendar();
}, 60000);

/* ============================================================
   OPEN AN ITEM
   ============================================================ */
function cvOpenItem(k) {
  const it = cvItems[k];
  if (!it) return;
  if (it.kind === 'event') { editEvent(it.id); return; }
  const s = new Date(it.s), e = new Date(it.e);
  const dayStr = d => cvFmtDate(d, { weekday:'short', day:'numeric', month:'short', year:'numeric' });
  let when;
  if (it.allDay) {
    const lastDay = cvAddDays(e, -1);
    when = cvSameDay(s, lastDay) ? dayStr(s) + ' (all day)' : dayStr(s) + ' – ' + dayStr(lastDay);
  } else if (it.kind === 'deadline') when = 'Due ' + dayStr(s) + ', ' + cvHM(s);
  else if (cvSameDay(s, e) || e - s < 864e5 && cvSameDay(s, new Date(it.e - 1))) when = dayStr(s) + ', ' + cvHM(s) + ' – ' + cvHM(e);
  else when = dayStr(s) + ', ' + cvHM(s) + ' – ' + dayStr(e) + ', ' + cvHM(e);

  document.getElementById('detail-kind').textContent = it.kind === 'deadline' ? 'DEADLINE' : 'TIMETABLE · READ-ONLY';
  document.getElementById('detail-title').textContent = (it.icon ? it.icon + ' ' : '') + it.title;
  document.getElementById('detail-when').textContent = '🕒 ' + when;
  document.getElementById('detail-where').textContent = it.location ? '📍 ' + it.location : '';
  document.getElementById('detail-notes').textContent = it.notes || '';
  const btn = document.getElementById('detail-action');
  if (it.kind === 'deadline') {
    btn.style.display = '';
    btn.textContent = 'Open deadlines';
    btn.onclick = () => { closeModal('detail-modal'); switchView('deadlines'); };
  } else {
    btn.style.display = 'none';
  }
  document.getElementById('detail-modal').classList.add('open');
}

/* ============================================================
   ADD / EDIT / DELETE EVENTS
   ============================================================ */
const $cv = id => document.getElementById(id);

function cvFillForm(ev) {
  const s = cvParseLocal(ev.start), e = cvParseLocal(ev.end) || s;
  $cv('event-title').value = ev.title || '';
  $cv('event-location').value = ev.location || '';
  $cv('event-notes').value = ev.notes || '';
  $cv('event-module').value = ev.module || '';
  $cv('event-allday').checked = !!ev.allDay;
  $cv('event-start-date').value = isoDate(s);
  $cv('event-start-time').value = cvHM(s);
  $cv('event-end-date').value = isoDate(e);
  $cv('event-end-time').value = cvHM(e);
  cvDurMs = Math.max(0, e - s) || 3600e3;
  $cv('event-error').textContent = '';
  cvDeleteArmed = false;
  $cv('event-delete-btn').textContent = 'Delete';
  evAllDayChanged();
}

// New event. date = 'YYYY-MM-DD', time = 'HH:MM' (both optional)
function openEventModal(date, time) {
  cvEditId = null;
  if (!date) date = isoDate(cvView === 'month' && !cvSameDay(cvCursor, new Date()) ? cvCursor : (cvView === 'day' ? cvCursor : new Date()));
  if (!time) { const n = new Date(); time = String(Math.min(23, n.getHours() + 1)).padStart(2,'0') + ':00'; }
  const s = cvParseLocal(date + 'T' + time);
  const e = new Date(s.getTime() + 3600e3);
  cvFillForm({ start: date + 'T' + time, end: isoDate(e) + 'T' + cvHM(e) });
  $cv('event-modal-title').textContent = 'NEW EVENT';
  $cv('event-delete-btn').style.display = 'none';
  $cv('event-modal').classList.add('open');
  setTimeout(() => $cv('event-title').focus(), 100);
}

function editEvent(id) {
  const ev = calEvents[id];
  if (!ev) return;
  cvEditId = id;
  cvFillForm(cvNormalizeEvent(ev));
  $cv('event-modal-title').textContent = 'EDIT EVENT';
  $cv('event-delete-btn').style.display = '';
  $cv('event-modal').classList.add('open');
}

function evAllDayChanged() {
  const all = $cv('event-allday').checked;
  document.querySelectorAll('#event-modal .cv-dt').forEach(el => el.classList.toggle('allday', all));
}

// Moving the start moves the end too, keeping the same length (like Apple Calendar)
function evStartChanged() {
  const s = cvParseLocal($cv('event-start-date').value + 'T' + ($cv('event-start-time').value || '00:00'));
  if (!s) return;
  const e = new Date(s.getTime() + cvDurMs);
  $cv('event-end-date').value = isoDate(e);
  $cv('event-end-time').value = cvHM(e);
}
document.addEventListener('DOMContentLoaded', () => {
  ['event-end-date', 'event-end-time'].forEach(id => $cv(id).addEventListener('change', () => {
    const s = cvParseLocal($cv('event-start-date').value + 'T' + ($cv('event-start-time').value || '00:00'));
    const e = cvParseLocal($cv('event-end-date').value + 'T' + ($cv('event-end-time').value || '00:00'));
    if (s && e && e >= s) cvDurMs = e - s;
  }));
  $cv('event-title').addEventListener('keydown', e => { if (e.key === 'Enter') saveEvent(); });
});

function saveEvent() {
  const title = $cv('event-title').value.trim();
  const allDay = $cv('event-allday').checked;
  const sd = $cv('event-start-date').value, ed = $cv('event-end-date').value || sd;
  const st = allDay ? '00:00' : ($cv('event-start-time').value || '09:00');
  const et = allDay ? '00:00' : ($cv('event-end-time').value || st);
  const err = $cv('event-error');
  if (!title) { err.textContent = 'Please give the event a title.'; $cv('event-title').focus(); return; }
  if (!sd) { err.textContent = 'Please choose a start date.'; return; }
  const start = sd + 'T' + st, end = ed + 'T' + et;
  if (cvParseLocal(end) < cvParseLocal(start)) { err.textContent = 'The end is before the start.'; return; }
  const id = cvEditId || uid();
  calEvents[id] = {
    title, start, end, allDay,
    location: $cv('event-location').value.trim(),
    notes: $cv('event-notes').value.trim(),
    module: $cv('event-module').value
  };
  save();
  closeModal('event-modal');
  renderCalendar();
}

function deleteEvent(id) {
  id = id || cvEditId;
  if (!id || !calEvents[id]) return;
  if (!cvDeleteArmed && $cv('event-modal').classList.contains('open')) {
    cvDeleteArmed = true;
    $cv('event-delete-btn').textContent = 'Tap again to delete';
    return;
  }
  delete calEvents[id];
  save();
  closeModal('event-modal');
  renderCalendar();
}

/* ============================================================
   SETTINGS
   ============================================================ */
function openSettings() {
  const st = cvGetSettings();
  $cv('set-ics-url').value = st.icsUrl || '';
  $cv('set-proxy-url').value = st.proxyUrl || '';
  $cv('set-tt-show').checked = st.showTT !== false;
  cvUpdateTTStatus();
  $cv('settings-modal').classList.add('open');
}

function saveTimetableSettings() {
  const st = cvGetSettings();
  st.icsUrl = $cv('set-ics-url').value.trim();
  st.proxyUrl = $cv('set-proxy-url').value.trim();
  st.showTT = $cv('set-tt-show').checked;
  localStorage.setItem('ed_settings', JSON.stringify(st));
  if (!st.icsUrl) { try { localStorage.removeItem(CV_TT_CACHE); } catch (e) {} }
  refreshTimetable(true);
  renderCalendar();
}

function cvUpdateTTStatus() {
  const st = cvGetSettings(), c = cvGetTTCache();
  let text = '', cls = '';
  if (!st.icsUrl) text = 'No timetable link saved yet.';
  else if (cvTTBusy) text = 'Loading timetable…';
  else if (c && c.error) { text = c.error; cls = 'err'; }
  else if (c && c.fetchedAt) {
    text = 'Timetable updated ' + new Date(c.fetchedAt).toLocaleString('en-ZA', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' }) +
      ' · ' + c.events.length + ' items';
    cls = 'ok';
  }
  const el = $cv('set-tt-status');
  if (el) { el.textContent = text; el.className = 'cv-set-status ' + cls; }
  const leg = $cv('cv-tt-status');
  if (leg) leg.textContent = st.icsUrl ? (c && c.error ? '⚠ timetable not updating' : '') : 'timetable: not linked yet';
}

/* ============================================================
   TIMETABLE SUBSCRIPTION (.ics)
   ============================================================ */
let cvTTBusy = false;
let cvTTMemo = null; // { fetchedAt, overridden: Map } parsed once per download

function cvGetTTCache() {
  try { return JSON.parse(localStorage.getItem(CV_TT_CACHE) || 'null'); } catch (e) { return null; }
}

async function refreshTimetable(force) {
  const st = cvGetSettings();
  const url = (st.icsUrl || '').trim();
  if (!url || cvTTBusy) return;
  const cache = cvGetTTCache();
  if (!force && cache && cache.url === url && Date.now() - (cache.triedAt || cache.fetchedAt || 0) < CV_TT_MAX_AGE) return;
  if (!navigator.onLine && cache && cache.url === url) return;
  cvTTBusy = true;
  cvUpdateTTStatus();
  const target = url.replace(/^webcal:\/\//i, 'https://');
  const proxy = (st.proxyUrl || '').trim().replace(/\/+$/, '');
  const fetchUrl = proxy ? proxy + '/?url=' + encodeURIComponent(target) : target;
  const keep = cache && cache.url === url ? cache : null;
  try {
    const r = await fetch(fetchUrl, { cache: 'no-store' });
    if (!r.ok) throw new Error('the server answered ' + r.status);
    const text = await r.text();
    if (text.indexOf('BEGIN:VCALENDAR') === -1) throw new Error("that link doesn't look like a calendar");
    const events = icsParse(text);
    localStorage.setItem(CV_TT_CACHE, JSON.stringify({ url, fetchedAt: Date.now(), triedAt: Date.now(), events, error: null }));
  } catch (err) {
    const msg = proxy
      ? "Couldn't load the timetable (" + err.message + '). Check the timetable link and the helper link.'
      : "Couldn't load the timetable. Most university servers block apps from reading them directly, so you'll need the timetable helper link (see the setup guide).";
    const c = keep || { url, fetchedAt: 0, events: [] };
    c.error = msg; c.triedAt = Date.now();
    try { localStorage.setItem(CV_TT_CACHE, JSON.stringify(c)); } catch (e) {}
  } finally {
    cvTTBusy = false;
    cvTTMemo = null;
    cvUpdateTTStatus();
    // safe to re-render: triedAt was just updated, so this won't fetch again
    if (typeof currentView !== 'undefined' && currentView === 'calendar') renderCalendar();
  }
}
setInterval(() => refreshTimetable(false), 15 * 60e3);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshTimetable(false); });
window.addEventListener('online', () => refreshTimetable(false));

function cvTimetableOccurrences(from, to) {
  const c = cvGetTTCache();
  if (!c || !c.events || !c.events.length || c.url !== (cvGetSettings().icsUrl || '').trim()) return [];
  if (!cvTTMemo || cvTTMemo.fetchedAt !== c.fetchedAt) {
    const overridden = new Map();
    c.events.forEach(ev => { if (ev.rid != null) { if (!overridden.has(ev.uid)) overridden.set(ev.uid, new Set()); overridden.get(ev.uid).add(ev.rid); } });
    cvTTMemo = { fetchedAt: c.fetchedAt, overridden };
  }
  const out = [];
  c.events.forEach(ev => {
    if (ev.cancel) return;
    const skip = ev.rid == null ? cvTTMemo.overridden.get(ev.uid) : null;
    icsExpand(ev, from, to, skip).forEach(([s, e]) => out.push({
      kind: 'tt', title: ev.title || 'Class', icon: '🎓', s, e, allDay: ev.allDay,
      location: ev.location, notes: ev.notes, color: 'var(--tt-color)'
    }));
  });
  return out;
}

/* ---------- .ics parsing ---------- */
const ICS_WIN_TZ = { 'South Africa Standard Time':'Africa/Johannesburg', 'GMT Standard Time':'Europe/London', 'UTC':'UTC', 'W. Europe Standard Time':'Europe/Berlin' };
const icsFmtCache = {};

function icsTzOffset(ms, tz) {
  const f = icsFmtCache[tz] || (icsFmtCache[tz] = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit' }));
  const p = {};
  f.formatToParts(new Date(ms)).forEach(x => p[x.type] = x.value);
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - ms;
}

function icsDate(v, params) {
  v = (v || '').trim();
  let m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (m || (params && params.VALUE === 'DATE')) {
    m = m || /^(\d{4})(\d{2})(\d{2})/.exec(v);
    return { ms: new Date(+m[1], +m[2] - 1, +m[3]).getTime(), allDay: true };
  }
  m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/.exec(v);
  if (!m) return null;
  const a = [+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)];
  if (m[7]) return { ms: Date.UTC(...a), allDay: false };
  let tz = params && params.TZID ? params.TZID.replace(/^"|"$/g, '').replace(/^\//, '') : '';
  tz = ICS_WIN_TZ[tz] || tz;
  if (tz) {
    try {
      const guess = Date.UTC(...a);
      let t = guess - icsTzOffset(guess, tz);
      const off2 = icsTzOffset(t, tz);
      t = guess - off2;
      return { ms: t, allDay: false };
    } catch (e) { /* unknown time zone: fall back to this device's time */ }
  }
  return { ms: new Date(...a).getTime(), allDay: false };
}

function icsText(v) {
  return v.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

function icsDuration(v) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
  if (!m) return null;
  const ms = (((+(m[2]||0) * 7 + +(m[3]||0)) * 24 + +(m[4]||0)) * 60 + +(m[5]||0)) * 60e3 + +(m[6]||0) * 1e3;
  return m[1] === '-' ? -ms : ms;
}

function icsParse(text) {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const out = [];
  let cur = null, sub = 0;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = { ex: [] }; sub = 0; continue; }
    if (!cur) continue;
    if (line === 'END:VEVENT') {
      if (cur.start) {
        const dur = cur.end ? cur.end.ms - cur.start.ms : (cur.dur != null ? cur.dur : (cur.start.allDay ? 864e5 : 0));
        out.push({
          uid: cur.uid || '', title: cur.title || '', location: cur.location || '', notes: cur.notes || '',
          s: cur.start.ms, d: Math.max(0, dur), allDay: cur.start.allDay,
          rrule: cur.rrule || null, ex: cur.ex, rid: cur.rid != null ? cur.rid : null, cancel: !!cur.cancel
        });
      }
      cur = null; continue;
    }
    if (/^BEGIN:/.test(line)) { sub++; continue; }   // e.g. VALARM inside the event
    if (/^END:/.test(line)) { sub--; continue; }
    if (sub > 0) continue;
    // split NAME;PARAMS:VALUE (colons inside quotes belong to params)
    let i = 0, q = false;
    for (; i < line.length; i++) { const ch = line[i]; if (ch === '"') q = !q; else if (ch === ':' && !q) break; }
    if (i >= line.length) continue;
    const head = line.slice(0, i), value = line.slice(i + 1);
    const parts = head.split(';');
    const name = parts[0].toUpperCase();
    const params = {};
    parts.slice(1).forEach(p => { const k = p.indexOf('='); if (k > 0) params[p.slice(0, k).toUpperCase()] = p.slice(k + 1); });
    switch (name) {
      case 'UID': cur.uid = value; break;
      case 'SUMMARY': cur.title = icsText(value); break;
      case 'LOCATION': cur.location = icsText(value); break;
      case 'DESCRIPTION': cur.notes = icsText(value); break;
      case 'DTSTART': cur.start = icsDate(value, params); break;
      case 'DTEND': cur.end = icsDate(value, params); break;
      case 'DURATION': cur.dur = icsDuration(value); break;
      case 'RRULE': cur.rrule = value; break;
      case 'EXDATE': value.split(',').forEach(x => { const d = icsDate(x, params); if (d) cur.ex.push(d.ms); }); break;
      case 'RECURRENCE-ID': { const d = icsDate(value, params); if (d) cur.rid = d.ms; break; }
      case 'STATUS': if (value.trim().toUpperCase() === 'CANCELLED') cur.cancel = true; break;
    }
  }
  return out;
}

// Returns [[startMs, endMs], ...] for the occurrences of ev that touch [from, to)
function icsExpand(ev, from, to, skip) {
  const dur = ev.d || 0;
  const hit = s => s < to && (s + dur > from || (dur === 0 && s >= from));
  if (!ev.rrule) return hit(ev.s) ? [[ev.s, ev.s + dur]] : [];

  const r = {};
  ev.rrule.split(';').forEach(p => { const [k, v] = p.split('='); if (k && v) r[k.toUpperCase()] = v; });
  const freq = r.FREQ, interval = Math.max(1, +r.INTERVAL || 1);
  const count = r.COUNT ? +r.COUNT : 0;
  const untilD = r.UNTIL ? icsDate(r.UNTIL, {}) : null;
  // an all-day UNTIL includes that whole day
  const until = untilD ? (untilD.allDay ? untilD.ms + 864e5 - 1 : untilD.ms) : Infinity;
  const ex = new Set(ev.ex || []);
  const base = new Date(ev.s);
  const H = base.getHours(), M = base.getMinutes(), S = base.getSeconds();
  const WD = { SU:0, MO:1, TU:2, WE:3, TH:4, FR:5, SA:6 };
  const byday = r.BYDAY ? r.BYDAY.split(',').map(x => { const m = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(x.trim()); return m ? { n: m[1] ? +m[1] : 0, wd: WD[m[2]] } : null; }).filter(Boolean) : null;
  const bymonthday = r.BYMONTHDAY ? r.BYMONTHDAY.split(',').map(Number) : null;

  const out = [];
  let n = 0, done = false;
  const emit = d => {
    const ms = d.getTime();
    if (ms < ev.s) return;
    if (ms > until || (count && n >= count) || ms >= to) { done = true; return; }
    n++;
    if (!ex.has(ms) && !(skip && skip.has(ms)) && hit(ms)) out.push([ms, ms + dur]);
  };
  const at = (y, mo, d) => new Date(y, mo, d, H, M, S);

  for (let i = 0; i < 3000 && !done; i++) {
    if (freq === 'DAILY') {
      const d = at(base.getFullYear(), base.getMonth(), base.getDate() + i * interval);
      if (!byday || byday.some(b => b.wd === d.getDay())) emit(d);
    } else if (freq === 'WEEKLY') {
      const ws = cvStartOfWeek(base);
      const days = (byday ? byday.map(b => b.wd) : [base.getDay()]).sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
      for (const wd of days) { if (done) break; emit(at(ws.getFullYear(), ws.getMonth(), ws.getDate() + i * interval * 7 + (wd + 6) % 7)); }
    } else if (freq === 'MONTHLY') {
      const y = base.getFullYear(), mo = base.getMonth() + i * interval;
      const dim = new Date(y, mo + 1, 0).getDate();
      let dates = [];
      if (byday) {
        byday.forEach(b => {
          const all = [];
          for (let day = 1; day <= dim; day++) if (new Date(y, mo, day).getDay() === b.wd) all.push(day);
          if (b.n > 0 && all[b.n - 1]) dates.push(all[b.n - 1]);
          else if (b.n < 0 && all[all.length + b.n]) dates.push(all[all.length + b.n]);
          else if (!b.n) dates.push(...all);
        });
      } else if (bymonthday) dates = bymonthday.map(x => x < 0 ? dim + x + 1 : x).filter(x => x >= 1 && x <= dim);
      else if (base.getDate() <= dim) dates = [base.getDate()];
      dates.sort((a, b) => a - b).forEach(day => { if (!done) emit(at(y, mo, day)); });
    } else if (freq === 'YEARLY') {
      const d = at(base.getFullYear() + i * interval, base.getMonth(), base.getDate());
      if (d.getMonth() === base.getMonth()) emit(d);
    } else {
      // unsupported rule: show only the first occurrence
      if (hit(ev.s)) out.push([ev.s, ev.s + dur]);
      break;
    }
  }
  return out;
}
