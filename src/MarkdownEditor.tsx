import { useEffect, useRef } from 'react';
import { basicSetup, EditorView } from 'codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { Annotation, Compartment, EditorState, Transaction } from '@codemirror/state';

const external = Annotation.define<boolean>();
export function MarkdownEditor({
  value,
  onChange,
  readOnly = false,
  onApplied,
}: {
  value: string;
  onChange: (s: string) => void;
  readOnly?: boolean;
  onApplied?: () => void;
}) {
  const container = useRef<HTMLDivElement>(null),
    view = useRef<EditorView | null>(null);
  const callbacks = useRef({ value, onChange });
  callbacks.current = { value, onChange };
  const mode = useRef(new Compartment());
  useEffect(() => {
    const editor = new EditorView({
      parent: container.current!,
      doc: callbacks.current.value,
      extensions: [
        basicSetup,
        markdown(),
        EditorView.lineWrapping,
        mode.current.of([]),
        EditorView.contentAttributes.of({ 'aria-label': 'Markdown 编辑器', spellcheck: 'false' }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !update.transactions.some((t) => t.annotation(external)))
            callbacks.current.onChange(update.state.doc.toString());
        }),
      ],
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
  }, []);
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const previous = editor.state.doc.toString();
    if (previous !== value) {
      const changes = value.startsWith(previous)
        ? { from: previous.length, insert: value.slice(previous.length) }
        : { from: 0, to: previous.length, insert: value };
      editor.dispatch({ changes, annotations: [external.of(true), Transaction.addToHistory.of(false)] });
    }
    onApplied?.();
  }, [value, onApplied]);
  useEffect(() => {
    view.current?.dispatch({
      effects: mode.current.reconfigure([
        EditorView.editable.of(!readOnly),
        EditorState.readOnly.of(readOnly),
      ]),
    });
  }, [readOnly]);
  return <div className="markdown-editor" ref={container} />;
}
