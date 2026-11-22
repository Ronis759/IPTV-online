import { parsePlaylist, guessPlaylistName, Playlist } from './m3u.js';
import { Store } from './store.js';
import { Player } from './player.js';

const $ = (selector, root = document) => root.querySelector(selector);

const els = {
  openPlaylists: $('#openPlaylists'),
  openSettings: $('#openSettings'),
  search: $('#search'),
  groupSelect: $('#groupSelect'),
  playlistName: $('#playlistName'),
  playlistMeta: $('#playlistMeta'),
  changePlaylist: $('#changePlaylist'),
  channelList: $('#channelList'),
  emptyList: $('#emptyList'),
  emptyLoadBtn: $('#emptyLoadBtn'),
  loadMore: $('#loadMore'),

  videoWrap: $('#videoWrap'),
  video: $('#video'),
  overlay: $('#overlay'),
  overlayBadge: $('#overlayBadge'),
  overlayTitle: $('#overlayTitle'),
  overlayText: $('#overlayText'),
  overlayLoad: $('#overlayLoad'),
  overlayRetry: $('#overlayRetry'),
  overlayRemove: $('#overlayRemove'),
  spinner: $('#spinner'),

  nowLogo: $('#nowLogo'),
  nowTitle: $('#nowTitle'),
  nowMeta: $('#nowMeta'),
  qualitySelect: $('#qualitySelect'),
  favBtn: $('#favBtn'),
  pipBtn: $('#pipBtn'),
  fsBtn: $('#fsBtn'),
  reloadBtn: $('#reloadBtn'),
  copyBtn: $('#copyBtn'),
  downloadBtn: $('#downloadBtn'),
  streamUrl: $('#streamUrl'),

  playlistDialog: $('#playlistDialog'),
  settingsDialog: $('#settingsDialog'),
  dropZone: $('#dropZone'),
  fileInput: $('#fileInput'),
  urlInput: $('#urlInput'),
  loadUrlBtn: $('#loadUrlBtn'),
  examples: $('#examples'),
  savedList: $('#savedList'),
  myLists: $('#myLists'),
  createListBtn: $('#createListBtn'),
  clearSaved: $('#clearSaved'),
  clearPlaylists: $('#clearPlaylists'),

  proxyToggle: $('#proxyToggle'),
  proxyTemplate: $('#proxyTemplate'),
  clearFavorites: $('#clearFavorites'),
  clearAll: $('#clearAll'),

  toast: $('#toast'),

  promptDialog: $('#promptDialog'),
  promptInput: $('#promptInput'),
  promptOk: $('#promptOk'),
};

const EXAMPLES = [
  { label: '✅ Проверенные', url: new URL('verified.m3u', window.location.href).href },
  { label: 'Россия', url: 'https://iptv-org.github.io/iptv/countries/ru.m3u' },
  { label: 'Украина', url: 'https://iptv-org.github.io/iptv/countries/ua.m3u' },
  { label: 'Беларусь', url: 'https://iptv-org.github.io/iptv/countries/by.m3u' },
  { label: 'Казахстан', url: 'https://iptv-org.github.io/iptv/countries/kz.m3u' },
  { label: 'Кино', url: 'https://iptv-org.github.io/iptv/categories/movies.m3u' },
  { label: 'Весь мир', url: 'https://iptv-org.github.io/iptv/index.m3u' },
];

const state = {
  items: [],
  filtered: [],
  group: 'all',
  query: '',
  favorites: new Map(),
  current: null,
  playlist: null,
  shown: 0,
  pageSize: 250,
  busy: false,
};

const player = new Player(els.video);

/* ============================================================
   Вспомогательные функции
   ============================================================ */

let toastTimer = null;

function toast(message, duration = 4200) {
  clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.hidden = false;
  requestAnimationFrame(() => els.toast.classList.add('is-visible'));
  toastTimer = setTimeout(() => {
    els.toast.classList.remove('is-visible');
    setTimeout(() => { els.toast.hidden = true; }, 220);
  }, duration);
}

function closeDialog(id) {
  const dialog = document.getElementById(id);
  if (dialog && dialog.open) dialog.close();
}

function makeId(value) {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) >>> 0;
  }
  return `p${hash.toString(36)}`;
}

function normalizeUrl(value) {
  let url = String(value || '').trim();
  if (!url) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `https://${url}`;
  try {
    return new URL(url).href;
  } catch {
    return '';
  }
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function initials(name) {
  const words = String(name || '?').trim().split(/\s+/).slice(0, 2);
  return words.map((word) => word[0] || '').join('').toUpperCase() || '?';
}

function plural(count, one, few, many) {
  const abs = Math.abs(count) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

function channelsLabel(count) {
  return `${count} ${plural(count, 'канал', 'канала', 'каналов')}`;
}

/** Английские названия групп из плейлистов iptv-org → по-русски. */
const GROUP_NAMES = {
  general: 'Общие',
  news: 'Новости',
  music: 'Музыка',
  movies: 'Кино',
  sports: 'Спорт',
  kids: 'Детские',
  entertainment: 'Развлечения',
  religious: 'Религиозные',
  culture: 'Культура',
  documentary: 'Документальные',
  lifestyle: 'Образ жизни',
  shop: 'Магазины',
  outdoor: 'Природа и туризм',
  family: 'Семейные',
  series: 'Сериалы',
  comedy: 'Комедия',
  education: 'Обучение',
  science: 'Наука',
  weather: 'Погода',
  business: 'Бизнес',
  auto: 'Авто',
  cooking: 'Кулинария',
  travel: 'Путешествия',
  undefined: 'Без группы',
  russia: 'Россия',
  ukraine: 'Украина',
  belarus: 'Беларусь',
  kazakhstan: 'Казахстан',
};

const CYRILLIC = /[а-яё]/i;

function localizeGroup(name) {
  const value = String(name || '').trim();
  if (!value) return 'Без группы';
  const key = value.toLowerCase();
  if (CYRILLIC.test(value)) return value;

  if (key.includes(';')) {
    const parts = key.split(';').map((part) => part.trim()).filter(Boolean);
    const known = parts.map((part) => GROUP_NAMES[part]);
    if (known.every(Boolean)) return known.join(', ');
  }

  return GROUP_NAMES[key] || value;
}

function syncFavorites() {
  state.favorites = new Map(Store.getFavorites().map((item) => [item.url, item]));
}

function setBusy(busy) {
  state.busy = busy;
  els.loadUrlBtn.disabled = busy;
  els.loadUrlBtn.textContent = busy ? 'Загрузка…' : 'Загрузить';
}

/* ============================================================
   Отрисовка списка каналов
   ============================================================ */

function groupName(item) {
  return localizeGroup(item.group);
}

function renderGroups() {
  const groups = new Map();
  for (const item of state.items) {
    const name = groupName(item);
    groups.set(name, (groups.get(name) || 0) + 1);
  }
  const select = els.groupSelect;
  select.innerHTML = '';

  const add = (value, label) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    select.appendChild(option);
  };

  add('all', `Все каналы (${state.items.length})`);
  add('fav', `★ Избранное (${state.favorites.size})`);

  const sorted = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0], 'ru'));
  for (const [name, count] of sorted) add(name, `${name} (${count})`);

  if (state.group !== 'all' && state.group !== 'fav' && !groups.has(state.group)) {
    state.group = 'all';
  }
  select.value = state.group;
}

function matchesFilter(item) {
  if (state.group === 'fav') {
    if (!state.favorites.has(item.url)) return false;
  } else if (state.group !== 'all') {
    if (groupName(item) !== state.group) return false;
  }

  if (state.query) {
    const query = state.query.toLowerCase();
    return (
      item.name.toLowerCase().includes(query) ||
      groupName(item).toLowerCase().includes(query)
    );
  }
  return true;
}

function channelNode(item) {
  const li = document.createElement('li');

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'channel';
  button.dataset.url = item.url;
  if (state.current && state.current.url === item.url) button.classList.add('is-active');

  const logo = document.createElement('img');
  logo.className = 'channel-logo';
  logo.alt = '';
  logo.loading = 'lazy';
  logo.decoding = 'async';
  if (item.logo) {
    logo.src = item.logo;
    logo.addEventListener('error', () => {
      logo.removeAttribute('src');
      logo.classList.add('is-empty');
      logo.textContent = initials(item.name);
    });
  } else {
    logo.classList.add('is-empty');
    logo.textContent = initials(item.name);
  }

  const text = document.createElement('span');
  text.className = 'channel-text';

  const name = document.createElement('span');
  name.className = 'channel-name';
  name.textContent = item.name;

  const group = document.createElement('span');
  group.className = 'channel-group';
  group.textContent = groupName(item);

  text.append(name, group);

  const fav = document.createElement('button');
  fav.type = 'button';
  fav.className = 'channel-fav';
  const isFav = state.favorites.has(item.url);
  fav.textContent = isFav ? '★' : '☆';
  fav.title = isFav ? 'Убрать из избранного' : 'В избранное';
  if (isFav) fav.classList.add('is-on');
  fav.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleFavorite(item);
  });

  button.append(logo, text, fav);
  button.addEventListener('click', () => selectChannel(item));

  li.appendChild(button);
  return li;
}

function appendChunk() {
  if (state.shown >= state.filtered.length) {
    els.loadMore.hidden = true;
    return;
  }

  const fragment = document.createDocumentFragment();
  const end = Math.min(state.shown + state.pageSize, state.filtered.length);
  for (let i = state.shown; i < end; i++) fragment.appendChild(channelNode(state.filtered[i]));
  els.channelList.appendChild(fragment);
  state.shown = end;
  els.loadMore.hidden = state.shown >= state.filtered.length;
}

function renderChannels() {
  state.filtered = state.items.filter(matchesFilter);
  state.shown = 0;
  els.channelList.innerHTML = '';
  appendChunk();

  const hasItems = state.items.length > 0;
  const noResults = hasItems && state.filtered.length === 0;
  els.emptyList.hidden = hasItems && !noResults;
  els.emptyList.querySelector('p').textContent = noResults
    ? 'Ничего не найдено. Измените запрос или выберите другую группу.'
    : 'Здесь появятся каналы.';
  els.emptyLoadBtn.hidden = noResults;
  els.loadMore.hidden = !hasItems || noResults || state.shown >= state.filtered.length;
}

function highlightCurrent() {
  const buttons = els.channelList.querySelectorAll('.channel');
  buttons.forEach((button) => {
    button.classList.toggle('is-active', Boolean(state.current) && button.dataset.url === state.current.url);
  });
}

/* ============================================================
   Избранное
   ============================================================ */

function toggleFavorite(item) {
  const added = Store.toggleFavorite(item);
  syncFavorites();
  toast(added ? 'Добавлено в избранное' : 'Убрано из избранного', 2000);

  if (state.group === 'fav') {
    renderGroups();
    renderChannels();
  } else {
    renderGroups();
    highlightCurrent();
    const buttons = els.channelList.querySelectorAll('.channel');
    buttons.forEach((button) => {
      if (button.dataset.url !== item.url) return;
      const fav = button.querySelector('.channel-fav');
      if (!fav) return;
      const isFav = state.favorites.has(item.url);
      fav.textContent = isFav ? '★' : '☆';
      fav.classList.toggle('is-on', isFav);
      fav.title = isFav ? 'Убрать из избранного' : 'В избранное';
    });
  }

  if (state.current && state.current.url === item.url) updateFavoriteButton();
}

/* ============================================================
   Плеер и состояние «сейчас играет»
   ============================================================ */

function updateFavoriteButton() {
  const active = Boolean(state.current) && state.favorites.has(state.current.url);
  els.favBtn.textContent = active ? '★' : '☆';
  els.favBtn.classList.toggle('active', active);
  els.favBtn.title = active ? 'Убрать из избранного' : 'В избранное';
  els.favBtn.setAttribute('aria-label', els.favBtn.title);
}

function updateNowPlaying(item) {
  els.nowTitle.textContent = item ? item.name : 'Ничего не воспроизводится';
  els.nowMeta.textContent = item
    ? `${groupName(item)}${state.playlist ? ` · ${state.playlist.name}` : ''}`
    : 'Выберите канал из списка';
  els.streamUrl.textContent = item ? item.url : '';
  els.streamUrl.title = item ? item.url : '';

  if (item && item.logo) {
    els.nowLogo.src = item.logo;
    els.nowLogo.hidden = false;
    els.nowLogo.onerror = () => { els.nowLogo.hidden = true; };
  } else {
    els.nowLogo.hidden = true;
    els.nowLogo.removeAttribute('src');
  }

  updateFavoriteButton();
}

function showOverlay({ badge = 'IPTV', title, text, error = false, retry = false, load = true, remove = false }) {
  els.overlayBadge.textContent = badge;
  els.overlayTitle.textContent = title;
  els.overlayText.textContent = text;
  els.overlay.classList.toggle('is-error', error);
  els.overlayRetry.hidden = !retry;
  els.overlayLoad.hidden = !load || error;
  els.overlayRemove.hidden = !remove;
  els.overlay.hidden = false;
}

function showChooseChannelOverlay(count) {
  showOverlay({
    badge: 'Плейлист',
    title: 'Выберите канал',
    text: `В плейлисте ${channelsLabel(count)}. Найдите нужный через поиск или выберите группу в списке слева.`,
    load: false,
  });
}

function hideOverlay() {
  els.overlay.hidden = true;
}

function selectChannel(item) {
  state.current = item;
  highlightCurrent();
  updateNowPlaying(item);
  hideOverlay();
  els.spinner.hidden = false;
  player.play(item);

  if (window.innerWidth <= 900) {
    els.videoWrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

let loadWatchdog = null;

function startLoadWatchdog() {
  clearLoadWatchdog();
  loadWatchdog = setTimeout(() => {
    loadWatchdog = null;
    if (!state.current || els.video.readyState > 0) return;
    els.spinner.hidden = true;
    showOverlay({
      badge: 'Ошибка',
      title: 'Поток не отвечает',
      text: 'Сервер не отдал видео за 25 секунд. Попробуйте другой канал, перезапустите поток или включите прокси в настройках.',
      error: true,
      retry: true,
    });
  }, 25000);
}

function clearLoadWatchdog() {
  if (loadWatchdog) {
    clearTimeout(loadWatchdog);
    loadWatchdog = null;
  }
}

function removeChannelFromPlaylist(channel) {
  const before = state.items.length;
  state.items = state.items.filter((item) => item.url !== channel.url);
  if (state.items.length === before) return;

  player.stop();
  clearLoadWatchdog();
  state.current = null;
  els.spinner.hidden = true;
  buildQualityOptions([]);

  if (state.playlist && state.playlist.id) {
    if (state.playlist.url !== '') {
      if (state.items.length) Store.setCache(state.playlist.id, state.items);
      else Store.setCache(state.playlist.id, []);
    }
    const saved = Store.getPlaylists().find((entry) => entry.id === state.playlist.id);
    if (saved) Store.savePlaylist({ ...saved, count: state.items.length });
  }

  if (!state.items.length) {
    resetPlaylist();
    toast('Все каналы убраны из плейлиста', 3000);
    return;
  }

  renderGroups();
  renderChannels();
  updatePlaylistBar();
  updateNowPlaying(null);
  showChooseChannelOverlay(state.items.length);
  toast(`Канал убран из плейлиста (осталось ${channelsLabel(state.items.length)})`, 3500);
}

function buildQualityOptions(levels) {
  const select = els.qualitySelect;
  select.innerHTML = '';

  if (!levels || levels.length < 2) {
    select.hidden = true;
    return;
  }

  const auto = document.createElement('option');
  auto.value = '-1';
  auto.textContent = 'Авто';
  select.appendChild(auto);

  const sorted = levels
    .map((level, index) => ({ ...level, index }))
    .sort((a, b) => b.height - a.height || b.bitrate - a.bitrate);

  for (const level of sorted) {
    const option = document.createElement('option');
    option.value = String(level.index);
    option.textContent = level.height
      ? `${level.height}p`
      : `${Math.round(level.bitrate / 1000)} кбит/с`;
    select.appendChild(option);
  }

  select.value = '-1';
  select.hidden = false;
}

player.addEventListener('loading', (event) => {
  const item = event.detail;
  els.spinner.hidden = false;
  els.nowMeta.textContent = `Подключение…${item ? ` · ${groupName(item)}` : ''}`;
  startLoadWatchdog();
});

player.addEventListener('playing', () => {
  clearLoadWatchdog();
  els.spinner.hidden = true;
  if (state.current) {
    els.nowMeta.textContent = `${groupName(state.current)}${state.playlist ? ` · ${state.playlist.name}` : ''} · в эфире`;
  }
});

player.addEventListener('buffering', () => {
  els.spinner.hidden = false;
});

player.addEventListener('blocked', () => {
  els.spinner.hidden = true;
  toast('Браузер заблокировал автозапуск — нажмите ▶ в плеере.', 5000);
});

player.addEventListener('levels', (event) => {
  buildQualityOptions(event.detail);
});

player.addEventListener('error', (event) => {
  clearLoadWatchdog();
  els.spinner.hidden = true;
  const message = event.detail && event.detail.message ? event.detail.message : 'Не удалось открыть поток.';
  const insecure = window.location.protocol === 'https:' && /^http:\/\//i.test((state.current && state.current.url) || '');
  showOverlay({
    badge: 'Ошибка',
    title: 'Поток не открылся',
    text: insecure
      ? 'Канал вещает по http://, а сайт открыт по https:// — браузер блокирует такие запросы (mixed content). Нужен поток по https:// или локальный запуск сайта.'
      : `${message} Попробуйте другой канал, перезапустить поток или включить прокси в настройках.`,
    error: true,
    retry: true,
    remove: true,
  });
});

/* ============================================================
   Загрузка плейлистов
   ============================================================ */

async function fetchText(url) {
  const response = await fetch(url, { cache: 'no-store', redirect: 'follow' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

function buildProxyUrl(template, url) {
  if (!template) return url;
  return template.includes('{url}')
    ? template.replace('{url}', encodeURIComponent(url))
    : `${template}${encodeURIComponent(url)}`;
}

async function fetchPlaylistText(url) {
  const settings = Store.getSettings();

  if (settings.proxy) {
    try {
      return await fetchText(buildProxyUrl(settings.proxyTemplate, url));
    } catch {
      toast('Прокси не ответил — пробую загрузить напрямую…', 3500);
    }
  }

  return fetchText(url);
}

function updatePlaylistBar() {
  if (state.playlist) {
    els.playlistName.textContent = state.playlist.name;
    const host = state.playlist.url ? hostOf(state.playlist.url) : 'локальный файл';
    els.playlistMeta.textContent = `${channelsLabel(state.items.length)} · ${host}`;
  } else {
    els.playlistName.textContent = 'Плейлист не загружен';
    els.playlistMeta.textContent = 'Загрузите M3U-плейлист, чтобы начать';
  }
}

function applyPlaylist({ name, url, text, id, cache = true }) {
  const { items, isHlsMedia } = parsePlaylist(text, url || '');
  const nextId = id || makeId(url || name);
  const playlistChanged = !state.playlist || state.playlist.id !== nextId;

  if (playlistChanged) {
    player.stop();
    clearLoadWatchdog();
    state.current = null;
    els.spinner.hidden = true;
    buildQualityOptions([]);
    updateNowPlaying(null);
  }

  if (!items.length && isHlsMedia) {
    // Пользователь вставил ссылку прямо на HLS-поток.
    const channel = {
      id: url,
      name: name || guessPlaylistName(url),
      url,
      logo: '',
      group: '',
    };
    state.items = [channel];
    state.filtered = [channel];
    state.playlist = { id: nextId, name: 'Одиночный поток', url };
    state.group = 'all';
    state.query = '';
    els.search.value = '';
    renderGroups();
    renderChannels();
    updatePlaylistBar();
    selectChannel(channel);
    return { count: 1 };
  }

  if (!items.length) {
    throw new Error('в плейлисте не найдено ни одного канала');
  }

  state.items = items;
  state.playlist = { id: nextId, name, url: url || '' };
  state.group = 'all';
  state.query = '';
  els.search.value = '';

  renderGroups();
  renderChannels();
  updatePlaylistBar();
  if (!state.current) showChooseChannelOverlay(items.length);

  Store.savePlaylist({
    id: state.playlist.id,
    name: state.playlist.name,
    url: state.playlist.url,
    count: items.length,
  });
  Store.setActive(state.playlist);
  if (cache) Store.setCache(state.playlist.id, items);

  renderSaved();
  return { count: items.length };
}

let loadSeq = 0;

async function loadPlaylistFromUrl(rawUrl, options = {}) {
  const { silent = false, name } = options;
  const url = normalizeUrl(rawUrl);

  if (!url) {
    if (!silent) toast('Введите корректную ссылку на плейлист');
    return;
  }

  const seq = ++loadSeq;
  setBusy(true);

  try {
    const text = await fetchPlaylistText(url);
    if (seq !== loadSeq) return;
    const result = applyPlaylist({
      name: name || guessPlaylistName(url),
      url,
      text,
    });
    if (!silent) {
      closeDialog('playlistDialog');
      toast(`Плейлист загружен: ${channelsLabel(result.count)}`);
    }
  } catch (error) {
    if (!silent && seq === loadSeq) {
      toast(`Не удалось загрузить: ${error.message}. Проверьте ссылку или включите прокси в настройках.`, 7000);
    }
  } finally {
    if (seq === loadSeq) setBusy(false);
  }
}

async function handleFile(file) {
  if (!file) return;
  if (file.size > 25 * 1024 * 1024) {
    toast('Файл больше 25 МБ — слишком большой для браузера.', 5000);
    return;
  }

  try {
    const seq = ++loadSeq;
    const text = await file.text();
    if (seq !== loadSeq) return;
    const name = file.name.replace(/\.[^.]+$/, '');
    const result = applyPlaylist({
      name,
      url: '',
      text,
      id: makeId(`file:${file.name}:${file.size}`),
    });
    closeDialog('playlistDialog');
    toast(`Плейлист загружен: ${channelsLabel(result.count)}`);
  } catch (error) {
    toast(`Не удалось прочитать файл: ${error.message}`, 6000);
  } finally {
    els.fileInput.value = '';
  }
}

/* ============================================================
   Сохранённые плейлисты
   ============================================================ */

function renderSaved() {
  const list = Store.getPlaylists();
  els.savedList.innerHTML = '';

  if (!list.length) {
    const empty = document.createElement('li');
    empty.className = 'saved-empty';
    empty.textContent = 'Пока пусто. Загруженные плейлисты появятся здесь.';
    els.savedList.appendChild(empty);
    return;
  }

  for (const entry of list) {
    const li = document.createElement('li');
    li.className = 'saved-item';

    const text = document.createElement('div');
    text.className = 'saved-item-text';

    const title = document.createElement('strong');
    title.textContent = entry.name || 'Плейлист';

    const meta = document.createElement('span');
    meta.textContent = [entry.count ? channelsLabel(entry.count) : '', entry.url ? hostOf(entry.url) : 'локальный файл']
      .filter(Boolean)
      .join(' · ');

    text.append(title, meta);

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'btn tiny';
    open.textContent = 'Открыть';
    open.addEventListener('click', () => {
      if (entry.url) {
        loadPlaylistFromUrl(entry.url, { name: entry.name });
      } else {
        toast('Локальный файл нужно выбрать заново — браузер не хранит его содержимое.', 5000);
      }
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn tiny ghost';
    remove.textContent = '✕';
    remove.title = 'Удалить из списка';
    remove.addEventListener('click', () => {
      Store.removePlaylist(entry.id);
      renderSaved();
      if (state.playlist && state.playlist.id === entry.id) {
        resetPlaylist();
      }
      toast('Плейлист удалён из списка', 2500);
    });

    li.append(text, open, remove);
    els.savedList.appendChild(li);
  }
}

function listingChip(label, title, onClick, { onRemove } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'listing';

  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'chip';
  chip.textContent = label;
  chip.title = title;
  chip.addEventListener('click', onClick);

  wrap.appendChild(chip);

  if (onRemove) {
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'chip-remove';
    remove.textContent = '✕';
    remove.title = 'Удалить';
    remove.addEventListener('click', onRemove);
    wrap.appendChild(remove);
  }

  return wrap;
}

function renderMyLists() {
  const items = Store.getListings();
  els.myLists.innerHTML = '';

  const fromFavorites = listingChip(
    `★ Избранные каналы (${state.favorites.size})`,
    'Сохранить каналы из избранного в свой плейлист',
    () => createListing('Мой плейлист', [...state.favorites.values()]),
    { onRemove: null },
  );
  els.myLists.appendChild(fromFavorites);

  for (const entry of items) {
    const saved = listingChip(
      `${entry.name} (${entry.items.length})`,
      'Открыть плейлист',
      () => openListing(entry),
      {
        onRemove: () => {
          Store.removeListing(entry.id);
          renderMyLists();
          toast('Свой плейлист удалён', 2000);
        },
      },
    );
    els.myLists.appendChild(saved);
  }
}

function askName(defaultName) {
  return new Promise((resolve) => {
    if (!els.promptDialog) {
      resolve(window.prompt ? window.prompt('Название плейлиста:', defaultName) : defaultName);
      return;
    }
    els.promptInput.value = defaultName;
    els.promptDialog.showModal();
    const done = (value) => {
      els.promptDialog.close();
      els.promptOk.onclick = null;
      els.promptDialog.onclose = null;
      resolve(value);
    };
    els.promptOk.onclick = () => done(els.promptInput.value);
    els.promptDialog.onclose = () => done(null);
    els.promptInput.focus();
    els.promptInput.select();
  });
}

function createListing(defaultName, items) {
  if (!items.length) {
    toast('Сначала отметьте каналы звёздочкой ☆ — так они попадут в плейлист.', 4500);
    return;
  }
  askName(defaultName).then((name) => {
    if (name === null) return;
    buildListing(name.trim() || defaultName, items);
  });
}

function buildListing(cleanName, items) {
  const text = Playlist.toM3U(items, { title: cleanName });
  const id = `my:${cleanName.toLowerCase()}:${items.length}`;

  applyPlaylist({ name: cleanName, url: '', text, id });

  Store.saveListing({
    id,
    name: cleanName,
    createdAt: Date.now(),
    items: items.map((item) => Playlist.cleanChannel(item)),
  });
  renderMyLists();

  closeDialog('playlistDialog');
  toast(`Свой плейлист «${cleanName}»: ${channelsLabel(items.length)}. Скачайте его файлом на кнопке ⤓.`, 5200);
}

function openListing(entry) {
  const text = Playlist.toM3U(entry.items, { title: entry.name });
  applyPlaylist({ name: entry.name, url: '', text, id: entry.id });
  closeDialog('playlistDialog');
  toast(`Открыт свой плейлист: ${channelsLabel(entry.items.length)}`, 3000);
}

function downloadCurrentPlaylist() {
  if (!state.items.length) {
    toast('Сначала загрузите или создайте плейлист', 3000);
    return;
  }

  const title = state.playlist ? state.playlist.name : 'iptv';
  const text = Playlist.toM3U(state.items, { title });
  const blob = new Blob([text], { type: 'audio/x-mpegurl;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${title.replace(/[^\wа-яё.-]+/gi, '_')}.m3u`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 4000);
  toast(`Файл ${link.download} сохранён. Его можно залить на GitHub и открыть по ссылке.`, 5000);
}

function resetPlaylist() {
  loadSeq++;
  player.stop();
  clearLoadWatchdog();
  state.items = [];
  state.filtered = [];
  state.current = null;
  state.playlist = null;
  state.group = 'all';
  state.query = '';
  els.search.value = '';
  renderGroups();
  renderChannels();
  updatePlaylistBar();
  updateNowPlaying(null);
  buildQualityOptions([]);
  els.streamUrl.textContent = '';
  showOverlay({
    badge: 'IPTV',
    title: 'Выберите канал',
    text: 'Загрузите плейлист по ссылке или файлом — и каналы появятся в списке слева.',
  });
}

/* ============================================================
   События интерфейса
   ============================================================ */

function bindEvents() {
  els.openPlaylists.addEventListener('click', () => els.playlistDialog.showModal());
  els.openSettings.addEventListener('click', () => els.settingsDialog.showModal());
  els.changePlaylist.addEventListener('click', () => els.playlistDialog.showModal());
  els.emptyLoadBtn.addEventListener('click', () => els.playlistDialog.showModal());
  els.overlayLoad.addEventListener('click', () => els.playlistDialog.showModal());

  els.overlayRetry.addEventListener('click', () => {
    if (!state.current) return;
    hideOverlay();
    els.spinner.hidden = false;
    player.play(state.current);
  });

  document.querySelectorAll('[data-close]').forEach((button) => {
    button.addEventListener('click', () => closeDialog(button.dataset.close));
  });

  els.search.addEventListener('input', () => {
    state.query = els.search.value.trim();
    clearTimeout(els.search._timer);
    els.search._timer = setTimeout(renderChannels, 150);
  });

  els.groupSelect.addEventListener('change', () => {
    state.group = els.groupSelect.value;
    renderChannels();
    els.channelList.scrollTop = 0;
  });

  els.loadMore.addEventListener('click', appendChunk);

  els.loadUrlBtn.addEventListener('click', () => loadPlaylistFromUrl(els.urlInput.value));
  els.urlInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      loadPlaylistFromUrl(els.urlInput.value);
    }
  });

  els.fileInput.addEventListener('change', () => handleFile(els.fileInput.files[0]));

  els.dropZone.addEventListener('dragover', (event) => {
    event.preventDefault();
    els.dropZone.classList.add('is-over');
  });
  els.dropZone.addEventListener('dragleave', () => els.dropZone.classList.remove('is-over'));
  els.dropZone.addEventListener('drop', (event) => {
    event.preventDefault();
    els.dropZone.classList.remove('is-over');
    handleFile(event.dataTransfer.files[0]);
  });

  // Перетаскивание файла в любое место страницы.
  document.addEventListener('dragover', (event) => {
    if (event.dataTransfer && [...event.dataTransfer.types].includes('Files')) event.preventDefault();
  });
  document.addEventListener('drop', (event) => {
    if (!event.dataTransfer || !event.dataTransfer.files.length) return;
    event.preventDefault();
    handleFile(event.dataTransfer.files[0]);
  });

  els.clearSaved.addEventListener('click', () => {
    if (!Store.getPlaylists().length) return;
    if (!confirm('Удалить все сохранённые плейлисты? Избранное останется.')) return;
    for (const entry of Store.getPlaylists()) Store.removePlaylist(entry.id);
    Store.setActive(null);
    renderSaved();
    resetPlaylist();
    toast('Список плейлистов очищен', 2500);
  });

  els.clearPlaylists.addEventListener('click', () => {
    if (!Store.getListings().length) {
      toast('Своих плейлистов пока нет', 2000);
      return;
    }
    if (!confirm('Удалить все свои плейлисты? Избранные каналы останутся.')) return;
    for (const entry of Store.getListings()) Store.removeListing(entry.id);
    renderMyLists();
    toast('Свои плейлисты удалены', 2500);
  });

  els.createListBtn.addEventListener('click', () => {
    createListing('Мой плейлист', [...state.favorites.values()]);
  });

  els.proxyToggle.addEventListener('change', () => {
    Store.saveSettings({ proxy: els.proxyToggle.checked });
    toast(els.proxyToggle.checked ? 'Прокси включён' : 'Прокси выключен', 2000);
  });

  els.proxyTemplate.addEventListener('change', () => {
    Store.saveSettings({ proxyTemplate: els.proxyTemplate.value.trim() });
    toast('Адрес прокси сохранён', 2000);
  });

  els.clearFavorites.addEventListener('click', () => {
    if (!state.favorites.size) { toast('Избранное уже пустое', 2000); return; }
    if (!confirm('Очистить избранное?')) return;
    Store.clearFavorites();
    syncFavorites();
    renderGroups();
    renderChannels();
    updateFavoriteButton();
    toast('Избранное очищено', 2500);
  });

  els.clearAll.addEventListener('click', () => {
    if (!confirm('Удалить все плейлисты, кэш, избранное и настройки?')) return;
    Store.clearAll();
    syncFavorites();
    state.items = [];
    renderSaved();
    resetPlaylist();
    els.proxyToggle.checked = false;
    els.proxyTemplate.value = Store.getSettings().proxyTemplate;
    toast('Все данные удалены', 3000);
  });

  // Избранное (звёздочка) и одиночная кнопка скачивания.
  els.favBtn.addEventListener('click', () => {
    if (!state.current) { toast('Сначала выберите канал', 2000); return; }
    toggleFavorite(state.current);
  });

  els.downloadBtn.addEventListener('click', downloadCurrentPlaylist);
  els.overlayRemove.addEventListener('click', () => {
    if (!state.current) return;
    removeChannelFromPlaylist(state.current);
  });

  els.promptInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      els.promptOk.click();
    }
  });

  els.reloadBtn.addEventListener('click', () => {
    if (!state.current) return;
    hideOverlay();
    player.play(state.current);
    toast('Перезапуск потока…', 1500);
  });

  els.copyBtn.addEventListener('click', async () => {
    if (!state.current) { toast('Сначала выберите канал', 2000); return; }
    try {
      await navigator.clipboard.writeText(state.current.url);
      toast('Ссылка на поток скопирована', 2000);
    } catch {
      toast('Браузер не дал скопировать ссылку', 3000);
    }
  });

  els.fsBtn.addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await els.videoWrap.requestFullscreen();
    } catch {
      toast('Полный экран недоступен', 2500);
    }
  });

  els.pipBtn.addEventListener('click', async () => {
    if (!document.pictureInPictureEnabled) { toast('Браузер не поддерживает картинку в картинке', 3000); return; }
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await els.video.requestPictureInPicture();
    } catch {
      toast('Не удалось включить картинку в картинке', 3000);
    }
  });

  els.qualitySelect.addEventListener('change', () => {
    player.setLevel(Number(els.qualitySelect.value));
  });

  document.addEventListener('keydown', (event) => {
    const target = event.target;
    if (target && (target.matches('input, select, textarea, button, a') || target.isContentEditable)) return;

    const key = event.key.toLowerCase();

    if (event.code === 'Space') {
      event.preventDefault();
      if (els.video.paused) els.video.play().catch(() => {});
      else els.video.pause();
    } else if (key === 'f' || key === 'а') {
      els.fsBtn.click();
    } else if (key === 'm' || key === 'ь') {
      els.video.muted = !els.video.muted;
    } else if (key === '/') {
      event.preventDefault();
      els.search.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      els.video.volume = Math.min(1, els.video.volume + 0.1);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      els.video.volume = Math.max(0, els.video.volume - 0.1);
    }
  });
}

/* ============================================================
   Старт
   ============================================================ */

function renderExamples() {
  for (const example of EXAMPLES) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.textContent = example.label;
    chip.title = example.url;
    chip.addEventListener('click', () => {
      els.urlInput.value = example.url;
      loadPlaylistFromUrl(example.url);
    });
    els.examples.appendChild(chip);
  }
}

function initSettingsUI() {
  const settings = Store.getSettings();
  els.proxyToggle.checked = Boolean(settings.proxy);
  els.proxyTemplate.value = settings.proxyTemplate;
}

function init() {
  syncFavorites();
  bindEvents();
  renderExamples();
  renderSaved();
  renderMyLists();
  initSettingsUI();
  renderGroups();
  renderChannels();
  updatePlaylistBar();
  updateNowPlaying(null);

  const active = Store.getActive();
  if (!active) return;

  const cached = Store.getCache(active.id);
  if (cached && cached.length) {
    state.items = cached;
    state.playlist = { id: active.id, name: active.name, url: active.url };
    renderGroups();
    renderChannels();
    updatePlaylistBar();
    showChooseChannelOverlay(cached.length);
    if (active.url) {
      // Тихо обновляем список каналов в фоне.
      loadPlaylistFromUrl(active.url, { silent: true, name: active.name });
    }
  } else if (active.url) {
    loadPlaylistFromUrl(active.url, { silent: true, name: active.name });
  }
}

init();

// Отладочный доступ из консоли браузера (не влияет на работу сайта).
window.__iptv = { player, state, els };
