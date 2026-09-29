import { describe, expect, it } from "vitest";
import {
  capMiddle, createReadLedger, foldOutput, renderFileList, renderJson, renderSkillList, renderValue, sliceNote, sliceText,
} from "../../server/mcp-compact-generic.mjs";

const pretty = (v: unknown) => JSON.stringify(v, null, 2);

/** Relit un tableau rendu : en-tête + lignes → objets (cellules vides = champ absent). */
function parseTable(text: string, title: string) {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.startsWith(`# ${title}`));
  const n = Number(/(\d+) lignes/.exec(lines[at])?.[1]);
  const cols = lines[at + 1].split("\t");
  return lines.slice(at + 2, at + 2 + n).map((l) => {
    const cells = l.split("\t");
    const row: Record<string, string> = {};
    cols.forEach((c, i) => { if (cells[i] !== "" && cells[i] !== undefined) row[c] = cells[i]; });
    return row;
  });
}

describe("renderJson — liste Drive (gws)", () => {
  const files = [1, 2, 3, 4].map((i) => ({
    kind: "drive#file",
    id: `1aJyS8fCYXz7PZ3LnzrGd1YjKmnp${i}`,
    name: i === 2 ? "Budget\t2026" : `Monthly ${i}`,
    mimeType: i === 4 ? "application/pdf" : "application/vnd.google-apps.presentation",
    modifiedTime: `2026-09-0${i}T07:39:56.178Z`,
    size: `0012728${i}`,
    ...(i === 3 ? {} : { owners: [{ displayName: "Data", emailAddress: "data@example.test" }] }),
  }));
  const raw = pretty({ nextPageToken: "tok~123", files });
  const { text, stats } = renderJson(raw);

  it("rend un tableau plus court que le JSON minifié", () => {
    expect(stats.mode).toBe("table");
    expect(stats.raw).toBe(raw.length);
    expect(text.length).toBeLessThan(JSON.stringify(JSON.parse(raw)).length);
    expect(text.split("\n")[0]).toBe("nextPageToken=tok~123");
    expect(text).toContain("# files : 4 lignes ; valeur identique sur chaque ligne : kind=drive#file");
  });

  it("ne perd ni ne réécrit aucune valeur", () => {
    const rows = parseTable(text, "files");
    expect(rows).toHaveLength(4);
    // Chaînes numériques intactes (zéros de tête), dates intactes, tabulation protégée.
    expect(rows.map((r) => r.size)).toEqual(files.map((f) => f.size));
    expect(rows.map((r) => r.modifiedTime)).toEqual(files.map((f) => f.modifiedTime));
    expect(JSON.parse(rows[1].name)).toBe("Budget\t2026");
    expect(JSON.parse(rows[0].owners)).toEqual(files[0].owners);
    // Champ absent = cellule vide, pas une valeur inventée.
    expect("owners" in rows[2]).toBe(false);
  });
});

describe("renderValue — formes", () => {
  it("distingue null, chaîne vide, champ absent et mots réservés", () => {
    const { text } = renderValue([{ a: null, b: "", c: "null" }, { a: 1, c: " x" }, { a: true, b: "[1]", c: "ok" }]);
    const lines = text.split("\n");
    expect(lines[1]).toBe("a\tb\tc");
    expect(lines[2]).toBe('null\t""\t"null"');
    expect(lines[3]).toBe('1\t\t" x"');
    expect(lines[4]).toBe('true\t"[1]"\tok');
  });

  it("aplatit les objets imbriqués en colonnes pointées (Agenda)", () => {
    const items = [1, 2].map((i) => ({ id: `e${i}`, etag: `"etag${i}"`, start: { dateTime: `2026-09-0${i}T09:00:00+02:00`, timeZone: "Europe/Paris" } }));
    const { text, mode } = renderValue({ items });
    expect(mode).toBe("table");
    expect(text).toContain("id\tetag\tstart.dateTime\tstart.timeZone");
    // etag conservé : il sert aux mises à jour conditionnelles.
    expect(text).toContain('"\\"etag1\\""');
  });

  it("rend une grille Sheets ligne par ligne, rangées inégales comprises", () => {
    const values = [["Client", "Budget", "Code postal"], ["Alpha", "1200,50", "01230"], ["Beta"]];
    const { text, mode } = renderValue({ range: "Feuille1!A1:C3", majorDimension: "ROWS", values });
    expect(mode).toBe("table");
    expect(text.split("\n")).toEqual([
      "range=Feuille1!A1:C3 ; majorDimension=ROWS",
      "# values : 3 lignes (grille)",
      "Client\tBudget\tCode postal",
      "Alpha\t1200,50\t01230",
      "Beta",
    ]);
  });

  it("rend chaque liste d'une réponse client-data dans son tableau", () => {
    const payload = {
      period: { from: "2026-09-01", to: "2026-09-07" }, currency: "EUR",
      total: { orders: 30, revenue: 1500.5 },
      by_type: [
        { prescriber_type: "veterinaire", orders: 20, revenue: 1000.5, revenue_share_pct: 66.68, orders_share_pct: 66.67 },
        { prescriber_type: "(aucun)", orders: 10, revenue: 500, revenue_share_pct: 33.32, orders_share_pct: 33.33 },
      ],
      top_codes: [
        { prescriber_code: "V001", prescriber_type: "veterinaire", orders: 12, revenue: 640 },
        { prescriber_code: "V002", prescriber_type: "veterinaire", orders: 8, revenue: 360.5 },
      ],
    };
    const { text, mode } = renderValue(payload);
    expect(mode).toBe("table");
    expect(text.split("\n")[0]).toBe("period.from=2026-09-01 ; period.to=2026-09-07 ; currency=EUR ; total.orders=30 ; total.revenue=1500.5");
    expect(parseTable(text, "by_type")[1]).toEqual({ prescriber_type: "(aucun)", orders: "10", revenue: "500", revenue_share_pct: "33.32", orders_share_pct: "33.33" });
    expect(parseTable(text, "top_codes")).toHaveLength(2);
    expect(text.length).toBeLessThan(JSON.stringify(payload).length);
  });

  it("reste en JSON minifié quand il n'y a pas de liste, qu'elle est courte, creuse ou hétérogène", () => {
    const flat = { orders: 3, statuses: { complete: 2, canceled: 1 } };
    expect(renderValue(flat)).toEqual({ text: JSON.stringify(flat), mode: "minified" });
    expect(renderValue({ files: [{ id: "a" }] }).mode).toBe("minified");
    expect(renderValue({ files: [] }).text).toBe('{"files":[]}');
    expect(renderValue([{ a: 1 }, "x"]).mode).toBe("minified");
    const sparse = [{ a: 1 }, { b: 2 }, { c: 3 }, { d: 4 }];
    expect(renderValue(sparse).text).toBe(JSON.stringify(sparse));
    const dotted = [{ "a.b": 1 }, { "a.b": 2 }];
    expect(renderValue(dotted).text).toBe(JSON.stringify(dotted));
  });
});

describe("renderJson — texte, erreurs, pages", () => {
  it("laisse intact ce qui n'est pas du JSON", () => {
    const t = "id  name\n1   Alpha\n";
    expect(renderJson(t)).toEqual({ text: t, stats: { raw: t.length, out: t.length, mode: "text" } });
    expect(renderJson("{pas du json").stats.mode).toBe("text");
  });

  it("ne fait que minifier une erreur", () => {
    const err = { error: { code: 403, message: "The caller does not have permission", errors: [{ reason: "forbidden", domain: "global" }, { reason: "x", domain: "y" }] } };
    expect(renderJson(pretty(err), { table: false }).text).toBe(JSON.stringify(err));
  });

  it("fusionne les pages NDJSON et ne garde que le jeton de la dernière", () => {
    const p1 = { files: [{ id: "a", name: "A" }, { id: "b", name: "B" }], nextPageToken: "t1" };
    const p2 = { files: [{ id: "c", name: "C" }] };
    const { text, stats } = renderJson(`${JSON.stringify(p1)}\n${JSON.stringify(p2)}\n`);
    expect(stats.pages).toBe(2);
    expect(text).toBe("[2 pages fusionnées]\n# files : 3 lignes\nid\tname\na\tA\nb\tB\nc\tC");
    const open = renderJson(`${JSON.stringify(p2)}\n${JSON.stringify(p1)}`).text;
    expect(open).toContain("nextPageToken=t1");
  });
});

describe("renderJson — nombres tels qu'ils sont écrits", () => {
  it("garde un entier au-delà de 2^53 et les décimales d'origine, en tableau comme en minifié", () => {
    const raw = '{"rows":[{"id":12345678901234567890,"v":1.10},{"id":9007199254740993,"v":2.0},{"id":-0,"v":1e3}]}';
    const { text, stats } = renderJson(raw);
    expect(stats.mode).toBe("table");
    expect(text.split("\n")).toEqual([
      "# rows : 3 lignes",
      "id\tv",
      "12345678901234567890\t1.10",
      "9007199254740993\t2.0",
      "-0\t1e3",
    ]);
    expect(renderJson(raw, { table: false }).text).toBe(raw);
    const nested = '{\n  "total": 12345678901234567890,\n  "ratio": 0.50,\n  "list": [18446744073709551615, 3]\n}';
    expect(renderJson(nested).text).toBe('{"total":12345678901234567890,"ratio":0.50,"list":[18446744073709551615,3]}');
  });

  it("ne confond pas un grand entier avec son arrondi dans une colonne constante ou un en-tête", () => {
    const raw = '{"total":9007199254740993,"rows":[{"a":9007199254740993,"b":1},{"a":9007199254740992,"b":2},{"a":9007199254740993,"b":3}]}';
    const { text } = renderJson(raw);
    expect(text.split("\n")).toEqual([
      "total=9007199254740993",
      "# rows : 3 lignes",
      "a\tb",
      "9007199254740993\t1",
      "9007199254740992\t2",
      "9007199254740993\t3",
    ]);
  });

  it("laisse les chaînes et les nombres ordinaires comme avant", () => {
    const raw = '[{"a":"12345678901234567890","b":12.5},{"a":"1.10","b":-3}]';
    expect(renderJson(raw).text).toBe("# 2 lignes\na\tb\n12345678901234567890\t12.5\n1.10\t-3");
  });

  it("garde les grands entiers à travers la fusion de pages", () => {
    const { text } = renderJson('{"files":[{"id":12345678901234567890,"n":"A"}]}\n{"files":[{"id":12345678901234567891,"n":"B"}]}');
    expect(text).toBe("[2 pages fusionnées]\n# files : 2 lignes\nid\tn\n12345678901234567890\tA\n12345678901234567891\tB");
  });
});

describe("renderValue — cellules qui imitent la forme", () => {
  it("protège une cellule qui commence comme un titre de section", () => {
    const { text } = renderValue([{ a: "# files : 9 lignes", b: "x" }, { a: "z", b: "y" }]);
    const lines = text.split("\n");
    expect(lines.filter((l) => l.startsWith("#"))).toEqual(["# 2 lignes"]);
    expect(lines[2]).toBe('"# files : 9 lignes"\tx');
    const grid = renderValue({ values: [["# x : 9 lignes", "b"], ["c", "d"], ["e", "f"], ["g", "h"]] }).text.split("\n");
    expect(grid.filter((l) => l.startsWith("#"))).toEqual(["# values : 4 lignes (grille)"]);
    expect(grid[1]).toBe('"# x : 9 lignes"\tb');
    // Une clé qui commencerait par # ne devient ni en-tête ni colonne.
    const keyed = [{ "# x": 1, b: 2 }, { "# x": 3, b: 4 }];
    expect(renderValue(keyed).text).toBe(JSON.stringify(keyed));
  });

  it("protège les séparateurs de ligne que JSON laisse passer (U+2028, U+2029, U+0085, tabulation verticale, saut de page)", () => {
    const rows = [{ a: "x\u2028y", b: "p\u000bq", c: "r\u2029s", d: "t\u000cu", e: "v\u0085w" }, { a: "z", b: "w", c: "k", d: "l", e: "m" }];
    const { text } = renderValue(rows);
    expect(text).not.toMatch(/[\u2028\u2029\u0085\u000b\u000c]/);
    const cells = text.split("\n")[2].split("\t");
    expect(cells).toEqual(['"x\\u2028y"', '"p\\u000bq"', '"r\\u2029s"', '"t\\fu"', '"v\\u0085w"']);
    expect(cells.map((c) => JSON.parse(c))).toEqual(Object.values(rows[0]));
    // En-tête et JSON minifié : même protection, même valeur à la relecture.
    const header = renderValue({ note: "a\u2028b", rows: [{ a: 1, b: 2 }, { a: 3, b: 4 }] }).text;
    expect(header.split("\n")[0]).toBe('note="a\\u2028b"');
    const min = renderValue({ note: "a\u2028b" }).text;
    expect(min).toBe('{"note":"a\\u2028b"}');
    expect(JSON.parse(min)).toEqual({ note: "a\u2028b" });
  });
});

describe("renderJson — pages dont les valeurs diffèrent", () => {
  it("ne remplace pas un total par celui de la dernière page : les valeurs sont données page par page", () => {
    const p1 = { files: [{ id: "a", n: "A" }, { id: "b", n: "B" }], resultSizeEstimate: 10, kind: "drive#fileList", nextPageToken: "t1" };
    const p2 = { files: [{ id: "c", n: "C" }], resultSizeEstimate: 3, kind: "drive#fileList" };
    const { text, stats } = renderJson(`${JSON.stringify(p1)}\n${JSON.stringify(p2)}`);
    expect(stats.pages).toBe(2);
    expect(text.split("\n")).toEqual([
      "[2 pages fusionnées ; valeur propre à chaque page, dans l'ordre des pages : resultSizeEstimate=10 | 3]",
      "kind=drive#fileList",
      "# files : 3 lignes",
      "id\tn",
      "a\tA",
      "b\tB",
      "c\tC",
    ]);
  });

  it("dit aussi quand un champ manque sur une page ou change de forme", () => {
    const { text } = renderJson('{"items":[{"a":1,"b":2},{"a":3,"b":4}],"meta":{"page":1}}\n{"items":[{"a":5,"b":6}],"meta":{"page":2},"warning":"partiel"}\n{"items":"aucun","meta":{"page":3}}');
    const first = text.split("\n")[0];
    expect(first).toContain('meta={"page":1} | {"page":2} | {"page":3}');
    expect(first).toContain('items=[{"a":1,"b":2},{"a":3,"b":4}] | [{"a":5,"b":6}] | aucun');
    expect(text).toContain('"warning":"partiel"');
    expect(text).not.toContain("# items");
  });
});

describe("foldOutput", () => {
  it("ne touche pas une sortie sans répétition", () => {
    const t = "== total\n   a  b\n0  1  2\n1  3  4\n2  5  6\n\nfin\n";
    expect(foldOutput(t)).toEqual({ text: t, folded: false });
  });

  it("garde le dernier état d'une barre de progression (retour chariot ou lignes)", () => {
    const cr = `Début\n${[10, 50, 100].map((p) => `\r${p}%|${"█".repeat(p / 10)}| ${p}/100`).join("")}\nFin`;
    const a = foldOutput(cr).text;
    expect(a).toContain("100%|██████████| 100/100");
    expect(a).not.toContain("50%|");
    expect(a.split("\n")[0]).toBe("[2 rafraîchissements de ligne (retour chariot) réduits à leur dernier état]");

    const lines = [1, 2, 3, 4].map((i) => ` ${i * 25}%|${"#".repeat(i * 2)}${" ".repeat(8 - i * 2)}| ${i}/4 [00:0${i}<00:01]`).join("\n");
    const b = foldOutput(`${lines}\nok`).text.split("\n");
    expect(b).toEqual([" 100%|########| 4/4 [00:04<00:01]", "…[3 états précédents de la barre de progression repliés]", "ok"]);
  });

  it("ne prend pas des filets de séparation pour une barre de progression", () => {
    const t = "━━━━━━━━ A ━━━━━━━━\n━━━━━━━━ B ━━━━━━━━\n";
    expect(foldOutput(t).text).toBe(t);
  });

  it("replie les lignes identiques consécutives à partir de trois", () => {
    const out = foldOutput(`a\na\nb\nb\nb\nb\nc`).text.split("\n");
    expect(out).toEqual(["a", "a", "b", "…[ligne identique répétée 4 fois de suite]", "c"]);
  });

  it("n'affiche qu'une fois un avertissement répété, avec le compte", () => {
    const w = "/work/.run/ab12.py:14: FutureWarning: Series.fillna with 'method' is deprecated\n  df['x'] = df['x'].fillna(method='ffill')";
    const out = foldOutput(`${w}\nligne 1\n${w}\nligne 2\n${w}\n/work/x.py:3: UserWarning: autre\n`).text.split("\n");
    expect(out).toEqual([
      ...w.split("\n"),
      "…[avertissement identique émis 3 fois, affiché une fois]",
      "ligne 1", "ligne 2",
      "/work/x.py:3: UserWarning: autre", "",
    ]);
  });

  it("écrit np.float64(x) comme x, sans toucher au reste", () => {
    const t = "P {'spend': np.float64(11560.96), 'n': np.int64(58), 'r': np.float64(-1e-05), 'z': np.float64(nan), 'ok': np.True_, 's': np.str_('a b')}\nnp.array([1, 2])";
    const out = foldOutput(t).text.split("\n");
    expect(out[0]).toContain("6 enveloppes numpy");
    expect(out[1]).toBe("P {'spend': 11560.96, 'n': 58, 'r': -1e-05, 'z': nan, 'ok': True, 's': 'a b'}");
    expect(out[2]).toBe("np.array([1, 2])");
  });
});

describe("capMiddle", () => {
  it("rend le texte tel quel sous le plafond", () => {
    expect(capMiddle("abc", 10)).toEqual({ text: "abc", cut: 0 });
  });

  it("garde début et fin, coupe sur des lignes, dit combien et comment lire le reste", () => {
    const lines = Array.from({ length: 400 }, (_, i) => `ligne ${String(i + 1).padStart(3, "0")} ${"x".repeat(20)}`);
    const src = lines.join("\n");
    const { text, cut } = capMiddle(src, 2000, { hint: "sortie complète : read_file .run/derniere-sortie.txt" });
    const out = text.split("\n");
    const mark = out.findIndex((l) => l.startsWith("…["));
    expect(out[0]).toBe(lines[0]);
    expect(out[out.length - 1]).toBe(lines[399]);
    // Aucune ligne coupée en deux de part et d'autre de la marque.
    expect(lines).toContain(out[mark - 1]);
    expect(lines).toContain(out[mark + 1]);
    expect(out[mark]).toMatch(new RegExp(`^…\\[${cut} caractères \\(\\d+ lignes\\) coupés ici, sur ${src.length} — sortie complète : read_file`));
    expect(text.length).toBeLessThan(2200);
    expect(text.length - out[mark].length - 1 + cut).toBe(src.length);
  });

  it("donne la plus grande part à la fin pour une trace d'erreur", () => {
    const src = `${"bruit\n".repeat(3000)}Traceback (most recent call last):\n  File "/work/.run/a.py", line 3\nValueError: colonne absente : spend`;
    const { text } = capMiddle(src, 1000, { headRatio: 0.3 });
    expect(text).toContain("Traceback (most recent call last):");
    expect(text.endsWith("ValueError: colonne absente : spend")).toBe(true);
  });

  it("coupe au caractère quand il n'y a pas de fin de ligne", () => {
    const { text, cut } = capMiddle("x".repeat(5000), 1000);
    expect(cut).toBe(4000);
    expect(text).toContain("…[4000 caractères coupés ici, sur 5000]…");
  });
});

describe("sliceText", () => {
  const lines = Array.from({ length: 100 }, (_, i) => `L${i + 1} ${"abcdefghi ".repeat(4)}`);
  const src = `${lines.join("\n")}\n`;

  it("rend tout, sans mention, quand le fichier tient dans le plafond", () => {
    const s = sliceText(src, { maxChars: 20_000 });
    expect(s.complete).toBe(true);
    expect(s.text).toBe(src);
    expect(s.totalLines).toBe(100);
    expect(sliceNote(s)).toBe("");
  });

  it("coupe en fin de ligne et enchaîne les plages sans trou ni recouvrement", () => {
    let got = "";
    let req: { startLine?: number; startChar?: number } = {};
    let calls = 0;
    for (;;) {
      const s = sliceText(src, { ...req, maxChars: 1000 });
      expect(s.text.endsWith("\n")).toBe(true);
      got += s.text;
      calls++;
      if (!s.next) { expect(sliceNote(s)).toMatch(/fin du fichier\]$/); break; }
      expect(sliceNote(s)).toBe(`[lignes ${s.firstLine}–${s.lastLine} sur 100, caractères ${s.from}–${s.to} sur ${src.length} — suite : start_line=${s.lastLine + 1}]`);
      req = { startLine: s.next.start_line, startChar: s.next.start_char };
    }
    expect(got).toBe(src);
    expect(calls).toBeGreaterThan(3);
  });

  it("respecte max_lines", () => {
    const s = sliceText(src, { startLine: 11, maxLines: 5, maxChars: 20_000 });
    expect(s.text).toBe(`${lines.slice(10, 15).join("\n")}\n`);
    expect([s.firstLine, s.lastLine, s.next]).toEqual([11, 15, { start_line: 16 }]);
  });

  it("passe au caractère quand une seule ligne dépasse le plafond", () => {
    const one = JSON.stringify({ data: "y".repeat(5000) });
    const a = sliceText(one, { maxChars: 2000 });
    expect(a.next).toEqual({ start_char: 2000 });
    expect(sliceNote(a)).toContain("suite : start_char=2000");
    const b = sliceText(one, { startChar: 2000, maxChars: 60_000 });
    expect(a.text + b.text).toBe(one);
    expect(b.next).toBeNull();
  });

  it("dit qu'il n'y a rien au-delà de la fin", () => {
    const s = sliceText(src, { startLine: 500, maxChars: 1000 });
    expect(s.text).toBe("");
    expect(sliceNote(s)).toBe(`[rien à lire à partir de là : le fichier fait 100 lignes, ${src.length} caractères]`);
  });
});

describe("createReadLedger", () => {
  it("reconnaît une plage déjà servie, fusionne les plages contiguës, oublie un fichier modifié", () => {
    const l = createReadLedger();
    expect(l.covers("f", "10:1", 0, 100)).toBe(false);
    l.record("f", "10:1", 0, 100);
    expect(l.covers("f", "10:1", 0, 100)).toBe(true);
    expect(l.covers("f", "10:1", 20, 60)).toBe(true);
    expect(l.covers("f", "10:1", 50, 150)).toBe(false);
    l.record("f", "10:1", 100, 200);
    expect(l.covers("f", "10:1", 50, 150)).toBe(true);
    expect(l.covers("g", "10:1", 0, 100)).toBe(false);
    // Fichier réécrit : plus rien n'est tenu pour lu.
    expect(l.covers("f", "11:2", 0, 100)).toBe(false);
    l.record("f", "11:2", 0, 10);
    expect(l.covers("f", "11:2", 0, 100)).toBe(false);
    expect(l.covers("f", "10:1", 0, 100)).toBe(false);
  });
});

describe("inventaire", () => {
  it("groupe les fichiers par dossier et annonce une liste arrêtée", () => {
    const files = [
      { path: "assets/logo.png", bytes: 22_000 }, { path: "assets/bg.jpg", bytes: 162_209 },
      { path: "data.json", bytes: 300 }, { path: "out/2026/deck.pptx", bytes: 7_170_716 },
    ];
    expect(renderFileList(files).split("\n")).toEqual([
      "/work/assets/ : logo.png (21.5 Ko), bg.jpg (158.4 Ko)",
      "/work/ : data.json (300 o)",
      "/work/out/2026/ : deck.pptx (6.8 Mo)",
    ]);
    expect(renderFileList(files, { truncatedAt: 4 })).toMatch(/…\[liste arrêtée aux 4 premiers fichiers — pour le reste, run_python avec os\.walk\('\/work'\)\]$/);
  });

  it("liste les skills sur une ligne", () => {
    expect(renderSkillList([{ name: "docx", assets: false }, { name: "slides-impulse", assets: true }]))
      .toBe("--- 2 skills HQ, lecture seule : /skills/<nom>/SKILL.md ; * = a aussi un dossier assets/ ---\ndocx, slides-impulse*");
  });
});
