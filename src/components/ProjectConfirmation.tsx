import { useId, useLayoutEffect, useRef } from 'react';

interface ProjectConfirmationProps {
  title: string;
  message?: string;
  cancelLabel: string;
  onCancel: () => void;
  confirm?: { label: string; onClick: () => void };
}

export function ProjectConfirmation({ title, message, cancelLabel, onCancel, confirm }: ProjectConfirmationProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const messageId = useId();

  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    element.showModal();
    cancel.current?.focus();
    return () => { element.close(); };
  }, []);

  return <dialog ref={dialog} id="project-confirmation" aria-labelledby={titleId}
    aria-describedby={message ? messageId : undefined}
    onCancel={event => { event.preventDefault(); onCancel(); }}
    className="fixed inset-0 m-auto max-h-[calc(100dvh_-_2rem)] w-[calc(100%_-_2rem)] max-w-md overflow-y-auto overscroll-contain rounded-xl border border-[var(--line)] bg-[var(--ink-800)] p-0 text-[var(--text-hi)] shadow-xl backdrop:bg-black/35">
    <header className="border-b border-[var(--line)] px-4 py-3">
      <h2 id={titleId} className="text-sm font-semibold">{title}</h2>
    </header>
    {message && <p id={messageId} className="whitespace-pre-line px-4 py-3 text-sm text-[var(--text-mid)]">{message}</p>}
    <footer className="flex flex-wrap justify-end gap-2 px-4 py-3">
      <button ref={cancel} id="btn-cancel-project-confirmation" type="button"
        className="btn-quiet cursor-pointer px-3 py-1.5 text-xs" onClick={onCancel}>
        {cancelLabel}
      </button>
      {confirm && <button id="btn-confirm-project-confirmation" type="button"
        className="btn-quiet cursor-pointer px-3 py-1.5 text-xs text-[var(--bad)]!" onClick={confirm.onClick}>
        {confirm.label}
      </button>}
    </footer>
  </dialog>;
}
