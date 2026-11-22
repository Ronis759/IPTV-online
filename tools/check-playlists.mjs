/**
 * Проверка публичных M3U-плейлистов: доступность каналов, https, CORS и скорость.
 *
 * Запуск:  node tools/check-playlists.mjs
 * Результат: tools/check-result.json и краткая сводка в консоли.
 */

import fs from 'node:fs';
import path from 'node:path';

const ORIGIN = 'https://ronis759.github.io';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const TIMEOUT = 7000;
const CONCURRENCY = 24;
const SAMPLE_PER_PLAYLIST = 100;

const PLAYLISTS = [
  { id: 'ru', name: 'Россия', url: 'https://iptv-org.github.io/iptv/countries/ru.m3u' },
  { id: 'ua', name: 'Украина', url: 'https://iptv-org.github.io/iptv/countries/ua.m3u' },
  { id: 'by', name: 'Беларусь', url: 'https://iptv-org.github.io/iptv/countries/by.m3u' },
  { id: 'kz', name: 'Казахстан', url: 'https://iptv-org.github.io/iptv/countries/kz.m3u' },
  { id: 'rus-lang', name: 'Русскоязычные', url: 'https://iptv-org.github.io/iptv/languages/rus.m3u' },
  { id: 'news', name: 'Новости', url: 'https://iptv-org.github.io/iptv/categories/news.m3u' },
  { id: 'movies', name: 'Кино', url: 'https://iptv-org.github.io/iptv/categories/movies.m3u' },
  { id: 'music', name: 'Музыка', url: 'https://iptv-org.github.io/iptv/categories/music.m3u' },
  { id: 'sport', name: 'Спорт', url: 'https://iptv-org.github.io/iptv/categories/sports.m3u' },
  { id: 'kids', name: 'Детские', url: 'https://iptv-org.github.io/iptv/categories/kids.m3u' },
  { id: 'de', name: 'Германия', url: 'https://iptv-org.github.io/iptv/countries/de.m3u' },
  { id: 'free-tv', name: 'Free-TV', url: 'https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8' },
];

function parsePlaylist(text) {
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/);
  const items = [];
  let pending = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^#EXTINF/i.test(line)) {
      const comma = line.lastIndexOf(',');
      const name = comma >= 0 ? line.slice(comma + 1).trim() : '';
      const logo = (line.match(/tvg-logo="([^"]*)"/i) || [])[1] || '';
      const group = (line.match(/group-title="([^"]*)"/i) || [])[1] || '';
      pending = { name, logo, group };
      continue;
    }
    if (line.startsWith('#')) continue;
    if (!/^https?:\/\//i.test(line)) continue;
    const item = pending || { name: '', logo: '', group: '' };
    pending = null;
    item.url = line;
    item.name = item.name || item.url;
    items.push(item);
  }
  return items;
}

function sample(items, limit) {
  if (items.length <= limit) return items.slice();
  const step = items.length / limit;
  const out = [];
  for (let i = 0; i < limit; i++) out.push(items[Math.floor(i * step)]);
  return out;
}

async function probe(channel) {
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const res = await fetch(channel.url, {
      headers: { Origin: ORIGIN, 'User-Agent': UA, Accept: '*/*' },
      signal: controller.signal,
      redirect: 'follow',
    });
    const ms = Math.round(performance.now() - started);
    const cors = (res.headers.get('access-control-allow-origin') || '').trim();
    const contentType = res.headers.get('content-type') || '';

    let ok = res.ok;
    let note = '';
    if (ok) {
      const looksM3u8 = /mpegurl|m3u8/i.test(contentType) || /\.m3u8?(\?|$)/i.test(channel.url);
      if (looksM3u8) {
        const text = (await res.text()).slice(0, 8000);
        ok = /^#EXTM3U/i.test(text.trim());
        if (!ok) note = 'не m3u8';
      } else {
        try { await res.body?.cancel(); } catch { /* ignore */ }
      }
    }

    return {
      ok,
      ms,
      status: res.status,
      cors: cors === '*' ? 'yes' : cors ? 'other' : 'no',
      contentType,
      note,
      name: channel.name,
      group: channel.group,
      url: channel.url,
    };
  } catch (error) {
    return {
      ok: false,
      ms: Math.round(performance.now() - started),
      cors: 'no',
      error: error.name,
      name: channel.name,
      group: channel.group,
      url: channel.url,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function mapLimit(list, limit, worker) {
  const results = new Array(list.length);
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (index < list.length) {
      const current = index++;
      results[current] = await worker(list[current]);
    }
  });
  await Promise.all(runners);
  return results;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function statsFor(results) {
  const tested = results.length;
  const alive = results.filter((r) => r.ok);
  const corsOk = alive.filter((r) => r.cors === 'yes');
  const fast = corsOk.filter((r) => r.ms <= 1500);
  return {
    tested,
    alive: alive.length,
    corsOk: corsOk.length,
    fast: fast.length,
    medianMs: median(corsOk.map((r) => r.ms)),
    aliveShare: tested ? Math.round((alive.length / tested) * 100) : 0,
    playableShare: tested ? Math.round((corsOk.length / tested) * 100) : 0,
  };
}

const output = [];
const report = [];

for (const playlist of PLAYLISTS) {
  process.stdout.write(`\n=== ${playlist.name} (${playlist.url})\n`);

  let text;
  try {
    const res = await fetch(playlist.url, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = await res.text();
  } catch (error) {
    console.log(`  не удалось скачать: ${error.message}`);
    output.push({ ...playlist, error: error.message });
    continue;
  }

  const items = parsePlaylist(text);
  const https = items.filter((item) => item.url.startsWith('https://'));
  const picked = sample(https, SAMPLE_PER_PLAYLIST);

  console.log(`  каналов: ${items.length}, из них https: ${https.length}, проверяю: ${picked.length}`);

  const results = await mapLimit(picked, CONCURRENCY, probe);
  const stats = statsFor(results);
  const playable = results
    .filter((r) => r.ok && r.cors === 'yes')
    .sort((a, b) => a.ms - b.ms)
    .slice(0, 12)
    .map((r) => ({ name: r.name, group: r.group, ms: r.ms, url: r.url }));

  output.push({ ...playlist, total: items.length, https: https.length, stats, playable, results });
  report.push({ ...playlist, total: items.length, https: https.length, ...stats });

  console.log(`  живых: ${stats.alive}/${stats.tested}, с CORS: ${stats.corsOk}, быстрых (<=1.5с): ${stats.fast}, медиана ${stats.medianMs} мс`);
}

const outFile = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'check-result.json');
fs.writeFileSync(outFile, JSON.stringify({ generatedAt: new Date().toISOString(), origin: ORIGIN, playlists: output, report }, null, 2));

console.log('\n\n=== СВОДКА ===');
for (const row of report.sort((a, b) => b.corsOk - a.corsOk)) {
  console.log(
    `${row.name.padEnd(16)} всего ${String(row.total).padStart(5)}  https ${String(row.https).padStart(5)}  ` +
    `проверено ${String(row.tested).padStart(3)}  живых ${String(row.alive).padStart(3)}  ` +
    `CORS ${String(row.corsOk).padStart(3)}  быстрых ${String(row.fast).padStart(3)}  медиана ${row.medianMs} мс`,
  );
}
console.log(`\nФайл: ${outFile}`);
