import { diagnosticFailure } from '../shared/diagnostics';
import { useEffect, useId, useRef, type ReactNode } from 'react';
export const labels = {
  book: '基本信息',
  outline: '大纲',
  subject: '主体',
  clue: '伏笔',
  chapter: '章节',
};
export const kinds = { character: '人物', item: '物品', scene: '场景' };
const icons = {
  logo: 'M4 5.5C7 4 9.7 4.1 12 6v14c-2.3-1.9-5-2-8-.5V5.5ZM20 5.5C17 4 14.3 4.1 12 6m0 14c2.3-1.9 5-2 8-.5V5.5M16 3v6m-3-3h6',
  book: 'M4 5.5c3-1.5 5.7-1.4 8 .5 2.3-1.9 5-2 8-.5v13c-3-1.5-5.7-1.4-8 .5-2.3-1.9-5-2-8-.5v-13ZM12 6v13',
  sliders: 'M4 6h16M4 12h16M4 18h16M8 4v4m8 2v4m-6 2v4',
  chat: 'M20 11.5a7.8 7.8 0 0 1-8 7.5c-1.1 0-2.2-.2-3.1-.6L4 20l1.2-4A7 7 0 0 1 4 11.5a8 8 0 0 1 16 0Z',
  plus: 'M12 5v14M5 12h14',
  search: 'M20 20l-4-4m2-5a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z',
  close: 'm6 6 12 12M18 6 6 18',
  back: 'm12 6-6 6 6 6m-6-6h14',
  right: 'm9 6 6 6-6 6',
  edit: 'M14 5l5 5M4 20l4.5-1 11-11a2.1 2.1 0 0 0-3-3l-11 11L4 20Z',
  trash: 'M5 7h14M9 7V4h6v3m2 0-.8 13H7.8L7 7m3 4v5m4-5v5',
  page: 'M6 3h8l4 4v14H6V3Zm8 0v5h4M9 12h6m-6 4h6',
  people: 'M15 7a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM5 20v-2c0-3 2.7-4 7-4s7 1 7 4v2',
  spark: 'M12 2 14.4 9.6 22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4L12 2Z',
  outline: 'M9 5h11M9 12h11M9 19h11M4 5h.1M4 12h.1M4 19h.1',
  up: 'm6 14 6-6 6 6',
  down: 'm6 10 6 6 6-6',
  check: 'm5 12 4 4L19 6',
  folder: 'M3 7h7l2 2h9v11H3V7Z',
  attach: 'm9 15 6.6-6.6a2 2 0 0 1 2.8 2.8l-8.1 8.1a4 4 0 0 1-5.7-5.7l8.6-8.6',
  send: 'M4 12h15m-6-6 6 6-6 6',
};
export function Icon({ name, size = 17 }: { name: keyof typeof icons; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={icons[name]} />
    </svg>
  );
}
export function Dialog({
  title,
  kicker,
  close,
  children,
}: {
  title: string;
  kicker: string;
  close: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    id = useId();
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={id}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <section className="dialog-inner">
        <header className="dialog-header">
          <div>
            <p className="eyebrow">{kicker}</p>
            <h2 id={id}>{title}</h2>
          </div>
          <button type="button" className="icon-button" aria-label="关闭" onClick={close}>
            <Icon name="close" />
          </button>
        </header>
        {children}
      </section>
    </dialog>
  );
}
export function ErrorText({ text }: { text?: string }) {
  return text ? (
    <p className="error" role="alert">
      {text}
    </p>
  ) : null;
}
export function errorDetails(error: unknown) {
  return diagnosticFailure(
    (error instanceof Error ? error.message : String(error)).replace(
      /^Error invoking remote method '[^']+': Error: /,
      '',
    ),
  );
}
export function errorMessage(error: unknown) {
  return errorDetails(error).message;
}
export const norm = (text: string) => text.normalize('NFKC').trim().toLocaleLowerCase();
