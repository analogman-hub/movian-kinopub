// TLS check v2: асинхронные запросы, сторожевой таймер на каждый хост,
// текст ошибки прямо в заголовке строки. Чистый ES5 (Duktape).

var page = require('movian/page');
var http = require('movian/http');
var service = require('movian/service');
var popup = require('movian/popup');

var PREFIX = 'tlscheck';
var WATCHDOG_MS = 20000;

var TARGETS = [
  { url: 'http://api.boramoraboom.ru/v1/types',        expect: [301, 302, 401, 200], note: 'Kinopub по голому HTTP: сеть до сервера', noFollow: true },
  { url: 'https://api.boramoraboom.ru/v1/types',       expect: [401], note: 'Kinopub API, TLS 1.2, ECDSA+GCM', debug: true },
  { url: 'https://api.service-kp.com/v1/types',        expect: [401], note: 'Kinopub API основной' },
  { url: 'https://proxykp.xyz/api/v1/types',           expect: [401], note: 'Kinopub прокси за Cloudflare' },
  { url: 'https://valid-isrgrootx1.letsencrypt.org/',  expect: [200], note: 'RSA, GCM и CBC' },
  { url: 'https://valid-isrgrootx2.letsencrypt.org/',  expect: [200], note: 'ECDSA, только GCM' },
  { url: 'https://www.apple.com/',                     expect: [200], note: 'RSA, контроль HTTPS' },
  { url: 'http://example.com/',                        expect: [200], note: 'HTTP, контроль сети' }
];

service.create('TLS check', PREFIX + ':start', 'other', true, null);

function short(url) {
  return url.replace(/^https?:\/\//, function(m) { return m === 'https://' ? 'S ' : 'P '; });
}

new page.Route(PREFIX + ':start', function(page) {
  page.type = 'directory';
  page.metadata.title = 'Проверка TLS (v2)';
  page.loading = false;

  var pending = TARGETS.length;
  var okCount = 0;

  TARGETS.forEach(function(t) {
    var started = Date.now();
    var done = false;
    var item = page.appendPassiveItem('label', null, {
      title: '...  ' + short(t.url),
      description: 'ждём ответ. ' + t.note
    });

    function finish(ok, text) {
      if (done) return;
      done = true;
      pending--;
      if (ok) okCount++;
      var ms = Date.now() - started;
      var title = (ok ? 'OK    ' : 'FAIL  ') + short(t.url) + '  [' + text + ', ' + ms + ' мс]';
      item.root.metadata.title = title;
      item.root.metadata.description = t.note;
      console.log('[tlscheck] ' + title + ' | ' + t.note);
      if (pending === 0) {
        popup.notify('TLS check: ' + okCount + '/' + TARGETS.length + ' OK', 8);
        page.appendPassiveItem('label', null, {
          title: 'Итог: ' + okCount + ' из ' + TARGETS.length,
          description: 'Строки с деталями в логе Movian по слову tlscheck'
        });
      }
    }

    setTimeout(function() { finish(false, 'нет ответа за ' + (WATCHDOG_MS / 1000) + ' с'); }, WATCHDOG_MS);

    try {
      var opts = { noFail: true };
      if (t.noFollow) opts.noFollow = true;
      if (t.debug) opts.debug = true;
      http.request(t.url, opts, function(err, res) {
        if (err) return finish(false, 'ошибка: ' + err);
        var ok = t.expect.indexOf(res.statuscode) >= 0;
        finish(ok, 'HTTP ' + res.statuscode + (ok ? '' : ', ожидали ' + t.expect.join('/')));
      });
    } catch (e) {
      finish(false, 'исключение: ' + e);
    }
  });
});
