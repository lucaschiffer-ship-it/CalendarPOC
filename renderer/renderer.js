/* renderer.js – runs in the Electron renderer process (no Node access) */

// ── DOM refs ─────────────────────────────────────────────────────────────────

const mfaOverlay    = document.getElementById('mfa-overlay');
const mfaForm       = document.getElementById('mfa-form');
const mfaCodeInput  = document.getElementById('mfa-code');
const loginScreen   = document.getElementById('login-screen');
const coursesScreen = document.getElementById('courses-screen');
const loginForm     = document.getElementById('login-form');
const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');
const loginBtn      = document.getElementById('login-btn');
const loginError    = document.getElementById('login-error');

const refreshBtn    = document.getElementById('refresh-btn');
const logoutBtn     = document.getElementById('logout-btn');
const statusBar     = document.getElementById('status-bar');
const statusText    = document.getElementById('status-text');
const courseList    = document.getElementById('course-list');
const emptyState    = document.getElementById('empty-state');
const courseCount   = document.getElementById('course-count');
const listViewBtn   = document.getElementById('list-view-btn');
const calViewBtn    = document.getElementById('cal-view-btn');
const calView       = document.getElementById('cal-view');
const calGrid       = document.getElementById('cal-grid');
const calWeekLabel  = document.getElementById('cal-week-label');
const calPrev       = document.getElementById('cal-prev');
const calNext       = document.getElementById('cal-next');

// Held in memory only; never written to disk
let _username = '';
let _password = '';
let _courses  = [];
let _calWeekStart  = getWeekMonday(new Date());
let _editingKey    = null;  // course key currently open in modal

// Course overrides persisted in localStorage
let _overrides = {};
try { _overrides = JSON.parse(localStorage.getItem('kisd-overrides') || '{}'); } catch {}

function saveOverrides() {
  localStorage.setItem('kisd-overrides', JSON.stringify(_overrides));
}

function getCourseKey(course) {
  return (course.title || '').trim().slice(0, 80);
}

function getEffectiveCourse(course) {
  const ov = _overrides[getCourseKey(course)] || {};
  const merged = { ...course };
  if (ov.title)       merged.title       = ov.title;
  if (ov.description !== undefined) merged.description = ov.description;
  if (ov.sessions && ov.sessions.length) {
    merged.meetingTimes = ov.sessions
      .map((s) => `${s.day} ${s.start} — ${s.end}`)
      .join(' · ');
  }
  if (ov.startDate || ov.endDate) {
    const s = ov.startDate ? isoToDisplay(ov.startDate) : '01.01.2026';
    const e = ov.endDate   ? isoToDisplay(ov.endDate)   : '31.12.2026';
    merged.timeframe = `${s} — ${e}`;
  }
  return merged;
}

function hasPlaceableSessions(course) {
  return parseMeetingTimes(getEffectiveCourse(course).meetingTimes).length > 0;
}

function isoToDisplay(iso) {
  const [y, mo, d] = iso.split('-');
  return `${d}.${mo}.${y}`;
}

function displayToIso(disp) {
  const m = disp.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  return m ? `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}` : '';
}

// ── Screens ───────────────────────────────────────────────────────────────────

function showScreen(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

// ── MFA overlay ───────────────────────────────────────────────────────────────

window.kisd.onMfaRequired(() => {
  mfaOverlay.classList.remove('hidden');
  mfaOverlay.classList.add('active');
  mfaCodeInput.value = '';
  mfaCodeInput.focus();
});

mfaForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const code = mfaCodeInput.value.trim();
  if (!code) return;
  mfaOverlay.classList.remove('active');
  mfaOverlay.classList.add('hidden');
  window.kisd.submitMfaCode(code);
});

// ── Login ─────────────────────────────────────────────────────────────────────

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = usernameInput.value.trim();
  const password = passwordInput.value;
  if (!username || !password) return;

  setLoginLoading(true);
  hideError();

  const result = await window.kisd.scrape({ username, password });

  setLoginLoading(false);

  if (!result.ok) {
    showError(result.error || 'Something went wrong.');
    return;
  }

  _username = username;
  _password = password;
  renderCourses(result.courses);
  showScreen('courses-screen');
});

function setLoginLoading(on) {
  loginBtn.disabled = on;
  loginBtn.querySelector('.btn-label').classList.toggle('hidden', on);
  loginBtn.querySelector('.btn-spinner').classList.toggle('hidden', !on);
}

function showError(msg) {
  loginError.textContent = msg;
  loginError.classList.remove('hidden');
}

function hideError() {
  loginError.classList.add('hidden');
  loginError.textContent = '';
}

// ── Refresh ───────────────────────────────────────────────────────────────────

refreshBtn.addEventListener('click', () => triggerRefresh());

async function triggerRefresh() {
  refreshBtn.disabled = true;
  setStatus('Re-scraping…');

  const result = await window.kisd.scrape({ username: _username, password: _password });

  clearStatus();
  refreshBtn.disabled = false;

  if (!result.ok) {
    setStatus('Refresh failed: ' + (result.error || 'unknown error'));
    setTimeout(clearStatus, 5000);
    return;
  }

  renderCourses(result.courses);
}

// ── Logout ────────────────────────────────────────────────────────────────────

logoutBtn.addEventListener('click', () => {
  _username = '';
  _password = '';
  _courses  = [];
  usernameInput.value = '';
  passwordInput.value = '';
  courseList.innerHTML = '';
  calGrid.innerHTML = '';
  emptyState.classList.add('hidden');
  calView.classList.add('hidden');
  courseList.classList.remove('hidden');
  listViewBtn.classList.add('active');
  calViewBtn.classList.remove('active');
  clearStatus();
  showScreen('login-screen');
});

// ── Status bar ────────────────────────────────────────────────────────────────

function setStatus(msg) {
  statusText.textContent = msg;
  statusBar.classList.remove('hidden');
}
function clearStatus() { statusBar.classList.add('hidden'); }

// ── Render courses ────────────────────────────────────────────────────────────

function renderCourses(courses) {
  _courses = courses;
  courseList.innerHTML = '';
  emptyState.classList.add('hidden');

  // If calendar view is active, re-render it too
  if (!calView.classList.contains('hidden')) {
    renderCalendar(_courses, _calWeekStart);
  }

  if (!courses || courses.length === 0) {
    emptyState.classList.remove('hidden');
    if (courseCount) courseCount.textContent = '';
    return;
  }

  if (courseCount) courseCount.textContent = `${courses.length} course${courses.length !== 1 ? 's' : ''}`;

  courses.forEach((course) => {
    const card = document.createElement('div');
    card.className = 'course-card';

    // ── Title ──────────────────────────────────────────────────────────────
    const title = document.createElement('div');
    title.className = 'course-title';
    title.textContent = course.title || 'Untitled';
    card.appendChild(title);

    // ── Type + Lecturers row ───────────────────────────────────────────────
    const meta = document.createElement('div');
    meta.className = 'course-meta';

    if (course.courseType) {
      meta.appendChild(makeBadge('type', course.courseType));
    }
    if (course.lecturers && course.lecturers.length > 0) {
      meta.appendChild(makeBadge('person', course.lecturers.join(', ')));
    }

    if (meta.children.length > 0) card.appendChild(meta);

    // ── Schedule block ─────────────────────────────────────────────────────
    const hasSchedule = course.timeframe || course.meetingTimes;
    if (hasSchedule) {
      const scheduleBlock = document.createElement('div');
      scheduleBlock.className = 'schedule-block';

      if (course.timeframe) {
        const tf = document.createElement('div');
        tf.className = 'schedule-row';
        tf.innerHTML = `<span class="schedule-label">Timeframe</span><span class="schedule-value">${escHtml(course.timeframe)}</span>`;
        scheduleBlock.appendChild(tf);
      }

      if (course.meetingTimes) {
        const mt = document.createElement('div');
        mt.className = 'schedule-row';
        mt.innerHTML = `<span class="schedule-label">Meeting Times</span><span class="schedule-value">${escHtml(course.meetingTimes)}</span>`;
        scheduleBlock.appendChild(mt);
      }

      card.appendChild(scheduleBlock);
    }

    courseList.appendChild(card);
  });
}

// ── View toggle ───────────────────────────────────────────────────────────────

listViewBtn.addEventListener('click', () => {
  listViewBtn.classList.add('active');
  calViewBtn.classList.remove('active');
  courseList.classList.remove('hidden');
  emptyState.classList.remove('hidden'); // let existing logic control it
  calView.classList.add('hidden');
  // re-run renderCourses to restore the list correctly
  if (_courses.length) renderCourses(_courses);
});

calViewBtn.addEventListener('click', () => {
  calViewBtn.classList.add('active');
  listViewBtn.classList.remove('active');
  courseList.classList.add('hidden');
  emptyState.classList.add('hidden');
  calView.classList.remove('hidden');
  renderCalendar(_courses, _calWeekStart);
});

// ── Edit modal ────────────────────────────────────────────────────────────────

const editModal      = document.getElementById('edit-modal');
const editTitle      = document.getElementById('edit-title');
const editDesc       = document.getElementById('edit-desc');
const editStart      = document.getElementById('edit-start');
const editEnd        = document.getElementById('edit-end');
const editSessions   = document.getElementById('edit-sessions');
const addSessionBtn  = document.getElementById('add-session-btn');
const modalCloseBtn  = document.getElementById('modal-close-btn');
const modalCancelBtn = document.getElementById('modal-cancel-btn');
const modalSaveBtn   = document.getElementById('modal-save-btn');

function openEditModal(courseKey) {
  _editingKey = courseKey;
  const course = _courses.find((c) => getCourseKey(c) === courseKey);
  if (!course) return;
  const ov = _overrides[courseKey] || {};
  const eff = getEffectiveCourse(course);

  editTitle.value = eff.title || '';
  editDesc.value  = eff.description || '';

  const tf = parseTimeframe(eff.timeframe);
  editStart.value = ov.startDate || (tf ? displayToIso(tf.start.toLocaleDateString('de-DE').replace(/\//g,'.')) : '');
  editEnd.value   = ov.endDate   || (tf ? displayToIso(tf.end.toLocaleDateString('de-DE').replace(/\//g,'.'))   : '');

  // Rebuild date values from timeframe string
  if (!editStart.value && eff.timeframe) {
    const m = eff.timeframe.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
    if (m) editStart.value = `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  }
  if (!editEnd.value && eff.timeframe) {
    const all = [...eff.timeframe.matchAll(/(\d{1,2})\.(\d{1,2})\.(\d{4})/g)];
    const m = all[all.length - 1];
    if (m) editEnd.value = `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  }

  // Populate sessions
  const rawSessions = ov.sessions || parseMeetingTimes(course.meetingTimes).map((s) => ({
    day:   ['Mon','Tue','Wed','Thu','Fri'][s.day] || 'Mon',
    start: fmtMin(s.startMin),
    end:   fmtMin(s.endMin),
  }));
  editSessions.innerHTML = '';
  rawSessions.forEach((s) => addSessionRow(s.day, s.start, s.end));

  editModal.classList.remove('hidden');
  editTitle.focus();
}

function addSessionRow(day = 'Mon', start = '09:00', end = '10:00') {
  const row = document.createElement('div');
  row.className = 'session-row';
  const days = ['Mon','Tue','Wed','Thu','Fri','Daily'];
  row.innerHTML =
    `<select class="session-day">${days.map((d) =>
      `<option${d === day ? ' selected' : ''}>${d}</option>`).join('')}</select>` +
    `<input type="time" class="session-start" value="${start}">` +
    `<span class="sep">–</span>` +
    `<input type="time" class="session-end" value="${end}">` +
    `<button class="btn-ghost session-remove" title="Remove">×</button>`;
  row.querySelector('.session-remove').addEventListener('click', () => row.remove());
  editSessions.appendChild(row);
}

function closeEditModal() {
  editModal.classList.add('hidden');
  _editingKey = null;
}

function saveEdit() {
  if (!_editingKey) return;
  const sessions = [...editSessions.querySelectorAll('.session-row')].map((row) => ({
    day:   row.querySelector('.session-day').value,
    start: row.querySelector('.session-start').value,
    end:   row.querySelector('.session-end').value,
  })).filter((s) => s.start && s.end);

  _overrides[_editingKey] = {
    ..._overrides[_editingKey],
    title:       editTitle.value.trim() || undefined,
    description: editDesc.value,
    startDate:   editStart.value || undefined,
    endDate:     editEnd.value   || undefined,
    sessions:    sessions.length ? sessions : undefined,
  };
  saveOverrides();
  closeEditModal();

  // Re-render whichever view is active
  if (!calView.classList.contains('hidden')) renderCalendar(_courses, _calWeekStart);
  else renderCourses(_courses);
}

addSessionBtn.addEventListener('click',  () => addSessionRow());
modalCloseBtn.addEventListener('click',  closeEditModal);
modalCancelBtn.addEventListener('click', closeEditModal);
modalSaveBtn.addEventListener('click',   saveEdit);
editModal.addEventListener('click', (e) => { if (e.target === editModal) closeEditModal(); });

// ── Week navigation ───────────────────────────────────────────────────────────

calPrev.addEventListener('click', () => {
  _calWeekStart = new Date(_calWeekStart);
  _calWeekStart.setDate(_calWeekStart.getDate() - 7);
  renderCalendar(_courses, _calWeekStart);
});

calNext.addEventListener('click', () => {
  _calWeekStart = new Date(_calWeekStart);
  _calWeekStart.setDate(_calWeekStart.getDate() + 7);
  renderCalendar(_courses, _calWeekStart);
});

// ── Calendar parsing ──────────────────────────────────────────────────────────

const DAY_NAMES  = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
const DAY_MAP    = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
const PALETTE    = ['#e63946', '#4361ee', '#2ec4b6', '#c77dff', '#fb5607', '#3a86ff'];
const CAL_START  = 8;   // 08:00
const CAL_END    = 21;  // 21:00
const HOUR_PX    = 64;  // pixels per hour

function getWeekMonday(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const dow = d.getDay();
  d.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));
  return d;
}

function parseMeetingTimes(str) {
  if (!str) return [];
  const result = [];
  for (const slot of str.split(' · ')) {
    const m = slot.trim().match(
      /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun|Daily)\s+(\d{1,2}):(\d{2})\s*[—–\-]+\s*(\d{1,2}):(\d{2})/
    );
    if (!m) continue;
    const [, dayStr, sh, sm, eh, em] = m;
    const startMin = parseInt(sh) * 60 + parseInt(sm);
    const endMin   = parseInt(eh) * 60 + parseInt(em);
    if (dayStr === 'Daily') {
      for (let d = 0; d <= 4; d++) result.push({ day: d, startMin, endMin });
    } else if (DAY_MAP[dayStr] !== undefined && DAY_MAP[dayStr] <= 4) {
      result.push({ day: DAY_MAP[dayStr], startMin, endMin });
    }
  }
  return result;
}

function parseTimeframe(str) {
  if (!str) return null;
  const m = str.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})\s*[—–\-]+\s*(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (!m) return null;
  return {
    start: new Date(+m[3], +m[2] - 1, +m[1]),
    end:   new Date(+m[6], +m[5] - 1, +m[4]),
  };
}

function fmtMin(totalMin) {
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}

function fmtDate(date) {
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

// ── Calendar render ───────────────────────────────────────────────────────────

function renderCalendar(courses, weekStart) {
  const totalHours = CAL_END - CAL_START;
  const bodyHeight = totalHours * HOUR_PX;

  // Week label
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 4);
  calWeekLabel.textContent =
    `${fmtDate(weekStart)} – ${fmtDate(weekEnd)} ${weekStart.getFullYear()}`;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Build events per day using effective (overridden) course data
  const dayEvents = [[], [], [], [], []]; // Mon–Fri
  courses.forEach((course, idx) => {
    const eff      = getEffectiveCourse(course);
    const tf       = parseTimeframe(eff.timeframe);
    const sessions = parseMeetingTimes(eff.meetingTimes);
    const color    = PALETTE[idx % PALETTE.length];
    const key      = getCourseKey(course);

    sessions.forEach(({ day, startMin, endMin }) => {
      if (day < 0 || day > 4) return;
      // Day date for this session
      const dayDate = new Date(weekStart);
      dayDate.setDate(dayDate.getDate() + day);
      // Only show if course is active on this day
      if (tf && (dayDate < tf.start || dayDate > tf.end)) return;
      dayEvents[day].push({ course, startMin, endMin, color, key });
    });
  });

  // Build HTML
  calGrid.innerHTML = '';

  // Time column
  const timeCol = document.createElement('div');
  timeCol.className = 'cal-time-col';
  const timeHeader = document.createElement('div');
  timeHeader.className = 'cal-time-header';
  timeCol.appendChild(timeHeader);
  const timeSlots = document.createElement('div');
  timeSlots.className = 'cal-time-slots';
  timeSlots.style.height = bodyHeight + 'px';
  for (let h = CAL_START; h <= CAL_END; h++) {
    const lbl = document.createElement('div');
    lbl.className = 'cal-hour-label';
    lbl.style.top = ((h - CAL_START) * HOUR_PX) + 'px';
    lbl.textContent = `${String(h).padStart(2,'0')}:00`;
    timeSlots.appendChild(lbl);
  }
  timeCol.appendChild(timeSlots);
  calGrid.appendChild(timeCol);

  // Days area
  const daysArea = document.createElement('div');
  daysArea.className = 'cal-days-area';

  // Day headers
  const daysHeader = document.createElement('div');
  daysHeader.className = 'cal-days-header';
  for (let d = 0; d < 5; d++) {
    const dayDate = new Date(weekStart);
    dayDate.setDate(dayDate.getDate() + d);
    const isToday = dayDate.getTime() === today.getTime();
    const hdr = document.createElement('div');
    hdr.className = 'cal-day-header' + (isToday ? ' today' : '');
    hdr.innerHTML =
      `<span class="day-name">${DAY_NAMES[d]}</span>` +
      `<span class="day-date">${dayDate.getDate()} ${dayDate.toLocaleString('en-GB',{month:'short'})}</span>`;
    daysHeader.appendChild(hdr);
  }
  daysArea.appendChild(daysHeader);

  // Day body
  const daysBody = document.createElement('div');
  daysBody.className = 'cal-days-body';
  daysBody.style.height = bodyHeight + 'px';

  // Hour background lines (spans all day columns)
  for (let h = 0; h <= totalHours; h++) {
    const line = document.createElement('div');
    line.className = 'cal-hour-bg';
    line.style.top = (h * HOUR_PX) + 'px';
    line.style.position = 'absolute';
    line.style.left = '0'; line.style.right = '0';
    daysBody.appendChild(line);
    if (h < totalHours) {
      const half = document.createElement('div');
      half.className = 'cal-half-bg';
      half.style.top = (h * HOUR_PX + HOUR_PX / 2) + 'px';
      half.style.position = 'absolute';
      half.style.left = '0'; half.style.right = '0';
      daysBody.appendChild(half);
    }
  }

  // Day columns with events
  for (let d = 0; d < 5; d++) {
    const col = document.createElement('div');
    col.className = 'cal-day-col';
    col.style.height = bodyHeight + 'px';

    dayEvents[d].forEach(({ course, startMin, endMin, color, key }) => {
      const top    = (startMin / 60 - CAL_START) * HOUR_PX;
      const height = Math.max(((endMin - startMin) / 60) * HOUR_PX - 4, 20);
      const eff = getEffectiveCourse(course);
      const ev = document.createElement('div');
      ev.className = 'cal-event';
      ev.style.cssText =
        `top:${top}px; height:${height}px; background:${color}cc; border-left-color:${color};`;
      ev.innerHTML =
        `<div class="cal-event-title">${escHtml(eff.title)}</div>` +
        `<div class="cal-event-time">${fmtMin(startMin)} – ${fmtMin(endMin)}</div>`;
      ev.addEventListener('click', () => openEditModal(key));
      col.appendChild(ev);
    });

    daysBody.appendChild(col);
  }

  daysArea.appendChild(daysBody);
  calGrid.appendChild(daysArea);

  // ── Missing-info section below grid ────────────────────────────────────────
  const missingEl = document.getElementById('missing-section');
  const missing   = courses.filter((c) => !hasPlaceableSessions(c));

  if (missing.length === 0) {
    missingEl.classList.add('hidden');
    return;
  }

  missingEl.classList.remove('hidden');
  missingEl.innerHTML =
    `<div class="missing-header">No schedule info — click to add times</div>` +
    `<div class="missing-cards" id="missing-cards"></div>`;
  const cardsEl = missingEl.querySelector('#missing-cards');

  missing.forEach((course) => {
    const eff  = getEffectiveCourse(course);
    const key  = getCourseKey(course);
    const card = document.createElement('div');
    card.className = 'missing-card';
    card.innerHTML =
      `<div class="missing-card-title">${escHtml(eff.title)}</div>` +
      (eff.timeframe
        ? `<div class="missing-card-meta">${escHtml(eff.timeframe)}</div>`
        : '') +
      (eff.lecturers && eff.lecturers.length
        ? `<div class="missing-card-meta">${escHtml(eff.lecturers.join(', '))}</div>`
        : '') +
      `<div class="missing-card-hint">+ Add meeting times</div>`;
    card.addEventListener('click', () => openEditModal(key));
    cardsEl.appendChild(card);
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeBadge(kind, text) {
  const icons = { type: '◆', person: '↳' };
  const b = document.createElement('span');
  b.className = `badge badge-${kind}`;

  const ic = document.createElement('span');
  ic.className = 'badge-icon';
  ic.textContent = icons[kind] || '•';

  const tx = document.createElement('span');
  tx.textContent = text;

  b.appendChild(ic);
  b.appendChild(tx);
  return b;
}

function escHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
