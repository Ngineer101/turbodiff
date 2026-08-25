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
// the editor reads like the rest of the surface.
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
    '.cm-content': { caretColor: 'var(--color-accent-bright)' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--color-accent-bright)' },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
      { backgroundColor: 'color-mix(in srgb, var(--color-accent) 35%, transparent)' },
    '.cm-gutters': {
      backgroundColor: 'var(--color-bg)',
      color: 'var(--color-mute)',
      borderRight: '1px solid var(--color-line)',
    },
    '.cm-activeLine': {
      backgroundColor: 'color-mix(in srgb, var(--color-raised) 45%, transparent)',
    },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--color-ink-dim)' },
    '.cm-panels': {
      backgroundColor: 'var(--color-surface-2)',
      color: 'var(--color-ink)',
      fontFamily: 'var(--font-sans)',
    },
    '.cm-searchMatch': {
      backgroundColor: 'color-mix(in srgb, var(--color-warn) 30%, transparent)',
    },
    '.cm-tooltip': {
      backgroundColor: 'var(--color-raised)',
      border: '1px solid var(--color-line-2)',
      color: 'var(--color-ink)',
    },
  },
  { dark: true },
);

// Same palette the cockpit's highlight.js theme uses (--color-code-* in
// styles.css), so code renders with the app's syntax colors everywhere.
const highlight = HighlightStyle.define([
  {
    tag: [tags.keyword, tags.operatorKeyword, tags.modifier, tags.moduleKeyword],
    color: 'var(--color-code-keyword)',
  },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.labelName],
    color: 'var(--color-code-fn)',
  },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: 'var(--color-code-string)' },
  {
    tag: [
      tags.number,
      tags.bool,
      tags.null,
      tags.atom,
      tags.constant(tags.name),
      tags.attributeName,
    ],
    color: 'var(--color-code-const)',
  },
  {
    tag: [tags.typeName, tags.className, tags.namespace, tags.tagName],
    color: 'var(--color-code-type)',
  },
  { tag: [tags.comment, tags.meta], color: 'var(--color-mute)', fontStyle: 'italic' },
  { tag: tags.heading, color: 'var(--color-ink)', fontWeight: '600' },
  { tag: tags.link, color: 'var(--color-accent-bright)' },
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
