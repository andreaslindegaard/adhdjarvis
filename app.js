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
  const SW_SCRIPT_VERSION = 17;

  let syncReady = false;
  let syncListeners = []; // to unsubscribe on sign-out

  // ---- Data layer ----
  const STORAGE_KEY = 'endless-planner-notes';
  const RECURRING_KEY = 'endless-planner-recurring';
  const SMARTLINKS_KEY = 'endless-planner-smartlinks';
  const LAYOUT_KEY = 'endless-planner-layout';

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

  // recurring structure: [ { id, text, time, startDate, doneDate } ]
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
    add(new Date(year, 11, 25), '1. juledag');
    add(new Date(year, 11, 26), '2. juledag');
    add(new Date(year, 11, 31), 'Nytårsaften');

    // Movable holidays (Easter-based)
    add(addDays(easter, -49), 'Fastelavn');
    add(addDays(easter, -3), 'Skærtorsdag');
    add(addDays(easter, -2), 'Langfredag');
    add(easter, 'Påskedag');
    add(addDays(easter, 1), '2. påskedag');
    if (year <= 2023) {
      add(addDays(easter, 26), 'Store bededag');
    }
    add(addDays(easter, 39), 'Kr. himmelfartsdag');
    add(addDays(easter, 49), 'Pinsedag');
    add(addDays(easter, 50), '2. pinsedag');

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

  function render() {
    const { start, end } = getDateRange();
    let html = '';
    let currentMonth = -1;
    let currentYear = -1;
    const d = new Date(start);

    while (d <= end) {
      const key = dateKey(d);
      const regularNotes = notes[key] || [];
      const recurringNotes = getRecurringForDate(key);
      const dayNotes = sortNotesByTime([...regularNotes, ...recurringNotes]);

      const matchingNotes = searchTerm
        ? dayNotes.filter(n => n.text.toLowerCase().includes(searchTerm.toLowerCase()))
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
          const doneClass = note.done ? 'done' : '';
          const checked = note.done ? 'checked' : '';
          const recurringClass = note.isRecurring ? 'is-recurring' : '';
          const freqLabel = note.frequency === 'yearly' ? 'Repeats yearly' :
                            note.frequency === 'monthly' ? 'Repeats monthly' :
                            note.frequency === 'weekly' ? 'Repeats weekly' : 'Repeats daily';
          const recurringBadge = note.isRecurring ? `<span class="recurring-badge" title="${freqLabel}">&#x21bb;</span>` : '';
          const leadBadge = note.leadTime ? `<span class="lead-badge" title="Remind ${note.leadTime}min before">\u23f0-${note.leadTime >= 60 ? (note.leadTime/60) + 'h' : note.leadTime + 'm'}</span>` : '';
          const recurringId = note.recurringId || '';
          const displayText = renderRichText(note.text);
          html += `<div class="note-item ${doneClass} ${recurringClass}" data-id="${note.id}" data-date="${key}" data-recurring-id="${recurringId}">
            <input type="checkbox" class="note-checkbox" ${checked} data-id="${note.id}" data-date="${key}" data-recurring-id="${recurringId}">
            ${recurringBadge}
            <div class="note-text">${displayText}</div>
            <span class="note-time">${note.time || ''}${leadBadge ? ' ' + leadBadge : ''}</span>
            <button class="note-edit" data-id="${note.id}" data-date="${key}" data-recurring-id="${recurringId}" title="Rediger">&#x270e;</button>
            <button class="note-delete" data-id="${note.id}" data-date="${key}" data-recurring-id="${recurringId}">&times;</button>
          </div>`;
        }
        html += `</div>`;
      }

      html += `<div class="add-note-area">
        <button class="add-note-btn" data-date="${key}">+ Add note</button>
        <div class="add-note-form" data-date="${key}">
          <div class="form-row">
            <textarea placeholder="Write a note... (use #tags)" data-date="${key}" rows="1"></textarea>
            <button class="reminder-menu-btn" data-date="${key}" title="P\u00e5mindelse">&#x23f0;</button>
            <button class="recurring-menu-btn" data-date="${key}" title="Gentagelse">&#x21bb;</button>
            <button data-date="${key}" class="save-note-btn">Add</button>
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
            <button class="recurring-option" data-freq="monthly" data-date="${key}">M\u00e5nedlig</button>
            <button class="recurring-option" data-freq="yearly" data-date="${key}">\u00c5rlig</button>
          </div>
        </div>
      </div>`;

      html += `</div>`;
      d.setDate(d.getDate() + 1);
    }

    doc.innerHTML = html;
    bindEvents();
    scrollToTodayOnBoot();
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
          note.text = note.text.replace(url, '').replace(/\s{2,}/g, ' ').trim();
          saveNotes(notes);
        }
      }
      render();
      return;
    }

    const target = e.target.closest('[class]');
    if (!target) return;

    if (target.classList.contains('note-checkbox')) {
      const { id, date, recurringId } = target.dataset;
      if (recurringId) {
        const rec = recurring.find(r => r.id === recurringId);
        if (rec) {
          if (target.checked) {
            rec.doneDate = date;
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
        saveNotes(notes);
        render();
      }
      return;
    }

    // Edit via pencil button or clicking note text
    if (target.classList.contains('note-edit') || target.classList.contains('note-text')) {
      const noteItem = target.closest('.note-item');
      if (!noteItem) return;
      const noteText = noteItem.querySelector('.note-text');

      // Already editing? Do nothing
      if (noteItem.querySelector('.note-edit-input')) return;

      const { id, date, recurringId } = noteItem.dataset;

      // Get raw text and current leadTime
      let rawText, currentLeadTime;
      if (recurringId) {
        const rec = recurring.find(r => r.id === recurringId);
        rawText = rec ? rec.text : '';
        currentLeadTime = rec ? rec.leadTime : null;
      } else {
        const dayNotes = notes[date] || [];
        const note = dayNotes.find(n => n.id === id);
        rawText = note ? note.text : '';
        currentLeadTime = note ? note.leadTime : null;
      }

      // Build edit wrapper with textarea + reminder pills
      const editWrap = document.createElement('div');
      editWrap.className = 'note-edit-wrap';

      const textarea = document.createElement('textarea');
      textarea.className = 'note-edit-input';
      textarea.value = rawText;
      textarea.rows = 1;

      const reminderRow = document.createElement('div');
      reminderRow.className = 'edit-reminder-row';
      let selectedLeadTime = currentLeadTime;
      const options = [
        [0, 'Ingen'], [5, '5 min'], [15, '15 min'],
        [30, '30 min'], [60, '1 time'], [1440, '1 dag']
      ];
      options.forEach(([mins, label]) => {
        const btn = document.createElement('button');
        btn.className = 'reminder-option' + ((mins === 0 && !currentLeadTime) || mins === currentLeadTime ? ' selected' : '');
        btn.textContent = label;
        btn.type = 'button';
        btn.addEventListener('mousedown', (ev) => {
          ev.preventDefault(); // prevent blur
          selectedLeadTime = mins === 0 ? null : mins;
          reminderRow.querySelectorAll('.reminder-option').forEach(b => b.classList.remove('selected'));
          btn.classList.add('selected');
        });
        reminderRow.appendChild(btn);
      });

      editWrap.appendChild(textarea);
      editWrap.appendChild(reminderRow);
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
            saveRecurring();
          }
        } else {
          const dayNotes = notes[date] || [];
          const note = dayNotes.find(n => n.id === id);
          if (note) {
            note.text = applySmartLinks(newText);
            const { time } = parseTimeFromText(newText);
            if (time) note.time = time;
            note.leadTime = selectedLeadTime;
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
          render(); // cancel
        }
      });
      textarea.addEventListener('blur', (ev) => {
        // Don't trigger blur-save if clicking a reminder pill
        if (ev.relatedTarget && ev.relatedTarget.closest('.edit-reminder-row')) return;
        saveEdit();
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

    if (target.classList.contains('add-note-btn')) {
      target.classList.add('hidden');
      const form = target.nextElementSibling;
      form.classList.add('active');
      form.querySelector('textarea').focus();
      return;
    }

    if (target.classList.contains('save-note-btn')) {
      const date = target.dataset.date;
      const form = target.closest('.add-note-form');
      const textarea = form.querySelector('textarea');
      const uiLeadTime = form.dataset.leadTime ? parseInt(form.dataset.leadTime) : null;
      addNote(date, textarea.value, uiLeadTime);
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
      e.preventDefault();
      const form = e.target.closest('.add-note-form');
      const uiLeadTime = form?.dataset.leadTime ? parseInt(form.dataset.leadTime) : null;
      addNote(e.target.dataset.date, e.target.value, uiLeadTime);
    }
  });

  doc.addEventListener('input', (e) => {
    if (e.target.matches('.add-note-form textarea')) {
      e.target.style.height = 'auto';
      e.target.style.height = e.target.scrollHeight + 'px';
    }
  });

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
    // All events handled via delegation above
  }

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

  function sortNotesByTime(dayNotes) {
    return [...dayNotes].sort((a, b) => {
      const timeA = a.time || '99:99';
      const timeB = b.time || '99:99';
      return timeA.localeCompare(timeB);
    });
  }

  // ---- Recurring detection ----
  // Matches English and Danish: "remind me every day", "mind mig hver dag", "birthday", "fødselsdag"
  const recurringRegex = /(?:remind\s+me\s+|mind\s+mig\s+)?(?:every\s*day|everyday|daily|hver\s*dag|daglig|dagligt|every\s*week|weekly|hver\s*uge|ugentlig|ugentligt|(?:every|hver)\s*(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun|mandag|tirsdag|onsdag|torsdag|fredag|l[øo]rdag|s[øo]ndag)|every\s*month|monthly|hver\s*m[åa]ned|m[åa]nedlig|m[åa]nedligt|every\s*year|yearly|hvert?\s*[åa]r|[åa]rlig|[åa]rligt|birthday|f[øo]dselsdag)\s*(?:to\s+|om\s+at\s+|om\s+)?/i;

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

  function cleanRecurringText(text) {
    // Only strip command-style prefixes like "mind mig hver dag om at" / "remind me every week to"
    // Keep standalone keywords like "fødselsdag", "birthday", "daglig" etc. as part of the note text
    const prefixRegex = /^(?:remind\s+me\s+|mind\s+mig\s+)(?:every\s*day|everyday|daily|hver\s*dag|daglig|dagligt|every\s*week|weekly|hver\s*uge|ugentlig|ugentligt|(?:every|hver)\s*(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun|mandag|tirsdag|onsdag|torsdag|fredag|l[øo]rdag|s[øo]ndag)|every\s*month|monthly|hver\s*m[åa]ned|m[åa]nedlig|m[åa]nedligt|every\s*year|yearly|hvert?\s*[åa]r|[åa]rlig|[åa]rligt|birthday|f[øo]dselsdag)\s*(?:to\s+|om\s+at\s+|om\s+)?/i;
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
        if (freq === 'daily') return forDate === dateKey(new Date());
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
        leadTime: r.leadTime ?? null
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

  function addNote(date, text, uiLeadTime) {
    text = text.trim();
    if (!text) return;

    text = applySmartLinks(text);

    if (isRecurringRequest(text)) {
      const { time: parsedTime } = parseTimeFromText(text);
      const leadTime = uiLeadTime || parseLeadTime(text);
      const freq = parseRecurringFrequency(text, date);
      let cleanText = applySmartLinks(cleanRecurringText(text));
      if (leadTime !== null) cleanText = cleanLeadTimeText(cleanText);
      recurring.push({
        id: crypto.randomUUID(),
        text: cleanText || text,
        time: parsedTime || null,
        startDate: date,
        doneDate: null,
        frequency: freq.frequency,
        dayOfWeek: freq.dayOfWeek,
        month: freq.month,
        dayOfMonth: freq.dayOfMonth,
        leadTime: leadTime
      });
      saveRecurring();
      render();
      return;
    }

    if (!notes[date]) notes[date] = [];

    const { time: parsedTime } = parseTimeFromText(text);
    const textLeadTime = parseLeadTime(text);
    if (textLeadTime !== null) text = cleanLeadTimeText(text);
    const leadTime = uiLeadTime || textLeadTime;

    notes[date].push({
      id: crypto.randomUUID(),
      text,
      done: false,
      time: parsedTime || null,
      leadTime: leadTime
    });

    notes[date] = sortNotesByTime(notes[date]);
    saveNotes(notes);
    render();
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
    notebookTabs.querySelectorAll('.notebook-tab').forEach(t => t.classList.remove('tab-match'));

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

  // ---- Today button ----
  document.getElementById('todayBtn').addEventListener('click', () => {
    searchBox.value = '';
    searchTerm = '';
    if (layoutState.mode === 'tabs' && layoutState.activeTab !== 'calendar') {
      layoutState.activeTab = 'calendar';
      saveLayout();
      applyLayout();
    }
    render();
    setTimeout(() => scrollCalendarToToday('smooth'), 50);
  });

  // ---- More menu ----
  const moreMenuBtn = document.getElementById('moreMenuBtn');
  const moreMenu = document.getElementById('moreMenu');
  if (moreMenuBtn && moreMenu) {
    moreMenuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      moreMenu.classList.toggle('hidden');
    });
    document.addEventListener('click', (e) => {
      if (!moreMenu.contains(e.target) && e.target !== moreMenuBtn) {
        moreMenu.classList.add('hidden');
      }
    });
    // Close menu when any menu button is clicked
    moreMenu.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => moreMenu.classList.add('hidden'));
    });
  }

  // ---- Export ----
  document.getElementById('exportBtn').addEventListener('click', () => {
    const data = JSON.stringify({ notes, recurring, notebook }, null, 2);
    document.getElementById('modalTitle').textContent = 'Export Data';
    document.getElementById('modalTextarea').value = data;
    document.getElementById('modalTextarea').readOnly = true;
    document.getElementById('modalAction').textContent = 'Copy';
    document.getElementById('modalAction').onclick = () => {
      navigator.clipboard.writeText(data);
      document.getElementById('modalAction').textContent = 'Copied!';
      setTimeout(() => document.getElementById('modalAction').textContent = 'Copy', 1500);
    };
    document.getElementById('modalOverlay').classList.add('active');
  });

  // ---- Import ----
  document.getElementById('importBtn').addEventListener('click', () => {
    document.getElementById('modalTitle').textContent = 'Import Data';
    document.getElementById('modalTextarea').value = '';
    document.getElementById('modalTextarea').readOnly = false;
    document.getElementById('modalAction').textContent = 'Import';
    document.getElementById('modalAction').onclick = () => {
      try {
        const imported = JSON.parse(document.getElementById('modalTextarea').value);
        const importedNotes = imported.notes || imported;
        const importedRecurring = imported.recurring || [];
        const importedNotebook = imported.notebook || null;

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
        if (importedNotebook?.pages) {
          for (const page of importedNotebook.pages) {
            if (!notebook.pages.find(p => p.id === page.id)) {
              notebook.pages.push(page);
            }
          }
          saveNotebook();
          renderNotebook();
        }
        saveNotes(notes);
        saveRecurring();
        render();
        document.getElementById('modalOverlay').classList.remove('active');
      } catch {
        alert('Invalid JSON data');
      }
    };
    document.getElementById('modalOverlay').classList.add('active');
  });

  // ---- Smart Links editor ----
  function renderSmartLinksUI() {
    const textarea = document.getElementById('modalTextarea');
    let html = '<div class="smart-links-editor">';
    smartLinks.forEach((rule, i) => {
      html += `<div class="sl-rule" data-index="${i}">
        <div class="sl-row"><label>Nøgleord</label><input type="text" class="sl-keywords" value="${(rule.keywords || []).join(', ')}" placeholder="frisør, hår, klip"></div>
        <div class="sl-row"><label>URL</label><input type="url" class="sl-url" value="${rule.url || ''}" placeholder="https://..."></div>
        <button class="sl-remove" data-index="${i}" title="Fjern">&times;</button>
      </div>`;
    });
    html += `<button class="sl-add">+ Tilføj Smart Link</button>`;
    html += '</div>';
    textarea.style.display = 'none';
    // Insert custom UI after textarea
    let container = document.getElementById('smartLinksContainer');
    if (!container) {
      container = document.createElement('div');
      container.id = 'smartLinksContainer';
      textarea.parentNode.insertBefore(container, textarea);
    }
    container.innerHTML = html;
    container.style.display = 'block';
  }

  function readSmartLinksFromUI() {
    const container = document.getElementById('smartLinksContainer');
    if (!container) return;
    const rules = container.querySelectorAll('.sl-rule');
    smartLinks = [];
    rules.forEach(rule => {
      const keywords = rule.querySelector('.sl-keywords').value.split(',').map(k => k.trim()).filter(Boolean);
      const url = rule.querySelector('.sl-url').value.trim();
      if (keywords.length && url) {
        smartLinks.push({ keywords, url, label: '' });
      }
    });
  }

  document.getElementById('smartLinksBtn').addEventListener('click', () => {
    document.getElementById('modalTitle').textContent = 'Smart Links';
    document.getElementById('modalTextarea').style.display = 'none';
    renderSmartLinksUI();
    document.getElementById('modalAction').textContent = 'Gem';
    document.getElementById('modalAction').onclick = () => {
      readSmartLinksFromUI();
      saveSmartLinks();
      document.getElementById('modalAction').textContent = 'Gemt!';
      setTimeout(() => document.getElementById('modalOverlay').classList.remove('active'), 600);
    };
    document.getElementById('modalOverlay').classList.add('active');

    // Delegate events for smart links UI
    const container = document.getElementById('smartLinksContainer');
    container.onclick = (e) => {
      if (e.target.classList.contains('sl-remove')) {
        const idx = parseInt(e.target.dataset.index);
        smartLinks.splice(idx, 1);
        renderSmartLinksUI();
      }
      if (e.target.classList.contains('sl-add')) {
        readSmartLinksFromUI();
        smartLinks.push({ keywords: [], url: '', label: '' });
        renderSmartLinksUI();
        container.querySelector('.sl-rule:last-child .sl-keywords')?.focus();
      }
    };
  });

  // Close modal
  function closeModal() {
    document.getElementById('modalOverlay').classList.remove('active');
    document.getElementById('modalTextarea').style.display = '';
    const slc = document.getElementById('smartLinksContainer');
    if (slc) slc.style.display = 'none';
  }
  document.getElementById('modalClose').addEventListener('click', closeModal);

  document.getElementById('modalOverlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal();
  });

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
    if (!text || text.includes('<') && (text.includes('<strong>') || text.includes('<li>') || text.includes('<br'))) {
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

  function getActivePage() {
    return notebook.pages.find(p => p.id === notebook.activePageId) || notebook.pages[0];
  }

  function renderNotebook({ forceEditorUpdate = false } = {}) {
    let tabsHtml = '';
    for (const page of notebook.pages) {
      const active = page.id === notebook.activePageId ? 'active' : '';
      const title = page.title || 'Untitled';
      tabsHtml += `<button class="notebook-tab ${active}" data-page-id="${page.id}">
        ${escapeHtml(title)}
        ${notebook.pages.length > 1 ? `<span class="tab-close" data-page-id="${page.id}">&times;</span>` : ''}
      </button>`;
    }
    notebookTabs.innerHTML = tabsHtml;

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

  notebookTabs.addEventListener('click', (e) => {
    const closeBtn = e.target.closest('.tab-close');
    if (closeBtn) {
      const id = closeBtn.dataset.pageId;
      notebook.pages = notebook.pages.filter(p => p.id !== id);
      if (notebook.activePageId === id) {
        notebook.activePageId = notebook.pages[0]?.id;
      }
      saveNotebook();
      renderNotebook({ forceEditorUpdate: true });
      return;
    }
    const tab = e.target.closest('.notebook-tab');
    if (tab) {
      notebook.activePageId = tab.dataset.pageId;
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
    const newPage = { id: crypto.randomUUID(), title: '', content: '', updated: Date.now() };
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

  const DEFAULT_NOTIF_SETTINGS = {
    browserEnabled: true,
    telegramEnabled: true,
    telegramBotToken: '8614319157:AAGgaj93y6xg8uOJMZk_YI4BfTbNYFEEMi0',
    telegramChatId: '8493934471',
    leadTime: 15,
    morningBriefing: true,
    morningTime: '06:30'
  };

  function loadNotifSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(NOTIF_KEY));
      if (saved && saved.telegramBotToken) return saved;
      // Auto-save defaults if nothing saved yet
      localStorage.setItem(NOTIF_KEY, JSON.stringify(DEFAULT_NOTIF_SETTINGS));
      return DEFAULT_NOTIF_SETTINGS;
    } catch {
      localStorage.setItem(NOTIF_KEY, JSON.stringify(DEFAULT_NOTIF_SETTINGS));
      return DEFAULT_NOTIF_SETTINGS;
    }
  }

  function saveNotifSettings(s) {
    localStorage.setItem(NOTIF_KEY, JSON.stringify(s));
    if (syncReady) SupabaseSync.save('notifSettings', s);
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

  function sendBrowserNotification(title, body) {
    if (Notification.permission === 'granted') {
      new Notification(title, { body, icon: '/icons/icon.svg' });
    }
  }

  function checkNotifications() {
    const s = loadNotifSettings();
    if (!s.browserEnabled && !s.telegramEnabled) return;

    const now = new Date();
    const todayKey = dateKey(now);
    const leadMinutes = s.leadTime || 0;
    const sent = getNotifSent();

    const todayNotes = notes[todayKey] || [];
    const recurringToday = getRecurringForDate(todayKey);
    const allNotes = [...todayNotes, ...recurringToday];

    for (const note of allNotes) {
      if (!note.time || note.done) continue;

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
        const prefix = noteLeadMinutes > 0 ? `In ${noteLeadMinutes} min` : 'Now';
        const cleanText = note.text.replace(/https?:\/\/[^\s]+/g, '').trim();
        const message = `\u23f0 ${prefix}: ${cleanText}`;

        if (s.browserEnabled) {
          sendBrowserNotification('ADHD Jarvis', message);
        }
        if (s.telegramEnabled) {
          sendTelegramMessage(`<b>\u23f0 ${prefix}</b>\n${cleanText}`);
        }

        markNotifSent(uniqueId);
      }
    }
  }

  // ---- Morning briefing ----
  function buildMorningBriefing() {
    const todayKey = dateKey(new Date());
    const todayDate = new Date();
    const dayName = WEEKDAYS[todayDate.getDay()];
    const monthName = MONTHS[todayDate.getMonth()];
    const dayNum = todayDate.getDate();

    const regularNotes = sortNotesByTime(notes[todayKey] || []).filter(n => !n.done);
    const recurringNotes = getRecurringForDate(todayKey).filter(n => !n.done);
    const allNotes = sortNotesByTime([...regularNotes, ...recurringNotes]);

    if (allNotes.length === 0) return null;

    let msg = `<b>\u2600\ufe0f Good morning! Here's your ${dayName}</b>\n`;
    msg += `<i>${monthName} ${dayNum}</i>\n\n`;

    const timed = allNotes.filter(n => n.time);
    const untimed = allNotes.filter(n => !n.time);

    if (timed.length > 0) {
      msg += `<b>\ud83d\udcc5 Schedule:</b>\n`;
      for (const n of timed) {
        const cleanText = n.text.replace(/https?:\/\/[^\s]+/g, '').trim();
        const icon = n.isRecurring ? '\ud83d\udd01' : '\u25b8';
        msg += `  ${icon} <b>${n.time}</b> \u2014 ${cleanText}\n`;
      }
      msg += '\n';
    }

    if (untimed.length > 0) {
      msg += `<b>\ud83d\udcdd Also today:</b>\n`;
      for (const n of untimed) {
        const cleanText = n.text.replace(/https?:\/\/[^\s]+/g, '').trim();
        const icon = n.isRecurring ? '\ud83d\udd01' : '\u25b8';
        msg += `  ${icon} ${cleanText}\n`;
      }
      msg += '\n';
    }

    msg += `<i>${allNotes.length} thing${allNotes.length !== 1 ? 's' : ''} on your plate. You got this \ud83d\udcaa</i>`;
    return msg;
  }

  function checkMorningBriefing() {
    const s = loadNotifSettings();
    if (!s.telegramEnabled || !s.morningBriefing) return;

    const now = new Date();
    const todayKey = dateKey(now);
    const sent = getNotifSent();

    const briefingId = `morning-briefing-${todayKey}`;
    if (sent.ids.includes(briefingId)) return;

    const [bh, bm] = (s.morningTime || '06:30').split(':').map(Number);
    const briefingTime = new Date(now);
    briefingTime.setHours(bh, bm, 0, 0);

    const diffMs = now.getTime() - briefingTime.getTime();
    if (diffMs >= 0 && diffMs < 120000) {
      const msg = buildMorningBriefing();
      if (msg) {
        sendTelegramMessage(msg);
        markNotifSent(briefingId);
      } else {
        const dayName = WEEKDAYS[now.getDay()];
        sendTelegramMessage(`<b>\u2600\ufe0f Good morning!</b>\nNothing scheduled for ${dayName}. Enjoy your free day! \ud83c\udf89`);
        markNotifSent(briefingId);
      }
    }
  }

  setInterval(() => { checkNotifications(); checkMorningBriefing(); }, 30000);
  setTimeout(() => { checkNotifications(); checkMorningBriefing(); }, 2000);

  // ---- Notifications UI ----
  document.getElementById('notificationsBtn').addEventListener('click', () => {
    const s = loadNotifSettings();
    document.getElementById('browserNotifToggle').checked = !!s.browserEnabled;
    document.getElementById('telegramNotifToggle').checked = !!s.telegramEnabled;
    document.getElementById('telegramBotToken').value = s.telegramBotToken || '';
    document.getElementById('telegramChatId').value = s.telegramChatId || '';
    document.getElementById('notifLeadTime').value = String(s.leadTime ?? 15);
    document.getElementById('morningBriefingToggle').checked = !!s.morningBriefing;
    document.getElementById('morningBriefingTime').value = s.morningTime || '06:30';

    const statusEl = document.getElementById('browserNotifStatus');
    if ('Notification' in window) {
      statusEl.textContent = `Permission: ${Notification.permission}`;
    } else {
      statusEl.textContent = 'Not supported in this browser';
    }

    document.getElementById('notifModalOverlay').classList.add('active');
  });

  document.getElementById('browserNotifToggle').addEventListener('change', async (e) => {
    if (e.target.checked && 'Notification' in window && Notification.permission !== 'granted') {
      const perm = await Notification.requestPermission();
      document.getElementById('browserNotifStatus').textContent = `Permission: ${perm}`;
      if (perm !== 'granted') e.target.checked = false;
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
        body: JSON.stringify({ chat_id: chatId, text: '\u2705 ADHD Jarvis connected! You will receive reminders here.' })
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

  document.getElementById('notifModalSave').addEventListener('click', () => {
    const s = {
      browserEnabled: document.getElementById('browserNotifToggle').checked,
      telegramEnabled: document.getElementById('telegramNotifToggle').checked,
      telegramBotToken: document.getElementById('telegramBotToken').value.trim(),
      telegramChatId: document.getElementById('telegramChatId').value.trim(),
      leadTime: parseInt(document.getElementById('notifLeadTime').value) || 0,
      morningBriefing: document.getElementById('morningBriefingToggle').checked,
      morningTime: document.getElementById('morningBriefingTime').value || '06:30'
    };
    saveNotifSettings(s);
    document.getElementById('notifModalOverlay').classList.remove('active');
  });

  document.getElementById('notifModalClose').addEventListener('click', () => {
    document.getElementById('notifModalOverlay').classList.remove('active');
  });

  document.getElementById('notifModalOverlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.classList.remove('active');
  });

  // ---- Sticky offset sync ----
  function updateStickyOffsets() {
    const topbarH = document.querySelector('.topbar').offsetHeight;
    const nbSection = document.getElementById('notebookSection');
    const viewTabsEl = document.getElementById('viewTabs');

    if (layoutState.mode === 'tabs') {
      viewTabsEl.style.top = topbarH + 'px';
      const viewTabsH = viewTabsEl.offsetHeight;
      document.querySelectorAll('.month-header').forEach(mh => {
        mh.style.top = (topbarH + viewTabsH) + 'px';
      });
    } else {
      nbSection.style.top = topbarH + 'px';
      const nbH = nbSection.offsetHeight;
      const totalOffset = topbarH + nbH;
      document.querySelectorAll('.month-header').forEach(mh => {
        mh.style.top = totalOffset + 'px';
      });
    }
  }

  function scrollCalendarToToday(behavior) {
    updateStickyOffsets();
    const el = document.querySelector('.day-block.is-today');
    if (!el) return;

    const topbar = document.querySelector('.topbar');
    const topbarH = topbar ? topbar.offsetHeight : 0;
    let stickyH = topbarH;

    if (layoutState.mode === 'tabs') {
      const viewTabsEl = document.getElementById('viewTabs');
      stickyH += viewTabsEl ? viewTabsEl.offsetHeight : 0;
    } else {
      const nbSection = document.getElementById('notebookSection');
      stickyH += nbSection ? nbSection.offsetHeight : 0;
    }

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
    status.textContent = '\u2601 Synced';
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

    syncListeners.push(SupabaseSync.listen('notes', (remote) => {
      notes = remote;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
      if (!isUserEditing()) render();
    }));

    syncListeners.push(SupabaseSync.listen('recurring', (remote) => {
      recurring = remote;
      localStorage.setItem(RECURRING_KEY, JSON.stringify(recurring));
      if (!isUserEditing()) render();
    }));

    syncListeners.push(SupabaseSync.listen('notebook', (remote) => {
      notebook = remote;
      if (!notebook.activePageId && notebook.pages?.length) {
        notebook.activePageId = notebook.pages[0].id;
      }
      localStorage.setItem(NB_STORAGE_KEY, JSON.stringify(notebook));
      if (!isUserEditing()) renderNotebook();
    }));

    syncListeners.push(SupabaseSync.listen('smartLinks', (remote) => {
      smartLinks = remote;
      localStorage.setItem(SMARTLINKS_KEY, JSON.stringify(smartLinks));
    }));

    syncListeners.push(SupabaseSync.listen('notifSettings', (remote) => {
      localStorage.setItem(NOTIF_KEY, JSON.stringify(remote));
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
      syncReady = true;
      updateAuthUI();

      await SupabaseSync.migrateFromLocalStorage({
        notes,
        recurring,
        notebook,
        smartLinks,
        notifSettings: loadNotifSettings()
      });

      startSyncListeners();

      updateSyncStatusUI('\u2601 Synced', 'green');
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

  function applyLayout() {
    const viewTabs = document.getElementById('viewTabs');
    const nbSection = document.getElementById('notebookSection');
    const plannerRoot = document.getElementById('plannerRoot');
    const toggleBtn = document.getElementById('viewToggleBtn');

    if (layoutState.mode === 'tabs') {
      document.body.classList.add('layout-tabs');
      document.body.classList.remove('layout-split');
      viewTabs.classList.add('visible');

      viewTabs.querySelectorAll('.view-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.view === layoutState.activeTab);
      });

      if (layoutState.activeTab === 'notebook') {
        nbSection.classList.remove('hidden');
        plannerRoot.classList.add('hidden');
        notebookContent.classList.remove('notebook-collapsed');
      } else {
        nbSection.classList.add('hidden');
        plannerRoot.classList.remove('hidden');
      }

      toggleBtn.innerHTML = SPLIT_ICON;
      toggleBtn.title = 'Switch to split view';
    } else {
      document.body.classList.remove('layout-tabs');
      document.body.classList.add('layout-split');
      viewTabs.classList.remove('visible');

      nbSection.classList.remove('hidden');
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

  document.getElementById('viewTabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.view-tab');
    if (!tab) return;
    layoutState.activeTab = tab.dataset.view;
    saveLayout();
    applyLayout();
  });

  // ---- Initial render ----
  render();
  renderNotebook();
  applyLayout();
  setTimeout(updateStickyOffsets, 50);

  registerServiceWorker();
  initCloudSync();
})();
