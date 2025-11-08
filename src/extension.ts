import * as vscode from 'vscode';

/**
 * Regex to find literal ".value" tokens.
 * (Step 1: hide all; later we can make TS-aware)
 */
const VALUE_RE = /\.value\b/g;

type HideRange = { range: vscode.Range; key: string };

export function activate(context: vscode.ExtensionContext) {
  const state = new Map<vscode.TextEditor, {
    hidden: HideRange[];
    decTypeHidden: vscode.TextEditorDecorationType;
    decTypeDot: vscode.TextEditorDecorationType;
  }>();

  function getConfig() {
    const cfg = vscode.workspace.getConfiguration();
    return {
      enabled: cfg.get<boolean>('ivueHideValue.enable', true),
      dot: cfg.get<string>('ivueHideValue.middot', '·'),
      color: cfg.get<string>('ivueHideValue.color', '#999999')
    };
  }

  function makeDecorations(dot: string, color: string) {
    // Decoration to make ".value" invisible and collapse its visual width.
    // We hide the text and use a negative margin in an AFTER segment on a zero-width anchor.
    const decHidden = vscode.window.createTextEditorDecorationType({
      // Make the real text visually gone
      opacity: '0',
      color: '#0000', // fully transparent
      letterSpacing: '-100px', // shrink glyph spacing aggressively
      textDecoration: 'none; font-size:0; width:0;'
    });

    // Decoration that draws the middot at the exact start of the token.
    const decDot = vscode.window.createTextEditorDecorationType({
      after: {
        contentText: dot,
        color,
        margin: '0 0 0 0'
      }
    });

    return { decHidden, decDot };
  }

  function keyOf(r: vscode.Range) {
    return `${r.start.line}:${r.start.character}-${r.end.line}:${r.end.character}`;
  }

  function computeRanges(editor: vscode.TextEditor): HideRange[] {
    const doc = editor.document;
    const ranges: HideRange[] = [];
    for (let line = 0; line < doc.lineCount; line++) {
      const text = doc.lineAt(line).text;
      VALUE_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = VALUE_RE.exec(text))) {
        const start = new vscode.Position(line, m.index);
        const end = new vscode.Position(line, m.index + m[0].length);
        const range = new vscode.Range(start, end);
        ranges.push({ range, key: keyOf(range) });
      }
    }
    return ranges;
  }

  function applyDecorations(editor: vscode.TextEditor) {
    const cfg = getConfig();
    let rec = state.get(editor);

    if (!cfg.enabled) {
      clearDecorations(editor);
      return;
    }

    if (!rec) {
      const { decHidden, decDot } = makeDecorations(cfg.dot, cfg.color);
      rec = { hidden: [], decTypeHidden: decHidden, decTypeDot: decDot };
      state.set(editor, rec);
      context.subscriptions.push(decHidden, decDot);
    }

    // Re-scan the document
    rec.hidden = computeRanges(editor);

    // Build two decoration lists:
    // - Hidden ranges (cover the ".value" token)
    // - Dot ranges placed at the START position (zero-length range)
    const hiddenOpts: vscode.DecorationOptions[] = [];
    const dotOpts: vscode.DecorationOptions[] = [];

    const carets = editor.selections.map(s => s.active);

    for (const h of rec.hidden) {
      const caretIsBeforeDot =
        carets.some(pos => pos.line === h.range.start.line && pos.character === h.range.start.character);

      // If the caret is exactly at the start of the hidden token,
      // temporarily reveal the original text (skip hiding & dot)
      if (caretIsBeforeDot) continue;

      hiddenOpts.push({ range: h.range });
      // zero-width anchor at the start to draw middot
      dotOpts.push({ range: new vscode.Range(h.range.start, h.range.start) });
    }

    editor.setDecorations(rec.decTypeHidden, hiddenOpts);
    editor.setDecorations(rec.decTypeDot, dotOpts);
  }

  function clearDecorations(editor: vscode.TextEditor) {
    const rec = state.get(editor);
    if (!rec) return;
    editor.setDecorations(rec.decTypeHidden, []);
    editor.setDecorations(rec.decTypeDot, []);
  }

  function refreshAllVisible() {
    vscode.window.visibleTextEditors.forEach(applyDecorations);
  }

  // Hover provider: show a hint when hovering the middot position
  const hover = vscode.languages.registerHoverProvider(
    ['javascript', 'javascriptreact', 'typescript', 'typescriptreact', 'vue'],
    {
      provideHover(doc, pos) {
        const ed = vscode.window.activeTextEditor;
        if (!ed || ed.document !== doc) return;
        const rec = state.get(ed);
        if (!rec) return;

        // If cursor hovers exactly at the start of a hidden token, show hint
        const hit = rec.hidden.find(h => h.range.start.line === pos.line &&
          pos.character >= h.range.start.character &&
          pos.character <= h.range.start.character + 1); // leniency
        if (!hit) return;

        return new vscode.Hover('hidden: `.value`');
      }
    }
  );

  context.subscriptions.push(
    hover,
    vscode.window.onDidChangeActiveTextEditor(ed => { if (ed) applyDecorations(ed); }),
    vscode.workspace.onDidChangeTextDocument(e => {
      const ed = vscode.window.activeTextEditor;
      if (ed && e.document === ed.document) applyDecorations(ed);
    }),
    vscode.window.onDidChangeTextEditorSelection(e => {
      // Update visibility when the caret moves (for reveal-before-dot behavior)
      applyDecorations(e.textEditor);
    })
  );

  // Initial
  vscode.window.visibleTextEditors.forEach(applyDecorations);
}

export function deactivate() { /* noop */ }
