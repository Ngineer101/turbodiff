import { indentWithTab } from '@codemirror/commands';
import { HighlightStyle, LanguageDescription, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { Compartment, EditorState, Transaction } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { basicSetup } from 'codemirror';
import { useEffect, useRef } from 'react';

// CodeMirror 6 wrapper for the code browser. Viewing and editing use the
// same editor (read-only vs editable) so both render identically. Every
// CodeMirror import stays inside the lazy code-page chunk — never import
// this from an eagerly-loaded module.

// The app's CSS tokens (src/client/styles.css) mapped onto CodeMirror, so
// the editor — including its search panel, autocomplete popup, matching
// brackets, and folds — reads like the rest of the surface.
const theme = EditorView.theme(
  {
    '&': {
      height: '100%',
      backgroundColor: 'var(--color-surface)',
      color: 'var(--color-ink)',
      fontSize: '0.8125rem',
    },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--font-mono)', lineHeight: '1.6' },
    '.cm-content': { caretColor: 'var(--color-accent-bright)', padding: '4px 0' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--color-accent-bright)' },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
      { backgroundColor: 'color-mix(in srgb, var(--color-accent) 35%, transparent)' },
    // Word-occurrence highlights from the current selection.
    '.cm-selectionMatch': {
      backgroundColor: 'color-mix(in srgb, var(--color-accent) 18%, transparent)',
    },
    // Matching-bracket pair when the caret is on a bracket.
    '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
      backgroundColor: 'color-mix(in srgb, var(--color-accent) 28%, transparent)',
      outline: '1px solid color-mix(in srgb, var(--color-accent) 55%, transparent)',
    },
    '.cm-nonmatchingBracket': { color: 'var(--color-danger)' },
    '.cm-gutters': {
      backgroundColor: 'var(--color-bg)',
      color: 'var(--color-mute)',
      borderRight: '1px solid var(--color-line)',
    },
    '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 12px' },
    '.cm-foldGutter .cm-gutterElement': { color: 'var(--color-mute)' },
    '.cm-activeLine': {
      backgroundColor: 'color-mix(in srgb, var(--color-raised) 45%, transparent)',
    },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--color-ink-dim)' },
    '.cm-foldPlaceholder': {
      backgroundColor: 'var(--color-raised)',
      border: '1px solid var(--color-line-2)',
      color: 'var(--color-mute)',
      borderRadius: '4px',
      padding: '0 6px',
      margin: '0 4px',
    },
    // Panels (search/replace) and dialog controls.
    '.cm-panels': {
      backgroundColor: 'var(--color-surface-2)',
      color: 'var(--color-ink)',
      fontFamily: 'var(--font-sans)',
    },
    '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--color-line)' },
    '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--color-line)' },
    '.cm-textfield': {
      backgroundColor: 'var(--color-bg)',
      border: '1px solid var(--color-line-2)',
      borderRadius: '5px',
      color: 'var(--color-ink)',
    },
    '.cm-button': {
      backgroundColor: 'var(--color-raised)',
      backgroundImage: 'none',
      border: '1px solid var(--color-line-2)',
      borderRadius: '5px',
      color: 'var(--color-ink)',
    },
    '.cm-searchMatch': {
      backgroundColor: 'color-mix(in srgb, var(--color-warn) 30%, transparent)',
    },
    '.cm-searchMatch.cm-searchMatch-selected': {
      backgroundColor: 'color-mix(in srgb, var(--color-warn) 55%, transparent)',
    },
    '.cm-tooltip': {
      backgroundColor: 'var(--color-raised)',
      border: '1px solid var(--color-line-2)',
      borderRadius: '8px',
      color: 'var(--color-ink)',
    },
    // Autocomplete popup.
    '.cm-tooltip.cm-tooltip-autocomplete': { overflow: 'hidden', padding: '0' },
    '.cm-tooltip-autocomplete > ul': {
      fontFamily: 'var(--font-mono)',
      fontSize: '0.8125rem',
      maxHeight: '16rem',
    },
    '.cm-tooltip-autocomplete > ul > li': { padding: '3px 10px' },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
      backgroundColor: 'color-mix(in srgb, var(--color-accent) 25%, transparent)',
      color: 'var(--color-ink)',
    },
    '.cm-completionIcon': { color: 'var(--color-mute)', opacity: '0.8' },
    '.cm-completionMatchedText': {
      color: 'var(--color-accent-bright)',
      textDecoration: 'none',
      fontWeight: '600',
    },
    '.cm-completionDetail': { color: 'var(--color-mute)', fontStyle: 'normal' },
  },
  { dark: true },
);

// Syntax colors, mapped onto the same --color-code-* palette the cockpit's
// highlight.js theme uses (GitHub-dark lineage), so code reads identically
// everywhere. Coverage is deliberately broad: control-flow keywords, JSX/HTML
// tags, escapes, diffs, and markdown formatting all get a rule so nothing
// falls through to CodeMirror's light-theme fallback. Punctuation, operators,
// and plain identifiers are intentionally left at the default ink color, the
// same restraint GitHub's own theme shows.
const highlight = HighlightStyle.define([
  // Comments & metadata
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment],
    color: 'var(--color-mute)',
    fontStyle: 'italic',
  },
  { tag: [tags.meta, tags.documentMeta, tags.processingInstruction], color: 'var(--color-mute)' },

  // Keywords, control flow, modifiers, this/super
  {
    tag: [
      tags.keyword,
      tags.controlKeyword,
      tags.definitionKeyword,
      tags.operatorKeyword,
      tags.moduleKeyword,
      tags.modifier,
      tags.self,
    ],
    color: 'var(--color-code-keyword)',
  },

  // Functions, methods, labels, macros
  {
    tag: [
      tags.function(tags.variableName),
      tags.function(tags.propertyName),
      tags.labelName,
      tags.macroName,
    ],
    color: 'var(--color-code-fn)',
  },

  // Strings, chars, regex, escapes, attribute values
  {
    tag: [
      tags.string,
      tags.docString,
      tags.special(tags.string),
      tags.character,
      tags.regexp,
      tags.escape,
      tags.attributeValue,
    ],
    color: 'var(--color-code-string)',
  },

  // Numbers, booleans, constants, atoms, attributes, units, CSS colors
  {
    tag: [
      tags.number,
      tags.integer,
      tags.float,
      tags.bool,
      tags.null,
      tags.atom,
      tags.unit,
      tags.color,
      tags.constant(tags.variableName),
      tags.constant(tags.name),
      tags.standard(tags.name),
      tags.attributeName,
    ],
    color: 'var(--color-code-const)',
  },

  // Types, classes, namespaces, annotations
  {
    tag: [
      tags.typeName,
      tags.className,
      tags.namespace,
      tags.definition(tags.typeName),
      tags.definition(tags.className),
      tags.annotation,
    ],
    color: 'var(--color-code-type)',
  },

  // Element/tag names (HTML, JSX, XML)
  { tag: tags.tagName, color: 'var(--color-accent-bright)' },

  // Diff / change markers
  { tag: [tags.inserted, tags.changed], color: 'var(--color-go-bright)' },
  { tag: tags.deleted, color: 'var(--color-danger)' },
  { tag: tags.invalid, color: 'var(--color-danger)' },

  // Links & URLs
  { tag: [tags.link, tags.url], color: 'var(--color-accent-bright)', textDecoration: 'underline' },

  // Markdown / prose formatting
  {
    tag: [
      tags.heading,
      tags.heading1,
      tags.heading2,
      tags.heading3,
      tags.heading4,
      tags.heading5,
      tags.heading6,
    ],
    color: 'var(--color-ink)',
    fontWeight: '600',
  },
  { tag: tags.strong, fontWeight: '600' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.monospace, color: 'var(--color-code-string)' },
  { tag: tags.quote, color: 'var(--color-mute)' },
]);

function readOnlyExtensions(readOnly: boolean) {
  return [
    EditorState.readOnly.of(readOnly),
    EditorView.editable.of(!readOnly),
    // A non-editable view has no tabindex of its own, which would make the
    // read-only viewer unfocusable — no ⌘F search, no arrow-key scrolling,
    // no fold keys. Keep it a first-class keyboard target in both modes.
    EditorView.contentAttributes.of({ tabindex: '0' }),
  ];
}

export function CodeEditor({
  value,
  onChange,
  path,
  readOnly,
  wrap = false,
  onSave,
}: {
  value: string;
  onChange: (next: string) => void;
  path: string;
  readOnly: boolean;
  // Soft-wrap long lines instead of horizontal scrolling.
  wrap?: boolean;
  // ⌘S / Ctrl-S inside the editor. Always intercepted (so the browser's
  // save-page dialog never appears over an editor), acts only when provided.
  onSave?: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // Latest props for the path-keyed creation effect, so it only re-runs (and
  // rebuilds the view) when the file changes.
  const valueRef = useRef(value);
  valueRef.current = value;
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const wrapRef = useRef(wrap);
  wrapRef.current = wrap;
  const readOnlyCompartment = useRef(new Compartment());
  const languageCompartment = useRef(new Compartment());
  const wrapCompartment = useRef(new Compartment());

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({
      doc: valueRef.current,
      parent: host,
      extensions: [
        // Before basicSetup so these win over its default bindings.
        keymap.of([
          {
            key: 'Mod-s',
            run: () => {
              onSaveRef.current?.();
              return true;
            },
          },
          indentWithTab,
        ]),
        basicSetup,
        theme,
        syntaxHighlighting(highlight),
        readOnlyCompartment.current.of(readOnlyExtensions(readOnlyRef.current)),
        languageCompartment.current.of([]),
        wrapCompartment.current.of(wrapRef.current ? EditorView.lineWrapping : []),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString());
        }),
      ],
    });
    viewRef.current = view;
    // Language support loads on demand per file (dynamic import inside
    // @codemirror/language-data), then swaps into the compartment.
    let cancelled = false;
    const language = LanguageDescription.matchFilename(languages, path);
    if (language) {
      language.load().then(
        (support) => {
          if (!cancelled) {
            view.dispatch({ effects: languageCompartment.current.reconfigure(support) });
          }
        },
        // A failed grammar chunk load just means no highlighting — the file
        // itself is already on screen.
        () => {},
      );
    }
    return () => {
      cancelled = true;
      view.destroy();
      viewRef.current = null;
    };
  }, [path]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: readOnlyCompartment.current.reconfigure(readOnlyExtensions(readOnly)),
    });
  }, [readOnly]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: wrapCompartment.current.reconfigure(wrap ? EditorView.lineWrapping : []),
    });
  }, [wrap]);

  // External value changes (discard, reload after save) replace the buffer;
  // edits round-trip through onChange, so an in-sync value is a no-op here.
  // The replacement stays out of the undo history — undo after a reload
  // must not resurrect the pre-reload buffer.
  useEffect(() => {
    const view = viewRef.current;
    if (view && value !== view.state.doc.toString()) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
        annotations: [Transaction.addToHistory.of(false)],
      });
    }
  }, [value]);

  return <div ref={hostRef} className="h-full min-h-0" />;
}
