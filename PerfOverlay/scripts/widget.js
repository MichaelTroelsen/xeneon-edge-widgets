/* Perf Overlay - FPS | GPU | CPU | LAT, the NVIDIA overlay's Basic view.
 *
 * Everything but FPS comes from http://127.0.0.1:41777/perf. FPS comes from the
 * same feed when it has one, and otherwise from iCUE's own Fps plugin
 * (widgetbuilder.fpsdataprovider:Fps:1.0). A field nobody could read is
 * rendered N/A, never 0: 0 % GPU is a real reading and must stay
 * distinguishable from "no reading".
 */
(function () {
  'use strict';

  var DEFAULT_FEED = 'http://127.0.0.1:41777/perf';
  var POLL_MS = 1000;
  var REQUEST_TIMEOUT_MS = 800;
  var NA = 'N/A';

  var timer = null;
  var perf = null;          /* last good /perf body, or null after a failure */
  var signalConnected = false;

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

  function readFeedUrl() {
    var raw = getIcueProperty('feedUrl');
    return (typeof raw === 'string' && raw.trim()) ? raw.trim() : DEFAULT_FEED;
  }

  function applyTheme() {
    var light = getIcueProperty('colorTheme') === 'light';
    document.documentElement.setAttribute('data-theme', light ? 'light' : 'dark');
  }

  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  /* iCUE's Fps plugin. Null when it is absent, not yet initialised, or says it
     has no FPS data. */
  function pluginFps() {
    var p = window.plugins && window.plugins.Fpsdataprovider;
    if (!p) return null;
    if (p.fpsAvailable === false) return null;
    return isNum(p.currentFps) ? p.currentFps : null;
  }

  function show(id, text) {
    var el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  function fmt(v, unit) {
    return isNum(v) ? String(Math.round(v)) + (unit ? ' ' + unit : '') : NA;
  }

  function render() {
    var fps = (perf && isNum(perf.fps)) ? perf.fps : pluginFps();
    show('v-fps', fmt(fps, ''));
    show('v-gpu', fmt(perf && perf.gpu, '%'));
    show('v-cpu', fmt(perf && perf.cpu, '%'));
    show('v-lat', fmt(perf && perf.lat, 'ms'));
  }

  function fetchPerf() {
    var controller = (typeof AbortController === 'function') ? new AbortController() : null;
    var timeout = setTimeout(function () { if (controller) controller.abort(); }, REQUEST_TIMEOUT_MS);
    var opts = controller ? { signal: controller.signal, cache: 'no-store' } : { cache: 'no-store' };
    return fetch(readFeedUrl(), opts)
      .then(function (res) {
        clearTimeout(timeout);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (json) {
        perf = (json && typeof json === 'object') ? json : null;
        render();
      })
      .catch(function () {
        clearTimeout(timeout);
        perf = null;      /* stale numbers would read as live ones */
        render();
      });
  }

  function connectFpsSignal() {
    var p = window.plugins && window.plugins.Fpsdataprovider;
    if (!signalConnected && p && p.fpsUpdated && typeof p.fpsUpdated.connect === 'function') {
      p.fpsUpdated.connect(render);
      signalConnected = true;
    }
  }

  function start() {
    applyTheme();
    connectFpsSignal();
    render();
    if (timer) clearInterval(timer);
    timer = setInterval(fetchPerf, POLL_MS);
    fetchPerf();
  }

  window.PerfOverlay = {
    onDataUpdated: start,
    onICUEInitialized: start,
    onFpsPluginInitialized: function () { connectFpsSignal(); render(); }
  };

  /* Outside iCUE nothing calls onICUEInitialized; start on load as well. */
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
