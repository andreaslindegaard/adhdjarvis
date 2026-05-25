(() => {
  if ('scrollRestoration' in history) {
    history.scrollRestoration = 'manual';
  }

  let bootScrollToToday = true;
  const bootScrollEnd = Date.now() + 4000;

  function scrollToTodayOnBoot() {
    if (!bootScrollToToday || Date.now() > bootScrollEnd) return;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        scrollCalendarToToday('auto');
      });
    });
  }

  function disableBootScroll() {
    bootScrollToToday = false;
  }
  ['pointerdown', 'wheel', 'keydown'].forEach((evt) => {
    document.addEventListener(evt, disableBootScroll, { once: true, passive: true });
  });
  setTimeout(() => {
    bootScrollToToday = false;
  }, 4000);

  // ---- Supabase (publishable key + RLS on planner_data) ----
  const SUPABASE_CONFIG = {
    url: 'https://wavyqvbsaoahbulkunbq.supabase.co',
    key: 'sb_publishable_qs8Q-O3K-7Bn538WRHwEqA_dAHDuYZs'
  };

  // Deploy: bump SW_SCRIPT_VERSION with CACHE_NAME in sw.js; bump ?v= on app.js / supabase-sync.js in index.html when those files change.
  const SW_SCRIPT_VERSION = 55;

  let syncReady = false;
  let syncListeners = []; // to unsubscribe on sign-out
  /** Last applied server `updated_at` per planner_data key (ms); drops stale realtime/duplicate payloads */
  let lastRemoteWriteAt = {};

  // ---- Data layer ----
  const STORAGE_KEY = 'endless-planner-notes';
  const RECURRING_KEY = 'endless-planner-recurring';
  const SMARTLINKS_KEY = 'endless-planner-smartlinks';
  const LAYOUT_KEY = 'endless-planner-layout';
  const STANDALONE_TODOS_KEY = 'endless-planner-standalone-todos';
  const PUSHUP_WIDGET_KEY = 'endless-planner-pushup-widget';
  const DEFAULT_PUSHUP_YEAR_GOAL = 10000;
  const DEFAULT_PUSHUP_MONTH_GOAL = 800;
  const PUSHUP_SET_WINDOW_MS = 5 * 1000;

  function loadNotes() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
    } catch { return {}; }
  }

  function saveNotes(data) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    if (syncReady) SupabaseSync.save('notes', data);
  }

  function loadRecurring() {
    try {
      return JSON.parse(localStorage.getItem(RECURRING_KEY)) || [];
    } catch { return []; }
  }

  function saveRecurring() {
    localStorage.setItem(RECURRING_KEY, JSON.stringify(recurring));
    if (syncReady) SupabaseSync.save('recurring', recurring);
  }

  // ---- Smart Links: keyword -> auto-attach URL ----
  function loadSmartLinks() {
    try {
      return JSON.parse(localStorage.getItem(SMARTLINKS_KEY)) || null;
    } catch { return null; }
  }

  function saveSmartLinks() {
    localStorage.setItem(SMARTLINKS_KEY, JSON.stringify(smartLinks));
    if (syncReady) SupabaseSync.save('smartLinks', smartLinks);
  }

  function loadStandaloneTodos() {
    try {
      return JSON.parse(localStorage.getItem(STANDALONE_TODOS_KEY)) || [];
    } catch { return []; }
  }

  function saveStandaloneTodos() {
    localStorage.setItem(STANDALONE_TODOS_KEY, JSON.stringify(standaloneTodos));
    if (syncReady) SupabaseSync.save('standaloneTodos', standaloneTodos);
  }

  function normalizePushupWidget(raw) {
    const data = raw && typeof raw === 'object' ? raw : {};
    const sets = Array.isArray(data.sets) ? data.sets : [];
    const parsedYearGoal = Number.parseInt(data.yearGoal, 10);
    const parsedMonthGoal = Number.parseInt(data.monthGoal, 10);
    return {
      enabled: !!data.enabled,
      yearGoal: Number.isFinite(parsedYearGoal) ? Math.max(0, parsedYearGoal) : DEFAULT_PUSHUP_YEAR_GOAL,
      monthGoal: Number.isFinite(parsedMonthGoal) ? Math.max(0, parsedMonthGoal) : DEFAULT_PUSHUP_MONTH_GOAL,
      statsOpen: !!data.statsOpen,
      sets: sets
        .map((set) => {
          const count = Math.max(0, Number.parseInt(set.count, 10) || 0);
          const startedAt = set.startedAt || set.at || set.updatedAt || new Date().toISOString();
          const updatedAt = set.updatedAt || startedAt;
          return {
            id: set.id || crypto.randomUUID(),
            startedAt,
            updatedAt,
            count
          };
        })
        .filter(set => set.count > 0),
      lastRecord: data.lastRecord && typeof data.lastRecord === 'object' ? data.lastRecord : null
    };
  }

  function loadPushupWidget() {
    try {
      return normalizePushupWidget(JSON.parse(localStorage.getItem(PUSHUP_WIDGET_KEY)));
    } catch {
      return normalizePushupWidget(null);
    }
  }

  function savePushupWidget() {
    pushupWidget = normalizePushupWidget(pushupWidget);
    localStorage.setItem(PUSHUP_WIDGET_KEY, JSON.stringify(pushupWidget));
    pushupLocalWriteAt = Date.now();
    if (syncReady) SupabaseSync.save('pushupWidget', pushupWidget);
  }

  const defaultSmartLinks = [
    {
      keywords: ['hairdresser', 'hairdressers', 'cut my hair', 'haircut', 'hair cut', 'fris\u00f8r', 'frisor'],
      url: 'https://haarcafeen.dk/herre/',
      label: 'haarcafeen.dk'
    }
  ];

  let smartLinks = loadSmartLinks() || defaultSmartLinks;
  if (!loadSmartLinks()) saveSmartLinks();

  function loadLayout() {
    try {
      return JSON.parse(localStorage.getItem(LAYOUT_KEY)) || { mode: 'split', activeTab: 'calendar' };
    } catch { return { mode: 'split', activeTab: 'calendar' }; }
  }

  function saveLayout() {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layoutState));
  }

  let layoutState = loadLayout();

  function applySmartLinks(text) {
    const lower = text.toLowerCase();
    for (const rule of smartLinks) {
      const matched = rule.keywords.some(kw => lower.includes(kw.toLowerCase()));
      if (matched && !text.includes(rule.url)) {
        return text + ' ' + rule.url;
      }
    }
    return text;
  }

  // notes structure: { "2026-03-29": [ { id, text, done, time } ] }
  let notes = loadNotes();

  let standaloneTodos = loadStandaloneTodos();
  let todoPanelCompletedExpanded = false;

  let pushupWidget = loadPushupWidget();
  let pushupCountdownTimer = null;
  let pushupLocalWriteAt = 0;

  // recurring structure: [ { id, text, time, startDate, doneDate } ] — checkbox completes the series (removed); doneDate unused for that path; delete (×) also removes
  let recurring = loadRecurring();

  // ---- Date helpers ----
  const WEEKDAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

  function dateKey(d) {
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }

  function parseDate(key) {
    const [y,m,d] = key.split('-').map(Number);
    return new Date(y, m-1, d);
  }

  function isToday(key) {
    return key === dateKey(new Date());
  }

  function isWeekend(d) {
    const day = d.getDay();
    return day === 0 || day === 6;
  }

  function getISOWeekNumber(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  }

  function getISOWeekKey(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    return `${d.getUTCFullYear()}-W${String(getISOWeekNumber(date)).padStart(2, '0')}`;
  }

  function formatNumber(n) {
    return new Intl.NumberFormat('da-DK').format(n || 0);
  }

  function getPushupSetDate(set) {
    const raw = set.startedAt || set.updatedAt;
    const d = raw ? new Date(raw) : new Date();
    return Number.isNaN(d.getTime()) ? new Date() : d;
  }

  function getLatestPushupSet() {
    if (!pushupWidget.sets.length) return null;
    return pushupWidget.sets.reduce((latest, set) => {
      if (!latest) return set;
      const latestTime = new Date(latest.updatedAt || latest.startedAt || 0).getTime();
      const setTime = new Date(set.updatedAt || set.startedAt || 0).getTime();
      return setTime > latestTime ? set : latest;
    }, null);
  }

  function getPushupSetUpdatedTime(set) {
    const time = new Date(set?.updatedAt || set?.startedAt || 0).getTime();
    return Number.isNaN(time) ? 0 : time;
  }

  function getPushupRecordTime(record) {
    const time = new Date(record?.at || 0).getTime();
    return Number.isNaN(time) ? 0 : time;
  }

  function mergePushupWidgetData(localRaw, remoteRaw) {
    const local = normalizePushupWidget(localRaw);
    const remote = normalizePushupWidget(remoteRaw);
    const setsById = new Map(remote.sets.map(set => [set.id, set]));

    for (const localSet of local.sets) {
      const remoteSet = setsById.get(localSet.id);
      if (!remoteSet || getPushupSetUpdatedTime(localSet) > getPushupSetUpdatedTime(remoteSet)) {
        setsById.set(localSet.id, localSet);
      }
    }

    const localRecordTime = getPushupRecordTime(local.lastRecord);
    const remoteRecordTime = getPushupRecordTime(remote.lastRecord);

    return {
      ...remote,
      statsOpen: local.statsOpen,
      sets: Array.from(setsById.values()).sort((a, b) => getPushupSetUpdatedTime(a) - getPushupSetUpdatedTime(b)),
      lastRecord: localRecordTime > remoteRecordTime ? local.lastRecord : remote.lastRecord
    };
  }

  function getActivePushupSet(now = new Date()) {
    const latest = getLatestPushupSet();
    if (!latest) return null;
    const updatedAt = new Date(latest.updatedAt || latest.startedAt || 0);
    if (Number.isNaN(updatedAt.getTime())) return null;
    if (dateKey(updatedAt) !== dateKey(now)) return null;
    return now - updatedAt <= PUSHUP_SET_WINDOW_MS ? latest : null;
  }

  function getPushupSetRemainingMs(set, now = new Date()) {
    if (!set) return 0;
    const updatedAt = new Date(set.updatedAt || set.startedAt || 0);
    if (Number.isNaN(updatedAt.getTime())) return 0;
    return Math.max(0, PUSHUP_SET_WINDOW_MS - (now.getTime() - updatedAt.getTime()));
  }

  function getPushupStats(now = new Date()) {
    const dayTotals = new Map();
    const weekTotals = new Map();
    const monthTotals = new Map();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth();
    const currentWeekKey = getISOWeekKey(now);
    const yesterdayKey = addDaysToDateKey(dateKey(now), -1);
    let todayTotal = 0;
    let yesterdayTotal = 0;
    let weekTotal = 0;
    let monthTotal = 0;
    let yearTotal = 0;
    let allTimeTotal = 0;
    let bestSet = { count: 0, date: '' };

    for (const set of pushupWidget.sets) {
      const count = Math.max(0, Number.parseInt(set.count, 10) || 0);
      if (!count) continue;
      const setDate = getPushupSetDate(set);
      const day = dateKey(setDate);
      const week = getISOWeekKey(setDate);
      const month = `${setDate.getFullYear()}-${String(setDate.getMonth() + 1).padStart(2, '0')}`;

      dayTotals.set(day, (dayTotals.get(day) || 0) + count);
      weekTotals.set(week, (weekTotals.get(week) || 0) + count);
      monthTotals.set(month, (monthTotals.get(month) || 0) + count);
      allTimeTotal += count;
      if (setDate.getFullYear() === currentYear) yearTotal += count;
      if (setDate.getFullYear() === currentYear && setDate.getMonth() === currentMonth) monthTotal += count;
      if (week === currentWeekKey) weekTotal += count;
      if (day === dateKey(now)) todayTotal += count;
      if (day === yesterdayKey) yesterdayTotal += count;
      if (count > bestSet.count) bestSet = { count, date: day };
    }

    let bestDay = { count: 0, key: '' };
    for (const [key, count] of dayTotals.entries()) {
      if (count > bestDay.count) bestDay = { count, key };
    }

    let bestWeek = { count: 0, key: '' };
    for (const [key, count] of weekTotals.entries()) {
      if (count > bestWeek.count) bestWeek = { count, key };
    }

    let bestMonth = { count: 0, key: '' };
    for (const [key, count] of monthTotals.entries()) {
      if (count > bestMonth.count) bestMonth = { count, key };
    }

    const monthGoal = Math.max(0, Number.parseInt(pushupWidget.monthGoal, 10) || 0);
    const monthRemaining = Math.max(0, monthGoal - monthTotal);
    const monthProgress = monthGoal > 0 ? Math.min(100, Math.round((monthTotal / monthGoal) * 100)) : 0;
    const yearGoal = Math.max(0, Number.parseInt(pushupWidget.yearGoal, 10) || 0);
    const yearRemaining = Math.max(0, yearGoal - yearTotal);
    const yearProgress = yearGoal > 0 ? Math.min(100, Math.round((yearTotal / yearGoal) * 100)) : 0;
    const yearStartUtc = Date.UTC(currentYear, 0, 1);
    const nextYearUtc = Date.UTC(currentYear + 1, 0, 1);
    const todayUtc = Date.UTC(currentYear, now.getMonth(), now.getDate());
    const daysInYear = Math.round((nextYearUtc - yearStartUtc) / 86400000);
    const dayOfYear = Math.floor((todayUtc - yearStartUtc) / 86400000) + 1;
    const daysRemainingInYear = Math.max(1, daysInYear - dayOfYear + 1);
    const yearExpectedByToday = yearGoal > 0
      ? Math.round((yearGoal * dayOfYear) / daysInYear)
      : 0;
    const yearPaceDelta = yearGoal > 0 ? yearTotal - yearExpectedByToday : 0;
    const yearDailyNeeded = yearGoal > 0 && yearRemaining > 0
      ? yearRemaining / daysRemainingInYear
      : 0;

    return {
      todayTotal,
      yesterdayTotal,
      weekTotal,
      monthTotal,
      yearTotal,
      allTimeTotal,
      bestSet,
      bestDay,
      bestWeek,
      bestMonth,
      monthGoal,
      monthRemaining,
      monthProgress,
      yearGoal,
      yearRemaining,
      yearProgress,
      yearPaceDelta,
      yearDailyNeeded,
      daysRemainingInYear
    };
  }

  function addPushupRep() {
    const now = new Date();
    const previousBestSet = getPushupStats(now).bestSet.count;
    let set = getActivePushupSet(now);

    if (!set) {
      set = {
        id: crypto.randomUUID(),
        startedAt: now.toISOString(),
        updatedAt: now.toISOString(),
        count: 0
      };
      pushupWidget.sets.push(set);
    }

    set.count += 1;
    set.updatedAt = now.toISOString();

    if (set.count > previousBestSet) {
      pushupWidget.lastRecord = {
        type: 'set',
        setId: set.id,
        count: set.count,
        at: now.toISOString()
      };
    }

    savePushupWidget();
  }

  // ---- Danish holidays (helligdage) ----
  function computeEaster(year) {
    const a = year % 19;
    const b = Math.floor(year / 100);
    const c = year % 100;
    const d = Math.floor(b / 4);
    const e = b % 4;
    const f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4);
    const k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31);
    const day = ((h + l - 7 * m + 114) % 31) + 1;
    return new Date(year, month - 1, day);
  }

  const holidayCache = {};

  function getDanishHolidays(year) {
    if (holidayCache[year]) return holidayCache[year];

    const holidays = {};
    const easter = computeEaster(year);

    function addDays(date, days) {
      const d = new Date(date);
      d.setDate(d.getDate() + days);
      return d;
    }

    function add(date, name) {
      holidays[dateKey(date)] = name;
    }

    // Fixed holidays
    add(new Date(year, 0, 1), 'Nytårsdag');
    add(new Date(year, 5, 5), 'Grundlovsdag / Fars dag');
    add(new Date(year, 11, 24), 'Juleaften');
    add(new Date(year, 11, 25), '1. Juledag');
    add(new Date(year, 11, 26), '2. Juledag');
    add(new Date(year, 11, 31), 'Nytårsaften');

    // Movable holidays (Easter-based)
    add(addDays(easter, -49), 'Fastelavn');
    add(addDays(easter, -3), 'Skærtorsdag');
    add(addDays(easter, -2), 'Langfredag');
    add(easter, 'Påskedag');
    add(addDays(easter, 1), '2. Påskedag');
    if (year <= 2023) {
      add(addDays(easter, 26), 'Store Bededag');
    }
    add(addDays(easter, 39), 'Kr. Himmelfartsdag');
    add(addDays(easter, 49), 'Pinsedag');
    add(addDays(easter, 50), '2. Pinsedag');

    // Mors dag: 2. søndag i maj
    const mayFirst = new Date(year, 4, 1);
    const morsDag = new Date(year, 4, (7 - mayFirst.getDay()) % 7 + 8);
    add(morsDag, 'Mors dag');

    holidayCache[year] = holidays;
    return holidays;
  }

  function getHolidayName(key) {
    const year = parseInt(key.split('-')[0]);
    const holidays = getDanishHolidays(year);
    return holidays[key] || null;
  }

  function getDateRange() {
    const today = new Date();
    let start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    let end = new Date(today.getFullYear() + 2, today.getMonth() + 1, 0);

    const noteKeys = Object.keys(notes).filter(k => notes[k] && notes[k].length > 0).sort();
    if (noteKeys.length > 0) {
      const earliest = parseDate(noteKeys[0]);
      const latest = parseDate(noteKeys[noteKeys.length - 1]);
      if (earliest < start) start = new Date(earliest.getFullYear(), earliest.getMonth(), 1);
      if (latest > end) end = new Date(latest.getFullYear(), latest.getMonth() + 1, 0);
    }

    return { start, end };
  }

  // ---- Rendering ----
  const doc = document.getElementById('plannerRoot');
  const calendarTabLayout = document.getElementById('calendarTabLayout');
  const calendarTodoPanel = document.getElementById('calendarTodoPanel');
  const searchBox = document.getElementById('searchBox');
  let searchTerm = '';

  function highlightText(text) {
    if (!searchTerm) return escapeHtml(text);
    const escaped = escapeHtml(text);
    const regex = new RegExp(`(${escapeRegex(searchTerm)})`, 'gi');
    return escaped.replace(regex, '<span class="search-highlight">$1</span>');
  }

  function escapeHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function getBrowserTimeZone() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
      return 'UTC';
    }
  }

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function plainCalendarText(text) {
    return String(text || '')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/^\s*[-*]\s+/gm, '')
      .replace(/^\s*\d+\.\s+/gm, '')
      .replace(/\s+/g, ' ')
      .trim() || 'ADHD Jarvis event';
  }

  function addDaysToDateKey(key, days) {
    const d = parseDate(key);
    d.setDate(d.getDate() + days);
    return dateKey(d);
  }

  function makeCalendarDate(date, time) {
    const d = parseDate(date);
    if (time) {
      const [hours, minutes] = String(time).split(':').map(Number);
      d.setHours(hours || 0, minutes || 0, 0, 0);
    }
    return d;
  }

  function addMinutes(date, minutes) {
    return new Date(date.getTime() + minutes * 60000);
  }

  function formatCompactDate(key) {
    return key.replace(/-/g, '');
  }

  function formatCompactDateTime(date) {
    return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}T${pad2(date.getHours())}${pad2(date.getMinutes())}00`;
  }

  function buildCalendarRRule(event) {
    const src = event.recurring || event;
    const freq = src.frequency;
    const dayNames = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
    if (freq === 'daily') return 'FREQ=DAILY';
    if (freq === 'weekly') return `FREQ=WEEKLY;BYDAY=${dayNames[src.dayOfWeek ?? parseDate(event.date).getDay()]}`;
    if (freq === 'biweekly') return `FREQ=WEEKLY;INTERVAL=2;BYDAY=${dayNames[src.dayOfWeek ?? parseDate(event.date).getDay()]}`;
    if (freq === 'monthly') return `FREQ=MONTHLY;BYMONTHDAY=${src.dayOfMonth ?? parseDate(event.date).getDate()}`;
    if (freq === 'yearly') {
      const d = parseDate(event.date);
      return `FREQ=YEARLY;BYMONTH=${(src.month ?? d.getMonth()) + 1};BYMONTHDAY=${src.dayOfMonth ?? d.getDate()}`;
    }
    return null;
  }

  function getCalendarEventForAction(date, id, recurringId) {
    if (recurringId) {
      const rec = recurring.find(r => r.id === recurringId);
      if (!rec) return null;
      return {
        id: rec.id,
        date: rec.startDate || date,
        occurrenceDate: date,
        text: rec.text,
        time: rec.time || null,
        leadTime: rec.leadTime ?? null,
        recurring: rec
      };
    }
    const note = (notes[date] || []).find(n => n.id === id);
    if (!note) return null;
    return {
      id: note.id,
      date,
      text: note.text,
      time: note.time || null,
      leadTime: note.leadTime ?? null
    };
  }

  function buildGoogleCalendarUrl(event) {
    const params = new URLSearchParams();
    const title = plainCalendarText(event.text);
    params.set('action', 'TEMPLATE');
    params.set('text', title);
    params.set('details', 'Created from ADHD Jarvis');
    params.set('ctz', getBrowserTimeZone());

    if (event.time) {
      const start = makeCalendarDate(event.date, event.time);
      const end = addMinutes(start, 60);
      params.set('dates', `${formatCompactDateTime(start)}/${formatCompactDateTime(end)}`);
    } else {
      params.set('dates', `${formatCompactDate(event.date)}/${formatCompactDate(addDaysToDateKey(event.date, 1))}`);
    }

    const rrule = buildCalendarRRule(event);
    if (rrule) params.set('recur', `RRULE:${rrule}`);

    return `https://calendar.google.com/calendar/render?${params.toString()}`;
  }

  function escapeIcsText(value) {
    return plainCalendarText(value)
      .replace(/\\/g, '\\\\')
      .replace(/\n/g, '\\n')
      .replace(/,/g, '\\,')
      .replace(/;/g, '\\;');
  }

  function foldIcsLine(line) {
    if (line.length <= 75) return line;
    const parts = [];
    let rest = line;
    while (rest.length > 75) {
      parts.push(rest.slice(0, 75));
      rest = ' ' + rest.slice(75);
    }
    parts.push(rest);
    return parts.join('\r\n');
  }

  function formatIcsDateTime(date) {
    return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}T${pad2(date.getHours())}${pad2(date.getMinutes())}00`;
  }

  function formatIcsUtcDateTime(date) {
    return `${date.getUTCFullYear()}${pad2(date.getUTCMonth() + 1)}${pad2(date.getUTCDate())}T${pad2(date.getUTCHours())}${pad2(date.getUTCMinutes())}${pad2(date.getUTCSeconds())}Z`;
  }

  function collectGoogleCalendarEvents() {
    const events = [];
    for (const [date, dayNotes] of Object.entries(notes)) {
      if (!Array.isArray(dayNotes)) continue;
      dayNotes
        .filter(note => note && note.isEvent === true && !note.smartList)
        .forEach(note => events.push({
          id: note.id,
          date,
          text: note.text,
          time: note.time || null,
          leadTime: note.leadTime ?? null
        }));
    }
    recurring
      .filter(rec => rec && rec.isEvent === true)
      .forEach(rec => events.push({
        id: rec.id,
        date: rec.startDate,
        text: rec.text,
        time: rec.time || null,
        leadTime: rec.leadTime ?? null,
        recurring: rec
      }));
    return events.sort((a, b) => `${a.date} ${a.time || ''}`.localeCompare(`${b.date} ${b.time || ''}`));
  }

  function buildIcsEvent(event, nowStamp, tz) {
    const lines = [
      'BEGIN:VEVENT',
      `UID:adhd-jarvis-${event.id}@local`,
      `DTSTAMP:${nowStamp}`,
      `SUMMARY:${escapeIcsText(event.text)}`,
      'DESCRIPTION:Created from ADHD Jarvis'
    ];

    if (event.time) {
      const start = makeCalendarDate(event.date, event.time);
      const end = addMinutes(start, 60);
      lines.push(`DTSTART;TZID=${tz}:${formatIcsDateTime(start)}`);
      lines.push(`DTEND;TZID=${tz}:${formatIcsDateTime(end)}`);
    } else {
      lines.push(`DTSTART;VALUE=DATE:${formatCompactDate(event.date)}`);
      lines.push(`DTEND;VALUE=DATE:${formatCompactDate(addDaysToDateKey(event.date, 1))}`);
    }

    const rrule = buildCalendarRRule(event);
    if (rrule) lines.push(`RRULE:${rrule}`);

    if (event.leadTime && event.time) {
      lines.push('BEGIN:VALARM');
      lines.push(`TRIGGER:-PT${event.leadTime}M`);
      lines.push('ACTION:DISPLAY');
      lines.push(`DESCRIPTION:${escapeIcsText(event.text)}`);
      lines.push('END:VALARM');
    }

    lines.push('END:VEVENT');
    return lines.map(foldIcsLine).join('\r\n');
  }

  function downloadGoogleCalendarIcs() {
    const events = collectGoogleCalendarEvents();
    if (events.length === 0) {
      alert('No calendar events to export yet.');
      return;
    }

    const tz = getBrowserTimeZone();
    const nowStamp = formatIcsUtcDateTime(new Date());
    const body = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//ADHD Jarvis//Planner//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      `X-WR-CALNAME:ADHD Jarvis`,
      `X-WR-TIMEZONE:${tz}`,
      ...events.map(event => buildIcsEvent(event, nowStamp, tz)),
      'END:VCALENDAR'
    ].join('\r\n');

    const blob = new Blob([body], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `adhd-jarvis-google-calendar-${dateKey(new Date())}.ics`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function isGoogleCalendarAutoSendEnabled() {
    try {
      return !!loadNotifSettings().googleCalendarAutoSend;
    } catch {
      return false;
    }
  }

  function maybeAutoSendEventToGoogleCalendar(event) {
    if (!isGoogleCalendarAutoSendEnabled()) return;
    window.open(buildGoogleCalendarUrl(event), '_blank', 'noopener');
  }

  function renderTagsInText(text) {
    return text.replace(/#(\w+)/g, '<span class="note-tag">#$1</span>');
  }

  function linkifyUrls(text) {
    return text.replace(/(https?:\/\/[^\s<]+)/g, (url) => {
      try {
        const parsed = new URL(url);
        const domain = parsed.hostname.replace(/^www\./, '');
        return `<span class="link-wrap"><a href="${url}" target="_blank" rel="noopener" class="note-link" title="${url}">${domain}</a><button class="link-delete" data-url="${url}" title="Fjern link">&times;</button></span>`;
      } catch {
        return `<span class="link-wrap"><a href="${url}" target="_blank" rel="noopener" class="note-link">${url}</a><button class="link-delete" data-url="${url}" title="Fjern link">&times;</button></span>`;
      }
    });
  }

  function applySearchHighlight(escapedText) {
    if (!searchTerm) return escapedText;
    const regex = new RegExp(`(${escapeRegex(searchTerm)})`, 'gi');
    return escapedText.replace(regex, '<span class="search-highlight">$1</span>');
  }

  function renderInlineRichText(text) {
    let html = applySearchHighlight(escapeHtml(text));
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = renderTagsInText(html);
    html = linkifyUrls(html);
    return html;
  }

  function renderRichText(text) {
    const lines = (text || '').split('\n');
    const blocks = [];
    let listType = null;

    function closeList() {
      if (listType) {
        blocks.push(`</${listType}>`);
        listType = null;
      }
    }

    for (const line of lines) {
      const bulletMatch = line.match(/^\s*[-*]\s+(.+)/);
      const numberedMatch = line.match(/^\s*\d+\.\s+(.+)/);

      if (bulletMatch) {
        if (listType !== 'ul') {
          closeList();
          blocks.push('<ul>');
          listType = 'ul';
        }
        blocks.push(`<li>${renderInlineRichText(bulletMatch[1])}</li>`);
        continue;
      }

      if (numberedMatch) {
        if (listType !== 'ol') {
          closeList();
          blocks.push('<ol>');
          listType = 'ol';
        }
        blocks.push(`<li>${renderInlineRichText(numberedMatch[1])}</li>`);
        continue;
      }

      closeList();
      blocks.push(`<div>${renderInlineRichText(line)}</div>`);
    }

    closeList();
    return blocks.join('');
  }

  function formatTodoPanelDate(key) {
    if (!key) return '';
    const today = dateKey(new Date());
    if (key === today) return 'Today';
    if (key === addDaysToDateKey(today, 1)) return 'Tomorrow';
    const d = parseDate(key);
    return `${WEEKDAYS[d.getDay()].slice(0, 3)} ${MONTHS[d.getMonth()].slice(0, 3)} ${d.getDate()}`;
  }

  function compareTodoPanelTasks(a, b) {
    const standaloneRankA = a.kind === 'standalone' ? 0 : 1;
    const standaloneRankB = b.kind === 'standalone' ? 0 : 1;
    if (standaloneRankA !== standaloneRankB) return standaloneRankA - standaloneRankB;
    if (a.kind === 'standalone' && b.kind === 'standalone') {
      const createdA = a.createdAt || '';
      const createdB = b.createdAt || '';
      if (createdA !== createdB) return createdA.localeCompare(createdB);
    }
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    const timeA = a.time || '99:99';
    const timeB = b.time || '99:99';
    if (timeA !== timeB) return timeA.localeCompare(timeB);
    return (a.text || a.sourceTitle || '').localeCompare((b.text || b.sourceTitle || ''), 'da');
  }

  function getTodoPanelCompletedTime(task) {
    const completedTime = Date.parse(task.completedAt || '');
    if (Number.isFinite(completedTime)) return completedTime;

    const dateTime = Date.parse(`${task.date || ''}T${task.time || '23:59'}`);
    if (Number.isFinite(dateTime)) return dateTime;

    const createdTime = Date.parse(task.createdAt || '');
    return Number.isFinite(createdTime) ? createdTime : 0;
  }

  function compareCompletedTodoPanelTasks(a, b) {
    const timeDiff = getTodoPanelCompletedTime(b) - getTodoPanelCompletedTime(a);
    if (timeDiff !== 0) return timeDiff;
    return compareTodoPanelTasks(a, b);
  }

  function collectTodoPanelTasks() {
    const tasks = standaloneTodos.map(todo => ({
      kind: 'standalone',
      date: '',
      id: todo.id,
      itemId: '',
      text: todo.text || '',
      done: !!todo.done,
      time: '',
      sourceTitle: '',
      createdAt: todo.createdAt || '',
      completedAt: todo.completedAt || ''
    }));
    for (const key of Object.keys(notes).sort()) {
      const dayNotes = sortNotesByTime(notes[key] || []);
      for (const note of dayNotes) {
        if (note.smartList === 'todo') {
          const items = Array.isArray(note.listItems) ? note.listItems : [];
          for (const item of items) {
            tasks.push({
              kind: 'smart',
              date: key,
              id: note.id,
              itemId: item.id,
              text: item.text || '',
              done: !!item.done,
              time: note.time || '',
              sourceTitle: note.text || '',
              completedAt: item.completedAt || ''
            });
          }
          continue;
        }

        if (!note.isEvent && !note.smartList) {
          tasks.push({
            kind: 'note',
            date: key,
            id: note.id,
            itemId: '',
            text: note.text || '',
            done: !!note.done,
            time: note.time || '',
            sourceTitle: '',
            completedAt: note.completedAt || ''
          });
        }
      }
    }
    return tasks.sort(compareTodoPanelTasks);
  }

  function renderTodoPanelTask(task) {
    const checked = task.done ? 'checked' : '';
    const doneClass = task.done ? ' is-completed' : '';
    const itemAttr = task.itemId ? ` data-item-id="${escapeHtml(task.itemId)}"` : '';
    const taskAttrs = ` data-kind="${escapeHtml(task.kind)}" data-date="${escapeHtml(task.date)}" data-id="${escapeHtml(task.id)}"${itemAttr}`;
    const deleteButton = task.kind === 'standalone'
      ? `<button type="button" class="calendar-todo-delete" data-action="delete-todo" data-id="${escapeHtml(task.id)}" title="Delete task" aria-label="Delete task">&times;</button>`
      : '';
    const textHtml = (task.text || '').trim()
      ? renderRichText(task.text)
      : '<span class="smart-list-item-placeholder">Empty item</span>';
    const sourceHtml = task.sourceTitle
      ? `<span class="calendar-todo-source">${applySearchHighlight(escapeHtml(task.sourceTitle))}</span>`
      : '';
    const timeHtml = task.time ? `<span>${escapeHtml(task.time)}</span>` : '';
    const dateHtml = task.date ? `<span>${escapeHtml(formatTodoPanelDate(task.date))}</span>` : '';
    const metaHtml = dateHtml || timeHtml || sourceHtml
      ? `<div class="calendar-todo-meta">
          ${dateHtml}
          ${timeHtml}
          ${sourceHtml}
        </div>`
      : '';

    return `<div class="calendar-todo-item${doneClass}"${taskAttrs}>
      <input type="checkbox" class="calendar-todo-checkbox" ${checked} data-kind="${escapeHtml(task.kind)}" data-date="${escapeHtml(task.date)}" data-id="${escapeHtml(task.id)}"${itemAttr} aria-label="Toggle task">
      <div class="calendar-todo-content">
        <div class="calendar-todo-text" data-action="edit-todo" tabindex="0" title="Edit task">${textHtml}</div>
        ${metaHtml}
      </div>
      ${deleteButton}
    </div>`;
  }

  function renderTodoPanelList(items, emptyText) {
    if (items.length === 0) {
      return `<div class="calendar-todo-empty">${emptyText}</div>`;
    }
    return `<div class="calendar-todo-list">${items.map(renderTodoPanelTask).join('')}</div>`;
  }

  function renderCompletedTodoPanel(completedTasks) {
    const retainedTasks = completedTasks.slice(0, 10);
    const visibleTasks = todoPanelCompletedExpanded
      ? retainedTasks
      : retainedTasks.slice(0, 3);
    const toggleHtml = retainedTasks.length > 3
      ? `<button type="button" class="calendar-todo-show-all" data-action="toggle-completed-todos" aria-expanded="${todoPanelCompletedExpanded}">
          ${todoPanelCompletedExpanded ? 'Vis færre' : 'Vis alle'}
        </button>`
      : '';

    return `${renderTodoPanelList(visibleTasks, 'Nothing completed yet.')}${toggleHtml}`;
  }

  function formatPushupWeekLabel(key) {
    const match = /^(\d{4})-W(\d{2})$/.exec(key || '');
    if (!match) return key || 'No record yet';
    return `Week ${Number(match[2])}, ${match[1]}`;
  }

  function formatPushupMonthLabel(key) {
    const match = /^(\d{4})-(\d{2})$/.exec(key || '');
    if (!match) return key || 'No record yet';
    const monthIndex = Number(match[2]) - 1;
    return `${MONTHS[monthIndex] || match[2]} ${match[1]}`;
  }

  function renderPushupStat(label, value, detail) {
    return `<div class="pushup-stat">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(formatNumber(value))}</strong>
      <small>${escapeHtml(detail || 'No record yet')}</small>
    </div>`;
  }

  function formatPushupDailyPace(value) {
    if (!Number.isFinite(value) || value <= 0) return '0';
    if (value < 1) return '< 1';
    return new Intl.NumberFormat('da-DK', {
      maximumFractionDigits: value < 10 ? 1 : 0
    }).format(value);
  }

  function renderPushupYearPace(stats) {
    if (stats.yearGoal <= 0) {
      return `<div class="pushup-year-pace">
        <div class="pushup-year-pace-top">
          <span>Årsmål tempo</span>
          <strong>Intet mål</strong>
        </div>
        <div class="pushup-year-pace-main">
          <strong>Sæt et årsmål</strong>
          <span>i settings</span>
        </div>
      </div>`;
    }

    const goalReached = stats.yearTotal >= stats.yearGoal;
    const paceClass = goalReached
      ? ' is-complete'
      : stats.yearPaceDelta >= 0
        ? ' is-on-track'
        : ' is-behind';
    const statusText = goalReached
      ? 'Målet er ramt'
      : stats.yearPaceDelta >= 0
        ? 'On track'
        : 'Bagud';
    const delta = Math.abs(stats.yearPaceDelta);
    const paceText = goalReached
      ? `${formatNumber(stats.yearTotal - stats.yearGoal)} over årsmålet`
      : stats.yearPaceDelta > 0
        ? `${formatNumber(delta)} foran tempoet`
        : stats.yearPaceDelta < 0
          ? `${formatNumber(delta)} bagud ift. tempoet`
          : 'Lige på tempoet';
    const dailyText = goalReached
      ? '0'
      : formatPushupDailyPace(stats.yearDailyNeeded);

    return `<div class="pushup-year-pace${paceClass}">
      <div class="pushup-year-pace-top">
        <span>Årsmål tempo</span>
        <strong>${escapeHtml(statusText)}</strong>
      </div>
      <div class="pushup-year-pace-main">
        <strong>${escapeHtml(dailyText)} om dagen</strong>
        <span>resten af året</span>
      </div>
      <small>${escapeHtml(paceText)}</small>
    </div>`;
  }

  function renderPushupGoalBar(label, current, goal, progress, remaining, detail) {
    const cappedProgress = Math.max(0, Math.min(100, progress || 0));
    const complete = goal > 0 && current >= goal;
    const remainingText = goal > 0
      ? complete
        ? 'Goal reached'
        : `${formatNumber(remaining)} left`
      : 'Set a goal in settings';

    return `<div class="pushup-goal-bar">
      <div class="pushup-goal-bar-top">
        <span>${escapeHtml(label)}</span>
        <strong>${formatNumber(current)} / ${formatNumber(goal)}</strong>
      </div>
      <div class="pushup-linear-progress" role="progressbar" aria-label="${escapeHtml(label)} progress" aria-valuenow="${cappedProgress}" aria-valuemin="0" aria-valuemax="100">
        <span style="width: ${cappedProgress}%"></span>
      </div>
      <div class="pushup-goal-bar-bottom">
        <span>${escapeHtml(detail)}</span>
        <span>${escapeHtml(remainingText)}</span>
      </div>
    </div>`;
  }

  function renderPushupWidget() {
    const now = new Date();
    const stats = getPushupStats(now);
    const activeSet = getActivePushupSet(now);
    const lastRecordAt = pushupWidget.lastRecord?.at ? new Date(pushupWidget.lastRecord.at) : null;
    const showSetRecord = !!(
      activeSet &&
      pushupWidget.lastRecord?.type === 'set' &&
      pushupWidget.lastRecord?.setId === activeSet.id &&
      lastRecordAt &&
      !Number.isNaN(lastRecordAt.getTime()) &&
      now - lastRecordAt < PUSHUP_SET_WINDOW_MS
    );
    const setRemainingMs = getPushupSetRemainingMs(activeSet, now);
    const setRemainingRatio = Math.max(0, Math.min(100, Math.round((setRemainingMs / PUSHUP_SET_WINDOW_MS) * 100)));
    const setExpiresAt = activeSet
      ? new Date(activeSet.updatedAt || activeSet.startedAt || 0).getTime() + PUSHUP_SET_WINDOW_MS
      : 0;
    const statsOpen = !!pushupWidget.statsOpen;
    const monthLabel = MONTHS[now.getMonth()];
    const yearLabel = String(now.getFullYear());
    const activeSetLabel = activeSet
      ? `${formatNumber(activeSet.count)} push-up${activeSet.count === 1 ? '' : 's'}`
      : '';

    return `<div class="pushup-widget">
      <div class="pushup-main-row">
        <div class="pushup-count-block">
          <span>Today</span>
          <strong>${formatNumber(stats.todayTotal)}</strong>
          <small>I går: ${formatNumber(stats.yesterdayTotal)}</small>
        </div>
        <button type="button" class="pushup-add-btn" data-action="pushup-plus" title="Add push-up" aria-label="Add push-up">+</button>
      </div>
      ${activeSet ? `<div class="pushup-set-timer" data-expires-at="${setExpiresAt}">
        <div class="pushup-set-timer-top">
          <span>Current set</span>
          <strong class="pushup-set-count" aria-live="polite">${escapeHtml(activeSetLabel)}</strong>
        </div>
        <div class="pushup-countdown-track" aria-hidden="true">
          <span class="pushup-countdown-fill" style="width: ${setRemainingRatio}%"></span>
        </div>
      </div>` : ''}
      ${showSetRecord ? `<div class="pushup-record-banner">New max record: ${formatNumber(activeSet.count)} in a row</div>` : ''}
      <div class="pushup-stats-panel${statsOpen ? ' is-open' : ''}">
        <button type="button" class="pushup-stats-toggle" data-action="pushup-toggle-stats" aria-expanded="${statsOpen}" aria-label="${statsOpen ? 'Skjul statistik' : 'Vis statistik'}">
          <span>Statistik</span>
          <strong aria-hidden="true">▾</strong>
        </button>
        ${statsOpen ? `<div class="pushup-stat-grid">
          ${renderPushupStat('Best day', stats.bestDay.count, stats.bestDay.key ? formatTodoPanelDate(stats.bestDay.key) : '')}
          ${renderPushupStat('Best week', stats.bestWeek.count, stats.bestWeek.key ? formatPushupWeekLabel(stats.bestWeek.key) : '')}
          ${renderPushupStat('Best month', stats.bestMonth.count, stats.bestMonth.key ? formatPushupMonthLabel(stats.bestMonth.key) : '')}
          ${renderPushupStat('Best streak', stats.bestSet.count, stats.bestSet.date ? formatTodoPanelDate(stats.bestSet.date) : '')}
          ${renderPushupStat('Weekly count', stats.weekTotal, 'This week')}
        </div>
        ${renderPushupYearPace(stats)}` : ''}
      </div>
      <div class="pushup-goals-row">
        ${renderPushupGoalBar('Monthly goal', stats.monthTotal, stats.monthGoal, stats.monthProgress, stats.monthRemaining, monthLabel)}
        ${renderPushupGoalBar('Yearly goal', stats.yearTotal, stats.yearGoal, stats.yearProgress, stats.yearRemaining, yearLabel)}
      </div>
    </div>`;
  }

  function renderWidgetsPanel() {
    const checked = pushupWidget.enabled ? 'checked' : '';
    return `<section class="calendar-widgets-panel" aria-label="Widgets">
      <div class="calendar-widgets-header">
        <h2>Widgets</h2>
      </div>
      <div class="calendar-widget-section">
        <label class="calendar-widget-toggle">
          <span>Push-up counter</span>
          <input type="checkbox" class="pushup-widget-toggle" ${checked} aria-label="Toggle push-up counter">
          <span class="calendar-widget-switch" aria-hidden="true"></span>
        </label>
        ${pushupWidget.enabled ? renderPushupWidget() : ''}
      </div>
    </section>`;
  }

  function renderWidgetsPanelInPlace() {
    if (!calendarTodoPanel) return;
    const panel = calendarTodoPanel.querySelector('.calendar-widgets-panel');
    if (!panel) {
      renderTodoPanel();
      return;
    }
    panel.outerHTML = renderWidgetsPanel();
    schedulePushupCountdownTimer();
  }

  function renderPushupWidgetInPlace() {
    if (!calendarTodoPanel || !pushupWidget.enabled) {
      renderWidgetsPanelInPlace();
      return;
    }
    const widget = calendarTodoPanel.querySelector('.pushup-widget');
    if (!widget) {
      renderWidgetsPanelInPlace();
      return;
    }
    widget.outerHTML = renderPushupWidget();
    schedulePushupCountdownTimer();
  }

  function stopPushupCountdownTimer() {
    if (pushupCountdownTimer) {
      clearInterval(pushupCountdownTimer);
      pushupCountdownTimer = null;
    }
  }

  function schedulePushupCountdownTimer() {
    stopPushupCountdownTimer();
    if (!calendarTodoPanel) return;

    const timer = calendarTodoPanel.querySelector('.pushup-set-timer[data-expires-at]');
    if (!timer) return;

    const fillEl = timer.querySelector('.pushup-countdown-fill');
    const expiresAt = Number.parseInt(timer.dataset.expiresAt, 10);
    if (!Number.isFinite(expiresAt)) return;

    const tick = () => {
      const remainingMs = Math.max(0, expiresAt - Date.now());
      const ratio = Math.max(0, Math.min(100, (remainingMs / PUSHUP_SET_WINDOW_MS) * 100));

      if (fillEl) fillEl.style.width = `${ratio}%`;

      if (remainingMs <= 0) {
        stopPushupCountdownTimer();
        renderTodoPanel();
      }
    };

    tick();
    pushupCountdownTimer = setInterval(tick, 100);
  }

  function renderTodoPanel(options = {}) {
    if (!calendarTodoPanel) return;
    const tasks = collectTodoPanelTasks();
    const activeTasks = tasks.filter(task => !task.done);
    const completedTasks = tasks.filter(task => task.done).sort(compareCompletedTodoPanelTasks);
    const completedPanelCount = Math.min(completedTasks.length, 10);
    if (completedPanelCount <= 3) todoPanelCompletedExpanded = false;

    calendarTodoPanel.innerHTML = `<div class="calendar-todo-card">
      <div class="calendar-todo-header">
        <h2>To-do list</h2>
      </div>
      <section class="calendar-todo-section">
        <div class="calendar-todo-section-header"><span>Active</span><span>${activeTasks.length}</span></div>
        <form class="calendar-todo-add-form" id="calendarTodoAddForm">
          <span class="calendar-todo-draft-checkbox" aria-hidden="true"></span>
          <input type="text" class="calendar-todo-add-input" id="calendarTodoAddInput" placeholder="Add a to-do..." autocomplete="off" spellcheck="false">
          <span aria-hidden="true"></span>
        </form>
        ${renderTodoPanelList(activeTasks, 'No active tasks.')}
      </section>
      <section class="calendar-todo-section">
        <div class="calendar-todo-section-header"><span>Completed</span><span>${completedPanelCount}</span></div>
        ${renderCompletedTodoPanel(completedTasks)}
      </section>
    </div>
    ${renderWidgetsPanel()}`;

    if (options.focusAddInput) {
      requestAnimationFrame(() => {
        const input = document.getElementById('calendarTodoAddInput');
        if (input) input.focus();
      });
    }

    schedulePushupCountdownTimer();
  }

  function render() {
    const { start, end } = getDateRange();
    let html = '';
    let currentMonth = -1;
    let currentYear = -1;
    let lastWeekNum = -1;
    const d = new Date(start);

    while (d <= end) {
      const key = dateKey(d);
      const regularNotes = notes[key] || [];
      const recurringNotes = getRecurringForDate(key);
      const dayNotes = sortNotesByTime([...regularNotes, ...recurringNotes]);

      const st = searchTerm ? searchTerm.toLowerCase() : '';
      const matchingNotes = searchTerm
        ? dayNotes.filter(n => {
            if (n.text && n.text.toLowerCase().includes(st)) return true;
            if (n.smartList && Array.isArray(n.listItems)) {
              return n.listItems.some(li => (li.text || '').toLowerCase().includes(st));
            }
            return false;
          })
        : dayNotes;

      if (searchTerm && matchingNotes.length === 0) {
        d.setDate(d.getDate() + 1);
        continue;
      }

      if (d.getMonth() !== currentMonth || d.getFullYear() !== currentYear) {
        currentMonth = d.getMonth();
        currentYear = d.getFullYear();

        const monthStart = new Date(currentYear, currentMonth, 1);
        const monthEnd = new Date(currentYear, currentMonth + 1, 0);
        let totalNotes = 0, doneNotes = 0;
        for (let md = new Date(monthStart); md <= monthEnd; md.setDate(md.getDate()+1)) {
          const mk = dateKey(md);
          if (notes[mk]) {
            totalNotes += notes[mk].length;
            doneNotes += notes[mk].filter(n => n.done).length;
          }
        }

        html += `<div class="month-header" id="month-${currentYear}-${currentMonth}">
          <h2>${MONTHS[currentMonth]} ${currentYear}</h2>
          <div class="month-stats">
            <span><strong>${totalNotes}</strong> notes</span>
            <span><strong>${doneNotes}</strong> done</span>
            ${totalNotes > 0 ? `<span><strong>${Math.round(doneNotes/totalNotes*100)}%</strong> complete</span>` : ''}
          </div>
        </div>`;
      }

      const wn = getISOWeekNumber(d);
      if (wn !== lastWeekNum) {
        lastWeekNum = wn;
        html += `<div class="week-marker"><span class="week-marker-label">Uge ${wn}</span><span class="week-marker-line"></span></div>`;
      }

      const todayClass = isToday(key) ? 'is-today' : '';
      const weekendClass = isWeekend(d) ? 'is-weekend' : '';
      const hasNotesClass = dayNotes.length > 0 ? 'has-notes' : '';
      const holidayName = getHolidayName(key);
      const holidayClass = holidayName ? 'is-holiday' : '';

      html += `<div class="day-block ${todayClass} ${weekendClass} ${hasNotesClass} ${holidayClass}" id="day-${key}" data-date="${key}">`;
      html += `<div class="day-header">`;
      html += `<span class="day-date">${d.getDate()}</span>`;
      html += `<span class="day-weekday">${WEEKDAYS[d.getDay()]}</span>`;
      if (isToday(key)) html += `<span class="day-label">Today</span>`;
      if (holidayName) html += `<span class="day-holiday">${holidayName}</span>`;
      html += `</div>`;

      if (matchingNotes.length > 0) {
        html += `<div class="notes-list">`;
        for (const note of matchingNotes) {
          const recurringClass = note.isRecurring ? 'is-recurring' : '';
          const freqText = note.frequency === 'yearly' ? '\u00c5rlig' :
                           note.frequency === 'monthly' ? 'M\u00e5nedlig' :
                           note.frequency === 'biweekly' ? 'Hver 14. dag' :
                           note.frequency === 'weekly' ? 'Ugentlig' : 'Daglig';
          const recurringBadge = note.isRecurring ? `<span class="recurring-badge" title="${freqText}">&#x21bb;</span>` : '';
          const leadBadge = note.leadTime ? `<span class="lead-badge" title="Remind ${note.leadTime}min before">\u23f0-${note.leadTime >= 60 ? (note.leadTime/60) + 'h' : note.leadTime + 'm'}</span>` : '';
          const recurringId = note.recurringId || '';

          if (note.smartList && (note.smartList === 'todo' || note.smartList === 'shopping')) {
            const slClass = note.smartList === 'todo' ? 'smart-list-todo' : 'smart-list-shopping';
            const slLabel = note.smartList === 'todo' ? 'To-do list' : 'Shopping list';
            const items = Array.isArray(note.listItems) ? note.listItems : [];
            let rowsHtml = '';
            for (const li of items) {
              const lic = li.done ? 'checked' : '';
              const lidone = li.done ? ' smart-list-item-done' : '';
              const itemText = (li.text || '').trim()
                ? renderRichText(li.text)
                : '<span class="smart-list-item-placeholder">Empty line</span>';
              rowsHtml += `<div class="smart-list-row${lidone}">
                <input type="checkbox" class="smart-list-item-cb" ${lic} data-id="${note.id}" data-date="${key}" data-item-id="${li.id}">
                <div class="note-text smart-list-item-text">${itemText}</div>
              </div>`;
            }
            const titleHtml = (note.text || '').trim()
              ? `<div class="smart-list-title note-text">${renderRichText(note.text)}</div>`
              : '';
            html += `<div class="note-wrap" data-id="${note.id}" data-date="${key}" data-recurring-id="">
              <div class="note-item smart-list-note ${slClass} ${recurringClass}" data-id="${note.id}" data-date="${key}" data-recurring-id="">
                <div class="smart-list-inner">
                  <div class="smart-list-header"><span class="smart-list-type-label">${slLabel}</span></div>
                  ${titleHtml}
                  <div class="smart-list-rows">${rowsHtml}</div>
                  <span class="note-time">${note.time || ''}${leadBadge ? ' ' + leadBadge : ''}${recurringBadge ? ' ' + recurringBadge : ''}</span>
                </div>
              </div>
              <div class="note-actions">
                <button class="note-delete" data-id="${note.id}" data-date="${key}" data-recurring-id="">&times;</button>
                <button class="note-edit" data-id="${note.id}" data-date="${key}" data-recurring-id="" title="Rediger">&#x270e;</button>
              </div>
            </div>`;
            continue;
          }

          const doneClass = note.done ? 'done' : '';
          const checked = note.done ? 'checked' : '';
          const eventClass = note.isEvent ? 'is-event' : '';
          const displayText = renderRichText(note.text);
          const checkboxHtml = note.isEvent
            ? `<span class="event-badge" title="Begivenhed">&#x1f4c5;</span>`
            : `<input type="checkbox" class="note-checkbox" ${checked} data-id="${note.id}" data-date="${key}" data-recurring-id="${recurringId}">`;
          const googleCalendarButton = note.isEvent
            ? `<button class="google-calendar-btn" data-id="${note.id}" data-date="${key}" data-recurring-id="${recurringId}" title="Send to Google Calendar" aria-label="Send to Google Calendar">G</button>`
            : '';
          html += `<div class="note-wrap" data-id="${note.id}" data-date="${key}" data-recurring-id="${recurringId}">
            <div class="note-item ${doneClass} ${recurringClass} ${eventClass}" data-id="${note.id}" data-date="${key}" data-recurring-id="${recurringId}">
              ${checkboxHtml}
              <div class="note-text">${displayText}</div>
              <span class="note-time">${note.time || ''}${leadBadge ? ' ' + leadBadge : ''}${recurringBadge ? ' ' + recurringBadge : ''}</span>
            </div>
            <div class="note-actions">
              ${googleCalendarButton}
              <button class="note-delete" data-id="${note.id}" data-date="${key}" data-recurring-id="${recurringId}">&times;</button>
              <button class="note-edit" data-id="${note.id}" data-date="${key}" data-recurring-id="${recurringId}" title="Rediger">&#x270e;</button>
            </div>
          </div>`;
        }
        html += `</div>`;
      }

      html += `<div class="add-note-area">
        <div class="quick-actions" data-date="${key}">
          <span class="quick-actions-label">Hurtig tilf\u00f8j</span>
          <button class="quick-action" data-date="${key}" data-qa="task">\u2610 Task</button>
          <button class="quick-action" data-date="${key}" data-qa="event">\u{1f4c5} Event</button>
          <button class="quick-action" data-date="${key}" data-qa="daily">\u21bb Daglig</button>
          <button class="quick-action" data-date="${key}" data-qa="weekly">\u21bb Ugentlig</button>
          <button class="quick-action" data-date="${key}" data-qa="biweekly">\u21bb 14. dag</button>
          <button class="quick-action" data-date="${key}" data-qa="monthly">\u21bb M\u00e5nedlig</button>
          <button class="quick-action quick-action-close" data-date="${key}" data-qa="close">&times;</button>
        </div>
        <button class="add-note-btn" data-date="${key}">+ Add note</button>
        <div class="add-note-form" data-date="${key}">
          <div class="form-row">
            <textarea placeholder="Write a note... (use #tags)" data-date="${key}" rows="1" spellcheck="false"></textarea>
            <button class="reminder-menu-btn" data-date="${key}" title="P\u00e5mindelse">&#x23f0;</button>
            <button class="recurring-menu-btn" data-date="${key}" title="Gentagelse">&#x21bb;</button>
            <button class="task-toggle-btn" data-date="${key}" title="Opgave (med checkbox)">&#x2610; Task</button>
            <button data-date="${key}" class="save-note-btn">Add</button>
            <button data-date="${key}" class="cancel-note-btn">&times;</button>
          </div>
          <div class="reminder-options hidden" data-date="${key}">
            <button class="reminder-option" data-mins="0" data-date="${key}">Ingen</button>
            <button class="reminder-option" data-mins="5" data-date="${key}">5 min</button>
            <button class="reminder-option" data-mins="15" data-date="${key}">15 min</button>
            <button class="reminder-option" data-mins="30" data-date="${key}">30 min</button>
            <button class="reminder-option" data-mins="60" data-date="${key}">1 time</button>
            <button class="reminder-option" data-mins="1440" data-date="${key}">1 dag</button>
          </div>
          <div class="recurring-options hidden" data-date="${key}">
            <button class="recurring-option" data-freq="daily" data-date="${key}">Daglig</button>
            <button class="recurring-option" data-freq="weekly" data-date="${key}">Ugentlig</button>
            <button class="recurring-option" data-freq="biweekly" data-date="${key}">Hver 14. dag</button>
            <button class="recurring-option" data-freq="monthly" data-date="${key}">M\u00e5nedlig</button>
            <button class="recurring-option" data-freq="yearly" data-date="${key}">\u00c5rlig</button>
          </div>
        </div>
      </div>`;

      html += `</div>`;
      d.setDate(d.getDate() + 1);
    }

    doc.innerHTML = html;
    renderTodoPanel();
    bindEvents();
    updateStickyOffsets();
    scrollToTodayOnBoot();
  }

  if (calendarTodoPanel) {
    function addStandaloneTodoFromInput(input) {
      const text = input ? input.value.trim() : '';
      if (!text) return false;

      standaloneTodos.push({
        id: crypto.randomUUID(),
        text: applySmartLinks(capitalizeFirst(text)),
        done: false,
        createdAt: new Date().toISOString(),
        completedAt: null
      });
      saveStandaloneTodos();
      renderTodoPanel({ focusAddInput: true });
      return true;
    }

    function getTodoPanelTaskText(kind, date, id, itemId) {
      if (kind === 'standalone') {
        return standaloneTodos.find(item => item.id === id)?.text || '';
      }

      const note = (notes[date] || []).find(n => n.id === id);
      if (!note) return '';

      if (kind === 'smart') {
        return Array.isArray(note.listItems)
          ? note.listItems.find(item => item.id === itemId)?.text || ''
          : '';
      }

      return note.text || '';
    }

    function saveTodoPanelTaskText(kind, date, id, itemId, nextText) {
      const text = applySmartLinks(nextText.trim());
      if (!text) {
        renderTodoPanel();
        return;
      }

      if (kind === 'standalone') {
        const todo = standaloneTodos.find(item => item.id === id);
        if (!todo) {
          renderTodoPanel();
          return;
        }
        todo.text = text;
        saveStandaloneTodos();
        renderTodoPanel();
        return;
      }

      const dayNotes = notes[date] || [];
      const note = dayNotes.find(n => n.id === id);
      if (!note) {
        renderTodoPanel();
        return;
      }

      if (kind === 'smart') {
        const item = Array.isArray(note.listItems)
          ? note.listItems.find(li => li.id === itemId)
          : null;
        if (!item) {
          renderTodoPanel();
          return;
        }
        item.text = text;
      } else {
        note.text = text;
        const { time } = parseTimeFromText(nextText);
        if (time) note.time = time;
        notes[date] = sortNotesByTime(notes[date]);
      }

      saveNotes(notes);
      render();
    }

    function beginTodoPanelTaskEdit(textEl) {
      const item = textEl.closest('.calendar-todo-item');
      if (!item || item.querySelector('.calendar-todo-edit-input')) return;

      const { kind, date, id, itemId } = item.dataset;
      const currentText = getTodoPanelTaskText(kind, date, id, itemId);
      const textarea = document.createElement('textarea');
      textarea.className = 'calendar-todo-edit-input';
      textarea.rows = 1;
      textarea.spellcheck = false;
      textarea.value = currentText;

      textEl.classList.add('is-editing');
      textEl.replaceChildren(textarea);

      const resize = () => {
        textarea.style.height = 'auto';
        textarea.style.height = `${textarea.scrollHeight}px`;
      };
      resize();
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);

      let closed = false;
      function finish(commit) {
        if (closed) return;
        closed = true;
        if (commit) {
          saveTodoPanelTaskText(kind, date, id, itemId, textarea.value);
        } else {
          renderTodoPanel();
        }
      }

      textarea.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && !ev.shiftKey) {
          ev.preventDefault();
          finish(true);
        }
        if (ev.key === 'Escape') {
          ev.preventDefault();
          finish(false);
        }
      });
      textarea.addEventListener('input', resize);
      textarea.addEventListener('blur', () => finish(true));
    }

    calendarTodoPanel.addEventListener('submit', (e) => {
      const form = e.target.closest('#calendarTodoAddForm');
      if (!form) return;
      e.preventDefault();

      addStandaloneTodoFromInput(form.querySelector('#calendarTodoAddInput'));
    });

    calendarTodoPanel.addEventListener('keydown', (e) => {
      const input = e.target.closest('#calendarTodoAddInput');
      if (input) {
        if (e.key !== 'Enter' || e.isComposing) return;
        e.preventDefault();
        addStandaloneTodoFromInput(input);
        return;
      }

      if (e.target.closest('.calendar-todo-edit-input')) return;

      const textEl = e.target.closest('[data-action="edit-todo"]');
      if (!textEl || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      beginTodoPanelTaskEdit(textEl);
    });

    calendarTodoPanel.addEventListener('click', (e) => {
      const pushupStatsToggle = e.target.closest('[data-action="pushup-toggle-stats"]');
      if (pushupStatsToggle) {
        pushupWidget.statsOpen = !pushupWidget.statsOpen;
        savePushupWidget();
        renderPushupWidgetInPlace();
        return;
      }

      const completedToggle = e.target.closest('[data-action="toggle-completed-todos"]');
      if (completedToggle) {
        todoPanelCompletedExpanded = !todoPanelCompletedExpanded;
        renderTodoPanel();
        return;
      }

      const pushupAddBtn = e.target.closest('[data-action="pushup-plus"]');
      if (pushupAddBtn) {
        addPushupRep();
        renderPushupWidgetInPlace();
        return;
      }

      const todoText = e.target.closest('[data-action="edit-todo"]');
      if (todoText && !e.target.closest('a')) {
        beginTodoPanelTaskEdit(todoText);
        return;
      }

      const deleteBtn = e.target.closest('[data-action="delete-todo"]');
      if (!deleteBtn) return;

      const { id } = deleteBtn.dataset;
      standaloneTodos = standaloneTodos.filter(todo => todo.id !== id);
      saveStandaloneTodos();
      renderTodoPanel();
    });

    calendarTodoPanel.addEventListener('change', (e) => {
      const pushupToggle = e.target.closest('.pushup-widget-toggle');
      if (pushupToggle) {
        pushupWidget.enabled = pushupToggle.checked;
        savePushupWidget();
        renderWidgetsPanelInPlace();
        return;
      }

      const target = e.target.closest('.calendar-todo-checkbox');
      if (!target) return;

      const { kind, date, id, itemId } = target.dataset;

      if (kind === 'standalone') {
        const todo = standaloneTodos.find(item => item.id === id);
        if (!todo) return;
        todo.done = target.checked;
        todo.completedAt = target.checked ? new Date().toISOString() : null;
        saveStandaloneTodos();
        renderTodoPanel();
        return;
      }

      const dayNotes = notes[date] || [];
      const note = dayNotes.find(n => n.id === id);
      if (!note) return;

      if (kind === 'smart') {
        const item = Array.isArray(note.listItems)
          ? note.listItems.find(li => li.id === itemId)
          : null;
        if (!item) return;
        item.done = target.checked;
        item.completedAt = target.checked ? new Date().toISOString() : null;
      } else {
        note.done = target.checked;
        note.completedAt = target.checked ? new Date().toISOString() : null;
      }

      saveNotes(notes);
      render();
    });

    document.addEventListener('wheel', (e) => {
      if (layoutState.mode !== 'tabs') return;
      if (isMobileViewport()) return;

      const panelRect = calendarTodoPanel.getBoundingClientRect();
      const viewTabsEl = document.getElementById('viewTabs');
      const tabsRect = viewTabsEl ? viewTabsEl.getBoundingClientRect() : null;
      const rightSideStarts = panelRect.left;
      const rightSideTop = tabsRect ? tabsRect.bottom : panelRect.top;
      if (e.clientX < rightSideStarts || e.clientY < rightSideTop) return;

      e.preventDefault();
      calendarTodoPanel.scrollTop += e.deltaY;
      calendarTodoPanel.scrollLeft += e.deltaX;
    }, { capture: true, passive: false });
  }

  // Event delegation
  doc.addEventListener('click', (e) => {
    // Check link-delete first with direct matching (before closest)
    const linkDel = e.target.closest('.link-delete');
    if (linkDel) {
      e.preventDefault();
      e.stopPropagation();
      const url = linkDel.dataset.url;
      const noteItem = linkDel.closest('.note-item');
      if (!noteItem) return;
      const { id, date, recurringId } = noteItem.dataset;
      if (recurringId) {
        const rec = recurring.find(r => r.id === recurringId);
        if (rec) {
          rec.text = rec.text.replace(url, '').replace(/\s{2,}/g, ' ').trim();
          saveRecurring();
        }
      } else {
        const note = (notes[date] || []).find(n => n.id === id);
        if (note) {
          if (note.smartList && note.listItems) {
            let changed = false;
            if (note.text && note.text.includes(url)) {
              note.text = note.text.replace(url, '').replace(/\s{2,}/g, ' ').trim();
              changed = true;
            } else {
              for (const li of note.listItems) {
                if (li.text && li.text.includes(url)) {
                  li.text = li.text.replace(url, '').replace(/\s{2,}/g, ' ').trim();
                  changed = true;
                  break;
                }
              }
            }
            if (changed) saveNotes(notes);
          } else {
            note.text = note.text.replace(url, '').replace(/\s{2,}/g, ' ').trim();
            saveNotes(notes);
          }
        }
      }
      render();
      return;
    }

    const target = e.target.closest('[class]');
    if (!target) return;

    if (target.classList.contains('google-calendar-btn')) {
      e.preventDefault();
      e.stopPropagation();
      const { id, date, recurringId } = target.dataset;
      const event = getCalendarEventForAction(date, id, recurringId);
      if (!event) return;
      window.open(buildGoogleCalendarUrl(event), '_blank', 'noopener');
      return;
    }

    if (target.classList.contains('smart-list-item-cb')) {
      const { id, date, itemId } = target.dataset;
      const dayNotes = notes[date] || [];
      const note = dayNotes.find(n => n.id === id);
      if (note && note.listItems) {
        const item = note.listItems.find(li => li.id === itemId);
        if (item) {
          item.done = target.checked;
          item.completedAt = target.checked ? new Date().toISOString() : null;
          saveNotes(notes);
          render();
        }
      }
      return;
    }

    if (target.classList.contains('note-checkbox')) {
      const { id, date, recurringId } = target.dataset;
      if (recurringId) {
        const rec = recurring.find(r => r.id === recurringId);
        if (rec) {
          if (target.checked) {
            recurring = recurring.filter(r => r.id !== recurringId);
          } else {
            rec.doneDate = null;
          }
          saveRecurring();
          render();
        }
        return;
      }
      const dayNotes = notes[date] || [];
      const note = dayNotes.find(n => n.id === id);
      if (note) {
        note.done = target.checked;
        note.completedAt = target.checked ? new Date().toISOString() : null;
        saveNotes(notes);
        render();
      }
      return;
    }

    // Edit via pencil button or clicking note text
    if (target.classList.contains('note-edit') || target.classList.contains('note-text') ||
        (target.closest('.smart-list-note') && !target.classList.contains('smart-list-item-cb'))) {
      const noteWrap = target.closest('.note-wrap');
      const noteItem = noteWrap ? noteWrap.querySelector('.note-item') : target.closest('.note-item');
      if (!noteItem) return;

      // Already editing? Do nothing
      if (noteItem.querySelector('.note-edit-input')) return;

      const { id, date, recurringId } = noteItem.dataset;

      if (!recurringId) {
        const dayNotes = notes[date] || [];
        const slNote = dayNotes.find(n => n.id === id);
        if (slNote && slNote.smartList) {
          const inner = noteItem.querySelector('.smart-list-inner');
          if (!inner) return;

          const editWrap = document.createElement('div');
          editWrap.className = 'note-edit-wrap smart-list-edit-wrap';

          const titleInput = document.createElement('input');
          titleInput.type = 'text';
          titleInput.spellcheck = false;
          titleInput.className = 'smart-list-edit-title';
          titleInput.placeholder = 'Title (optional)';
          titleInput.value = slNote.text || '';

          const itemsLabel = document.createElement('div');
          itemsLabel.className = 'smart-list-edit-label';
          itemsLabel.textContent = 'Items (one per line)';

          const itemsTa = document.createElement('textarea');
          itemsTa.spellcheck = false;
          itemsTa.className = 'note-edit-input smart-list-edit-items';
          itemsTa.rows = Math.max(3, (slNote.listItems || []).length || 1);
          itemsTa.value = (slNote.listItems || []).map(li => li.text || '').join('\n');

          editWrap.appendChild(titleInput);
          editWrap.appendChild(itemsLabel);
          editWrap.appendChild(itemsTa);
          inner.replaceWith(editWrap);
          titleInput.focus();

          let saved = false;
          function saveSmartListEdit() {
            if (saved) return;
            saved = true;
            const newTitle = titleInput.value.trim();
            const lines = itemsTa.value.split('\n').map(l => l.trim()).filter(Boolean);
            const oldItems = slNote.listItems || [];
            const newItems = lines.map((line, i) => ({
              id: oldItems[i]?.id || crypto.randomUUID(),
              text: applySmartLinks(line),
              done: oldItems[i] && oldItems[i].text === line ? oldItems[i].done : false
            }));
            if (!newTitle && newItems.length === 0) {
              render();
              return;
            }
            slNote.text = newTitle ? applySmartLinks(newTitle) : '';
            slNote.listItems = newItems.length ? newItems : [{ id: crypto.randomUUID(), text: '', done: false }];
            notes[date] = sortNotesByTime(notes[date]);
            saveNotes(notes);
            render();
          }

          editWrap.addEventListener('focusout', (ev) => {
            if (editWrap.contains(ev.relatedTarget)) return;
            saveSmartListEdit();
          });
          itemsTa.addEventListener('keydown', (ev) => {
            if (ev.key === 'Escape') render();
          });
          titleInput.addEventListener('keydown', (ev) => {
            if (ev.key === 'Escape') render();
          });
          return;
        }
      }

      const noteText = noteItem.querySelector('.note-text');
      if (!noteText) return;

      // Get raw text, current leadTime, and isEvent
      let rawText, currentLeadTime, currentIsEvent;
      if (recurringId) {
        const rec = recurring.find(r => r.id === recurringId);
        rawText = rec ? rec.text : '';
        currentLeadTime = rec ? rec.leadTime : null;
        currentIsEvent = rec ? (rec.isEvent ?? true) : true;
      } else {
        const dayNotes = notes[date] || [];
        const note = dayNotes.find(n => n.id === id);
        rawText = note ? note.text : '';
        currentLeadTime = note ? note.leadTime : null;
        currentIsEvent = note ? (note.isEvent ?? true) : true;
      }

      // Build edit wrapper: textarea + compact option bar (accordion-style panels)
      const editWrap = document.createElement('div');
      editWrap.className = 'note-edit-wrap';

      const textarea = document.createElement('textarea');
      textarea.className = 'note-edit-input';
      textarea.spellcheck = false;
      textarea.value = rawText;
      textarea.rows = 1;

      let selectedLeadTime = currentLeadTime;
      const leadOptions = [
        [0, 'Ingen'], [5, '5 min'], [15, '15 min'],
        [30, '30 min'], [60, '1 time'], [1440, '1 dag']
      ];

      let selectedIsEvent = currentIsEvent;

      const prefixMap = {
        daily: 'mind mig hver dag om at ',
        weekly: 'mind mig hver uge om at ',
        biweekly: 'mind mig hver 14. dag om at ',
        monthly: 'mind mig hver m\u00e5ned om at ',
        yearly: 'mind mig hvert \u00e5r om at '
      };

      let selectedRepeat = null;
      const repeatChoices = [
        [null, 'Ingen'],
        ['daily', 'Daglig'],
        ['weekly', 'Ugentlig'],
        ['biweekly', 'Hver 14. dag'],
        ['monthly', 'M\u00e5nedlig'],
        ['yearly', '\u00c5rlig']
      ];
      if (recurringId) {
        const _recInit = recurring.find(r => r.id === recurringId);
        selectedRepeat = _recInit && _recInit.frequency ? _recInit.frequency : 'daily';
      }

      const reminderRow = document.createElement('div');
      reminderRow.className = 'edit-reminder-row';
      leadOptions.forEach(([mins, label]) => {
        const btn = document.createElement('button');
        btn.className = 'reminder-option' + ((mins === 0 && (currentLeadTime == null || currentLeadTime === undefined)) || mins === currentLeadTime ? ' selected' : '');
        btn.textContent = label;
        btn.type = 'button';
        btn.addEventListener('mousedown', (ev) => {
          ev.preventDefault();
          selectedLeadTime = mins === 0 ? null : mins;
          reminderRow.querySelectorAll('.reminder-option').forEach(b => b.classList.remove('selected'));
          btn.classList.add('selected');
          refreshReminderSummary();
          closeEditPanels();
        });
        reminderRow.appendChild(btn);
      });

      const typeRow = document.createElement('div');
      typeRow.className = 'edit-reminder-row';
      const eventBtn = document.createElement('button');
      eventBtn.className = 'reminder-option' + (currentIsEvent ? ' selected' : '');
      eventBtn.textContent = '\u{1f4c5} Event';
      eventBtn.type = 'button';
      eventBtn.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        selectedIsEvent = true;
        eventBtn.classList.add('selected');
        taskBtn.classList.remove('selected');
        refreshTypeSummary();
        closeEditPanels();
      });

      const taskBtn = document.createElement('button');
      taskBtn.className = 'reminder-option' + (!currentIsEvent ? ' selected' : '');
      taskBtn.textContent = '\u2610 Task';
      taskBtn.type = 'button';
      taskBtn.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        selectedIsEvent = false;
        taskBtn.classList.add('selected');
        eventBtn.classList.remove('selected');
        refreshTypeSummary();
        closeEditPanels();
      });

      typeRow.appendChild(eventBtn);
      typeRow.appendChild(taskBtn);

      const repeatChoicesForRow = recurringId
        ? repeatChoices.filter(([f]) => f !== null)
        : repeatChoices;
      const repeatRow = document.createElement('div');
      repeatRow.className = 'edit-reminder-row edit-repeat-row';
      repeatChoicesForRow.forEach(([freq, label]) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        const isSel = (freq === null && selectedRepeat == null) || freq === selectedRepeat;
        btn.className = 'reminder-option edit-repeat-option' + (isSel ? ' selected' : '');
        btn.textContent = label;
        btn.addEventListener('mousedown', (ev) => {
          ev.preventDefault();
          selectedRepeat = freq;
          repeatRow.querySelectorAll('.edit-repeat-option').forEach(b => b.classList.remove('selected'));
          btn.classList.add('selected');
          refreshRepeatSummary();
          closeEditPanels();
        });
        repeatRow.appendChild(btn);
      });

      const optsBar = document.createElement('div');
      optsBar.className = 'edit-opts-bar';
      const panelsWrap = document.createElement('div');
      panelsWrap.className = 'edit-opts-panels';

      let openEditPanel = null;
      function setOpenEditPanel(id) {
        openEditPanel = id;
        panelsWrap.querySelectorAll('.edit-opts-panel').forEach(p => {
          const pid = p.dataset.editPanel;
          p.classList.toggle('is-open', id !== null && pid === id);
        });
        optsBar.querySelectorAll('.edit-opts-trigger').forEach(t => {
          t.classList.toggle('is-open', id !== null && t.dataset.editPanel === id);
        });
      }
      function closeEditPanels() {
        setOpenEditPanel(null);
      }

      function makeTrigger(title, panelId) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'edit-opts-trigger';
        b.dataset.editPanel = panelId;
        const t = document.createElement('span');
        t.className = 'edit-opts-trigger-title';
        t.textContent = title;
        const s = document.createElement('span');
        s.className = 'edit-opts-summary';
        b.appendChild(t);
        b.appendChild(s);
        b.addEventListener('mousedown', (ev) => {
          ev.preventDefault();
          const next = openEditPanel === panelId ? null : panelId;
          setOpenEditPanel(next);
        });
        return { btn: b, summary: s };
      }

      const remTrig = makeTrigger('P\u00e5mindelse', 'reminder');
      const typeTrig = makeTrigger('Type', 'type');

      function refreshReminderSummary() {
        const found = leadOptions.find(([m]) =>
          (m === 0 && (selectedLeadTime == null || selectedLeadTime === undefined)) || m === selectedLeadTime
        );
        remTrig.summary.textContent = found ? found[1] : 'Ingen';
      }

      function refreshTypeSummary() {
        typeTrig.summary.textContent = selectedIsEvent ? 'Begivenhed' : 'Opgave';
      }

      const repTrig = makeTrigger('Gentagelse', 'repeat');

      function refreshRepeatSummary() {
        const found = repeatChoices.find(([f]) =>
          (f === null && selectedRepeat == null) || f === selectedRepeat
        );
        repTrig.summary.textContent = found ? found[1] : 'Ingen';
      }

      refreshReminderSummary();
      refreshTypeSummary();
      refreshRepeatSummary();

      optsBar.appendChild(remTrig.btn);
      optsBar.appendChild(typeTrig.btn);
      optsBar.appendChild(repTrig.btn);

      const panelReminder = document.createElement('div');
      panelReminder.className = 'edit-opts-panel';
      panelReminder.dataset.editPanel = 'reminder';
      panelReminder.appendChild(reminderRow);

      const panelType = document.createElement('div');
      panelType.className = 'edit-opts-panel';
      panelType.dataset.editPanel = 'type';
      panelType.appendChild(typeRow);

      panelsWrap.appendChild(panelReminder);
      panelsWrap.appendChild(panelType);

      const panelRepeat = document.createElement('div');
      panelRepeat.className = 'edit-opts-panel';
      panelRepeat.dataset.editPanel = 'repeat';
      panelRepeat.appendChild(repeatRow);
      panelsWrap.appendChild(panelRepeat);

      editWrap.appendChild(textarea);
      editWrap.appendChild(optsBar);
      editWrap.appendChild(panelsWrap);
      noteText.replaceWith(editWrap);
      textarea.style.height = 'auto';
      textarea.style.height = textarea.scrollHeight + 'px';
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);

      let saved = false;
      function saveEdit() {
        if (saved) return;
        saved = true;
        const newText = textarea.value.trim();
        if (!newText) {
          render(); // empty = cancel
          return;
        }
        if (recurringId) {
          const rec = recurring.find(r => r.id === recurringId);
          if (rec) {
            rec.text = applySmartLinks(newText);
            const { time } = parseTimeFromText(newText);
            if (time) rec.time = time;
            rec.leadTime = selectedLeadTime;
            rec.isEvent = selectedIsEvent;
            if (selectedRepeat) {
              const f = freqFromRepeatChoice(selectedRepeat, date);
              const oldSig = [rec.frequency, rec.dayOfWeek ?? '', rec.month ?? '', rec.dayOfMonth ?? ''].join('|');
              rec.frequency = f.frequency;
              if ('dayOfWeek' in f) rec.dayOfWeek = f.dayOfWeek;
              else delete rec.dayOfWeek;
              if ('month' in f) rec.month = f.month;
              else delete rec.month;
              if ('dayOfMonth' in f) rec.dayOfMonth = f.dayOfMonth;
              else delete rec.dayOfMonth;
              const newSig = [rec.frequency, rec.dayOfWeek ?? '', rec.month ?? '', rec.dayOfMonth ?? ''].join('|');
              if (oldSig !== newSig) rec.startDate = date;
            }
            saveRecurring();
          }
        } else if (selectedRepeat) {
          const dayNotes = notes[date] || [];
          const note = dayNotes.find(n => n.id === id);
          if (!note) {
            render();
            return;
          }
          let t = capitalizeFirst(newText.trim());
          t = applySmartLinks(t);
          if (!recurringRegex.test(t)) {
            t = prefixMap[selectedRepeat] + t;
          }
          const freq = isRecurringRequest(t)
            ? parseRecurringFrequency(t, date)
            : freqFromRepeatChoice(selectedRepeat, date);
          const rawForClean = isRecurringRequest(t)
            ? t
            : (prefixMap[selectedRepeat] + capitalizeFirst(newText.trim()));
          const fullForTime = isRecurringRequest(t) ? t : applySmartLinks(rawForClean);
          let cleanText = applySmartLinks(cleanRecurringText(rawForClean));
          const { time: parsedTime } = parseTimeFromText(fullForTime);
          const leadTime = selectedLeadTime ?? parseLeadTime(fullForTime) ?? null;
          if (leadTime !== null) cleanText = cleanLeadTimeText(cleanText);
          recurring.push({
            id: crypto.randomUUID(),
            text: cleanText || cleanRecurringText(rawForClean) || newText,
            time: parsedTime || note.time || null,
            startDate: date,
            doneDate: null,
            frequency: freq.frequency,
            dayOfWeek: freq.dayOfWeek,
            month: freq.month,
            dayOfMonth: freq.dayOfMonth,
            leadTime: leadTime ?? null,
            isEvent: selectedIsEvent
          });
          notes[date] = (notes[date] || []).filter(n => n.id !== id);
          if (notes[date].length === 0) delete notes[date];
          saveRecurring();
          saveNotes(notes);
        } else {
          const dayNotes = notes[date] || [];
          const note = dayNotes.find(n => n.id === id);
          if (note) {
            note.text = applySmartLinks(newText);
            const { time } = parseTimeFromText(newText);
            if (time) note.time = time;
            note.leadTime = selectedLeadTime;
            note.isEvent = selectedIsEvent;
            notes[date] = sortNotesByTime(notes[date]);
            saveNotes(notes);
          }
        }
        render();
      }

      textarea.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && !ev.shiftKey) {
          ev.preventDefault();
          saveEdit();
        }
        if (ev.key === 'Escape') {
          if (openEditPanel) {
            closeEditPanels();
            ev.preventDefault();
            return;
          }
          render(); // cancel
        }
      });
      textarea.addEventListener('blur', (ev) => {
        if (ev.relatedTarget && editWrap.contains(ev.relatedTarget)) return;
        setTimeout(() => saveEdit(), 0);
      });
      textarea.addEventListener('input', () => {
        textarea.style.height = 'auto';
        textarea.style.height = textarea.scrollHeight + 'px';
      });
      return;
    }

    if (target.classList.contains('note-delete')) {
      const { id, date, recurringId } = target.dataset;
      if (recurringId) {
        recurring = recurring.filter(r => r.id !== recurringId);
        saveRecurring();
        render();
        return;
      }
      notes[date] = (notes[date] || []).filter(n => n.id !== id);
      if (notes[date].length === 0) delete notes[date];
      saveNotes(notes);
      render();
      return;
    }

    if (target.classList.contains('quick-action')) {
      const area = target.closest('.add-note-area');
      const qa = area.querySelector('.quick-actions');
      const qaType = target.dataset.qa;

      if (qaType === 'close') {
        qa.classList.remove('visible');
        return;
      }

      const btn = area.querySelector('.add-note-btn');
      const form = area.querySelector('.add-note-form');
      const date = target.dataset.date;
      qa.classList.remove('visible');
      btn.classList.add('hidden');
      form.classList.add('active');
      const textarea = form.querySelector('textarea');

      if (qaType === 'task') {
        form.dataset.isTask = '1';
        const taskBtn = form.querySelector('.task-toggle-btn');
        if (taskBtn) taskBtn.classList.add('active');
      }
      if (['daily','weekly','biweekly','monthly','yearly'].includes(qaType)) {
        const prefixMap = {
          daily: 'mind mig hver dag om at ',
          weekly: 'mind mig hver uge om at ',
          biweekly: 'mind mig hver 14. dag om at ',
          monthly: 'mind mig hver m\u00e5ned om at ',
          yearly: 'mind mig hvert \u00e5r om at '
        };
        textarea.value = prefixMap[qaType];
      }
      textarea.focus();
      return;
    }

    if (target.classList.contains('add-note-btn')) {
      const area = target.closest('.add-note-area');
      const qa = area.querySelector('.quick-actions');
      qa.classList.remove('visible');
      target.classList.add('hidden');
      const form = target.nextElementSibling;
      form.classList.add('active');
      form.querySelector('textarea').focus();
      return;
    }

    if (target.classList.contains('cancel-note-btn')) {
      const area = target.closest('.add-note-area');
      const form = area.querySelector('.add-note-form');
      const btn = area.querySelector('.add-note-btn');
      form.classList.remove('active');
      form.querySelector('textarea').value = '';
      form.querySelector('.reminder-options').classList.add('hidden');
      form.querySelector('.recurring-options').classList.add('hidden');
      delete form.dataset.leadTime;
      delete form.dataset.isTask;
      const taskBtn = form.querySelector('.task-toggle-btn');
      if (taskBtn) taskBtn.classList.remove('active');
      const reminderBtn = form.querySelector('.reminder-menu-btn');
      if (reminderBtn) reminderBtn.classList.remove('active');
      btn.classList.remove('hidden');
      return;
    }

    if (target.classList.contains('save-note-btn')) {
      const date = target.dataset.date;
      const form = target.closest('.add-note-form');
      const textarea = form.querySelector('textarea');
      const uiLeadTime = form.dataset.leadTime ? parseInt(form.dataset.leadTime) : null;
      const isTask = form.dataset.isTask === '1';
      addNote(date, textarea.value, uiLeadTime, !isTask);
      return;
    }

    // Toggle reminder options menu
    if (target.classList.contains('reminder-menu-btn')) {
      const form = target.closest('.add-note-form');
      const options = form.querySelector('.reminder-options');
      form.querySelector('.recurring-options').classList.add('hidden');
      options.classList.toggle('hidden');
      return;
    }

    // Reminder option selected
    if (target.classList.contains('reminder-option')) {
      const mins = parseInt(target.dataset.mins);
      const form = target.closest('.add-note-form');
      const options = form.querySelector('.reminder-options');
      const btn = form.querySelector('.reminder-menu-btn');

      // Store selected lead time on the form
      if (mins === 0) {
        delete form.dataset.leadTime;
        btn.textContent = '\u23f0';
        btn.classList.remove('active');
      } else {
        form.dataset.leadTime = mins;
        const label = mins >= 1440 ? (mins / 1440) + 'd' : mins >= 60 ? (mins / 60) + 'h' : mins + 'm';
        btn.textContent = '\u23f0' + label;
        btn.classList.add('active');
      }

      // Highlight selected option
      options.querySelectorAll('.reminder-option').forEach(o => o.classList.remove('selected'));
      target.classList.add('selected');
      options.classList.add('hidden');
      form.querySelector('textarea').focus();
      return;
    }

    // Toggle task mode (default is event)
    if (target.classList.contains('task-toggle-btn')) {
      target.classList.toggle('active');
      const form = target.closest('.add-note-form');
      form.dataset.isTask = target.classList.contains('active') ? '1' : '';
      return;
    }

    // Toggle recurring options menu
    if (target.classList.contains('recurring-menu-btn')) {
      const form = target.closest('.add-note-form');
      const options = form.querySelector('.recurring-options');
      form.querySelector('.reminder-options').classList.add('hidden');
      options.classList.toggle('hidden');
      return;
    }

    // Recurring option selected
    if (target.classList.contains('recurring-option')) {
      const freq = target.dataset.freq;
      const form = target.closest('.add-note-form');
      const textarea = form.querySelector('textarea');
      const options = form.querySelector('.recurring-options');

      const prefixMap = {
        daily: 'mind mig hver dag om at ',
        weekly: 'mind mig hver uge om at ',
        biweekly: 'mind mig hver 14. dag om at ',
        monthly: 'mind mig hver m\u00e5ned om at ',
        yearly: 'mind mig hvert \u00e5r om at '
      };

      // Prepend prefix if not already recurring
      const currentText = textarea.value.trim();
      if (!recurringRegex.test(currentText)) {
        textarea.value = prefixMap[freq] + currentText;
      }

      options.classList.add('hidden');
      textarea.focus();
      return;
    }
  });

  doc.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && e.target.matches('.add-note-form textarea')) {
      if (calendarSmartListMenuOpen) return;
      e.preventDefault();
      const form = e.target.closest('.add-note-form');
      const uiLeadTime = form?.dataset.leadTime ? parseInt(form.dataset.leadTime) : null;
      const isTask = form?.dataset.isTask === '1';
      addNote(e.target.dataset.date, e.target.value, uiLeadTime, !isTask);
    }
  });

  doc.addEventListener('input', (e) => {
    if (e.target.matches('.add-note-form textarea')) {
      e.target.style.height = 'auto';
      e.target.style.height = e.target.scrollHeight + 'px';
      updateCalendarSmartListMenu(e.target);
    }
  });

  document.addEventListener('mousedown', (e) => {
    const opt = e.target.closest('.calendar-smart-list-option');
    if (!opt) return;
    e.preventDefault();
    const menu = document.getElementById('calendarSmartListMenu');
    const date = menu?.dataset.date;
    const ta = calendarSmartListAnchor;
    const type = opt.dataset.type;
    if (date && ta && (type === 'todo' || type === 'shopping')) {
      const cur = ta.selectionStart;
      const v = ta.value;
      const token = getCalendarAtToken(v, cur);
      if (token) {
        ta.value = v.slice(0, token.start) + v.slice(cur);
        ta.selectionStart = ta.selectionEnd = token.start;
      }
      addSmartListNote(date, type);
    }
    hideCalendarSmartListMenu();
  });

  document.addEventListener('click', (e) => {
    if (!calendarSmartListMenuOpen) return;
    if (e.target.closest('#calendarSmartListMenu')) return;
    hideCalendarSmartListMenu();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && calendarSmartListMenuOpen) hideCalendarSmartListMenu();
  });

  doc.addEventListener('scroll', () => hideCalendarSmartListMenu(), true);

  // Markdown-style shortcuts for all editable textareas:
  // Ctrl+B => **bold**, Ctrl+Shift+8 => bullets, Ctrl+Shift+7 => numbered list
  document.addEventListener('keydown', (e) => {
    const textarea = e.target;
    if (!(textarea instanceof HTMLTextAreaElement) || textarea.readOnly) return;

    const isCtrl = e.ctrlKey || e.metaKey;
    if (!isCtrl) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = textarea.value.slice(start, end);

    if (e.key.toLowerCase() === 'b' && !e.shiftKey) {
      e.preventDefault();
      const wrapped = `**${selected || 'bold text'}**`;
      textarea.setRangeText(wrapped, start, end, 'select');
      if (!selected) {
        textarea.selectionStart = start + 2;
        textarea.selectionEnd = start + 11;
      }
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }

    if (e.shiftKey && e.code === 'Digit8') {
      e.preventDefault();
      const replacement = selected
        ? selected.split('\n').map(line => `- ${line}`).join('\n')
        : '- ';
      textarea.setRangeText(replacement, start, end, 'end');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }

    if (e.shiftKey && e.code === 'Digit7') {
      e.preventDefault();
      const replacement = selected
        ? selected.split('\n').map((line, idx) => `${idx + 1}. ${line}`).join('\n')
        : '1. ';
      textarea.setRangeText(replacement, start, end, 'end');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });

  function bindEvents() {
    // Hover to show quick actions on desktop
    doc.querySelectorAll('.add-note-btn').forEach(btn => {
      let hoverTimeout;
      const area = btn.closest('.add-note-area');
      const qa = area.querySelector('.quick-actions');

      btn.addEventListener('mouseenter', () => {
        hoverTimeout = setTimeout(() => {
          qa.classList.add('visible');
        }, 400);
      });
      btn.addEventListener('mouseleave', () => {
        clearTimeout(hoverTimeout);
      });
      area.addEventListener('mouseleave', () => {
        clearTimeout(hoverTimeout);
        qa.classList.remove('visible');
      });

      // Long-press for mobile
      let pressTimer;
      btn.addEventListener('touchstart', (e) => {
        pressTimer = setTimeout(() => {
          e.preventDefault();
          qa.classList.add('visible');
        }, 500);
      }, { passive: false });
      btn.addEventListener('touchend', () => clearTimeout(pressTimer));
      btn.addEventListener('touchmove', () => clearTimeout(pressTimer));
    });
  }

  // Tap outside to dismiss quick actions and open add-note forms on mobile
  document.addEventListener('click', (e) => {
    if (e.target.closest('.quick-actions') || e.target.closest('.add-note-btn')) return;
    doc.querySelectorAll('.quick-actions.visible').forEach(qa => {
      qa.classList.remove('visible');
    });
  });

  // Tap on note to reveal/hide actions on mobile
  doc.addEventListener('click', (e) => {
    if (window.innerWidth > 600) return;
    const noteWrap = e.target.closest('.note-wrap');
    if (e.target.closest('.note-actions')) return;

    doc.querySelectorAll('.note-wrap.note-active').forEach(nw => {
      if (nw !== noteWrap) nw.classList.remove('note-active');
    });

    if (noteWrap) {
      noteWrap.classList.toggle('note-active');
    }
  });

  // ---- Time parsing ----
  function parseTimeFromText(text) {
    let hours, minutes;

    const klRegex = /\bkl\.?\s*(\d{1,2})(?::(\d{2}))?\b/i;
    const klMatch = text.match(klRegex);

    const ampmRegex = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i;
    const ampmMatch = text.match(ampmRegex);

    const h24Regex = /\b(\d{1,2}):(\d{2})\b/;
    const h24Match = text.match(h24Regex);

    if (klMatch) {
      hours = parseInt(klMatch[1]);
      minutes = klMatch[2] ? parseInt(klMatch[2]) : 0;
    } else if (ampmMatch) {
      hours = parseInt(ampmMatch[1]);
      minutes = ampmMatch[2] ? parseInt(ampmMatch[2]) : 0;
      const period = ampmMatch[3].toLowerCase();
      if (period === 'pm' && hours !== 12) hours += 12;
      if (period === 'am' && hours === 12) hours = 0;
    } else if (h24Match) {
      hours = parseInt(h24Match[1]);
      minutes = parseInt(h24Match[2]);
    } else {
      return { time: null };
    }

    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
      return { time: null };
    }

    return { time: `${String(hours).padStart(2,'0')}:${String(minutes).padStart(2,'0')}` };
  }

  function hasNoteTime(note) {
    return !!(note.time && String(note.time).trim());
  }

  /** Day order: all-day events → timed events → timed tasks → tasks without time */
  function sortNotesByTime(dayNotes) {
    function rank(note) {
      const isEv = note.isEvent === true;
      const t = hasNoteTime(note);
      if (isEv && !t) return 0;
      if (isEv && t) return 1;
      if (!isEv && t) return 2;
      return 3;
    }
    return [...dayNotes].sort((a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      if (ra !== rb) return ra - rb;
      const ta = hasNoteTime(a) ? a.time : null;
      const tb = hasNoteTime(b) ? b.time : null;
      if (ta && tb) return ta.localeCompare(tb);
      const textA = (a.text || '').slice(0, 80);
      const textB = (b.text || '').slice(0, 80);
      return textA.localeCompare(textB, 'da');
    });
  }

  // ---- Recurring detection ----
  // Matches English and Danish: "remind me every day", "mind mig hver dag", "birthday", "fødselsdag"
  const recurringRegex = /(?:remind\s+me\s+|mind\s+mig\s+)?(?:every\s*day|everyday|daily|hver\s*dag|daglig|dagligt|every\s*(?:2|two|other)\s*weeks?|(?:bi-?weekly)|hver\s*(?:2\.?|anden)\s*uge|hver\s*14\.?\s*dag|every\s*14\s*days?|every\s*week|weekly|hver\s*uge|ugentlig|ugentligt|(?:every|hver)\s*(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun|mandag|tirsdag|onsdag|torsdag|fredag|l[øo]rdag|s[øo]ndag)|every\s*month|monthly|hver\s*m[åa]ned|m[åa]nedlig|m[åa]nedligt|every\s*year|yearly|hvert?\s*[åa]r|[åa]rlig|[åa]rligt|birthday|f[øo]dselsdag)\s*(?:to\s+|om\s+at\s+|om\s+)?/i;

  const DAY_NAME_MAP = {
    sunday: 0, sun: 0, 'søndag': 0, 'sondag': 0,
    monday: 1, mon: 1, mandag: 1,
    tuesday: 2, tue: 2, tirsdag: 2,
    wednesday: 3, wed: 3, onsdag: 3,
    thursday: 4, thu: 4, torsdag: 4,
    friday: 5, fri: 5, fredag: 5,
    saturday: 6, sat: 6, 'lørdag': 6, 'lordag': 6
  };

  function parseRecurringFrequency(text, date) {
    const lower = text.toLowerCase();
    const d = parseDate(date);

    if (/birthday|f[øo]dselsdag/i.test(lower)) {
      return { frequency: 'yearly', month: d.getMonth(), dayOfMonth: d.getDate() };
    }
    if (/every\s*year|yearly|hvert\s*[åa]r|[åa]rlig/i.test(lower)) {
      return { frequency: 'yearly', month: d.getMonth(), dayOfMonth: d.getDate() };
    }
    if (/every\s*month|monthly|hver\s*m[åa]ned|m[åa]nedlig/i.test(lower)) {
      return { frequency: 'monthly', dayOfMonth: d.getDate() };
    }
    if (/every\s*(?:2|two|other)\s*weeks?|bi-?weekly|hver\s*(?:2\.?|anden)\s*uge|hver\s*14\.?\s*dag|every\s*14\s*days?/i.test(lower)) {
      return { frequency: 'biweekly', dayOfWeek: d.getDay() };
    }
    const dayMatch = lower.match(/(?:every|hver)\s*(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun|mandag|tirsdag|onsdag|torsdag|fredag|l[øo]rdag|s[øo]ndag)/i);
    if (dayMatch) {
      const dayName = dayMatch[1].toLowerCase().replace('ø', 'o');
      return { frequency: 'weekly', dayOfWeek: DAY_NAME_MAP[dayName] ?? DAY_NAME_MAP[dayMatch[1].toLowerCase()] };
    }
    if (/every\s*week|weekly|hver\s*uge|ugentlig/i.test(lower)) {
      return { frequency: 'weekly', dayOfWeek: d.getDay() };
    }
    return { frequency: 'daily' };
  }

  function freqFromRepeatChoice(choice, dateKey) {
    const d = parseDate(dateKey);
    switch (choice) {
      case 'daily': return { frequency: 'daily' };
      case 'weekly': return { frequency: 'weekly', dayOfWeek: d.getDay() };
      case 'biweekly': return { frequency: 'biweekly', dayOfWeek: d.getDay() };
      case 'monthly': return { frequency: 'monthly', dayOfMonth: d.getDate() };
      case 'yearly': return { frequency: 'yearly', month: d.getMonth(), dayOfMonth: d.getDate() };
      default: return { frequency: 'daily' };
    }
  }

  function cleanRecurringText(text) {
    // Only strip command-style prefixes like "mind mig hver dag om at" / "remind me every week to"
    // Keep standalone keywords like "fødselsdag", "birthday", "daglig" etc. as part of the note text
    const prefixRegex = /^(?:remind\s+me\s+|mind\s+mig\s+)(?:every\s*day|everyday|daily|hver\s*dag|daglig|dagligt|every\s*(?:2|two|other)\s*weeks?|(?:bi-?weekly)|hver\s*(?:2\.?|anden)\s*uge|hver\s*14\.?\s*dag|every\s*14\s*days?|every\s*week|weekly|hver\s*uge|ugentlig|ugentligt|(?:every|hver)\s*(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun|mandag|tirsdag|onsdag|torsdag|fredag|l[øo]rdag|s[øo]ndag)|every\s*month|monthly|hver\s*m[åa]ned|m[åa]nedlig|m[åa]nedligt|every\s*year|yearly|hvert?\s*[åa]r|[åa]rlig|[åa]rligt|birthday|f[øo]dselsdag)\s*(?:to\s+|om\s+at\s+|om\s+)?/i;
    const cleaned = text.replace(prefixRegex, '').trim();
    return cleaned || text.trim();
  }

  function isRecurringRequest(text) {
    return recurringRegex.test(text);
  }

  function getRecurringForDate(forDate) {
    const d = parseDate(forDate);
    return recurring
      .filter(r => {
        if (forDate < r.startDate) return false;
        if (r.doneDate === forDate) return false;

        const freq = r.frequency || 'daily';
        if (freq === 'daily') return forDate === dateKey(new Date()) || forDate === r.startDate;
        if (freq === 'biweekly') {
          if (d.getDay() !== r.dayOfWeek) return false;
          const start = parseDate(r.startDate);
          const diffMs = d.getTime() - start.getTime();
          const diffDays = Math.round(diffMs / 86400000);
          const diffWeeks = Math.round(diffDays / 7);
          return diffWeeks % 2 === 0;
        }
        if (freq === 'weekly') return d.getDay() === r.dayOfWeek;
        if (freq === 'monthly') return d.getDate() === r.dayOfMonth;
        if (freq === 'yearly') return d.getMonth() === r.month && d.getDate() === r.dayOfMonth;
        return false;
      })
      .map(r => ({
        id: `recurring-${r.id}-${forDate}`,
        recurringId: r.id,
        text: r.text,
        done: false,
        time: r.time || '',
        isRecurring: true,
        frequency: r.frequency || 'daily',
        leadTime: r.leadTime ?? null,
        isEvent: r.isEvent || false
      }));
  }

  // ---- Per-note lead time parsing ----
  function parseLeadTime(text) {
    const match = text.match(/\bremind\s+(\d+)\s*(min|mins|minutes|m|h|hrs|hours|hour)\b/i);
    if (!match) return null;
    const val = parseInt(match[1]);
    const unit = match[2].toLowerCase();
    if (unit.startsWith('h')) return val * 60;
    return val;
  }

  function cleanLeadTimeText(text) {
    return text.replace(/\s*\bremind\s+\d+\s*(min|mins|minutes|m|h|hrs|hours|hour)\b/i, '').trim();
  }

  function capitalizeFirst(s) {
    if (!s) return s;
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function addNote(date, text, uiLeadTime, isEvent) {
    text = text.trim();
    if (!text) return;

    text = capitalizeFirst(text);
    text = applySmartLinks(text);

    if (isRecurringRequest(text)) {
      const { time: parsedTime } = parseTimeFromText(text);
      const leadTime = uiLeadTime || parseLeadTime(text);
      const freq = parseRecurringFrequency(text, date);
      let cleanText = applySmartLinks(cleanRecurringText(text));
      if (leadTime !== null) cleanText = cleanLeadTimeText(cleanText);
      const rec = {
        id: crypto.randomUUID(),
        text: cleanText || text,
        time: parsedTime || null,
        startDate: date,
        doneDate: null,
        frequency: freq.frequency,
        dayOfWeek: freq.dayOfWeek,
        month: freq.month,
        dayOfMonth: freq.dayOfMonth,
        leadTime: leadTime,
        isEvent: isEvent || false
      };
      recurring.push(rec);
      saveRecurring();
      if (rec.isEvent) {
        maybeAutoSendEventToGoogleCalendar({
          id: rec.id,
          date: rec.startDate,
          text: rec.text,
          time: rec.time || null,
          leadTime: rec.leadTime ?? null,
          recurring: rec
        });
      }
      render();
      return;
    }

    if (!notes[date]) notes[date] = [];

    const { time: parsedTime } = parseTimeFromText(text);
    const textLeadTime = parseLeadTime(text);
    if (textLeadTime !== null) text = cleanLeadTimeText(text);
    const leadTime = uiLeadTime || textLeadTime;

    const note = {
      id: crypto.randomUUID(),
      text,
      done: false,
      time: parsedTime || null,
      leadTime: leadTime,
      isEvent: isEvent || false
    };

    notes[date].push(note);

    notes[date] = sortNotesByTime(notes[date]);
    saveNotes(notes);
    if (note.isEvent) {
      maybeAutoSendEventToGoogleCalendar({
        id: note.id,
        date,
        text: note.text,
        time: note.time || null,
        leadTime: note.leadTime ?? null
      });
    }
    render();
  }

  function addSmartListNote(date, listType) {
    if (!notes[date]) notes[date] = [];
    if (notes[date].some(n => n.smartList === listType)) {
      const label = listType === 'todo' ? 'to-do' : 'shopping';
      alert(`There is already a ${label} list on this day.`);
      return;
    }
    notes[date].push({
      id: crypto.randomUUID(),
      text: '',
      done: false,
      time: null,
      leadTime: null,
      isEvent: false,
      smartList: listType,
      listItems: [{ id: crypto.randomUUID(), text: '', done: false }]
    });
    notes[date] = sortNotesByTime(notes[date]);
    saveNotes(notes);
    render();
  }

  function getCalendarAtToken(text, cursor) {
    const before = text.slice(0, cursor);
    const atIdx = before.lastIndexOf('@');
    if (atIdx === -1) return null;
    const afterAt = before.slice(atIdx + 1);
    if (/[\s\n]/.test(afterAt)) return null;
    return { start: atIdx, query: afterAt };
  }

  function getTextareaCaretRect(textarea, position) {
    const mirror = document.createElement('div');
    const style = window.getComputedStyle(textarea);
    [
      'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing',
      'paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom',
      'borderLeftWidth', 'borderTopWidth', 'width', 'boxSizing'
    ].forEach((prop) => {
      mirror.style[prop] = style[prop];
    });
    mirror.style.whiteSpace = 'pre-wrap';
    mirror.style.wordWrap = 'break-word';
    mirror.style.position = 'absolute';
    mirror.style.visibility = 'hidden';
    mirror.style.left = '-9999px';
    mirror.style.top = '0';
    const before = textarea.value.substring(0, position);
    mirror.textContent = before;
    const span = document.createElement('span');
    span.textContent = textarea.value.substring(position) || '.';
    mirror.appendChild(span);
    document.body.appendChild(mirror);
    const taRect = textarea.getBoundingClientRect();
    const top = span.offsetTop + parseFloat(style.paddingTop || '0') + parseFloat(style.borderTopWidth || '0');
    const left = span.offsetLeft + parseFloat(style.paddingLeft || '0') + parseFloat(style.borderLeftWidth || '0');
    document.body.removeChild(mirror);
    return {
      top: taRect.top + top - textarea.scrollTop,
      left: taRect.left + left - textarea.scrollLeft
    };
  }

  let calendarSmartListMenuOpen = false;
  let calendarSmartListAnchor = null;

  function hideCalendarSmartListMenu() {
    const menu = document.getElementById('calendarSmartListMenu');
    if (!menu) return;
    menu.classList.add('hidden');
    menu.setAttribute('aria-hidden', 'true');
    calendarSmartListMenuOpen = false;
    calendarSmartListAnchor = null;
  }

  function positionCalendarSmartListMenu(textarea) {
    const menu = document.getElementById('calendarSmartListMenu');
    if (!menu || !textarea) return;
    const pos = textarea.selectionStart;
    const { top, left } = getTextareaCaretRect(textarea, pos);
    const lh = parseFloat(window.getComputedStyle(textarea).lineHeight) || 20;
    let menuTop = top + lh + 4;
    let menuLeft = left;
    const mw = menu.offsetWidth || 160;
    const mh = menu.offsetHeight || 72;
    if (menuLeft + mw > window.innerWidth - 8) menuLeft = window.innerWidth - mw - 8;
    if (menuTop + mh > window.innerHeight - 8) menuTop = top - mh - 4;
    if (menuLeft < 8) menuLeft = 8;
    if (menuTop < 8) menuTop = 8;
    menu.style.left = `${menuLeft}px`;
    menu.style.top = `${menuTop}px`;
  }

  function updateCalendarSmartListMenu(textarea) {
    const menu = document.getElementById('calendarSmartListMenu');
    if (!menu) return;
    const cur = textarea.selectionStart;
    const token = getCalendarAtToken(textarea.value, cur);
    if (!token) {
      hideCalendarSmartListMenu();
      return;
    }
    menu.dataset.date = textarea.dataset.date || '';
    calendarSmartListAnchor = textarea;
    calendarSmartListMenuOpen = true;
    menu.classList.remove('hidden');
    menu.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => {
      requestAnimationFrame(() => positionCalendarSmartListMenu(textarea));
    });
  }

  // ---- Search ----
  let searchTimeout;
  searchBox.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      searchTerm = searchBox.value.trim();
      render();
      searchNotebook(searchTerm);
    }, 200);
  });

  function searchNotebook(term) {
    notebookTabs.querySelectorAll('.notebook-tab[data-page-id]').forEach(t => t.classList.remove('tab-match'));

    if (!term) {
      notebookEditor.classList.remove('has-search-match');
      clearNotebookHighlight();
      return;
    }

    const lowerTerm = term.toLowerCase();
    let firstMatchId = null;

    for (const page of notebook.pages) {
      const inTitle = (page.title || '').toLowerCase().includes(lowerTerm);
      const inContent = (page.content || '').toLowerCase().includes(lowerTerm);
      if (inTitle || inContent) {
        const tab = notebookTabs.querySelector(`.notebook-tab[data-page-id="${page.id}"]`);
        if (tab) tab.classList.add('tab-match');
        if (!firstMatchId) firstMatchId = page.id;
      }
    }

    if (firstMatchId) {
      const currentPage = getActivePage();
      const currentMatches =
        (currentPage.title || '').toLowerCase().includes(lowerTerm) ||
        (currentPage.content || '').toLowerCase().includes(lowerTerm);

      if (!currentMatches) {
        notebook.activePageId = firstMatchId;
        markPageActivated(firstMatchId);
        saveNotebook();
        renderNotebook();
      }

      if (layoutState.mode === 'tabs') {
        if (layoutState.activeTab !== 'notebook') {
          layoutState.activeTab = 'notebook';
          saveLayout();
          applyLayout();
        }
      } else if (notebook.collapsed) {
        notebook.collapsed = false;
        saveNotebook();
        renderNotebook();
        setTimeout(updateStickyOffsets, 10);
      }

      notebookEditor.classList.add('has-search-match');
      scrollToNotebookMatch(lowerTerm);
    } else {
      notebookEditor.classList.remove('has-search-match');
      clearNotebookHighlight();
    }
  }

  function clearNotebookHighlight() {
    notebookEditor.querySelectorAll('mark.nb-search-hl').forEach(m => {
      const parent = m.parentNode;
      parent.replaceChild(document.createTextNode(m.textContent), m);
      parent.normalize();
    });
  }

  function scrollToNotebookMatch(term) {
    clearNotebookHighlight();
    if (!term) return;

    const t = term.toLowerCase();
    const matches = [];
    const walker = document.createTreeWalker(notebookEditor, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent;
      if (!text) continue;
      const lower = text.toLowerCase();
      let from = 0;
      let idx;
      while ((idx = lower.indexOf(t, from)) !== -1) {
        matches.push({ node, start: idx, end: idx + term.length });
        from = idx + term.length;
      }
    }

    matches.sort((a, b) => {
      if (a.node === b.node) return a.start - b.start;
      const pos = a.node.compareDocumentPosition(b.node);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });

    const MAX_MARKS = 200;
    if (matches.length > MAX_MARKS) matches.length = MAX_MARKS;

    for (let i = matches.length - 1; i >= 0; i--) {
      const { node: n, start, end } = matches[i];
      const range = document.createRange();
      range.setStart(n, start);
      range.setEnd(n, end);
      const mark = document.createElement('mark');
      mark.className = 'nb-search-hl';
      try {
        range.surroundContents(mark);
      } catch (_) {
        /* range crosses element boundary */
      }
    }

    const firstMark = notebookEditor.querySelector('mark.nb-search-hl');
    if (firstMark) {
      firstMark.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  function clearMobileSearch() {
    const msRow = document.getElementById('mobileSearchRow');
    const msInput = document.getElementById('mobileSearchInput');
    if (msRow) msRow.classList.remove('active');
    if (msInput) msInput.value = '';
  }

  // ---- Today button ----
  document.getElementById('todayBtn').addEventListener('click', () => {
    searchBox.value = '';
    searchTerm = '';
    clearMobileSearch();
    layoutState.mobileActiveView = 'calendar';
    if (layoutState.mode === 'tabs' && layoutState.activeTab !== 'calendar') {
      layoutState.activeTab = 'calendar';
      saveLayout();
      applyLayout();
    } else {
      saveLayout();
      applyLayout();
    }
    render();
    setTimeout(() => scrollCalendarToToday('smooth'), 50);
  });

  // ---- Settings helpers ----
  function getPlannerExportData() {
    return JSON.stringify({ notes, recurring, standaloneTodos, pushupWidget, notebook, smartLinks }, null, 2);
  }

  function applyImportedPlannerData(imported) {
    const importedNotes = imported.notes || imported;
    const importedRecurring = imported.recurring || [];
    const importedStandaloneTodos = Array.isArray(imported.standaloneTodos) ? imported.standaloneTodos : [];
    const importedPushupWidget = imported.pushupWidget ? normalizePushupWidget(imported.pushupWidget) : null;
    const importedNotebook = imported.notebook || null;
    const importedSmartLinks = Array.isArray(imported.smartLinks) ? imported.smartLinks : null;

    for (const [date, dayNotes] of Object.entries(importedNotes)) {
      if (!Array.isArray(dayNotes)) continue;
      if (!notes[date]) notes[date] = [];
      for (const note of dayNotes) {
        if (!notes[date].find(n => n.id === note.id)) {
          notes[date].push(note);
        }
      }
    }

    for (const rec of importedRecurring) {
      if (!recurring.find(r => r.id === rec.id)) {
        recurring.push(rec);
      }
    }

    for (const todo of importedStandaloneTodos) {
      if (todo && todo.id && !standaloneTodos.find(t => t.id === todo.id)) {
        standaloneTodos.push(todo);
      }
    }

    if (importedPushupWidget) {
      const existingPushupSetIds = new Set(pushupWidget.sets.map(set => set.id));
      pushupWidget.enabled = importedPushupWidget.enabled;
      pushupWidget.yearGoal = importedPushupWidget.yearGoal;
      pushupWidget.monthGoal = importedPushupWidget.monthGoal;
      for (const set of importedPushupWidget.sets) {
        if (!existingPushupSetIds.has(set.id)) {
          pushupWidget.sets.push(set);
          existingPushupSetIds.add(set.id);
        }
      }
      if (importedPushupWidget.lastRecord?.at) {
        const importedRecordTime = new Date(importedPushupWidget.lastRecord.at).getTime();
        const currentRecordTime = pushupWidget.lastRecord?.at ? new Date(pushupWidget.lastRecord.at).getTime() : 0;
        if (!pushupWidget.lastRecord || importedRecordTime > currentRecordTime) {
          pushupWidget.lastRecord = importedPushupWidget.lastRecord;
        }
      }
      savePushupWidget();
    }

    if (importedNotebook?.pages) {
      for (const page of importedNotebook.pages) {
        if (!notebook.pages.find(p => p.id === page.id)) {
          notebook.pages.push(page);
        }
      }
      saveNotebook();
      renderNotebook();
    }

    if (importedSmartLinks) {
      smartLinks = importedSmartLinks;
      saveSmartLinks();
      renderSettingsSmartLinksUI();
    }

    saveNotes(notes);
    saveRecurring();
    saveStandaloneTodos();
    render();
  }

  function refreshSettingsExport() {
    const exportTextarea = document.getElementById('settingsExportTextarea');
    if (exportTextarea) exportTextarea.value = getPlannerExportData();
  }

  function setSettingsStatus(id, message, color = 'var(--text-dim)') {
    const status = document.getElementById(id);
    if (!status) return;
    status.textContent = message;
    status.style.color = color;
  }

  async function copySettingsExport() {
    const data = getPlannerExportData();
    refreshSettingsExport();
    try {
      await navigator.clipboard.writeText(data);
      setSettingsStatus('settingsExportStatus', 'Copied.');
    } catch (_) {
      setSettingsStatus('settingsExportStatus', 'Copy failed. Select the export text manually.', 'var(--accent)');
    }
  }

  function importSettingsData() {
    const textarea = document.getElementById('settingsImportTextarea');
    if (!textarea) return;
    try {
      const imported = JSON.parse(textarea.value);
      applyImportedPlannerData(imported);
      refreshSettingsExport();
      textarea.value = '';
      setSettingsStatus('settingsImportStatus', 'Imported.');
    } catch (_) {
      setSettingsStatus('settingsImportStatus', 'Invalid JSON data.', 'var(--accent)');
    }
  }

  function collectSmartLinksFromSettingsUI() {
    const container = document.getElementById('settingsSmartLinksList');
    if (!container) return [];
    return Array.from(container.querySelectorAll('.sl-rule'))
      .map((rule) => {
        const keywords = rule.querySelector('.sl-keywords')?.value
          .split(',')
          .map(k => k.trim())
          .filter(Boolean) || [];
        const url = rule.querySelector('.sl-url')?.value.trim() || '';
        return keywords.length && url ? { keywords, url, label: '' } : null;
      })
      .filter(Boolean);
  }

  function renderSettingsSmartLinksUI(rules = smartLinks || []) {
    const container = document.getElementById('settingsSmartLinksList');
    if (!container) return;
    const normalized = Array.isArray(rules) ? rules : [];
    if (!normalized.length) {
      container.innerHTML = '<p class="settings-help">No Smart Links yet.</p>';
      return;
    }
    container.innerHTML = normalized.map((rule, i) => `
      <div class="sl-rule" data-index="${i}">
        <div class="sl-row"><label>Keywords</label><input type="text" class="sl-keywords" value="${escapeHtml((rule.keywords || []).join(', '))}" placeholder="haircut, dentist, invoice"></div>
        <div class="sl-row"><label>URL</label><input type="url" class="sl-url" value="${escapeHtml(rule.url || '')}" placeholder="https://..."></div>
        <button type="button" class="sl-remove" data-index="${i}" title="Remove">&times;</button>
      </div>
    `).join('');
  }

  // ---- Notebook ----
  const NB_STORAGE_KEY = 'endless-planner-notebook';

  function loadNotebook() {
    try {
      const data = JSON.parse(localStorage.getItem(NB_STORAGE_KEY));
      if (data && data.pages && data.pages.length > 0) return data;
    } catch {}
    return {
      pages: [{ id: crypto.randomUUID(), title: 'General Notes', content: '', updated: Date.now() }],
      activePageId: null,
      collapsed: false
    };
  }

  function saveNotebook() {
    localStorage.setItem(NB_STORAGE_KEY, JSON.stringify(notebook));
    if (syncReady) SupabaseSync.save('notebook', notebook);
  }

  let notebook = loadNotebook();
  if (!notebook.activePageId) notebook.activePageId = notebook.pages[0].id;

  const notebookTabs = document.getElementById('notebookTabs');
  const notebookTitle = document.getElementById('notebookTitle');
  const notebookEditor = document.getElementById('notebookEditor');
  const notebookToolbar = document.getElementById('notebookToolbar');
  const notebookCharCount = document.getElementById('notebookCharCount');
  const notebookLastSaved = document.getElementById('notebookLastSaved');
  const notebookContent = document.getElementById('notebookContent');
  const notebookToggle = document.getElementById('notebookToggle');
  const notebookAddBtn = document.getElementById('notebookAddBtn');

  function migrateMarkdownToHtml(text) {
    if (!text || /<[a-z/]/i.test(text)) {
      return text;
    }
    const lines = text.split('\n');
    const result = [];
    for (const line of lines) {
      let html = escapeHtml(line);
      html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      result.push(html);
    }
    return result.join('<br>');
  }

  function repairCorruptedHtml(html) {
    if (!html || !html.includes('&amp;')) return html;
    const el = document.createElement('div');
    let prev = html;
    for (let i = 0; i < 20; i++) {
      el.innerHTML = prev;
      const decoded = el.innerHTML;
      if (decoded === prev) break;
      prev = decoded;
    }
    return prev;
  }

  (function repairNotebookPages() {
    let changed = false;
    for (const page of notebook.pages) {
      if (page.content && page.content.includes('&amp;amp;')) {
        page.content = repairCorruptedHtml(page.content);
        changed = true;
      }
    }
    if (changed) saveNotebook();
  })();

  (function migrateNotebookPins() {
    const pinned = notebook.pages.filter(p => p.pinned);
    if (!pinned.length) return;
    if (pinned.some(p => p.pinnedRank == null)) {
      pinned.sort((a, b) => (a.updated || 0) - (b.updated || 0));
      pinned.forEach((p, i) => {
        p.pinnedRank = i;
      });
      saveNotebook();
    }
  })();

  function sortPagesForSidebar(pages) {
    const pinned = pages.filter(p => p.pinned).sort((a, b) => (a.pinnedRank || 0) - (b.pinnedRank || 0));
    const unpinned = pages
      .filter(p => !p.pinned)
      .sort((a, b) => (b.lastActiveAt || b.updated || 0) - (a.lastActiveAt || a.updated || 0));
    return [...pinned, ...unpinned];
  }

  function compactPinnedRanks() {
    const pinned = notebook.pages.filter(p => p.pinned).sort((a, b) => (a.pinnedRank || 0) - (b.pinnedRank || 0));
    pinned.forEach((p, i) => {
      p.pinnedRank = i;
    });
  }

  function toggleSidebarPin(pageId) {
    const p = notebook.pages.find(x => x.id === pageId);
    if (!p) return;
    if (p.pinned) {
      p.pinned = false;
      delete p.pinnedRank;
      compactPinnedRanks();
    } else {
      const ranks = notebook.pages.filter(x => x.pinned).map(x => x.pinnedRank ?? 0);
      const maxR = ranks.length ? Math.max(...ranks) : -1;
      p.pinned = true;
      p.pinnedRank = maxR + 1;
    }
    saveNotebook();
    renderSidebar();
  }

  function reorderPinnedPages(draggedId, targetId, insertBefore) {
    let ids = notebook.pages
      .filter(p => p.pinned)
      .sort((a, b) => (a.pinnedRank || 0) - (b.pinnedRank || 0))
      .map(p => p.id);
    const from = ids.indexOf(draggedId);
    const hasTarget = ids.includes(targetId);
    if (from === -1 || !hasTarget || draggedId === targetId) return;
    ids.splice(from, 1);
    let insertAt = ids.indexOf(targetId);
    if (insertBefore) {
      ids.splice(insertAt, 0, draggedId);
    } else {
      ids.splice(insertAt + 1, 0, draggedId);
    }
    ids.forEach((id, i) => {
      const pg = notebook.pages.find(x => x.id === id);
      if (pg) pg.pinnedRank = i;
    });
    saveNotebook();
    renderSidebar();
  }

  const NB_PIN_SVG =
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M9.828.722a.5.5 0 0 1 .354.146l4.95 4.95a.5.5 0 0 1 0 .707c-.48.48-1.072.588-1.503.588-.177 0-.335-.018-.46-.039l-3.134 3.134a5.927 5.927 0 0 1 .16 1.013c.046.702-.032 1.687-.72 2.375a.5.5 0 0 1-.707 0l-2.829-2.828-3.182 3.182c-.195.195-1.219.902-1.414.707-.195-.195.512-1.22.707-1.414l3.182-3.182-2.828-2.829a.5.5 0 0 1 0-.707c.688-.688 1.673-.767 2.375-.72a5.922 5.922 0 0 1 1.013.16l3.134-3.133a2.772 2.772 0 0 1-.04-.461c0-.431.108-1.022.589-1.503a.5.5 0 0 1 .353-.146z"/></svg>';

  let nbSidebarDragOverEl = null;
  let nbSidebarDragSourceId = null;
  let nbContextPageId = null;

  function getActivePages() {
    return notebook.pages.filter(p => !p.archived);
  }

  function getArchivedPages() {
    return notebook.pages.filter(p => p.archived);
  }

  function getActivePage() {
    const active = getActivePages();
    return active.find(p => p.id === notebook.activePageId) || active[0];
  }

  /** Sidebar order: most recently selected tab first (falls back to `updated`). */
  function markPageActivated(id) {
    if (!id) return;
    const p = notebook.pages.find(x => x.id === id);
    if (p) p.lastActiveAt = Date.now();
  }

  function renderNotebook({ forceEditorUpdate = false } = {}) {
    const activePages = getActivePages();
    let tabsHtml = '';
    for (const page of activePages) {
      const active = page.id === notebook.activePageId ? 'active' : '';
      const title = page.title || 'Untitled';
      tabsHtml += `<button class="notebook-tab ${active}" data-page-id="${page.id}">
        ${escapeHtml(title)}
        ${activePages.length > 1 ? `<span class="tab-close" data-page-id="${page.id}">&times;</span>` : ''}
      </button>`;
    }
    notebookTabs.innerHTML = tabsHtml;
    if (notebookAddBtn) notebookTabs.appendChild(notebookAddBtn);

    renderSidebar();

    const page = getActivePage();
    const editorFocused = document.activeElement === notebookEditor;

    if (!editorFocused || forceEditorUpdate) {
      notebookTitle.value = page.title || '';
      const html = migrateMarkdownToHtml(page.content || '');
      if (html !== page.content) {
        page.content = html;
        saveNotebook();
      }
      notebookEditor.innerHTML = page.content || '';
    }
    updateNotebookMeta(page);

    const chevron = notebookToggle.querySelector('.chevron');
    if (notebook.collapsed) {
      notebookContent.classList.add('notebook-collapsed');
      notebookAddBtn.classList.add('hidden');
      chevron.classList.remove('open');
    } else {
      notebookContent.classList.remove('notebook-collapsed');
      notebookAddBtn.classList.remove('hidden');
      chevron.classList.add('open');
    }
  }

  function updateNotebookMeta(page) {
    const len = (notebookEditor.textContent || '').length;
    notebookCharCount.textContent = `${len} character${len !== 1 ? 's' : ''}`;
    if (page.updated) {
      const d = new Date(page.updated);
      notebookLastSaved.textContent = `Saved ${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    }
  }

  // Toolbar buttons
  notebookToolbar.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const btn = e.target.closest('button[data-cmd]');
    if (!btn) return;
    notebookEditor.focus();
    document.execCommand(btn.dataset.cmd, false, null);
  });

  // Keyboard shortcuts inside notebook editor
  notebookEditor.addEventListener('keydown', (e) => {
    const isCtrl = e.ctrlKey || e.metaKey;
    if (!isCtrl) return;

    if (e.key.toLowerCase() === 'b' && !e.shiftKey) {
      e.preventDefault();
      document.execCommand('bold', false, null);
      return;
    }
    if (e.shiftKey && e.code === 'Digit8') {
      e.preventDefault();
      document.execCommand('insertUnorderedList', false, null);
      return;
    }
    if (e.shiftKey && e.code === 'Digit7') {
      e.preventDefault();
      document.execCommand('insertOrderedList', false, null);
    }
  });

  function archivePage(id) {
    const page = notebook.pages.find(p => p.id === id);
    if (!page) return;
    page.archived = true;
    if (notebook.activePageId === id) {
      const active = getActivePages();
      notebook.activePageId = active[0]?.id;
      markPageActivated(notebook.activePageId);
    }
    saveNotebook();
    renderNotebook({ forceEditorUpdate: true });
  }

  function restorePage(id) {
    const page = notebook.pages.find(p => p.id === id);
    if (!page) return;
    page.archived = false;
    notebook.activePageId = id;
    markPageActivated(id);
    saveNotebook();
    renderNotebook({ forceEditorUpdate: true });
  }

  function deletePagePermanently(id) {
    const page = notebook.pages.find(p => p.id === id);
    const title = page ? (page.title || 'Untitled') : 'this page';
    if (!confirm(`Permanently delete "${title}"? This cannot be undone.`)) return;
    notebook.pages = notebook.pages.filter(p => p.id !== id);
    compactPinnedRanks();
    saveNotebook();
    renderNotebook({ forceEditorUpdate: true });
  }

  // ---- Notebook sidebar ----
  const nbSidebar = document.getElementById('nbSidebar');
  const nbSidebarOverlay = document.getElementById('nbSidebarOverlay');
  const nbSidebarList = document.getElementById('nbSidebarList');
  const nbSidebarToggle = document.getElementById('nbSidebarToggle');
  const nbSidebarClose = document.getElementById('nbSidebarClose');
  const nbSidebarNew = document.getElementById('nbSidebarNew');

  function openSidebar() {
    renderSidebar();
    nbSidebar.classList.add('open');
    if (isMobileViewport()) nbSidebarOverlay.classList.add('active');
  }
  function closeSidebar() {
    nbSidebar.classList.remove('open');
    nbSidebarOverlay.classList.remove('active');
  }

  nbSidebarToggle.addEventListener('click', () => {
    if (nbSidebar.classList.contains('open')) closeSidebar();
    else openSidebar();
  });
  nbSidebarClose.addEventListener('click', closeSidebar);
  nbSidebarOverlay.addEventListener('click', closeSidebar);

  nbSidebarNew.addEventListener('click', () => {
    const now = Date.now();
    const newPage = { id: crypto.randomUUID(), title: '', content: '', updated: now, lastActiveAt: now, archived: false };
    notebook.pages.push(newPage);
    notebook.activePageId = newPage.id;
    saveNotebook();
    renderNotebook({ forceEditorUpdate: true });
    if (isMobileViewport()) closeSidebar();
    notebookTitle.focus();
  });

  function renderSidebar() {
    const sorted = sortPagesForSidebar([...notebook.pages]);
    nbSidebarList.innerHTML = sorted
      .map(p => {
        const title = escapeHtml(p.title || 'Untitled');
        const date = p.updated ? new Date(p.updated).toLocaleDateString() : '';
        const isActive = p.id === notebook.activePageId && !p.archived;
        const cls = ['nb-sidebar-item'];
        if (isActive) cls.push('active');
        if (p.archived) cls.push('archived');
        if (p.pinned) cls.push('pinned');
        const draggable = p.pinned ? 'true' : 'false';
        const pinIndicator = p.pinned
          ? `<span class="nb-sidebar-item-pin-indicator" title="Pinned" aria-label="Pinned">${NB_PIN_SVG}</span>`
          : '';
        return `<div class="${cls.join(' ')}" data-page-id="${p.id}" data-pinned="${p.pinned ? 'true' : 'false'}" draggable="${draggable}">
        <div class="nb-sidebar-item-info">
          <span class="nb-sidebar-item-title">${title}</span>
          <span class="nb-sidebar-item-date">${date}${p.archived ? ' &middot; archived' : ''}</span>
        </div>
        <div class="nb-sidebar-item-trailing">
          ${pinIndicator}
          <button type="button" class="nb-sidebar-item-delete" data-page-id="${p.id}" draggable="false" title="Delete permanently">&times;</button>
        </div>
      </div>`;
      })
      .join('');
  }

  function hideNbSidebarContextMenu() {
    const menu = document.getElementById('nbSidebarContextMenu');
    if (!menu) return;
    menu.classList.add('hidden');
    menu.setAttribute('aria-hidden', 'true');
    nbContextPageId = null;
  }

  function showNbSidebarContextMenu(clientX, clientY, pageId) {
    const menu = document.getElementById('nbSidebarContextMenu');
    const btn = document.getElementById('nbSidebarCtxPin');
    const page = notebook.pages.find(p => p.id === pageId);
    if (!menu || !page || !btn) return;
    nbContextPageId = pageId;
    btn.textContent = page.pinned ? 'Unpin' : 'Pin';
    menu.classList.remove('hidden');
    menu.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => {
      const w = menu.offsetWidth;
      const h = menu.offsetHeight;
      let left = clientX;
      let top = clientY;
      if (left + w > window.innerWidth - 8) left = window.innerWidth - w - 8;
      if (top + h > window.innerHeight - 8) top = window.innerHeight - h - 8;
      if (left < 8) left = 8;
      if (top < 8) top = 8;
      menu.style.left = `${left}px`;
      menu.style.top = `${top}px`;
    });
  }

  nbSidebarList.addEventListener('contextmenu', e => {
    const item = e.target.closest('.nb-sidebar-item');
    if (!item) return;
    e.preventDefault();
    showNbSidebarContextMenu(e.clientX, e.clientY, item.dataset.pageId);
  });

  nbSidebarList.addEventListener('scroll', () => hideNbSidebarContextMenu());

  document.getElementById('nbSidebarCtxPin').addEventListener('click', e => {
    e.stopPropagation();
    if (nbContextPageId) toggleSidebarPin(nbContextPageId);
    hideNbSidebarContextMenu();
  });

  document.getElementById('nbSidebarCtxDelete').addEventListener('click', e => {
    e.stopPropagation();
    if (nbContextPageId) {
      deletePagePermanently(nbContextPageId);
      renderSidebar();
    }
    hideNbSidebarContextMenu();
  });

  document.addEventListener('click', e => {
    const menu = document.getElementById('nbSidebarContextMenu');
    if (!menu || menu.classList.contains('hidden')) return;
    if (menu.contains(e.target)) return;
    hideNbSidebarContextMenu();
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') hideNbSidebarContextMenu();
  });

  nbSidebarList.addEventListener('click', (e) => {
    const deleteBtn = e.target.closest('.nb-sidebar-item-delete');
    if (deleteBtn) {
      e.stopPropagation();
      deletePagePermanently(deleteBtn.dataset.pageId);
      renderSidebar();
      return;
    }
    const item = e.target.closest('.nb-sidebar-item');
    if (item) {
      const id = item.dataset.pageId;
      const page = notebook.pages.find(p => p.id === id);
      if (!page) return;
      if (page.archived) {
        page.archived = false;
      }
      notebook.activePageId = id;
      markPageActivated(id);
      saveNotebook();
      renderNotebook({ forceEditorUpdate: true });
      if (isMobileViewport()) closeSidebar();
    }
  });

  nbSidebarList.addEventListener('dragstart', e => {
    const row = e.target.closest('.nb-sidebar-item[draggable="true"]');
    if (!row) return;
    if (e.target.closest('button')) {
      e.preventDefault();
      return;
    }
    nbSidebarDragSourceId = row.dataset.pageId;
    e.dataTransfer.setData('text/plain', row.dataset.pageId);
    e.dataTransfer.effectAllowed = 'move';
    row.classList.add('nb-sidebar-item-dragging');
  });

  nbSidebarList.addEventListener('dragend', () => {
    nbSidebarDragSourceId = null;
    nbSidebarList.querySelectorAll('.nb-sidebar-item-dragging').forEach(el => el.classList.remove('nb-sidebar-item-dragging'));
    nbSidebarList.querySelectorAll('.nb-sidebar-drop-target').forEach(el => el.classList.remove('nb-sidebar-drop-target'));
    nbSidebarDragOverEl = null;
  });

  nbSidebarList.addEventListener('dragover', e => {
    const row = e.target.closest('.nb-sidebar-item[data-pinned="true"]');
    if (!row || !nbSidebarDragSourceId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (nbSidebarDragOverEl && nbSidebarDragOverEl !== row) {
      nbSidebarDragOverEl.classList.remove('nb-sidebar-drop-target');
    }
    nbSidebarDragOverEl = row;
    row.classList.add('nb-sidebar-drop-target');
  });

  nbSidebarList.addEventListener('drop', e => {
    const targetRow = e.target.closest('.nb-sidebar-item[data-pinned="true"]');
    const draggedId = e.dataTransfer.getData('text/plain');
    e.preventDefault();
    nbSidebarList.querySelectorAll('.nb-sidebar-drop-target').forEach(el => el.classList.remove('nb-sidebar-drop-target'));
    nbSidebarDragOverEl = null;
    if (!targetRow || !draggedId) return;
    const targetId = targetRow.dataset.pageId;
    if (draggedId === targetId) return;
    const rect = targetRow.getBoundingClientRect();
    const insertBefore = e.clientY < rect.top + rect.height / 2;
    reorderPinnedPages(draggedId, targetId, insertBefore);
  });

  notebookTabs.addEventListener('click', (e) => {
    const closeBtn = e.target.closest('.tab-close');
    if (closeBtn) {
      archivePage(closeBtn.dataset.pageId);
      return;
    }
    const tab = e.target.closest('.notebook-tab[data-page-id]');
    if (tab) {
      notebook.activePageId = tab.dataset.pageId;
      markPageActivated(tab.dataset.pageId);
      saveNotebook();
      renderNotebook({ forceEditorUpdate: true });
    }
  });

  notebookToggle.addEventListener('click', () => {
    if (layoutState.mode === 'tabs') return;
    notebook.collapsed = !notebook.collapsed;
    saveNotebook();
    renderNotebook();
    setTimeout(updateStickyOffsets, 10);
  });

  notebookAddBtn.addEventListener('click', () => {
    const now = Date.now();
    const newPage = { id: crypto.randomUUID(), title: '', content: '', updated: now, lastActiveAt: now, archived: false };
    notebook.pages.push(newPage);
    notebook.activePageId = newPage.id;
    saveNotebook();
    renderNotebook({ forceEditorUpdate: true });
    notebookTitle.focus();
  });

  let nbTitleTimeout;
  notebookTitle.addEventListener('input', () => {
    clearTimeout(nbTitleTimeout);
    nbTitleTimeout = setTimeout(() => {
      const page = getActivePage();
      page.title = notebookTitle.value;
      page.updated = Date.now();
      saveNotebook();
      renderNotebook();
    }, 300);
  });

  let nbContentTimeout;
  notebookEditor.addEventListener('input', () => {
    clearTimeout(nbContentTimeout);
    nbContentTimeout = setTimeout(() => {
      const page = getActivePage();
      page.content = notebookEditor.innerHTML;
      page.updated = Date.now();
      saveNotebook();
      updateNotebookMeta(page);
      notebookLastSaved.textContent = `Saved just now`;
    }, 400);
  });

  // ---- Notebook resize handle ----
  const NB_HEIGHT_KEY = 'endless-planner-nb-height';
  const resizeHandle = document.getElementById('notebookResizeHandle');
  const savedNbHeight = localStorage.getItem(NB_HEIGHT_KEY);
  if (savedNbHeight) {
    document.getElementById('notebookBody').style.setProperty('--nb-editor-height', savedNbHeight + 'px');
  }

  let nbDragStartY = 0;
  let nbDragStartH = 0;

  function onNbDragMove(e) {
    if (e.cancelable) e.preventDefault();
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    const delta = clientY - nbDragStartY;
    const newH = Math.max(40, Math.min(window.innerHeight * 0.7, nbDragStartH + delta));
    document.getElementById('notebookBody').style.setProperty('--nb-editor-height', newH + 'px');
  }

  function onNbDragEnd() {
    resizeHandle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    const computed = getComputedStyle(document.getElementById('notebookBody')).getPropertyValue('--nb-editor-height');
    localStorage.setItem(NB_HEIGHT_KEY, parseInt(computed));
    document.removeEventListener('mousemove', onNbDragMove);
    document.removeEventListener('mouseup', onNbDragEnd);
    document.removeEventListener('touchmove', onNbDragMove);
    document.removeEventListener('touchend', onNbDragEnd);
    setTimeout(updateStickyOffsets, 10);
  }

  function onNbDragStart(e) {
    e.preventDefault();
    resizeHandle.classList.add('dragging');
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
    nbDragStartY = e.touches ? e.touches[0].clientY : e.clientY;
    nbDragStartH = notebookEditor.offsetHeight;
    document.addEventListener('mousemove', onNbDragMove);
    document.addEventListener('mouseup', onNbDragEnd);
    document.addEventListener('touchmove', onNbDragMove, { passive: false });
    document.addEventListener('touchend', onNbDragEnd);
  }

  resizeHandle.addEventListener('mousedown', onNbDragStart);
  resizeHandle.addEventListener('touchstart', onNbDragStart, { passive: false });

  // ---- Notifications engine ----
  const NOTIF_KEY = 'endless-planner-notif-settings';
  const NOTIF_SENT_KEY = 'endless-planner-notif-sent';
  const MORNING_BRIEF_SENT_LS = 'endless-planner-morning-brief-sent-date';
  let morningBriefSentDate = null;
  try {
    morningBriefSentDate = localStorage.getItem(MORNING_BRIEF_SENT_LS);
  } catch (_) {
    morningBriefSentDate = null;
  }

  const DEFAULT_NOTIF_SETTINGS = {
    browserEnabled: true,
    telegramEnabled: true,
    telegramBotToken: '8614319157:AAGgaj93y6xg8uOJMZk_YI4BfTbNYFEEMi0',
    telegramChatId: '8493934471',
    leadTime: 15,
    phoneAlarmEnabled: true,
    morningBriefing: true,
    morningTime: '06:30',
    timeZone: '',
    googleCalendarAutoSend: false
  };

  function sanitizeNotifSettings(raw) {
    const data = raw && typeof raw === 'object' ? { ...raw } : {};
    if (typeof data.phoneAlarmEnabled !== 'boolean' && typeof data.alarmEnabled === 'boolean') {
      data.phoneAlarmEnabled = data.alarmEnabled;
    }
    delete data.alarmEnabled;
    return data;
  }

  function loadNotifSettings() {
    try {
      const saved = sanitizeNotifSettings(JSON.parse(localStorage.getItem(NOTIF_KEY)));
      if (saved && typeof saved === 'object') return { ...DEFAULT_NOTIF_SETTINGS, ...saved };
      // Auto-save defaults if nothing saved yet
      localStorage.setItem(NOTIF_KEY, JSON.stringify(DEFAULT_NOTIF_SETTINGS));
      return { ...DEFAULT_NOTIF_SETTINGS };
    } catch {
      localStorage.setItem(NOTIF_KEY, JSON.stringify(DEFAULT_NOTIF_SETTINGS));
      return { ...DEFAULT_NOTIF_SETTINGS };
    }
  }

  function saveNotifSettings(s) {
    const clean = { ...DEFAULT_NOTIF_SETTINGS, ...sanitizeNotifSettings(s) };
    localStorage.setItem(NOTIF_KEY, JSON.stringify(clean));
    if (syncReady) SupabaseSync.save('notifSettings', clean);
  }

  function ensureNotifTimeZone() {
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const s = loadNotifSettings();
      if (!s.timeZone || s.timeZone !== tz) {
        s.timeZone = tz;
        saveNotifSettings(s);
      }
    } catch (_) {}
  }

  function getNotifSent() {
    try {
      const data = JSON.parse(localStorage.getItem(NOTIF_SENT_KEY)) || {};
      const today = dateKey(new Date());
      if (data.date !== today) return { date: today, ids: [] };
      return data;
    } catch { return { date: dateKey(new Date()), ids: [] }; }
  }

  function markNotifSent(noteId) {
    const sent = getNotifSent();
    sent.ids.push(noteId);
    localStorage.setItem(NOTIF_SENT_KEY, JSON.stringify(sent));
  }

  function markMorningBriefHandled(todayKey) {
    morningBriefSentDate = todayKey;
    try {
      localStorage.setItem(MORNING_BRIEF_SENT_LS, todayKey);
    } catch (_) {}
    if (syncReady) SupabaseSync.save('morningBriefSent', { date: todayKey });
  }

  let alarmAudioCtx = null;
  let alarmInterval = null;
  let alarmStopTimer = null;

  function isLikelyPhoneAlarmDevice() {
    const ua = navigator.userAgent || '';
    if (/Android|webOS|iPhone|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua)) return true;

    const touchPoints = navigator.maxTouchPoints || 0;
    const screenW = window.screen?.width || window.innerWidth;
    const screenH = window.screen?.height || window.innerHeight;
    return touchPoints > 0 && Math.min(screenW, screenH) <= 820;
  }

  function isAlarmEnabledOnThisDevice() {
    return isLikelyPhoneAlarmDevice() && !!loadNotifSettings().phoneAlarmEnabled;
  }

  function updateAlarmDeviceUi() {
    const toggle = document.getElementById('alarmNotifToggle');
    const status = document.getElementById('alarmDeviceStatus');
    if (!toggle || !status) return;

    const isPhone = isLikelyPhoneAlarmDevice();
    const settings = loadNotifSettings();
    toggle.checked = !!settings.phoneAlarmEnabled;
    toggle.disabled = false;
    status.textContent = isPhone
      ? 'When this is on, this phone rings for timed reminders.'
      : 'When this is on, reminders created here can ring on your phone; this desktop will stay silent.';
  }

  function getAlarmAudioContext() {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;
    if (!alarmAudioCtx) alarmAudioCtx = new AudioCtx();
    return alarmAudioCtx;
  }

  function primeAlarmAudio() {
    if (!isAlarmEnabledOnThisDevice()) return;
    const ctx = getAlarmAudioContext();
    if (ctx && ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
  }

  function stopAlarmSound() {
    if (alarmInterval) {
      clearInterval(alarmInterval);
      alarmInterval = null;
    }
    if (alarmStopTimer) {
      clearTimeout(alarmStopTimer);
      alarmStopTimer = null;
    }
    if ('vibrate' in navigator) {
      navigator.vibrate(0);
    }
  }

  function scheduleAlarmTone(ctx, start, frequency) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(frequency, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.18, start + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.22);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(start);
    osc.stop(start + 0.25);
  }

  async function playAlarmSound() {
    const ctx = getAlarmAudioContext();
    if (!ctx) return false;

    try {
      if (ctx.state === 'suspended') await ctx.resume();
    } catch (_) {
      return false;
    }
    if (ctx.state !== 'running') return false;

    stopAlarmSound();
    const playPattern = () => {
      const start = ctx.currentTime + 0.02;
      scheduleAlarmTone(ctx, start, 740);
      scheduleAlarmTone(ctx, start + 0.28, 880);
      scheduleAlarmTone(ctx, start + 0.56, 740);
    };

    playPattern();
    alarmInterval = setInterval(playPattern, 1800);
    alarmStopTimer = setTimeout(stopAlarmSound, 15000);
    return true;
  }

  function showAlarmModal(message, detail) {
    const overlay = document.getElementById('alarmModalOverlay');
    const messageEl = document.getElementById('alarmModalMessage');
    const whenEl = document.getElementById('alarmModalWhen');
    if (!overlay || !messageEl || !whenEl) return;

    messageEl.textContent = message || 'Reminder due';
    whenEl.textContent = detail || 'Reminder due';
    overlay.classList.add('active');
  }

  function stopReminderAlarm() {
    stopAlarmSound();
    const overlay = document.getElementById('alarmModalOverlay');
    if (overlay) overlay.classList.remove('active');
  }

  function triggerReminderAlarm(message, detail) {
    if (!isAlarmEnabledOnThisDevice()) return;

    showAlarmModal(message, detail);
    if ('vibrate' in navigator) {
      navigator.vibrate([450, 160, 450, 160, 700]);
    }
    playAlarmSound();
  }

  document.addEventListener('pointerdown', primeAlarmAudio, { passive: true });
  document.addEventListener('touchstart', primeAlarmAudio, { passive: true });
  document.addEventListener('keydown', primeAlarmAudio);

  async function sendTelegramMessage(text) {
    const s = loadNotifSettings();
    if (!s.telegramBotToken || !s.telegramChatId) return false;
    try {
      const res = await fetch(`https://api.telegram.org/bot${s.telegramBotToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: s.telegramChatId,
          text: text,
          parse_mode: 'HTML'
        })
      });
      const data = await res.json();
      return data.ok;
    } catch { return false; }
  }

  function waitForServiceWorkerReady(timeoutMs = 1200) {
    return Promise.race([
      navigator.serviceWorker.ready,
      new Promise(resolve => setTimeout(() => resolve(null), timeoutMs))
    ]);
  }

  async function sendBrowserNotification(title, body, tag = 'jarvis-reminder') {
    if (!('Notification' in window) || Notification.permission !== 'granted') return false;

    const options = {
      body,
      icon: '/icons/icon.svg',
      badge: '/icons/icon.svg',
      tag,
      renotify: true,
      requireInteraction: true,
      data: { url: location.href }
    };

    try {
      if ('serviceWorker' in navigator) {
        const reg = await waitForServiceWorkerReady();
        if (reg) {
          await reg.showNotification(title, options);
          return true;
        }
      }
    } catch (_) {}

    new Notification(title, options);
    return true;
  }

  function checkNotifications() {
    const s = loadNotifSettings();
    const alarmEnabledHere = isAlarmEnabledOnThisDevice();
    if (!s.browserEnabled && !s.telegramEnabled && !alarmEnabledHere) return;

    const now = new Date();
    const todayKey = dateKey(now);
    const leadMinutes = s.leadTime || 0;
    const sent = getNotifSent();

    const todayNotes = notes[todayKey] || [];
    const recurringToday = getRecurringForDate(todayKey);
    const allNotes = [...todayNotes, ...recurringToday];

    for (const note of allNotes) {
      if (!note.time || note.done || note.smartList) continue;

      const uniqueId = `${todayKey}-${note.id}`;
      if (sent.ids.includes(uniqueId)) continue;

      const [h, m] = note.time.split(':').map(Number);
      if (isNaN(h) || isNaN(m)) continue;

      const noteTime = new Date(now);
      noteTime.setHours(h, m, 0, 0);

      // Per-note lead time overrides global setting
      const noteLeadMinutes = (note.leadTime !== null && note.leadTime !== undefined)
        ? note.leadTime
        : leadMinutes;

      const alertTime = new Date(noteTime.getTime() - noteLeadMinutes * 60000);

      const diffMs = now.getTime() - alertTime.getTime();
      if (diffMs >= 0 && diffMs < 60000) {
        const cleanText = note.text.replace(/https?:\/\/[^\s]+/g, '').trim();
        const when =
          noteLeadMinutes > 0
            ? `in ${noteLeadMinutes} minute${noteLeadMinutes !== 1 ? 's' : ''}`
            : 'now';
        const message = `Sir — ${when}: ${cleanText}`;

        if (s.browserEnabled) {
          sendBrowserNotification('Jarvis', message, uniqueId);
        }
        if (alarmEnabledHere) {
          triggerReminderAlarm(cleanText || message, `Reminder ${when}`);
        }
        if (s.telegramEnabled) {
          sendTelegramMessage(`<b>Sir</b> &mdash; ${when}: ${cleanText}`);
        }

        markNotifSent(uniqueId);
      }
    }
  }

  // ---- Morning briefing ----
  function briefingHtmlToPlain(html) {
    return html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\u00a0/g, ' ')
      .trim();
  }

  function buildMorningBriefing() {
    const todayKey = dateKey(new Date());
    const todayDate = new Date();
    const dayName = WEEKDAYS[todayDate.getDay()];
    const monthName = MONTHS[todayDate.getMonth()];
    const dayNum = todayDate.getDate();

    const dayRaw = notes[todayKey] || [];
    const smartTodoNotes = dayRaw.filter(n => n.smartList === 'todo');
    const smartShopNotes = dayRaw.filter(n => n.smartList === 'shopping');

    const regularNotes = sortNotesByTime(dayRaw.filter(n => !n.smartList && !n.done));
    const recurringNotes = getRecurringForDate(todayKey).filter(n => !n.done);
    const allNotes = sortNotesByTime([...regularNotes, ...recurringNotes]);

    const todoBlocks = [];
    for (const n of smartTodoNotes) {
      const items = (n.listItems || []).filter(li => !li.done && (li.text || '').trim());
      if (!items.length) continue;
      const lines = [];
      if ((n.text || '').trim()) {
        lines.push(`<b>${(n.text || '').replace(/https?:\/\/[^\s]+/g, '').trim()}</b>`);
      }
      for (const li of items) {
        const cleanText = (li.text || '').replace(/https?:\/\/[^\s]+/g, '').trim();
        lines.push(`  - ${cleanText}`);
      }
      todoBlocks.push(lines.join('\n'));
    }

    const shopBlocks = [];
    for (const n of smartShopNotes) {
      const items = (n.listItems || []).filter(li => !li.done && (li.text || '').trim());
      if (!items.length) continue;
      const lines = [];
      if ((n.text || '').trim()) {
        lines.push(`<b>${(n.text || '').replace(/https?:\/\/[^\s]+/g, '').trim()}</b>`);
      }
      for (const li of items) {
        const cleanText = (li.text || '').replace(/https?:\/\/[^\s]+/g, '').trim();
        lines.push(`  - ${cleanText}`);
      }
      shopBlocks.push(lines.join('\n'));
    }

    const hasTodo = todoBlocks.length > 0;
    const hasShop = shopBlocks.length > 0;

    if (allNotes.length === 0 && !hasTodo && !hasShop) return null;

    let msg = `<b>Good morning, sir.</b>\n`;
    msg += `<i>Your ${dayName} briefing &mdash; ${monthName} ${dayNum}</i>\n\n`;

    const timed = allNotes.filter(n => n.time);
    const untimed = allNotes.filter(n => !n.time);

    if (timed.length > 0) {
      msg += `<b>Today\u2019s schedule</b>\n`;
      for (const n of timed) {
        const cleanText = n.text.replace(/https?:\/\/[^\s]+/g, '').trim();
        const recur = n.isRecurring ? ' <i>(recurring)</i>' : '';
        msg += `  \u2022 <b>${n.time}</b> \u2014 ${cleanText}${recur}\n`;
      }
      msg += '\n';
    }

    if (untimed.length > 0) {
      msg += `<b>Also on your list for today</b>\n`;
      for (const n of untimed) {
        const cleanText = n.text.replace(/https?:\/\/[^\s]+/g, '').trim();
        const recur = n.isRecurring ? ' <i>(recurring)</i>' : '';
        msg += `  \u2022 ${cleanText}${recur}\n`;
      }
      msg += '\n';
    }

    if (hasTodo) {
      msg += `<b>To-do lists</b>\n`;
      msg += `${todoBlocks.join('\n\n')}\n\n`;
    }
    if (hasShop) {
      msg += `<b>Shopping</b>\n`;
      msg += `${shopBlocks.join('\n\n')}\n\n`;
    }

    let smartItemCount = 0;
    for (const n of smartTodoNotes) {
      smartItemCount += (n.listItems || []).filter(li => !li.done && (li.text || '').trim()).length;
    }
    for (const n of smartShopNotes) {
      smartItemCount += (n.listItems || []).filter(li => !li.done && (li.text || '').trim()).length;
    }
    const totalCount = allNotes.length + smartItemCount;
    msg += `<i>That is ${totalCount} item${totalCount !== 1 ? 's' : ''} on your programme, sir.</i>`;
    return msg;
  }

  function checkMorningBriefing() {
    const s = loadNotifSettings();
    if (!s.morningBriefing) return;
    if (!s.telegramEnabled && !s.browserEnabled) return;

    const now = new Date();
    const todayKey = dateKey(now);

    if (morningBriefSentDate === todayKey) {
      const briefingId = `morning-briefing-${todayKey}`;
      const sent2 = getNotifSent();
      if (!sent2.ids.includes(briefingId)) markNotifSent(briefingId);
      return;
    }

    const sent = getNotifSent();
    const briefingId = `morning-briefing-${todayKey}`;
    if (sent.ids.includes(briefingId)) return;

    const [bh, bm] = (s.morningTime || '06:30').split(':').map(Number);
    const briefingTime = new Date(now);
    briefingTime.setHours(bh, bm, 0, 0);

    const diffMs = now.getTime() - briefingTime.getTime();
    if (diffMs >= 0 && diffMs < 120000) {
      const msgHtml = buildMorningBriefing();
      if (msgHtml) {
        const plain = briefingHtmlToPlain(msgHtml);
        if (s.telegramEnabled) sendTelegramMessage(msgHtml);
        if (s.browserEnabled) sendBrowserNotification('Jarvis', plain);
        markNotifSent(briefingId);
      } else {
        markNotifSent(briefingId);
        markMorningBriefHandled(todayKey);
      }
    }
  }

  setInterval(() => { checkNotifications(); checkMorningBriefing(); }, 30000);
  setTimeout(() => { checkNotifications(); checkMorningBriefing(); }, 2000);

  // ---- Settings UI ----
  const settingsOverlay = document.getElementById('notifModalOverlay');
  const settingsTabs = Array.from(document.querySelectorAll('[data-settings-section]'));
  const settingsPanels = Array.from(document.querySelectorAll('[data-settings-panel]'));

  function setSettingsSection(section) {
    const resolved = settingsPanels.some(panel => panel.dataset.settingsPanel === section)
      ? section
      : 'jarvis';

    settingsTabs.forEach((tab) => {
      const isActive = tab.dataset.settingsSection === resolved;
      tab.classList.toggle('active', isActive);
      tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
      tab.tabIndex = isActive ? 0 : -1;
    });

    settingsPanels.forEach((panel) => {
      const isActive = panel.dataset.settingsPanel === resolved;
      panel.classList.toggle('active', isActive);
      panel.hidden = !isActive;
    });
  }

  function populateSettingsModal() {
    const s = loadNotifSettings();
    document.getElementById('browserNotifToggle').checked = !!s.browserEnabled;
    updateAlarmDeviceUi();
    document.getElementById('telegramNotifToggle').checked = !!s.telegramEnabled;
    document.getElementById('telegramBotToken').value = s.telegramBotToken || '';
    document.getElementById('telegramChatId').value = s.telegramChatId || '';
    document.getElementById('notifLeadTime').value = String(s.leadTime ?? 15);
    document.getElementById('morningBriefingToggle').checked = !!s.morningBriefing;
    document.getElementById('morningBriefingTime').value = s.morningTime || '06:30';
    document.getElementById('googleCalendarAutoSendToggle').checked = !!s.googleCalendarAutoSend;
    document.getElementById('pushupMonthGoalInput').value = String(pushupWidget.monthGoal ?? DEFAULT_PUSHUP_MONTH_GOAL);
    document.getElementById('pushupYearGoalInput').value = String(pushupWidget.yearGoal ?? DEFAULT_PUSHUP_YEAR_GOAL);
    refreshSettingsExport();
    renderSettingsSmartLinksUI();
    setSettingsStatus('settingsExportStatus', '');
    setSettingsStatus('settingsImportStatus', '');

    const statusEl = document.getElementById('browserNotifStatus');
    if ('Notification' in window) {
      statusEl.textContent = `Permission: ${Notification.permission}`;
    } else {
      statusEl.textContent = 'Not supported in this browser';
    }
  }

  function openSettingsModal(section = 'jarvis') {
    populateSettingsModal();
    setSettingsSection(section);
    settingsOverlay.classList.add('active');
  }

  function closeSettingsModal() {
    settingsOverlay.classList.remove('active');
  }

  document.getElementById('settingsBtn').addEventListener('click', () => {
    openSettingsModal('jarvis');
  });

  settingsTabs.forEach((tab, index) => {
    tab.addEventListener('click', () => {
      setSettingsSection(tab.dataset.settingsSection);
    });

    tab.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      e.preventDefault();
      const step = e.key === 'ArrowRight' ? 1 : -1;
      const next = settingsTabs[(index + step + settingsTabs.length) % settingsTabs.length];
      next.focus();
      setSettingsSection(next.dataset.settingsSection);
    });
  });

  document.getElementById('browserNotifToggle').addEventListener('change', async (e) => {
    if (e.target.checked && 'Notification' in window && Notification.permission !== 'granted') {
      const perm = await Notification.requestPermission();
      document.getElementById('browserNotifStatus').textContent = `Permission: ${perm}`;
      if (perm !== 'granted') e.target.checked = false;
    }
  });

  document.getElementById('alarmNotifToggle').addEventListener('change', (e) => {
    const s = loadNotifSettings();
    s.phoneAlarmEnabled = e.target.checked;
    saveNotifSettings(s);
    updateAlarmDeviceUi();
    if (isAlarmEnabledOnThisDevice()) {
      primeAlarmAudio();
    } else {
      stopReminderAlarm();
    }
  });

  document.getElementById('telegramTestBtn').addEventListener('click', async () => {
    const token = document.getElementById('telegramBotToken').value.trim();
    const chatId = document.getElementById('telegramChatId').value.trim();
    const statusEl = document.getElementById('telegramTestStatus');
    if (!token || !chatId) {
      statusEl.textContent = 'Enter both token and chat ID first';
      statusEl.style.color = 'var(--accent)';
      return;
    }
    statusEl.textContent = 'Sending...';
    statusEl.style.color = 'var(--text-dim)';
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: 'At your service, sir. I shall deliver your reminders here.'
        })
      });
      const data = await res.json();
      if (data.ok) {
        statusEl.textContent = 'Test message sent! Check Telegram.';
        statusEl.style.color = 'green';
      } else {
        statusEl.textContent = `Error: ${data.description}`;
        statusEl.style.color = 'var(--accent)';
      }
    } catch (err) {
      statusEl.textContent = `Failed: ${err.message}`;
      statusEl.style.color = 'var(--accent)';
    }
  });

  document.getElementById('settingsMonthCalendarBtn').addEventListener('click', () => {
    closeSettingsModal();
    openCalPicker();
  });

  document.getElementById('settingsGoogleCalendarExportBtn').addEventListener('click', downloadGoogleCalendarIcs);
  document.getElementById('settingsCopyExportBtn').addEventListener('click', copySettingsExport);
  document.getElementById('settingsImportBtn').addEventListener('click', importSettingsData);

  document.getElementById('settingsSmartLinksAddBtn').addEventListener('click', () => {
    const draft = collectSmartLinksFromSettingsUI();
    draft.push({ keywords: [], url: '', label: '' });
    renderSettingsSmartLinksUI(draft);
    document.querySelector('#settingsSmartLinksList .sl-rule:last-child .sl-keywords')?.focus();
  });

  document.getElementById('settingsSmartLinksList').addEventListener('click', (e) => {
    const removeBtn = e.target.closest('.sl-remove');
    if (!removeBtn) return;
    const idx = parseInt(removeBtn.dataset.index, 10);
    const draft = collectSmartLinksFromSettingsUI();
    if (Number.isFinite(idx)) draft.splice(idx, 1);
    renderSettingsSmartLinksUI(draft);
  });

  document.getElementById('notifModalSave').addEventListener('click', () => {
    const s = {
      browserEnabled: document.getElementById('browserNotifToggle').checked,
      telegramEnabled: document.getElementById('telegramNotifToggle').checked,
      telegramBotToken: document.getElementById('telegramBotToken').value.trim(),
      telegramChatId: document.getElementById('telegramChatId').value.trim(),
      leadTime: parseInt(document.getElementById('notifLeadTime').value) || 0,
      phoneAlarmEnabled: document.getElementById('alarmNotifToggle').checked,
      morningBriefing: document.getElementById('morningBriefingToggle').checked,
      morningTime: document.getElementById('morningBriefingTime').value || '06:30',
      googleCalendarAutoSend: document.getElementById('googleCalendarAutoSendToggle').checked,
      timeZone: (typeof Intl !== 'undefined' && Intl.DateTimeFormat)
        ? Intl.DateTimeFormat().resolvedOptions().timeZone
        : ''
    };
    saveNotifSettings(s);
    pushupWidget.monthGoal = Math.max(0, parseInt(document.getElementById('pushupMonthGoalInput').value, 10) || 0);
    pushupWidget.yearGoal = Math.max(0, parseInt(document.getElementById('pushupYearGoalInput').value, 10) || 0);
    savePushupWidget();
    smartLinks = collectSmartLinksFromSettingsUI();
    saveSmartLinks();
    renderTodoPanel();
    closeSettingsModal();
  });

  document.getElementById('notifModalClose').addEventListener('click', () => {
    closeSettingsModal();
  });

  document.getElementById('notifModalCloseIcon').addEventListener('click', () => {
    closeSettingsModal();
  });

  settingsOverlay.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeSettingsModal();
  });

  document.getElementById('alarmModalDismiss').addEventListener('click', stopReminderAlarm);
  document.getElementById('alarmModalOverlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) stopReminderAlarm();
  });

  // ---- Sticky offset sync ----
  function getStickyBaseOffset() {
    const topbar = document.querySelector('.topbar');
    const topbarH = topbar ? topbar.offsetHeight : 0;
    const mobileSearchRow = document.getElementById('mobileSearchRow');
    const mobileSearchActive = mobileSearchRow && mobileSearchRow.classList.contains('active');
    const mobileSearchH = mobileSearchActive ? mobileSearchRow.offsetHeight : 0;
    return topbarH + mobileSearchH;
  }

  function getCalendarStickyOffset() {
    let stickyH = getStickyBaseOffset();
    if (layoutState.mode === 'tabs') {
      const viewTabsEl = document.getElementById('viewTabs');
      stickyH += viewTabsEl ? viewTabsEl.offsetHeight : 0;
    }
    return stickyH;
  }

  function updateStickyOffsets() {
    const topbar = document.querySelector('.topbar');
    const topbarH = topbar ? topbar.offsetHeight : 0;
    const mobileSearchRow = document.getElementById('mobileSearchRow');
    const nbSection = document.getElementById('notebookSection');
    const viewTabsEl = document.getElementById('viewTabs');
    const stickyBase = getStickyBaseOffset();
    const todoPanel = document.getElementById('calendarTodoPanel');
    if (todoPanel) {
      todoPanel.style.top = '';
      todoPanel.style.maxHeight = '';
    }

    if (mobileSearchRow) {
      mobileSearchRow.style.top = topbarH + 'px';
    }

    if (layoutState.mode === 'tabs') {
      viewTabsEl.style.top = stickyBase + 'px';
      const viewTabsH = viewTabsEl.offsetHeight;
      document.querySelectorAll('.month-header').forEach(mh => {
        mh.style.top = (stickyBase + viewTabsH) + 'px';
      });
      if (todoPanel) {
        const todoTop = stickyBase + viewTabsH + 16;
        todoPanel.style.top = todoTop + 'px';
        todoPanel.style.maxHeight = `calc(100vh - ${todoTop + 16}px)`;
      }
    } else {
      if (nbSection) nbSection.style.top = topbarH + 'px';
      document.querySelectorAll('.month-header').forEach(mh => {
        mh.style.top = stickyBase + 'px';
      });
      if (todoPanel) {
        const todoTop = stickyBase + 16;
        todoPanel.style.top = todoTop + 'px';
        todoPanel.style.maxHeight = `calc(100vh - ${todoTop + 16}px)`;
      }
    }
  }

  function scrollCalendarToToday(behavior) {
    updateStickyOffsets();
    const el = document.querySelector('.day-block.is-today');
    if (!el) return;

    const stickyH = getCalendarStickyOffset();

    let prev = el.previousElementSibling;
    while (prev && !prev.classList.contains('month-header')) {
      prev = prev.previousElementSibling;
    }
    const monthHeaderH = prev && prev.classList.contains('month-header') ? prev.offsetHeight : 0;

    const pad = stickyH + monthHeaderH + 10;
    const y = el.getBoundingClientRect().top + window.scrollY - pad;
    window.scrollTo({
      top: Math.max(0, y),
      behavior: behavior === 'smooth' ? 'smooth' : 'auto'
    });
  }

  const nbResizeObserver = new ResizeObserver(() => updateStickyOffsets());
  nbResizeObserver.observe(document.getElementById('notebookSection'));

  // ---- Supabase sync ----
  function acceptRemoteWrite(key, meta) {
    const ua = meta && meta.updated_at;
    if (!ua) return true;
    const t = new Date(ua).getTime();
    if (Number.isNaN(t)) return true;
    const prev = lastRemoteWriteAt[key];
    if (prev != null && t < prev) return false;
    lastRemoteWriteAt[key] = t;
    return true;
  }

  function applyRemotePayload(key, remote, meta) {
    if (!acceptRemoteWrite(key, meta)) return false;
    if (key === 'notes') {
      notes = remote;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
      return true;
    }
    if (key === 'recurring') {
      recurring = remote;
      localStorage.setItem(RECURRING_KEY, JSON.stringify(recurring));
      return true;
    }
    if (key === 'standaloneTodos') {
      standaloneTodos = Array.isArray(remote) ? remote : [];
      localStorage.setItem(STANDALONE_TODOS_KEY, JSON.stringify(standaloneTodos));
      return true;
    }
    if (key === 'pushupWidget') {
      const shouldProtectLocalPushup = pushupLocalWriteAt && Date.now() - pushupLocalWriteAt < 10000;
      pushupWidget = shouldProtectLocalPushup
        ? mergePushupWidgetData(pushupWidget, remote)
        : normalizePushupWidget(remote);
      localStorage.setItem(PUSHUP_WIDGET_KEY, JSON.stringify(pushupWidget));
      return true;
    }
    if (key === 'notebook') {
      notebook = remote;
      if (!notebook.activePageId && notebook.pages?.length) {
        notebook.activePageId = notebook.pages[0].id;
      }
      localStorage.setItem(NB_STORAGE_KEY, JSON.stringify(notebook));
      return true;
    }
    if (key === 'smartLinks') {
      smartLinks = remote;
      localStorage.setItem(SMARTLINKS_KEY, JSON.stringify(smartLinks));
      return true;
    }
    if (key === 'notifSettings') {
      const remoteSettings = sanitizeNotifSettings(remote);
      const merged = remoteSettings && typeof remoteSettings === 'object' ? { ...DEFAULT_NOTIF_SETTINGS, ...remoteSettings } : { ...DEFAULT_NOTIF_SETTINGS };
      let tz = '';
      try {
        tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      } catch (_) {}
      const hadTimeZone = !!(merged.timeZone && String(merged.timeZone).trim());
      if (!hadTimeZone && tz) merged.timeZone = tz;
      localStorage.setItem(NOTIF_KEY, JSON.stringify(merged));
      if (syncReady && !hadTimeZone && tz) saveNotifSettings(merged);
      return true;
    }
    if (key === 'morningBriefSent') {
      if (remote && typeof remote === 'object' && remote.date) {
        morningBriefSentDate = remote.date;
        try {
          localStorage.setItem(MORNING_BRIEF_SENT_LS, remote.date);
        } catch (_) {}
      }
      return true;
    }
    return false;
  }

  async function hydratePlannerDataFromServer() {
    if (typeof SupabaseSync.fetchKey !== 'function') return;
    const keys = ['notes', 'recurring', 'standaloneTodos', 'pushupWidget', 'notebook', 'smartLinks', 'notifSettings', 'morningBriefSent'];
    for (const key of keys) {
      try {
        const row = await SupabaseSync.fetchKey(key);
        if (!row || row.payload === undefined) continue;
        applyRemotePayload(key, row.payload, { updated_at: row.updated_at });
      } catch (e) {
        console.warn('hydrate', key, e);
      }
    }
  }

  function updateSyncStatusUI(text, color) {
    const el = document.getElementById('syncStatus');
    if (el) {
      el.textContent = text;
      el.style.color = color || 'var(--text-dim)';
    }
  }

  function updateAuthUI() {
    const btn = document.getElementById('syncBtn');
    const status = document.getElementById('syncStatus');
    if (!btn || !status) return;

    btn.textContent = 'Andreas';
    btn.title = 'Synced across all devices';
    btn.onclick = null;
    status.innerHTML = '\u2601<span class="sync-label"> Synced</span>';
    status.style.color = 'green';
  }

  function startSyncListeners() {
    // Unsubscribe previous listeners
    syncListeners.forEach(unsub => unsub());
    syncListeners = [];

    // Listen for remote changes on each data key
    // Skip re-render if user is actively typing
    function isUserEditing() {
      const active = document.activeElement;
      if (!active) return false;
      const tag = active.tagName;
      if (tag === 'TEXTAREA' || tag === 'INPUT') return true;
      if (active.isContentEditable) return true;
      if (active.classList.contains('note-edit-input')) return true;
      return false;
    }

    syncListeners.push(SupabaseSync.listen('notes', (remote, meta) => {
      if (!applyRemotePayload('notes', remote, meta)) return;
      if (!isUserEditing()) render();
    }));

    syncListeners.push(SupabaseSync.listen('recurring', (remote, meta) => {
      if (!applyRemotePayload('recurring', remote, meta)) return;
      if (!isUserEditing()) render();
    }));

    syncListeners.push(SupabaseSync.listen('standaloneTodos', (remote, meta) => {
      if (!applyRemotePayload('standaloneTodos', remote, meta)) return;
      if (!isUserEditing()) renderTodoPanel();
    }));

    syncListeners.push(SupabaseSync.listen('pushupWidget', (remote, meta) => {
      if (!applyRemotePayload('pushupWidget', remote, meta)) return;
      if (!isUserEditing()) renderWidgetsPanelInPlace();
    }));

    syncListeners.push(SupabaseSync.listen('notebook', (remote, meta) => {
      if (!applyRemotePayload('notebook', remote, meta)) return;
      if (!isUserEditing()) renderNotebook();
    }));

    syncListeners.push(SupabaseSync.listen('smartLinks', (remote, meta) => {
      applyRemotePayload('smartLinks', remote, meta);
    }));

    syncListeners.push(SupabaseSync.listen('notifSettings', (remote, meta) => {
      applyRemotePayload('notifSettings', remote, meta);
    }));

    syncListeners.push(SupabaseSync.listen('morningBriefSent', (remote, meta) => {
      applyRemotePayload('morningBriefSent', remote, meta);
    }));
  }

  async function initCloudSync() {
    if (typeof window.supabase === 'undefined' || typeof SupabaseSync === 'undefined') {
      console.log('Supabase not loaded \u2014 running in local-only mode');
      const statusEl = document.getElementById('syncStatus');
      if (statusEl) statusEl.textContent = 'Local only';
      const btn = document.getElementById('syncBtn');
      if (btn) {
        btn.textContent = 'Setup sync';
        btn.title = 'Load Supabase scripts and set SUPABASE_CONFIG in app.js';
        btn.onclick = () => {
          alert('Add the Supabase JS script and supabase-sync.js to index.html, and set SUPABASE_CONFIG (url + publishable key) in app.js. Create table planner_data in Supabase SQL Editor.');
        };
      }
      return;
    }
    if (!SUPABASE_CONFIG.url || !SUPABASE_CONFIG.key || SUPABASE_CONFIG.key === 'YOUR_SUPABASE_PUBLISHABLE_KEY') {
      console.log('Supabase not configured \u2014 running in local-only mode');
      const statusEl = document.getElementById('syncStatus');
      if (statusEl) statusEl.textContent = 'Local only';
      return;
    }

    try {
      await SupabaseSync.init(SUPABASE_CONFIG);

      await SupabaseSync.migrateFromLocalStorage({
        notes,
        recurring,
        standaloneTodos,
        pushupWidget,
        notebook,
        smartLinks,
        notifSettings: loadNotifSettings()
      });

      await hydratePlannerDataFromServer();
      syncReady = true;
      updateAuthUI();

      startSyncListeners();

      const statusEl2 = document.getElementById('syncStatus');
      if (statusEl2) {
        statusEl2.innerHTML = '\u2601<span class="sync-label"> Synced</span>';
        statusEl2.style.color = 'green';
      }
    } catch (err) {
      console.error('Supabase init failed:', err);
      updateSyncStatusUI('Sync error', 'var(--accent)');
    }
  }

  // ---- Service Worker Registration ----
  function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register(`/sw.js?v=${SW_SCRIPT_VERSION}`).then(reg => {
        console.log('Service worker registered:', reg.scope);
      }).catch(err => {
        console.warn('Service worker registration failed:', err);
      });
    }
  }

  // ---- Layout mode (split / tabs) ----
  const SPLIT_ICON = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1.5" y="1.5" width="13" height="5.5" rx="1"/><rect x="1.5" y="9" width="13" height="5.5" rx="1"/></svg>';
  const TABS_ICON = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1.5" y="5" width="13" height="9.5" rx="1"/><rect x="1.5" y="1.5" width="5" height="4.5" rx="1" fill="currentColor" stroke="none"/><rect x="8.5" y="1.5" width="5" height="4.5" rx="1"/></svg>';
  const MOBILE_VIEWS = ['calendar', 'todo', 'widgets'];

  function getMobileActiveView() {
    return MOBILE_VIEWS.includes(layoutState.mobileActiveView)
      ? layoutState.mobileActiveView
      : 'calendar';
  }

  function updateMobileViewClass(activeView) {
    MOBILE_VIEWS.forEach(view => {
      document.body.classList.toggle(`mobile-view-${view}`, view === activeView && isMobileViewport());
    });
  }

  function applyLayout() {
    const viewTabs = document.getElementById('viewTabs');
    const nbSection = document.getElementById('notebookSection');
    const plannerRoot = document.getElementById('plannerRoot');
    const calendarView = calendarTabLayout || plannerRoot;
    const toggleBtn = document.getElementById('viewToggleBtn');
    const mobileBottomNav = document.getElementById('mobileBottomNav');
    const isMobile = isMobileViewport();
    const mobileActiveView = getMobileActiveView();

    updateMobileViewClass(mobileActiveView);

    if (mobileBottomNav) {
      mobileBottomNav.querySelectorAll('[data-mobile-view]').forEach(btn => {
        const isActive = btn.dataset.mobileView === mobileActiveView;
        btn.classList.toggle('active', isActive);
        btn.setAttribute('aria-current', isActive ? 'page' : 'false');
      });
    }

    if (layoutState.mode === 'tabs') {
      document.body.classList.add('layout-tabs');
      document.body.classList.remove('layout-split');
      viewTabs.classList.add('visible');

      viewTabs.querySelectorAll('.view-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.view === layoutState.activeTab);
      });

      if (isMobile) {
        nbSection.classList.add('hidden');
        calendarView.classList.remove('hidden');
        plannerRoot.classList.toggle('hidden', mobileActiveView !== 'calendar');
        notebookContent.classList.remove('notebook-collapsed');
      } else if (layoutState.activeTab === 'notebook') {
        nbSection.classList.remove('hidden');
        calendarView.classList.add('hidden');
        plannerRoot.classList.add('hidden');
        notebookContent.classList.remove('notebook-collapsed');
      } else {
        nbSection.classList.add('hidden');
        calendarView.classList.remove('hidden');
        plannerRoot.classList.remove('hidden');
      }

      toggleBtn.innerHTML = SPLIT_ICON;
      toggleBtn.title = 'Switch to split view';
    } else {
      document.body.classList.remove('layout-tabs');
      document.body.classList.add('layout-split');
      viewTabs.classList.remove('visible');

      nbSection.classList.remove('hidden');
      calendarView.classList.remove('hidden');
      plannerRoot.classList.remove('hidden');
      renderNotebook();

      toggleBtn.innerHTML = TABS_ICON;
      toggleBtn.title = 'Switch to tab view';
    }

    setTimeout(updateStickyOffsets, 10);
  }

  document.getElementById('viewToggleBtn').addEventListener('click', () => {
    layoutState.mode = layoutState.mode === 'split' ? 'tabs' : 'split';
    saveLayout();
    applyLayout();
  });

  let savedCalendarScrollY = null;
  let savedNotebookScrollY = null;

  const CAL_SCROLL_SS_KEY = 'adhd-planner-cal-scroll-y';
  const NB_SCROLL_SS_KEY = 'adhd-planner-nb-scroll-y';

  function clampWindowScrollY(y) {
    const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    return Math.max(0, Math.min(Number(y), max));
  }

  document.getElementById('viewTabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.view-tab');
    if (!tab) return;
    const targetView = tab.dataset.view;
    if (targetView === layoutState.activeTab) return;

    disableBootScroll();

    if (layoutState.activeTab === 'calendar') {
      savedCalendarScrollY = window.scrollY;
      try { sessionStorage.setItem(CAL_SCROLL_SS_KEY, String(savedCalendarScrollY)); } catch (_) {}
    } else if (layoutState.activeTab === 'notebook') {
      savedNotebookScrollY = window.scrollY;
      try { sessionStorage.setItem(NB_SCROLL_SS_KEY, String(savedNotebookScrollY)); } catch (_) {}
    }

    layoutState.activeTab = targetView;
    saveLayout();
    applyLayout();

    if (targetView === 'calendar') {
      let y = savedCalendarScrollY;
      if (y == null) {
        try {
          const parsed = parseFloat(sessionStorage.getItem(CAL_SCROLL_SS_KEY));
          if (!isNaN(parsed)) y = parsed;
        } catch (_) {}
      }
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (y != null && !isNaN(y)) {
            window.scrollTo(0, clampWindowScrollY(y));
          } else {
            setTimeout(() => scrollCalendarToToday('auto'), 40);
          }
        });
      });
    } else if (targetView === 'notebook') {
      let y = savedNotebookScrollY;
      if (y == null) {
        try {
          const parsed = parseFloat(sessionStorage.getItem(NB_SCROLL_SS_KEY));
          if (!isNaN(parsed)) y = parsed;
        } catch (_) {}
      }
      if (y != null && !isNaN(y)) {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            window.scrollTo(0, clampWindowScrollY(y));
          });
        });
      }
    }
  });

  document.getElementById('mobileBottomNav')?.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-mobile-view]');
    if (!tab) return;

    const targetView = tab.dataset.mobileView;
    if (!MOBILE_VIEWS.includes(targetView) || targetView === getMobileActiveView()) return;

    disableBootScroll();

    if (getMobileActiveView() === 'calendar') {
      savedCalendarScrollY = window.scrollY;
      try { sessionStorage.setItem(CAL_SCROLL_SS_KEY, String(savedCalendarScrollY)); } catch (_) {}
    }

    layoutState.mode = 'tabs';
    layoutState.mobileActiveView = targetView;
    saveLayout();
    applyLayout();

    if (targetView === 'calendar') {
      let y = savedCalendarScrollY;
      if (y == null) {
        try {
          const parsed = parseFloat(sessionStorage.getItem(CAL_SCROLL_SS_KEY));
          if (!isNaN(parsed)) y = parsed;
        } catch (_) {}
      }
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (y != null && !isNaN(y)) {
            window.scrollTo(0, clampWindowScrollY(y));
          } else {
            setTimeout(() => scrollCalendarToToday('auto'), 40);
          }
        });
      });
    } else {
      requestAnimationFrame(() => window.scrollTo(0, 0));
    }
  });

  // ---- Month grid calendar picker ----
  const calPickerOverlay = document.getElementById('calPickerOverlay');
  const calPickerGrid = document.getElementById('calPickerGrid');
  const calPickerLabel = document.getElementById('calPickerLabel');
  const calPickerWeekdays = document.getElementById('calPickerWeekdays');
  let calPickerDate = new Date();

  const SHORT_WEEKDAYS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];

  function renderCalPickerWeekdays() {
    calPickerWeekdays.innerHTML = '<span style="font-size:0.6rem">Uge</span>' +
      SHORT_WEEKDAYS.map(d => `<span>${d}</span>`).join('');
  }
  renderCalPickerWeekdays();

  function renderCalPicker() {
    const year = calPickerDate.getFullYear();
    const month = calPickerDate.getMonth();
    calPickerLabel.textContent = `${MONTHS[month]} ${year}`;

    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);

    let startDow = firstDay.getDay();
    if (startDow === 0) startDow = 7;

    const todayStr = dateKey(new Date());
    const allCells = [];

    for (let i = startDow - 1; i > 0; i--) {
      const d = new Date(year, month, 1 - i);
      allCells.push({ d, otherMonth: true });
    }

    for (let day = 1; day <= lastDay.getDate(); day++) {
      allCells.push({ d: new Date(year, month, day), otherMonth: false });
    }

    const totalCells = allCells.length;
    const remaining = totalCells % 7 === 0 ? 0 : 7 - (totalCells % 7);
    for (let i = 1; i <= remaining; i++) {
      allCells.push({ d: new Date(year, month + 1, i), otherMonth: true });
    }

    let html = '';
    for (let i = 0; i < allCells.length; i++) {
      if (i % 7 === 0) {
        const wn = getISOWeekNumber(allCells[i].d);
        html += `<div class="cal-week-num">${wn}</div>`;
      }

      const { d, otherMonth } = allCells[i];
      const key = dateKey(d);
      const dow = d.getDay();
      const isTodayCls = key === todayStr ? ' is-today' : '';
      const isWeekendCls = (dow === 0 || dow === 6) ? ' is-weekend' : '';
      const hasN = hasNotesForDate(key);
      const hasNotesCls = hasN ? ' has-notes' : '';
      const holiday = getHolidayName(key);
      const holidayCls = holiday ? ' is-holiday' : '';
      const titleAttr = holiday ? ` title="${holiday}"` : '';
      const otherCls = otherMonth ? ' other-month' : '';

      html += `<div class="cal-day-cell${otherCls}${isTodayCls}${isWeekendCls}${hasNotesCls}${holidayCls}"${titleAttr} data-date="${key}">
        <span class="cal-day-num">${d.getDate()}</span>
      </div>`;
    }

    calPickerGrid.innerHTML = html;
  }

  function hasNotesForDate(key) {
    if (notes[key] && notes[key].length > 0) return true;
    const recs = getRecurringForDate(key);
    return recs.length > 0;
  }

  function openCalPicker() {
    calPickerDate = new Date();
    renderCalPicker();
    calPickerOverlay.classList.add('active');
  }

  function closeCalPicker() {
    calPickerOverlay.classList.remove('active');
  }

  function jumpToDate(key) {
    closeCalPicker();

    searchBox.value = '';
    searchTerm = '';
    clearMobileSearch();
    layoutState.mobileActiveView = 'calendar';

    if (layoutState.mode === 'tabs' && layoutState.activeTab !== 'calendar') {
      layoutState.activeTab = 'calendar';
      saveLayout();
      applyLayout();
    } else {
      saveLayout();
      applyLayout();
    }

    render();

    setTimeout(() => {
      const el = document.getElementById('day-' + key);
      if (el) {
        updateStickyOffsets();
        const stickyH = getCalendarStickyOffset();

        let prev = el.previousElementSibling;
        while (prev && !prev.classList.contains('month-header')) {
          prev = prev.previousElementSibling;
        }
        const monthHeaderH = prev && prev.classList.contains('month-header') ? prev.offsetHeight : 0;

        const pad = stickyH + monthHeaderH + 10;
        const y = el.getBoundingClientRect().top + window.scrollY - pad;
        window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });

        el.style.transition = 'background 0.3s ease';
        el.style.background = 'var(--accent-soft)';
        setTimeout(() => { el.style.background = ''; }, 1500);
      }
    }, 80);
  }

  document.getElementById('calPickerBtn').addEventListener('click', openCalPicker);

  calPickerOverlay.addEventListener('click', (e) => {
    if (e.target === calPickerOverlay) closeCalPicker();
  });

  document.getElementById('calPickerPrev').addEventListener('click', () => {
    calPickerDate.setMonth(calPickerDate.getMonth() - 1);
    renderCalPicker();
  });

  document.getElementById('calPickerNext').addEventListener('click', () => {
    calPickerDate.setMonth(calPickerDate.getMonth() + 1);
    renderCalPicker();
  });

  document.getElementById('calPickerTodayBtn').addEventListener('click', () => {
    jumpToDate(dateKey(new Date()));
  });

  calPickerGrid.addEventListener('click', (e) => {
    const cell = e.target.closest('.cal-day-cell');
    if (!cell) return;
    jumpToDate(cell.dataset.date);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (nbSidebar.classList.contains('open')) {
        closeSidebar();
      }
      if (calPickerOverlay.classList.contains('active')) {
        closeCalPicker();
      }
      const alarmOverlay = document.getElementById('alarmModalOverlay');
      if (alarmOverlay && alarmOverlay.classList.contains('active')) {
        stopReminderAlarm();
      }
      const msRow = document.getElementById('mobileSearchRow');
      if (msRow && msRow.classList.contains('active')) {
        msRow.classList.remove('active');
      }
    }
  });

  // ---- Mobile: force tabs layout on small screens ----
  function isMobileViewport() {
    return window.innerWidth <= 600;
  }

  if (isMobileViewport()) {
    let mobileLayoutChanged = false;
    if (layoutState.mode !== 'tabs') {
      layoutState.mode = 'tabs';
      mobileLayoutChanged = true;
    }
    if (!layoutState.activeTab) {
      layoutState.activeTab = 'calendar';
      mobileLayoutChanged = true;
    }
    if (!MOBILE_VIEWS.includes(layoutState.mobileActiveView)) {
      layoutState.mobileActiveView = 'calendar';
      mobileLayoutChanged = true;
    }
    if (mobileLayoutChanged) saveLayout();
  }

  window.addEventListener('resize', (() => {
    let resizeTimer;
    return () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const isMobile = isMobileViewport();
        let mobileLayoutChanged = false;
        if (isMobile && layoutState.mode !== 'tabs') {
          layoutState.mode = 'tabs';
          mobileLayoutChanged = true;
        }
        if (isMobile && !MOBILE_VIEWS.includes(layoutState.mobileActiveView)) {
          layoutState.mobileActiveView = 'calendar';
          mobileLayoutChanged = true;
        }
        if (mobileLayoutChanged) {
          saveLayout();
        }
        applyLayout();
      }, 200);
    };
  })());

  // ---- Mobile search toggle ----
  const mobileSearchRow = document.getElementById('mobileSearchRow');
  const mobileSearchInput = document.getElementById('mobileSearchInput');
  const mobileSearchToggle = document.getElementById('mobileSearchToggle');
  const mobileSearchClose = document.getElementById('mobileSearchClose');

  if (mobileSearchToggle) {
    mobileSearchToggle.addEventListener('click', () => {
      mobileSearchRow.classList.add('active');
      mobileSearchInput.value = searchBox.value;
      updateStickyOffsets();
      setTimeout(() => mobileSearchInput.focus(), 50);
    });
  }

  if (mobileSearchClose) {
    mobileSearchClose.addEventListener('click', () => {
      mobileSearchRow.classList.remove('active');
      mobileSearchInput.value = '';
      searchBox.value = '';
      searchTerm = '';
      render();
      searchNotebook('');
      updateStickyOffsets();
    });
  }

  if (mobileSearchInput) {
    let mobileSearchTimeout;
    mobileSearchInput.addEventListener('input', () => {
      clearTimeout(mobileSearchTimeout);
      mobileSearchTimeout = setTimeout(() => {
        searchBox.value = mobileSearchInput.value;
        searchTerm = mobileSearchInput.value.trim();
        render();
        searchNotebook(searchTerm);
      }, 200);
    });
  }

  async function boot() {
    render();
    renderNotebook();
    renderSidebar();
    applyLayout();
    setTimeout(updateStickyOffsets, 50);
    await initCloudSync();
    render();
    renderNotebook();
    applyLayout();
    setTimeout(updateStickyOffsets, 50);
    registerServiceWorker();
    ensureNotifTimeZone();
  }

  boot();
})();
