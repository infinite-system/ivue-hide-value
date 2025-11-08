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

// --- computed folding decorations ---
const hideWholeLineDecoration = vscode.window.createTextEditorDecorationType({
  textDecoration: 'font-size:0; opacity:0;',
  rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
});

const lineDotDecoration = vscode.window.createTextEditorDecorationType({
  before: {
    contentText: DOT,
    color: new vscode.ThemeColor('editor.foreground'),
    fontSize: '0.8em',
    margin: '0 .2ch 0 0',
  },
});

const dollarToComputedDecoration = vscode.window.createTextEditorDecorationType({
  textDecoration: 'font-size:0; opacity:0;', // hide the "$"
  rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  after: {
    // show "computed " right where the $ was; no trailing space requested
    contentText: 'computed',
    color: new vscode.ThemeColor('editor.foreground'),
    fontStyle: 'italic',
    margin: '0 1ch 0 -1ch',
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
  return /\b(Ref|ShallowRef|ComputedRef|WritableComputedRef)\s*</.test(hover);
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

// ---------- computed folding scan ----------
// Regex for:   name = computed(this.$name.bind(this));
const RE_COMPUTED_ASSIGN = /^\s*(?:public|protected|private)?\s*(?:override\s+)?([A-Za-z_]\w*)\s*=\s*computed\s*\(\s*this\.\$([A-Za-z_]\w*)\s*\.bind\s*\(\s*this\s*\)\s*\)\s*;?/;

// Regex for:   [modifiers] $name( ... )
const RE_METHOD_SIG = /^\s*(?:public|protected|private)?\s*(?:override\s+)?(?:async\s+)?(\$[A-Za-z_]\w*)\s*\(/;

type ComputedPair = {
  assignRange: vscode.Range;    // the whole assignment line to hide
  dotAnchor: vscode.Range;      // zero-length at first nonspace column to paint the middot
  dollarRange: vscode.Range;    // the '$' char in the method signature to hide/replace
};

function findComputedPairsInVisible(editor: vscode.TextEditor): ComputedPair[] {
  const pairs: ComputedPair[] = [];
  const doc = editor.document;
  const { visibleRanges } = editor;

  // First collect all method signatures ($name → dollarRange)
  const methodDollarByName = new Map<string, vscode.Range>();

  for (const vis of visibleRanges) {
    for (let line = vis.start.line; line <= vis.end.line; line++) {
      const text = doc.lineAt(line).text;
      const m = RE_METHOD_SIG.exec(text);
      if (m) {
        const full = m[1]; // like "$area3"
        const idx = text.indexOf(full);
        const dollarCol = idx; // first char is '$'
        const r = new vscode.Range(
          new vscode.Position(line, dollarCol),
          new vscode.Position(line, dollarCol + 1) // only the '$'
        );
        methodDollarByName.set(full.slice(1), r); // store without '$' for lookup
      }
    }
  }

  // Then find assignments and pair them if method exists
  for (const vis of visibleRanges) {
    for (let line = vis.start.line; line <= vis.end.line; line++) {
      const text = doc.lineAt(line).text;
      const a = RE_COMPUTED_ASSIGN.exec(text);
      if (!a) continue;
      const lhsName = a[1]; // 'area3'
      const rhsMethod = a[2]; // 'area3'
      if (lhsName !== rhsMethod) {
        // still allow pairing by rhs name
      }
      const methodRange = methodDollarByName.get(rhsMethod);
      if (!methodRange) continue;

      // assignment line full range
      const assignStart = new vscode.Position(line, 0);
      const assignEnd = new vscode.Position(line, text.length);
      const assignRange = new vscode.Range(assignStart, assignEnd);

      // dot anchor: start at first non-space (so dot sits near indent)
      const firstNon = text.search(/\S/);
      const col = firstNon === -1 ? 0 : firstNon;
      const dotPos = new vscode.Position(line, col);
      const dotAnchor = new vscode.Range(dotPos, dotPos); // zero-length

      pairs.push({
        assignRange,
        dotAnchor,
        dollarRange: methodRange,
      });
    }
  }

  return pairs;
}

// ---------- core apply ----------
const applyDecorations = debounce(async () => {
  const editor = vscode.window.activeTextEditor;
  if (!langOk(editor)) return;

  const { document, selections } = editor!;

  // 1) .value folding (unchanged behavior)
  const valueRanges = findValueRangesInVisible(editor!);
  const valueDecorations: vscode.DecorationOptions[] = [];

  for (const r of valueRanges) {
    // reveal only when selection touches the exact .value range (or its end)
    if (anySelectionTouches(r, selections)) {
      continue;
    }
    // TS-aware: check the receiver just before ".value"
    const receiverEnd = r.start;
    if (r.start.character < 1) continue;
    const ok = await isRefLike(document, receiverEnd);
    if (!ok) continue;

    valueDecorations.push({ range: r, hoverMessage: new vscode.MarkdownString('**Ref-like**: hidden `.value`') });
  }
  editor!.setDecorations(hiddenValueDecoration, valueDecorations);

  // 2) computed folding
  const pairs = findComputedPairsInVisible(editor!);
  const hideLineDecos: vscode.DecorationOptions[] = [];
  const dotDecos: vscode.DecorationOptions[] = [];
  const dollarDecos: vscode.DecorationOptions[] = [];

  for (const p of pairs) {
    // if cursor/selection touches either the assignment line or the method $ range → reveal both
    const touchesAssign = anySelectionTouches(p.assignRange, selections);
    const touchesDollar = anySelectionTouches(p.dollarRange, selections);
    if (touchesAssign || touchesDollar) {
      continue; // reveal original text
    }

    hideLineDecos.push({ range: p.assignRange });
    dotDecos.push({ range: p.dotAnchor });
    dollarDecos.push({ range: p.dollarRange });
  }

  editor!.setDecorations(hideWholeLineDecoration, hideLineDecos);
  editor!.setDecorations(lineDotDecoration, dotDecos);
  editor!.setDecorations(dollarToComputedDecoration, dollarDecos);
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