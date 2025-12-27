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
    color: "orange", //new vscode.ThemeColor("editor.foreground"),
    fontWeight: "bold",
    margin: "0 0 0 -6ch",
  },
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
  Last hidden value ranges for caret nudge
===========================================================*/
let lastHiddenValueRanges: vscode.Range[] = [];
let isAdjustingCaret = false;

/*===========================================================
  NEW: only allow revealRange right after tab switch
===========================================================*/
const REVEAL_ON_TAB_SWITCH_MS = 600;
let allowRevealUntil = 0;

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

      // Only reveal on tab switch (and only once)
      const now = Date.now();
      const canReveal = allowRevealUntil > now;

      // Consume the window as soon as we actually nudge (prevents later surprise jumps)
      allowRevealUntil = 0;

      if (canReveal) {
        const target = newSelections[0].active;
        const targetRange = new vscode.Range(target, target);
        const isVisible = editor.visibleRanges.some((vr) =>
          vr.contains(targetRange)
        );
        if (!isVisible) {
          editor.revealRange(
            targetRange,
            vscode.TextEditorRevealType.InCenterIfOutsideViewport
          );
        }
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
    // UPDATED: set a short "allow reveal" window on tab switch
    vscode.window.onDidChangeActiveTextEditor(() => {
      allowRevealUntil = Date.now() + REVEAL_ON_TAB_SWITCH_MS;
      applyDecorations();
    }),
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