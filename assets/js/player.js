/**
 * Движок воспроизведения: HLS (hls.js), MPEG-TS (mpegts.js) и обычные файлы (mp4/webm).
 * Сообщает о состоянии через CustomEvent: loading, playing, buffering, levels, level, error, blocked.
 */

const HLS_EXT = new Set(['m3u8', 'm3u']);
const TS_EXT = new Set(['ts', 'mts', 'm2ts']);

function extOf(url) {
  try {
    const match = new URL(url).pathname.match(/\.([a-z0-9]+)$/i);
    return match ? match[1].toLowerCase() : '';
  } catch {
    return '';
  }
}

const MESSAGES = {
  network: 'Поток не открылся. Ссылка не работает или сервер запрещает воспроизведение с другого сайта (CORS).',
  media: 'Поток повреждён или формат не поддерживается браузером.',
  unsupported: 'Браузер не умеет воспроизводить такой поток.',
};

export class Player extends EventTarget {
  constructor(video) {
    super();
    this.video = video;
    this.hls = null;
    this.mpegts = null;
    this.current = null;
    this._networkRetries = 0;
    this._mediaRetries = 0;
    this._triedNative = false;
    this._levels = [];

    this.video.addEventListener('playing', () => this._emit('playing', this.current));
    this.video.addEventListener('waiting', () => this._emit('buffering', this.current));
    this.video.addEventListener('error', () => {
      if (this.hls || this.mpegts) return;
      if (!this.video.currentSrc) return;
      this._fail(MESSAGES.network);
    });
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  _fail(message) {
    this._emit('error', { message, channel: this.current });
  }

  _tryPlay() {
    const attempt = this.video.play();
    if (attempt && typeof attempt.catch === 'function') {
      attempt.catch((err) => {
        if (err && err.name === 'NotAllowedError') this._emit('blocked', this.current);
      });
    }
  }

  play(channel) {
    this.stop();
    this.current = channel;
    this._emit('loading', channel);

    const ext = extOf(channel.url);
    const nativeHls = this.video.canPlayType('application/vnd.apple.mpegurl');
    const hlsSupported = Boolean(window.Hls && window.Hls.isSupported());

    if (HLS_EXT.has(ext) || ext === '') {
      if (hlsSupported) return this._playHls(channel);
      if (nativeHls) return this._playNative(channel);
      return this._fail(MESSAGES.unsupported);
    }

    if (TS_EXT.has(ext)) {
      if (window.mpegts && window.mpegts.isSupported()) return this._playMpegts(channel);
      return this._playNative(channel);
    }

    return this._playNative(channel);
  }

  _playHls(channel) {
    const Hls = window.Hls;
    const hls = new Hls({
      enableWorker: true,
      lowLatencyMode: true,
      backBufferLength: 90,
      manifestLoadingTimeOut: 15000,
      levelLoadingTimeOut: 15000,
      fragLoadingTimeOut: 30000,
    });

    this.hls = hls;
    this._networkRetries = 0;
    this._mediaRetries = 0;

    hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
      this._levels = (data.levels || []).map((level) => ({
        height: level.height || 0,
        bitrate: level.bitrate || 0,
      }));
      this._emit('levels', this._levels);
      this._tryPlay();
    });

    hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
      this._emit('level', data.level);
    });

    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (!data.fatal) return;

      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        const isManifestError = /manifest/i.test(data.details || '');
        if (!isManifestError && this._networkRetries < 1) {
          this._networkRetries++;
          hls.startLoad();
          return;
        }
        // Для ссылок без расширения пробуем открыть как обычный файл.
        if (extOf(channel.url) === '' && !this._triedNative) {
          this._triedNative = true;
          this._destroyHls();
          this._playNative(channel);
          return;
        }
        this._fail(MESSAGES.network);
        this._destroyHls();
        return;
      }

      if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        if (this._mediaRetries < 1) {
          this._mediaRetries++;
          hls.recoverMediaError();
          return;
        }
        this._fail(MESSAGES.media);
        this._destroyHls();
        return;
      }

      this._fail(MESSAGES.network);
      this._destroyHls();
    });

    hls.attachMedia(this.video);
    hls.loadSource(channel.url);
  }

  _playMpegts(channel) {
    const mpegts = window.mpegts;
    const instance = mpegts.createPlayer(
      { type: 'mpegts', url: channel.url, isLive: true, cors: true },
      { enableWorker: true, liveBufferLatencyChasing: true, lazyLoad: false },
    );

    this.mpegts = instance;
    instance.on(mpegts.Events.ERROR, () => {
      this._fail(MESSAGES.network);
    });
    instance.attachMediaElement(this.video);
    instance.load();
    this._tryPlay();
  }

  _playNative(channel) {
    this.video.src = channel.url;
    this._tryPlay();
  }

  _destroyHls() {
    if (!this.hls) return;
    try {
      this.hls.destroy();
    } catch {
      /* ignore */
    }
    this.hls = null;
  }

  _destroyMpegts() {
    if (!this.mpegts) return;
    try {
      this.mpegts.pause();
      this.mpegts.unload();
      this.mpegts.detachMediaElement();
      this.mpegts.destroy();
    } catch {
      /* ignore */
    }
    this.mpegts = null;
  }

  /** Установка качества: -1 — авто, иначе индекс уровня. */
  setLevel(index) {
    if (!this.hls) return;
    this.hls.currentLevel = index;
  }

  stop() {
    this._destroyHls();
    this._destroyMpegts();
    this._levels = [];
    try {
      this.video.pause();
      this.video.removeAttribute('src');
      this.video.load();
    } catch {
      /* ignore */
    }
  }
}
