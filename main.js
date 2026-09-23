// Kinopub для Movian. Чистый ES5 (Duktape): без let/const, стрелок и шаблонных строк.

var page = require('movian/page');
var http = require('movian/http');
var store = require('movian/store');
var settings = require('movian/settings');
var service = require('movian/service');
var popup = require('movian/popup');
var prop = require('movian/prop');

var PREFIX = 'kinopub';
var PLUGIN_VERSION = '0.3.10';   // make check сверяет с plugin.json
var DEFAULT_BOOT = 'https://1abab.ru';
var FALLBACK_API = 'https://api.boramoraboom.ru';
var CLIENT_ID = 'xbmc';
var CLIENT_SECRET = 'cgg3gtifu46urtfp2zp1nqtba0k2ezxh';
var PER_PAGE = 30;

var auth = store.create('auth');   // access, refresh, expires
var conf = store.create('config'); // apiHost, apiTs, apiSource

// ---------------------------------------------------------------- настройки

var bootUrl = DEFAULT_BOOT;
var apiOverride = '';
var apiBase = conf.apiHost || FALLBACK_API;
var quality = '1080p';
var proto = 'hls4';
var preferVoice = '';
var subsAuto = false;
var syncProgress = true;
var lastVoiceName = null;
var voiceNames = [];      // названия дорожек в порядке манифеста: hls:N -> voiceNames[N-1]

try {
  var cfg = new settings.globalSettings(PREFIX, 'Kinopub', Plugin.path + 'icon.png', 'Клиент kino.pub');
  cfg.createString('bootUrl', 'Адрес конфигурации (как плейлист в MicroIPTV)', DEFAULT_BOOT, function(v) {
    bootUrl = (v || DEFAULT_BOOT).replace(/\/+$/, '');
  });
  cfg.createString('apiOverride', 'Адрес API вручную (пусто = определять автоматически)', '', function(v) {
    apiOverride = (v || '').replace(/\/+$/, '');
    apiBase = apiOverride || conf.apiHost || FALLBACK_API;
  });
  cfg.createAction('refreshHost', 'Обновить адрес API сейчас', function() {
    resolveApiHost(true, function(err, host, src) {
      popup.notify(err ? 'Kinopub: ' + err : 'Kinopub API: ' + host + ' (' + src + ')', 6);
    });
  });
  cfg.createMultiOpt('quality', 'Максимальное качество', [
    ['1080p', '1080p', true],
    ['720p', '720p'],
    ['480p', '480p']
  ], function(v) { quality = v; });
  cfg.createMultiOpt('proto', 'Протокол видео', [
    ['hls4', 'HLS4: все озвучки, качество подбирается автоматически', true],
    ['hls', 'HLS: одна озвучка, качество из настройки выше'],
    ['http', 'MP4 по HTTP: одна озвучка, качество из настройки выше']
  ], function(v) { proto = v; });
  cfg.createString('voice', 'Предпочитаемая озвучка (часть названия, например LostFilm)', '', function(v) {
    preferVoice = (v || '').toLowerCase();
  });
  cfg.createBool('subsauto', 'Включать субтитры автоматически (иначе выбор в плеере)', false, function(v) {
    subsAuto = !!v;
  });
  cfg.createBool('sync', 'Отправлять позицию просмотра на kino.pub', true, function(v) { syncProgress = !!v; });
  cfg.createAction('logout', 'Выйти из аккаунта (сбросить токены)', function() {
    clearAuth();
    popup.notify('Kinopub: токены удалены', 4);
  });
} catch (e) {
  console.log('[kinopub] settings failed: ' + e);
}

service.create('Kinopub', PREFIX + ':start', 'video', true, Plugin.path + 'icon.png');

// ---------------------------------------------------------------- адрес API

// XOR hex-строки с ключом, как в getByKey() из бандла Apple TV-клиента Kinopub
function xorHex(hex, key) {
  var out = '';
  for (var i = 0; i * 2 < hex.length; i++) {
    out += String.fromCharCode(parseInt(hex.substr(i * 2, 2), 16) ^ (key.charCodeAt(i % key.length) % 255));
  }
  return out;
}

// Ходим по редиректам сами и запоминаем #a=/#u= из Location: короткие ссылки
// Kinopub передают зашифрованный адрес именно во фрагменте.
function followBoot(url) {
  var hash = null;
  for (var i = 0; i < 6; i++) {
    var h = /#(.*)$/.exec(url);
    if (h) { hash = h[1]; url = url.replace(/#.*$/, ''); }
    var r = http.request(url, { headRequest: true, noFail: true, noFollow: true });
    var loc = r.headers_lc['location'];
    if ((r.statuscode >= 300 && r.statuscode < 400) && loc) { url = loc; continue; }
    return { url: url, hash: hash, status: r.statuscode };
  }
  return { url: url, hash: hash, status: 0 };
}

function hashParam(hash, name) {
  if (!hash) return null;
  var m = new RegExp('(?:^|&)' + name + '=([0-9a-fA-F]+)').exec(hash);
  return m ? m[1] : null;
}

// Возвращает {host, source} или бросает ошибку
function discoverApiHost() {
  var b = followBoot(bootUrl);
  var bundleUrl = /\.js(\?|$)/.test(b.url) ? b.url : b.url.replace(/\/+$/, '') + '/application.js';
  var res = http.request(bundleUrl, { noFail: true });
  if (res.statuscode !== 200) throw new Error('бандл ' + bundleUrl + ': HTTP ' + res.statuscode);
  var js = res.toString();
  var sm = /clientSecret:"([^"]+)"/.exec(js);
  if (!sm) throw new Error('в бандле нет clientSecret');
  var secret = sm[1];

  var a = hashParam(b.hash, 'a');
  if (a) return { host: xorHex(a, secret), source: 'ссылка #a' };
  var u = hashParam(b.hash, 'u');
  if (u) return { host: xorHex(u, secret) + '/api', source: 'ссылка #u' };

  var gm = /getByKey\("([0-9a-fA-F]+)"/.exec(js);
  if (gm) return { host: xorHex(gm[1], secret), source: 'бандл' };

  var pm = /proxyUrl:"([^"]+)"/.exec(js);
  if (pm) return { host: pm[1] + '/api', source: 'прокси по умолчанию' };
  throw new Error('адрес API в бандле не найден');
}

// Movian не умеет вернуть 401 кодом: без realm он бросает исключение с этим текстом
function isUnauthorized(e) {
  return /Authentication without realm/.test(String(e));
}

function checkApiHost(host) {
  try {
    var args = auth.access ? { access_token: auth.access } : {};
    var r = http.request(host + '/v1/types', { args: args, noFail: true, noAuth: true });
    return r.statuscode === 200 || r.statuscode === 401;
  } catch (e) {
    return isUnauthorized(e);   // 401 = сервер жив, это и нужно
  }
}

var resolving = false;
var lastResolveAt = 0;

// force=true — игнорировать кэш; cb(err, host, source)
function resolveApiHost(force, cb) {
  if (apiOverride) { if (cb) cb(null, apiOverride, 'вручную'); return; }
  var fresh = conf.apiHost && conf.apiTs && Date.now() - conf.apiTs < 12 * 3600 * 1000;
  if (!force && fresh) { if (cb) cb(null, conf.apiHost, 'кэш'); return; }
  if (resolving) { if (cb) cb(new Error('уже идёт'), null); return; }
  resolving = true;
  lastResolveAt = Date.now();
  setTimeout(function() {
    var err = null, found = null;
    try {
      found = discoverApiHost();
      if (!/^https?:\/\//.test(found.host)) throw new Error('странный адрес: ' + found.host);
      if (!checkApiHost(found.host)) throw new Error(found.host + ' не отвечает как API');
      conf.apiHost = found.host;
      conf.apiTs = Date.now();
      conf.apiSource = found.source;
      apiBase = found.host;
      console.log('[kinopub] API host: ' + found.host + ' (' + found.source + ')');
    } catch (e) {
      err = e;
      console.log('[kinopub] API host discovery failed: ' + e);
    }
    resolving = false;
    if (cb) cb(err, found && found.host, found && found.source);
  }, 1);
}

// Вызывается при сетевых ошибках API: не чаще раза в 10 минут
function apiFailed(where) {
  if (Date.now() - lastResolveAt < 10 * 60 * 1000) return;
  console.log('[kinopub] API failure at ' + where + ', re-discovering host');
  resolveApiHost(true, function(err, host) {
    if (!err && host) popup.notify('Kinopub: адрес API обновлён: ' + host, 5);
  });
}

// ---------------------------------------------------------------- OAuth

function clearAuth() {
  delete auth.access; delete auth.refresh; delete auth.expires;
}

function oauth(params, cb) {
  params.client_id = CLIENT_ID;
  params.client_secret = CLIENT_SECRET;
  var ctrl = { method: 'POST', postdata: params, noFail: true, noAuth: true };
  if (cb) {
    http.request(apiBase + '/oauth2/device', ctrl, function(err, res) {
      if (err) { apiFailed('oauth'); return cb({ status: 0, json: { error: String(err) } }); }
      cb(parseResponse(res));
    });
    return;
  }
  try {
    return parseResponse(http.request(apiBase + '/oauth2/device', ctrl));
  } catch (e) {
    apiFailed('oauth');
    throw e;
  }
}

function parseResponse(res) {
  var json = {};
  try { json = JSON.parse(res.toString()); } catch (e) { json = { error: 'bad json' }; }
  return { status: res.statuscode, json: json };
}

function saveTokens(t) {
  auth.access = t.access_token;
  auth.refresh = t.refresh_token;
  auth.expires = Date.now() + ((t.expires_in || 3600) - 60) * 1000;
}

function refreshTokens() {
  if (!auth.refresh) return false;
  var r = oauth({ grant_type: 'refresh_token', refresh_token: auth.refresh });
  if (r.status === 200 && r.json.access_token) { saveTokens(r.json); return true; }
  console.log('[kinopub] refresh failed: ' + r.status + ' ' + JSON.stringify(r.json));
  return false;
}

function haveAuth() {
  if (!auth.access) return false;
  if (Date.now() < auth.expires) return true;
  return refreshTokens();
}

// ---------------------------------------------------------------- API

function apiRequest(path, args) {
  args.access_token = auth.access;
  return http.request(apiBase + '/v1' + path, {
    args: args,
    headers: { Authorization: 'Bearer ' + auth.access },
    noFail: true, noAuth: true
  });
}

function api(path, args) {
  if (!haveAuth()) throw new Error('NOAUTH');
  args = args || {};
  var res;
  try {
    res = apiRequest(path, args);
  } catch (e) {
    if (!isUnauthorized(e)) { apiFailed(path); throw e; }
    // 401: пробуем обновить токен и повторить один раз
    if (!refreshTokens()) { clearAuth(); throw new Error('NOAUTH'); }
    try {
      res = apiRequest(path, args);
    } catch (e2) {
      if (isUnauthorized(e2)) { clearAuth(); throw new Error('NOAUTH'); }
      apiFailed(path); throw e2;
    }
  }
  if (res.statuscode === 401) { clearAuth(); throw new Error('NOAUTH'); }
  if (res.statuscode !== 200) throw new Error('API ' + res.statuscode + ' ' + path);
  return JSON.parse(res.toString());
}

function apiAsync(path, args, cb) {
  if (!haveAuth()) { if (cb) cb(new Error('NOAUTH'), null); return; }
  args = args || {};
  var retried = false;
  function go() {
    args.access_token = auth.access;
    http.request(apiBase + '/v1' + path, {
      args: args,
      headers: { Authorization: 'Bearer ' + auth.access },
      noFail: true, noAuth: true
    }, function(err, res) {
      if (err) {
        if (isUnauthorized(err) && !retried && refreshTokens()) { retried = true; go(); return; }
        if (!isUnauthorized(err)) apiFailed(path);
        if (cb) cb(err, null);
        return;
      }
      if (res.statuscode !== 200) { if (cb) cb(new Error('API ' + res.statuscode + ' ' + path), null); return; }
      var json = null;
      try { json = JSON.parse(res.toString()); } catch (e) { if (cb) cb(e, null); return; }
      if (cb) cb(null, json);
    });
  }
  go();
}

// Сведения об устройстве для «Мои устройства» на kino.pub: после активации и раз в сутки
function deviceInfo() {
  var ps3 = /^\/dev_hdd0\//.test(String(Core.storagePath || ''));
  return {
    title: ps3 ? 'Movian на PlayStation 3' : 'Movian',
    hardware: ps3 ? 'Sony PlayStation 3' : 'Unknown',
    software: 'Movian ' + (Core.currentVersionString || '?') + ', плагин kinopub ' + PLUGIN_VERSION
  };
}

function deviceNotify(force) {
  var info = deviceInfo();
  var stamp = info.software + '|' + info.hardware;
  if (!force && conf.notifyStamp === stamp && conf.notifyTs && Date.now() - conf.notifyTs < 24 * 3600 * 1000) return;
  if (!haveAuth()) return;
  http.request(apiBase + '/v1/device/notify', {
    method: 'POST',
    postdata: info,
    args: { access_token: auth.access },
    headers: { Authorization: 'Bearer ' + auth.access },
    noFail: true, noAuth: true
  }, function(err, res) {
    if (err || res.statuscode !== 200) {
      console.log('[kinopub] device/notify failed: ' + (err || ('HTTP ' + res.statuscode)));
      return;
    }
    conf.notifyStamp = stamp;
    conf.notifyTs = Date.now();
    console.log('[kinopub] device/notify ok: ' + JSON.stringify(info));
  });
}

// Единая обёртка страницы: ловит ошибки и отправляет на активацию при NOAUTH.
function guarded(fn) {
  return function(pg) {
    var args = Array.prototype.slice.call(arguments);
    try {
      fn.apply(null, args);
    } catch (e) {
      if (String(e).indexOf('NOAUTH') >= 0) {
        pg.redirect(PREFIX + ':activate');
      } else {
        console.log('[kinopub] ' + e);
        pg.error('Kinopub: ' + e);
      }
    }
  };
}

// ---------------------------------------------------------------- helpers

function poster(it, size) {
  return it && it.posters ? (it.posters[size] || it.posters.big || it.posters.medium) : null;
}

function fmtDuration(sec) {
  if (!sec) return null;
  var m = Math.round(sec / 60);
  return m >= 60 ? Math.floor(m / 60) + ' ч ' + (m % 60) + ' мин' : m + ' мин';
}

function describe(it, full) {
  var parts = [];
  if (it.year) parts.push(String(it.year));
  if (it.genres && it.genres.length) parts.push(it.genres.map(function(g) { return g.title; }).join(', '));
  if (it.countries && it.countries.length && full) parts.push(it.countries.map(function(c) { return c.title; }).join(', '));
  if (it.imdb_rating) parts.push('IMDb ' + it.imdb_rating);
  if (it.kinopoisk_rating) parts.push('КП ' + it.kinopoisk_rating);
  if (it.duration && it.duration.average && it.type !== 'movie') parts.push('серия ~' + fmtDuration(it.duration.average));
  else if (it.duration && it.duration.total) parts.push(fmtDuration(it.duration.total));
  if (it.quality) parts.push(it.quality + 'p');
  if (it.voice && !full) parts.push(it.voice);
  var out = parts.join(' · ');
  if (it.plot) out += '\n' + it.plot;
  if (full) {
    if (it.voice) out += '\nОзвучки: ' + it.voice;
    if (it.director) out += '\nРежиссёр: ' + it.director;
    if (it.cast) out += '\nВ ролях: ' + it.cast;
  }
  return out;
}

function isSerial(it) {
  return it.type === 'serial' || it.type === 'docuserial' || it.type === 'tvshow';
}

function watchlistTitle(inList) {
  return inList ? 'Kinopub: убрать из «Буду смотреть»' : 'Kinopub: добавить в «Буду смотреть»';
}

function toggleWatchlist(it, node) {
  apiAsync('/watching/togglewatchlist', { id: it.id }, function(err, r) {
    if (err) { popup.notify('Kinopub: ' + err, 4); return; }
    it.in_watchlist = !!r.watching;
    if (node) node.root.metadata.title = watchlistTitle(it.in_watchlist);
    popup.notify(it.in_watchlist ? 'Добавлено в «Буду смотреть»' : 'Убрано из «Буду смотреть»', 3);
  });
}

function appendCard(pg, it) {
  var item = pg.appendItem(PREFIX + ':item:' + it.id, 'directory', {
    title: it.title,
    icon: poster(it, 'big'),
    description: describe(it, false),
    year: it.year,
    rating: it.imdb_rating ? Math.round(it.imdb_rating * 10) : null
  });
  if (isSerial(it)) {
    var opt = item.addOptAction(watchlistTitle(it.in_watchlist), function() { toggleWatchlist(it, opt); });
  }
  return item;
}

// Постраничный список: fetcher(pageNo) -> {items, pagination}.
// Первая страница загружается сразу, paginator Movian вызывает при прокрутке.
function paged(pg, title, fetcher) {
  pg.type = 'directory';
  pg.metadata.title = title;
  var pageNo = 1;
  function loadNext() {
    var r = fetcher(pageNo);
    var items = r.items || [];
    items.forEach(function(it) { appendCard(pg, it); });
    console.log('[kinopub] ' + title + ': страница ' + pageNo + ', ' + items.length + ' шт.');
    pageNo++;
    var p = r.pagination || {};
    return items.length > 0 && !!p.current && !!p.total && p.current < p.total;
  }
  var more = loadNext();
  if (more) pg.paginator = loadNext;
  pg.loading = false;
}

function qualityRank(q) {
  return { '2160p': 4, '1080p': 3, '720p': 2, '480p': 1 }[q] || 0;
}

// Выбор файла: только h264, не выше выбранного качества, лучший из оставшихся.
function pickFile(files) {
  var best = null;
  (files || []).forEach(function(f) {
    if (f.codec && f.codec !== 'h264') return;
    if (qualityRank(f.quality) > qualityRank(quality)) return;
    if (!best || qualityRank(f.quality) > qualityRank(best.quality)) best = f;
  });
  if (!best && files && files.length) best = files[files.length - 1];
  return best;
}

function fileUrl(f) {
  var u = f.urls || f.url || {};
  if (proto === 'hls4') return u.hls4 || u.hls2 || u.hls || u.http || null;
  if (proto === 'hls') return u.hls || u.hls2 || u.hls4 || u.http || null;
  return u.http || u.hls || null;
}

// Название озвучки из описания в ответе API
function audioName(a, idx) {
  var parts = [];
  if (a.type && a.type.title) parts.push(a.type.title);
  if (a.author && a.author.title) parts.push(a.author.title);
  var name = parts.join('. ') || 'Дорожка';
  return (idx < 10 ? '0' + idx : '' + idx) + '. ' + name + (a.lang ? ' (' + a.lang.toUpperCase() + ')' : '');
}

function attr(line, key) {
  var m = new RegExp('(?:^|[:,])' + key + '=(?:"([^"]*)"|([^,]*))').exec(line);
  return m ? (m[1] !== undefined ? m[1] : m[2]) : null;
}

// Скачиваем манифест hls4 и переписываем: одна группа аудио на все качества,
// без субтитров и I-frame, нужная озвучка помечена DEFAULT. Возвращает hls:file:// URL.
function buildLocalManifest(url, wantIdx) {
  var res = http.request(url, { noFail: true });
  if (res.statuscode !== 200) throw new Error('manifest HTTP ' + res.statuscode);
  var text = res.toString();
  if (text.indexOf('#EXTM3U') !== 0) throw new Error('not a playlist');

  var lines = text.split(/\r?\n/);
  var out = ['#EXTM3U', '#EXT-X-VERSION:4'];
  var group = null;
  var tracks = 0;
  var matched = false;
  lastVoiceName = null;
  voiceNames = [];

  // Первый проход: аудио из первой группы
  lines.forEach(function(l) {
    if (l.indexOf('#EXT-X-MEDIA:') !== 0 || attr(l, 'TYPE') !== 'AUDIO') return;
    var g = attr(l, 'GROUP-ID');
    if (group === null) group = g;
    if (g !== group) return;
    var name = attr(l, 'NAME') || '';
    var idx = parseInt(name, 10);
    var hit = false;
    if (wantIdx) hit = idx === wantIdx;
    else if (preferVoice) hit = name.toLowerCase().indexOf(preferVoice) >= 0 && !matched;
    if (hit) { matched = true; lastVoiceName = name; }
    var flag = wantIdx || preferVoice ? (hit ? 'YES' : 'NO') : (attr(l, 'DEFAULT') || 'NO');
    l = l.replace(/,DEFAULT=(YES|NO)/, '').replace(/,AUTOSELECT=(YES|NO)/, '');
    l = l.replace('#EXT-X-MEDIA:', '#EXT-X-MEDIA:DEFAULT=' + flag + ',AUTOSELECT=' + flag + ',');
    out.push(l);
    voiceNames.push(name);
    tracks++;
  });
  if ((wantIdx || preferVoice) && !matched) {
    // ничего не совпало: вернуть исходные DEFAULT
    out = ['#EXTM3U', '#EXT-X-VERSION:4'];
    voiceNames = [];
    lines.forEach(function(l) {
      if (l.indexOf('#EXT-X-MEDIA:') === 0 && attr(l, 'TYPE') === 'AUDIO' && attr(l, 'GROUP-ID') === group) {
        out.push(l);
        voiceNames.push(attr(l, 'NAME') || '');
        if (attr(l, 'DEFAULT') === 'YES') lastVoiceName = attr(l, 'NAME');
      }
    });
  } else if (!matched) {
    lines.forEach(function(l) {
      if (l.indexOf('#EXT-X-MEDIA:') === 0 && attr(l, 'TYPE') === 'AUDIO' && attr(l, 'GROUP-ID') === group && attr(l, 'DEFAULT') === 'YES') lastVoiceName = attr(l, 'NAME');
    });
  }

  // Второй проход: варианты качества, все на одну группу аудио
  var pendingInf = null;
  lines.forEach(function(l) {
    if (l.indexOf('#EXT-X-STREAM-INF:') === 0) {
      l = l.replace(/,SUBTITLES="[^"]*"/, '');
      if (group) l = /AUDIO="/.test(l) ? l.replace(/AUDIO="[^"]*"/, 'AUDIO="' + group + '"') : l + ',AUDIO="' + group + '"';
      pendingInf = l;
    } else if (pendingInf && l && l.charAt(0) !== '#') {
      out.push(pendingInf); out.push(l); pendingInf = null;
    }
  });

  var nfs = require('native/fs');
  var dir = Core.storagePath + '/hls';
  nfs.mkdirs(dir);
  var path = dir + '/current.m3u8';
  require('fs').writeFileSync(path, out.join('\n') + '\n');
  console.log('[kinopub] local manifest: ' + tracks + ' audio, group ' + group + ', ' + out.length + ' lines -> ' + path);
  return 'hls:file://' + path;
}

// Заглушка «Без субтитров»: Movian всегда автоматически включает внешние субтитры,
// поэтому первой в список ставим пустую дорожку. Она выигрывает по очкам: тот же
// базовый балл, язык из настроек Movian (settings/i18n), а при равенстве очков
// побеждает URL, меньший по алфавиту, и file:// меньше https://.
function preferredSubLang() {
  try {
    var raw = require('fs').readFileSync(Core.storagePath + '/../../settings/i18n');
    var j = JSON.parse(String(raw));
    return j.subtitle1 || null;
  } catch (e) {
    return null;
  }
}

function noSubsTrack() {
  var nfs = require('native/fs');
  var dir = Core.storagePath + '/hls';
  nfs.mkdirs(dir);
  var path = dir + '/none.srt';
  try {
    require('fs').writeFileSync(path, '1\n00:00:00,000 --> 00:00:00,100\n \n');
  } catch (e) {
    console.log('[kinopub] none.srt: ' + e);
  }
  var t = { url: 'file://' + path, title: 'Без субтитров' };
  var lang = preferredSubLang();
  if (lang) t.language = lang;
  return t;
}

// Разворачиваем редиректы сами: Movian после 302 теряет поддержку диапазонов.
function resolveRedirects(url) {
  for (var i = 0; i < 5; i++) {
    var r;
    try {
      r = http.request(url, { headRequest: true, noFail: true, noFollow: true });
    } catch (e) {
      console.log('[kinopub] resolve failed: ' + e);
      return url;
    }
    var loc = r.headers_lc['location'];
    if ((r.statuscode === 301 || r.statuscode === 302 || r.statuscode === 303 || r.statuscode === 307) && loc) {
      console.log('[kinopub] redirect ' + r.statuscode + ' -> ' + loc);
      url = loc;
      continue;
    }
    console.log('[kinopub] final HTTP ' + r.statuscode +
                ' type=' + (r.headers_lc['content-type'] || '-') +
                ' len=' + (r.headers_lc['content-length'] || '-') +
                ' ranges=' + (r.headers_lc['accept-ranges'] || '-'));
    return url;
  }
  return url;
}

// ---------------------------------------------------------------- страницы

new page.Route(PREFIX + ':start', guarded(function(pg) {
  pg.type = 'directory';
  pg.metadata.title = 'Kinopub';
  pg.metadata.icon = Plugin.path + 'icon.png';
  if (!apiOverride && !conf.apiHost) {
    pg.loading = true;
    try {
      var d = discoverApiHost();
      if (checkApiHost(d.host)) {
        conf.apiHost = d.host; conf.apiTs = Date.now(); conf.apiSource = d.source; apiBase = d.host;
        console.log('[kinopub] API host: ' + d.host + ' (' + d.source + ')');
      }
    } catch (e) {
      console.log('[kinopub] initial discovery failed: ' + e + ', using ' + apiBase);
    }
  } else {
    resolveApiHost(false, null);
  }
  deviceNotify(false);
  pg.appendAction('Поиск по Kinopub', function() {
    var r = require('native/popup').textDialog('Поиск по Kinopub', true, true);
    if (r && r.input) pg.redirect(PREFIX + ':search:' + encodeURIComponent(r.input));
  });
  if (!haveAuth()) { pg.redirect(PREFIX + ':activate'); return; }

  pg.appendItem(PREFIX + ':watching:serials', 'directory', { title: 'Я смотрю: сериалы' });
  pg.appendItem(PREFIX + ':watching:movies', 'directory', { title: 'Я смотрю: фильмы' });
  pg.appendItem(PREFIX + ':bookmarks', 'directory', { title: 'Закладки' });
  pg.appendItem(PREFIX + ':shortcut:fresh:', 'directory', { title: 'Свежее' });
  pg.appendItem(PREFIX + ':shortcut:hot:', 'directory', { title: 'Горячее' });
  pg.appendItem(PREFIX + ':shortcut:popular:', 'directory', { title: 'Популярное' });

  var types = api('/types').items || [];
  types.forEach(function(t) {
    pg.appendItem(PREFIX + ':type:' + t.id, 'directory', { title: t.title });
  });
  pg.loading = false;
}));

// Активация устройства
new page.Route(PREFIX + ':activate', function(pg) {
  pg.type = 'directory';
  pg.metadata.title = 'Активация Kinopub';
  pg.loading = true;

  oauth({ grant_type: 'device_code' }, function(r) {
    pg.loading = false;
    if (r.status !== 200 || !r.json.code) {
      pg.error('Не удалось получить код: ' + r.status + ' ' + JSON.stringify(r.json));
      return;
    }
    var code = r.json.code;
    var interval = Math.max(3, r.json.interval || 5) * 1000;
    var deadline = Date.now() + (r.json.expires_in || 300) * 1000;

    pg.appendPassiveItem('label', null, {
      title: 'Код: ' + r.json.user_code,
      description: 'Откройте ' + (r.json.verification_uri || 'https://kino.pub/device') +
                   ' и введите этот код. Страница обновится сама.'
    });
    pg.appendAction('Запросить новый код', function() { pg.redirect(PREFIX + ':activate'); });

    function poll() {
      if (Date.now() > deadline) { pg.error('Код истёк. Запросите новый.'); return; }
      oauth({ grant_type: 'device_token', code: code }, function(t) {
        if (t.status === 200 && t.json.access_token) {
          saveTokens(t.json);
          popup.notify('Kinopub: устройство активировано', 5);
          deviceNotify(true);
          pg.redirect(PREFIX + ':start');
        } else if (t.json.error === 'authorization_pending' || t.status === 0) {
          setTimeout(poll, interval);
        } else {
          pg.error('Ошибка активации: ' + JSON.stringify(t.json));
        }
      });
    }
    setTimeout(poll, interval);
  });
});

new page.Route(PREFIX + ':search:(.*)', guarded(function(pg, q) {
  q = decodeURIComponent(q);
  paged(pg, 'Поиск: ' + q, function(n) {
    return api('/items/search', { q: q, page: n, perpage: PER_PAGE });
  });
  pg.appendAction('Искать ещё раз', function() {
    var r = require('native/popup').textDialog('Поиск по Kinopub', true, true);
    if (r && r.input) pg.redirect(PREFIX + ':search:' + encodeURIComponent(r.input));
  });
}));

new page.Route(PREFIX + ':type:([^:]+)', guarded(function(pg, type) {
  paged(pg, type, function(n) {
    return api('/items', { type: type, page: n, perpage: PER_PAGE, sort: 'updated-' });
  });
}));

new page.Route(PREFIX + ':shortcut:([^:]+):([^:]*)', guarded(function(pg, kind, type) {
  var titles = { fresh: 'Свежее', hot: 'Горячее', popular: 'Популярное' };
  if (!type) {
    pg.type = 'directory';
    pg.metadata.title = titles[kind] || kind;
    (api('/types').items || []).forEach(function(t) {
      pg.appendItem(PREFIX + ':shortcut:' + kind + ':' + t.id, 'directory', { title: t.title });
    });
    pg.loading = false;
    return;
  }
  paged(pg, (titles[kind] || kind) + ': ' + type, function(n) {
    return api('/items/' + kind, { type: type, page: n, perpage: PER_PAGE });
  });
}));

new page.Route(PREFIX + ':watching:([^:]+)', guarded(function(pg, what) {
  pg.type = 'directory';
  pg.metadata.title = what === 'serials' ? 'Я смотрю: сериалы' : 'Я смотрю: фильмы';
  (api('/watching/' + what).items || []).forEach(function(it) {
    var meta = {
      title: it.title,
      icon: poster(it, 'big'),
      description: it.total ? ('Просмотрено ' + (it.watched || 0) + ' из ' + it.total +
                               (it.new ? ', новых ' + it.new : '')) : ''
    };
    if (it.new) meta.title = '● ' + it.new + '  ' + it.title;
    pg.appendItem(PREFIX + ':item:' + it.id, 'directory', meta);
  });
  pg.loading = false;
}));

new page.Route(PREFIX + ':bookmarks', guarded(function(pg) {
  pg.type = 'directory';
  pg.metadata.title = 'Закладки';
  (api('/bookmarks').items || []).forEach(function(f) {
    pg.appendItem(PREFIX + ':bookmark:' + f.id, 'directory', {
      title: f.title, description: (f.count || 0) + ' шт.'
    });
  });
  pg.loading = false;
}));

new page.Route(PREFIX + ':bookmark:(\\d+)', guarded(function(pg, id) {
  paged(pg, 'Закладки', function(n) {
    return api('/bookmarks/' + id, { page: n, perpage: PER_PAGE });
  });
}));

// Карточка: список серий или видео
function watchMark(v) {
  if (v.watched === 1) return '✓ ';
  if (v.watched === 0) return '▶ ';
  return '• ';
}

function episodeDesc(v) {
  var parts = [];
  if (v.duration) parts.push(fmtDuration(v.duration));
  if (v.watched === 1) parts.push('просмотрено');
  else if (v.watched === 0 && v.watching && v.watching.time) parts.push('остановлено на ' + fmtDuration(v.watching.time));
  else parts.push('не просмотрено');
  if (v.audios && v.audios.length) parts.push(v.audios.length + ' озвуч.');
  if (v.subtitles && v.subtitles.length) parts.push('субтитры: ' + v.subtitles.length);
  return parts.join(' · ');
}

new page.Route(PREFIX + ':item:(\\d+)', guarded(function(pg, id) {
  var it = api('/items/' + id, { nolinks: 1 }).item;
  pg.type = 'directory';
  pg.metadata.title = it.title;
  pg.metadata.icon = poster(it, 'big');

  // Заголовок: тип «info» показывает иконку и несколько строк текста; подробности по кнопкам
  var hdr = pg.appendPassiveItem('info', null, { icon: poster(it, 'big'), title: it.title });
  hdr.root.description = it.title + '\n' + describe(it, true).split('\n')[0];

  if (it.plot) {
    pg.appendItem(PREFIX + ':text:' + it.id + ':plot', 'directory', {
      title: 'Описание', icon: 'skin://icons/ic_description_48px.svg'
    });
  }
  if (it.cast || it.director) {
    pg.appendItem(PREFIX + ':text:' + it.id + ':cast', 'directory', {
      title: 'Актёры и создатели', icon: 'skin://icons/ic_person_48px.svg'
    });
  }
  if (it.trailer && (it.trailer.id || it.trailer.url)) {
    pg.appendItem(PREFIX + ':trailer:' + it.id, 'video', {
      title: 'Трейлер', icon: 'skin://icons/ic_play_arrow_48px.svg'
    });
  }
  if (isSerial(it)) {
    var wl = pg.appendAction(watchlistTitle(it.in_watchlist), function() { toggleWatchlist(it, wl); });
  }

  function seenTitle(v) {
    return v.watched === 1 ? 'Снять отметку просмотра на Kinopub' : 'Отметить просмотр на Kinopub';
  }

  function addOptions(item, v, baseUrl, season) {
    var vNum = parseInt(baseUrl.split(':').pop(), 10);
    var opt = item.addOptAction(seenTitle(v), function() {
      var args = { id: it.id, video: vNum };
      if (season) args.season = season;
      apiAsync('/watching/toggle', args, function(err, r) {
        if (err) { popup.notify('Kinopub: ' + err, 4); return; }
        v.watched = r.watched ? 1 : -1;
        var t = item.root.metadata.title;
        item.root.metadata.title = watchMark(v) + t.replace(/^[✓▶•] /, '');
        item.root.metadata.description = episodeDesc(v);
        opt.root.metadata.title = seenTitle(v);
        popup.notify(v.watched === 1 ? 'Отмечено просмотренным на Kinopub' : 'Отметка просмотра снята', 3);
      });
    });
    if (v.audios && v.audios.length) {
      item.addOptSeparator('Озвучка');
      v.audios.forEach(function(a, i) {
        var idx = a.index || (i + 1);
        item.addOptURL(audioName(a, idx), baseUrl + ':' + idx);
      });
    }
  }

  function videoMeta(title, v, thumb) {
    return {
      title: watchMark(v) + title,
      icon: thumb || poster(it, 'small'),
      description: episodeDesc(v),
      duration: v.duration || null
    };
  }

  if (it.seasons && it.seasons.length) {
    it.seasons.forEach(function(s) {
      pg.appendPassiveItem('separator', null, { title: s.title || ('Сезон ' + s.number) });
      (s.episodes || []).forEach(function(ep, idx) {
        var epNum = ep.number || (idx + 1);
        var num = 'S' + s.number + 'E' + epNum;
        var epUrl = PREFIX + ':play:' + it.id + ':' + s.number + ':' + epNum;
        var epItem = pg.appendItem(epUrl, 'video',
                      videoMeta(num + (ep.title ? ' ' + ep.title : ''), ep, ep.thumbnail));
        addOptions(epItem, ep, epUrl, s.number);
      });
    });
  } else {
    (it.videos || []).forEach(function(v, idx) {
      var vNum = v.number || (idx + 1);
      var t = (it.videos.length > 1 ? vNum + '. ' : '') + (v.title || it.title);
      var vUrl = PREFIX + ':play:' + it.id + ':0:' + vNum;
      var vItem = pg.appendItem(vUrl, 'video', videoMeta(t, v, v.thumbnail));
      addOptions(vItem, v, vUrl, 0);
    });
  }
  pg.loading = false;
}));

// Длинный текст: список элементов «info», он скроллится в отличие от модального окна
function textChunks(text, limit) {
  var out = [];
  String(text || '').split(/\n+/).forEach(function(par) {
    par = par.replace(/\s+/g, ' ').replace(/^ | $/g, '');
    while (par.length > limit) {
      var cut = par.lastIndexOf('. ', limit);
      if (cut < limit / 2) cut = par.lastIndexOf(' ', limit);
      if (cut <= 0) cut = limit;
      out.push(par.substr(0, cut + 1).replace(/ $/, ''));
      par = par.substr(cut + 1).replace(/^ /, '');
    }
    if (par) out.push(par);
  });
  return out;
}

new page.Route(PREFIX + ':text:(\\d+):([a-z]+)', guarded(function(pg, itemId, kind) {
  var it = api('/items/' + itemId, { nolinks: 1 }).item;
  pg.type = 'directory';
  var text;
  if (kind === 'cast') {
    pg.metadata.title = it.title + ': актёры и создатели';
    var lines = [];
    if (it.director) lines.push('Режиссёр: ' + it.director);
    if (it.cast) lines.push('В ролях: ' + it.cast);
    if (it.voice) lines.push('Озвучки: ' + it.voice);
    text = lines.join('\n');
  } else {
    pg.metadata.title = it.title + ': описание';
    text = it.plot || '';
  }
  pg.metadata.icon = poster(it, 'big');
  textChunks(text, 500).forEach(function(chunk, i) {
    var item = pg.appendPassiveItem('info', null, i === 0 ? { icon: poster(it, 'big') } : {});
    item.root.description = chunk;
  });
  pg.loading = false;
}));

// Трейлер: по факту /v1/items/trailer отдаёт массив [{id, url}] с HLS-мастером на CDN,
// по документации — объект с files[] из mp4. Поддерживаем оба варианта.
new page.Route(PREFIX + ':trailer:(\\d+)', guarded(function(pg, itemId) {
  var r = api('/items/trailer', { id: itemId });
  console.log('[kinopub] trailer response: ' + JSON.stringify(r).substr(0, 800));
  var tr = r.trailer || {};
  if (tr instanceof Array) tr = tr[0] || {};
  var url = null;
  var files = tr.files || [];
  var best = null;
  files.forEach(function(f) {
    var q = parseInt(f.quality, 10) || 0;
    if (q > 1080) return;
    if (!best || q > (parseInt(best.quality, 10) || 0)) best = f;
  });
  if (best && best.url) url = best.url;
  else if (tr.url && !/youtube\.com|youtu\.be/.test(tr.url)) url = tr.url;
  if (!url) {
    throw new Error(tr.url ? 'Трейлер доступен только на YouTube: ' + tr.url : 'У трейлера нет файлов для воспроизведения');
  }
  url = resolveRedirects(url);
  if (/\.m3u8(\?|$)/.test(url)) url = 'hls:' + url;
  console.log('[kinopub] trailer ' + itemId + ' -> ' + url);
  pg.type = 'video';
  pg.source = 'videoparams:' + JSON.stringify({
    title: 'Трейлер',
    canonicalUrl: PREFIX + ':trailer:' + itemId,
    no_fs_scan: true,
    sources: [{ url: url }]
  });
  pg.loading = false;
}));

// Воспроизведение: item, season (0 для фильмов), video number
new page.Route(PREFIX + ':play:(\\d+):(\\d+):(\\d+)(?::(\\d+))?(?::(sub))?', guarded(function(pg, itemId, season, number, audioIdx, subFlag) {
  season = parseInt(season, 10); number = parseInt(number, 10);
  audioIdx = audioIdx ? parseInt(audioIdx, 10) : 0;

  var it = api('/items/' + itemId).item;
  var video = null;
  var title = it.title;

  if (season > 0) {
    (it.seasons || []).forEach(function(s) {
      if (s.number !== season) return;
      (s.episodes || []).forEach(function(ep, idx) { if ((ep.number || idx + 1) === number) video = ep; });
    });
    if (video) title = it.title + ' S' + season + 'E' + number + (video.title ? ' ' + video.title : '');
  } else {
    (it.videos || []).forEach(function(v, idx) { if ((v.number || idx + 1) === number) video = v; });
    if (video && video.title && it.videos.length > 1) title = it.title + ' — ' + video.title;
  }
  if (!video) throw new Error('Видео не найдено');

  var files = video.files;
  var subs = video.subtitles || [];
  if (video.id) {
    try {
      var links = api('/items/media-links', { mid: video.id });
      if (links.files && links.files.length) { files = links.files; subs = links.subtitles || subs; }
    } catch (e) { console.log('[kinopub] media-links: ' + e); }
  }
  var f = pickFile(files);
  var url = f && fileUrl(f);
  if (!url) throw new Error('Нет подходящего файла (h264 до ' + quality + ')');

  (files || []).forEach(function(x) {
    var uu = x.urls || x.url || {};
    console.log('[kinopub] file ' + (x.quality || '?') + ' ' + (x.codec || '?') + ' http=' + (uu.http || '-') + ' hls=' + (uu.hls || '-') + ' hls2=' + (uu.hls2 || '-') + ' hls4=' + (uu.hls4 || '-'));
  });
  console.log('[kinopub] play ' + title + ' ' + (f.quality || '') + ' ' + proto + ' ' + url);
  if (proto === 'hls4') {
    try {
      url = buildLocalManifest(url, audioIdx);
    } catch (e) {
      console.log('[kinopub] local manifest failed: ' + e + ', playing original');
      url = 'hls:' + resolveRedirects(url);
    }
  } else {
    url = resolveRedirects(url);
    // Плейлисты отдаём HLS-модулю напрямую: проба Movian смотрит только первые 4 КБ.
    if (proto === 'hls' || /\.m3u8(\?|$)/.test(url)) url = 'hls:' + url;
  }

  pendingPlay = { key: itemId + ':' + season + ':' + number, duration: video.duration || 0, watched: video.watched };
  console.log('[kinopub] play meta duration=' + pendingPlay.duration + ' watched=' + pendingPlay.watched);
  pg.type = 'video';
  pg.source = 'videoparams:' + JSON.stringify({
    title: title,
    canonicalUrl: PREFIX + ':play:' + itemId + ':' + season + ':' + number,  // без озвучки: позиция общая
    no_fs_scan: true,
    sources: [{ url: url }],
    subtitles: (subsAuto ? [] : [noSubsTrack()]).concat(
      subs.filter(function(s) { return s.url && !s.embed; }).map(function(s) {
        return { url: s.url, language: s.lang, title: s.lang };
      }))
  });
  pg.loading = false;
}));

// Наблюдение за текущим плеером: название озвучки и отправка позиции на kino.pub.
// Хук videoscrobble для HLS в Movian не вызывается, поэтому идём через media.current.
var curIsOurs = false;
var shownVoice = null;
var voiceTimer = null;
var playing = { item: 0, season: 0, video: 0, time: 0, status: '', lastSent: 0, lastSentTime: -1, duration: 0, watched: -1, autoMarked: false, lastT: -1, seekAt: 0 };
var pendingPlay = null;   // {key, duration, watched} из маршрута play
var ssHeld = false;       // держим ли мы счётчик ui.disableScreensaver

// Скин снимает блокировку заставки при любом состоянии кроме play, а счётчик
// бездействия за время просмотра не сбрасывается, поэтому короткая перемотка
// после долгого просмотра включает заставку мгновенно. Держим блокировку сами,
// пока играет наша серия и плеер не стоит на паузе.
function holdScreensaver(want) {
  if (want === ssHeld) return;
  try {
    prop.atomicAdd(prop.global.ui.disableScreensaver, want ? 1 : -1);
    ssHeld = want;
    console.log('[kinopub] screensaver hold ' + (want ? 'on' : 'off'));
  } catch (e) {
    console.log('[kinopub] screensaver hold failed: ' + e);
  }
}

function sendMark(reason) {
  if (!syncProgress || !playing.item || playing.time < 10) return;
  var t = Math.floor(playing.time);
  if (t === playing.lastSentTime) return;
  var args = { id: playing.item, video: playing.video, time: t };
  if (playing.season > 0) args.season = playing.season;
  var snap = playing.item + ':' + playing.season + ':' + playing.video;
  playing.lastSentTime = t;
  playing.lastSent = Date.now();
  apiAsync('/watching/marktime', args, function(err) {
    console.log('[kinopub] marktime ' + snap + ' t=' + t + ' (' + reason + ')' + (err ? ' FAILED ' + err : ''));
  });
}

// Зона титров: до конца не больше 5% или 2 минут, что больше
function inEndZone(t) {
  if (!playing.duration) return false;
  return playing.duration - t <= Math.max(120, playing.duration * 0.05);
}

// Дошли до зоны титров: проверяем статус на Kinopub и ставим отметку, если её ещё нет
function autoMarkWatched() {
  if (!syncProgress) return;
  var item = playing.item, season = playing.season, video = playing.video;
  var q = { id: item, video: video };
  if (season > 0) q.season = season;
  apiAsync('/watching', q, function(err, r) {
    if (err || !r || !r.item) { console.log('[kinopub] automark: status check failed ' + err); return; }
    var status = -1;
    var list = season > 0 && r.item.seasons ? (r.item.seasons[0] || {}).episodes : r.item.videos;
    (list || []).forEach(function(v) { if (v.number === video) status = v.status; });
    console.log('[kinopub] automark: server status=' + status);
    if (status === 1) { playing.watched = 1; return; }
    apiAsync('/watching/toggle', q, function(err2, r2) {
      if (err2) { console.log('[kinopub] automark toggle failed ' + err2); return; }
      playing.watched = r2 && r2.watched ? 1 : playing.watched;
      console.log('[kinopub] automark: ' + item + ':' + season + ':' + video + ' -> ' + JSON.stringify(r2));
      popup.notify('Kinopub: серия отмечена просмотренной', 4);
    });
  });
}

try {
  var mediaCur = prop.global.media.current;
  prop.subscribeValue(mediaCur.url, function(v) {
    var u = String(v || '');
    var m = /^kinopub:play:(\d+):(\d+):(\d+)/.exec(u);
    if (playing.item && (!m || parseInt(m[1], 10) !== playing.item || parseInt(m[2], 10) !== playing.season ||
                         parseInt(m[3], 10) !== playing.video)) {
      sendMark('stop');
      if (!playing.autoMarked && inEndZone(playing.time)) {
        playing.autoMarked = true;
        console.log('[kinopub] automark: stopped in end zone at ' + Math.floor(playing.time) + '/' + Math.floor(playing.duration));
        autoMarkWatched();
      }
    }
    curIsOurs = !!m;
    if (!curIsOurs) { shownVoice = null; holdScreensaver(false); }
    playing.item = m ? parseInt(m[1], 10) : 0;
    playing.season = m ? parseInt(m[2], 10) : 0;
    playing.video = m ? parseInt(m[3], 10) : 0;
    playing.time = 0; playing.lastSentTime = -1; playing.lastSent = Date.now();
    playing.duration = 0; playing.watched = -1; playing.autoMarked = false;
    playing.lastT = -1; playing.seekAt = Date.now();
    if (m && pendingPlay && pendingPlay.key === m[1] + ':' + m[2] + ':' + m[3]) {
      playing.duration = pendingPlay.duration; playing.watched = pendingPlay.watched;
    }
    console.log('[kinopub] media.current.url = ' + u);
  });
  prop.subscribeValue(mediaCur.currenttime, function(v) {
    if (!curIsOurs) return;
    var t = parseFloat(v);
    if (isNaN(t)) return;
    if (playing.lastT >= 0 && Math.abs(t - playing.lastT) > 5) playing.seekAt = Date.now();
    playing.lastT = t;
    playing.time = t;
    // Отметка: до конца осталось не больше 5% или 2 минут (что больше), плеер играет,
    // и последние 15 секунд не было перемотки, т.е. до этой точки дошли просмотром.
    if (!playing.autoMarked && playing.duration > 0) {
      if (inEndZone(t) && playing.status === 'play' && Date.now() - playing.seekAt > 15000) {
        playing.autoMarked = true;
        console.log('[kinopub] automark: threshold reached at ' + Math.floor(t) + '/' + Math.floor(playing.duration));
        autoMarkWatched();
      }
    }
  });
  prop.subscribeValue(mediaCur.metadata.duration, function(v) {
    if (!curIsOurs) return;
    var d = parseFloat(v);
    if (!isNaN(d) && d > 0 && !playing.duration) playing.duration = d;
  });
  prop.subscribeValue(mediaCur.playstatus, function(v) {
    var st = String(v || '');
    var prev = playing.status;
    playing.status = st;
    if (!curIsOurs) return;
    console.log('[kinopub] playstatus = ' + st + ' at ' + Math.floor(playing.time) + 's');
    holdScreensaver(st !== 'pause' && st !== 'stop');
    if (st === 'pause' && prev !== 'pause') sendMark('pause');
    if (st === 'stop') sendMark('stop');
  });
  setInterval(function() {
    if (curIsOurs && playing.status === 'play' && Date.now() - playing.lastSent > 60000) sendMark('periodic');
  }, 15000);
  prop.subscribeValue(mediaCur.audio.current, function(v) {
    var u = String(v || '');
    if (!curIsOurs) return;
    var m = /^hls:(\d+)$/.exec(u);
    if (!m) return;
    var name = voiceNames[parseInt(m[1], 10) - 1];
    if (!name) return;
    if (voiceTimer) clearTimeout(voiceTimer);
    voiceTimer = setTimeout(function() {
      voiceTimer = null;
      if (name === shownVoice) return;
      shownVoice = name;
      popup.notify('Озвучка: ' + name, 4);
    }, 800);
  });
} catch (e) {
  console.log('[kinopub] media.current subscribe failed: ' + e);
}

// Глобальный поиск Movian
new page.Searcher('Kinopub', null, function(pg, query) {
  try {
    if (!haveAuth()) return;
    (api('/items/search', { q: query, perpage: 40 }).items || []).forEach(function(it) {
      appendCard(pg, it);
    });
  } catch (e) { console.log('[kinopub] search: ' + e); }
});
