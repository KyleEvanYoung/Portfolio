/* BookFlix front end. Put your deployed Google Apps Script Web App URL here. */
const GOOGLE_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwFtVs-FzrBjF-5hy42P0_BGTQF_kH89b9FJpYqDte0KXrb4Qvtub7Qyc-UsuyUqNXZyQ/exec';
const BOOK_MODEL_URL = 'assets/stories/3d_book_for_website.glb';
const STORIES = typeof Storys !== 'undefined' ? Storys : (window.Storys || []);
const TWO_MONTHS_MS = 1000 * 60 * 60 * 24 * 62;

const state = {
  deviceCode: getOrCreateDeviceCode(),
  user: null,
  stories: [],
  library: new Set(JSON.parse(localStorage.getItem('bookflix-library') || '[]')),
  loadedModel: true,
  filters: { search: '', series: 'all', genre: 'all', types: new Set(['FlashFiction', 'ShortStory', 'Novelette', 'Novella', 'Novel']) },
  progressTimers: new Map()
};

const el = id => document.getElementById(id);

window.addEventListener('DOMContentLoaded', async () => {
  skipLoaderAfterSixSeconds();
  await initApp();
});

async function initApp() {
  state.stories = normalizeStories(STORIES);
  fillFilters();
  bindEvents();
  applyTheme(localStorage.getItem('bookflix-theme') || 'Default');
  renderAll();
  hideLoader();
  const result = await api('initUser', { code: state.deviceCode, storyNames: state.stories.map(s => s.Name) });
  if (result && result.ok) {
    state.user = result.user;
    hydrateFromUser(result.user);
    renderAll();
  }
}

function getOrCreateDeviceCode() {
  let code = localStorage.getItem('bookflix-device-code');
  if (!/^\d{10}$/.test(code || '')) {
    code = String(Math.floor(1000000000 + Math.random() * 9000000000));
    localStorage.setItem('bookflix-device-code', code);
  }
  return code;
}

function normalizeStories(stories) {
  return [...stories].sort((a, b) => new Date(b.ReleaseDate || 0) - new Date(a.ReleaseDate || 0));
}

function skipLoaderAfterSixSeconds() {
  setTimeout(hideLoader, 6000);
}

function hideLoader() {
  const preloader = el('preloader');
  if (preloader) preloader.classList.add('hidden');
}

async function api(action, data = {}) {
  if (!GOOGLE_SCRIPT_URL || GOOGLE_SCRIPT_URL.includes('PASTE_YOUR')) {
    console.warn('Google Apps Script URL is not set. Backend action skipped:', action, data);
    return { ok: false, offline: true };
  }
  try {
    const res = await fetch(GOOGLE_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, ...data })
    });
    return await res.json();
  } catch (error) {
    console.warn('Backend failed:', error);
    return { ok: false, error: String(error) };
  }
}

function hydrateFromUser(user) {
  if (!user) return;
  const theme = user['Theme Style'] || localStorage.getItem('bookflix-theme') || 'Default';
  applyTheme(theme);
  el('themeSelect').value = theme;
  state.library.clear();
  state.stories.forEach(story => {
    const value = user[`${story.Name} In Libary`];
    if (String(value).toLowerCase() === 'true') state.library.add(story.Name);
  });
  localStorage.setItem('bookflix-library', JSON.stringify([...state.library]));
}

function bindEvents() {
  el('menuButton').addEventListener('click', toggleOptions);
  el('closeOptions').addEventListener('click', toggleOptions);
  el('libraryButton').addEventListener('click', openLibrary);
  el('closeLibrary').addEventListener('click', () => el('libraryPanel').classList.remove('open'));
  el('closeModal').addEventListener('click', () => el('storyModal').close());
  el('storySearch').addEventListener('input', e => { state.filters.search = e.target.value.toLowerCase(); renderAll(); });
  el('seriesFilter').addEventListener('change', e => { state.filters.series = e.target.value; renderAll(); });
  el('genreFilter').addEventListener('change', e => { state.filters.genre = e.target.value; renderAll(); });
  document.querySelectorAll('.typeToggle').forEach(box => box.addEventListener('change', () => {
    state.filters.types = new Set([...document.querySelectorAll('.typeToggle:checked')].map(b => b.value));
    renderAll();
  }));
  el('loginSubmit').addEventListener('click', login);
  el('makeAccountButton').addEventListener('click', makeAccount);
  el('forgotPasswordButton').addEventListener('click', forgotPassword);
  el('themeSelect').addEventListener('change', e => changeTheme(e.target.value));
  el('closeReader').addEventListener('click', closeReader);
  el('fontSize').addEventListener('input', e => el('readerContent').style.fontSize = `${e.target.value}px`);
  el('fontFamily').addEventListener('change', e => el('readerContent').style.fontFamily = e.target.value);
  el('readerTheme').addEventListener('change', e => el('readerContent').className = `reader-content ${e.target.value}`);
}

function fillFilters() {
  const series = new Set();
  const genres = new Set();
  state.stories.forEach(story => {
    if (story.Series) series.add(story.Series);
    (story.Genres || []).forEach(g => genres.add(g));
  });
  for (const s of [...series].sort()) el('seriesFilter').insertAdjacentHTML('beforeend', `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`);
  for (const g of [...genres].sort()) el('genreFilter').insertAdjacentHTML('beforeend', `<option value="${escapeHtml(g)}">${escapeHtml(g)}</option>`);
}

function renderAll() {
  renderHero();
  renderReleaseSection();
  renderGenreSections();
  renderLibrary();
}

function isLevelOne() {
  return state.user && String(state.user['Level Of Account License']) === 'Level 1';
}

function visibleStoryInfo(story) {
  const release = new Date(story.ReleaseDate || '1970-01-01');
  const now = new Date();
  if (isLevelOne() || release <= now) return { visible: true, locked: false, upcoming: false };
  const diff = release - now;
  if (diff <= TWO_MONTHS_MS) return { visible: true, locked: true, upcoming: true };
  return { visible: false, locked: true, upcoming: false };
}

function filteredStories() {
  return state.stories.filter(story => {
    const info = visibleStoryInfo(story);
    if (!info.visible) return false;
    if (!state.filters.types.has(story.StoryType)) return false;
    if (state.filters.series !== 'all' && story.Series !== state.filters.series) return false;
    if (state.filters.genre !== 'all' && !(story.Genres || []).includes(state.filters.genre)) return false;
    const text = `${story.Name} ${story.Description} ${story.Series} ${(story.Genres || []).join(' ')}`.toLowerCase();
    return !state.filters.search || text.includes(state.filters.search);
  });
}

function renderHero() {
  const story = filteredStories()[0] || state.stories[0];
  if (!story) return;
  const info = visibleStoryInfo(story);
  el('hero').style.backgroundImage = `linear-gradient(90deg, rgba(0,0,0,.95), rgba(0,0,0,.45)), url('${story.Wallpaper || story.Ebookcover}')`;
  el('hero').innerHTML = `
    <div class="hero-copy">
      <span>FEATURED</span>
      <h2>${escapeHtml(story.Name)}</h2>
      <p>${escapeHtml(story.Description || '')}</p>
      <div class="hero-buttons">
        ${info.locked ? `<button disabled>Locked until ${formatDate(story.ReleaseDate)}</button>` : `<button onclick="openReaderByName('${escapeJs(story.Name)}')">▶ Read Now</button>`}
        <button class="round" onclick="toggleLibraryByName('${escapeJs(story.Name)}')">${state.library.has(story.Name) ? '✓' : '+'}</button>
      </div>
      ${info.upcoming ? countdownMarkup(story) : ''}
    </div>
    <img class="hero-book" src="${story.Ebookcover || story.Logo || ''}" alt="${escapeHtml(story.Name)} cover" onerror="this.style.display='none'" />`;
}

function renderReleaseSection() {
  const list = filteredStories();
  el('releaseSection').innerHTML = `<div class="section-title"><h2>Sorted By Release Date</h2><button>See All</button></div><div class="book-row">${list.map(bookCard).join('')}</div>`;
}

function renderGenreSections() {
  const list = filteredStories();
  const genres = [...new Set(list.flatMap(s => s.Genres || []))];
  el('genreSections').innerHTML = genres.map(genre => {
    const books = list.filter(s => (s.Genres || []).includes(genre));
    return `<section class="story-section"><div class="section-title"><h2>${escapeHtml(genre)}</h2><button>See All</button></div><div class="book-row">${books.map(bookCard).join('')}</div></section>`;
  }).join('');
}

function bookCard(story) {
  const info = visibleStoryInfo(story);
  const inLibrary = state.library.has(story.Name);
  const model = info.locked ? '' : `
    <model-viewer class="book-model" src="${BOOK_MODEL_URL}" poster="${story.Ebookcover || story.Wallpaper || ''}" camera-controls disable-zoom auto-rotate exposure="1" shadow-intensity="1" onerror="this.outerHTML='<img class=&quot;book-fallback&quot; src=&quot;${story.Wallpaper || story.Ebookcover || ''}&quot; alt=&quot;book&quot; />'"></model-viewer>`;
  return `<article class="book-card ${info.locked ? 'locked' : ''}" onclick="openStoryModal('${escapeJs(story.Name)}')">
    <div class="book-wrap">
      ${model || `<img class="book-fallback black-logo" src="${story.Logo || story.Ebookcover || ''}" alt="${escapeHtml(story.Name)} logo" />`}
      ${inLibrary ? '<strong class="library-ribbon">In Libary</strong>' : ''}
      ${info.upcoming ? '<strong class="library-ribbon locked-ribbon">Locked</strong>' : ''}
    </div>
    <h3>${escapeHtml(story.Name)}</h3>
    <p>${escapeHtml(story.Series || '')}</p>
    ${info.upcoming ? countdownMarkup(story) : ''}
  </article>`;
}

function countdownMarkup(story) {
  const release = new Date(story.ReleaseDate);
  const days = Math.max(0, Math.ceil((release - new Date()) / (1000 * 60 * 60 * 24)));
  return `<div class="countdown"><b>${days}</b> days until release <button onclick="event.stopPropagation();addCalendar('${escapeJs(story.Name)}','${story.ReleaseDate}')">Add Calendar</button></div>`;
}

function openStoryModal(name) {
  const story = state.stories.find(s => s.Name === name);
  if (!story) return;
  const info = visibleStoryInfo(story);
  const modal = el('storyModal');
  el('modalContent').innerHTML = `
    <div class="modal-book ${info.locked ? 'locked' : 'spin'}">
      <img src="${story.Ebookcover || story.Wallpaper || ''}" alt="${escapeHtml(story.Name)} cover" />
    </div>
    <div class="modal-copy">
      <h2>${escapeHtml(story.Name)}</h2>
      <p>${escapeHtml(story.Description || '')}</p>
      <p class="tags">${(story.Genres || []).map(g => `<span>${escapeHtml(g)}</span>`).join('')}</p>
      ${info.upcoming ? countdownMarkup(story) : ''}
      <div class="modal-actions">
        <button ${info.locked ? 'disabled' : ''} onclick="downloadFile('${escapeJs(story.Epub)}')">Ebook</button>
        <button ${info.locked ? 'disabled' : ''} onclick="downloadFile('${escapeJs(story.Pdfstory)}')">PDF</button>
        <button onclick="toggleLibraryByName('${escapeJs(story.Name)}'); openStoryModal('${escapeJs(story.Name)}')">${state.library.has(story.Name) ? 'Remove From Libary' : 'Add To Libary'}</button>
        <button ${info.locked ? 'disabled' : ''} onclick="openReaderByName('${escapeJs(story.Name)}')">Read Now</button>
      </div>
    </div>`;
  if (!modal.open) modal.showModal();
}

function downloadFile(path) {
  const a = document.createElement('a');
  a.href = path;
  a.download = path.split('/').pop();
  a.rel = 'noopener';
  a.click();
}

async function toggleLibraryByName(name) {
  const isIn = state.library.has(name);
  if (isIn) state.library.delete(name); else state.library.add(name);
  localStorage.setItem('bookflix-library', JSON.stringify([...state.library]));
  renderAll();
  await api('updateLibrary', { code: state.deviceCode, storyName: name, inLibrary: !isIn });
}
window.toggleLibraryByName = toggleLibraryByName;
window.openStoryModal = openStoryModal;
window.downloadFile = downloadFile;
window.openReaderByName = openReaderByName;
window.addCalendar = addCalendar;

function openLibrary() {
  renderLibrary();
  el('libraryPanel').classList.add('open');
}

function renderLibrary() {
  const books = state.stories.filter(s => state.library.has(s.Name));
  el('libraryBooks').innerHTML = books.length ? books.map(bookCard).join('') : '<p class="empty">No books in your Libary yet.</p>';
}

function toggleOptions() {
  el('options_menu').classList.toggle('open');
  document.body.classList.toggle('menu-open');
}

async function login() {
  const email = el('loginEmail').value;
  const password = el('loginPassword').value;
  const result = await api('login', { email, password });
  if (result.ok) {
    state.user = result.user;
    hydrateFromUser(result.user);
    if (result.forcedPassword) el('loginPassword').value = result.forcedPassword;
    el('loginArea').innerHTML = '<h3>Login</h3><p class="success">Logined In</p>';
    renderAll();
  } else {
    el('loginStatus').textContent = result.error || 'Login failed';
  }
}

async function makeAccount() {
  const email = el('newEmail').value;
  const password = el('newPassword').value;
  const result = await api('makeAccount', { code: state.deviceCode, email, password });
  el('accountStatus').textContent = result.ok ? 'Account made and locked to this device.' : (result.error || 'Could not make account');
}

async function forgotPassword() {
  const result = await api('forgotPassword', { code: state.deviceCode });
  el('accountStatus').textContent = result.ok ? 'Forgotten Password mode is now active for this device.' : (result.error || 'Could not update password state');
}

async function changeTheme(theme) {
  applyTheme(theme);
  localStorage.setItem('bookflix-theme', theme);
  await api('updateTheme', { code: state.deviceCode, theme });
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
}

async function openReaderByName(name) {
  const story = state.stories.find(s => s.Name === name);
  if (!story) return;
  el('storyModal').open && el('storyModal').close();
  el('readerTitle').textContent = story.Name;
  el('reader').classList.remove('hidden');
  el('readerContent').className = 'reader-content reader-dark';
  el('readerContent').innerHTML = '<p>Loading story...</p>';
  let latest = await api('getUser', { code: state.deviceCode });
  if (latest.ok) state.user = latest.user;
  const savedProgress = Number(state.user && state.user[`${story.Name} Were Up To In Story`]) || 0;
  try {
    const response = await fetch(story.Worddoc);
    const buffer = await response.arrayBuffer();
    const converted = await mammoth.convertToHtml({ arrayBuffer: buffer }, {
      styleMap: [
        "p[style-name='Heading 1'] => h1:fresh",
        "p[style-name='Heading 2'] => h2:fresh",
        "p[style-name='Title'] => h1.title:fresh"
      ]
    });
    el('readerContent').innerHTML = converted.value || '<p>No text found in this Word document.</p>';
    requestAnimationFrame(() => jumpToProgress(savedProgress));
  } catch (error) {
    el('readerContent').innerHTML = `<p>Could not load the Word document. <a href="${story.Worddoc}" target="_blank" rel="noopener">Open the file directly</a>.</p>`;
  }
  attachReaderTracking(story);
}

function attachReaderTracking(story) {
  const reader = el('readerContent');
  reader.onscroll = () => {
    const max = Math.max(1, reader.scrollHeight - reader.clientHeight);
    const percent = Math.round((reader.scrollTop / max) * 100);
    el('readerPercent').textContent = `${percent}%`;
    console.log(`${story.Name} reader percentage:`, percent);
    clearTimeout(state.progressTimers.get(story.Name));
    const timer = setTimeout(() => api('updateProgress', { code: state.deviceCode, storyName: story.Name, progress: percent }), 800);
    state.progressTimers.set(story.Name, timer);
  };
}

function jumpToProgress(progress) {
  const reader = el('readerContent');
  const max = Math.max(1, reader.scrollHeight - reader.clientHeight);
  reader.scrollTop = max * Math.min(100, Math.max(0, progress)) / 100;
}

function closeReader() {
  el('reader').classList.add('hidden');
}

function addCalendar(name, releaseDate) {
  const date = new Date(releaseDate + 'T09:00:00');
  const ymd = releaseDate.replaceAll('-', '');
  const google = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(name + ' release')}&dates=${ymd}T090000/${ymd}T100000&details=${encodeURIComponent('BookFlix story release')}`;
  window.open(google, '_blank', 'noopener');
  const ics = `BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nSUMMARY:${name} release\nDTSTART:${ymd}T090000\nDTEND:${ymd}T100000\nDESCRIPTION:BookFlix story release\nEND:VEVENT\nEND:VCALENDAR`;
  const blob = new Blob([ics], { type: 'text/calendar' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name.replace(/[^a-z0-9]/gi, '_')}.ics`;
  a.click();
  URL.revokeObjectURL(url);
}

function formatDate(date) {
  return new Date(date).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function escapeHtml(text) {
  return String(text || '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;' }[c]));
}
function escapeJs(text) {
  return String(text || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
