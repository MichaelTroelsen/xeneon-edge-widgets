/* C64 Weather — Open-Meteo current conditions on a Commodore 64 boot screen.
   Temperatures are always fetched in Celsius and converted for display, so
   flipping the unit costs no request and still works from cache while offline. */
(function () {
  'use strict';

  var GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
  var FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
  var REQUEST_TIMEOUT_MS = 12000;
  var STALE_AFTER_MS = 3 * 60 * 60 * 1000; /* cached data older than this is flagged offline */

  var DEFAULT_LOCATION = 'Copenhagen';
  /* Keep in step with manifest.json - the boot banner is where the widget
     reports its own version on the device. */
  var WIDGET_VERSION = '1.5.5';

  /* ---------- themes ----------
     Each theme is a palette (CSS class), a startup screen, and a font mode. The
     palette tokens were already the only thing the stylesheet consumed, so a
     theme is a token redefinition rather than a second stylesheet.

     `boot` is the machine's real startup screen, line for line. It used to be a
     homage that said WEATHER where the machine said BASIC; the reference shots
     these were checked against made the homage look like a mistake instead of a
     joke, so the startup text is now verbatim and the widget's own line - the
     one carrying the version - is `load`, which on every one of these machines
     was something the user typed, not something the ROM printed.

     STILL NOT AUTHENTIC, and worth saying plainly: the letterforms are this
     project's own 8x8 set, NOT a ROM dump. See TODO.md.

     `mixedCase` is a property of the machine, not a preference. The C64 and the
     PET boot in their uppercase/graphics character set, so folding their text
     to capitals is right; the BBC, CPC, Spectrum and Amiga all printed mixed
     case and folding theirs was simply wrong. */
  var THEMES = {
    c64: {
      label: 'Commodore 64',
      boot: ['**** COMMODORE 64 BASIC V2 ****',
             '64K RAM SYSTEM  38911 BASIC BYTES FREE'],
      load: 'LOAD"WEATHER ' + WIDGET_VERSION + '",8,1',
      ready: 'READY.',
      cursor: 'block'
    },
    pet: {
      /* The CBM 8032 in the reference photo: 32K, BASIC 4.0. An 8K PET running
         BASIC 2.0 says "*** COMMODORE BASIC ***" and 7167 bytes instead. */
      label: 'Commodore PET',
      boot: ['*** COMMODORE BASIC 4.0 ***',
             '31743 BYTES FREE'],
      load: 'LOAD"WEATHER ' + WIDGET_VERSION + '",8',
      ready: 'READY.',
      cursor: 'block'
    },
    bbc: {
      label: 'BBC Micro',
      boot: ['BBC Computer 32K',
             'Acorn DFS',
             'BASIC'],
      load: '>CHAIN "WEATHER ' + WIDGET_VERSION + '"',
      ready: '>',
      cursor: 'underline',
      mixedCase: true
    },
    cpc: {
      /* The CPC 464 in the reference photo. A 6128 says 128K, (v3) and
         BASIC 1.1, with the copyright year 1985. */
      label: 'Amstrad CPC',
      boot: ['Amstrad 64K Microcomputer  (v1)',
             '©1984 Amstrad Consumer Electronics plc',
             '        and Locomotive Software Ltd.',
             'BASIC 1.0'],
      load: 'RUN"WEATHER ' + WIDGET_VERSION,
      ready: 'Ready',
      cursor: 'block',
      mixedCase: true
    },
    spectrum: {
      /* One line, and it sat at the foot of the screen rather than the top -
         see the `order` rule for .theme-spectrum .boot. */
      label: 'ZX Spectrum',
      boot: ['© 1982 Sinclair Research Ltd'],
      load: 'LOAD "WEATHER ' + WIDGET_VERSION + '"',
      ready: '0 OK, 0:1',
      cursor: 'block',
      mixedCase: true
    },
    amiga: {
      /* Kickstart 3.1, which is the ROM screen in the reference shot, not the
         Workbench 1.3 screen this theme used to claim. */
      label: 'Amiga',
      boot: ['3.1 ROM  40.063',
             'Copyright © 1985-1993',
             'Commodore-Amiga, Inc.',
             'All Rights Reserved.'],
      load: '',
      ready: '',
      cursor: 'none',
      mixedCase: true
    },
    modern: {
      label: 'Modern',
      boot: [],
      load: '',
      ready: '',
      cursor: 'none',
      font: 'system',
      mixedCase: true
    }
  };

  var THEME_ORDER = ['c64', 'pet', 'bbc', 'cpc', 'spectrum', 'amiga', 'modern'];

  /* Tapping the screen steps to the next theme in THEME_ORDER. The iCUE
     property is still the setting; a tap is an override layered over it and
     remembered alongside the property value it was made against. When that
     value changes the user has spoken through the settings panel - the more
     deliberate act of the two - so the override is dropped rather than
     silently outranking the new choice. */
  var TAP_SLOP_PX = 12;   /* movement beyond this is a drag, not a tap */
  var TAP_MAX_MS = 700;
  var themeOverride = null;      /* theme id chosen by tapping, or null */
  var themeOverrideBase = null;  /* the property value at the time of that tap */

  function settingThemeName() {
    var raw = String(getIcueProperty('theme') || 'c64').toLowerCase();
    return THEMES[raw] ? raw : 'c64';
  }

  function themeName() {
    var base = settingThemeName();
    if (!themeOverride) return base;
    if (themeOverrideBase !== base) {
      themeOverride = null;
      themeOverrideBase = null;
      saveThemeOverride();
      return base;
    }
    return themeOverride;
  }

  function cycleTheme() {
    var base = settingThemeName();
    var i = THEME_ORDER.indexOf(themeName());   /* may clear a stale override */
    themeOverride = THEME_ORDER[(i + 1) % THEME_ORDER.length];
    themeOverrideBase = base;
    saveThemeOverride();
    renderStatic();
    render();
  }

  var appliedTheme = null;

  function applyTheme() {
    var name = themeName();
    var t = THEMES[name];
    PETSCII.setFont(t.font === 'system' ? 'system' : 'pixel', t.glyphs || null, t.mixedCase);
    var root = document.querySelector('.widget-root');
    if (root) {
      THEME_ORDER.forEach(function (n) { root.classList.remove('theme-' + n); });
      root.classList.add('theme-' + name);
      root.classList.toggle('is-bare', !t.boot.length);
      root.setAttribute('data-cursor', t.cursor);
    }
    appliedTheme = name;
    return t;
  }

  /* ---------- the boot sequence ----------
     Changing machine reboots it. The new machine's startup screen holds the
     whole slot for BOOT_MS and then hands over to the weather screen, which is
     what lets the startup text be the real thing at its real length: four lines
     of Amstrad copyright have somewhere to go without crowding the readout.

     Modern has no startup screen to play, so it just appears. */
  var BOOT_MS = 2000;
  var bootTimer = null;
  var bootedTheme = null;

  function endBoot() {
    bootTimer = null;
    if (els.root) els.root.classList.remove('is-booting');
  }

  function playBoot(name, hasBoot) {
    if (bootedTheme === name) return;   /* a redraw is not a reboot */
    bootedTheme = name;
    if (bootTimer) clearTimeout(bootTimer);
    if (!hasBoot || !els.root) { endBoot(); return; }
    els.root.classList.add('is-booting');
    bootTimer = setTimeout(endBoot, BOOT_MS);
  }

  var els = {};
  var refreshTimer = null;
  var inFlight = null;
  var retryTimer = null;
  var retryDelayMs = 0;   /* 0 = not currently in a retry backoff */
  var RETRY_INITIAL_MS = 10000;
  var lastQuery = null;   /* location string the current data was fetched for */
  var current = null;     /* normalised reading, always in Celsius */
  var offline = false;    /* last fetch failed and we are showing older data */
  var languageCode = 'en';

  /* ---------- iCUE property access ---------- */

  function getIcueProperty(name) {
    if (typeof window !== 'undefined' && Object.prototype.hasOwnProperty.call(window, name)) {
      var value = window[name];
      if (value !== undefined && value !== null && value !== '') return value;
    }
    try {
      var sandboxed = Function('return typeof ' + name + ' !== "undefined" ? ' + name + ' : undefined')();
      if (sandboxed !== undefined && sandboxed !== null && sandboxed !== '') return sandboxed;
    } catch (e) { /* not injected in this context */ }
    return undefined;
  }

  function clampRange(v, min, max, d) {
    v = Number(v);
    if (!Number.isFinite(v)) return d;
    return Math.max(min, Math.min(max, v));
  }

  function readLocation() {
    /* Property is `cityName`: a global named `location` would shadow-clash with
       window.location and never round-trip as a string. */
    var raw = getIcueProperty('cityName');
    return (typeof raw === 'string' && raw.trim()) ? raw.trim() : DEFAULT_LOCATION;
  }

  function readUnit() {
    var pref = getIcueProperty('tempUnit');
    if (pref === 'C' || pref === 'F') return pref;
    try {
      if (typeof iCUE !== 'undefined' && typeof iCUE.defaultTemperatureUnit === 'function') {
        return iCUE.defaultTemperatureUnit().indexOf('F') >= 0 ? 'F' : 'C';
      }
    } catch (e) { /* iCUE not present (browser) */ }
    return 'C';
  }

  function readRefreshMinutes() {
    return clampRange(getIcueProperty('refreshMinutes'), 5, 120, 15);
  }

  /* ---------- persistence ---------- */

  function storageKey() {
    var id = getIcueProperty('uniqueId');
    return 'c64weather:' + (typeof id === 'string' && id ? id : 'default');
  }

  function saveCache(reading) {
    try {
      localStorage.setItem(storageKey(), JSON.stringify(reading));
    } catch (e) { /* storage unavailable — cache is a bonus, not a requirement */ }
  }

  /* Kept apart from the reading cache: a corrupt or absent reading must not
     cost the chosen theme, and vice versa. */
  function themeKey() {
    return storageKey() + ':theme';
  }

  function saveThemeOverride() {
    try {
      if (themeOverride) {
        localStorage.setItem(themeKey(),
          JSON.stringify({ name: themeOverride, base: themeOverrideBase }));
      } else {
        localStorage.removeItem(themeKey());
      }
    } catch (e) { /* storage unavailable — the override just lasts the session */ }
  }

  function loadThemeOverride() {
    try {
      var raw = localStorage.getItem(themeKey());
      if (!raw) return;
      var parsed = JSON.parse(raw);
      if (parsed && THEMES[parsed.name]) {
        themeOverride = parsed.name;
        themeOverrideBase = parsed.base;
      }
    } catch (e) { /* fall back to the setting */ }
  }

  function loadCache() {
    try {
      var raw = localStorage.getItem(storageKey());
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      return (parsed && typeof parsed.tempC === 'number') ? parsed : null;
    } catch (e) {
      return null;
    }
  }

  /* ---------- weather codes ---------- */

  function describe(code, isDay) {
    var map = {
      0:  ['CLEAR SKY', isDay ? 'sun' : 'moon'],
      1:  ['MAINLY CLEAR', isDay ? 'sun' : 'moon'],
      2:  ['PARTLY CLOUDY', 'partly'],
      3:  ['OVERCAST', 'cloud'],
      45: ['FOG', 'fog'],
      48: ['RIME FOG', 'fog'],
      51: ['LIGHT DRIZZLE', 'drizzle'],
      53: ['DRIZZLE', 'drizzle'],
      55: ['DENSE DRIZZLE', 'drizzle'],
      56: ['FREEZING DRIZZLE', 'drizzle'],
      57: ['FREEZING DRIZZLE', 'drizzle'],
      61: ['LIGHT RAIN', 'rain'],
      63: ['RAIN', 'rain'],
      65: ['HEAVY RAIN', 'rain'],
      66: ['FREEZING RAIN', 'rain'],
      67: ['FREEZING RAIN', 'rain'],
      71: ['LIGHT SNOW', 'snow'],
      73: ['SNOW', 'snow'],
      75: ['HEAVY SNOW', 'snow'],
      77: ['SNOW GRAINS', 'snow'],
      80: ['LIGHT SHOWERS', 'rain'],
      81: ['SHOWERS', 'rain'],
      82: ['VIOLENT SHOWERS', 'rain'],
      85: ['SNOW SHOWERS', 'snow'],
      86: ['HEAVY SNOW SHOWERS', 'snow'],
      95: ['THUNDERSTORM', 'storm'],
      96: ['STORM WITH HAIL', 'storm'],
      99: ['STORM WITH HAIL', 'storm']
    };
    return map[code] || ['UNKNOWN', 'cloud'];
  }

  /* ---------- networking ---------- */

  function fetchJson(url) {
    var controller = (typeof AbortController === 'function') ? new AbortController() : null;
    var timer = setTimeout(function () { if (controller) controller.abort(); }, REQUEST_TIMEOUT_MS);
    var opts = controller ? { signal: controller.signal } : {};
    var settled = false;
    /* abort() only works when AbortController exists; on a webview without it
       (or a fetch that ignores the abort signal) the underlying promise can
       simply never settle, which would wedge `inFlight` forever and starve
       every future refresh and retry. Race a plain timer alongside it so this
       promise always settles within REQUEST_TIMEOUT_MS regardless of whether
       the abort actually took effect. */
    var timeoutGuard = new Promise(function (_, reject) {
      setTimeout(function () {
        if (!settled) reject(new Error('request timed out'));
      }, REQUEST_TIMEOUT_MS + 500);
    });
    var request = fetch(url, opts).then(function (res) {
      settled = true;
      clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }, function (err) {
      settled = true;
      clearTimeout(timer);
      throw err;
    });
    return Promise.race([request, timeoutGuard]);
  }

  var COORD_RE = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;

  function resolveLocation(query) {
    var coords = COORD_RE.exec(query);
    if (coords) {
      var lat = parseFloat(coords[1]);
      var lon = parseFloat(coords[2]);
      if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
        return Promise.resolve({
          latitude: lat,
          longitude: lon,
          label: lat.toFixed(2) + ', ' + lon.toFixed(2)
        });
      }
    }
    var url = GEOCODE_URL + '?name=' + encodeURIComponent(query) +
      '&count=1&language=' + encodeURIComponent(languageCode) + '&format=json';
    return fetchJson(url).then(function (data) {
      var hit = data && data.results && data.results[0];
      if (!hit) return null; /* not found — distinct from a network failure */
      return {
        latitude: hit.latitude,
        longitude: hit.longitude,
        label: hit.country_code ? hit.name + ', ' + hit.country_code : hit.name
      };
    });
  }

  function fetchWeather(place) {
    var url = FORECAST_URL +
      '?latitude=' + encodeURIComponent(place.latitude) +
      '&longitude=' + encodeURIComponent(place.longitude) +
      '&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code,is_day' +
      '&daily=temperature_2m_max,temperature_2m_min,sunrise,sunset' +
      '&timezone=auto&forecast_days=1&temperature_unit=celsius&wind_speed_unit=kmh';
    return fetchJson(url).then(function (data) {
      var cur = data && data.current;
      if (!cur || typeof cur.temperature_2m !== 'number') throw new Error('malformed response');
      var daily = (data && data.daily) || {};
      return {
        city: place.label,
        tempC: cur.temperature_2m,
        feelsC: typeof cur.apparent_temperature === 'number' ? cur.apparent_temperature : null,
        humidity: typeof cur.relative_humidity_2m === 'number' ? cur.relative_humidity_2m : null,
        windKmh: typeof cur.wind_speed_10m === 'number' ? cur.wind_speed_10m : null,
        code: cur.weather_code,
        isDay: cur.is_day !== 0,
        hiC: (daily.temperature_2m_max && daily.temperature_2m_max.length) ? daily.temperature_2m_max[0] : null,
        loC: (daily.temperature_2m_min && daily.temperature_2m_min.length) ? daily.temperature_2m_min[0] : null,
        /* Kept as the raw ISO string. timezone=auto means it is already local to
           the location, so parsing it into a Date would re-shift it into ours. */
        sunrise: (daily.sunrise && daily.sunrise.length) ? daily.sunrise[0] : null,
        sunset: (daily.sunset && daily.sunset.length) ? daily.sunset[0] : null,
        fetchedAt: Date.now()
      };
    });
  }

  /* ---------- rendering ---------- */

  function toDisplayTemp(celsius, unit) {
    if (typeof celsius !== 'number') return null;
    return unit === 'F' ? celsius * 9 / 5 + 32 : celsius;
  }

  function tempString(celsius, unit, withUnit) {
    var v = toDisplayTemp(celsius, unit);
    if (v === null) return '--°';
    return Math.round(v) + '°' + (withUnit ? unit : '');
  }

  /* Wind follows the temperature unit: km/h alongside °C, mph alongside °F.
     No label - the glyph in front of the row carries that. */
  function windString(kmh, unit) {
    if (typeof kmh !== 'number') return null;
    return unit === 'F'
      ? Math.round(kmh * 0.621371) + 'MPH'
      : Math.round(kmh) + 'KM/H';
  }

  /* "2026-08-28T05:42" -> "05:42". Substring, not Date: the API already
     returned it in the location's own timezone. */
  function clockString(iso) {
    if (typeof iso !== 'string' || iso.length < 16) return null;
    return iso.substring(11, 16);
  }

  /* One stat row: glyph plus value, hidden entirely when there is no value. */
  function setStat(el, glyph, text) {
    if (!el) return;
    if (text === null || text === undefined) {
      el.setAttribute('data-empty', '1');
      return;
    }
    el.removeAttribute('data-empty');
    PETSCII.setGlyph(el.querySelector('.glyph'), glyph);
    PETSCII.setText(el.querySelector('.val'), text);
  }

  function setRange(el, text) {
    if (!el) return;
    if (text === null) {
      el.setAttribute('data-empty', '1');
      return;
    }
    el.removeAttribute('data-empty');
    PETSCII.setText(el, text);
  }

  function showState(state) {
    ['loading-state', 'error-state', 'empty-state', 'content'].forEach(function (name) {
      var el = document.querySelector('.' + name);
      if (el) el.style.display = (name === state) ? '' : 'none';
    });
  }

  function render() {
    if (!current) return;
    var unit = readUnit();
    var info = describe(current.code, current.isDay);

    PETSCII.setText(els.temp, tempString(current.tempC, unit, true));
    PETSCII.setText(els.condition, info[0]);
    PETSCII.setText(els.city, current.city);
    PETSCII.setSprite(els.sprite, info[1]);
    els.sprite.className = 'sprite-cell sprite-' + info[1];

    /* Low | high under the sprite, as the reference layout has it. */
    setRange(els.range,
      (current.loC !== null && current.hiC !== null)
        ? tempString(current.loC, unit, false) + ' | ' + tempString(current.hiC, unit, false)
        : null);

    /* Older cached readings predate the sun times; those rows stay hidden. */
    var up = clockString(current.sunrise);
    var down = clockString(current.sunset);
    setStat(els.statUp, 'sunrise', up);
    setStat(els.statDown, 'sunset', down);
    setStat(els.statWind, 'wind', windString(current.windKmh, unit));
    setStat(els.statFeels, 'thermo',
      current.feelsC !== null ? tempString(current.feelsC, unit, false) : null);
    setStat(els.statHum, 'drop',
      current.humidity !== null ? Math.round(current.humidity) + '%' : null);

    var stale = offline || (Date.now() - current.fetchedAt) > STALE_AFTER_MS;
    els.root.classList.toggle('is-stale', stale);

    showState('content');
  }

  /* A line the theme leaves empty is removed rather than drawn as a blank one:
     the Amiga's ROM screen has no prompt at all, and an empty row of the right
     height still reads as a gap someone forgot to fill. */
  function setLine(el, text, flagEl) {
    if (!el) return;
    /* The READY prompt is a span sharing its row with the cursor, so the row is
       what has to be hidden, not the span. */
    var host = flagEl || el;
    if (!text) {
      host.setAttribute('data-empty', '1');
      PETSCII.setText(el, '');
      return;
    }
    host.removeAttribute('data-empty');
    PETSCII.setText(el, text);
  }

  function renderBootLines(lines) {
    if (!els.boot) return;
    els.boot.innerHTML = '';
    lines.forEach(function (text) {
      var div = document.createElement('div');
      div.className = 'boot-line';
      PETSCII.setText(div, text);
      els.boot.appendChild(div);
    });
  }

  function renderStatic() {
    var theme = applyTheme();
    renderBootLines(theme.boot);
    /* The machine is keyed on the theme id, not on a per-theme field: the
       drawing IS the machine, so a theme without one (Modern) simply has no
       entry and renders nothing. */
    PETSCII.setMachine(els.machine, appliedTheme);
    setLine(els.load, theme.load);
    setLine(els.ready, theme.ready, els.readyLine);
    /* Amiga and Modern are the two machines with no typed load line (the Amiga
       booted straight to Workbench with no prompt at all, and Modern keeps no
       console conceit), so neither has anywhere to carry the version. Give
       both a small corner caption instead - the one place on the device that
       can tell a stale cached copy from a current one, same as the load line
       does for the other five. */
    setLine(els.versionTag, theme.load ? '' : 'v' + WIDGET_VERSION);
    playBoot(appliedTheme, theme.boot.length > 0);
    PETSCII.setText(els.loadingA, 'SEARCHING FOR WEATHER');
    PETSCII.setText(els.loadingB, 'LOADING');
    PETSCII.setText(els.errorA, '?DEVICE NOT PRESENT  ERROR');
    PETSCII.setText(els.errorB, 'CHECK NETWORK CONNECTION');
    PETSCII.setText(els.emptyA, '?FILE NOT FOUND  ERROR');
    PETSCII.setText(els.emptyB, 'CHECK LOCATION SETTING');
    PETSCII.setText(els.offline, '*** OFFLINE - LAST READING ***');
  }

  /* ---------- update cycle ---------- */

  function refresh(force) {
    var query = readLocation();
    if (inFlight) return;
    if (!force && current && lastQuery === query &&
        (Date.now() - current.fetchedAt) < readRefreshMinutes() * 60000) {
      render();
      return;
    }
    if (!current) showState('loading-state');

    inFlight = resolveLocation(query)
      .then(function (place) {
        if (!place) {
          /* Geocoder answered, the place just does not exist. This is not a
             transient failure, so it does not enter the retry backoff. */
          if (!current) showState('empty-state');
          clearRetry();
          return null;
        }
        return fetchWeather(place).then(function (reading) {
          current = reading;
          lastQuery = query;
          offline = false;
          saveCache(reading);
          render();
          clearRetry();
          return reading;
        });
      })
      .catch(function () {
        /* Prefer the last known reading with an offline marker over a blank screen. */
        if (!current) current = loadCache();
        offline = true;
        if (current) {
          render();
        } else {
          showState('error-state');
        }
        scheduleRetry();
      })
      /* Both callbacks run inFlight = null, so a synchronous throw anywhere
         above (not just the expected reject path) still releases the
         single-flight guard instead of wedging it forever. */
      .then(clearInFlight, clearInFlight);
  }

  function clearInFlight() {
    inFlight = null;
  }

  function clearRetry() {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    retryDelayMs = 0;
  }

  /* A failed fetch re-enters quickly instead of waiting out the full refresh
     interval (5-120 minutes): 10s, doubling each further failure, capped at
     the configured interval. This is what lets a cold boot before Wi-Fi
     associates recover in well under a minute instead of sitting on the
     C64 error screen for up to 15 minutes. The endpoints are public and
     rate-limited, so this stays a bounded backoff, never a tight loop. */
  function scheduleRetry() {
    var capMs = readRefreshMinutes() * 60000;
    retryDelayMs = retryDelayMs ? Math.min(retryDelayMs * 2, capMs) : RETRY_INITIAL_MS;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(function () { refresh(true); }, retryDelayMs);
  }

  function scheduleRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(function () { refresh(true); }, readRefreshMinutes() * 60000);
  }

  /* ---------- iCUE lifecycle ---------- */

  function onIcueDataUpdated() {
    var query = readLocation();
    var locationChanged = (lastQuery !== null && lastQuery !== query);
    /* The theme setting can change here too, and the boot screen is only drawn
       by renderStatic - without this a theme picked in the settings panel did
       not appear until the widget was reloaded. */
    renderStatic();
    render();
    scheduleRefresh();
    refresh(locationChanged);
  }

  function onIcueInitialized() {
    if (typeof iCUE !== 'undefined' && iCUE.iCUELanguage) {
      languageCode = iCUE.iCUELanguage;
    }
    onIcueDataUpdated();
  }

  /* The handlers are exposed here and bound to `icueEvents` by a bare assignment
     in index.html. That assignment cannot live in this file: it is an implicit
     global, which throws under the 'use strict' directive above, and iCUE's
     import validator only recognises the binding when it appears in the page. */
  window.C64Weather = {
    onDataUpdated: onIcueDataUpdated,
    onICUEInitialized: onIcueInitialized
  };

  function cacheElements() {
    els.root = document.querySelector('.widget-root');
    els.boot = document.getElementById('boot');
    els.machine = document.getElementById('machine');
    els.load = document.getElementById('load-line');
    els.ready = document.getElementById('ready-text');
    els.readyLine = document.querySelector('.ready-line');
    els.versionTag = document.getElementById('version-tag');
    els.temp = document.getElementById('temp');
    els.condition = document.getElementById('condition');
    els.city = document.getElementById('city');
    els.range = document.getElementById('range');
    els.statUp = document.getElementById('stat-up');
    els.statDown = document.getElementById('stat-down');
    els.statWind = document.getElementById('stat-wind');
    els.statFeels = document.getElementById('stat-feels');
    els.statHum = document.getElementById('stat-hum');
    els.sprite = document.getElementById('sprite');
    els.offline = document.getElementById('offline');
    els.loadingA = document.getElementById('loading-a');
    els.loadingB = document.getElementById('loading-b');
    els.errorA = document.getElementById('error-a');
    els.errorB = document.getElementById('error-b');
    els.emptyA = document.getElementById('empty-a');
    els.emptyB = document.getElementById('empty-b');
  }

  /* A single false read of iCUE_initialized is a race, not proof of a browser. */
  var bootAttempts = 0, BOOT_RETRY_MS = 100, BOOT_RETRY_MAX = 15;
  function bootCheck() {
    if (typeof iCUE_initialized !== 'undefined' && iCUE_initialized) {
      onIcueInitialized();
      return;
    }
    if (bootAttempts < BOOT_RETRY_MAX) {
      bootAttempts++;
      setTimeout(bootCheck, BOOT_RETRY_MS);
      return;
    }
    onIcueDataUpdated();
  }

  /* Tap anywhere to step to the next theme. Needs "interactive": true in
     manifest.json, without which iCUE never forwards touches to the page.
     A plain click listener would also fire at the end of a drag, so a gesture
     counts as a tap only if the pointer barely moved and was not held. Pointer
     events cover mouse and touch alike; the click fallback is for any context
     that does not deliver them.

     DECIDED: tap stays cycleTheme-only, even in error-state, rather than also
     forcing a refresh there. It is the one gesture this device forwards, it
     already has a settled, shipped meaning, and overloading it would make it
     ambiguous right when a user is staring at the error screen wondering
     what a tap will do. The retry backoff below now closes the actual gap
     (recovering in well under a minute on its own); a tap-to-retry would
     only shave a few seconds off that in the rare case someone is watching
     the screen at that exact moment, and touch-drag is not forwarded here
     so there is no unused second gesture to spend on it either. Revisit
     only if the backoff still leaves a case where the widget sits idle
     for longer than a user is willing to wait with their eyes on it. */
  function bindTap() {
    var startX = 0, startY = 0, startT = 0, tracking = false;

    function down(e) {
      tracking = true;
      startX = e.clientX;
      startY = e.clientY;
      startT = Date.now();
    }

    function up(e) {
      if (!tracking) return;
      tracking = false;
      var moved = Math.abs(e.clientX - startX) > TAP_SLOP_PX ||
                  Math.abs(e.clientY - startY) > TAP_SLOP_PX;
      if (!moved && (Date.now() - startT) <= TAP_MAX_MS) cycleTheme();
    }

    if (typeof window.PointerEvent === 'function') {
      document.addEventListener('pointerdown', down);
      document.addEventListener('pointerup', up);
      document.addEventListener('pointercancel', function () { tracking = false; });
    } else {
      document.addEventListener('click', cycleTheme);
    }
  }

  cacheElements();
  loadThemeOverride();
  renderStatic();
  showState('loading-state');
  current = loadCache();
  if (current) render();
  bindTap();
  bootCheck();
})();
