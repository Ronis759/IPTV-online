/**
 * Разбор M3U / M3U8 плейлистов.
 * Поддерживаются атрибуты tvg-*, group-title, #EXTGRP, #EXTVLCOPT, #KODIPROP.
 */

const ATTR_RE = /([\w-]+)\s*=\s*"([^"]*)"/g;

/** Ищет запятую, разделяющую атрибуты и название канала (вне кавычек). */
function findNameComma(line) {
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ',' && !inQuotes) return i;
  }
  return -1;
}

/** Разбирает строку #EXTINF. */
export function parseExtinf(line) {
  const channel = {
    name: '',
    logo: '',
    group: '',
    tvgId: '',
    tvgName: '',
    vlc: {},
    kodi: {},
  };

  const comma = findNameComma(line);
  const head = comma === -1 ? line : line.slice(0, comma);
  if (comma !== -1) channel.name = line.slice(comma + 1).trim();

  let match;
  ATTR_RE.lastIndex = 0;
  while ((match = ATTR_RE.exec(head))) {
    const key = match[1].toLowerCase();
    const value = match[2].trim();
    if (key === 'tvg-logo') channel.logo = value;
    else if (key === 'tvg-name') channel.tvgName = value;
    else if (key === 'tvg-id') channel.tvgId = value;
    else if (key === 'group-title' || key === 'group') channel.group = value;
  }

  return channel;
}

function resolveUrl(raw, baseUrl) {
  const value = raw.trim();
  if (!value) return '';
  if (/^(https?|rtmp|rtsp|udp|mms):/i.test(value)) return value;
  if (!baseUrl) return '';
  try {
    return new URL(value, baseUrl).href;
  } catch {
    return '';
  }
}

function nameFromUrl(url) {
  try {
    const path = new URL(url).pathname;
    const last = decodeURIComponent(path.split('/').filter(Boolean).pop() || '');
    return last.replace(/\.(m3u8?|mp4|ts|txt)$/i, '') || url;
  } catch {
    return url;
  }
}

/**
 * @param {string} text содержимое плейлиста
 * @param {string} [baseUrl] адрес плейлиста (для относительных ссылок)
 * @returns {{items: Array, isHlsMedia: boolean, skipped: number}}
 */
export function parsePlaylist(text, baseUrl = '') {
  const items = [];
  const seen = new Set();
  let pending = null;
  let isHlsMedia = false;
  let skipped = 0;

  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (/^#EXTM3U/i.test(line)) continue;

    if (/^#EXTINF/i.test(line)) {
      pending = parseExtinf(line);
      continue;
    }

    if (/^#EXTGRP\s*:/i.test(line)) {
      if (pending) pending.group = line.slice(line.indexOf(':') + 1).trim();
      continue;
    }

    if (/^#EXTVLCOPT\s*:/i.test(line)) {
      if (pending) {
        const opt = line.slice(line.indexOf(':') + 1).trim();
        const eq = opt.indexOf('=');
        if (eq > 0) pending.vlc[opt.slice(0, eq).trim().toLowerCase()] = opt.slice(eq + 1).trim();
      }
      continue;
    }

    if (/^#KODIPROP\s*:/i.test(line)) {
      if (pending) {
        const opt = line.slice(line.indexOf(':') + 1).trim();
        const eq = opt.indexOf('=');
        if (eq > 0) pending.kodi[opt.slice(0, eq).trim().toLowerCase()] = opt.slice(eq + 1).trim();
      }
      continue;
    }

    if (/^#EXT-X-/i.test(line)) {
      // Признак того, что это медиаплейлист HLS, а не список каналов.
      isHlsMedia = true;
      continue;
    }

    if (line.startsWith('#')) continue;

    const url = resolveUrl(line, baseUrl);
    if (!url) {
      skipped++;
      continue;
    }

    const channel = pending || { name: '', logo: '', group: '', tvgId: '', tvgName: '', vlc: {}, kodi: {} };
    pending = null;

    if (!/^https?:/i.test(url)) {
      // rtsp/udp/mms браузер воспроизвести не может.
      skipped++;
      continue;
    }

    channel.url = url;
    channel.name = (channel.name || channel.tvgName || nameFromUrl(url)).trim();
    channel.group = (channel.group || '').trim();
    channel.id = `${url}|${channel.name}`;

    if (seen.has(channel.id)) continue;
    seen.add(channel.id);
    items.push(channel);
  }

  return { items, isHlsMedia, skipped };
}

/** Понятное имя плейлиста из его адреса. */
export function guessPlaylistName(url) {
  try {
    const parsed = new URL(url);
    const last = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '');
    const name = last.replace(/\.(m3u8?|txt)$/i, '');
    return name || parsed.hostname.replace(/^www\./, '');
  } catch {
    return 'Плейлист';
  }
}
