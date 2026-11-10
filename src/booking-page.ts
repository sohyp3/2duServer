export const bookingHtml = `<!doctype html>
<html lang="en" dir="auto">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Book a time</title>
<link rel="stylesheet" href="/book/app.css">
</head>
<body>
<main>
<h1 id="title">Book a time</h1>
<p id="length" class="muted"></p>
<p id="status" role="status"></p>
<div id="picker" hidden>
<div class="nav">
<button type="button" id="earlier">Earlier</button>
<button type="button" id="later">Later</button>
</div>
<div id="days" class="row"></div>
<p id="zone" class="muted"></p>
<div id="slots" class="row"></div>
</div>
<form id="form" hidden>
<p id="chosen"></p>
<label>Name <input id="name" name="name" maxlength="80" required autocomplete="name"></label>
<label>Email or phone <input id="contact" name="contact" maxlength="120" required autocomplete="email"></label>
<label>Note (optional) <textarea id="note" name="note" maxlength="500" rows="3"></textarea></label>
<input class="hp" type="text" id="website" name="website" tabindex="-1" autocomplete="off">
<div class="nav"><button type="button" id="back">Back</button><button type="submit" id="confirm" class="primary">Confirm</button></div>
</form>
</main>
<script src="/book/app.js"></script>
</body>
</html>
`;

export const bookingCss = `:root{color-scheme:light dark;--bg:#faf8f3;--fg:#1c1b18;--accent:#5f7d2a;--line:#c9c5b8}
@media (prefers-color-scheme:dark){:root{--bg:#0d0c0a;--fg:#f2efe8;--accent:#a7c968;--line:#3a3830}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:480px;margin:0 auto;padding:24px 16px}
h1{font-size:1.5rem;margin:0 0 4px}
.muted{opacity:.7;margin:4px 0 12px}
.row{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0}
.nav{display:flex;justify-content:space-between;gap:8px;margin:8px 0}
button{min-height:44px;min-width:44px;padding:8px 14px;border:1px solid var(--line);border-radius:8px;background:transparent;color:var(--fg);font:inherit;cursor:pointer}
button:disabled{opacity:.35;cursor:default}
button.on,button.primary{background:var(--accent);border-color:var(--accent);color:var(--bg)}
button:focus-visible,input:focus-visible,textarea:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
label{display:block;margin:12px 0}
input,textarea{display:block;width:100%;min-height:44px;margin-top:4px;padding:8px;border:1px solid var(--line);border-radius:8px;background:transparent;color:var(--fg);font:inherit}
.hp{position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden}
[hidden]{display:none!important}
#status.error{color:#c0392b}
`;

export const bookingJs = `(function () {
  var slug = location.pathname.split('/').pop();
  var api = '/v1/public/booking/' + slug;
  var $ = function (id) { return document.getElementById(id); };
  var state = { from: null, slots: [], day: null, chosen: null, tz: '' };
  var fmtTime = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
  var fmtDay = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric' });
  var fmtFull = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'short' });
  var dayKey = function (iso) {
    var d = new Date(iso);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  };
  function say(text, isError) {
    $('status').textContent = text || '';
    $('status').className = isError ? 'error' : '';
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
  function button(text, onclick, cls) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    if (cls) b.className = cls;
    b.addEventListener('click', onclick);
    return b;
  }
  function load(from) {
    var url = api + (from ? '?from=' + encodeURIComponent(from) : '');
    return fetch(url).then(function (r) {
      return r.json().then(function (j) { return { status: r.status, body: j }; });
    }).then(function (r) {
      if (r.status === 404) { say('This booking link is not available.', true); $('picker').hidden = true; return; }
      if (r.status !== 200) { say(r.body.error || 'Something went wrong.', true); return; }
      say('');
      state.from = r.body.from;
      state.slots = r.body.slots;
      state.tz = r.body.tz;
      $('title').textContent = r.body.title;
      $('length').textContent = r.body.duration_min + ' minutes';
      $('zone').textContent = 'Times shown in ' + Intl.DateTimeFormat().resolvedOptions().timeZone;
      document.title = r.body.title;
      $('picker').hidden = false;
      renderDays();
    }).catch(function () { say('Could not reach the server.', true); });
  }
  function shift(n) {
    var d = new Date(state.from + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    state.day = null;
    load(d.toISOString().slice(0, 10));
  }
  function renderDays() {
    var byDay = {};
    state.slots.forEach(function (s) { (byDay[dayKey(s)] = byDay[dayKey(s)] || []).push(s); });
    clear($('days')); clear($('slots'));
    var start = new Date(state.from + 'T12:00:00');
    var first = null;
    for (var i = 0; i < 7; i++) {
      var d = new Date(start.getTime() + i * 86400000);
      var key = dayKey(d.toISOString());
      var has = !!byDay[key];
      if (has && !first) first = key;
      var b = button(fmtDay.format(d), (function (k) { return function () { state.day = k; renderDays(); }; })(key), state.day === key ? 'on' : '');
      b.disabled = !has;
      $('days').appendChild(b);
    }
    if (!state.day || !byDay[state.day]) state.day = first;
    if (state.day) {
      (byDay[state.day] || []).forEach(function (s) {
        $('slots').appendChild(button(fmtTime.format(new Date(s)), function () { choose(s); }));
      });
    }
    if (!first) say('No times available this week.');
  }
  function choose(s) {
    state.chosen = s;
    $('chosen').textContent = fmtFull.format(new Date(s));
    $('picker').hidden = true;
    $('form').hidden = false;
    $('name').focus();
  }
  $('earlier').addEventListener('click', function () { shift(-7); });
  $('later').addEventListener('click', function () { shift(7); });
  $('back').addEventListener('click', function () { $('form').hidden = true; $('picker').hidden = false; });
  $('form').addEventListener('submit', function (e) {
    e.preventDefault();
    $('confirm').disabled = true;
    var body = JSON.stringify({
      start: state.chosen,
      name: $('name').value,
      contact: $('contact').value,
      note: $('note').value,
      website: $('website').value
    });
    fetch(api, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body })
      .then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }); })
      .then(function (r) {
        $('confirm').disabled = false;
        if (r.status === 201) {
          $('form').hidden = true;
          say("You're booked. " + fmtFull.format(new Date(state.chosen)));
          return;
        }
        say(r.body.error || 'Something went wrong.', true);
        if (r.status === 409) { $('form').hidden = true; load(state.from); }
      })
      .catch(function () { $('confirm').disabled = false; say('Could not reach the server.', true); });
  });
  load(null);
})();
`;
