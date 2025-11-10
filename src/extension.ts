import * as vscode from "vscode";

/*===========================================================
  Shared
===========================================================*/
const DOT = "\u2219"; // middot marker for folded .value
const RE_VALUE = /\.value\b/g;
const TS_LIKE_LANGS = [
  "typescript",
  "typescriptreact",
  "javascript",
  "javascriptreact",
  "vue",
];

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
function anySelectionOnLine(
  line: number,
  selections: readonly vscode.Selection[]
) {
  return selections.some((sel) => sel.active.line === line);
}

/*===========================================================
  Decorations
===========================================================*/
const hiddenValueDecoration = vscode.window.createTextEditorDecorationType({
  textDecoration: "font-size:0; opacity:0;",
  rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  after: {
    contentText: DOT,
    color: 'orange', //new vscode.ThemeColor("editor.foreground"),
    fontWeight: "bold",
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
    margin: "0 .2ch 0 0",
  },
});

/** Single, per-instance configurable label for "computed" (and optional visibility prefix). */
const computedLabelDecoration = vscode.window.createTextEditorDecorationType({
  textDecoration: "font-size:0; opacity:0;", // hide the '$' anchor itself
  rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  after: {
    // contentText & margin are provided per instance via renderOptions
    color: new vscode.ThemeColor("editor.foreground"),
    fontStyle: "italic",
  },
});

/** Hide visibility/modifier tokens on the method line */
const hideVisibilityDecoration = vscode.window.createTextEditorDecorationType({
  textDecoration: "font-size:0; opacity:0;",
  rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
});

/*===========================================================
  Helpers
===========================================================*/
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
    if (!hovers) return null;
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
) {
  const hover = await getHoverTypeAt(doc, receiverEnd);
  return !!hover?.match(
    /\b(Ref|ShallowRef|ComputedRef|WritableComputedRef)\s*</
  );
}

/** NEW: scan the entire document for `.value` usages */
function findValueRangesInDoc(doc: vscode.TextDocument) {
  const ranges: vscode.Range[] = [];
  for (let line = 0; line < doc.lineCount; line++) {
    const text = doc.lineAt(line).text;
    let m: RegExpExecArray | null;
    RE_VALUE.lastIndex = 0;
    while ((m = RE_VALUE.exec(text))) {
      const start = new vscode.Position(line, m.index);
      const end = new vscode.Position(line, m.index + m[0].length);
      ranges.push(new vscode.Range(start, end));
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

/*===========================================================
  Computed folding
===========================================================*/
// $method signature (any modifier mix) — allow extra $ in name
const RE_METHOD_SIG =
  /^\s*(?:public|protected|private)?\s*(?:override\s+)?(?:async\s+)?(\$[A-Za-z_$][\w$]*)\s*\(/;

// Lightweight starter to detect a computed assignment on the line
const RE_ASSIGN_LINE_START =
  /^\s*(public|protected|private)?\s*[A-Za-z_]\w*\s*=\s*computed\b/;

// Extract method name like this.$foo(...) from a blob of text — allow $ in name
const RE_THIS_DOLLAR_NAME = /this\.\$([A-Za-z_$][\w$]*)\b/;

type ComputedPair = {
  assignRange: vscode.Range;             // FULL range (can be multiline)
  assignFirstLine: number;               // first line number
  dotAnchor: vscode.Range;               // where to put the dot (indent start of first line)
  dollarRange?: vscode.Range;            // position of '$' in method signature
  methodVisHideRange?: vscode.Range;     // range to hide existing visibility on method line
  propVis?: "public" | "private" | "protected"; // visibility from assignment
};

/** UPDATED: hide *all* modifiers (visibility/override/async) before the $ on the method line */
function visibilityTokenRangeOnLine(
  doc: vscode.TextDocument,
  line: number
): vscode.Range | undefined {
  const text = doc.lineAt(line).text;

  // Find beginning of the code and the '$' anchor for the method
  const indent = (text.match(/^(\s*)/)?.[1].length ?? 0);
  const dollarIdx = text.indexOf("$");
  if (dollarIdx === -1 || dollarIdx <= indent) return undefined;

  // Slice only the prefix before '$' and look for modifiers there
  const prefix = text.slice(indent, dollarIdx);

  // Match optional visibility + any number of 'override ' / 'async ' blocks
  const m = prefix.match(/^(?:(public|protected|private)\s+)?(?:(?:override|async)\s+)*/);
  if (!m) return undefined;

  const len = m[0].length;
  if (len === 0) return undefined;

  const start = new vscode.Position(line, indent);
  const end = new vscode.Position(line, indent + len);
  return new vscode.Range(start, end);
}

/** UPDATED: exact length of hidden modifiers (visibility + override/async) for label shift */
function tokenLengthOnLine(
  doc: vscode.TextDocument,
  line: number
): number {
  const text = doc.lineAt(line).text;
  const indent = (text.match(/^(\s*)/)?.[1].length ?? 0);
  const dollarIdx = text.indexOf("$");
  if (dollarIdx === -1 || dollarIdx <= indent) return 0;

  const prefix = text.slice(indent, dollarIdx);
  const m = prefix.match(/^(?:(public|protected|private)\s+)?(?:(?:override|async)\s+)*/);
  return m ? m[0].length : 0;
}

/** NEW: do we have 'override' among the hidden modifiers on the method line? */
function hasOverrideOnLine(doc: vscode.TextDocument, line: number): boolean {
  const text = doc.lineAt(line).text;
  const indent = (text.match(/^(\s*)/)?.[1].length ?? 0);
  const dollarIdx = text.indexOf("$");
  if (dollarIdx === -1 || dollarIdx <= indent) return false;
  const prefix = text.slice(indent, dollarIdx);
  return /\boverride\b/.test(prefix);
}

function findNearestMethodDollar(
  doc: vscode.TextDocument,
  fromLine: number,
  name: string,
  scanLimit = 300
): vscode.Range | undefined {
  // Down
  for (
    let line = fromLine + 1,
      end = Math.min(doc.lineCount - 1, fromLine + scanLimit);
    line <= end;
    line++
  ) {
    const t = doc.lineAt(line).text;
    const m = RE_METHOD_SIG.exec(t);
    if (m && m[1] === `$${name}`) {
      const idx = t.indexOf(m[1]);
      return new vscode.Range(
        new vscode.Position(line, idx),
        new vscode.Position(line, idx + 1)
      );
    }
  }
  // Up
  for (
    let line = fromLine - 1, end = Math.max(0, fromLine - scanLimit);
    line >= end;
  line--
  ) {
    const t = doc.lineAt(line).text;
    const m = RE_METHOD_SIG.exec(t);
    if (m && m[1] === `$${name}`) {
      const idx = t.indexOf(m[1]);
      return new vscode.Range(
        new vscode.Position(line, idx),
        new vscode.Position(line, idx + 1)
      );
    }
  }
  return undefined;
}

/** NEW: scan the entire document for computed(...) blocks (multiline-safe) */
function findComputedPairsInDoc(doc: vscode.TextDocument): ComputedPair[] {
  const pairs: ComputedPair[] = [];

  for (let line = 0; line < doc.lineCount; line++) {
    const firstLineText = doc.lineAt(line).text;
    const m = RE_ASSIGN_LINE_START.exec(firstLineText);
    if (!m) continue;

    // visibility from assignment line (exact token or undefined)
    const propVis = (m[1] as "public" | "private" | "protected" | undefined) ?? undefined;

    // capture whole computed(...) block by balancing parentheses
    let startLine = line;
    let endLine = line;
    let depth = 0;
    let seenComputedParen = false;

    // Start scanning from first line at the index of 'computed'
    const startIdx = firstLineText.indexOf("computed");
    let textBlob = firstLineText.slice(startIdx);

    // count parens on the first slice
    for (const ch of textBlob) {
      if (ch === "(") { depth++; seenComputedParen = true; }
      else if (ch === ")") depth--;
    }

    while (depth > 0 && endLine + 1 < doc.lineCount) {
      endLine++;
      const t = doc.lineAt(endLine).text;
      textBlob += "\n" + t;
      for (const ch of t) {
        if (ch === "(") depth++;
        else if (ch === ")") depth--;
      }
    }
    if (!seenComputedParen) continue; // safety

    // Build full range across lines
    const startPos = new vscode.Position(startLine, 0);
    const endPos = new vscode.Position(endLine, doc.lineAt(endLine).text.length);
    const assignRange = new vscode.Range(startPos, endPos);

    // extract rhs method name this.$name from the blob
    const nameMatch = RE_THIS_DOLLAR_NAME.exec(textBlob);
    const rhsName = nameMatch?.[1];

    // Where to place the dot (indent of first non-space on first line)
    const firstNonSpace = firstLineText.search(/\S/);
    const dotAnchorPos = new vscode.Position(
      startLine,
      firstNonSpace === -1 ? 0 : firstNonSpace
    );

    // locate the $ on the method signature to attach label
    let dollarRange: vscode.Range | undefined = undefined;
    let methodVisHideRange: vscode.Range | undefined = undefined;
    if (rhsName) {
      const found = findNearestMethodDollar(doc, endLine, rhsName);
      if (found) {
        dollarRange = found;
        methodVisHideRange = visibilityTokenRangeOnLine(doc, found.start.line);
      }
    }

    pairs.push({
      assignRange,
      assignFirstLine: startLine,
      dotAnchor: new vscode.Range(dotAnchorPos, dotAnchorPos),
      dollarRange,
      methodVisHideRange,
      propVis,
    });

    // Skip ahead: we've already consumed until endLine
    line = endLine;
  }

  return pairs;
}

/*===========================================================
  Last hidden value ranges for caret nudge
===========================================================*/
let lastHiddenValueRanges: vscode.Range[] = [];
let isAdjustingCaret = false;

/*===========================================================
  Main decoration compute & apply
===========================================================*/
const applyDecorations = debounce(async () => {
  const editor = vscode.window.activeTextEditor;
  if (!langOk(editor)) return;
  const { document, selections } = editor!;

  // .value folds — now across the whole document
  const valueRanges = findValueRangesInDoc(document);
  const decos: vscode.DecorationOptions[] = [];
  const accepted: vscode.Range[] = [];

  for (const r of valueRanges) {
    if (anySelectionTouches(r, selections)) continue;
    if (r.start.character < 1) continue;
    const ok = await isRefLike(document, r.start);
    if (!ok) continue;
    decos.push({ range: r });
    accepted.push(r);
  }
  editor!.setDecorations(hiddenValueDecoration, decos);
  lastHiddenValueRanges = accepted;

  // computed folds — now across the whole document
  const pairs = findComputedPairsInDoc(document);
  const hideLines: vscode.DecorationOptions[] = [];
  const dots: vscode.DecorationOptions[] = [];
  const hideVis: vscode.DecorationOptions[] = [];
  const computedLabels: vscode.DecorationOptions[] = [];

  const usedDollarSpots = new Set<string>();

  for (const p of pairs) {
    const methodLine = p.dollarRange?.start.line;

    // expand if caret is anywhere inside the assignment block OR on the method line
    const onAssignBlock = anySelectionTouches(p.assignRange, selections);
    const onMethodLine =
      methodLine !== undefined && anySelectionOnLine(methodLine, selections);

    const expandPair = onAssignBlock || onMethodLine;

    if (!expandPair) {
      hideLines.push({ range: p.assignRange });       // hides ALL lines in the computed block
      dots.push({ range: p.dotAnchor });              // one middot at the first line
    }

    if (p.dollarRange && !expandPair) {
      const key = `${p.dollarRange.start.line}:${p.dollarRange.start.character}`;
      if (!usedDollarSpots.has(key)) {
        usedDollarSpots.add(key);

        if (p.methodVisHideRange) {
          hideVis.push({ range: p.methodVisHideRange });
        }

        // Label: visibility (from assignment) + override (from method) + 'computed'
        const parts: string[] = [];
        if (p.propVis) parts.push(p.propVis);
        if (methodLine !== undefined && hasOverrideOnLine(document, methodLine)) {
          parts.push("override");
        }
        parts.push("computed");
        const label = parts.join(" ");

        // Shift left by 1ch for hidden '$' + hidden modifier width (visibility/override/async)
        const visLen = p.methodVisHideRange
          ? tokenLengthOnLine(document, p.methodVisHideRange.start.line)
          : 0;
        const shiftCh = 1 + visLen; // "$" + hidden modifiers width
        const margin = `0 1ch 0 -${shiftCh}ch`;

        computedLabels.push({
          range: p.dollarRange,
          renderOptions: {
            after: {
              contentText: label,
              margin,
            },
          },
        });
      }
    }
  }

  editor!.setDecorations(hideWholeLineDecoration, hideLines);
  editor!.setDecorations(lineDotDecoration, dots);
  editor!.setDecorations(computedLabelDecoration, computedLabels);
  editor!.setDecorations(hideVisibilityDecoration, hideVis);
}, 50);

/*===========================================================
  Caret nudge after middot
===========================================================*/
function adjustCaretAfterMiddot(editor: vscode.TextEditor) {
  if (isAdjustingCaret) return;
  if (!lastHiddenValueRanges.length) return;

  const newSelections: vscode.Selection[] = [];
  let changed = false;

  const lookup = new Map<number, Set<number>>();
  for (const r of lastHiddenValueRanges) {
    const set = lookup.get(r.start.line) ?? new Set();
    set.add(r.start.character + 1);
    lookup.set(r.start.line, set);
  }

  for (const sel of editor.selections) {
    if (!sel.isEmpty) {
      newSelections.push(sel);
      continue;
    }

    const line = sel.active.line;
    const ch = sel.active.character;
    const set = lookup.get(line);

    if (set && set.has(ch)) {
      const match = lastHiddenValueRanges.find(
        (r) => r.start.line === line && r.start.character + 1 === ch
      );
      if (match) {
        const dest = match.end;
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
      editor.revealRange(
        new vscode.Range(newSelections[0].active, newSelections[0].active)
      );
    } finally {
      isAdjustingCaret = false;
    }
  }
}

/*===========================================================
  Activate / Deactivate
===========================================================*/
export function activate(context: vscode.ExtensionContext) {
  applyDecorations();

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => applyDecorations()),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (
        e.reason === vscode.TextDocumentChangeReason.Undo ||
        e.reason === vscode.TextDocumentChangeReason.Redo
      )
        return;
      const ed = vscode.window.activeTextEditor;
      if (ed && e.document.uri.toString() === ed.document.uri.toString()) {
        applyDecorations();
      }
    }),
    vscode.window.onDidChangeTextEditorVisibleRanges(() => applyDecorations()),
    vscode.window.onDidChangeTextEditorSelection(() => {
      applyDecorations();
      const ed = vscode.window.activeTextEditor;
      if (ed) adjustCaretAfterMiddot(ed);
    }),
    vscode.workspace.onDidChangeConfiguration(() => applyDecorations())
  );
}

export function deactivate() {}
