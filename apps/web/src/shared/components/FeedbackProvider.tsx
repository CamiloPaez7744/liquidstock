import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { AlertCircle, AlertTriangle, CheckCircle2, Info, X } from "lucide-react";
import { haptics } from "../lib/haptics.js";

export type ToastKind = "success" | "error" | "warning" | "info";

export interface ToastInput {
  kind: ToastKind;
  title: string;
  description?: string;
  durationMs?: number;
}

interface ToastItem extends ToastInput {
  id: string;
}

export interface AlertModalAction {
  label: string;
  variant?: "primary" | "danger" | "warning" | "secondary";
  onClick?: () => Promise<void> | void;
}

export interface AlertModalOptions {
  tone?: "warning" | "danger" | "info";
  title: string;
  description: string;
  bulletItems?: string[];
  actions: AlertModalAction[];
}

interface FeedbackContextValue {
  toast: (input: ToastInput) => void;
  showAlertModal: (options: AlertModalOptions) => void;
  closeAlertModal: () => void;
}

const FeedbackContext = createContext<FeedbackContextValue | null>(null);

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [modal, setModal] = useState<AlertModalOptions | null>(null);
  const [modalBusyIndex, setModalBusyIndex] = useState<number | null>(null);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (input: ToastInput) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      setToasts((prev) => [...prev.slice(-3), { ...input, id }]);
      const duration = input.durationMs ?? (input.kind === "error" || input.kind === "warning" ? 6000 : 4000);
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, duration);
    },
    [],
  );

  const showAlertModal = useCallback((options: AlertModalOptions) => {
    setModalBusyIndex(null);
    setModal(options);
  }, []);

  const closeAlertModal = useCallback(() => {
    setModalBusyIndex(null);
    setModal(null);
  }, []);

  const handleActionClick = async (action: AlertModalAction, idx: number) => {
    if (modalBusyIndex !== null) return;
    haptics.tap();
    if (!action.onClick) {
      closeAlertModal();
      return;
    }
    setModalBusyIndex(idx);
    try {
      await action.onClick();
      closeAlertModal();
    } catch (err) {
      haptics.blocked();
      setModalBusyIndex(null);
      toast({
        kind: "error",
        title: "No se pudo completar la acción",
        description: err instanceof Error ? err.message : "Ocurrió un error inesperado.",
      });
    }
  };

  return (
    <FeedbackContext.Provider value={{ toast, showAlertModal, closeAlertModal }}>
      {children}

      {/* Floating pop-up toasts (always visible regardless of scroll position) */}
      {toasts.length > 0 && (
        <div
          aria-live="polite"
          className="pointer-events-none fixed inset-x-3 top-3 z-[70] flex flex-col items-end gap-2 sm:inset-x-auto sm:right-4 sm:top-4 sm:w-full sm:max-w-sm"
        >
          {toasts.map((item) => {
            const toneStyle =
              item.kind === "success"
                ? "border-success/45 bg-card/95 text-foreground shadow-success/10"
                : item.kind === "error"
                  ? "border-destructive/50 bg-card/95 text-foreground shadow-destructive/15"
                  : item.kind === "warning"
                    ? "border-warning/50 bg-card/95 text-foreground shadow-warning/15"
                    : "border-primary/45 bg-card/95 text-foreground shadow-primary/10";

            const iconNode =
              item.kind === "success" ? (
                <CheckCircle2 className="h-5 w-5 shrink-0 text-success" />
              ) : item.kind === "error" ? (
                <AlertCircle className="h-5 w-5 shrink-0 text-destructive" />
              ) : item.kind === "warning" ? (
                <AlertTriangle className="h-5 w-5 shrink-0 text-warning" />
              ) : (
                <Info className="h-5 w-5 shrink-0 text-primary" />
              );

            return (
              <div
                key={item.id}
                role="status"
                className={`pointer-events-auto flex w-full items-start gap-3 rounded-2xl border p-3.5 shadow-2xl backdrop-blur-md transition ${toneStyle}`}
              >
                <div className="mt-0.5">{iconNode}</div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold leading-snug">{item.title}</p>
                  {item.description && (
                    <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                      {item.description}
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  aria-label="Cerrar notificación"
                  onClick={() => dismissToast(item.id)}
                  className="press-response flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-secondary/70 text-muted-foreground hover:text-foreground"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Critical Alert & Confirmation Pop-up Modal */}
      {modal && (
        <div
          className="fixed inset-0 z-[80] flex items-end justify-center bg-black/75 p-0 backdrop-blur-sm sm:items-center sm:p-4"
          onClick={() => {
            if (modalBusyIndex === null) closeAlertModal();
          }}
        >
          <div
            className="material-thick safe-bottom w-full max-w-md overflow-hidden rounded-t-3xl border border-white/15 shadow-2xl sm:rounded-3xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3 border-b border-white/10 px-5 py-4">
              <div className="flex items-start gap-3">
                <div
                  className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${
                    modal.tone === "danger"
                      ? "bg-destructive/15 text-destructive"
                      : modal.tone === "info"
                        ? "bg-primary/15 text-primary"
                        : "bg-warning/15 text-warning"
                  }`}
                >
                  {modal.tone === "danger" ? (
                    <AlertCircle className="h-5 w-5" />
                  ) : modal.tone === "info" ? (
                    <Info className="h-5 w-5" />
                  ) : (
                    <AlertTriangle className="h-5 w-5" />
                  )}
                </div>
                <div className="min-w-0">
                  <h3 className="font-display text-base font-bold leading-snug text-foreground">
                    {modal.title}
                  </h3>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    {modal.description}
                  </p>
                </div>
              </div>
              <button
                type="button"
                disabled={modalBusyIndex !== null}
                onClick={closeAlertModal}
                className="press-response flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-secondary text-foreground disabled:opacity-40"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {modal.bulletItems && modal.bulletItems.length > 0 && (
              <div className="max-h-52 space-y-1.5 overflow-y-auto px-5 pt-4">
                {modal.bulletItems.map((line, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-2 rounded-xl border border-white/10 bg-background/60 px-3 py-2 text-xs font-medium text-foreground"
                  >
                    <span
                      className={`h-2 w-2 shrink-0 rounded-full ${
                        modal.tone === "danger" ? "bg-destructive" : "bg-warning"
                      }`}
                    />
                    <span className="min-w-0 flex-1">{line}</span>
                  </div>
                ))}
              </div>
            )}

            <div className="flex flex-col gap-2 p-5">
              {modal.actions.map((action, idx) => {
                const variantClass =
                  action.variant === "danger"
                    ? "bg-destructive text-white"
                    : action.variant === "warning"
                      ? "bg-warning text-primary-foreground"
                      : action.variant === "primary"
                        ? "bg-primary text-primary-foreground"
                        : "border border-white/15 bg-secondary text-foreground";
                const isThisBusy = modalBusyIndex === idx;
                return (
                  <button
                    key={idx}
                    type="button"
                    disabled={modalBusyIndex !== null}
                    onClick={() => void handleActionClick(action, idx)}
                    className={`press-response flex min-h-11 w-full items-center justify-center rounded-xl px-4 text-sm font-bold disabled:opacity-50 ${variantClass}`}
                  >
                    {isThisBusy ? "Procesando..." : action.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </FeedbackContext.Provider>
  );
}

export function useFeedback(): FeedbackContextValue {
  const ctx = useContext(FeedbackContext);
  if (!ctx) {
    throw new Error("useFeedback debe usarse dentro de FeedbackProvider");
  }
  return ctx;
}
