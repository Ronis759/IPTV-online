/**
 * Хранилище настроек, плейлистов и избранного в localStorage.
 * Всё лежит только в браузере пользователя.
 */

const NS = 'iptv.online.';
const KEY = {
  playlists: `${NS}playlists`,
  active: `${NS}active`,
  favorites: `${NS}favorites`,
  settings: `${NS}settings`,
  myListings: `${NS}myListings`,
  cache: `${NS}cache.`,
};

const MAX_LISTINGS = 20;

const MAX_PLAYLISTS = 15;
const MAX_CACHE_CHARS = 2_500_000;

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function remove(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

export const Store = {
  /* ---------- Плейлисты ---------- */

  getPlaylists() {
    const list = read(KEY.playlists, []);
    return Array.isArray(list) ? list : [];
  },

  savePlaylist(entry) {
    const list = this.getPlaylists().filter((item) => item.id !== entry.id);
    list.unshift({
      ...entry,
      addedAt: entry.addedAt || Date.now(),
      lastUsedAt: Date.now(),
    });
    const trimmed = list.slice(0, MAX_PLAYLISTS);
    // Удаляем кэш для выброшенных плейлистов.
    for (const dropped of list.slice(MAX_PLAYLISTS)) {
      if (dropped && dropped.id) remove(KEY.cache + dropped.id);
    }
    write(KEY.playlists, trimmed);
    return trimmed;
  },

  removePlaylist(id) {
    const list = this.getPlaylists().filter((item) => item.id !== id);
    write(KEY.playlists, list);
    remove(KEY.cache + id);
    const active = this.getActive();
    if (active && active.id === id) this.setActive(null);
    return list;
  },

  touchPlaylist(id) {
    const list = this.getPlaylists();
    const found = list.find((item) => item.id === id);
    if (!found) return;
    found.lastUsedAt = Date.now();
    write(KEY.playlists, list);
  },

  /* ---------- Активный плейлист ---------- */

  getActive() {
    return read(KEY.active, null);
  },

  setActive(active) {
    if (!active) remove(KEY.active);
    else write(KEY.active, active);
  },

  /* ---------- Кэш каналов ---------- */

  getCache(id) {
    const cached = read(KEY.cache + id, null);
    return cached && Array.isArray(cached.items) ? cached.items : null;
  },

  setCache(id, items) {
    const payload = { savedAt: Date.now(), items };
    let json;
    try {
      json = JSON.stringify(payload);
    } catch {
      return false;
    }
    if (json.length > MAX_CACHE_CHARS) return false;
    return write(KEY.cache + id, payload);
  },

  /* ---------- Избранное ---------- */

  getFavorites() {
    const list = read(KEY.favorites, []);
    return Array.isArray(list) ? list : [];
  },

  isFavorite(url) {
    return this.getFavorites().some((item) => item.url === url);
  },

  toggleFavorite(channel) {
    const list = this.getFavorites();
    const index = list.findIndex((item) => item.url === channel.url);
    if (index >= 0) {
      list.splice(index, 1);
      write(KEY.favorites, list);
      return false;
    }
    list.unshift({
      url: channel.url,
      name: channel.name,
      logo: channel.logo || '',
      group: channel.group || '',
      addedAt: Date.now(),
    });
    write(KEY.favorites, list);
    return true;
  },

  clearFavorites() {
    write(KEY.favorites, []);
  },

  /* ---------- Мои плейлисты (избранные каналы) ---------- */

  getListings() {
    const list = read(KEY.myListings, []);
    return Array.isArray(list) ? list : [];
  },

  saveListing(entry) {
    const list = this.getListings().filter((item) => item.id !== entry.id);
    list.unshift(entry);
    write(KEY.myListings, list.slice(0, MAX_LISTINGS));
    return this.getListings();
  },

  removeListing(id) {
    const list = this.getListings().filter((item) => item.id !== id);
    write(KEY.myListings, list);
    return list;
  },

  /* ---------- Настройки ---------- */

  getSettings() {
    return {
      proxy: false,
      proxyTemplate: 'https://corsproxy.io/?url={url}',
      ...read(KEY.settings, {}),
    };
  },

  saveSettings(settings) {
    write(KEY.settings, { ...this.getSettings(), ...settings });
  },

  /* ---------- Полная очистка ---------- */

  clearAll() {
    try {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith(NS)) keys.push(key);
      }
      keys.forEach((key) => localStorage.removeItem(key));
    } catch {
      /* ignore */
    }
  },
};
