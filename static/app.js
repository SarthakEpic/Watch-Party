const EMOJI = ["❤️", "😂", "👏", "😮", "🍿", "✨", "🔥", "🥹", "🙌", "👀"];
const CHAT_EMOJIS = [
  ["❤️", "heart love"], ["🧡", "orange heart"], ["💛", "yellow heart"], ["💚", "green heart"],
  ["💙", "blue heart"], ["💜", "purple heart"], ["🖤", "black heart"], ["🤍", "white heart"],
  ["😂", "laugh tears funny"], ["🤣", "rolling laugh"], ["🥹", "teary touched"], ["😭", "cry"],
  ["😮", "wow surprised"], ["😱", "scream shock"], ["😏", "smirk"], ["🥰", "love heart eyes"],
  ["👏", "clap applause"], ["🙌", "celebrate hands"], ["🤝", "deal"], ["👍", "thumbs up"],
  ["👀", "eyes watching"], ["🤔", "thinking"], ["🫣", "peek"], ["🤯", "mind blown"],
  ["🍿", "popcorn movie"], ["🎬", "clapper movie"], ["🎥", "camera film"], ["🎞️", "film frames"],
  ["🥤", "drink soda"], ["🍫", "chocolate snack"], ["🍕", "pizza"], ["🧸", "cute bear"],
  ["✨", "sparkles magic"], ["⭐", "star"], ["🌙", "moon night"], ["🔥", "fire hot"],
  ["💀", "skull funny"], ["🫶", "heart hands"], ["💅", "slay"], ["🕺", "dance"],
  ["🐈", "cat cute"], ["🐼", "panda cute"], ["🐸", "frog cute"], ["🦊", "fox cute"],
];
const DEMO_SAMPLE_VIDEO = {
  id: "demo-sample-video",
  title: "Sample clip",
  overview: "A sample YouTube video to try synchronized playback with your watch party.",
  source_url: "https://youtu.be/yVndvvCdvU4?si=L0iOdFUS68nKxjS6",
  source_kind: "youtube",
  youtube_id: "yVndvvCdvU4",
  source_label: "Sample video",
  genre_names: ["Sample clip"],
};
const LEGACY_DEMO_VIDEO_IDS = ["sample-spring-reel", "official-tengen-preview"];
const YOUTUBE_DRIFT_THRESHOLD_SECONDS = 1.5;
const YOUTUBE_CORRECTION_COOLDOWN_MS = 5000;
const YOUTUBE_BUFFER_STALL_MS = 10000;
const state = {
  userId: "",
  name: "",
  username: null,
  isGuest: true,
  room: null,
  socket: null,
  serverOffset: 0,
  lastVersion: 0,
  actionCounter: 0,
  activeSource: "",
  activeKind: "",
  sourceMode: "url",
  youtubePlayer: null,
  youtubeReady: false,
  youtubeApiPromise: null,
  lastYouTubeCorrectionAt: 0,
  youtubeBufferingSince: 0,
  youtubeBufferProgressAt: 0,
  youtubeLastBufferedFraction: 0,
  youtubeLastBufferTime: 0,
  youtubeRecoveryAttempts: 0,
  youtubeRecoveryAttemptAt: 0,
  applyingPlaybackUntil: 0,
  pendingMovie: null,
  videoDialogMovie: null,
  pendingAction: null,
  actionAcknowledgements: new Map(),
  waitingMovieActionId: null,
  draggedSeek: false,
  activeTab: "chat",
  lastChatCount: 0,
  pickerTab: "emoji",
  klipyAppKey: "",
  klipySearchTimer: null,
  klipySearchSequence: 0,
  emojiSuggestionIndex: 0,
  emojiSuggestions: [],
  emojiSuggestionStart: 0,
  reconnectTimer: null,
  catalogTimer: null,
  catalog: [],
};

const ui = {
  lobby: document.getElementById("lobbyView"),
  roomView: document.getElementById("roomView"),
  movieGrid: document.getElementById("movieGrid"),
  catalogStatus: document.getElementById("catalogStatus"),
  search: document.getElementById("movieSearch"),
  genre: document.getElementById("genreFilter"),
  category: document.getElementById("categoryFilter"),
  video: document.getElementById("sharedVideo"),
  youtubeContainer: document.getElementById("youtubeContainer"),
  browserPreview: document.getElementById("browserPreview"),
  emptyScreen: document.getElementById("emptyScreen"),
  videoError: document.getElementById("videoError"),
  resumeButton: document.getElementById("resumeVideoButton"),
  syncIndicator: document.getElementById("syncIndicator"),
  syncLabel: document.getElementById("syncLabel"),
  playPauseButton: document.getElementById("playPauseButton"),
  seek: document.getElementById("seekSlider"),
  timeCurrent: document.getElementById("timeCurrent"),
  timeTotal: document.getElementById("timeTotal"),
  chatMessages: document.getElementById("chatMessages"),
  chatForm: document.getElementById("chatForm"),
  chatInput: document.getElementById("chatInput"),
  chatPicker: document.getElementById("chatPicker"),
  emojiGrid: document.getElementById("emojiGrid"),
  emojiSearch: document.getElementById("emojiSearch"),
  klipyStickerSearch: document.getElementById("klipyStickerSearch"),
  klipyStickerStatus: document.getElementById("klipyStickerStatus"),
  stickerGrid: document.getElementById("stickerGrid"),
  emojiAutocomplete: document.getElementById("emojiAutocomplete"),
  memberList: document.getElementById("memberList"),
  playlist: document.getElementById("playlistList"),
  pollCard: document.getElementById("pollCard"),
  videoDialog: document.getElementById("videoDialog"),
  videoForm: document.getElementById("videoForm"),
  videoTitle: document.getElementById("filmTitleInput"),
  videoUrl: document.getElementById("videoUrlInput"),
  videoFile: document.getElementById("videoFileInput"),
  sourceUrlFields: document.getElementById("sourceUrlFields"),
  sourceFileFields: document.getElementById("sourceFileFields"),
  uploadProgress: document.getElementById("uploadProgress"),
  uploadProgressLabel: document.getElementById("uploadProgressLabel"),
  sourceModeGrid: document.getElementById("sourceModeGrid"),
  submitVideoButton: document.getElementById("submitVideoButton"),
  toastRegion: document.getElementById("toastRegion"),
};

// Handle the primary action directly. This keeps the stream button responsive
// even if the browser's dialog-form submit behavior differs between browsers.
ui.submitVideoButton.addEventListener("click", function (event) {
  event.preventDefault();
  event.stopPropagation();
  submitVideo();
});

function makeElement(tagName, className, text) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (text !== undefined && text !== null) element.textContent = text;
  return element;
}

function makeId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (window.crypto && typeof window.crypto.getRandomValues === "function") {
    window.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, function (byte) { return byte.toString(16).padStart(2, "0"); }).join("");
}

function encodeStickerPayload(payload) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let binary = "";
  bytes.forEach(function (byte) { binary += String.fromCharCode(byte); });
  return "[[sticker:" + btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "") + "]]";
}

function safeKlipyMediaUrl(value) {
  try {
    const source = String(value || "");
    const url = new URL(source);
    if (url.protocol !== "https:" || !/(^|\.)klipy\.com$/i.test(url.hostname)) return "";
    if (!/\.(gif|webp|png|jpe?g|mp4|webm)$/i.test(url.pathname)) return "";
    return source;
  } catch (_) { return ""; }
}

function klipyMediaElement(url, className, label) {
  const isVideo = /\.(mp4|webm)(?:[?#]|$)/i.test(url);
  const media = makeElement(isVideo ? "video" : "img", className);
  if (isVideo) {
    media.autoplay = true;
    media.loop = true;
    media.muted = true;
    media.playsInline = true;
    media.preload = "metadata";
    media.setAttribute("aria-label", label || "Animated sticker");
  } else {
    media.alt = label || "Movie-night sticker";
    media.loading = "lazy";
    media.decoding = "async";
  }
  media.src = url;
  media.addEventListener("error", function () { media.classList.add("is-unavailable"); });
  return media;
}

function decodeStickerMessage(text) {
  const match = String(text || "").match(/^\[\[sticker:([A-Za-z0-9_-]{1,450})\]\]$/);
  if (!match) return null;
  try {
    const base64 = match[1].replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64 + "=".repeat((4 - base64.length % 4) % 4));
    const bytes = Uint8Array.from(binary, function (character) { return character.charCodeAt(0); });
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (value && value.k === "klipy") {
      const url = safeKlipyMediaUrl(value.u);
      if (!url) return null;
      return { type: "klipy", url: url, label: String(value.s || "Movie-night sticker").slice(0, 80) };
    }
    if (value && Array.isArray(value.a)) {
      return {
        type: "emoji",
        label: String(value.s || "Movie-night moment").slice(0, 48),
        art: value.a.slice(0, 4).map(function (item) { return String(item).slice(0, 8); }),
      };
    }
    return null;
  } catch (_) { return null; }
}

function encodeKlipyStickerMessage(sticker) {
  return encodeStickerPayload({ k: "klipy", s: String(sticker.title || "Movie-night sticker").slice(0, 80), u: sticker.url });
}

function createStickerElement(sticker) {
  if (sticker.type === "klipy") {
    const card = makeElement("figure", "chat-sticker-message is-klipy");
    card.setAttribute("aria-label", sticker.label);
    const image = klipyMediaElement(sticker.url, "chat-sticker-image", sticker.label);
    const caption = makeElement("figcaption", "chat-sticker-caption");
    caption.append(makeElement("span", "chat-sticker-label", sticker.label), makeElement("span", "chat-sticker-credit", "via KLIPY"));
    card.append(image, caption);
    return card;
  }
  const card = makeElement("span", "chat-sticker-message");
  card.setAttribute("aria-label", sticker.label);
  card.append(makeElement("span", "chat-sticker-art", (sticker.art || []).join(" ")));
  card.append(makeElement("span", "chat-sticker-label", sticker.label));
  return card;
}

function setKlipyStickerStatus(message, kind) {
  ui.klipyStickerStatus.textContent = message;
  ui.klipyStickerStatus.className = "picker-status" + (kind ? " is-" + kind : "");
}

function firstKlipyUrl() {
  for (let index = 0; index < arguments.length; index += 1) {
    const item = arguments[index];
    const value = item && typeof item === "object" ? item.url : item;
    const url = safeKlipyMediaUrl(value);
    if (url) return url;
  }
  return "";
}

function klipyStickerFromResult(item, index) {
  const file = item && item.file && typeof item.file === "object" ? item.file : {};
  const xs = file.xs || {};
  const sm = file.sm || {};
  const md = file.md || {};
  const hd = file.hd || {};
  const preview = file.preview || {};
  const url = firstKlipyUrl(sm.webp, sm.gif, sm.mp4, sm.webm, sm.png, sm.jpg, sm.jpeg, md.webp, md.gif, md.mp4, md.webm, md.png, md.jpg, md.jpeg, hd.webp, hd.gif, hd.mp4, hd.webm, hd.png, hd.jpg, hd.jpeg, preview.webp, preview.gif, preview.mp4, preview.webm, preview.png, preview.jpg, preview.jpeg);
  const previewUrl = firstKlipyUrl(xs.webp, xs.gif, xs.mp4, xs.webm, xs.png, xs.jpg, xs.jpeg, preview.webp, preview.gif, preview.mp4, preview.webm, preview.png, preview.jpg, preview.jpeg, sm.webp, sm.gif, sm.mp4, sm.webm, sm.png, sm.jpg, sm.jpeg) || url;
  const title = String(item && (item.title || (item.ad && item.ad.title) || item.slug || (item.type === "ad" && "Sponsored")) || "Movie-night sticker").trim().slice(0, 80);
  return { id: String(item && (item.id || item.slug) || index), slug: String(item && item.slug || ""), title: title, url: url, previewUrl: previewUrl };
}

function klipyStickerResults(payload) {
  const candidates = [
    payload && payload.result && payload.result.data && payload.result.data.data,
    payload && payload.result && payload.result.data,
    payload && payload.data && payload.data.data,
    payload && payload.data,
  ];
  return candidates.find(Array.isArray) || [];
}

function trackKlipyShare(sticker, query) {
  if (!state.klipyAppKey || !sticker.slug) return;
  const url = "https://api.klipy.com/api/v1/" + encodeURIComponent(state.klipyAppKey) + "/stickers/share/" + encodeURIComponent(sticker.slug);
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ customer_id: state.userId, q: query || "" }),
    keepalive: true,
  }).catch(function () { /* Sharing the chat message should not depend on analytics. */ });
}

function renderKlipyStickers(items, query) {
  ui.stickerGrid.replaceChildren();
  if (!items.length) {
    setKlipyStickerStatus(query ? "No stickers came up. Try another search." : "No trending stickers are available right now.", "empty");
    return;
  }
  setKlipyStickerStatus(items.length + " stickers · Select one to send it to everyone.");
  items.forEach(function (item, index) {
    const sticker = klipyStickerFromResult(item, index);
    const button = makeElement("button", "sticker-choice klipy-sticker-choice");
    button.type = "button";
    button.title = sticker.url ? "Send “" + sticker.title + "”" : sticker.title;
    button.setAttribute("aria-label", sticker.url ? "Send sticker: " + sticker.title : sticker.title + " preview unavailable");
    button.disabled = !sticker.url;
    if (sticker.previewUrl) {
      button.append(klipyMediaElement(sticker.previewUrl, "klipy-sticker-thumb", ""));
    } else {
      button.append(makeElement("span", "klipy-sticker-unavailable", "Preview unavailable"));
    }
    button.append(makeElement("span", "sticker-choice-label", sticker.title));
    button.addEventListener("click", function () {
      const message = encodeKlipyStickerMessage(sticker);
      if (message.length > 500) {
        showToast("This sticker link is too long to share in chat.");
        return;
      }
      if (sendAction("chat", { text: message })) {
        trackKlipyShare(sticker, query);
        closeChatPicker();
      }
    });
    ui.stickerGrid.append(button);
  });
}

async function loadKlipyStickers(query) {
  const search = String(query || "").trim().slice(0, 80);
  const requestId = ++state.klipySearchSequence;
  ui.stickerGrid.replaceChildren();
  if (!state.klipyAppKey) {
    setKlipyStickerStatus("Live stickers need a KLIPY app key in the server settings.", "setup");
    return;
  }
  setKlipyStickerStatus("Finding movie-night stickers…", "loading");
  const endpoint = "https://api.klipy.com/api/v1/" + encodeURIComponent(state.klipyAppKey) + "/stickers/" + (search ? "search" : "trending");
  const localeMatch = String(navigator.language || "en-US").match(/-([a-z]{2})$/i);
  const locale = localeMatch ? localeMatch[1].toLowerCase() : "us";
  const params = new URLSearchParams({ page: "1", per_page: "20", locale: locale, content_filter: "high", customer_id: state.userId || "guest" });
  if (search) params.set("q", search);
  try {
    const response = await fetch(endpoint + "?" + params.toString(), { headers: { Accept: "application/json" } });
    const payload = await response.json().catch(function () { return {}; });
    if (requestId !== state.klipySearchSequence) return;
    if (!response.ok) {
      const message = response.status === 401 || response.status === 403 ? "KLIPY did not accept the app key. Check the server setting." :
        response.status === 429 ? "KLIPY is limiting requests. Wait a moment and try again." : "KLIPY stickers could not be loaded. Try again shortly.";
      setKlipyStickerStatus(message, "error");
      return;
    }
    renderKlipyStickers(klipyStickerResults(payload), search);
  } catch (_) {
    if (requestId === state.klipySearchSequence) setKlipyStickerStatus("Could not reach KLIPY. Check your connection and try again.", "error");
  }
}

function renderStickerPicker(query) {
  loadKlipyStickers(query === undefined ? ui.klipyStickerSearch.value : query);
}

function scheduleKlipyStickerSearch(query) {
  window.clearTimeout(state.klipySearchTimer);
  setKlipyStickerStatus("Search movie reactions, plot twists, and more…");
  state.klipySearchTimer = window.setTimeout(function () { loadKlipyStickers(query); }, 320);
}

function insertEmojiAtCursor(emoji) {
  const input = ui.chatInput;
  const start = input.selectionStart === null ? input.value.length : input.selectionStart;
  const end = input.selectionEnd === null ? start : input.selectionEnd;
  input.setRangeText(emoji, start, end, "end");
  input.focus();
  hideEmojiAutocomplete();
  renderEmojiSuggestions();
}

function renderEmojiPicker(query) {
  const value = String(query || "").trim().toLowerCase();
  const matching = CHAT_EMOJIS.filter(function (item) {
    return !value || item[1].includes(value) || item[0].includes(value);
  });
  ui.emojiGrid.replaceChildren();
  matching.forEach(function (item) {
    const button = makeElement("button", "emoji-choice", item[0]);
    button.type = "button";
    button.title = item[1];
    button.setAttribute("aria-label", item[1]);
    button.addEventListener("click", function () { insertEmojiAtCursor(item[0]); });
    ui.emojiGrid.append(button);
  });
  if (!matching.length) ui.emojiGrid.append(makeElement("p", "picker-empty", "No emoji match that search."));
}

function setPickerTab(tab) {
  const selectedTab = tab === "stickers" ? "stickers" : "emoji";
  state.pickerTab = selectedTab;
  document.querySelectorAll("[data-picker-tab]").forEach(function (button) {
    const selected = button.dataset.pickerTab === selectedTab;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-selected", String(selected));
  });
  document.getElementById("emojiPickerPane").classList.toggle("hidden", selectedTab !== "emoji");
  document.getElementById("stickersPickerPane").classList.toggle("hidden", selectedTab !== "stickers");
  if (selectedTab === "emoji") ui.emojiSearch.focus();
  else renderStickerPicker();
}

function openChatPicker(tab) {
  ui.chatPicker.classList.remove("hidden");
  document.getElementById("chatPickerToggle").setAttribute("aria-expanded", "true");
  hideEmojiAutocomplete();
  renderEmojiPicker(ui.emojiSearch.value);
  setPickerTab(tab || state.pickerTab || "emoji");
}

function closeChatPicker(restoreFocus) {
  ui.chatPicker.classList.add("hidden");
  document.getElementById("chatPickerToggle").setAttribute("aria-expanded", "false");
  if (restoreFocus !== false) ui.chatInput.focus();
}

function hideEmojiAutocomplete() {
  ui.emojiAutocomplete.classList.add("hidden");
  state.emojiSuggestions = [];
  state.emojiSuggestionIndex = 0;
}

function renderEmojiSuggestions() {
  const input = ui.chatInput;
  const cursor = input.selectionStart === null ? input.value.length : input.selectionStart;
  const prefix = input.value.slice(0, cursor);
  const match = prefix.match(/:([a-z0-9_-]{2,})$/i);
  if (!match) { hideEmojiAutocomplete(); return; }
  const query = match[1].toLowerCase();
  const matching = CHAT_EMOJIS.filter(function (item) { return item[1].split(" ").some(function (word) { return word.startsWith(query); }); }).slice(0, 6);
  if (!matching.length) { hideEmojiAutocomplete(); return; }
  state.emojiSuggestions = matching;
  state.emojiSuggestionStart = cursor - match[0].length;
  state.emojiSuggestionIndex = Math.min(state.emojiSuggestionIndex, matching.length - 1);
  ui.emojiAutocomplete.replaceChildren();
  matching.forEach(function (item, index) {
    const button = makeElement("button", "emoji-suggestion" + (index === state.emojiSuggestionIndex ? " is-active" : ""));
    button.type = "button";
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", String(index === state.emojiSuggestionIndex));
    button.append(makeElement("span", "emoji-suggestion-glyph", item[0]), makeElement("span", "emoji-suggestion-name", ":" + item[1].split(" ")[0] + ":"));
    button.addEventListener("pointerdown", function (event) { event.preventDefault(); });
    button.addEventListener("click", function () { selectEmojiSuggestion(index); });
    ui.emojiAutocomplete.append(button);
  });
  ui.emojiAutocomplete.classList.remove("hidden");
}

function selectEmojiSuggestion(index) {
  const suggestion = state.emojiSuggestions[index];
  if (!suggestion) return;
  const input = ui.chatInput;
  const cursor = input.selectionStart === null ? input.value.length : input.selectionStart;
  const end = input.selectionEnd === null ? cursor : input.selectionEnd;
  input.setRangeText(suggestion[0] + " ", state.emojiSuggestionStart, end, "end");
  hideEmojiAutocomplete();
  input.focus();
}

function replaceKnownShortcodes(text) {
  const aliases = new Map();
  CHAT_EMOJIS.forEach(function (item) { aliases.set(item[1].split(" ")[0], item[0]); });
  return String(text || "").replace(/:([a-z0-9_-]+):/gi, function (token, name) { return aliases.get(name.toLowerCase()) || token; });
}

function safeTheme(theme) {
  const allowed = ["violet", "amber", "fern", "rose", "blue", "coral", "mint", "gold"];
  return allowed.includes(theme) ? theme : "violet";
}

function setProfileLabels() {
  const name = state.name || "Guest";
  document.getElementById("userNameLabel").textContent = name;
  document.getElementById("userAvatar").textContent = name.slice(0, 1).toUpperCase();
  document.getElementById("profileNameInput").value = name.startsWith("Guest ") ? "" : name;
  document.getElementById("accountUsernameInput").value = state.username || "";
  document.getElementById("accountPasswordInput").autocomplete = state.isGuest ? "new-password" : "current-password";
  const accountStatus = document.getElementById("accountStatus");
  const accountButtons = document.getElementById("accountGuestButtons");
  const logoutButton = document.getElementById("logoutButton");
  accountStatus.textContent = state.isGuest ?
    "Guest session · create an account to keep this identity on another device." :
    "Signed in as @" + state.username + " · your room identity is saved.";
  accountButtons.classList.toggle("hidden", !state.isGuest);
  logoutButton.classList.toggle("hidden", state.isGuest);
  if (window.AfterglowMedia) {
    window.AfterglowMedia.configure({ userId: state.userId, name: name, sendAction: sendAction, onToast: showToast });
  }
}

function applySessionUser(user) {
  const oldId = state.userId;
  state.userId = user.id;
  state.name = user.name;
  state.username = user.username || null;
  state.isGuest = Boolean(user.is_guest);
  setProfileLabels();
  if (oldId && oldId !== state.userId && state.room && state.socket) {
    if (window.AfterglowMedia) window.AfterglowMedia.disconnect();
    state.socket.close(1000, "Session identity changed");
  }
}

function showToast(message) {
  const toast = makeElement("div", "toast", message);
  ui.toastRegion.append(toast);
  window.setTimeout(function () { toast.remove(); }, 3200);
}

function setView(view) {
  const inRoom = view === "room" && Boolean(state.room);
  ui.lobby.classList.toggle("hidden", inRoom);
  ui.roomView.classList.toggle("hidden", !inRoom);
  document.getElementById("navDiscover").classList.toggle("is-active", !inRoom);
  document.getElementById("navRoom").classList.toggle("is-active", inRoom);
  if (inRoom) renderRoom();
  else window.scrollTo({ top: 0, behavior: "smooth" });
}

function openProfileDialog() {
  setProfileLabels();
  document.getElementById("profileDialog").showModal();
  document.getElementById("profileNameInput").focus();
}

async function saveProfile() {
  const name = document.getElementById("profileNameInput").value.trim().replace(/\s+/g, " ");
  if (!name) {
    showToast("Add a display name so friends know it's you.");
    document.getElementById("profileNameInput").focus();
    return;
  }
  try {
    const result = await api("/api/profile", { method: "PATCH", body: JSON.stringify({ name: name.slice(0, 28) }) });
    applySessionUser(result.user);
    document.getElementById("profileDialog").close();
    if (state.room && state.socket && state.socket.readyState === WebSocket.OPEN) {
      sendAction("member.rename", {});
    }
  } catch (error) {
    showToast(error.message);
  }
}

async function createAccount() {
  const credentials = readAccountCredentials();
  if (!credentials) return;
  try {
    const result = await api("/api/auth/register", { method: "POST", body: JSON.stringify(credentials) });
    applySessionUser(result.user);
    document.getElementById("accountPasswordInput").value = "";
    showToast("Account created. This identity is saved for your next visit.");
  } catch (error) { showToast(error.message); }
}

async function signIn() {
  const credentials = readAccountCredentials();
  if (!credentials) return;
  try {
    const result = await api("/api/auth/login", { method: "POST", body: JSON.stringify(credentials) });
    applySessionUser(result.user);
    document.getElementById("accountPasswordInput").value = "";
    showToast("Signed in as @" + result.user.username + ".");
  } catch (error) { showToast(error.message); }
}

function readAccountCredentials() {
  const username = document.getElementById("accountUsernameInput").value.trim();
  const password = document.getElementById("accountPasswordInput").value;
  if (!username || !password) {
    showToast("Enter a username and password first.");
    return null;
  }
  return { username: username, password: password };
}

async function signOut() {
  try {
    const result = await api("/api/auth/logout", { method: "POST", body: "{}" });
    applySessionUser(result.user);
    document.getElementById("accountUsernameInput").value = "";
    document.getElementById("accountPasswordInput").value = "";
    showToast("Signed out. You are using a guest session now.");
  } catch (error) { showToast(error.message); }
}

async function api(path, options) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const result = await response.json().catch(function () { return {}; });
  if (!response.ok) throw new Error(result.detail || "The request could not be completed.");
  return result;
}

function updateCatalogStatus(message, active) {
  ui.catalogStatus.replaceChildren();
  const dot = makeElement("span", "catalog-status-dot");
  const label = makeElement("span", "", message);
  if (active) dot.style.background = "var(--pink)";
  ui.catalogStatus.append(dot, label);
}

async function loadCatalog() {
  const query = ui.search.value.trim();
  const genre = ui.genre.value;
  const category = ui.category.value;
  const roomCode = state.room ? state.room.code : "";
  updateCatalogStatus(query ? "Looking for the closest title match…" : "A few good options for the group.", true);
  const params = new URLSearchParams({ query: query, genre: genre, category: category });
  if (roomCode) params.set("room_code", roomCode);
  try {
    const result = await api("/api/catalog?" + params.toString());
    state.catalog = result.movies || [];
    renderMovieCards(state.catalog);
    updateCatalogStatus(
      result.source === "OMDb" ? "OMDb posters and IMDb ratings · group votes shape tonight's picks." :
        result.source === "saved catalog" ? "Using saved movie metadata while the catalog reconnects." :
          "Offline picks · add a free OMDb key for real posters and IMDb ratings · group votes shape picks.",
      false
    );
    const attribution = document.getElementById("catalogAttribution");
    if (result.attribution) {
      attribution.classList.remove("hidden");
      attribution.replaceChildren(document.createTextNode(result.attribution + " "));
      const link = document.createElement("a");
      link.href = "https://www.omdbapi.com/";
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.setAttribute("aria-label", "OMDb API");
      link.textContent = "OMDb";
      attribution.append(link);
    } else {
      attribution.classList.add("hidden");
    }
    if (result.api_error) showToast(result.api_error);
  } catch (error) {
    updateCatalogStatus("The catalog could not load. Try again in a moment.", false);
    ui.movieGrid.replaceChildren(makeElement("div", "no-results", error.message));
  }
}

function posterElement(movie, className) {
  const isFilmPoster = !className || className === "movie-poster";
  const poster = makeElement(
    "div",
    (className || "movie-poster") + " movie-poster-theme-" + safeTheme(movie.poster_theme) + (isFilmPoster ? "" : " poster-mini")
  );
  if (movie.poster_path) {
    let backdrop = null;
    if (isFilmPoster) {
      poster.classList.add("has-poster");
      backdrop = document.createElement("img");
      backdrop.className = "poster-backdrop";
      backdrop.alt = "";
      backdrop.setAttribute("aria-hidden", "true");
      backdrop.loading = "lazy";
      backdrop.decoding = "async";
      backdrop.referrerPolicy = "no-referrer";
      backdrop.addEventListener("error", function () { backdrop.remove(); }, { once: true });
    }

    const image = document.createElement("img");
    if (isFilmPoster) image.className = "poster-art";
    image.alt = "";
    image.loading = "lazy";
    image.decoding = "async";
    image.referrerPolicy = "no-referrer";
    image.addEventListener("error", function () {
      if (backdrop) backdrop.remove();
      image.remove();
      if (isFilmPoster) poster.classList.remove("has-poster");
      if (isFilmPoster && !poster.querySelector(".poster-kicker")) {
        poster.append(makeElement("span", "poster-kicker", movie.genre_names && movie.genre_names[0] ? movie.genre_names[0] : "NIGHT PICK"));
      }
    }, { once: true });
    if (backdrop) {
      poster.append(backdrop);
      backdrop.src = movie.poster_path;
    }
    poster.append(image);
    image.src = movie.poster_path;
  } else if (isFilmPoster) {
    poster.append(makeElement("span", "poster-kicker", movie.genre_names && movie.genre_names[0] ? movie.genre_names[0] : "NIGHT PICK"));
  }
  return poster;
}

function addMovieToRoom(movie) {
  if (!state.room) {
    state.pendingAction = { type: "playlist.add", movie: movie };
    createRoom(false);
    return;
  }
  sendAction("playlist.add", { movie: movie });
  showToast("Added to tonight's queue.");
}

function startMovieInRoom(movie) {
  if (!state.room) {
    state.pendingMovie = movie;
    createRoom(false);
    return;
  }
  openVideoDialog(movie);
}

function renderMovieCards(movies) {
  ui.movieGrid.replaceChildren();
  if (!movies || !movies.length) {
    ui.movieGrid.append(makeElement("div", "no-results", "No close matches yet. Try a shorter title or another genre."));
    return;
  }
  movies.forEach(function (movie) {
    const card = makeElement("article", "movie-card");
    card.append(posterElement(movie, "movie-poster"));
    const copy = makeElement("div", "movie-copy");
    const year = movie.year ? String(movie.year) : "A GOOD STARTING POINT";
    const rating = Number(movie.imdb_rating || movie.vote_average);
    const yearAndRating = Number.isFinite(rating) && rating > 0 ?
      year + " · IMDb ★ " + rating.toFixed(1) : year;
    copy.append(makeElement("span", "movie-year", yearAndRating));
    copy.append(makeElement("h3", "movie-title", movie.title));
    const genres = makeElement("div", "movie-meta");
    (movie.genre_names || []).slice(0, 2).forEach(function (genre) {
      genres.append(makeElement("span", "genre-chip", genre));
    });
    copy.append(genres);
    copy.append(makeElement("p", "movie-reason", movie.recommendation_reason || movie.overview || "A film to put on the shortlist."));
    const lookupLinks = makeElement("div", "movie-source-links");
    const lookupQuery = encodeURIComponent((movie.title + " " + (movie.year || "")).trim());
    const imdbLink = makeElement("a", "", "IMDb ↗");
    imdbLink.href = movie.imdb_id ?
      "https://www.imdb.com/title/" + encodeURIComponent(movie.imdb_id) + "/" :
      "https://www.imdb.com/find/?q=" + lookupQuery;
    imdbLink.target = "_blank";
    imdbLink.rel = "noopener noreferrer";
    imdbLink.setAttribute("aria-label", "Look up " + movie.title + " on IMDb");
    const moctaleLink = makeElement("a", "", "Moctale ↗");
    moctaleLink.href = "https://www.google.com/search?q=" + encodeURIComponent("site:moctale.in/content " + movie.title + " " + (movie.year || ""));
    moctaleLink.target = "_blank";
    moctaleLink.rel = "noopener noreferrer";
    moctaleLink.setAttribute("aria-label", "Find " + movie.title + " on Moctale");
    lookupLinks.append(imdbLink, moctaleLink);
    const actions = makeElement("div", "movie-card-actions");
    const queueButton = makeElement("button", "", "＋ Queue");
    queueButton.type = "button";
    queueButton.addEventListener("click", function () { addMovieToRoom(movie); });
    const watchButton = makeElement("button", "movie-detail-button", "Watch →");
    watchButton.type = "button";
    watchButton.addEventListener("click", function () { startMovieInRoom(movie); });
    actions.append(queueButton, watchButton);
    copy.append(lookupLinks, actions);
    card.append(copy);
    ui.movieGrid.append(card);
  });
}

async function createRoom(demo) {
  const button = demo ? document.getElementById("tryDemoButton") : document.getElementById("createRoomButton");
  button.disabled = true;
  try {
    const result = await api("/api/rooms", {
      method: "POST",
      body: JSON.stringify({
        demo: Boolean(demo),
        title: demo ? "Sample clip" : "Friday movie night",
      }),
    });
    await enterRoom(result.room.code, result.room);
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
}

async function joinRoom(code) {
  const normalized = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (normalized.length < 4) {
    showToast("That room code looks a little short.");
    return;
  }
  try {
    const result = await api("/api/rooms/" + encodeURIComponent(normalized));
    await enterRoom(normalized, result.room);
  } catch (error) {
    showToast(error.message);
  }
}

async function enterRoom(code, initialRoom) {
  if (window.AfterglowMedia && state.room && state.room.code !== code) window.AfterglowMedia.disconnect();
  state.room = initialRoom || null;
  state.lastVersion = 0;
  setView("room");
  const nextUrl = new URL(window.location.href);
  nextUrl.searchParams.set("room", code);
  history.replaceState({}, "", nextUrl.pathname + nextUrl.search);
  try {
    const result = await api("/api/rooms/" + encodeURIComponent(code));
    receiveSnapshot(result.room);
    connectToRoom(code);
  } catch (error) {
    state.room = null;
    setView("lobby");
    showToast(error.message);
  }
}

function connectToRoom(code) {
  if (state.socket && state.socket.readyState === WebSocket.OPEN) state.socket.close();
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const socketUrl = protocol + "//" + window.location.host + "/ws/rooms/" + encodeURIComponent(code);
  const socket = new WebSocket(socketUrl);
  state.socket = socket;
  if (window.AfterglowMedia) window.AfterglowMedia.setSocket(socket);
  socket.addEventListener("open", function () {
    window.clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
    socket.send(JSON.stringify({ type: "ping", client_time: Date.now() }));
    document.getElementById("syncLabel").textContent = "Room is live";
    if (state.pendingAction) {
      sendAction(state.pendingAction.type, { movie: state.pendingAction.movie });
      state.pendingAction = null;
    }
    if (state.pendingMovie) {
      const movie = state.pendingMovie;
      state.pendingMovie = null;
      if (!ui.videoDialog.open) openVideoDialog(movie);
    }
  });
  socket.addEventListener("message", function (event) {
    let message;
    try { message = JSON.parse(event.data); } catch (_) { return; }
    if (message.type === "pong") {
      const sentAt = Number(message.client_time || Date.now());
      state.serverOffset = Number(message.server_time) * 1000 - ((sentAt + Date.now()) / 2);
    } else if (message.type === "snapshot" && message.room) {
      recordActionAcknowledgement(message.action_id, { ok: true });
      if (Number(message.room.version) >= state.lastVersion) receiveSnapshot(message.room);
    } else if (message.type === "room.ended") {
      returnToLobby(message.message || "The host ended this room.");
    } else if (message.type === "rtc.signal") {
      if (window.AfterglowMedia) window.AfterglowMedia.handleSignal(message);
    } else if (message.type === "error") {
      recordActionAcknowledgement(message.action_id, { ok: false, message: message.message || "The room rejected that change." });
      showToast(message.message || "That room action did not go through.");
      if (message.action_id && message.action_id === state.waitingMovieActionId && ui.videoDialog.open) {
        const error = document.getElementById("videoFormError");
        error.textContent = message.message || "The room rejected that stream.";
        error.classList.remove("hidden");
      }
      if (window.AfterglowMedia) window.AfterglowMedia.handleServerError(message.message || "");
    }
  });
  socket.addEventListener("close", function (event) {
    if ((event.code === 4001 || event.code === 4404) && state.socket === socket && state.room) {
      returnToLobby(event.code === 4001 ? "The host ended this room." : "This room is no longer available.");
      return;
    }
    if (state.socket !== socket || !state.room) return;
    document.getElementById("syncLabel").textContent = "Reconnecting…";
    ui.syncIndicator.classList.add("is-waiting");
    window.clearTimeout(state.reconnectTimer);
    state.reconnectTimer = window.setTimeout(function () {
      state.reconnectTimer = null;
      if (state.room) connectToRoom(state.room.code);
    }, 1600);
  });
  socket.addEventListener("error", function () {
    document.getElementById("syncLabel").textContent = "Connection interrupted";
  });
}

function receiveSnapshot(room) {
  room = {
    ...room,
    current_movie: room.current_movie && LEGACY_DEMO_VIDEO_IDS.includes(room.current_movie.id) ?
      { ...room.current_movie, ...DEMO_SAMPLE_VIDEO } : room.current_movie,
  };
  const previousPlayback = state.room && state.room.playback;
  const nextPlayback = room.playback;
  if (nextPlayback && (!previousPlayback ||
      previousPlayback.is_playing !== nextPlayback.is_playing ||
      previousPlayback.updated_at !== nextPlayback.updated_at)) {
    // A host play, pause, or seek is authoritative, so apply it immediately.
    state.lastYouTubeCorrectionAt = 0;
  }
  state.room = room;
  state.lastVersion = Number(room.version || 0);
  renderRoom();
  if (window.AfterglowMedia) window.AfterglowMedia.syncRoom(state.room);
  if (ui.lobby.classList.contains("hidden")) loadCatalogDebounced(80);
}

function sendAction(type, payload) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
    showToast("Room is reconnecting. Try that again in a moment.");
    return false;
  }
  state.actionCounter += 1;
  const actionId = state.userId.slice(0, 6) + "-" + Date.now().toString(36) + "-" + state.actionCounter;
  try {
    state.socket.send(JSON.stringify({ type: type, action_id: actionId, ...(payload || {}) }));
    return actionId;
  } catch (_) {
    showToast("Room is reconnecting. Try that again in a moment.");
    return false;
  }
}

function recordActionAcknowledgement(actionId, result) {
  if (!actionId) return;
  state.actionAcknowledgements.set(String(actionId), result);
  while (state.actionAcknowledgements.size > 64) {
    state.actionAcknowledgements.delete(state.actionAcknowledgements.keys().next().value);
  }
}

function waitForActionAcknowledgement(actionId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise(function (resolve) {
    function checkAcknowledgement() {
      const result = state.actionAcknowledgements.get(actionId);
      if (result) {
        state.actionAcknowledgements.delete(actionId);
        resolve(result);
        return;
      }
      if (Date.now() >= deadline) {
        resolve({ ok: false, message: "The room did not confirm the stream change. Please try again." });
        return;
      }
      window.setTimeout(checkAcknowledgement, 100);
    }
    checkAcknowledgement();
  });
}

function waitForRoomSocket(timeoutMs) {
  const roomCode = state.room && state.room.code;
  if (!roomCode) return Promise.resolve(false);
  const deadline = Date.now() + timeoutMs;
  return new Promise(function (resolve) {
    function checkConnection() {
      if (!state.room || state.room.code !== roomCode) {
        resolve(false);
        return;
      }
      if (state.socket && state.socket.readyState === WebSocket.OPEN) {
        resolve(true);
        return;
      }
      if ((!state.socket || state.socket.readyState === WebSocket.CLOSED) && state.reconnectTimer === null) {
        try { connectToRoom(roomCode); } catch (_) { /* Try again until the connection timeout. */ }
      }
      if (Date.now() >= deadline) {
        resolve(false);
        return;
      }
      window.setTimeout(checkConnection, 100);
    }
    checkConnection();
  });
}

function movieSource(movie) {
  return movie && movie.source_url ? movie.source_url : "";
}

function movieKind(movie) {
  return movie && movie.source_kind ? movie.source_kind : "url";
}

function loadYouTubeApi() {
  if (window.YT && window.YT.Player) return Promise.resolve();
  if (state.youtubeApiPromise) return state.youtubeApiPromise;
  state.youtubeApiPromise = new Promise(function (resolve, reject) {
    const timeout = window.setTimeout(function () { reject(new Error("YouTube player did not load.")); }, 15000);
    window.onYouTubeIframeAPIReady = function () {
      window.clearTimeout(timeout);
      resolve();
    };
    let script = document.getElementById("youtube-iframe-api");
    if (!script) {
      script = document.createElement("script");
      script.id = "youtube-iframe-api";
      script.src = "https://www.youtube.com/iframe_api";
      script.async = true;
      script.onerror = function () {
        window.clearTimeout(timeout);
        reject(new Error("YouTube player could not connect."));
      };
      document.head.append(script);
    }
  });
  return state.youtubeApiPromise;
}

function parseYouTubeId(value) {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    let id = "";
    if (host === "youtu.be") id = parsed.pathname.split("/").filter(Boolean)[0] || "";
    else if (["youtube.com", "m.youtube.com", "music.youtube.com", "youtube-nocookie.com"].includes(host)) {
      id = parsed.searchParams.get("v") || parsed.pathname.match(/^\/(?:embed|shorts|live)\/([^/?]+)/)?.[1] || "";
    }
    return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : "";
  } catch (_) { return ""; }
}

function clearYouTubePlayer() {
  if (state.youtubePlayer) {
    try { state.youtubePlayer.destroy(); } catch (_) { /* The API may still be loading. */ }
  }
  state.youtubePlayer = null;
  state.youtubeReady = false;
  state.lastYouTubeCorrectionAt = 0;
  resetYouTubeBufferWatch();
  ui.youtubeContainer.replaceChildren();
  const mount = makeElement("div", "", null);
  mount.id = "youtubePlayerMount";
  ui.youtubeContainer.append(mount);
}

function readYouTubeBufferProgress(player) {
  let fraction = 0;
  let position = 0;
  try { fraction = Number(player.getVideoLoadedFraction()) || 0; } catch (_) { /* API not ready yet. */ }
  try { position = Number(player.getCurrentTime()) || 0; } catch (_) { /* API not ready yet. */ }
  return { fraction: fraction, position: position };
}

function startYouTubeBufferWatch(player) {
  if (state.youtubeBufferingSince) return;
  const now = Date.now();
  const progress = readYouTubeBufferProgress(player);
  state.youtubeBufferingSince = now;
  state.youtubeBufferProgressAt = now;
  state.youtubeLastBufferedFraction = progress.fraction;
  state.youtubeLastBufferTime = progress.position;
  state.youtubeRecoveryAttempts = 0;
  state.youtubeRecoveryAttemptAt = 0;
}

function resetYouTubeBufferWatch() {
  state.youtubeBufferingSince = 0;
  state.youtubeBufferProgressAt = 0;
  state.youtubeLastBufferedFraction = 0;
  state.youtubeLastBufferTime = 0;
  state.youtubeRecoveryAttempts = 0;
  state.youtubeRecoveryAttemptAt = 0;
}

function updateYouTubeBufferWatch(player, now) {
  startYouTubeBufferWatch(player);
  const progress = readYouTubeBufferProgress(player);
  if (progress.fraction > state.youtubeLastBufferedFraction + 0.002 || progress.position > state.youtubeLastBufferTime + 0.2) {
    state.youtubeBufferProgressAt = now;
  }
  state.youtubeLastBufferedFraction = progress.fraction;
  state.youtubeLastBufferTime = progress.position;

  const bufferingFor = now - state.youtubeBufferingSince;
  const stalledFor = now - state.youtubeBufferProgressAt;
  if (stalledFor >= YOUTUBE_BUFFER_STALL_MS && state.youtubeRecoveryAttempts === 0) {
    state.youtubeRecoveryAttempts = 1;
    state.youtubeRecoveryAttemptAt = now;
    state.applyingPlaybackUntil = now + 1500;
    setSyncStatus("waiting", "Buffer stalled · trying one gentle resume");
    try { player.playVideo(); } catch (_) { /* Leave recovery to YouTube if the player is closing. */ }
    return;
  }
  if (state.youtubeRecoveryAttempts > 0 && now - state.youtubeRecoveryAttemptAt >= YOUTUBE_BUFFER_STALL_MS && stalledFor >= YOUTUBE_BUFFER_STALL_MS) {
    setSyncStatus("waiting", "Still buffering · try YouTube Settings → Quality or check the connection");
    return;
  }
  setSyncStatus("waiting", "YouTube buffering · " + Math.floor(bufferingFor / 1000) + "s");
}

function loadYouTubeMovie(videoId) {
  if (state.youtubePlayer && state.youtubeId === videoId) {
    if (state.youtubeReady) state.youtubePlayer.cueVideoById(videoId);
    return;
  }
  state.youtubeId = videoId;
  clearYouTubePlayer();
  loadYouTubeApi().then(function () {
    if (!state.room || movieKind(state.room.current_movie) !== "youtube" || parseYouTubeId(movieSource(state.room.current_movie)) !== videoId) return;
    state.youtubePlayer = new window.YT.Player("youtubePlayerMount", {
      width: "100%",
      height: "100%",
      videoId: videoId,
      playerVars: { controls: 1, playsinline: 1, rel: 0, enablejsapi: 1, origin: window.location.origin },
      events: {
        onReady: function (event) {
          state.youtubeReady = true;
          const duration = event.target.getDuration();
          ui.seek.max = String(duration || 100);
          ui.timeTotal.textContent = formatTime(duration);
          applyPlayback(serverPlaybackPosition());
        },
        onStateChange: function (event) {
          if (!state.room) return;
          if (event.data === window.YT.PlayerState.BUFFERING) {
            if (state.room.playback.is_playing) updateYouTubeBufferWatch(event.target, Date.now());
            return;
          }
          if (event.data === window.YT.PlayerState.PLAYING || event.data === window.YT.PlayerState.PAUSED || event.data === window.YT.PlayerState.ENDED) {
            resetYouTubeBufferWatch();
          }
          if (Date.now() < state.applyingPlaybackUntil) return;
          if (!roomIsHost()) {
            if (![window.YT.PlayerState.PLAYING, window.YT.PlayerState.PAUSED, window.YT.PlayerState.ENDED, window.YT.PlayerState.CUED].includes(event.data)) return;
            window.setTimeout(function () { applyPlayback(serverPlaybackPosition()); }, 150);
            return;
          }
          const current = state.youtubePlayer && state.youtubePlayer.getCurrentTime ? state.youtubePlayer.getCurrentTime() : 0;
          if (event.data === window.YT.PlayerState.PLAYING && !state.room.playback.is_playing) sendAction("play", { position: current });
          if ((event.data === window.YT.PlayerState.PAUSED || event.data === window.YT.PlayerState.ENDED) && state.room.playback.is_playing) sendAction("pause", { position: current });
        },
        onError: function () {
          resetYouTubeBufferWatch();
          setSyncStatus("waiting", "This YouTube video cannot be embedded");
          showToast("That video may have embedding disabled or be unavailable in your region.");
        },
      },
    });
  }).catch(function () {
    setSyncStatus("waiting", "YouTube player unavailable");
    showToast("YouTube could not be loaded. Check the network and try again.");
  });
}

function roomIsHost() {
  return Boolean(state.room && state.room.host_id === state.userId);
}

function renderRoom() {
  if (!state.room) return;
  document.getElementById("roomTitle").textContent = state.room.title || "Screening room";
  document.getElementById("roomCodeLabel").textContent = state.room.code;
  document.getElementById("roomFooterCode").textContent = state.room.code;
  const onlineMembers = (state.room.members || []).filter(function (member) { return member.connected; });
  document.getElementById("memberCount").textContent = onlineMembers.length + (onlineMembers.length === 1 ? " person here" : " people here");
  document.getElementById("peopleTabCount").textContent = String(onlineMembers.length);
  document.getElementById("hostPill").classList.toggle("hidden", !roomIsHost());
  document.getElementById("endRoomButton").classList.toggle("hidden", !roomIsHost());
  document.getElementById("leaveRoomButton").classList.toggle("hidden", roomIsHost());
  document.getElementById("controlHostNote").textContent = roomIsHost() ? "You have the remote" : "Only the host steers playback";
  renderCurrentMovie();
  renderPlaylist();
  renderChat();
  renderPeople();
  renderPoll();
  if (state.activeTab === "people") setActivityTab("people", false);
  else setActivityTab("chat", false);
}

function renderCurrentMovie() {
  const movie = state.room.current_movie;
  const source = movieSource(movie);
  const kind = movieKind(movie);
  const hasSource = Boolean(source);
  const playerKind = ["url", "file", "youtube"].includes(kind);
  const title = movie ? movie.title : "The seats are yours.";
  document.getElementById("screeningTitle").textContent = title;
  document.getElementById("screeningSubtitle").textContent = movie ?
    (movie.source_label || "Shared video") + (kind === "browser" ? " · the page is shared by URL." : " · the video streams from its source; the room shares playback timing.") :
    "Choose a film, then gather everyone around the same moment.";
  document.getElementById("queueNowTitle").textContent = movie ? movie.title : "Nothing is playing yet";
  document.getElementById("queueNowNote").textContent = movie ?
    (movie.year ? String(movie.year) + " · " : "") + (movie.source_label || "Loaded for the room") :
    "Choose a film or load a video link.";
  ui.emptyScreen.classList.toggle("has-video", hasSource);
  ui.videoError.classList.add("hidden");
  document.getElementById("sampleLabel").classList.toggle("hidden", !(movie && (movie.id === DEMO_SAMPLE_VIDEO.id || LEGACY_DEMO_VIDEO_IDS.includes(movie.id))));
  ui.playPauseButton.disabled = !hasSource || !playerKind || !roomIsHost();
  ui.seek.disabled = !hasSource || !playerKind || !roomIsHost();
  document.getElementById("changeVideoButton").disabled = !roomIsHost();
  document.getElementById("loadVideoButton").disabled = !roomIsHost();
  if (!hasSource) {
    if (state.activeSource) {
      ui.video.pause();
      ui.video.removeAttribute("src");
      ui.video.load();
      ui.video.classList.remove("hidden");
      ui.youtubeContainer.classList.add("hidden");
      ui.browserPreview.classList.add("hidden");
      ui.browserPreview.removeAttribute("src");
      clearYouTubePlayer();
      state.activeSource = "";
      state.activeKind = "";
    }
    ui.timeCurrent.textContent = "0:00";
    ui.timeTotal.textContent = "0:00";
    ui.seek.value = 0;
    setSyncStatus("waiting", "Waiting for a film");
    updatePlayPause(false);
    return;
  }
  if (state.activeSource !== source || state.activeKind !== kind) {
    const previousKind = state.activeKind;
    if (previousKind === "youtube" && state.youtubePlayer) {
      state.applyingPlaybackUntil = Date.now() + 1200;
      try { state.youtubePlayer.pauseVideo(); } catch (_) { /* The player may be closing. */ }
      clearYouTubePlayer();
    }
    state.activeSource = source;
    state.activeKind = kind;
    ui.video.pause();
    ui.video.classList.toggle("hidden", kind === "youtube" || kind === "browser");
    ui.youtubeContainer.classList.toggle("hidden", kind !== "youtube");
    ui.browserPreview.classList.toggle("hidden", kind !== "browser");
    ui.videoError.classList.add("hidden");
    if (kind !== "browser") ui.browserPreview.removeAttribute("src");
    if (kind === "youtube") {
      ui.video.removeAttribute("src");
      ui.video.load();
      const videoId = parseYouTubeId(source);
      if (videoId) loadYouTubeMovie(videoId);
      else {
        ui.videoError.classList.remove("hidden");
        setSyncStatus("waiting", "That YouTube link is not valid");
      }
    } else if (kind === "browser") {
      ui.video.removeAttribute("src");
      ui.video.load();
      ui.browserPreview.src = source;
      ui.browserPreview.onload = function () { setSyncStatus("synced", "Shared browser page · site allows embedding"); };
      ui.browserPreview.onerror = function () { setSyncStatus("waiting", "This site may block embedding"); };
      setSyncStatus("waiting", "Loading shared browser page…");
    } else {
      ui.youtubeContainer.classList.add("hidden");
      ui.browserPreview.classList.add("hidden");
      ui.browserPreview.removeAttribute("src");
      clearYouTubePlayer();
      ui.video.classList.remove("hidden");
      ui.video.src = source;
      ui.video.load();
      ui.video.addEventListener("loadedmetadata", onVideoMetadata, { once: true });
    }
  }
  if (kind === "browser") {
    ui.timeCurrent.textContent = "PAGE";
    ui.timeTotal.textContent = "SHARED";
    ui.seek.value = 0;
    setSyncStatus("synced", "Shared browser page · site allows embedding");
    updatePlayPause(false);
    return;
  }
  const target = serverPlaybackPosition();
  applyPlayback(target);
}

function serverPlaybackPosition() {
  const playback = state.room && state.room.playback;
  if (!playback) return 0;
  const serverNow = Date.now() + state.serverOffset;
  const elapsed = playback.is_playing ? Math.max(0, serverNow / 1000 - Number(playback.updated_at)) : 0;
  return Math.max(0, Number(playback.position) + elapsed);
}

function applyPlayback(target) {
  if (!state.room || !movieSource(state.room.current_movie)) return;
  const kind = movieKind(state.room.current_movie);
  if (kind === "browser") return;
  let current = Number(ui.video.currentTime) || 0;
  let duration = Number.isFinite(ui.video.duration) ? ui.video.duration : null;
  let ready = ui.video.readyState >= 1;
  let youtubeState = null;
  if (kind === "youtube") {
    if (!state.youtubeReady || !state.youtubePlayer) {
      setSyncStatus("waiting", "Loading YouTube player…");
      return;
    }
    current = Number(state.youtubePlayer.getCurrentTime()) || 0;
    duration = Number(state.youtubePlayer.getDuration()) || null;
    youtubeState = state.youtubePlayer.getPlayerState();
    ready = true;
  }
  if (kind === "youtube" && state.room.playback.is_playing && youtubeState === window.YT.PlayerState.BUFFERING) {
    updateYouTubeBufferWatch(state.youtubePlayer, Date.now());
    updatePlayPause(true);
    return;
  }
  const safeTarget = duration ? Math.min(target, Math.max(0, duration - 0.05)) : target;
  const drift = safeTarget - current;
  const correctionThreshold = kind === "youtube" ? YOUTUBE_DRIFT_THRESHOLD_SECONDS : 0.5;
  const youtubeCooldownElapsed = kind !== "youtube" || Date.now() - state.lastYouTubeCorrectionAt >= YOUTUBE_CORRECTION_COOLDOWN_MS;
  const youtubeCanSeek = kind !== "youtube" || youtubeState !== window.YT.PlayerState.BUFFERING;
  const needsCorrection = !state.draggedSeek && ready && Math.abs(drift) > correctionThreshold && youtubeCooldownElapsed && youtubeCanSeek;
  if (needsCorrection) {
    try {
      if (kind === "youtube") {
        state.youtubePlayer.seekTo(safeTarget, true);
        state.lastYouTubeCorrectionAt = Date.now();
      }
      else ui.video.currentTime = safeTarget;
      current = safeTarget;
      state.applyingPlaybackUntil = Date.now() + 1200;
    } catch (_) { /* Wait for media readiness before applying a seek. */ }
    setSyncStatus("correcting", "Correcting drift");
    window.setTimeout(function () {
      if (state.room && state.room.playback.is_playing) {
        if (state.activeKind === "youtube" && state.youtubePlayer && state.youtubePlayer.getPlayerState() === window.YT.PlayerState.BUFFERING) {
          updateYouTubeBufferWatch(state.youtubePlayer, Date.now());
          return;
        }
        const correctedDrift = Math.abs(serverPlaybackPosition() - getMediaTime());
        setSyncStatus("synced", "Synced · " + Math.round(correctedDrift * 1000) + " ms");
      } else if (state.room) {
        setSyncStatus("synced", "Room is paused");
      }
    }, 650);
  } else if (!ui.roomView.classList.contains("hidden")) {
    if (kind === "youtube" && state.room.playback.is_playing && Math.abs(drift) > correctionThreshold) {
      setSyncStatus("waiting", "Letting YouTube settle · " + Math.round(Math.abs(drift) * 1000) + " ms drift");
    } else if (state.room.playback.is_playing) setSyncStatus("synced", "Synced · " + Math.round(Math.abs(drift) * 1000) + " ms");
    else setSyncStatus("synced", "Room is paused");
  }

  state.applyingPlaybackUntil = Date.now() + 1200;
  if (state.room.playback.is_playing) {
    if (kind === "youtube") {
      if (youtubeState !== window.YT.PlayerState.PLAYING && youtubeState !== window.YT.PlayerState.BUFFERING) state.youtubePlayer.playVideo();
      ui.resumeButton.classList.add("hidden");
      updatePlayPause(true);
    } else {
      ui.video.play().then(function () {
        ui.resumeButton.classList.add("hidden");
        updatePlayPause(true);
      }).catch(function () {
        ui.resumeButton.classList.remove("hidden");
        updatePlayPause(false);
        setSyncStatus("waiting", "Tap to start this video");
      });
    }
  } else {
    if (kind === "youtube") state.youtubePlayer.pauseVideo();
    else ui.video.pause();
    ui.resumeButton.classList.add("hidden");
    updatePlayPause(false);
  }
}

function getMediaTime() {
  if (state.activeKind === "youtube" && state.youtubeReady && state.youtubePlayer) return Number(state.youtubePlayer.getCurrentTime()) || 0;
  return Number(ui.video.currentTime) || 0;
}

function setMediaTime(position) {
  if (state.activeKind === "youtube" && state.youtubeReady && state.youtubePlayer) state.youtubePlayer.seekTo(position, true);
  else ui.video.currentTime = position;
}

function onVideoMetadata() {
  if (!state.room) return;
  const duration = Number.isFinite(ui.video.duration) ? ui.video.duration : 0;
  ui.seek.max = String(duration || 100);
  ui.timeTotal.textContent = formatTime(duration);
  ui.emptyScreen.classList.add("has-video");
  applyPlayback(serverPlaybackPosition());
}

function setSyncStatus(mode, text) {
  ui.syncIndicator.classList.toggle("is-waiting", mode === "waiting");
  ui.syncIndicator.classList.toggle("is-correcting", mode === "correcting");
  document.getElementById("syncLabel").textContent = text;
}

function updatePlayPause(isPlaying) {
  document.getElementById("playPauseIcon").textContent = isPlaying ? "Ⅱ" : "▶";
  ui.playPauseButton.setAttribute("aria-label", isPlaying ? "Pause shared video" : "Play shared video");
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remaining = String(total % 60).padStart(2, "0");
  return hours ? String(hours) + ":" + String(minutes).padStart(2, "0") + ":" + remaining : String(minutes) + ":" + remaining;
}

function renderPlaylist() {
  const items = state.room.playlist || [];
  document.getElementById("queueCount").textContent = String(items.length);
  document.getElementById("queueEmpty").classList.toggle("hidden", items.length > 0);
  document.getElementById("createPollButton").disabled = items.length < 2 || Boolean(state.room.poll && !state.room.poll.closed);
  ui.playlist.replaceChildren();
  items.forEach(function (movie, index) {
    const row = makeElement("div", "queue-item");
    const thumb = posterElement(movie, "queue-thumb");
    const meta = makeElement("div", "queue-meta");
    meta.append(makeElement("strong", "", movie.title));
    meta.append(makeElement("small", "", (movie.year || "Shortlist") + " · added by " + (movie.added_by || "the room")));
    const actions = makeElement("div", "queue-actions");
    const up = makeElement("button", "", "↑");
    up.type = "button";
    up.title = "Move up";
    up.setAttribute("aria-label", "Move " + movie.title + " up");
    up.disabled = index === 0;
    up.addEventListener("click", function () { sendAction("playlist.move", { movie_id: movie.id, delta: -1 }); });
    const down = makeElement("button", "", "↓");
    down.type = "button";
    down.title = "Move down";
    down.setAttribute("aria-label", "Move " + movie.title + " down");
    down.disabled = index === items.length - 1;
    down.addEventListener("click", function () { sendAction("playlist.move", { movie_id: movie.id, delta: 1 }); });
    const remove = makeElement("button", "", "×");
    remove.type = "button";
    remove.title = "Remove from queue";
    remove.setAttribute("aria-label", "Remove " + movie.title + " from queue");
    remove.addEventListener("click", function () { sendAction("playlist.remove", { movie_id: movie.id }); });
    actions.append(up, down, remove);
    row.append(thumb, meta, actions);
    ui.playlist.append(row);
  });
}

function renderChat() {
  const messages = state.room.chat || [];
  const shouldStick = ui.chatMessages.scrollHeight - ui.chatMessages.scrollTop - ui.chatMessages.clientHeight < 45;
  ui.chatMessages.replaceChildren();
  if (!messages.length) {
    const prompt = makeElement("div", "chat-first-message");
    const icon = makeElement("span", "chat-empty-icon");
    icon.append(window.AfterglowIcons.create("messages", 19));
    prompt.append(icon, makeElement("strong", "chat-empty-title", "The opening credits haven't rolled."));
    prompt.append(makeElement("span", "chat-empty-copy", "Say hello, share a film pick, or send a sticker to get the conversation started."));
    ui.chatMessages.append(prompt);
  }
  messages.forEach(function (message) {
    const row = makeElement("article", "chat-message" + (message.reaction ? " is-reaction" : "") + (message.user_id === state.userId ? " is-own" : ""));
    const avatar = makeElement("span", "avatar", String(message.name || "G").slice(0, 1).toUpperCase());
    const content = makeElement("div", "chat-message-content");
    const head = makeElement("div", "chat-message-head");
    head.append(makeElement("strong", "", message.name || "Guest"));
    const time = new Date(Number(message.created_at || Date.now()) * 1000);
    const timestamp = time.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const timeElement = makeElement("time", "", timestamp);
    head.append(timeElement);
    content.append(head);
    const sticker = !message.reaction && decodeStickerMessage(message.text);
    if (sticker) content.append(createStickerElement(sticker));
    else content.append(makeElement("p", "chat-message-text", message.text || ""));
    row.append(avatar, content);
    ui.chatMessages.append(row);
  });
  if (shouldStick) ui.chatMessages.scrollTop = ui.chatMessages.scrollHeight;
  document.getElementById("chatUnread").classList.toggle("hidden", state.activeTab === "chat" || messages.length <= state.lastChatCount);
  state.lastChatCount = messages.length;
}

function renderPeople() {
  const members = state.room.members || [];
  const online = members.filter(function (member) { return member.connected; });
  document.getElementById("peopleHeadline").textContent = online.length === 1 ? "The first seat is taken." : "The best seats are together.";
  document.getElementById("peopleSubhead").textContent = online.length === 1 ? "Send the room link to your people." : online.length + " people are here for the show.";
  ui.memberList.replaceChildren();
  members.forEach(function (member) {
    const row = makeElement("div", "member-row" + (member.connected ? " is-online" : ""));
    const avatar = makeElement("span", "avatar", String(member.name || "G").slice(0, 1).toUpperCase());
    const name = makeElement("span", "member-name", member.name + (member.id === state.userId ? " (you)" : ""));
    row.append(avatar, name);
    if (member.id === state.room.host_id) row.append(makeElement("span", "member-role", "HOST"));
    else if (roomIsHost() && member.connected) {
      const transfer = makeElement("button", "host-transfer-button", "Make host");
      transfer.type = "button";
      transfer.addEventListener("click", function () {
        sendAction("host.transfer", { target_id: member.id });
        showToast(member.name + " has the remote.");
      });
      row.append(transfer);
    }
    ui.memberList.append(row);
  });
}

function renderPoll() {
  const poll = state.room.poll;
  const button = document.getElementById("createPollButton");
  if (!poll) {
    ui.pollCard.classList.add("hidden");
    button.classList.remove("hidden");
    return;
  }
  button.classList.add("hidden");
  ui.pollCard.classList.remove("hidden");
  ui.pollCard.replaceChildren();
  ui.pollCard.append(makeElement("h3", "", poll.title));
  const totalVotes = Object.keys(poll.votes || {}).length;
  ui.pollCard.append(makeElement("p", "poll-subline", poll.closed ? "Poll closed · " + totalVotes + (totalVotes === 1 ? " vote" : " votes") : "Vote for the next movie."));
  (poll.options || []).forEach(function (option) {
    const voteButton = makeElement("button", "poll-option" + (poll.votes && poll.votes[state.userId] === option.id ? " is-voted" : ""));
    voteButton.type = "button";
    voteButton.disabled = poll.closed;
    const percent = totalVotes ? Math.round((Number(option.votes || 0) / totalVotes) * 100) : 0;
    const meter = makeElement("span", "poll-meter");
    meter.style.width = percent + "%";
    voteButton.append(meter);
    voteButton.append(makeElement("span", "poll-option-text", option.title));
    voteButton.append(makeElement("span", "poll-votes", String(option.votes || 0)));
    if (!poll.closed) voteButton.addEventListener("click", function () { sendAction("poll.vote", { option_id: option.id }); });
    ui.pollCard.append(voteButton);
  });
  if (roomIsHost()) {
    const controls = makeElement("div", "poll-host-controls");
    if (!poll.closed) {
      const close = makeElement("button", "", "Close poll");
      close.type = "button";
      close.addEventListener("click", function () { sendAction("poll.close", {}); });
      controls.append(close);
    } else {
      const winner = (poll.options || []).slice().sort(function (a, b) { return Number(b.votes || 0) - Number(a.votes || 0); })[0];
      if (winner) {
        const play = makeElement("button", "", "Put the winner on screen");
        play.type = "button";
        play.addEventListener("click", function () { openVideoDialog(winner); });
        controls.append(play);
      }
      if ((state.room.playlist || []).length >= 2) {
        const again = makeElement("button", "", "Start another poll");
        again.type = "button";
        again.addEventListener("click", beginPoll);
        controls.append(again);
      }
    }
    if (controls.childElementCount) ui.pollCard.append(controls);
  }
}

function setActivityTab(tab, focusButton) {
  state.activeTab = tab;
  const chatSelected = tab === "chat";
  document.getElementById("chatTab").classList.toggle("is-selected", chatSelected);
  document.getElementById("chatTab").setAttribute("aria-selected", String(chatSelected));
  document.getElementById("peopleTab").classList.toggle("is-selected", !chatSelected);
  document.getElementById("peopleTab").setAttribute("aria-selected", String(!chatSelected));
  document.getElementById("chatPane").classList.toggle("hidden", !chatSelected);
  document.getElementById("peoplePane").classList.toggle("hidden", chatSelected);
  if (chatSelected) document.getElementById("chatUnread").classList.add("hidden");
  if (focusButton) (chatSelected ? document.getElementById("chatTab") : document.getElementById("peopleTab")).focus();
}

function setSourceMode(kind) {
  state.sourceMode = ["url", "youtube", "file", "browser"].includes(kind) ? kind : "url";
  ui.sourceModeGrid.querySelectorAll("[data-source-kind]").forEach(function (button) {
    const selected = button.dataset.sourceKind === state.sourceMode;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  const isFile = state.sourceMode === "file";
  ui.sourceUrlFields.classList.toggle("hidden", isFile);
  ui.sourceFileFields.classList.toggle("hidden", !isFile);
  const label = document.getElementById("videoUrlLabel");
  const hint = document.getElementById("videoDialogHint");
  if (state.sourceMode === "youtube") {
    label.textContent = "YOUTUBE VIDEO LINK";
    ui.videoUrl.placeholder = "https://youtu.be/xxxxxxxxxxx";
    hint.textContent = "The official YouTube player serves each viewer. Some videos disable embedding or are restricted by region.";
  } else if (state.sourceMode === "browser") {
    label.textContent = "WEBSITE LINK";
    ui.videoUrl.placeholder = "https://example.com/page";
    hint.textContent = "This is a shared embedded webpage, not a cloud browser. Many sites block embedding; use Share screen for those.";
  } else if (state.sourceMode === "file") {
    hint.textContent = "MP4 and WebM files up to 500 MB are uploaded to this app's server, then streamed to each participant. Only upload media you have permission to share.";
  } else {
    label.textContent = "DIRECT VIDEO FILE LINK";
    ui.videoUrl.placeholder = "https://example.com/your-film.mp4";
    hint.textContent = "Use an MP4 or WebM media URL that everyone can access. A movie or streaming-service page is not a direct video file.";
  }
}

function openVideoDialog(movie, requestedMode) {
  if (!state.room) return;
  if (!roomIsHost()) {
    showToast("Ask the host to change the shared film.");
    return;
  }
  const selected = movie || state.room.current_movie || {};
  state.videoDialogMovie = movie || state.room.current_movie || null;
  ui.videoTitle.value = selected.title || "";
  ui.videoUrl.value = selected.source_url || "";
  ui.videoFile.value = "";
  ui.uploadProgress.classList.add("hidden");
  setSourceMode(requestedMode || selected.source_kind || "url");
  document.getElementById("videoFormError").classList.add("hidden");
  const dialogTitle = document.getElementById("videoDialogTitle");
  dialogTitle.replaceChildren(document.createTextNode(movie ? "Put a film " : "Choose a "));
  const emphasis = makeElement("em", "", movie ? "on screen." : "stream.");
  dialogTitle.append(emphasis);
  document.getElementById("videoDialogCopy").textContent = movie ?
    "The movie catalog helps choose a title. Select where the actual stream will come from." :
    "Choose YouTube, a direct video URL, a file upload, or a webpage that allows embedding.";
  ui.videoDialog.showModal();
  ui.videoTitle.focus();
}

async function submitVideo() {
  const button = ui.submitVideoButton;
  const status = document.getElementById("videoSubmitStatus");
  const error = document.getElementById("videoFormError");
  if (button.disabled) return;
  button.disabled = true;
  button.dataset.idleLabel = button.dataset.idleLabel || button.firstChild.textContent;
  button.firstChild.textContent = "Loading into the room… ";
  button.setAttribute("aria-busy", "true");
  status.textContent = "Checking the stream details…";
  status.classList.remove("hidden");
  error.classList.add("hidden");
  try {
    await submitVideoForm();
  } catch (submissionError) {
    console.error("Unable to load the stream into the room", submissionError);
    error.textContent = submissionError && submissionError.message ? submissionError.message : "The stream could not be loaded. Please try again.";
    error.classList.remove("hidden");
  } finally {
    button.disabled = false;
    button.firstChild.textContent = button.dataset.idleLabel;
    button.removeAttribute("aria-busy");
    if (status.textContent === "Checking the stream details…") status.classList.add("hidden");
  }
}

async function submitVideoForm() {
  const title = ui.videoTitle.value.trim();
  const sourceUrl = ui.videoUrl.value.trim();
  const error = document.getElementById("videoFormError");
  const status = document.getElementById("videoSubmitStatus");
  const kind = state.sourceMode;
  error.classList.add("hidden");
  status.classList.add("hidden");
  if (!roomIsHost()) {
    error.textContent = "Only the room host can change the stream.";
    error.classList.remove("hidden");
    return;
  }
  let parsed;
  try { parsed = new URL(sourceUrl); } catch (_) { parsed = null; }
  if (!title) {
    error.textContent = "Add the title so the room knows what is on screen.";
    error.classList.remove("hidden");
    ui.videoTitle.focus();
    return;
  }
  let playableUrl = sourceUrl;
  let youtubeId = "";
  if (kind === "file") {
    const file = ui.videoFile.files && ui.videoFile.files[0];
    if (!file) {
      error.textContent = "Choose an MP4 or WebM file to upload.";
      error.classList.remove("hidden");
      ui.videoFile.focus();
      return;
    }
    if (file.size > 500 * 1024 * 1024 || !/\.(mp4|webm)$/i.test(file.name)) {
      error.textContent = "Choose an MP4 or WebM file that is 500 MB or smaller.";
      error.classList.remove("hidden");
      return;
    }
    ui.uploadProgress.classList.remove("hidden");
    ui.uploadProgressLabel.textContent = "Uploading " + file.name + "…";
    try {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch("/api/rooms/" + encodeURIComponent(state.room.code) + "/media", { method: "POST", body: form });
      const result = await response.json();
      if (!response.ok) throw new Error(result.detail || "The upload did not finish.");
      playableUrl = new URL(result.url, window.location.origin).href;
    } catch (uploadError) {
      error.textContent = uploadError.message || "The video could not be uploaded.";
      error.classList.remove("hidden");
      return;
    } finally {
      ui.uploadProgress.classList.add("hidden");
    }
  } else {
    if (!parsed || !["https:", "http:"].includes(parsed.protocol)) {
      error.textContent = kind === "youtube" ? "Paste a YouTube watch, short, or embed URL." : "Paste a valid http:// or https:// URL.";
      error.classList.remove("hidden");
      ui.videoUrl.focus();
      return;
    }
    if (window.location.protocol === "https:" && parsed.protocol === "http:") {
      error.textContent = "Use an https link so the browser can load it safely.";
      error.classList.remove("hidden");
      ui.videoUrl.focus();
      return;
    }
    if (kind === "youtube") {
      youtubeId = parseYouTubeId(sourceUrl);
      if (!youtubeId) {
        error.textContent = "That does not look like a standard YouTube video link.";
        error.classList.remove("hidden");
        ui.videoUrl.focus();
        return;
      }
      playableUrl = "https://www.youtube.com/watch?v=" + youtubeId;
    }
    if (kind === "browser" && parsed.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(parsed.hostname)) {
      error.textContent = "Use an https website URL for browser sharing.";
      error.classList.remove("hidden");
      ui.videoUrl.focus();
      return;
    }
  }

  const selected = state.videoDialogMovie || {};
  const sourceLabels = {
    url: "Direct video URL",
    youtube: "YouTube player",
    file: "Uploaded video",
    browser: "Shared browser page",
  };
  const movie = {
    ...selected,
    id: selected.id || "custom-" + makeId(),
    title: title,
    source_url: playableUrl,
    source_kind: kind,
    youtube_id: youtubeId || undefined,
    source_label: sourceLabels[kind],
    runtime_seconds: null,
  };
  state.pendingMovie = null;
  status.textContent = "Connecting to the room…";
  status.classList.remove("hidden");
  const connected = await waitForRoomSocket(10000);
  status.classList.add("hidden");
  if (!connected) {
    error.textContent = "The room is still reconnecting. Try again once it is live.";
    error.classList.remove("hidden");
    return;
  }
  const actionId = sendAction("movie.select", { movie: movie });
  if (!actionId) {
    error.textContent = "Couldn't reach the room. Your stream details are still here—please try again.";
    error.classList.remove("hidden");
    return;
  }
  state.waitingMovieActionId = actionId;
  status.textContent = "Waiting for the room to confirm…";
  status.classList.remove("hidden");
  const acknowledgement = await waitForActionAcknowledgement(actionId, 8000);
  state.waitingMovieActionId = null;
  status.classList.add("hidden");
  if (!ui.videoDialog.open) return;
  if (acknowledgement.ok) {
    state.videoDialogMovie = null;
    ui.videoDialog.close();
  } else {
    error.textContent = acknowledgement.message;
    error.classList.remove("hidden");
  }
}

function inviteUrl() {
  return window.location.origin + window.location.pathname + "?room=" + encodeURIComponent(state.room.code);
}

async function copyInvite() {
  if (!state.room) return;
  try {
    await navigator.clipboard.writeText(inviteUrl());
    showToast("Invite link copied. Share it with your friends.");
  } catch (_) {
    window.prompt("Copy this room invite:", inviteUrl());
  }
}

async function copyRoomCode() {
  if (!state.room) return;
  try {
    await navigator.clipboard.writeText(state.room.code);
    showToast("Room code copied. Send it to your friends.");
  } catch (_) {
    window.prompt("Copy this room code:", state.room.code);
  }
}

function beginPoll() {
  if (!state.room || (state.room.playlist || []).length < 2) {
    showToast("Add two films to the queue before starting a poll.");
    return;
  }
  const options = state.room.playlist.slice(0, 4);
  if (sendAction("poll.create", { title: "What should we put on?", options: options })) {
    showToast("The room can vote now.");
  }
}

function showLobbyAndBrowse() {
  setView("lobby");
  window.setTimeout(function () { document.getElementById("discoverTitle").scrollIntoView({ behavior: "smooth", block: "start" }); }, 50);
}

function returnToLobby(message) {
  const previousSocket = state.socket;
  state.socket = null;
  state.room = null;
  state.lastVersion = 0;
  state.activeSource = "";
  state.activeKind = "";
  window.clearTimeout(state.reconnectTimer);
  if (window.AfterglowMedia) window.AfterglowMedia.disconnect();
  if (previousSocket && previousSocket.readyState < WebSocket.CLOSING) previousSocket.close(1000, "Left screening room");

  ui.video.pause();
  ui.video.removeAttribute("src");
  ui.video.load();
  ui.browserPreview.removeAttribute("src");
  clearYouTubePlayer();
  if (ui.videoDialog.open) ui.videoDialog.close();

  const nextUrl = new URL(window.location.href);
  nextUrl.searchParams.delete("room");
  history.replaceState({}, "", nextUrl.pathname + nextUrl.search + nextUrl.hash);
  setView("lobby");
  loadCatalogDebounced(0);
  if (message) showToast(message);
}

document.getElementById("createRoomButton").addEventListener("click", function () { createRoom(false); });
document.getElementById("tryDemoButton").addEventListener("click", function () { createRoom(true); });
document.getElementById("navDiscover").addEventListener("click", function () { showLobbyAndBrowse(); });
document.getElementById("navRoom").addEventListener("click", function () {
  if (state.room) setView("room");
  else showToast("Start a room or join one with a code.");
});
document.getElementById("profileButton").addEventListener("click", openProfileDialog);
document.getElementById("topProfileButton").addEventListener("click", openProfileDialog);
document.getElementById("saveProfileButton").addEventListener("click", saveProfile);
document.getElementById("closeProfileDialogButton").addEventListener("click", function () { document.getElementById("profileDialog").close(); });
document.getElementById("profileForm").addEventListener("submit", function (event) { event.preventDefault(); });
document.getElementById("registerButton").addEventListener("click", createAccount);
document.getElementById("loginButton").addEventListener("click", signIn);
document.getElementById("logoutButton").addEventListener("click", signOut);
document.getElementById("profileNameInput").addEventListener("keydown", function (event) {
  if (event.key === "Enter") { event.preventDefault(); saveProfile(); }
});
document.getElementById("accountPasswordInput").addEventListener("keydown", function (event) {
  if (event.key === "Enter" && state.isGuest) { event.preventDefault(); signIn(); }
});
document.getElementById("joinForm").addEventListener("submit", function (event) {
  event.preventDefault();
  joinRoom(document.getElementById("roomCodeInput").value);
});
document.getElementById("roomCodeInput").addEventListener("input", function (event) {
  event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
});
document.getElementById("backToDiscover").addEventListener("click", showLobbyAndBrowse);
document.getElementById("closeVideoDialogButton").addEventListener("click", function () { ui.videoDialog.close(); });
document.getElementById("endRoomButton").addEventListener("click", function () {
  if (!roomIsHost() || !state.room) return;
  if (window.confirm("End this screening room for everyone? This will close it for all participants.")) {
    sendAction("room.end", {});
  }
});
document.getElementById("leaveRoomButton").addEventListener("click", function () {
  if (state.room) returnToLobby("You left the room.");
});
document.getElementById("copyInviteButton").addEventListener("click", copyInvite);
document.getElementById("copyRoomCodeButton").addEventListener("click", copyRoomCode);
document.getElementById("peopleInviteButton").addEventListener("click", copyInvite);
document.getElementById("queueAddButton").addEventListener("click", showLobbyAndBrowse);
document.getElementById("findFilmButton").addEventListener("click", showLobbyAndBrowse);
document.getElementById("createPollButton").addEventListener("click", beginPoll);
document.getElementById("chatTab").addEventListener("click", function () { setActivityTab("chat", false); });
document.getElementById("peopleTab").addEventListener("click", function () { setActivityTab("people", false); });
document.querySelectorAll(".reaction-tray button").forEach(function (button) {
  button.addEventListener("click", function () { sendAction("reaction", { emoji: button.dataset.emoji }); });
});
ui.chatForm.addEventListener("submit", function (event) {
  event.preventDefault();
  const text = replaceKnownShortcodes(ui.chatInput.value.trim());
  if (text && sendAction("chat", { text: text })) {
    ui.chatInput.value = "";
    hideEmojiAutocomplete();
  }
});
document.getElementById("chatPickerToggle").addEventListener("click", function () {
  if (ui.chatPicker.classList.contains("hidden")) openChatPicker();
  else closeChatPicker();
});
document.getElementById("closeChatPicker").addEventListener("click", closeChatPicker);
document.querySelectorAll("[data-picker-tab]").forEach(function (button) {
  button.addEventListener("click", function () { setPickerTab(button.dataset.pickerTab); });
});
ui.emojiSearch.addEventListener("input", function () { renderEmojiPicker(ui.emojiSearch.value); });
ui.klipyStickerSearch.addEventListener("input", function () { scheduleKlipyStickerSearch(ui.klipyStickerSearch.value); });
document.querySelectorAll("[data-sticker-query]").forEach(function (button) {
  button.addEventListener("click", function () {
    ui.klipyStickerSearch.value = button.dataset.stickerQuery || "";
    scheduleKlipyStickerSearch(ui.klipyStickerSearch.value);
  });
});
ui.chatInput.addEventListener("input", function () {
  if (!ui.chatPicker.classList.contains("hidden")) closeChatPicker();
  renderEmojiSuggestions();
});
ui.chatInput.addEventListener("keydown", function (event) {
  if (ui.emojiAutocomplete.classList.contains("hidden")) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const direction = event.key === "ArrowDown" ? 1 : -1;
    state.emojiSuggestionIndex = (state.emojiSuggestionIndex + direction + state.emojiSuggestions.length) % state.emojiSuggestions.length;
    renderEmojiSuggestions();
  } else if (event.key === "Enter" && state.emojiSuggestions.length) {
    event.preventDefault();
    selectEmojiSuggestion(state.emojiSuggestionIndex);
  } else if (event.key === "Escape") {
    hideEmojiAutocomplete();
  }
});
document.addEventListener("pointerdown", function (event) {
  if (!ui.chatPicker.classList.contains("hidden") && !ui.chatPicker.contains(event.target) && event.target.id !== "chatPickerToggle") closeChatPicker(false);
  if (!ui.emojiAutocomplete.classList.contains("hidden") && !ui.emojiAutocomplete.contains(event.target) && event.target !== ui.chatInput) hideEmojiAutocomplete();
});
ui.videoForm.addEventListener("submit", function (event) { event.preventDefault(); submitVideo(); });
document.getElementById("loadVideoButton").addEventListener("click", function () { openVideoDialog(null); });
document.getElementById("changeVideoButton").addEventListener("click", function () { openVideoDialog(null); });
document.getElementById("chooseSourceButton").addEventListener("click", function () { openVideoDialog(null); });
ui.sourceModeGrid.querySelectorAll("[data-source-kind]").forEach(function (button) {
  button.addEventListener("click", function () { setSourceMode(button.dataset.sourceKind); });
});
document.getElementById("shareScreenButton").addEventListener("click", function () {
  if (window.AfterglowMedia) window.AfterglowMedia.startScreenShare();
});
document.getElementById("stopScreenButton").addEventListener("click", function () {
  if (window.AfterglowMedia) window.AfterglowMedia.stopScreenShare();
});
document.getElementById("videoChatButton").addEventListener("click", function () {
  if (!state.room || !window.AfterglowMedia) return;
  if ((state.room.video_members || []).includes(state.userId)) window.AfterglowMedia.leaveVideoChat();
  else window.AfterglowMedia.startVideoChat();
});
document.getElementById("micToggleButton").addEventListener("click", function () {
  if (window.AfterglowMedia) window.AfterglowMedia.toggleMic();
});
document.getElementById("cameraToggleButton").addEventListener("click", function () {
  if (window.AfterglowMedia) window.AfterglowMedia.toggleCamera();
});
ui.resumeButton.addEventListener("click", function () {
  if (!state.room) return;
  if (state.activeKind === "youtube" && state.youtubeReady && state.youtubePlayer) {
    state.youtubePlayer.playVideo();
    ui.resumeButton.classList.add("hidden");
    setSyncStatus("synced", "In sync with the room");
    return;
  }
  ui.video.play().then(function () {
    ui.resumeButton.classList.add("hidden");
    setSyncStatus("synced", "In sync with the room");
  }).catch(function () { showToast("This browser couldn't start that video link."); });
});
document.getElementById("fullscreenButton").addEventListener("click", function () {
  const frame = document.getElementById("videoFrame");
  if (document.fullscreenElement) document.exitFullscreen();
  else if (frame.requestFullscreen) frame.requestFullscreen();
});
document.getElementById("playPauseButton").addEventListener("click", function () {
  if (!roomIsHost() || !state.room) return;
  if (state.room.playback.is_playing) {
    const position = getMediaTime() || serverPlaybackPosition();
    state.applyingPlaybackUntil = Date.now() + 1200;
    if (state.activeKind === "youtube" && state.youtubeReady) state.youtubePlayer.pauseVideo();
    else ui.video.pause();
    sendAction("pause", { position: position });
  } else {
    const position = getMediaTime() || serverPlaybackPosition();
    state.applyingPlaybackUntil = Date.now() + 1200;
    if (state.activeKind === "youtube" && state.youtubeReady) state.youtubePlayer.playVideo();
    else ui.video.play().catch(function () { ui.resumeButton.classList.remove("hidden"); });
    sendAction("play", { position: position });
  }
});
ui.seek.addEventListener("pointerdown", function () { state.draggedSeek = true; });
ui.seek.addEventListener("input", function () {
  const duration = state.activeKind === "youtube" && state.youtubeReady ? Number(state.youtubePlayer.getDuration()) : ui.video.duration;
  if (Number.isFinite(duration)) {
    setMediaTime(Number(ui.seek.value));
    ui.timeCurrent.textContent = formatTime(Number(ui.seek.value));
  }
});
ui.seek.addEventListener("change", function () {
  state.draggedSeek = false;
  if (roomIsHost()) {
    state.applyingPlaybackUntil = Date.now() + 1200;
    sendAction("seek", { position: Number(ui.seek.value) });
  }
});
ui.seek.addEventListener("pointerup", function () { state.draggedSeek = false; });
ui.video.addEventListener("error", function () {
  if (state.activeSource && ["url", "file"].includes(state.activeKind)) {
    ui.videoError.classList.remove("hidden");
    setSyncStatus("waiting", "Video link unavailable");
  }
});
ui.video.addEventListener("loadedmetadata", function () {
  if (state.room && state.room.current_movie && ["url", "file"].includes(state.activeKind)) {
    ui.timeTotal.textContent = formatTime(ui.video.duration);
    ui.seek.max = String(Number.isFinite(ui.video.duration) ? ui.video.duration : 100);
  }
});
ui.video.addEventListener("ended", function () {
  if (roomIsHost() && state.room && state.activeKind !== "youtube" && state.room.playback.is_playing) {
    sendAction("pause", { position: ui.video.duration || ui.video.currentTime });
  }
});
ui.search.addEventListener("input", function () { loadCatalogDebounced(550); });
ui.genre.addEventListener("change", loadCatalog);
ui.category.addEventListener("change", loadCatalog);
document.addEventListener("keydown", function (event) {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    ui.search.focus();
  }
  if (event.key === "Escape" && document.activeElement === ui.search) ui.search.blur();
});

function loadCatalogDebounced(delay) {
  window.clearTimeout(state.catalogTimer);
  state.catalogTimer = window.setTimeout(loadCatalog, delay);
}

window.setInterval(function () {
  if (!state.room || !movieSource(state.room.current_movie)) return;
  if (state.activeKind === "browser") return;
  const isYouTube = state.activeKind === "youtube";
  const playerReady = isYouTube ? state.youtubeReady && state.youtubePlayer : ui.video.readyState >= 1;
  const duration = isYouTube ? (playerReady ? Number(state.youtubePlayer.getDuration()) || null : null) :
    (Number.isFinite(ui.video.duration) ? ui.video.duration : null);
  const current = getMediaTime();
  ui.timeCurrent.textContent = formatTime(current);
  if (duration) {
    ui.timeTotal.textContent = formatTime(duration);
    ui.seek.max = String(duration);
    if (!state.draggedSeek) ui.seek.value = String(current);
  }
  if (state.room.playback.is_playing && playerReady) {
    const youtubeState = isYouTube ? state.youtubePlayer.getPlayerState() : null;
    if (isYouTube && youtubeState === window.YT.PlayerState.BUFFERING) {
      updateYouTubeBufferWatch(state.youtubePlayer, Date.now());
      return;
    }
    if (isYouTube) resetYouTubeBufferWatch();
    const drift = serverPlaybackPosition() - current;
    const correctionThreshold = isYouTube ? YOUTUBE_DRIFT_THRESHOLD_SECONDS : 0.5;
    const youtubeCooldownElapsed = !isYouTube || Date.now() - state.lastYouTubeCorrectionAt >= YOUTUBE_CORRECTION_COOLDOWN_MS;
    const youtubeCanSeek = !isYouTube || youtubeState === window.YT.PlayerState.PLAYING;
    if (Math.abs(drift) > correctionThreshold && youtubeCooldownElapsed && youtubeCanSeek) {
      const target = duration ? Math.min(serverPlaybackPosition(), Math.max(0, duration - 0.05)) : serverPlaybackPosition();
      try {
        setMediaTime(target);
        if (isYouTube) state.lastYouTubeCorrectionAt = Date.now();
        state.applyingPlaybackUntil = Date.now() + 1200;
      } catch (_) { /* The next sync tick will retry. */ }
      setSyncStatus("correcting", "Correcting drift");
      window.setTimeout(function () {
        if (!state.room) return;
        if (isYouTube && state.youtubePlayer && state.youtubePlayer.getPlayerState() === window.YT.PlayerState.BUFFERING) {
          updateYouTubeBufferWatch(state.youtubePlayer, Date.now());
          return;
        }
        const correctedTime = isYouTube ? getMediaTime() : Number(ui.video.currentTime) || 0;
        setSyncStatus("synced", "Synced · " + Math.round(Math.abs(serverPlaybackPosition() - correctedTime) * 1000) + " ms");
      }, 500);
    } else {
      if (isYouTube && Math.abs(drift) > correctionThreshold) {
        setSyncStatus("waiting", "Letting YouTube settle · " + Math.round(Math.abs(drift) * 1000) + " ms drift");
      } else {
        setSyncStatus("synced", "Synced · " + Math.round(Math.abs(drift) * 1000) + " ms");
      }
    }
  }
}, 500);

window.setInterval(function () {
  if (state.socket && state.socket.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify({ type: "ping", client_time: Date.now() }));
  }
}, 5000);

async function boot() {
  try {
    const session = await api("/api/session");
    applySessionUser(session.user);
    try {
      const clientConfig = await api("/api/client-config");
      state.klipyAppKey = String(clientConfig.klipy_app_key || "");
    } catch (_) { state.klipyAppKey = ""; }
    if (window.AfterglowMedia) await window.AfterglowMedia.refreshConfig();
  } catch (error) {
    showToast("The app could not start a secure session: " + error.message);
    return;
  }
  loadCatalog();
  const roomCode = new URLSearchParams(window.location.search).get("room");
  if (roomCode) joinRoom(roomCode);
}

boot();
