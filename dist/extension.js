"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
/**
 * Regex to find literal ".value" tokens.
 * (Step 1: hide all; later we can make TS-aware)
 */
const VALUE_RE = /\.value\b/g;
function activate(context) {
    const state = new Map();
    function getConfig() {
        const cfg = vscode.workspace.getConfiguration();
        return {
            enabled: cfg.get('ivueHideValue.enable', true),
            dot: cfg.get('ivueHideValue.middot', '·'),
            color: cfg.get('ivueHideValue.color', '#999999')
        };
    }
    function makeDecorations(dot, color) {
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
    function keyOf(r) {
        return `${r.start.line}:${r.start.character}-${r.end.line}:${r.end.character}`;
    }
    function computeRanges(editor) {
        const doc = editor.document;
        const ranges = [];
        for (let line = 0; line < doc.lineCount; line++) {
            const text = doc.lineAt(line).text;
            VALUE_RE.lastIndex = 0;
            let m;
            while ((m = VALUE_RE.exec(text))) {
                const start = new vscode.Position(line, m.index);
                const end = new vscode.Position(line, m.index + m[0].length);
                const range = new vscode.Range(start, end);
                ranges.push({ range, key: keyOf(range) });
            }
        }
        return ranges;
    }
    function applyDecorations(editor) {
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
        const hiddenOpts = [];
        const dotOpts = [];
        const carets = editor.selections.map(s => s.active);
        for (const h of rec.hidden) {
            const caretIsBeforeDot = carets.some(pos => pos.line === h.range.start.line && pos.character === h.range.start.character);
            // If the caret is exactly at the start of the hidden token,
            // temporarily reveal the original text (skip hiding & dot)
            if (caretIsBeforeDot)
                continue;
            hiddenOpts.push({ range: h.range });
            // zero-width anchor at the start to draw middot
            dotOpts.push({ range: new vscode.Range(h.range.start, h.range.start) });
        }
        editor.setDecorations(rec.decTypeHidden, hiddenOpts);
        editor.setDecorations(rec.decTypeDot, dotOpts);
    }
    function clearDecorations(editor) {
        const rec = state.get(editor);
        if (!rec)
            return;
        editor.setDecorations(rec.decTypeHidden, []);
        editor.setDecorations(rec.decTypeDot, []);
    }
    function refreshAllVisible() {
        vscode.window.visibleTextEditors.forEach(applyDecorations);
    }
    // Hover provider: show a hint when hovering the middot position
    const hover = vscode.languages.registerHoverProvider(['javascript', 'javascriptreact', 'typescript', 'typescriptreact', 'vue'], {
        provideHover(doc, pos) {
            const ed = vscode.window.activeTextEditor;
            if (!ed || ed.document !== doc)
                return;
            const rec = state.get(ed);
            if (!rec)
                return;
            // If cursor hovers exactly at the start of a hidden token, show hint
            const hit = rec.hidden.find(h => h.range.start.line === pos.line &&
                pos.character >= h.range.start.character &&
                pos.character <= h.range.start.character + 1); // leniency
            if (!hit)
                return;
            return new vscode.Hover('hidden: `.value`');
        }
    });
    context.subscriptions.push(hover, vscode.window.onDidChangeActiveTextEditor(ed => { if (ed)
        applyDecorations(ed); }), vscode.workspace.onDidChangeTextDocument(e => {
        const ed = vscode.window.activeTextEditor;
        if (ed && e.document === ed.document)
            applyDecorations(ed);
    }), vscode.window.onDidChangeTextEditorSelection(e => {
        // Update visibility when the caret moves (for reveal-before-dot behavior)
        applyDecorations(e.textEditor);
    }));
    // Initial
    vscode.window.visibleTextEditors.forEach(applyDecorations);
}
function deactivate() { }
