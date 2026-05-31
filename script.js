/* BookFlix front end. Put index.html, style.css, script.js, stories.js, loader.gif, and assets in the same site folder. */
const GOOGLE_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbwFtVs-FzrBjF-5hy42P0_BGTQF_kH89b9FJpYqDte0KXrb4Qvtub7Qyc-UsuyUqNXZyQ/exec";
const BOOK_MODEL_URL = "assets/stories/3d_book_for_website.glb";
const DEVICE_KEY = "bookflix_10_digi_code";
const MODEL_KEY = "bookflix_custom_model_url";
const DEFAULT_TYPES = [
  ["FlashFiction", "Flash Fiction (1 to 5 pages)"],
  ["ShortStory", "Short Story (5 to 25 pages)"],
  ["Novelette", "Novelette (25 to 60 pages)"],
  ["Novella", "Novella (60 to 150 pages)"],
  ["Novel", "Novel (150 pages)"]
];

let account = { license: "Level 0", theme: "Default", library: {}, progress: {} };
let activeStory = null;
let heroIndex = 0;
let heroStories = [];
let currentVisibleStories = [];
let checkedTypes = new Set(DEFAULT_TYPES.map(([key]) => key));

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

window.addEventListener("DOMContentLoaded", init);

async function init() {
  const timeout = setTimeout(hidePreloader, 6000);
  setTimeout(hidePreloader, 900);

  bindUi();
  ensureDeviceCode();
  buildFilterControls();
  await registerDevice();
  await refreshAccount();
  renderAll();
  clearTimeout(timeout);
}

function hidePreloader() {
  const loader = $("#preloader");
  if (loader && !loader.classList.contains("hide")) loader.classList.add("hide");
}

function bindUi() {
  $("#menuBtn").addEventListener("click", () => toggleOptions(true));
  $$('[data-close-panel]').forEach(btn => btn.addEventListener("click", () => toggleOptions(false)));
  $("#libraryBtn").addEventListener("click", openLibrary);
  $$('[data-close-library]').forEach(btn => btn.addEventListener("click", () => $("#libraryPanel").classList.remove("open")));
  $$('[data-close-modal]').forEach(btn => btn.addEventListener("click", closeModal));
  $("#seriesFilter").addEventListener("change", renderAll);
  $("#genreFilter").addEventListener("change", renderAll);
  $("#themeSelect").addEventListener("change", onThemeChange);
  $("#loginBtn").addEventListener("click", login);
  $("#signupBtn").addEventListener("click", signup);
  $("#forgotBtn").addEventListener("click", forgotPassword);
  $("#closeReader").addEventListener("click", closeReader);
  $("#readerSize").addEventListener("input", e => $("#readerContent").style.fontSize = `${e.target.value}px`);
  $("#readerFont").addEventListener("change", e => $("#readerContent").style.fontFamily = e.target.value);
  $("#readerTheme").addEventListener("change", e => {
    const reader = $("#reader");
    reader.classList.remove("reader-dark", "reader-paper", "reader-light");
    reader.classList.add(e.target.value);
  });
  $("#reader").addEventListener("scroll", debounce(updateReaderProgress, 250));
}

function toggleOptions(open) {
  $("#options_menu").classList.toggle("open", open);
  if (window.matchMedia("(min-width: 761px)").matches) $("#app").classList.toggle("shift-left", open);
}

function ensureDeviceCode() {
  let code = localStorage.getItem(DEVICE_KEY);
  if (!code) {
    code = String(Math.floor(1000000000 + Math.random() * 9000000000));
    localStorage.setItem(DEVICE_KEY, code);
  }
  return code;
}

function storyHeaders() {
  return Storys.flatMap(story => [
    `${story.Name} Have Read Ture Or Fasle`,
    `${story.Name} Were Up To In Story`,
    `${story.Name} In Libary`
  ]);
}

async function api(action, data = {}) {
  if (!GOOGLE_SCRIPT_URL || GOOGLE_SCRIPT_URL.includes("PASTE_YOUR")) {
    console.warn("Google Apps Script URL is not set. Running site in local-only mode.", action, data);
    return { ok: false, localOnly: true };
  }
  try {
    const res = await fetch(GOOGLE_SCRIPT_URL, {
      method: "POST",
      mode: "cors",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action, code: ensureDeviceCode(), storyHeaders: storyHeaders(), stories: Storys.map(s => s.Name), ...data })
    });
    return await res.json();
  } catch (err) {
    console.error("Google sheet request failed", err);
    return { ok: false, error: String(err) };
  }
}

async function registerDevice() { await api("init"); }
async function refreshAccount() {
  const result = await api("getAccount");
  if (result && result.ok) account = { ...account, ...result.account };
  applyTheme(account.theme || "Default");
}

function buildFilterControls() {
  const typeBox = $("#storyTypeFilters");
  typeBox.innerHTML = DEFAULT_TYPES.map(([key, label]) => `<label><input type="checkbox" value="${key}" checked /> ${label}</label>`).join("");
  typeBox.addEventListener("change", () => {
    checkedTypes = new Set($$("#storyTypeFilters input:checked").map(input => input.value));
    renderAll();
  });

  const series = [...new Set(Storys.map(s => s.Series).filter(Boolean))].sort();
  $("#seriesFilter").innerHTML = `<option value="All">All</option>${series.map(s => `<option>${escapeHtml(s)}</option>`).join("")}`;
  const genres = [...new Set(Storys.flatMap(s => s.Genres || []))].sort();
  $("#genreFilter").innerHTML = `<option value="All">All</option>${genres.map(g => `<option>${escapeHtml(g)}</option>`).join("")}`;
}

function renderAll() {
  currentVisibleStories = getDisplayStories();
  buildHero();
  renderReleaseGrid();
  renderGenreSections();
  renderLibrary();
}

function getDisplayStories() {
  const today = startOfDay(new Date());
  const twoMonths = new Date(today); twoMonths.setMonth(twoMonths.getMonth() + 2);
  const seriesFilter = $("#seriesFilter").value;
  const genreFilter = $("#genreFilter").value;
  return Storys.filter(story => {
    const release = startOfDay(new Date(story.ReleaseDate));
    const typeOk = checkedTypes.has(story.StoryType);
    const seriesOk = seriesFilter === "All" || story.Series === seriesFilter;
    const genreOk = genreFilter === "All" || (story.Genres || []).includes(genreFilter);
    if (!typeOk || !seriesOk || !genreOk) return false;
    if (account.license === "Level 1") return true;
    if (release <= today) return true;
    return release <= twoMonths;
  }).sort((a, b) => new Date(b.ReleaseDate) - new Date(a.ReleaseDate));
}

function isLocked(story) {
  if (account.license === "Level 1") return false;
  return startOfDay(new Date(story.ReleaseDate)) > startOfDay(new Date());
}

function buildHero() {
  const typeMap = new Map();
  currentVisibleStories.forEach(story => { if (!typeMap.has(story.StoryType)) typeMap.set(story.StoryType, story); });
  heroStories = [...typeMap.values()];
  if (!heroStories.length) { $("#hero").innerHTML = `<div class="hero-inner"><h1>No stories ready yet</h1></div>`; return; }
  heroIndex = heroIndex % heroStories.length;
  renderHero(heroStories[heroIndex]);
  clearInterval(window.heroTimer);
  window.heroTimer = setInterval(() => {
    heroIndex = (heroIndex + 1) % heroStories.length;
    renderHero(heroStories[heroIndex]);
  }, 6000);
}

function renderHero(story) {
  const hero = $("#hero");
  hero.style.backgroundImage = `url('${story.Wallpaper}')`;
  const locked = isLocked(story);
  hero.innerHTML = `
    <div class="hero-inner">
      <div>
        <div class="featured">FEATURED</div>
        ${story.Logo ? `<img class="hero-logo" src="${story.Logo}" alt="${escapeHtml(story.Name)} logo" onerror="this.remove()" />` : `<h1>${escapeHtml(story.Name)}</h1>`}
        <p>${escapeHtml(story.Description || "")}</p>
        ${locked ? `<div class="countdown">Locked. Releases in ${daysUntil(story.ReleaseDate)} days.</div>` : ""}
        <div class="hero-actions">
          <button onclick="${locked ? `addCalendarEvent('${encodeURIComponent(story.Name)}','${story.ReleaseDate}')` : `openBook('${encodeURIComponent(story.Name)}')`}">${locked ? "Add Calendar" : "▶ Read Now"}</button>
          <button class="circle-btn" onclick="toggleLibrary('${encodeURIComponent(story.Name)}')">+</button>
        </div>
      </div>
      <div>${modelOrFallback(story, "hero-model")}</div>
    </div>`;
  $("#heroDots").innerHTML = heroStories.map((_, i) => `<span class="dot ${i === heroIndex ? "active" : ""}"></span>`).join("");
}

function renderReleaseGrid() { $("#releaseGrid").innerHTML = currentVisibleStories.map(bookCard).join(""); hydrateMedia(); }
function renderGenreSections() {
  const genres = [...new Set(currentVisibleStories.flatMap(s => s.Genres || []))].sort();
  $("#genresContainer").innerHTML = genres.map(genre => {
    const stories = currentVisibleStories.filter(s => (s.Genres || []).includes(genre));
    return `<section class="book-section"><div class="section-title"><h2>${escapeHtml(genre)}</h2><button class="top-btn" onclick="scrollToTop()">See All</button></div><div class="book-grid">${stories.map(bookCard).join("")}</div></section>`;
  }).join("");
  hydrateMedia();
}

function bookCard(story) {
  const locked = isLocked(story);
  const inLibrary = account.library?.[story.Name] === true;
  return `<article class="book-card ${locked ? "locked" : ""}" data-name="${escapeHtml(story.Name)}" onclick="openBook('${encodeURIComponent(story.Name)}')">
    ${inLibrary ? `<span class="library-badge">In Libary</span>` : ""}
    ${locked ? `<span class="badge">LOCKED</span>` : isNew(story.ReleaseDate) ? `<span class="badge">NEW</span>` : ""}
    <div class="book-cover-wrap">${modelOrFallback(story, "book-model")}</div>
    <div class="book-title">${escapeHtml(story.Name)}</div>
    <div class="book-meta">${escapeHtml(story.Series || "")} ${locked ? `• ${daysUntil(story.ReleaseDate)} days` : ""}</div>
  </article>`;
}

function modelOrFallback(story, className) {
  const model = localStorage.getItem(MODEL_KEY) || BOOK_MODEL_URL;
  return `<model-viewer class="${className}" src="${model}" poster="${story.Ebookcover || story.Wallpaper}" auto-rotate rotation-per-second="20deg" disable-zoom disable-pan camera-controls="false" interaction-prompt="none" shadow-intensity="1" data-fallback="${story.Wallpaper}" onerror="replaceModelWithFallback(this)"></model-viewer>`;
}

function hydrateMedia() {
  $$('model-viewer').forEach(viewer => {
    viewer.addEventListener('load', () => {}, { once: true });
    viewer.addEventListener('error', () => replaceModelWithFallback(viewer), { once: true });
    setTimeout(() => { if (!viewer.loaded) replaceModelWithFallback(viewer); }, 4500);
  });
}

function replaceModelWithFallback(viewer) {
  if (!viewer || viewer.dataset.replaced) return;
  viewer.dataset.replaced = "true";
  const img = document.createElement("img");
  img.src = viewer.dataset.fallback || "";
  img.className = viewer.classList.contains("hero-model") ? "fallback-wall" : "";
  img.alt = "Story wallpaper";
  viewer.replaceWith(img);
}

window.openBook = function(encodedName) {
  const story = Storys.find(s => s.Name === decodeURIComponent(encodedName));
  if (!story) return;
  activeStory = story;
  const locked = isLocked(story);
  $("#bookModalBody").innerHTML = `
    <div class="modal-layout">
      <div>${modelOrFallback(story, "modal-model")}</div>
      <div>
        <h1>${escapeHtml(story.Name)}</h1>
        <p class="book-meta">${escapeHtml((story.Genres || []).join(" • "))} • ${escapeHtml(story.Series || "")}</p>
        <p>${escapeHtml(story.Description || "")}</p>
        ${locked ? `<p class="countdown">This book is locked until ${story.ReleaseDate}. ${daysUntil(story.ReleaseDate)} days left.</p>` : ""}
        <div class="modal-actions">
          <a class="${locked ? "disabled" : ""}" href="${story.Epub}" download>Ebook</a>
          <a class="${locked ? "disabled" : ""}" href="${story.Pdfstory}" download>PDF</a>
          <button onclick="toggleLibrary('${encodeURIComponent(story.Name)}')">${account.library?.[story.Name] ? "Remove From Libary" : "Add To Libary"}</button>
          <button class="${locked ? "disabled" : ""}" onclick="openReader('${encodeURIComponent(story.Name)}')">Read Now</button>
          ${locked ? `<button onclick="addCalendarEvent('${encodeURIComponent(story.Name)}','${story.ReleaseDate}')">Add Calendar</button>` : ""}
        </div>
      </div>
    </div>`;
  $("#bookModal").classList.remove("hidden");
  hydrateMedia();
};

function closeModal() { $("#bookModal").classList.add("hidden"); }

window.toggleLibrary = async function(encodedName) {
  const story = Storys.find(s => s.Name === decodeURIComponent(encodedName));
  if (!story) return;
  const next = !(account.library?.[story.Name] === true);
  account.library = { ...(account.library || {}), [story.Name]: next };
  await api("setLibrary", { storyName: story.Name, value: next });
  renderAll();
  if (!$("#bookModal").classList.contains("hidden")) window.openBook(encodeURIComponent(story.Name));
};

function openLibrary() { renderLibrary(); $("#libraryPanel").classList.add("open"); }
function renderLibrary() {
  const books = currentVisibleStories.filter(story => account.library?.[story.Name] === true);
  $("#libraryGrid").innerHTML = books.length ? books.map(bookCard).join("") : `<p class="book-meta">No books in your Libary yet.</p>`;
  hydrateMedia();
}

window.openReader = async function(encodedName) {
  const story = Storys.find(s => s.Name === decodeURIComponent(encodedName));
  if (!story || isLocked(story)) return;
  closeModal();
  const reader = $("#reader");
  const content = $("#readerContent");
  reader.classList.remove("hidden", "reader-dark", "reader-paper", "reader-light");
  reader.classList.add($("#readerTheme").value || "reader-dark");
  content.innerHTML = `<p>Loading ${escapeHtml(story.Name)}...</p>`;
  try {
    const response = await fetch(story.Worddoc);
    const buffer = await response.arrayBuffer();
    const result = await mammoth.convertToHtml({ arrayBuffer: buffer }, {
      convertImage: mammoth.images.imgElement(image => image.read("base64").then(data => ({ src: `data:${image.contentType};base64,${data}` })))
    });
    content.innerHTML = result.value;
    const pct = Number(account.progress?.[story.Name] || 0);
    setTimeout(() => jumpToProgress(pct), 350);
    console.log(`${story.Name} reader progress: ${pct}%`);
  } catch (err) {
    console.error(err);
    content.innerHTML = `<p>The Word document could not be loaded. You can still download the ebook or PDF.</p>`;
  }
};

function closeReader() { $("#reader").classList.add("hidden"); }
function jumpToProgress(percent) {
  const reader = $("#reader");
  const max = reader.scrollHeight - reader.clientHeight;
  reader.scrollTop = Math.max(0, max * (percent / 100));
}
function updateReaderProgress() {
  if (!activeStory) return;
  const reader = $("#reader");
  const max = reader.scrollHeight - reader.clientHeight;
  const percent = max > 0 ? Math.min(100, Math.round((reader.scrollTop / max) * 100)) : 0;
  $("#readerProgress").textContent = `${percent}%`;
  console.log(`${activeStory.Name} reader progress: ${percent}%`);
  account.progress = { ...(account.progress || {}), [activeStory.Name]: percent };
  api("setProgress", { storyName: activeStory.Name, percent });
}

async function login() {
  const email = $("#loginEmail").value.trim();
  const password = $("#loginPassword").value;
  const result = await api("login", { email, password });
  if (result.ok) {
    account = { ...account, ...result.account };
    $("#loginBox").innerHTML = `<p class="small-status">Logined In</p>`;
    applyTheme(account.theme || "Default");
    renderAll();
  } else $("#loginStatus").textContent = result.error || "Login failed";
}

async function signup() {
  const email = $("#signupEmail").value.trim();
  const password = $("#signupPassword").value;
  const result = await api("signup", { email, password });
  $("#signupStatus").textContent = result.ok ? "Account made and locked to this device." : (result.error || "Could not make account");
}

async function forgotPassword() {
  const result = await api("forgotPassword");
  $("#signupStatus").textContent = result.ok ? "Forgotten Password mode set for this device." : (result.error || "Could not set forgotten password");
}

async function onThemeChange(e) {
  const theme = e.target.value;
  applyTheme(theme);
  account.theme = theme;
  await api("setTheme", { theme });
}
function applyTheme(theme) {
  document.body.className = document.body.className.replace(/theme-\S+/g, "").trim();
  document.body.classList.add(`theme-${theme || "Default"}`);
  $("#themeSelect").value = theme || "Default";
}

window.addCalendarEvent = function(encodedName, releaseDate) {
  const name = decodeURIComponent(encodedName);
  const date = new Date(releaseDate);
  const ymd = date.toISOString().slice(0,10).replaceAll("-", "");
  const google = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(name + " release")}&dates=${ymd}/${ymd}&details=${encodeURIComponent("BookFlix release date")}`;
  const ics = `BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nSUMMARY:${name} release\nDTSTART;VALUE=DATE:${ymd}\nEND:VEVENT\nEND:VCALENDAR`;
  const blob = new Blob([ics], { type: "text/calendar" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${name.replace(/[^a-z0-9]/gi, "_")}_release.ics`;
  a.click();
  window.open(google, "_blank", "noopener");
};

function startOfDay(date) { return new Date(date.getFullYear(), date.getMonth(), date.getDate()); }
function daysUntil(date) { return Math.max(0, Math.ceil((startOfDay(new Date(date)) - startOfDay(new Date())) / 86400000)); }
function isNew(date) { return (Date.now() - new Date(date).getTime()) / 86400000 <= 45; }
function escapeHtml(str) { return String(str ?? "").replace(/[&<>'"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c])); }
function debounce(fn, wait) { let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); }; }
