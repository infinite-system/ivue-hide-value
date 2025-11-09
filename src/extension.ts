import * as vscode from "vscode";

/* =========================================================
   1) .value folding (UNCHANGED from your base)
   ========================================================= */
const DOT = "\u2219"; // middot-like (compact)
const RE_VALUE = /\.value\b/g;
const TS_LIKE_LANGS = [
  "typescript",
  "typescriptreact",
  "javascript",
  "javascriptreact",
  "vue",
];

const hiddenValueDecoration = vscode.window.createTextEditorDecorationType({
  textDecoration: "font-size:0; opacity:0;",
  rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  after: {
    contentText: DOT,
    color: new vscode.ThemeColor("editor.foreground"),
    fontSize: "0.8em",
    margin: "0 0 0 -6ch",
  },
});

const hideWholeLineDecoration = vscode.window.createTextEditorDecorationType({
  textDecoration: "font-size:0; opacity:0;",
  rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
});

const lineDotDecoration = vscode.window.createTextEditorDecorationType({
  before: {
    contentText: DOT,
    color: new vscode.ThemeColor("editor.foreground"),
    fontSize: "0.8em",
    margin: "0 .2ch 0 0",
  },
});

const dollarToComputedDecoration = vscode.window.createTextEditorDecorationType(
  {
    textDecoration: "font-size:0; opacity:0;",
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    after: {
      contentText: "computed",
      color: new vscode.ThemeColor("editor.foreground"),
      fontStyle: "italic",
      margin: "0 1ch 0 -1ch",
    },
  }
);

function langOk(editor?: vscode.TextEditor) {
  return !!editor && TS_LIKE_LANGS.includes(editor.document.languageId);
}
function positionsEqual(a: vscode.Position, b: vscode.Position) {
  return a.line === b.line && a.character === b.character;
}
function anySelectionTouches(
  range: vscode.Range,
  selections: readonly vscode.Selection[]
) {
  return selections.some(
    (sel) => range.intersection(sel) || positionsEqual(sel.active, range.end)
  );
}

async function getHoverTypeAt(
  doc: vscode.TextDocument,
  pos: vscode.Position
): Promise<string | null> {
  try {
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      "vscode.executeHoverProvider",
      doc.uri,
      pos
    );
    if (!hovers || !hovers.length) return null;
    const parts: string[] = [];
    for (const h of hovers) {
      for (const c of h.contents) {
        if (typeof c === "string") parts.push(c);
        else if ("value" in c) parts.push((c as any).value);
      }
    }
    return parts.join("\n") || null;
  } catch {
    return null;
  }
}
async function isRefLike(
  doc: vscode.TextDocument,
  receiverEnd: vscode.Position
): Promise<boolean> {
  const hover = await getHoverTypeAt(doc, receiverEnd);
  if (!hover) return false;
  return /\b(Ref|ShallowRef|ComputedRef|WritableComputedRef)\s*</.test(hover);
}

function findValueRangesInVisible(editor: vscode.TextEditor): vscode.Range[] {
  const { document, visibleRanges } = editor;
  const ranges: vscode.Range[] = [];
  for (const vis of visibleRanges) {
    for (let line = vis.start.line; line <= vis.end.line; line++) {
      const text = document.lineAt(line).text;
      let m: RegExpExecArray | null;
      RE_VALUE.lastIndex = 0;
      while ((m = RE_VALUE.exec(text))) {
        const start = new vscode.Position(line, m.index);
        const end = new vscode.Position(line, m.index + m[0].length);
        ranges.push(new vscode.Range(start, end));
      }
    }
  }
  return ranges;
}

function debounce<F extends (...args: any[]) => void>(fn: F, wait = 120) {
  let t: NodeJS.Timeout | undefined;
  return (...args: Parameters<F>) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

/* =========================================================
   1b) Computed folding (UNCHANGED from your base)
   ========================================================= */
const RE_COMPUTED_ASSIGN =
  /^\s*(?:public|protected|private)?\s*(?:override\s+)?([A-Za-z_]\w*)\s*=\s*computed\s*\(\s*this\.\$([A-Za-z_]\w*)\s*\.bind\s*\(\s*this\s*\)\s*(?:as\s+typeof\s+this\.\$\2\s*)?\)\s*;?/;
const RE_METHOD_SIG =
  /^\s*(?:public|protected|private)?\s*(?:override\s+)?(?:async\s+)?(\$[A-Za-z_]\w*)\s*\(/;

type ComputedPair = {
  assignRange: vscode.Range;
  dotAnchor: vscode.Range;
  dollarRange: vscode.Range;
};

function findComputedPairsInVisible(editor: vscode.TextEditor): ComputedPair[] {
  const pairs: ComputedPair[] = [];
  const doc = editor.document;
  const { visibleRanges } = editor;

  const methodDollarByName = new Map<string, vscode.Range>();
  for (const vis of visibleRanges) {
    for (let line = vis.start.line; line <= vis.end.line; line++) {
      const text = doc.lineAt(line).text;
      const m = RE_METHOD_SIG.exec(text);
      if (m) {
        const full = m[1]; // "$name"
        const idx = text.indexOf(full);
        const r = new vscode.Range(
          new vscode.Position(line, idx),
          new vscode.Position(line, idx + 1)
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
      const rhsMethod = a[2];
      const methodRange = methodDollarByName.get(rhsMethod);
      if (!methodRange) continue;

      const assignRange = new vscode.Range(
        new vscode.Position(line, 0),
        new vscode.Position(line, text.length)
      );
      const firstNon = text.search(/\S/);
      const col = firstNon === -1 ? 0 : firstNon;
      const dotPos = new vscode.Position(line, col);
      const dotAnchor = new vscode.Range(dotPos, dotPos);

      pairs.push({ assignRange, dotAnchor, dollarRange: methodRange });
    }
  }
  return pairs;
}

/* ---------------------------------------------------------
   Cache of hidden .value ranges for precise caret nudging
   --------------------------------------------------------- */
let lastHiddenValueRanges: vscode.Range[] = [];
let isAdjustingCaret = false;

const applyDecorations = debounce(async () => {
  const editor = vscode.window.activeTextEditor;
  if (!langOk(editor)) return;

  const { document, selections } = editor!;

  // .value folding
  const valueRanges = findValueRangesInVisible(editor!);
  const valueDecorations: vscode.DecorationOptions[] = [];
  const acceptedRanges: vscode.Range[] = [];
  for (const r of valueRanges) {
    if (anySelectionTouches(r, selections)) continue;
    const receiverEnd = r.start;
    if (r.start.character < 1) continue;
    const ok = await isRefLike(document, receiverEnd);
    if (!ok) continue;
    valueDecorations.push({
      range: r,
      hoverMessage: new vscode.MarkdownString("**Ref-like**: hidden `.value`"),
    });
    acceptedRanges.push(r);
  }
  editor!.setDecorations(hiddenValueDecoration, valueDecorations);
  // store only ranges that are actually hidden
  lastHiddenValueRanges = acceptedRanges;

  // computed folding
  const pairs = findComputedPairsInVisible(editor!);
  const hideLineDecos: vscode.DecorationOptions[] = [];
  const dotDecos: vscode.DecorationOptions[] = [];
  const dollarDecos: vscode.DecorationOptions[] = [];

  for (const p of pairs) {
    const touchesAssign = anySelectionTouches(p.assignRange, selections);
    const touchesDollar = anySelectionTouches(p.dollarRange, selections);
    if (touchesAssign || touchesDollar) continue;
    hideLineDecos.push({ range: p.assignRange });
    dotDecos.push({ range: p.dotAnchor });
    dollarDecos.push({ range: p.dollarRange });
  }
  editor!.setDecorations(hideWholeLineDecoration, hideLineDecos);
  editor!.setDecorations(lineDotDecoration, dotDecos);
  editor!.setDecorations(dollarToComputedDecoration, dollarDecos);
}, 50);

/* =========================================================
   2) Constructor region maintainer for bound methods
   ========================================================= */
const REGION_START = "// #region ivue bound methods";
const REGION_END = "// #endregion ivue bound methods";

const RE_CLASS = /class\s+([A-Za-z_]\w*)([\s\S]*?)\{/g;
const RE_EXTENDS = /\bextends\b/;

// ---------- tiny scanners (comment/string safe enough for headers) ----------
function findMatchingBrace(text: string, fromIndex: number): number {
  let depth = 0;
  for (let i = fromIndex; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function findConstructorRange(
  text: string,
  classStart: number,
  classEnd: number
): { start: number; end: number } | null {
  // Only look at depth-1 constructor headers
  let i = classStart + 1;
  while (i < classEnd) {
    // skip spaces/comments
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") {
      while (i < classEnd && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < classEnd && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }

    // read potential identifier/keyword
    const idStart = i;
    while (i < classEnd && /[A-Za-z0-9_$]/.test(text[i])) i++;
    const word = text.slice(idStart, i);

    if (word === "constructor") {
      // skip spaces, params (...)
      while (/\s/.test(text[i])) i++;
      if (text[i] !== "(") continue;
      let p = i + 1,
        bal = 1;
      while (p < classEnd && bal > 0) {
        if (text[p] === "(") bal++;
        else if (text[p] === ")") bal--;
        else if (text[p] === '"' || text[p] === "'" || text[p] === "`") {
          const q = text[p];
          p++;
          while (p < classEnd && text[p] !== q) {
            if (q === "`" && text[p] === "$" && text[p + 1] === "{") {
              // skip template ${}
              p += 2;
              let b = 1;
              while (p < classEnd && b > 0) {
                if (text[p] === "{") b++;
                else if (text[p] === "}") b--;
                p++;
              }
              continue;
            }
            if (text[p] === "\\") p++;
            p++;
          }
        }
        p++;
      }
      while (/\s/.test(text[p])) p++;
      if (text[p] === "{") {
        const open = p;
        const close = findMatchingBrace(text, open);
        if (close !== -1) return { start: open, end: close };
      }
    }

    // skip to end of this member header (find next '{' or ';')
    while (
      i < classEnd &&
      text[i] !== "{" &&
      text[i] !== ";" &&
      text[i] !== "\n"
    )
      i++;
    if (text[i] === "{") {
      const open = i;
      const close = findMatchingBrace(text, open);
      if (close === -1) return null;
      i = close + 1;
    } else i++;
  }
  return null;
}

function getIndentAt(doc: vscode.TextDocument, pos: vscode.Position): string {
  const lineText = doc.lineAt(pos.line).text;
  return lineText.match(/^\s*/)?.[0] ?? "";
}

// ---------- robust top-level method collector ----------
// ---------- robust top-level method collector (with fallback) ----------
// ---------- robust top-level method collector (depth-aware, no keyword dict) ----------
function collectOwnMethodNames(
  text: string,
  classOpen: number,
  classClose: number
): string[] {
  const names: string[] = [];
  const end = classClose;
  let i = classOpen + 1;
  let braceDepth = 1;

  const isIdentStart = (c: string) => /[A-Za-z_$]/.test(c);
  const isIdent = (c: string) => /[A-Za-z0-9_$]/.test(c);

  while (i < end) {
    const c = text[i];

    // Track braces to remain only at top-level inside class
    if (c === "{") {
      braceDepth++;
      i++;
      continue;
    }
    if (c === "}") {
      braceDepth--;
      i++;
      if (braceDepth < 1) break;
      continue;
    }

    // Only scan for methods at depth 1
    if (braceDepth !== 1) {
      i++;
      continue;
    }

    // Skip whitespace
    if (/\s/.test(c)) {
      i++;
      continue;
    }

    // Skip comments
    if (c === "/" && text[i + 1] === "/") {
      while (i < end && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < end && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }

    // Skip decorators @something
    if (c === "@") {
      while (i < end && text[i] !== "\n") i++;
      continue;
    }

    // modifiers (public private protected override async readonly static etc)
    const modifiers = new Set([
      "public",
      "private",
      "protected",
      "override",
      "async",
      "static",
      "readonly",
      "declare",
    ]);
    let start = i;
    let word = "";
    let isStatic = false;

    while (isIdentStart(text[i])) {
      let s = i;
      i++;
      while (isIdent(text[i])) i++;
      const w = text.slice(s, i);
      if (modifiers.has(w)) {
        if (w === "static") isStatic = true;
        while (/\s/.test(text[i])) i++;
        start = i;
        continue;
      }
      word = w;
      break;
    }

    if (isStatic) {
      // Skip entire static member
      // Same skip logic we used for skipping non-method class fields
      while (i < end && text[i] !== "{" && text[i] !== ";" && text[i] !== "\n")
        i++;
      if (text[i] === "{") {
        const open = i;
        const close = findMatchingBrace(text, open);
        if (close !== -1) i = close + 1;
      }
      // Move on to scan next member
      continue;
    }

    if (!word) {
      i++;
      continue;
    }

    // Skip get/set methods
    if (word === "get" || word === "set") {
      // skip the next identifier & parameter list normally
      while (i < end && text[i] !== "{" && text[i] !== "\n") i++;
      continue;
    }

    // If next token isn't "(" → not a real method
    if (text[i] !== "(") continue;

    // Confirm it's a normal method: next non-space after parameter list must be "{"
    let p = i + 1,
      depthP = 1;
    while (p < end && depthP > 0) {
      if (text[p] === "(") depthP++;
      else if (text[p] === ")") depthP--;
      p++;
    }
    while (/\s/.test(text[p])) p++;

    if (text[p] !== "{") {
      // means it's something like `name(...) =>` or weird signature → ignore
      i = p;
      continue;
    }

    // Confirm final: we found a class method: name(...)
    if (word !== "constructor" && !word.startsWith("$")) {
      names.push(word);
    }

    // Skip this method body
    let bodyDepth = 1;
    p++; // past '{'
    while (p < end && bodyDepth > 0) {
      if (text[p] === "{") bodyDepth++;
      else if (text[p] === "}") bodyDepth--;
      p++;
    }
    i = p;
  }

  return Array.from(new Set(names));
}

function buildDesiredBindLines(methodNames: string[]): string[] {
  return methodNames.map(
    (n) => `this.${n} = this.${n}.bind(this) as typeof this.${n};`
  );
}

function findFirstSuperCallOffset(
  text: string,
  ctorStart: number,
  ctorEnd: number
): number | null {
  const body = text.slice(ctorStart + 1, ctorEnd);
  const idx = body.indexOf("super(");
  if (idx < 0) return null;
  const before = body.slice(0, idx);
  const lineStart = before.lastIndexOf("\n") + 1;
  const afterLine = body.indexOf("\n", idx);
  const endInBody = afterLine >= 0 ? afterLine : body.length;
  return ctorStart + 1 + endInBody;
}

function ensureConstructorAndRegionOps(
  doc: vscode.TextDocument,
  classHeaderStart: number,
  classOpen: number,
  classClose: number,
  currentText: string,
  desiredLines: string[],
  classHeaderText: string
): Op[] {
  const ops: Op[] = [];
  const hasExtends = RE_EXTENDS.test(classHeaderText);

  // If no methods → remove region if present; do NOT add constructor
  if (desiredLines.length === 0) {
    const ctor = findConstructorRange(currentText, classOpen, classClose);
    if (!ctor) return ops;
    const ctorBody = currentText.slice(ctor.start + 1, ctor.end);
    const startIdx = ctorBody.indexOf(REGION_START);
    const endIdx = startIdx >= 0 ? ctorBody.indexOf(REGION_END, startIdx) : -1;
    if (startIdx >= 0 && endIdx >= 0) {
      const regAbsStart = ctor.start + 1 + startIdx;
      const regAbsEnd = ctor.start + 1 + endIdx + REGION_END.length;
      let delStart = regAbsStart;
      if (currentText[delStart - 1] === "\n") delStart -= 1;
      ops.push({
        kind: "delete",
        range: new vscode.Range(
          doc.positionAt(delStart),
          doc.positionAt(regAbsEnd)
        ),
      });
    }
    return ops;
  }

  // Ensure constructor exists
  let ctor = findConstructorRange(currentText, classOpen, classClose);
  if (!ctor) {
    const eol = doc.eol === vscode.EndOfLine.LF ? "\n" : "\r\n";
    const insertPos = doc.positionAt(classOpen + 1);
    const classIndent = getIndentAt(doc, insertPos);
    const innerIndent = classIndent + "  ";
    const regionIndent = innerIndent;

    const ctorHeader = hasExtends
      ? `${innerIndent}constructor(...args: any[]) {${eol}${innerIndent}  super(...args);${eol}`
      : `${innerIndent}constructor() {${eol}`;

    const regionBlock =
      `${innerIndent}  ${REGION_START}${eol}` +
      desiredLines.map((l) => `${regionIndent}${l}`).join(eol) +
      (desiredLines.length ? eol : "") +
      `${innerIndent}  ${REGION_END}${eol}`;

    const ctorClose = `${innerIndent}}${eol}`;

    const ctorText = eol + ctorHeader + regionBlock + ctorClose;
    ops.push({ kind: "insert", at: insertPos, text: ctorText });
    return ops;
  }

  // Constructor exists → ensure region at top (after super(...) if present)
  const eol = doc.eol === vscode.EndOfLine.LF ? "\n" : "\r\n";
  const ctorStart = ctor.start;
  const ctorEnd = ctor.end;

  const ctorStartPos = doc.positionAt(ctorStart);
  const ctorIndent = getIndentAt(doc, ctorStartPos);
  const innerIndent = ctorIndent + "  ";
  const regionIndent = innerIndent;

  const ctorBody = currentText.slice(ctorStart + 1, ctorEnd);
  const regionStartIdx = ctorBody.indexOf(REGION_START);
  const regionEndIdx =
    regionStartIdx >= 0 ? ctorBody.indexOf(REGION_END, regionStartIdx) : -1;

  const desiredBlockCore =
    desiredLines.map((l) => `${regionIndent}${l}`).join(eol) +
    (desiredLines.length ? eol : "");

  if (regionStartIdx === -1 || regionEndIdx === -1) {
    const afterSuperAbs = findFirstSuperCallOffset(
      currentText,
      ctorStart,
      ctorEnd
    );
    const insertAtAbs = afterSuperAbs ?? ctorStart + 1;
    const insertPos = doc.positionAt(insertAtAbs);

    const blockText =
      `${eol}${innerIndent}${REGION_START}${eol}` +
      `${desiredBlockCore}` +
      `${innerIndent}${REGION_END}${eol}`;

    ops.push({ kind: "insert", at: insertPos, text: blockText });
    return ops;
  }

  // Region exists → replace content only if changed
  const contentStart = ctorStart + 1 + regionStartIdx + REGION_START.length;
  const contentEnd = ctorStart + 1 + regionEndIdx;

  const currentContent = currentText.slice(contentStart, contentEnd);

  const normalize = (s: string) =>
    s
      .split(/\r?\n/)
      .map((line) =>
        line.replace(
          new RegExp(
            `^${regionIndent.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}`
          ),
          ""
        )
      )
      .map((s) => s.trimEnd())
      .filter((s) => s.length > 0)
      .join("\n");

  const currentNorm = normalize(currentContent);
  const desiredNorm = desiredLines.join("\n");

  if (currentNorm !== desiredNorm) {
    const replaceRange = new vscode.Range(
      doc.positionAt(contentStart),
      doc.positionAt(contentEnd)
    );
    const newText = `\n${desiredBlockCore}${innerIndent}`;
    ops.push({ kind: "replace", range: replaceRange, text: newText });
  }

  return ops;
}

type Op =
  | { kind: "insert"; at: vscode.Position; text: string }
  | { kind: "replace"; range: vscode.Range; text: string }
  | { kind: "delete"; range: vscode.Range };

function collectEditsForBindings(doc: vscode.TextDocument): Op[] {
  const full = doc.getText();
  const opsAll: Op[] = [];

  RE_CLASS.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE_CLASS.exec(full))) {
    const classHeaderStart = m.index;
    const classHeaderText = m[2] || "";
    const openBraceIdx = full.indexOf("{", classHeaderStart);
    if (openBraceIdx === -1) continue;
    const closeBraceIdx = findMatchingBrace(full, openBraceIdx);
    if (closeBraceIdx === -1) continue;

    // robust collector: top-level class methods only
    const methodNames = collectOwnMethodNames(
      full,
      openBraceIdx,
      closeBraceIdx
    );
    const desiredLines = buildDesiredBindLines(methodNames);

    const ops = ensureConstructorAndRegionOps(
      doc,
      classHeaderStart,
      openBraceIdx,
      closeBraceIdx,
      full,
      desiredLines,
      classHeaderText
    );
    opsAll.push(...ops);
  }
  return opsAll;
}

/* =========================================================
   3) Activate (undo-safe & idempotent)
   ========================================================= */
let isApplyingEdit = false;

const updateBindingsDebounced = debounce((doc: vscode.TextDocument) => {
  updateBindings(doc).catch(() => {
    /* ignore */
  });
}, 120);

async function updateBindings(doc: vscode.TextDocument) {
  if (!TS_LIKE_LANGS.includes(doc.languageId)) return;
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.toString() !== doc.uri.toString()) return;
  if (isApplyingEdit) return;

  const ops = collectEditsForBindings(doc);
  if (!ops.length) return;

  isApplyingEdit = true;
  try {
    await editor.edit(
      (editBuilder) => {
        for (const op of ops) {
          if (op.kind === "insert") editBuilder.insert(op.at, op.text);
          else if (op.kind === "replace")
            editBuilder.replace(op.range, op.text);
          else editBuilder.delete(op.range);
        }
      },
      { undoStopBefore: false, undoStopAfter: false }
    );
  } finally {
    isApplyingEdit = false;
  }
}

/* ---------------------------------------------------------
   Caret adjustment: AFTER middot only
   - If the caret is exactly one character after the start
     of a hidden `.value` range (i.e., between '.' and 'v'),
     nudge it to the end of `.value`.
   - No edits; only selection move; guarded against loops.
   --------------------------------------------------------- */
function adjustCaretAfterMiddot(editor: vscode.TextEditor) {
  if (isAdjustingCaret) return;
  if (!lastHiddenValueRanges.length) return;
  if (!editor.selections.length) return;

  const doc = editor.document;
  const newSelections: vscode.Selection[] = [];
  let changed = false;

  // Build a quick lookup set of "starts+1" positions (the spot after '.')
  // Compare by (line, character) pairs for speed.
  const startsPlusOne = new Map<number, Set<number>>();
  for (const r of lastHiddenValueRanges) {
    const line = r.start.line;
    const ch = r.start.character + 1; // position AFTER '.'
    let set = startsPlusOne.get(line);
    if (!set) {
      set = new Set();
      startsPlusOne.set(line, set);
    }
    set.add(ch);
  }

  for (const sel of editor.selections) {
    if (!sel.isEmpty) {
      newSelections.push(sel);
      continue;
    }
    const { line, character } = sel.active;
    const set = startsPlusOne.get(line);

    if (set && set.has(character)) {
      // Find the matching range to know its true end (after '.value')
      const match = lastHiddenValueRanges.find(
        (r) => r.start.line === line && r.start.character + 1 === character
      );
      if (match) {
        const dest = match.end; // end of ".value"
        newSelections.push(new vscode.Selection(dest, dest));
        changed = true;
        continue;
      }
    }
    newSelections.push(sel);
  }

  if (changed) {
    try {
      isAdjustingCaret = true;
      editor.selections = newSelections;
      // Reveal to keep UX snappy if we moved the caret far to the right
      editor.revealRange(
        new vscode.Range(newSelections[0].active, newSelections[0].active)
      );
    } finally {
      isAdjustingCaret = false;
    }
  }
}

export function activate(context: vscode.ExtensionContext) {
  // Decorations
  applyDecorations();

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => {
      applyDecorations();
      const ed = vscode.window.activeTextEditor;
      if (ed) updateBindingsDebounced(ed.document);
    }),

    vscode.workspace.onDidOpenTextDocument((doc) => {
      const ed = vscode.window.activeTextEditor;
      if (ed && doc.uri.toString() === ed.document.uri.toString()) {
        updateBindingsDebounced(doc);
      }
    }),

    vscode.workspace.onDidChangeTextDocument((e) => {
      if (
        e.reason === vscode.TextDocumentChangeReason.Undo ||
        e.reason === vscode.TextDocumentChangeReason.Redo
      ) {
        return;
      }
      const ed = vscode.window.activeTextEditor;
      if (ed && e.document.uri.toString() === ed.document.uri.toString()) {
        applyDecorations();
        updateBindingsDebounced(e.document);
      }
    }),

    vscode.window.onDidChangeTextEditorVisibleRanges(() => applyDecorations()),

    vscode.window.onDidChangeTextEditorSelection(() => {
      // Keep decorations current, then nudge caret if it's AFTER middot.
      applyDecorations();
      const ed = vscode.window.activeTextEditor;
      if (ed) adjustCaretAfterMiddot(ed);
    }),

    vscode.workspace.onDidChangeConfiguration(() => applyDecorations())
  );

  const ed = vscode.window.activeTextEditor;
  if (ed) updateBindingsDebounced(ed.document);
}

export function deactivate() {
  // VS Code disposes decorations automatically
}
