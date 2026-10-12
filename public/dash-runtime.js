/*
 * ImpulseMotion — runtime « dash » des dashboards du staff (Mes dashboards).
 *
 * Chargé dans un <iframe sandbox="allow-scripts"> avant la page du dashboard.
 * Même contrat que le type « Dashboard » de Claude, pour qu'une page écrite là-bas
 * tourne ici telle quelle :
 *   dash.data(id)            → { status, data, columns, meta, message, refreshing }
 *   dash.onData(fn)          → fn maintenant, puis à chaque donnée ou redimensionnement
 *   dash.loader(id, {fn})    → met en forme la réponse brute d'un outil ({answer, args, call, read})
 *   dash.calc(id, {inputs, fn, title, description}) → valeur dérivée (fn(...inputs))
 *   dash.refresh(id?)        → redemande la source (ou toutes) au parent
 *   dash.params() / setParams(obj) / resetParams()
 *   dash.colors              → palette
 *   dash.setLink(hash)       → ancre dans l'adresse du parent (info seulement)
 *
 * Les données viennent du parent (ImpulseMotion) par postMessage ; la page ne
 * touche jamais au réseau. Messages :
 *   parent → iframe : { type: "dash:data", results: { id: { status, answer | message, at } }, params }
 *   iframe → parent : { type: "dash:ready", datasets: [...ids] }
 *                     { type: "dash:refresh", ids: [...] | null }
 *                     { type: "dash:params", params }
 *                     { type: "dash:height", height }
 *                     { type: "dash:sources", sources: [{ id, kind, status, message, title, description, rows }] }
 */
(function () {
  "use strict";
  var raw = {};        // id → { status, answer, message, at, refreshing }
  var loaders = {};    // id → { fn, description }
  var calcs = {};      // id → { inputs, fn, title, description }
  var cache = {};      // id → computed { status, data, columns, meta, message }
  var listeners = [];
  var params = {};
  var defaults = {};
  var booted = false;
  var dirty = true;

  function post(msg) { try { window.parent.postMessage(msg, "*"); } catch (e) { /* noop */ } }

  function asRows(answer) {
    var a = answer;
    if (typeof a === "string") { try { a = JSON.parse(a); } catch (e) { return { data: a, columns: [] }; } }
    if (Array.isArray(a) && a.length === 1 && a[0] && typeof a[0] === "object" && !Array.isArray(a[0]) && (a[0].rows || a[0].data || a[0].results)) a = a[0];
    if (a && typeof a === "object" && !Array.isArray(a)) {
      var inner = a.rows || a.data || a.results;
      if (Array.isArray(inner)) a = inner;
    }
    if (Array.isArray(a) && a.every(function (r) { return r && typeof r === "object" && !Array.isArray(r); })) {
      var cols = [];
      a.forEach(function (r) { Object.keys(r).forEach(function (k) { if (cols.indexOf(k) < 0) cols.push(k); }); });
      return { data: a, columns: cols };
    }
    return { data: a, columns: [] };
  }

  function shape(result) {
    if (Array.isArray(result)) {
      var cols = [];
      result.forEach(function (r) { if (r && typeof r === "object") Object.keys(r).forEach(function (k) { if (cols.indexOf(k) < 0) cols.push(k); }); });
      return { data: result, columns: cols, meta: [] };
    }
    if (result && typeof result === "object") {
      if (Array.isArray(result.rows)) return { data: result.rows, columns: result.columns || Object.keys(result.rows[0] || {}), meta: result.meta || [] };
      if (result.data !== undefined) return { data: result.data, columns: result.columns || [], meta: result.meta || [] };
    }
    return { data: result, columns: [], meta: [] };
  }

  var readers = {
    bigquery: function (a) { return asRows(a).data; },
    governed: function (a) { return asRows(a).data; },
    snowflake: function (a) { return asRows(a).data; },
    databricks: function (a) { return asRows(a).data; },
  };

  function computeSource(id) {
    var r = raw[id];
    if (!r) return booted
      ? { status: "error", data: [], columns: [], meta: [], message: "Source « " + id + " » inconnue : ni jeu de données du dashboard, ni calcul.", refreshing: false }
      : { status: "loading", data: [], columns: [], meta: [], message: null, refreshing: false };
    if (r.status !== "ok") return { status: r.status, data: [], columns: [], meta: [], message: r.message || null, refreshing: false };
    var loader = loaders[id];
    try {
      if (loader) {
        var out = loader.fn({
          answer: r.answer,
          args: r.args || {},
          call: function () { throw new Error("call() n'est pas disponible dans ImpulseMotion : une source = un appel."); },
          read: readers,
        });
        if (out && typeof out.then === "function") throw new Error("Le loader de « " + id + "» est asynchrone : non pris en charge.");
        var s = shape(out);
        return { status: "ok", data: s.data, columns: s.columns, meta: s.meta, message: null, refreshing: !!r.refreshing };
      }
      var rows = asRows(r.answer);
      return { status: "ok", data: rows.data, columns: rows.columns, meta: [], message: null, refreshing: !!r.refreshing };
    } catch (e) {
      return { status: "error", data: [], columns: [], meta: [], message: String(e && e.message ? e.message : e), refreshing: false };
    }
  }

  function computeCalc(id, stack) {
    var c = calcs[id];
    stack = stack || [];
    if (stack.indexOf(id) >= 0) return { status: "error", data: [], columns: [], meta: [], message: "Dépendance circulaire : " + stack.concat(id).join(" → ") };
    var inputs = [];
    for (var i = 0; i < c.inputs.length; i++) {
      var dep = get(c.inputs[i], stack.concat(id));
      if (dep.status !== "ok") return { status: dep.status === "loading" ? "loading" : "error", data: [], columns: [], meta: [], message: dep.status === "loading" ? null : "Source « " + c.inputs[i] + " » : " + (dep.message || dep.status), refreshing: false };
      inputs.push(dep.data);
    }
    try {
      var out = c.fn.apply(null, inputs);
      var s = shape(out);
      return { status: "ok", data: s.data, columns: s.columns, meta: s.meta, message: null, refreshing: false };
    } catch (e) {
      return { status: "error", data: [], columns: [], meta: [], message: String(e && e.message ? e.message : e), refreshing: false };
    }
  }

  function get(id, stack) {
    if (cache[id]) return cache[id];
    var v = calcs[id] ? computeCalc(id, stack) : computeSource(id);
    // Older pages read .rows / .value
    v.rows = Array.isArray(v.data) ? v.data : [];
    v.value = v.data;
    cache[id] = v;
    return v;
  }

  function invalidate() { cache = {}; dirty = true; }

  var scheduled = false;
  function notify() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(function () {
      scheduled = false;
      listeners.forEach(function (fn) { try { fn(); } catch (e) { console.error("[dash] onData", e); } });
      reportSources();
      reportHeight();
    }, 0);
  }

  function reportSources() {
    var ids = Object.keys(raw).concat(Object.keys(calcs).filter(function (k) { return !raw[k]; }));
    var sources = ids.map(function (id) {
      var v = get(id);
      return { id: id, kind: calcs[id] ? "calc" : "source", status: v.status, message: v.message || null, title: calcs[id] ? calcs[id].title || id : null, description: calcs[id] ? calcs[id].description || null : (loaders[id] ? loaders[id].description || null : null), rows: Array.isArray(v.data) ? v.data.length : null, at: raw[id] && raw[id].at ? raw[id].at : null };
    });
    post({ type: "dash:sources", sources: sources });
  }

  var lastH = 0;
  function reportHeight() {
    var h = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
    if (Math.abs(h - lastH) > 2) { lastH = h; post({ type: "dash:height", height: h }); }
  }

  var dash = {
    colors: ["#8b5cf6", "#22c55e", "#f59e0b", "#3b82f6", "#ec4899", "#14b8a6", "#f97316", "#a3e635"],
    data: function (id) { return get(String(id)); },
    onData: function (fn) { if (typeof fn === "function") { listeners.push(fn); if (booted) { try { fn(); } catch (e) { console.error("[dash] onData", e); } } } },
    loader: function (id, def) { loaders[String(id)] = { fn: def && def.fn, description: def && def.description }; invalidate(); if (booted) notify(); },
    calc: function (id, def) { calcs[String(id)] = { inputs: (def && def.inputs) || [], fn: def && def.fn, title: def && def.title, description: def && def.description }; invalidate(); if (booted) notify(); },
    refresh: function (id) {
      var ids = id == null ? null : [String(id)];
      (ids || Object.keys(raw)).forEach(function (k) { if (raw[k]) raw[k].refreshing = true; });
      invalidate(); notify();
      post({ type: "dash:refresh", ids: ids });
    },
    params: function () { return JSON.parse(JSON.stringify(params)); },
    setParams: function (obj) {
      if (!obj || typeof obj !== "object") return;
      Object.keys(obj).forEach(function (k) { var v = obj[k]; if (v === undefined) return; params[k] = v; });
      invalidate(); notify();
      post({ type: "dash:params", params: dash.params() });
    },
    resetParams: function () { params = JSON.parse(JSON.stringify(defaults)); invalidate(); notify(); post({ type: "dash:params", params: dash.params() }); },
    setLink: function (hash) { post({ type: "dash:link", hash: String(hash || "") }); },
    __boot: function (datasetIds, defaultParams) {
      defaults = defaultParams && typeof defaultParams === "object" ? defaultParams : {};
      params = JSON.parse(JSON.stringify(defaults));
      (datasetIds || []).forEach(function (id) { if (!raw[id]) raw[id] = { status: "loading", answer: null, message: null, at: null, refreshing: false }; });
      booted = true;
      invalidate(); notify();
      post({ type: "dash:ready", datasets: Object.keys(raw) });
    },
  };

  window.addEventListener("message", function (ev) {
    var msg = ev.data;
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "dash:data" && msg.results && typeof msg.results === "object") {
      Object.keys(msg.results).forEach(function (id) {
        var r = msg.results[id] || {};
        raw[id] = { status: r.status === "ok" ? "ok" : (r.status || "error"), answer: r.answer, args: r.args, message: r.message || null, at: r.at || null, refreshing: false };
      });
      if (msg.params && typeof msg.params === "object") { params = JSON.parse(JSON.stringify(msg.params)); }
      invalidate(); notify();
    }
  });
  window.addEventListener("resize", function () { invalidate(); notify(); });
  window.addEventListener("load", reportHeight);
  if (window.ResizeObserver) { new ResizeObserver(function () { reportHeight(); }).observe(document.documentElement); }

  window.dash = dash;
})();
