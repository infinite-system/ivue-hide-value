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

/** Single, per-instance configurable label for "computed" (and optional visibility/override). */
const computedLabelDecoration = vscode.window.createTextEditorDecorationType({
  textDecoration: "font-size:0; opacity:0;", // hide the '$' anchor itself
  rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  after: {
    // contentText & margin are provided per instance via renderOptions
    color: new vscode.ThemeColor("editor.foreground"),
    fontWeight: "600",
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

/**
 * STRICT receiver check:
 * Given the position at the start of ".value", inspect the hover of the *receiver*
 * (the character immediately before the dot) and only return true when the receiver’s
 * declared type itself is one of the Ref-like types.
 */
async function isRefLike(
  doc: vscode.TextDocument,
  dotStart: vscode.Position // start of ".value"
) {
  const col = dotStart.character;
  const posForReceiver =
    col > 0 ? new vscode.Position(dotStart.line, col - 1) : dotStart;

  const hover = await getHoverTypeAt(doc, posForReceiver);
  if (!hover) return false;

  // We need the *top-level* type of the receiver, not a nested Ref somewhere inside.
  const REF = "(Ref|ShallowRef|ComputedRef|WritableComputedRef|ModelRef|DemiRef)";
  const colonTypeLine = /:\s*([^\n]+)/;

  const m = hover.match(colonTypeLine);
  if (!m) return false;

  const typeAfterColon = m[1].trim();
  const topLevelRef = new RegExp(`^${REF}(\\b|<)`);
  return topLevelRef.test(typeAfterColon);
}

/** Scan the entire document for `.value` usages */
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

// Lightweight starter to detect a computed assignment on the line:
// Accept any mix/order of public/protected/private/override before the prop name.
const RE_ASSIGN_LINE_START =
  /^\s*(?:(?:public|protected|private|override)\s+)*[A-Za-z_]\w*\s*=\s*computed\b/;

// Extract method name like this.$foo(...) from a blob of text — allow $ in name
const RE_THIS_DOLLAR_NAME = /this\.\$([A-Za-z_$][\w$]*)\b/;

// Extract the assigned property name on the same line (modifiers allowed, any order)
const RE_PROP_NAME_ON_ASSIGN =
  /^\s*(?:(?:public|protected|private|override)\s+)*([A-Za-z_]\w*)\s*=\s*computed\b/;

// Class header (best-effort); brace may be on same or following line.
const RE_CLASS_HEADER =
  /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+[A-Za-z_$][\w$]*/;

type ModVis = "public" | "private" | "protected";
type ComputedPair = {
  assignRange: vscode.Range;             // FULL range (can be multiline)
  assignFirstLine: number;               // first line number
  dotAnchor: vscode.Range;               // where to put the dot (indent start of first line)
  // The *next* method after assignment (strictly the next signature encountered) within same class
  nextMethodDollarRange?: vscode.Range;
  nextMethodName?: string;               // e.g. "$area"
  methodVisHideRange?: vscode.Range;     // range to hide existing visibility on that method line
  propVis?: ModVis;                      // visibility from assignment
  assignHasOverride?: boolean;           // override from assignment line
  propName?: string;                     // LHS property name being assigned
  rhsName?: string;                      // RHS method name called via this.$<name>()
};

/** Hide *all* modifiers (visibility/override/async) before the $ on the method line */
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

/** Exact length of hidden modifiers (visibility + override/async) for label shift */
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

/** Do we have 'override' among the hidden modifiers on the method line? */
function hasOverrideOnLine(doc: vscode.TextDocument, line: number): boolean {
  const text = doc.lineAt(line).text;
  const indent = (text.match(/^(\s*)/)?.[1].length ?? 0);
  const dollarIdx = text.indexOf("$");
  if (dollarIdx === -1 || dollarIdx <= indent) return false;
  const prefix = text.slice(indent, dollarIdx);
  return /\boverride\b/.test(prefix);
}

/*===========================================================
  Class scoping helpers (best-effort, brace-balanced)
===========================================================*/
/** Find the enclosing class header line (if any) for a given line. */
function findEnclosingClassHeaderLine(doc: vscode.TextDocument, fromLine: number): number | undefined {
  for (let l = fromLine; l >= 0; l--) {
    const t = doc.lineAt(l).text;
    if (RE_CLASS_HEADER.test(t)) return l;
  }
  return undefined;
}

/** Starting at a known class header line, find the class body open brace line and the matching close brace line. */
function findClassRangeFromHeader(doc: vscode.TextDocument, headerLine: number): { openLine: number; closeLine: number } | undefined {
  // Find the first '{' at/after headerLine
  let openLine = -1;
  let depth = 0;

  // Locate opening brace
  for (let l = headerLine; l < doc.lineCount; l++) {
    const text = doc.lineAt(l).text;
    const idx = text.indexOf("{");
    if (idx !== -1) {
      openLine = l;
      depth = 1;
      // Count remaining braces on the same line after first '{'
      for (let i = idx + 1; i < text.length; i++) {
        if (text[i] === "{") depth++;
        else if (text[i] === "}") depth--;
      }
      break;
    }
  }
  if (openLine < 0) return undefined;

  // Walk forward to find matching close
  for (let l = openLine + 1; l < doc.lineCount; l++) {
    const text = doc.lineAt(l).text;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      if (depth === 0) {
        return { openLine, closeLine: l };
      }
    }
  }
  return undefined;
}

/** For an arbitrary line, find the enclosing class body [openLine, closeLine]. */
function findEnclosingClassBounds(doc: vscode.TextDocument, line: number): { openLine: number; closeLine: number } | undefined {
  const header = findEnclosingClassHeaderLine(doc, line);
  if (header === undefined) return undefined;
  const range = findClassRangeFromHeader(doc, header);
  if (!range) return undefined;
  // Ensure the line lies within the class body (between open and close)
  if (line < range.openLine || line > range.closeLine) return undefined;
  return range;
}

/** Find the next method *within* a class body (bounded search). */
function findNextMethodAfterWithin(
  doc: vscode.TextDocument,
  fromLine: number,
  classCloseLine: number
): { range: vscode.Range; name: string } | undefined {
  for (let line = fromLine + 1; line <= classCloseLine; line++) {
    const t = doc.lineAt(line).text;
    const m = RE_METHOD_SIG.exec(t);
    if (m) {
      const token = m[1]; // "$name"
      const idx = t.indexOf(token);
      return {
        range: new vscode.Range(
          new vscode.Position(line, idx),
          new vscode.Position(line, idx + 1) // just the "$"
        ),
        name: token,
      };
    }
  }
  return undefined;
}

/*===========================================================
  Modifiers parsing
===========================================================*/
/** Parse modifiers on the computed assignment line, in ANY order. */
function extractAssignModifiers(lineText: string): {
  propName?: string;
  visibility?: ModVis;
  hasOverride: boolean;
} {
  const nameMatch = RE_PROP_NAME_ON_ASSIGN.exec(lineText);
  const propName = nameMatch?.[1];

  // Take the substring before the prop name to analyze modifiers safely
  let prefix = "";
  if (propName) {
    const idx = lineText.indexOf(propName);
    prefix = idx >= 0 ? lineText.slice(0, idx) : "";
  } else {
    // fallback: take start up to '='
    const eqIdx = lineText.indexOf("=");
    prefix = eqIdx >= 0 ? lineText.slice(0, eqIdx) : lineText;
  }

  const hasOverride = /\boverride\b/.test(prefix);
  // pick first visibility token present (any order)
  let visibility: ModVis | undefined = undefined;
  if (/\bpublic\b/.test(prefix)) visibility = "public";
  else if (/\bprotected\b/.test(prefix)) visibility = "protected";
  else if (/\bprivate\b/.test(prefix)) visibility = "private";

  return { propName, visibility, hasOverride };
}

/** Scan the entire document for computed(...) blocks (multiline-safe), scoped to class bodies */
function findComputedPairsInDoc(doc: vscode.TextDocument): ComputedPair[] {
  const pairs: ComputedPair[] = [];

  for (let line = 0; line < doc.lineCount; line++) {
    const firstLineText = doc.lineAt(line).text;
    const starter = RE_ASSIGN_LINE_START.exec(firstLineText);
    if (!starter) continue;

    // Ensure this assignment is inside a class
    const classBounds = findEnclosingClassBounds(doc, line);
    if (!classBounds) continue;

    // Extract modifiers & name from assignment line (supports any order)
    const { propName, visibility, hasOverride } = extractAssignModifiers(firstLineText);

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
    const rhsName = nameMatch?.[1]; // without '$'

    // Where to place the dot (indent of first non-space on first line)
    const firstNonSpace = firstLineText.search(/\S/);
    const dotAnchorPos = new vscode.Position(
      startLine,
      firstNonSpace === -1 ? 0 : firstNonSpace
    );

    // Find the *next* method after the computed assignment — but only within this class
    const next = findNextMethodAfterWithin(doc, endLine, classBounds.closeLine);
    const nextMethodDollarRange = next?.range;
    const nextMethodName = next?.name; // includes '$'

    // If we found a next method, compute its visibility-hide range
    const methodVisHideRange =
      nextMethodDollarRange
        ? visibilityTokenRangeOnLine(doc, nextMethodDollarRange.start.line)
        : undefined;

    pairs.push({
      assignRange,
      assignFirstLine: startLine,
      dotAnchor: new vscode.Range(dotAnchorPos, dotAnchorPos),
      nextMethodDollarRange,
      nextMethodName,
      methodVisHideRange,
      propVis: visibility,
      assignHasOverride: hasOverride,
      propName,
      rhsName,
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

    // STRICT: fold only when the RECEIVER of this ".value" is a Ref-like
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
    // expand if caret is anywhere inside the assignment block OR on the next method line
    const onAssignBlock = anySelectionTouches(p.assignRange, selections);
    const onMethodLine =
      p.nextMethodDollarRange?.start.line !== undefined &&
      anySelectionOnLine(p.nextMethodDollarRange.start.line, selections);

    const expandPair = onAssignBlock || onMethodLine;

    // The pair only “matches” when:
    // 1) propName exists and equals rhsName (from this.$rhs),
    // 2) the *next* method exists and its name is `$<propName>`.
    const equalPropAndRhs = !!p.propName && !!p.rhsName && p.propName === p.rhsName;
    const nextMatchesProp =
      !!p.nextMethodName && !!p.propName && p.nextMethodName === `$${p.propName}`;
    const matchedPair = equalPropAndRhs && nextMatchesProp;

    if (!expandPair && matchedPair) {
      // Hide the computed block and show a dot at its start
      hideLines.push({ range: p.assignRange });
      dots.push({ range: p.dotAnchor });
    }

    // Decorate the next method line as "computed" only when matched
    if (p.nextMethodDollarRange && !expandPair && matchedPair) {
      const key = `${p.nextMethodDollarRange.start.line}:${p.nextMethodDollarRange.start.character}`;
      if (!usedDollarSpots.has(key)) {
        usedDollarSpots.add(key);

        if (p.methodVisHideRange) {
          hideVis.push({ range: p.methodVisHideRange });
        }

        // Label: visibility (from assignment) + (override from assignment OR method) + 'computed'
        const parts: string[] = [];
        if (p.propVis) parts.push(p.propVis);

        const methodLine = p.nextMethodDollarRange.start.line;
        const methodHasOverride = hasOverrideOnLine(document, methodLine);
        const showOverride = !!p.assignHasOverride || methodHasOverride;
        if (showOverride) parts.push("override");

        parts.push("computed");
        const label = parts.join(" ");

        // Shift left by 1ch for hidden '$' + hidden modifier width (visibility/override/async)
        const visLen = p.methodVisHideRange
          ? tokenLengthOnLine(document, p.methodVisHideRange.start.line)
          : 0;
        const shiftCh = 1 + visLen; // "$" + hidden modifiers width
        const margin = `0 1ch 0 -${shiftCh}ch`;

        computedLabels.push({
          range: p.nextMethodDollarRange,
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
  Caret nudge after middot (with delayed activation for keyboard nav)
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

      // Only reveal if caret is outside viewport
      const target = newSelections[0].active;
      const targetRange = new vscode.Range(target, target);
      const isVisible = editor.visibleRanges.some((vr) => vr.contains(targetRange));
      if (!isVisible) {
        editor.revealRange(
          targetRange,
          vscode.TextEditorRevealType.InCenterIfOutsideViewport
        );
      }
    } finally {
      isAdjustingCaret = false;
    }
  }
}

/*===========================================================
  Activate / Deactivate
===========================================================*/
const CARET_NUDGE_DELAY_MS = 140;
let keyboardNudgeTimer: NodeJS.Timeout | undefined;

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
    vscode.window.onDidChangeTextEditorSelection((e) => {
      applyDecorations();
      const ed = vscode.window.activeTextEditor;
      if (!ed) return;

      // If selection change is caused by keyboard (e.g., arrow keys),
      // delay the caret nudge so repeated keypresses can cross the middot.
      if (e.kind === vscode.TextEditorSelectionChangeKind.Keyboard) {
        if (keyboardNudgeTimer) clearTimeout(keyboardNudgeTimer);
        keyboardNudgeTimer = setTimeout(() => {
          adjustCaretAfterMiddot(ed);
          keyboardNudgeTimer = undefined;
        }, CARET_NUDGE_DELAY_MS);
      } else {
        // Mouse/Command: apply immediately
        if (keyboardNudgeTimer) {
          clearTimeout(keyboardNudgeTimer);
          keyboardNudgeTimer = undefined;
        }
        adjustCaretAfterMiddot(ed);
      }
    }),
    vscode.workspace.onDidChangeConfiguration(() => applyDecorations())
  );
}

export function deactivate() {
  if (keyboardNudgeTimer) {
    clearTimeout(keyboardNudgeTimer);
    keyboardNudgeTimer = undefined;
  }
}
