"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/extension.ts
var extension_exports = {};
__export(extension_exports, {
  activate: () => activate,
  deactivate: () => deactivate
});
module.exports = __toCommonJS(extension_exports);
var vscode = __toESM(require("vscode"));
var DOT = "\u2219";
var RE_VALUE = /\.value\b/g;
var TS_LIKE_LANGS = ["typescript", "typescriptreact", "javascript", "javascriptreact", "vue"];
var hiddenValueDecoration = vscode.window.createTextEditorDecorationType({
  textDecoration: "font-size:0; opacity:0;",
  rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  after: {
    contentText: DOT,
    color: new vscode.ThemeColor("editor.foreground"),
    fontSize: "0.8em",
    margin: "0 0 0 -6ch"
    // pull the dot left into the hidden width
  }
});
var hideWholeLineDecoration = vscode.window.createTextEditorDecorationType({
  textDecoration: "font-size:0; opacity:0;",
  rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
});
var lineDotDecoration = vscode.window.createTextEditorDecorationType({
  before: {
    contentText: DOT,
    color: new vscode.ThemeColor("editor.foreground"),
    fontSize: "0.8em",
    margin: "0 .2ch 0 0"
  }
});
var dollarToComputedDecoration = vscode.window.createTextEditorDecorationType({
  textDecoration: "font-size:0; opacity:0;",
  // hide the "$"
  rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  after: {
    // show "computed " right where the $ was; no trailing space requested
    contentText: "computed",
    color: new vscode.ThemeColor("editor.foreground"),
    fontStyle: "italic",
    margin: "0 1ch 0 -1ch"
  }
});
function langOk(editor) {
  return !!editor && TS_LIKE_LANGS.includes(editor.document.languageId);
}
function positionsEqual(a, b) {
  return a.line === b.line && a.character === b.character;
}
function anySelectionTouches(range, selections) {
  return selections.some((sel) => range.intersection(sel) || positionsEqual(sel.active, range.end));
}
async function getHoverTypeAt(doc, pos) {
  try {
    const hovers = await vscode.commands.executeCommand(
      "vscode.executeHoverProvider",
      doc.uri,
      pos
    );
    if (!hovers || !hovers.length) return null;
    const parts = [];
    for (const h of hovers) {
      for (const c of h.contents) {
        if (typeof c === "string") parts.push(c);
        else if ("value" in c) parts.push(c.value);
      }
    }
    const text = parts.join("\n");
    return text || null;
  } catch {
    return null;
  }
}
async function isRefLike(doc, receiverEnd) {
  const hover = await getHoverTypeAt(doc, receiverEnd);
  if (!hover) return false;
  return /\b(Ref|ShallowRef|ComputedRef|WritableComputedRef)\s*</.test(hover);
}
function findValueRangesInVisible(editor) {
  const { document, visibleRanges } = editor;
  const ranges = [];
  for (const vis of visibleRanges) {
    for (let line = vis.start.line; line <= vis.end.line; line++) {
      const text = document.lineAt(line).text;
      let m;
      RE_VALUE.lastIndex = 0;
      while (m = RE_VALUE.exec(text)) {
        const start = new vscode.Position(line, m.index);
        const end = new vscode.Position(line, m.index + m[0].length);
        ranges.push(new vscode.Range(start, end));
      }
    }
  }
  return ranges;
}
function debounce(fn, wait = 120) {
  let t;
  return (...args) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}
var RE_COMPUTED_ASSIGN = /^\s*(?:public|protected|private)?\s*(?:override\s+)?([A-Za-z_]\w*)\s*=\s*computed\s*\(\s*this\.\$([A-Za-z_]\w*)\s*\.bind\s*\(\s*this\s*\)\s*\)\s*;?/;
var RE_METHOD_SIG = /^\s*(?:public|protected|private)?\s*(?:override\s+)?(?:async\s+)?(\$[A-Za-z_]\w*)\s*\(/;
function findComputedPairsInVisible(editor) {
  const pairs = [];
  const doc = editor.document;
  const { visibleRanges } = editor;
  const methodDollarByName = /* @__PURE__ */ new Map();
  for (const vis of visibleRanges) {
    for (let line = vis.start.line; line <= vis.end.line; line++) {
      const text = doc.lineAt(line).text;
      const m = RE_METHOD_SIG.exec(text);
      if (m) {
        const full = m[1];
        const idx = text.indexOf(full);
        const dollarCol = idx;
        const r = new vscode.Range(
          new vscode.Position(line, dollarCol),
          new vscode.Position(line, dollarCol + 1)
          // only the '$'
        );
        methodDollarByName.set(full.slice(1), r);
      }
    }
  }
  for (const vis of visibleRanges) {
    for (let line = vis.start.line; line <= vis.end.line; line++) {
      const text = doc.lineAt(line).text;
      const a = RE_COMPUTED_ASSIGN.exec(text);
      if (!a) continue;
      const lhsName = a[1];
      const rhsMethod = a[2];
      if (lhsName !== rhsMethod) {
      }
      const methodRange = methodDollarByName.get(rhsMethod);
      if (!methodRange) continue;
      const assignStart = new vscode.Position(line, 0);
      const assignEnd = new vscode.Position(line, text.length);
      const assignRange = new vscode.Range(assignStart, assignEnd);
      const firstNon = text.search(/\S/);
      const col = firstNon === -1 ? 0 : firstNon;
      const dotPos = new vscode.Position(line, col);
      const dotAnchor = new vscode.Range(dotPos, dotPos);
      pairs.push({
        assignRange,
        dotAnchor,
        dollarRange: methodRange
      });
    }
  }
  return pairs;
}
var applyDecorations = debounce(async () => {
  const editor = vscode.window.activeTextEditor;
  if (!langOk(editor)) return;
  const { document, selections } = editor;
  const valueRanges = findValueRangesInVisible(editor);
  const valueDecorations = [];
  for (const r of valueRanges) {
    if (anySelectionTouches(r, selections)) {
      continue;
    }
    const receiverEnd = r.start;
    if (r.start.character < 1) continue;
    const ok = await isRefLike(document, receiverEnd);
    if (!ok) continue;
    valueDecorations.push({ range: r, hoverMessage: new vscode.MarkdownString("**Ref-like**: hidden `.value`") });
  }
  editor.setDecorations(hiddenValueDecoration, valueDecorations);
  const pairs = findComputedPairsInVisible(editor);
  const hideLineDecos = [];
  const dotDecos = [];
  const dollarDecos = [];
  for (const p of pairs) {
    const touchesAssign = anySelectionTouches(p.assignRange, selections);
    const touchesDollar = anySelectionTouches(p.dollarRange, selections);
    if (touchesAssign || touchesDollar) {
      continue;
    }
    hideLineDecos.push({ range: p.assignRange });
    dotDecos.push({ range: p.dotAnchor });
    dollarDecos.push({ range: p.dollarRange });
  }
  editor.setDecorations(hideWholeLineDecoration, hideLineDecos);
  editor.setDecorations(lineDotDecoration, dotDecos);
  editor.setDecorations(dollarToComputedDecoration, dollarDecos);
}, 50);
function activate(context) {
  applyDecorations();
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => applyDecorations()),
    vscode.workspace.onDidChangeTextDocument((e) => {
      const ed = vscode.window.activeTextEditor;
      if (ed && e.document.uri.toString() === ed.document.uri.toString()) applyDecorations();
    }),
    vscode.window.onDidChangeTextEditorSelection(() => applyDecorations()),
    vscode.window.onDidChangeTextEditorVisibleRanges(() => applyDecorations()),
    vscode.workspace.onDidChangeConfiguration(() => applyDecorations())
  );
}
function deactivate() {
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  activate,
  deactivate
});
