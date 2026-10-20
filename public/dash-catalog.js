/*
 * ImpulseMotion — catalogue de métriques et de dimensions des dashboards du staff.
 *
 * Un seul fichier, chargé à deux endroits avec le même code :
 *   - dans le cadre isolé des pages (window.DashCatalog, avant dash-runtime.js) ;
 *   - dans l'app (import CommonJS depuis lib/staff-dashboards/catalog.ts) pour
 *     valider une formule au moment où le consultant l'écrit, et la tester.
 *
 * Une MÉTRIQUE est une formule arithmétique sur les champs d'une ligne :
 *   "cost_micros / 1000000 / conversions", "actions.purchase / clicks * 100".
 *   Identifiants = chemins de champs (points autorisés) ; nombres ; + - * / % ;
 *   parenthèses ; fonctions : abs, min, max, round(x, n), coalesce(a, b…),
 *   pct(a, b) = a / b × 100, div(a, b). Une division par zéro vaut 0.
 *   Un champ est cherché tel quel, puis en camelCase / snake_case, puis sous
 *   `metrics` (GAQL) ; une liste Meta [{action_type, value}] se lit par type
 *   (actions.purchase). Les chaînes numériques sont converties.
 *
 * Une DIMENSION lit un champ ("field"), en extrait un groupe par expression
 * régulière ("regex") ou le classe par motifs ("mapping"), avec un repli.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (root) root.DashCatalog = api;
})(typeof window !== "undefined" ? window : typeof globalThis !== "undefined" ? globalThis : null, function () {
  "use strict";

  var FUNCTIONS = {
    abs: function (a) { return Math.abs(num(a[0])); },
    min: function (a) { return a.length ? Math.min.apply(null, a.map(num)) : 0; },
    max: function (a) { return a.length ? Math.max.apply(null, a.map(num)) : 0; },
    round: function (a) { var n = Math.max(0, Math.min(6, Math.floor(num(a[1])))); var f = Math.pow(10, n); return Math.round(num(a[0]) * f) / f; },
    coalesce: function (a) { for (var i = 0; i < a.length; i++) { if (a[i] !== null && a[i] !== undefined && !(typeof a[i] === "number" && isNaN(a[i]))) return num(a[i]); } return 0; },
    pct: function (a) { var b = num(a[1]); return b === 0 ? 0 : (num(a[0]) / b) * 100; },
    div: function (a) { var b = num(a[1]); return b === 0 ? 0 : num(a[0]) / b; },
  };

  function num(v) {
    if (typeof v === "number") return isFinite(v) ? v : 0;
    if (typeof v === "string") { var n = Number(v.replace(/\s/g, "").replace(",", ".")); return isFinite(n) ? n : 0; }
    if (typeof v === "boolean") return v ? 1 : 0;
    return 0;
  }

  // ── Lexer / parser (Pratt) ────────────────────────────────────────────────
  var IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:[.:][A-Za-z0-9_]+)*/;

  function tokenize(src) {
    var out = [], i = 0, s = String(src);
    while (i < s.length) {
      var c = s[i];
      if (/\s/.test(c)) { i++; continue; }
      if (/[0-9.]/.test(c)) {
        var m = s.slice(i).match(/^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/);
        if (!m) throw new Error("nombre illisible à la position " + (i + 1));
        out.push({ t: "num", v: Number(m[0]) }); i += m[0].length; continue;
      }
      var id = s.slice(i).match(IDENT_RE);
      if (id) { out.push({ t: "id", v: id[0] }); i += id[0].length; continue; }
      if ("+-*/%(),".indexOf(c) >= 0) { out.push({ t: c }); i++; continue; }
      throw new Error("caractère inattendu « " + c + " » à la position " + (i + 1));
    }
    out.push({ t: "end" });
    return out;
  }

  function parse(src) {
    var toks = tokenize(src), pos = 0;
    function peek() { return toks[pos]; }
    function next() { return toks[pos++]; }
    function expect(t) { var k = next(); if (k.t !== t) throw new Error("attendu « " + t + " »" + (k.t === "end" ? " avant la fin" : " à la place de « " + (k.v !== undefined ? k.v : k.t) + " »")); return k; }
    function primary() {
      var k = next();
      if (k.t === "num") return { k: "num", v: k.v };
      if (k.t === "-") return { k: "neg", a: unary() };
      if (k.t === "+") return unary();
      if (k.t === "(") { var e = expr(0); expect(")"); return e; }
      if (k.t === "id") {
        if (peek().t === "(") {
          next();
          var name = k.v.toLowerCase();
          if (!Object.prototype.hasOwnProperty.call(FUNCTIONS, name)) throw new Error("fonction inconnue « " + k.v + " » (abs, min, max, round, coalesce, pct, div)");
          var args = [];
          if (peek().t !== ")") { args.push(expr(0)); while (peek().t === ",") { next(); args.push(expr(0)); } }
          expect(")");
          return { k: "fn", f: name, args: args };
        }
        return { k: "field", path: k.v };
      }
      throw new Error(k.t === "end" ? "formule incomplète" : "élément inattendu « " + (k.v !== undefined ? k.v : k.t) + " »");
    }
    function unary() { return primary(); }
    var PREC = { "+": 1, "-": 1, "*": 2, "/": 2, "%": 2 };
    function expr(minPrec) {
      var left = unary();
      for (;;) {
        var op = peek().t;
        var p = PREC[op];
        if (p === undefined || p < minPrec) return left;
        next();
        var right = expr(p + 1);
        left = { k: "bin", op: op, a: left, b: right };
      }
    }
    var tree = expr(0);
    if (peek().t !== "end") throw new Error("texte en trop après la formule : « " + (peek().v !== undefined ? peek().v : peek().t) + " »");
    return tree;
  }

  function fieldsOfTree(node, out) {
    if (!node) return out;
    if (node.k === "field") { if (out.indexOf(node.path) < 0) out.push(node.path); }
    else if (node.k === "neg") fieldsOfTree(node.a, out);
    else if (node.k === "bin") { fieldsOfTree(node.a, out); fieldsOfTree(node.b, out); }
    else if (node.k === "fn") node.args.forEach(function (a) { fieldsOfTree(a, out); });
    return out;
  }

  // ── Lecture d'un champ dans une ligne ─────────────────────────────────────
  var snake = function (s) { return s.replace(/[A-Z]/g, function (c) { return "_" + c.toLowerCase(); }); };
  var camel = function (s) { return s.replace(/_([a-z0-9])/g, function (_, c) { return c.toUpperCase(); }); };

  function pick(obj, key) {
    if (!obj || typeof obj !== "object") return undefined;
    if (Array.isArray(obj)) {
      // Liste Meta [{action_type, value}] : lue par type d'action.
      for (var i = 0; i < obj.length; i++) {
        var x = obj[i];
        if (x && typeof x === "object" && (x.action_type === key || x.actionType === key)) return x.value;
      }
      return undefined;
    }
    if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
    var c = camel(key), s = snake(key);
    if (c !== key && Object.prototype.hasOwnProperty.call(obj, c)) return obj[c];
    if (s !== key && Object.prototype.hasOwnProperty.call(obj, s)) return obj[s];
    return undefined;
  }

  function walk(obj, segs) {
    var cur = obj;
    for (var i = 0; i < segs.length; i++) {
      // Un type d'action Meta avec des points (offsite_conversion.fb_pixel_purchase) : la fin du chemin d'un coup.
      if (Array.isArray(cur)) { var rest = segs.slice(i).join("."); var v = pick(cur, rest); return v; }
      cur = pick(cur, segs[i]);
      if (cur === undefined) return undefined;
    }
    return cur;
  }

  /** La valeur brute d'un chemin dans une ligne, ou undefined. */
  function resolve(row, path) {
    if (!row || typeof row !== "object") return undefined;
    var p = String(path);
    if (Object.prototype.hasOwnProperty.call(row, p)) return row[p];
    var segs = p.split(/[.:]/);
    var v = walk(row, segs);
    if (v !== undefined) return v;
    // GAQL : metrics.x / segments.x / campaign.x, ou un champ nu cherché sous metrics.
    if (row.metrics && typeof row.metrics === "object" && segs[0] !== "metrics") { v = walk(row.metrics, segs); if (v !== undefined) return v; }
    return undefined;
  }

  function evalTree(node, row) {
    switch (node.k) {
      case "num": return node.v;
      case "field": return num(resolve(row, node.path));
      case "neg": return -evalTree(node.a, row);
      case "fn": {
        // coalesce : un champ absent de la ligne compte comme absent (pas comme 0).
        var args = node.args.map(function (a) {
          if (node.f === "coalesce" && a.k === "field") { var raw = resolve(row, a.path); return raw === undefined || raw === null || raw === "" ? undefined : num(raw); }
          return evalTree(a, row);
        });
        return FUNCTIONS[node.f](args);
      }
      case "bin": {
        var a = evalTree(node.a, row), b = evalTree(node.b, row);
        switch (node.op) {
          case "+": return a + b;
          case "-": return a - b;
          case "*": return a * b;
          case "/": return b === 0 ? 0 : a / b;
          case "%": return b === 0 ? 0 : a % b;
        }
      }
    }
    return 0;
  }

  var compiled = {};
  function compile(formula) {
    var key = String(formula);
    if (!compiled[key]) compiled[key] = parse(key);
    return compiled[key];
  }

  /** { ok: true, fields } ou { ok: false, error }. */
  function validateFormula(formula) {
    try { var t = parse(formula); return { ok: true, fields: fieldsOfTree(t, []) }; }
    catch (e) { return { ok: false, error: e && e.message ? e.message : String(e) }; }
  }

  function evaluate(formula, row) {
    var v = evalTree(compile(formula), row || {});
    return isFinite(v) ? v : 0;
  }

  // ── Dimensions ────────────────────────────────────────────────────────────
  function regexOf(pattern, flags) {
    try { return new RegExp(pattern, flags || "i"); } catch (e) { return null; }
  }

  /** La valeur de la dimension pour une ligne (toujours une chaîne). */
  function derive(dimension, row) {
    var d = dimension || {};
    var raw = resolve(row, d.field);
    var text = raw === null || raw === undefined ? "" : String(raw);
    var fallback = d.rule && typeof d.rule.fallback === "string" ? d.rule.fallback : "Autre";
    if (d.kind === "regex") {
      var re = regexOf(d.rule && d.rule.pattern, d.rule && d.rule.flags);
      if (!re) return fallback;
      var m = text.match(re);
      if (!m) return fallback;
      var g = d.rule && typeof d.rule.group === "number" ? d.rule.group : 1;
      var out = m[g] !== undefined ? m[g] : m[0];
      return out && out.trim() ? out.trim() : fallback;
    }
    if (d.kind === "mapping") {
      var items = d.rule && Array.isArray(d.rule.values) ? d.rule.values : [];
      var lower = text.toLowerCase();
      for (var i = 0; i < items.length; i++) {
        var it = items[i] || {};
        var match = String(it.match || "");
        if (!match) continue;
        if (it.regex) { var r2 = regexOf(match, "i"); if (r2 && r2.test(text)) return String(it.value); }
        else if (lower.indexOf(match.toLowerCase()) >= 0) return String(it.value);
      }
      return fallback;
    }
    return text || fallback;
  }

  function validateDimension(d) {
    if (!d || typeof d !== "object") return { ok: false, error: "dimension vide" };
    if (!d.field || typeof d.field !== "string") return { ok: false, error: "champ source requis" };
    if (d.kind === "regex") {
      if (!d.rule || typeof d.rule.pattern !== "string" || !d.rule.pattern) return { ok: false, error: "expression régulière requise" };
      if (!regexOf(d.rule.pattern, d.rule.flags)) return { ok: false, error: "expression régulière invalide" };
    } else if (d.kind === "mapping") {
      var items = d.rule && Array.isArray(d.rule.values) ? d.rule.values : [];
      if (!items.length) return { ok: false, error: "au moins un motif → valeur" };
      for (var i = 0; i < items.length; i++) {
        if (!items[i] || typeof items[i].match !== "string" || !items[i].match || typeof items[i].value !== "string") return { ok: false, error: "chaque ligne doit avoir un motif et une valeur" };
        if (items[i].regex && !regexOf(items[i].match, "i")) return { ok: false, error: "motif " + (i + 1) + " : expression régulière invalide" };
      }
    } else if (d.kind !== "field") return { ok: false, error: "type inconnu (field, regex ou mapping)" };
    return { ok: true };
  }

  // ── Format ────────────────────────────────────────────────────────────────
  function format(def, value, currency) {
    var v = num(value);
    var fmt = def && def.format ? def.format : "number";
    var loc = "fr-FR";
    try {
      if (fmt === "integer") return new Intl.NumberFormat(loc, { maximumFractionDigits: 0 }).format(v);
      if (fmt === "currency") return new Intl.NumberFormat(loc, { style: "currency", currency: currency || (def && def.unit) || "EUR", maximumFractionDigits: v >= 100 ? 0 : 2 }).format(v);
      if (fmt === "percent") return new Intl.NumberFormat(loc, { maximumFractionDigits: 2 }).format(v) + " %";
      if (fmt === "ratio") return new Intl.NumberFormat(loc, { maximumFractionDigits: 2 }).format(v) + "x";
      return new Intl.NumberFormat(loc, { maximumFractionDigits: 2 }).format(v);
    } catch (e) { return String(v); }
  }

  // ── Agrégation ────────────────────────────────────────────────────────────
  /**
   * Regroupe des lignes par dimension (null = un seul groupe), additionne les
   * champs que les métriques utilisent, puis évalue chaque métrique sur le
   * total du groupe. Rend [{ key, count, fields: {…sommes}, metrics: {…} }].
   */
  function rollup(rows, dimension, metrics) {
    var list = Array.isArray(rows) ? rows : [];
    var defs = Array.isArray(metrics) ? metrics : [];
    var fields = [];
    defs.forEach(function (m) { var v = validateFormula(m.formula); if (v.ok) v.fields.forEach(function (f) { if (fields.indexOf(f) < 0) fields.push(f); }); });
    var groups = {}, order = [];
    list.forEach(function (row) {
      var key = dimension ? derive(dimension, row) : "Total";
      if (!groups[key]) { groups[key] = { key: key, count: 0, fields: {} }; order.push(key); fields.forEach(function (f) { groups[key].fields[f] = 0; }); }
      var g = groups[key];
      g.count++;
      fields.forEach(function (f) { g.fields[f] += num(resolve(row, f)); });
    });
    return order.map(function (key) {
      var g = groups[key];
      var out = { key: key, count: g.count, fields: g.fields, metrics: {} };
      defs.forEach(function (m) { out.metrics[m.key] = evaluate(m.formula, g.fields); });
      return out;
    });
  }

  return {
    validateFormula: validateFormula,
    fieldsOf: function (formula) { var v = validateFormula(formula); return v.ok ? v.fields : []; },
    evaluate: evaluate,
    resolve: resolve,
    derive: derive,
    validateDimension: validateDimension,
    format: format,
    rollup: rollup,
    num: num,
  };
});
