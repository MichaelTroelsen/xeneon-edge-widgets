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
  var WIDGET_VERSION = '1.2.0';
  var BOOT_BANNER = '**** COMMODORE 64 WEATHER V' + WIDGET_VERSION + ' ****';
  var BOOT_RAM = '64K RAM SYSTEM  38911 BASIC BYTES FREE';
  var LOAD_LINE = 'LOAD"WEATHER",8,1';

  var els = {};
  var refreshTimer = null;
  var inFlight = null;
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
    return fetch(url, opts).then(function (res) {
      clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }, function (err) {
      clearTimeout(timer);
      throw err;
    });
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

  function renderStatic() {
    PETSCII.setText(els.banner, BOOT_BANNER);
    PETSCII.setText(els.ram, BOOT_RAM);
    PETSCII.setText(els.load, LOAD_LINE);
    PETSCII.setText(els.ready, 'READY.');
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
          /* Geocoder answered, the place just does not exist. */
          if (!current) showState('empty-state');
          return null;
        }
        return fetchWeather(place).then(function (reading) {
          current = reading;
          lastQuery = query;
          offline = false;
          saveCache(reading);
          render();
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
      })
      .then(function () { inFlight = null; });
  }

  function scheduleRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(function () { refresh(true); }, readRefreshMinutes() * 60000);
  }

  /* ---------- iCUE lifecycle ---------- */

  function onIcueDataUpdated() {
    var query = readLocation();
    var locationChanged = (lastQuery !== null && lastQuery !== query);
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
    els.banner = document.getElementById('boot-banner');
    els.ram = document.getElementById('boot-ram');
    els.load = document.getElementById('load-line');
    els.ready = document.getElementById('ready-text');
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

  cacheElements();
  renderStatic();
  showState('loading-state');
  current = loadCache();
  if (current) render();
  bootCheck();
})();
