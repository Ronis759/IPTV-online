/**
 * Глубокая проверка каналов и сборка собственного плейлиста verified.m3u.
 *
 * Для каждого канала проверяется:
 *   1) мастер-манифест m3u8 (доступен, отдаёт #EXTM3U, есть CORS);
 *   2) вариант потока (если это master);
 *   3) первый видеофрагмент (доступен, CORS, не HTML-ошибка).
 *
 * Запуск: node tools/build-verified.mjs
 * Результат: verified.m3u + tools/verified-report.json
 */

import fs from 'node:fs';
import path from 'node:path';

const ORIGIN = 'https://ronis759.github.io';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const TIMEOUT = 8000;
const CONCURRENCY = 20;
const MAX_TOTAL_MS = 4000;
const MAX_CHANNELS = 400;

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

const SOURCES = [
  { id: 'ru', name: 'Россия', url: 'https://iptv-org.github.io/iptv/countries/ru.m3u', limit: Infinity },
  { id: 'rus', name: 'Русскоязычные', url: 'https://iptv-org.github.io/iptv/languages/rus.m3u', limit: Infinity },
  { id: 'by', name: 'Беларусь', url: 'https://iptv-org.github.io/iptv/countries/by.m3u', limit: Infinity },
  { id: 'kz', name: 'Казахстан', url: 'https://iptv-org.github.io/iptv/countries/kz.m3u', limit: Infinity },
  { id: 'news', name: 'Новости', url: 'https://iptv-org.github.io/iptv/categories/news.m3u', limit: 150 },
  { id: 'music', name: 'Музыка', url: 'https://iptv-org.github.io/iptv/categories/music.m3u', limit: 120 },
  { id: 'movies', name: 'Кино', url: 'https://iptv-org.github.io/iptv/categories/movies.m3u', limit: 100 },
  { id: 'sport', name: 'Спорт', url: 'https://iptv-org.github.io/iptv/categories/sports.m3u', limit: 100 },
  { id: 'kids', name: 'Детские', url: 'https://iptv-org.github.io/iptv/categories/kids.m3u', limit: 80 },
  { id: 'free-tv', name: 'Free-TV', url: 'https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8', limit: 150 },
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
    item.name = (item.name || item.url).replace(/\s*\[[^\]]*\]\s*/g, ' ').trim();
    items.push(item);
  }
  return items;
}

function sample(items, limit) {
  if (!Number.isFinite(limit) || items.length <= limit) return items.slice();
  const step = items.length / limit;
  const out = [];
  for (let i = 0; i < limit; i++) out.push(items[Math.floor(i * step)]);
  return out;
}

function corsOk(value) {
  const v = (value || '').toLowerCase();
  return v === '*' || v.includes('ronis759');
}

async function get(url, { text = false, range = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const headers = { Origin: ORIGIN, 'User-Agent': UA, Accept: '*/*' };
    if (range) headers.Range = 'bytes=0-2047';
    const res = await fetch(url, { headers, signal: controller.signal, redirect: 'follow' });
    const result = {
      ok: res.ok,
      status: res.status,
      cors: corsOk(res.headers.get('access-control-allow-origin')),
      type: res.headers.get('content-type') || '',
      finalUrl: res.url || url,
      text: '',
    };
    if (text && res.ok) result.text = await res.text();
    else {
      try { await res.body?.cancel(); } catch { /* ignore */ }
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}

function firstVariant(manifest, baseUrl) {
  const lines = manifest.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!/^#EXT-X-STREAM-INF/i.test(lines[i].trim())) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j].trim();
      if (!line || line.startsWith('#')) continue;
      try { return new URL(line, baseUrl).href; } catch { return null; }
    }
  }
  return null;
}

function firstSegment(mediaPlaylist, baseUrl) {
  for (const raw of mediaPlaylist.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    try { return new URL(line, baseUrl).href; } catch { return null; }
  }
  return null;
}

async function deepProbe(channel) {
  const started = performance.now();
  const steps = { manifest: false, variant: false, segment: false, cors: false };
  try {
    const manifest = await get(channel.url, { text: true });
    if (!manifest.ok || !/^#EXTM3U/i.test(manifest.text.trim())) {
      return { ok: false, ms: Math.round(performance.now() - started), steps, reason: 'манифест' };
    }
    steps.manifest = true;
    steps.cors = manifest.cors;
    if (!manifest.cors) return { ok: false, ms: Math.round(performance.now() - started), steps, reason: 'CORS манифеста' };

    let mediaUrl = channel.url;
    let mediaText = manifest.text;

    if (/#EXT-X-STREAM-INF/i.test(manifest.text)) {
      const variantUrl = firstVariant(manifest.text, channel.url);
      if (!variantUrl) return { ok: false, ms: Math.round(performance.now() - started), steps, reason: 'нет варианта' };
      const variant = await get(variantUrl, { text: true });
      if (!variant.ok || !/^#EXTM3U/i.test(variant.text.trim())) {
        return { ok: false, ms: Math.round(performance.now() - started), steps, reason: 'вариант' };
      }
      steps.variant = true;
      if (!variant.cors) return { ok: false, ms: Math.round(performance.now() - started), steps, reason: 'CORS варианта' };
      mediaUrl = variant.finalUrl || variantUrl;
      mediaText = variant.text;
    }

    const segmentUrl = firstSegment(mediaText, mediaUrl);
    if (!segmentUrl) return { ok: false, ms: Math.round(performance.now() - started), steps, reason: 'нет фрагмента' };

    const segment = await get(segmentUrl, { range: true });
    if (!segment.ok || /text\/html/i.test(segment.type)) {
      return { ok: false, ms: Math.round(performance.now() - started), steps, reason: 'фрагмент' };
    }
    steps.segment = true;
    if (!segment.cors) return { ok: false, ms: Math.round(performance.now() - started), steps, reason: 'CORS фрагмента' };

    const ms = Math.round(performance.now() - started);
    return { ok: ms <= MAX_TOTAL_MS, ms, steps, reason: ms > MAX_TOTAL_MS ? 'медленно' : '' };
  } catch (error) {
    return { ok: false, ms: Math.round(performance.now() - started), steps, reason: error.name };
  }
}

async function mapLimit(list, limit, worker) {
  const results = new Array(list.length);
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (index < list.length) {
      const current = index++;
      results[current] = await worker(list[current], current);
    }
  });
  await Promise.all(runners);
  return results;
}

const seen = new Set();
const candidates = [];
const sourceStats = [];

for (const source of SOURCES) {
  process.stdout.write(`\n=== ${source.name}: `);
  let text;
  try {
    const res = await fetch(source.url, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = await res.text();
  } catch (error) {
    console.log(`не удалось скачать (${error.message})`);
    continue;
  }

  const items = parsePlaylist(text);
  const https = items.filter((item) => item.url.startsWith('https://'));
  const picked = sample(https, source.limit);

  let added = 0;
  for (const item of picked) {
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    candidates.push({ ...item, source: source.id, sourceName: source.name });
    added++;
  }
  console.log(`каналов ${items.length}, https ${https.length}, к проверке +${added}`);
  sourceStats.push({ ...source, total: items.length, https: https.length, picked: picked.length, added });
}

console.log(`\nВсего уникальных каналов к глубокой проверке: ${candidates.length}`);

let done = 0;
const results = await mapLimit(candidates, CONCURRENCY, async (channel) => {
  const probe = await deepProbe(channel);
  done++;
  if (done % 25 === 0) process.stdout.write(`\r  проверено ${done}/${candidates.length}   `);
  return { ...channel, ...probe };
});
process.stdout.write(`\r  проверено ${done}/${candidates.length}\n`);

const working = results.filter((r) => r.ok).sort((a, b) => a.ms - b.ms);
console.log(`\nРабочих каналов: ${working.length} из ${results.length}`);

const bySource = new Map();
for (const channel of working) {
  const key = channel.sourceName;
  bySource.set(key, (bySource.get(key) || 0) + 1);
}
console.log('\nРабочие по источникам:');
for (const [name, count] of [...bySource.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${name}: ${count}`);
}

const chosen = working.slice(0, MAX_CHANNELS);

const lines = [
  '#EXTM3U',
  '# Плейлист собран автоматически: только каналы с рабочим https-потоком, CORS и быстрым откликом.',
  `# Проверено: ${new Date().toISOString().slice(0, 10)} · каналов: ${chosen.length}`,
  '',
];

for (const channel of chosen) {
  const group = channel.group || channel.sourceName || 'Разное';
  const name = channel.name || 'Канал';
  const attrs = [`tvg-name="${name.replace(/"/g, "'")}"`, `group-title="${group.replace(/"/g, "'")}"`];
  if (channel.logo) attrs.unshift(`tvg-logo="${channel.logo}"`);
  lines.push(`#EXTINF:-1 ${attrs.join(' ')},${name}`);
  lines.push(channel.url);
}

const outFile = path.join(ROOT, 'verified.m3u');
fs.writeFileSync(outFile, `${lines.join('\n')}\n`, 'utf8');

const report = {
  generatedAt: new Date().toISOString(),
  checked: results.length,
  working: working.length,
  written: chosen.length,
  maxTotalMs: MAX_TOTAL_MS,
  sources: sourceStats.map((s) => ({
    name: s.name,
    url: s.url,
    total: s.total,
    https: s.https,
    checked: s.picked,
    working: working.filter((c) => c.source === s.id).length,
  })),
  channels: chosen.map((c) => ({
    name: c.name, group: c.group, logo: c.logo, url: c.url, ms: c.ms, source: c.sourceName,
  })),
  failedReasons: Object.fromEntries(
    Object.entries(
      results.filter((r) => !r.ok).reduce((acc, r) => {
        acc[r.reason || 'другое'] = (acc[r.reason || 'другое'] || 0) + 1;
        return acc;
      }, {}),
    ).sort((a, b) => b[1] - a[1]),
  ),
};
fs.writeFileSync(path.join(ROOT, 'tools', 'verified-report.json'), JSON.stringify(report, null, 2), 'utf8');

console.log(`\nПлейлист: ${outFile}`);
console.log(`Отчёт: ${path.join(ROOT, 'tools', 'verified-report.json')}`);
console.log('Причины отказов:', JSON.stringify(report.failedReasons));
