import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type JSX, type ReactNode } from "react";

export interface ConfirmOptions {
  /** The question, naming what is acted on: "Recall scene “Sunday AM”?". */
  title: string;
  /** What happens, and what is lost. */
  message?: ReactNode;
  /** The confirming button's text ("Recall", "Delete"…). */
  confirmLabel?: string;
  cancelLabel?: string;
  /** Destructive: the confirm button is drawn in the error colour. */
  danger?: boolean;
}

type Confirm = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<Confirm | null>(null);

interface Pending extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

/**
 * A modal "are you sure?" built on <dialog>.showModal(): the page behind is inert, focus is trapped
 * and Escape cancels, as the platform does it. Focus starts on Cancel, so Enter alone never fires a
 * scene recall or a delete; it goes back to the control that asked when the dialog closes.
 */
export function ConfirmProvider({ children }: { children: ReactNode }): JSX.Element {
  const [pending, setPending] = useState<Pending | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const messageId = useId();

  const confirm = useCallback<Confirm>(
    (options) =>
      new Promise<boolean>((resolve) => {
        returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setPending((previous) => {
          previous?.resolve(false);
          return { ...options, resolve };
        });
      }),
    [],
  );

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!pending || !dialog) return;
    if (!dialog.open) dialog.showModal();
    cancelRef.current?.focus();
  }, [pending]);

  function settle(ok: boolean): void {
    if (!pending) return;
    pending.resolve(ok);
    setPending(null);
    dialogRef.current?.close();
    returnFocus.current?.focus();
  }

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <dialog
        ref={dialogRef}
        className="confirm-dialog"
        aria-labelledby={titleId}
        aria-describedby={pending?.message ? messageId : undefined}
        onCancel={(event) => {
          event.preventDefault();
          settle(false);
        }}
        onClick={(event) => {
          // A click on the backdrop (the dialog element itself, outside its box) cancels.
          if (event.target === event.currentTarget) settle(false);
        }}
      >
        {pending && (
          <div className="confirm-dialog__body">
            <h2 id={titleId} className="confirm-dialog__title">
              {pending.title}
            </h2>
            {pending.message && (
              <div id={messageId} className="confirm-dialog__message">
                {pending.message}
              </div>
            )}
            <div className="confirm-dialog__actions">
              <button type="button" ref={cancelRef} onClick={() => settle(false)}>
                {pending.cancelLabel ?? "Cancel"}
              </button>
              <button
                type="button"
                className={pending.danger ? "button--danger" : "button--primary"}
                onClick={() => settle(true)}
              >
                {pending.confirmLabel ?? "Confirm"}
              </button>
            </div>
          </div>
        )}
      </dialog>
    </ConfirmContext.Provider>
  );
}

/** `await confirm({...})` resolves true when the operator confirmed. Falls back to window.confirm outside the provider. */
export function useConfirm(): Confirm {
  const confirm = useContext(ConfirmContext);
  return confirm ?? ((options) => Promise.resolve(window.confirm(options.title)));
}

/**
 * The one question every scene change asks (Scenes tab, Overview card): which scene, and that what
 * was changed on the console since the last load goes. `scene` is how to name it ("12 Sunday AM",
 * "the next scene").
 */
export function useConfirmSceneRecall(): (scene: string) => Promise<boolean> {
  const confirm = useConfirm();
  return (scene) =>
    confirm({
      title: `Recall ${scene}?`,
      message: (
        <>
          <p>The console switches to it at once: faders, mutes, routing and processing change, and the audience hears it.</p>
          <p>Changes made on the console since the last scene load and not saved there are lost.</p>
        </>
      ),
      confirmLabel: "Recall",
      danger: true,
    });
}
