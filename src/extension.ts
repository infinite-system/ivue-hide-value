import * as vscode from 'vscode';

// ---------- config ----------
const DOT = '\u2219'; // middot-like (compact)
const RE_VALUE = /\.value\b/g;
const TS_LIKE_LANGS = ['typescript', 'typescriptreact', 'javascript', 'javascriptreact', 'vue'];

// decoration: fully hide text, paint dot visually in its place
const hiddenValueDecoration = vscode.window.createTextEditorDecorationType({
  textDecoration: 'font-size:0; opacity:0;',
  rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  after: {
    contentText: DOT,
    color: new vscode.ThemeColor('editor.foreground'),
    fontSize: '0.8em',
    margin: '0 0 0 -6ch', // pull the dot left into the hidden width
  },
});

// ---------- utils ----------
const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));
function langOk(editor?: vscode.TextEditor) {
  return !!editor && TS_LIKE_LANGS.includes(editor.document.languageId);
}
function positionsEqual(a: vscode.Position, b: vscode.Position) {
  return a.line === b.line && a.character === b.character;
}
function posInRange(p: vscode.Position, r: vscode.Range) {
  return r.contains(p);
}
function anySelectionTouches(range: vscode.Range, selections: readonly vscode.Selection[]) {
  return selections.some(sel => range.intersection(sel) || positionsEqual(sel.active, range.end));
}

// ask VS Code’s hover provider for the type text at position
async function getHoverTypeAt(doc: vscode.TextDocument, pos: vscode.Position): Promise<string | null> {
  try {
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      doc.uri,
      pos,
    );
    if (!hovers || !hovers.length) return null;
    // join all hover contents to a single string we can scan
    const parts: string[] = [];
    for (const h of hovers) {
      for (const c of h.contents) {
        if (typeof c === 'string') parts.push(c);
        else if ('value' in c) parts.push(c.value);
      }
    }
    const text = parts.join('\n');
    return text || null;
  } catch {
    return null;
  }
}

// determine if the expression just before `.value` is a Ref / ComputedRef (TS-aware via hover text)
async function isRefLike(doc: vscode.TextDocument, receiverEnd: vscode.Position): Promise<boolean> {
  const hover = await getHoverTypeAt(doc, receiverEnd);
  if (!hover) return false;
  // heuristics on the type text from TS/JS hover
  // matches: Ref<...>, ShallowRef<...>, ComputedRef<...>, WritableComputedRef<...>
  return /\b(Ref|ShallowRef|ComputedRef|WritableComputedRef)\s*<|:?\s*Ref<|:?\s*ComputedRef</.test(hover);
}

// extract all “.value” ranges in visible lines
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

// throttle/debounce helper
function debounce<F extends (...args: any[]) => void>(fn: F, wait = 120) {
  let t: NodeJS.Timeout | undefined;
  return (...args: Parameters<F>) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

// ---------- core apply ----------
const applyDecorations = debounce(async () => {
  const editor = vscode.window.activeTextEditor;
  if (!langOk(editor)) return;

  const { document, selections } = editor!;
  const valueRanges = findValueRangesInVisible(editor!);

  const decorations: vscode.DecorationOptions[] = [];

  for (const r of valueRanges) {
    // cursor logic:
    //  - if cursor/selection touches the .value range → reveal it
    //  - also reveal if cursor is exactly at the end (to allow typing/backspace)
    if (anySelectionTouches(r, selections)) {
      continue;
    }

    // TS-aware: check the receiver just before ".value"
    // receiverEnd = start of ".value" (foo|.value) — request hover there
    const receiverEnd = r.start;

    // Skip extremely long lines quickly
    if (r.start.character < 1) continue;

    // ask hover provider (TypeScript/JS) for the type
    const ok = await isRefLike(document, receiverEnd);
    if (!ok) continue;

    decorations.push({ range: r, hoverMessage: new vscode.MarkdownString('**Ref-like**: hidden `.value`') });
  }

  editor!.setDecorations(hiddenValueDecoration, decorations);
}, 50);

// ---------- activation ----------
export function activate(context: vscode.ExtensionContext) {
  // initial
  applyDecorations();

  // re-run on these triggers
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => applyDecorations()),
    vscode.workspace.onDidChangeTextDocument((e) => {
      const ed = vscode.window.activeTextEditor;
      if (ed && e.document.uri.toString() === ed.document.uri.toString()) applyDecorations();
    }),
    vscode.window.onDidChangeTextEditorSelection(() => applyDecorations()),
    vscode.window.onDidChangeTextEditorVisibleRanges(() => applyDecorations()),
    vscode.workspace.onDidChangeConfiguration(() => applyDecorations()),
  );
}

export function deactivate() {
  // noop; VS Code cleans up decorations on disposal
}