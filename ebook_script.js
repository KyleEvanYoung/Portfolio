/*
 * ebook_script.js
 * Frontend logic for BookFlix-style ebook website.
 *
 * IMPORTANT:
 * Paste your deployed Google Apps Script Web App URL below.
 * Leave it empty to run the website without Google Sheet syncing.
 */
const GOOGLE_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbwUmuj0KB5TApqfXR7nfHIV9j1QYxizFTjKZkJ2Nt3diAYgNkNLfjmGe-aGnsUSiBpFAQ/exec"; // Example: "https://script.google.com/macros/s/AKfycb.../exec"

const MODEL_URL = "assets/stories/3d_book_for_website.glb";
const PRELOAD_TIMEOUT_MS = 6000;
const TWO_MONTHS_MS = 1000 * 60 * 60 * 24 * 62;

const state = {
  deviceCode: "",
  user: null,
  visibleStories: [],
  upcomingStories: [],
  library: new Set(),
  activeStory: null,
  heroSlides: [],
  heroIndex: 0,
  heroTimer: null,
  typeFilters: new Set(["FlashFiction", "ShortStory", "Novelette", "Novella", "Novel"]),
  currentTheme: "Default"
};

const $ = (id) => document.getElementById(id);

document.addEventListener("DOMContentLoaded", async () => {
  skipPreloaderAfterSixSeconds();
  bindUi();
  initDeviceCode();
  populateFilters();
  await syncInitDevice();
  applyTheme((state.user && state.user["Theme Style"]) || "Default");
  renderEverything();
  hidePreloader();
  setInterval(() => api("updateLastOpened", { code: state.deviceCode }), 1000 * 60 * 5);
});

function skipPreloaderAfterSixSeconds() {
  window.setTimeout(() => hidePreloader(), PRELOAD_TIMEOUT_MS);
}

function hidePreloader() {
  const preloader = $("preloader");
  if (preloader) preloader.classList.add("hidden");
}

function bindUi() {
  $("menuBtn").addEventListener("click", () => document.body.classList.toggle("menu-open"));
  $("closeMenuBtn").addEventListener("click", () => document.body.classList.remove("menu-open"));
  $("libraryBtn").addEventListener("click", openLibrary);
  $("closeLibraryBtn").addEventListener("click", () => $("libraryOverlay").hidden = true);
  $("closeBookModalBtn").addEventListener("click", () => $("bookModal").hidden = true);
  $("closeReaderBtn").addEventListener("click", closeReader);

  $("searchInput").addEventListener("input", renderEverything);
  $("genreFilter").addEventListener("change", renderEverything);
  $("seriesFilter").addEventListener("change", renderEverything);

  document.querySelectorAll("[data-type]").forEach(input => {
    input.addEventListener("change", () => {
      if (input.checked) state.typeFilters.add(input.dataset.type);
      else state.typeFilters.delete(input.dataset.type);
      renderEverything();
    });
  });

  $("loginButton").addEventListener("click", login);
  $("makeAccountButton").addEventListener("click", makeAccount);
  $("forgotPasswordButton").addEventListener("click", forgotPassword);

  $("themeSelect").addEventListener("change", async (event) => {
    const theme = event.target.value;
    applyTheme(theme);
    await api("setTheme", { code: state.deviceCode, theme });
  });

  $("readerSize").addEventListener("input", updateReaderStyle);
  $("readerFont").addEventListener("change", updateReaderStyle);
  $("readerBg").addEventListener("input", updateReaderStyle);
  $("readerColor").addEventListener("input", updateReaderStyle);

  $("heroReadBtn").addEventListener("click", () => state.heroSlides[state.heroIndex] && openReader(state.heroSlides[state.heroIndex]));
  $("heroAddBtn").addEventListener("click", () => state.heroSlides[state.heroIndex] && toggleLibrary(state.heroSlides[state.heroIndex]));
}

function initDeviceCode() {
  let code = localStorage.getItem("ebook_device_10_digit_code");
  if (!/^\d{10}$/.test(code || "")) {
    code = "";
    if (crypto && crypto.getRandomValues) {
      const arr = new Uint32Array(1);
      crypto.getRandomValues(arr);
      code = String(arr[0]).padStart(10, "0").slice(0, 10);
    } else {
      code = String(Math.floor(1000000000 + Math.random() * 9000000000));
    }
    localStorage.setItem("ebook_device_10_digit_code", code);
  }
  state.deviceCode = code;
  $("deviceCodeText").textContent = code;
}

async function syncInitDevice() {
  const storyNames = Storys.map(s => s.Name);
  const response = await api("initDevice", { code: state.deviceCode, storyNames });
  if (response && response.ok) {
    state.user = response.user || null;
    restoreLibraryFromUser();
  } else {
    loadLocalLibrary();
  }
}

async function api(action, payload = {}) {
  if (!GOOGLE_SCRIPT_URL) return null;

  try {
    const response = await fetch(GOOGLE_SCRIPT_URL, {
      method: "POST",
      mode: "cors",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action, ...payload })
    });
    return await response.json();
  } catch (error) {
    console.warn("Google Sheet API failed:", error);
    return null;
  }
}

function populateFilters() {
  const genres = new Set();
  const series = new Set();

  Storys.forEach(story => {
    (story.Genres || []).forEach(g => genres.add(g));
    if (story.Series) series.add(story.Series);
  });

  [...genres].sort().forEach(genre => $("genreFilter").append(new Option(genre, genre)));
  [...series].sort().forEach(name => $("seriesFilter").append(new Option(name, name)));
}

function restoreLibraryFromUser() {
  state.library.clear();
  if (!state.user) return loadLocalLibrary();

  Storys.forEach(story => {
    const key = story.Name + " In Libary";
    if (String(state.user[key] || "").toLowerCase() === "true") {
      state.library.add(story.Name);
    }
  });

  if (state.library.size === 0) loadLocalLibrary();
}

function loadLocalLibrary() {
  const local = JSON.parse(localStorage.getItem("ebook_library") || "[]");
  state.library = new Set(local);
}

function saveLocalLibrary() {
  localStorage.setItem("ebook_library", JSON.stringify([...state.library]));
}

function applyTheme(theme) {
  state.currentTheme = theme || "Default";
  document.body.dataset.theme = state.currentTheme;
  $("themeSelect").value = state.currentTheme;
}

function getAccountLevel() {
  return String((state.user && state.user["Level Of Account License"]) || "Level 0");
}

function classifyStories() {
  const now = new Date();
  const accountLevel = getAccountLevel();

  const allSorted = [...Storys].sort((a, b) => new Date(b.ReleaseDate) - new Date(a.ReleaseDate));
  state.visibleStories = [];
  state.upcomingStories = [];

  allSorted.forEach(story => {
    const releaseDate = new Date(story.ReleaseDate);
    const diff = releaseDate.getTime() - now.getTime();
    const future = diff > 0;

    if (accountLevel === "Level 1") {
      state.visibleStories.push(story);
      return;
    }

    if (!future) {
      state.visibleStories.push(story);
    } else if (diff <= TWO_MONTHS_MS) {
      state.upcomingStories.push(story);
    }
  });
}

function filteredStories(stories) {
  const q = $("searchInput").value.trim().toLowerCase();
  const genre = $("genreFilter").value;
  const series = $("seriesFilter").value;

  return stories.filter(story => {
    if (!state.typeFilters.has(story.StoryType)) return false;
    if (genre !== "all" && !(story.Genres || []).includes(genre)) return false;
    if (series !== "all" && story.Series !== series) return false;
    if (q && !`${story.Name} ${story.Description} ${(story.Genres || []).join(" ")} ${story.Series}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

function renderEverything() {
  classifyStories();
  renderHero();
  renderReleaseGrid();
  renderUpcoming();
  renderGenreSections();
  renderLibraryGrid();
}

function renderHero() {
  const typeMap = new Map();
  state.visibleStories.forEach(story => {
    if (!typeMap.has(story.StoryType)) typeMap.set(story.StoryType, story);
  });
  state.heroSlides = [...typeMap.values()];
  if (state.heroSlides.length === 0) state.heroSlides = state.visibleStories.slice(0, 1);
  state.heroIndex = Math.min(state.heroIndex, Math.max(0, state.heroSlides.length - 1));
  drawHeroSlide();

  clearInterval(state.heroTimer);
  state.heroTimer = setInterval(() => {
    if (!state.heroSlides.length) return;
    state.heroIndex = (state.heroIndex + 1) % state.heroSlides.length;
    drawHeroSlide();
  }, 7000);
}

function drawHeroSlide() {
  const story = state.heroSlides[state.heroIndex];
  if (!story) return;

  $("hero").style.backgroundImage = `url("${story.Wallpaper}")`;
  $("heroType").textContent = story.StoryType || "Featured";
  $("heroTitle").textContent = story.Name;
  $("heroDescription").textContent = story.Description || "";
  $("heroFallback").src = story.Ebookcover || story.Wallpaper || "";
  $("heroFallback").hidden = true;

  setupModelFallback($("heroModel"), $("heroFallback"));

  $("heroDots").innerHTML = "";
  state.heroSlides.forEach((_, i) => {
    const dot = document.createElement("button");
    dot.className = i === state.heroIndex ? "active" : "";
    dot.type = "button";
    dot.addEventListener("click", () => {
      state.heroIndex = i;
      drawHeroSlide();
    });
    $("heroDots").append(dot);
  });
}

function renderReleaseGrid() {
  const stories = filteredStories(state.visibleStories);
  $("releaseGrid").innerHTML = "";
  stories.forEach(story => $("releaseGrid").append(bookCard(story)));
}

function renderUpcoming() {
  const upcoming = filteredStories(state.upcomingStories);
  $("upcomingSection").hidden = upcoming.length === 0;
  $("upcomingGrid").innerHTML = "";
  upcoming.forEach(story => $("upcomingGrid").append(bookCard(story, { upcoming: true })));
}

function renderGenreSections() {
  const container = $("genresContainer");
  container.innerHTML = "";

  const stories = filteredStories(state.visibleStories);
  const genreMap = new Map();

  stories.forEach(story => {
    (story.Genres || ["Other"]).forEach(genre => {
      if (!genreMap.has(genre)) genreMap.set(genre, []);
      genreMap.get(genre).push(story);
    });
  });

  [...genreMap.entries()].sort(([a], [b]) => a.localeCompare(b)).forEach(([genre, list]) => {
    const section = document.createElement("section");
    section.className = "story-section";
    section.innerHTML = `
      <div class="section-title-row">
        <h2>${escapeHtml(genre)}</h2>
        <button class="text-link" type="button">See All</button>
      </div>
      <div class="book-row"></div>
    `;
    const row = section.querySelector(".book-row");
    list.forEach(story => row.append(bookCard(story)));
    container.append(section);
  });
}

function bookCard(story, options = {}) {
  const card = document.createElement("article");
  card.className = "book-card";
  card.tabIndex = 0;

  const locked = options.upcoming;
  const inLib = state.library.has(story.Name);

  card.innerHTML = `
    <div class="cover-wrap">
      <img class="cover" src="${escapeAttr(story.Port || story.Wallpaper)}" alt="${escapeAttr(story.Name)} cover" loading="lazy" />
      ${inLib ? `<span class="badge">In Libary</span>` : ""}
      ${locked ? `<span class="badge dark">Locked</span>` : ""}
    </div>
    <h3>${escapeHtml(story.Name)}</h3>
    <p>${escapeHtml(story.Series || (story.Genres || []).join(", "))}</p>
    ${locked ? `<small class="countdown-text">${countdownText(story.ReleaseDate)}</small>` : ""}
  `;

  card.addEventListener("click", () => openBookModal(story, locked));
  card.addEventListener("keypress", (e) => {
    if (e.key === "Enter") openBookModal(story, locked);
  });

  return card;
}

function openBookModal(story, locked = false) {
  state.activeStory = story;
  $("bookModal").hidden = false;
  $("modalTitle").textContent = story.Name;
  $("modalDesc").textContent = story.Description || "";
  $("modalType").textContent = `${story.StoryType || ""} • ${(story.Genres || []).join(", ")}`;
  $("modalMeta").textContent = `${story.Series || "No Series"} • Release: ${story.ReleaseDate}`;
  $("modalCountdown").textContent = locked ? countdownText(story.ReleaseDate) : "";
  $("modalLibraryBtn").textContent = state.library.has(story.Name) ? "Remove From Libary" : "Add To Libary";

  $("modalVisual").innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "modal-model-wrap";
  wrap.innerHTML = `
    <model-viewer class="book-model modal-model"
      src="${MODEL_URL}"
      camera-controls="false"
      disable-zoom
      interaction-prompt="none"
      auto-rotate
      rotation-per-second="45deg"
      shadow-intensity="0.8"
      alt="${escapeAttr(story.Name)}">
    </model-viewer>
    <img class="modal-fallback" src="${escapeAttr(story.Ebookcover || story.Wallpaper)}" alt="${escapeAttr(story.Name)}" hidden />
    ${state.library.has(story.Name) ? `<span class="big-badge">In Libary</span>` : ""}
  `;
  $("modalVisual").append(wrap);
  setupModelFallback(wrap.querySelector("model-viewer"), wrap.querySelector("img"));

  $("modalEbookBtn").disabled = locked;
  $("modalPdfBtn").disabled = locked;
  $("modalReadBtn").disabled = locked;
  $("modalLibraryBtn").disabled = locked;

  $("modalGoogleCalBtn").hidden = !locked;
  $("modalAppleCalBtn").hidden = !locked;

  $("modalEbookBtn").onclick = () => downloadFile(story.Epub);
  $("modalPdfBtn").onclick = () => downloadFile(story.Pdfstory);
  $("modalLibraryBtn").onclick = () => toggleLibrary(story);
  $("modalReadBtn").onclick = () => openReader(story);

  $("modalGoogleCalBtn").onclick = () => openGoogleCalendar(story);
  $("modalAppleCalBtn").onclick = () => downloadAppleCalendar(story);
}

function setupModelFallback(model, fallback) {
  let finished = false;
  const showFallback = () => {
    if (finished) return;
    finished = true;
    if (model) model.style.display = "none";
    if (fallback) fallback.hidden = false;
  };

  if (!model || !fallback) return showFallback();

  const timer = setTimeout(showFallback, 5500);
  model.addEventListener("load", () => {
    finished = true;
    clearTimeout(timer);
    model.style.display = "";
    fallback.hidden = true;
  }, { once: true });

  model.addEventListener("error", showFallback, { once: true });
}

function downloadFile(url) {
  if (!url) return;
  const a = document.createElement("a");
  a.href = url;
  a.download = "";
  document.body.append(a);
  a.click();
  a.remove();
}

async function toggleLibrary(story) {
  const isInLibrary = state.library.has(story.Name);
  if (isInLibrary) state.library.delete(story.Name);
  else state.library.add(story.Name);
  saveLocalLibrary();

  await api("setLibrary", {
    code: state.deviceCode,
    storyName: story.Name,
    inLibrary: !isInLibrary
  });

  if (state.activeStory && state.activeStory.Name === story.Name) {
    openBookModal(story, false);
  }
  renderEverything();
}

function openLibrary() {
  renderLibraryGrid();
  $("libraryOverlay").hidden = false;
}

function renderLibraryGrid() {
  const grid = $("libraryGrid");
  if (!grid) return;
  grid.innerHTML = "";

  const books = state.visibleStories.filter(story => state.library.has(story.Name));
  if (books.length === 0) {
    grid.innerHTML = `<p class="empty">No books in your Libary yet.</p>`;
    return;
  }

  books.forEach(story => grid.append(bookCard(story)));
}

async function openReader(story) {
  state.activeStory = story;
  $("bookModal").hidden = true;
  $("readerOverlay").hidden = false;
  $("readerTitle").textContent = story.Name;
  $("readerContent").innerHTML = "<p>Loading story...</p>";

  try {
    const response = await fetch(story.Worddoc);
    if (!response.ok) throw new Error("Could not load Worddoc.");
    const arrayBuffer = await response.arrayBuffer();

    const result = await mammoth.convertToHtml({ arrayBuffer }, {
      styleMap: [
        "p[style-name='Title'] => h1:fresh",
        "p[style-name='Heading 1'] => h2:fresh",
        "p[style-name='Heading 2'] => h3:fresh"
      ]
    });

    $("readerContent").innerHTML = result.value || "<p>No readable text found.</p>";
    cleanReaderImages();
    updateReaderStyle();
    jumpToSavedProgress(story);
    window.setTimeout(() => trackReaderProgress(story), 400);
  } catch (error) {
    $("readerContent").innerHTML = `
      <h2>Could not open the Word document.</h2>
      <p>The file may be missing, blocked by the browser, or not a valid .docx file.</p>
      <p><a href="${escapeAttr(story.Worddoc)}" download>Download Worddoc</a></p>
    `;
    console.warn(error);
  }
}

function cleanReaderImages() {
  $("readerContent").querySelectorAll("img").forEach(img => {
    img.style.width = "40%";
    img.style.maxWidth = "300px";
    img.style.height = "300px";
    img.style.objectFit = "contain";
  });

  $("readerContent").querySelectorAll("h1,h2,h3,h4").forEach(h => {
    h.classList.add("chapter-gap");
  });
}

function updateReaderStyle() {
  const content = $("readerContent");
  content.style.fontSize = $("readerSize").value + "px";
  content.style.fontFamily = $("readerFont").value;
  content.style.backgroundColor = $("readerBg").value;
  content.style.color = $("readerColor").value;
}

function closeReader() {
  $("readerOverlay").hidden = true;
  if (state.activeStory) trackReaderProgress(state.activeStory, true);
}

function getSavedProgress(story) {
  const sheetKey = story.Name + " Were Up To In Story";
  const fromSheet = Number(state.user && state.user[sheetKey]);
  if (Number.isFinite(fromSheet) && fromSheet > 0) return fromSheet;

  const local = Number(localStorage.getItem(progressKey(story)) || 0);
  return Number.isFinite(local) ? local : 0;
}

function jumpToSavedProgress(story) {
  const progress = getSavedProgress(story);
  if (progress <= 0) return;

  const content = $("readerContent");
  const target = content.scrollHeight * (progress / 100);
  $("readerOverlay").scrollTop = target;
}

let progressTimeout = null;
function trackReaderProgress(story, immediate = false) {
  const overlay = $("readerOverlay");
  const content = $("readerContent");
  const maxScroll = Math.max(1, content.scrollHeight - overlay.clientHeight);

  const percent = Math.max(0, Math.min(100, (overlay.scrollTop / maxScroll) * 100));
  console.log(`${story.Name} reader progress: ${percent.toFixed(2)}%`);

  localStorage.setItem(progressKey(story), String(percent.toFixed(2)));

  clearTimeout(progressTimeout);
  const send = () => api("setProgress", { code: state.deviceCode, storyName: story.Name, percent });

  if (immediate) send();
  else progressTimeout = setTimeout(send, 900);
}

$("readerOverlay").addEventListener("scroll", () => {
  if (state.activeStory && !$("readerOverlay").hidden) trackReaderProgress(state.activeStory);
}, { passive: true });

function progressKey(story) {
  return `ebook_progress_${state.deviceCode}_${story.Name}`;
}

async function login() {
  const email = $("loginEmail").value.trim();
  const password = $("loginPassword").value;

  const response = await api("login", { email, password });
  if (response && response.ok) {
    state.user = response.user;
    restoreLibraryFromUser();
    applyTheme(state.user["Theme Style"] || "Default");
    $("loginCard").innerHTML = `<h3>Login</h3><p class="success">Logined In</p>`;
    if (response.passwordFromSheet && response.passwordFromSheet !== password) {
      alert("Password recovered and filled from Google Sheet.");
    }
    renderEverything();
  } else {
    $("loginStatus").textContent = (response && response.error) || "Login failed. Check backend setup.";
  }
}

async function makeAccount() {
  const email = $("newEmail").value.trim();
  const password = $("newPassword").value;

  const response = await api("makeAccount", { code: state.deviceCode, email, password });
  alert(response && response.ok ? "Account made." : ((response && response.error) || "Could not make account."));
}

async function forgotPassword() {
  const response = await api("forgotPassword", { code: state.deviceCode });
  alert(response && response.ok ? "Forgotten Password mode set." : ((response && response.error) || "Could not update password mode."));
}

function openGoogleCalendar(story) {
  const start = new Date(story.ReleaseDate + "T09:00:00");
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  const dates = `${formatCalDate(start)}/${formatCalDate(end)}`;
  const url = new URL("https://calendar.google.com/calendar/render");
  url.searchParams.set("action", "TEMPLATE");
  url.searchParams.set("text", `${story.Name} release`);
  url.searchParams.set("details", story.Description || "");
  url.searchParams.set("dates", dates);
  window.open(url.toString(), "_blank", "noopener");
}

function downloadAppleCalendar(story) {
  const start = new Date(story.ReleaseDate + "T09:00:00");
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    "SUMMARY:" + escapeIcs(`${story.Name} release`),
    "DESCRIPTION:" + escapeIcs(story.Description || ""),
    "DTSTART:" + formatIcsDate(start),
    "DTEND:" + formatIcsDate(end),
    "END:VEVENT",
    "END:VCALENDAR"
  ].join("\r\n");

  const blob = new Blob([ics], { type: "text/calendar" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${story.Name.replace(/[^\w\d]+/g, "_")}_release.ics`;
  a.click();
  URL.revokeObjectURL(url);
}

function countdownText(dateString) {
  const diff = new Date(dateString).getTime() - Date.now();
  if (diff <= 0) return "Released now";
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff / (1000 * 60 * 60)) % 24);
  return `${days} days ${hours} hours until release`;
}

function formatCalDate(date) {
  return date.toISOString().replace(/[-:]|\.\d{3}/g, "");
}

function formatIcsDate(date) {
  return formatCalDate(date);
}

function escapeIcs(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[char]));
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}
