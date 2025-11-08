import * as vscode from 'vscode';

/* =========================================================
   1) Your existing .value folding (UNCHANGED)
   ========================================================= */
const DOT = '\u2219'; // middot-like (compact)
const RE_VALUE = /\.value\b/g;
const TS_LIKE_LANGS = ['typescript', 'typescriptreact', 'javascript', 'javascriptreact', 'vue'];

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
    contentText: 'computed',
    color: new vscode.ThemeColor('editor.foreground'),
    fontStyle: 'italic',
    margin: '0 1ch 0 -1ch',
  },
});

function langOk(editor?: vscode.TextEditor) {
  return !!editor && TS_LIKE_LANGS.includes(editor.document.languageId);
}
function positionsEqual(a: vscode.Position, b: vscode.Position) {
  return a.line === b.line && a.character === b.character;
}
function anySelectionTouches(range: vscode.Range, selections: readonly vscode.Selection[]) {
  return selections.some(sel => range.intersection(sel) || positionsEqual(sel.active, range.end));
}

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
        else if ('value' in c) parts.push((c as any).value);
      }
    }
    const text = parts.join('\n');
    return text || null;
  } catch {
    return null;
  }
}
async function isRefLike(doc: vscode.TextDocument, receiverEnd: vscode.Position): Promise<boolean> {
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

// --- computed folding (keep your last working regex/logic) ---
const RE_COMPUTED_ASSIGN = /^\s*(?:public|protected|private)?\s*(?:override\s+)?([A-Za-z_]\w*)\s*=\s*computed\s*\(\s*this\.\$([A-Za-z_]\w*)\s*\.bind\s*\(\s*this\s*\)\s*\)\s*;?/;
const RE_METHOD_SIG = /^\s*(?:public|protected|private)?\s*(?:override\s+)?(?:async\s+)?(\$[A-Za-z_]\w*)\s*\(/;

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
      const lhsName = a[1];
      const rhsMethod = a[2];
      const methodRange = methodDollarByName.get(rhsMethod);
      if (!methodRange) continue;

      const assignRange = new vscode.Range(new vscode.Position(line, 0), new vscode.Position(line, text.length));
      const firstNon = text.search(/\S/);
      const col = firstNon === -1 ? 0 : firstNon;
      const dotPos = new vscode.Position(line, col);
      const dotAnchor = new vscode.Range(dotPos, dotPos);

      pairs.push({ assignRange, dotAnchor, dollarRange: methodRange });
    }
  }
  return pairs;
}

const applyDecorations = debounce(async () => {
  const editor = vscode.window.activeTextEditor;
  if (!langOk(editor)) return;

  const { document, selections } = editor!;

  // .value folding
  const valueRanges = findValueRangesInVisible(editor!);
  const valueDecorations: vscode.DecorationOptions[] = [];
  for (const r of valueRanges) {
    if (anySelectionTouches(r, selections)) continue;
    const receiverEnd = r.start;
    if (r.start.character < 1) continue;
    const ok = await isRefLike(document, receiverEnd);
    if (!ok) continue;
    valueDecorations.push({ range: r, hoverMessage: new vscode.MarkdownString('**Ref-like**: hidden `.value`') });
  }
  editor!.setDecorations(hiddenValueDecoration, valueDecorations);

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
const REGION_START = '// #region ivue bound methods';
const REGION_END = '// #endregion ivue bound methods';

// Matches instance methods to bind (NOT starting with $, NOT static/get/set/constructor)
const RE_CLASS = /class\s+([A-Za-z_]\w*)[\s\S]*?\{/g;
const RE_METHOD_HEADER =
  /^\s*(?:public|private|protected)?\s*(?:override\s+)?(?!static\b)(?!get\b)(?!set\b)(?!constructor\b)(?:async\s+)?([A-Za-z_]\w*)\s*\(/;

function findMatchingBrace(text: string, fromIndex: number): number {
  let depth = 0;
  for (let i = fromIndex; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function findConstructorRange(text: string, classStart: number, classEnd: number): { start: number, end: number } | null {
  const classBody = text.slice(classStart, classEnd + 1); // includes braces
  const base = classStart;
  const re = /^\s*constructor\s*\([^)]*\)\s*\{/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(classBody))) {
    const openIdx = base + m.index + m[0].lastIndexOf('{');
    const closeIdx = findMatchingBrace(text, openIdx);
    if (closeIdx !== -1) return { start: openIdx, end: closeIdx };
  }
  return null;
}

function collectOwnMethodNames(text: string, classOpenBrace: number, classCloseBrace: number): string[] {
  const body = text.slice(classOpenBrace + 1, classCloseBrace);
  const lines = body.split('\n');
  const names: string[] = [];
  for (const line of lines) {
    const m = RE_METHOD_HEADER.exec(line);
    if (!m) continue;
    const name = m[1];
    if (!name || name === 'super') continue; // safety
    if (name.startsWith('$')) continue;
    names.push(name);
  }
  // de-dup while preserving order
  const seen = new Set<string>();
  return names.filter(n => (seen.has(n) ? false : (seen.add(n), true)));
}

function getIndentOfLine(text: string, index: number): string {
  let i = index;
  while (i > 0 && text[i - 1] !== '\n') i--;
  let j = i;
  while (j < text.length && (text[j] === ' ' || text[j] === '\t')) j++;
  return text.slice(i, j);
}

function ensureConstructorAndRegion(
  doc: vscode.TextDocument,
  edit: vscode.WorkspaceEdit,
  classOpen: number,
  classClose: number,
  currentText: string,
  desiredLines: string[]
) {
  const constructor = findConstructorRange(currentText, classOpen, classClose);
  const fileUri = doc.uri;

  if (!constructor) {
    // Insert a constructor with the region just after the opening brace
    const classIndent = getIndentOfLine(currentText, classOpen);
    const innerIndent = classIndent + '  ';
    const regionIndent = innerIndent + '  ';

    const insertPos = doc.positionAt(classOpen + 1); // right after '{'
    const eol = doc.eol === vscode.EndOfLine.LF ? '\n' : '\r\n';
    const body =
      eol +
      innerIndent + 'constructor() {' + eol +
      innerIndent + '  ' + REGION_START + eol +
      desiredLines.map(l => regionIndent + l).join(eol) + (desiredLines.length ? eol : '') +
      innerIndent + '  ' + REGION_END + eol +
      innerIndent + '}' + eol;

    edit.insert(fileUri, insertPos, body);
    return;
  }

  // Constructor exists; find/replace region content or insert region if missing
  const ctorStart = constructor.start;
  const ctorEnd = constructor.end;
  const ctorIndent = getIndentOfLine(currentText, doc.offsetAt(doc.positionAt(ctorStart)));
  const innerIndent = ctorIndent + '  ';
  const regionIndent = innerIndent + '  ';
  const eol = doc.eol === vscode.EndOfLine.LF ? '\n' : '\r\n';

  const ctorBodyText = currentText.slice(ctorStart + 1, ctorEnd); // between { and }
  const regionStartIdx = ctorBodyText.indexOf(REGION_START);
  const regionEndIdx = regionStartIdx >= 0 ? ctorBodyText.indexOf(REGION_END, regionStartIdx) : -1;

  if (regionStartIdx === -1 || regionEndIdx === -1) {
    // Insert a fresh region at end of constructor body (before closing brace)
    const insertPos = doc.positionAt(ctorEnd);
    const block =
      eol +
      innerIndent + REGION_START + eol +
      desiredLines.map(l => regionIndent + l).join(eol) + (desiredLines.length ? eol : '') +
      innerIndent + REGION_END + eol;
    edit.insert(fileUri, insertPos, block);
    return;
  }

  // Replace existing region content only if changed
  const regionContentStart = ctorStart + 1 + regionStartIdx + REGION_START.length;
  const regionContentEnd = ctorStart + 1 + regionEndIdx;
  const currentContent = currentText.slice(regionContentStart, regionContentEnd);

  // Normalize current content to compare
  const currentLines = currentContent
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(s => s.length > 0 && s !== REGION_START && s !== REGION_END);

  const desiredBlock =
    eol +
    desiredLines.map(l => regionIndent + l).join(eol) +
    (desiredLines.length ? eol : '') +
    innerIndent;

  const desiredRaw =
    eol +
    desiredLines.map(l => regionIndent + l).join(eol) +
    (desiredLines.length ? eol : '') ;

  // Only write if different
  const desiredCompare = desiredLines.join('\n');
  const currentCompare = currentLines
    .map(s => s.replace(/^\s*this\./, 'this.')) // normalize indent
    .join('\n');

  if (desiredCompare !== currentCompare) {
    // Replace between REGION_START and REGION_END content
    const replaceRange = new vscode.Range(
      doc.positionAt(regionContentStart),
      doc.positionAt(regionContentEnd)
    );
    edit.replace(fileUri, replaceRange, desiredBlock);
  }
}

function buildDesiredBindLines(methodNames: string[]): string[] {
  // this.name = this.name.bind(this);
  return methodNames.map(n => `this.${n} = this.${n}.bind(this);`);
}

const updateBindingsDebounced = debounce((doc: vscode.TextDocument) => {
  updateBindings(doc).catch(() => { /* ignore */ });
}, 120);

async function updateBindings(doc: vscode.TextDocument) {
  if (!TS_LIKE_LANGS.includes(doc.languageId)) return;

  const full = doc.getText();

  // Scan each class in the file
  const edits = new vscode.WorkspaceEdit();
  let changed = false;

  RE_CLASS.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE_CLASS.exec(full))) {
    const classKeywordIdx = m.index;
    // Find the opening brace for this class
    const openBraceIdx = full.indexOf('{', classKeywordIdx);
    if (openBraceIdx === -1) continue;
    const closeBraceIdx = findMatchingBrace(full, openBraceIdx);
    if (closeBraceIdx === -1) continue;

    // Collect own method names inside this class
    const methodNames = collectOwnMethodNames(full, openBraceIdx, closeBraceIdx);

    // Desired binding lines
    const desired = buildDesiredBindLines(methodNames);

    const before = edits.size;
    ensureConstructorAndRegion(doc, edits, openBraceIdx, closeBraceIdx, full, desired);
    if (edits.size > before) changed = true;
  }

  if (changed) {
    // Apply as a single atomic edit (good for Undo)
    await vscode.workspace.applyEdit(edits);
  }
}

/* =========================================================
   3) Activate
   ========================================================= */
export function activate(context: vscode.ExtensionContext) {
  // Decorations
  applyDecorations();

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => {
      applyDecorations();
      const ed = vscode.window.activeTextEditor;
      if (ed) updateBindingsDebounced(ed.document);
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      const ed = vscode.window.activeTextEditor;
      if (ed && e.document.uri.toString() === ed.document.uri.toString()) {
        applyDecorations();
        updateBindingsDebounced(e.document);
      }
    }),
    vscode.window.onDidOpenTextDocument((doc) => {
      const ed = vscode.window.activeTextEditor;
      if (ed && doc.uri.toString() === ed.document.uri.toString()) {
        updateBindingsDebounced(doc);
      }
    }),
    vscode.window.onDidChangeTextEditorVisibleRanges(() => applyDecorations()),
    vscode.window.onDidChangeTextEditorSelection(() => applyDecorations()),
    vscode.workspace.onDidChangeConfiguration(() => applyDecorations()),
  );

  // Initial bindings check on load
  const ed = vscode.window.activeTextEditor;
  if (ed) updateBindingsDebounced(ed.document);
}

export function deactivate() {
  // VS Code disposes decorations automatically
}
