/**
 * Перепроверка готового плейлиста verified.m3u: прогоняет ту же цепочку
 * (манифест → вариант → фрагмент) и выкидывает отвалившиеся каналы.
 *
 * Запуск: node tools/refresh-verified.mjs
 */

import fs from 'node:fs';
import path from 'node:path';

const ORIGIN = 'https://ronis759.github.io';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const TIMEOUT = 8000;
const CONCURRENCY = 20;
const MAX_TOTAL_MS = 4000;
const ROUNDS = 2;

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const FILE = path.join(ROOT, 'verified.m3u');

function parse(text) {
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/);
  const items = [];
  let pending = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^#EXTINF/i.test(line)) {
      pending = {
        rawExtinf: line,
        name: line.slice(line.lastIndexOf(',') + 1).trim(),
        group: (line.match(/group-title="([^"]*)"/i) || [])[1] || '',
        logo: (line.match(/tvg-logo="([^"]*)"/i) || [])[1] || '',
      };
      continue;
    }
    if (line.startsWith('#')) continue;
    if (!/^https?:\/\//i.test(line)) continue;
    items.push({ ...(pending || { rawExtinf: null, name: line, group: '', logo: '' }), url: line });
    pending = null;
  }
  return items;
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

async function probe(url) {
  const started = performance.now();
  try {
    const manifest = await get(url, { text: true });
    if (!manifest.ok || !/^#EXTM3U/i.test(manifest.text.trim()) || !manifest.cors) {
      return { ok: false, ms: Math.round(performance.now() - started), reason: 'манифест' };
    }
    let mediaUrl = manifest.finalUrl;
    let mediaText = manifest.text;
    if (/#EXT-X-STREAM-INF/i.test(manifest.text)) {
      const variantUrl = firstVariant(manifest.text, manifest.finalUrl);
      if (!variantUrl) return { ok: false, ms: 0, reason: 'нет варианта' };
      const variant = await get(variantUrl, { text: true });
      if (!variant.ok || !variant.cors || !/^#EXTM3U/i.test(variant.text.trim())) {
        return { ok: false, ms: Math.round(performance.now() - started), reason: 'вариант' };
      }
      mediaUrl = variant.finalUrl;
      mediaText = variant.text;
    }
    const segmentUrl = firstSegment(mediaText, mediaUrl);
    if (!segmentUrl) return { ok: false, ms: 0, reason: 'нет фрагмента' };
    const segment = await get(segmentUrl, { range: true });
    if (!segment.ok || !segment.cors || /text\/html/i.test(segment.type)) {
      return { ok: false, ms: Math.round(performance.now() - started), reason: 'фрагмент' };
    }
    const ms = Math.round(performance.now() - started);
    return ms <= MAX_TOTAL_MS
      ? { ok: true, ms, reason: '' }
      : { ok: false, ms, reason: 'медленно' };
  } catch (error) {
    return { ok: false, ms: Math.round(performance.now() - started), reason: error.name };
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

const channels = parse(fs.readFileSync(FILE, 'utf8'));
console.log(`В плейлисте ${channels.length} каналов. Раундов проверки: ${ROUNDS}`);

const alive = new Map();

for (let round = 1; round <= ROUNDS; round++) {
  const subset = round === 1 ? channels : channels.filter((c) => alive.has(c.url));
  console.log(`\nРаунд ${round}: проверяю ${subset.length}`);
  const results = await mapLimit(subset, CONCURRENCY, async (channel) => ({ channel, ...(await probe(channel.url)) }));

  for (const result of results) {
    if (result.ok) alive.set(result.channel.url, result.ms);
    else alive.delete(result.channel.url);
  }
  console.log(`  осталось рабочих: ${alive.size}`);
}

const kept = channels
  .filter((channel) => alive.has(channel.url))
  .sort((a, b) => (alive.get(a.url) || 0) - (alive.get(b.url) || 0));

const lines = [
  '#EXTM3U',
  '# Каналы проверены автоматически: https + CORS + рабочий манифест + видеофрагмент.',
  `# Проверено: ${new Date().toISOString().slice(0, 10)} · каналов: ${kept.length}`,
  '',
];
for (const channel of kept) {
  const fallback = channel.rawExtinf || `#EXTINF:-1 group-title="${channel.group}",${channel.name}`;
  lines.push(fallback);
  lines.push(channel.url);
}
fs.writeFileSync(FILE, `${lines.join('\n')}\n`, 'utf8');

const removed = channels.length - kept.length;
console.log(`\nУбрано отвалившихся: ${removed}`);
console.log(`В плейлисте осталось: ${kept.length}`);
console.log(`Файл: ${FILE}`);
