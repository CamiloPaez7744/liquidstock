import { Clock, Moon, Plus, Trash2 } from "lucide-react";
import type { OperatingScheduleSlot } from "@liquistock/domain";
import { haptics } from "../lib/haptics.js";

const ISO_DAYS: Array<{ id: number; short: string }> = [
  { id: 1, short: "L" },
  { id: 2, short: "M" },
  { id: 3, short: "X" },
  { id: 4, short: "J" },
  { id: 5, short: "V" },
  { id: 6, short: "S" },
  { id: 7, short: "D" },
];

export function ScheduleSlotsEditor({
  slots,
  onChange,
  disabled = false,
  title,
  hint,
}: {
  slots: OperatingScheduleSlot[];
  onChange: (next: OperatingScheduleSlot[]) => void;
  disabled?: boolean;
  title?: string;
  hint?: string;
}) {
  const addSlot = (preset?: OperatingScheduleSlot) => {
    haptics.tap();
    onChange([
      ...slots,
      preset ?? {
        daysOfWeek: [1, 2, 3, 4, 5],
        openTime: "16:00",
        closeTime: "23:30",
        validFrom: null,
        validUntil: null,
        label: "Horario regular",
      },
    ]);
  };

  const applyBarWeekendPreset = () => {
    haptics.tap();
    onChange([
      {
        daysOfWeek: [1, 2, 3, 4],
        openTime: "16:00",
        closeTime: "23:30",
        validFrom: null,
        validUntil: null,
        label: "Lunes a Jueves",
      },
      {
        daysOfWeek: [5, 6],
        openTime: "16:00",
        closeTime: "03:00",
        validFrom: null,
        validUntil: null,
        label: "Viernes y Sábado (Madrugada)",
      },
      {
        daysOfWeek: [7],
        openTime: "14:00",
        closeTime: "22:00",
        validFrom: null,
        validUntil: null,
        label: "Domingo",
      },
    ]);
  };

  const updateSlot = (idx: number, patch: Partial<OperatingScheduleSlot>) => {
    const next = slots.map((s, i) => (i === idx ? { ...s, ...patch } : s));
    onChange(next);
  };

  const toggleDay = (idx: number, day: number) => {
    const curr = slots[idx]?.daysOfWeek ?? [];
    const nextDays = curr.includes(day)
      ? curr.filter((d) => d !== day)
      : [...curr, day].sort((a, b) => a - b);
    updateSlot(idx, { daysOfWeek: nextDays.length > 0 ? nextDays : [day] });
  };

  const removeSlot = (idx: number) => {
    haptics.tap();
    onChange(slots.filter((_, i) => i !== idx));
  };

  return (
    <div className="space-y-3">
      {(title || hint) && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            {title && (
              <p className="flex items-center gap-1.5 text-sm font-bold text-foreground">
                <Clock className="h-4 w-4 text-primary" />
                {title}
              </p>
            )}
            {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
          </div>
          {!disabled && (
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={applyBarWeekendPreset}
                className="press-response rounded-xl bg-accent/15 px-3 py-1.5 text-[11px] font-bold text-accent ring-1 ring-accent/30"
              >
                Plantilla Bar (L-J + V-S madrugada)
              </button>
              <button
                type="button"
                onClick={() => addSlot()}
                className="press-response flex items-center gap-1 rounded-xl bg-primary/15 px-3 py-1.5 text-[11px] font-bold text-primary ring-1 ring-primary/30"
              >
                <Plus className="h-3.5 w-3.5" />
                Añadir franja
              </button>
            </div>
          )}
        </div>
      )}

      {slots.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/15 bg-background/40 p-3 text-xs text-muted-foreground">
          Sin horarios específicos configurados (abierto todos los días). Agrega franjas para
          diferenciar entre semana, fines de semana hasta la madrugada o fechas especiales.
        </div>
      ) : (
        <div className="space-y-2.5">
          {slots.map((slot, idx) => {
            const isOvernight = Boolean(slot.openTime && slot.closeTime && slot.openTime > slot.closeTime);
            return (
              <div
                key={idx}
                className="space-y-2.5 rounded-xl border border-white/10 bg-background/60 p-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <input
                    type="text"
                    disabled={disabled}
                    placeholder="Nombre de franja (ej. Fin de semana madrugada)"
                    value={slot.label ?? ""}
                    onChange={(e) => updateSlot(idx, { label: e.target.value })}
                    className="min-w-44 flex-1 rounded-lg border border-white/10 bg-card px-2.5 py-1.5 text-xs font-semibold text-foreground"
                  />
                  <div className="flex items-center gap-1.5">
                    {isOvernight && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-bold text-accent">
                        <Moon className="h-3 w-3" />
                        Madrugada (día sig.)
                      </span>
                    )}
                    {!disabled && (
                      <button
                        type="button"
                        title="Eliminar franja"
                        onClick={() => removeSlot(idx)}
                        className="press-response flex h-7 w-7 items-center justify-center rounded-lg bg-secondary text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <div className="flex items-center gap-1">
                    {ISO_DAYS.map((d) => {
                      const active = slot.daysOfWeek.includes(d.id);
                      return (
                        <button
                          key={d.id}
                          type="button"
                          disabled={disabled}
                          onClick={() => toggleDay(idx, d.id)}
                          className={`press-response flex h-8 w-8 items-center justify-center rounded-lg text-xs font-bold ${
                            active
                              ? "bg-primary text-primary-foreground"
                              : "bg-secondary/70 text-muted-foreground"
                          }`}
                        >
                          {d.short}
                        </button>
                      );
                    })}
                  </div>

                  <div className="flex items-center gap-1.5 text-xs">
                    <input
                      type="time"
                      disabled={disabled}
                      value={slot.openTime}
                      onChange={(e) => updateSlot(idx, { openTime: e.target.value })}
                      className="rounded-lg border border-white/15 bg-card px-2 py-1.5 font-mono text-xs"
                    />
                    <span className="text-muted-foreground">a</span>
                    <input
                      type="time"
                      disabled={disabled}
                      value={slot.closeTime}
                      onChange={(e) => updateSlot(idx, { closeTime: e.target.value })}
                      className="rounded-lg border border-white/15 bg-card px-2 py-1.5 font-mono text-xs"
                    />
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                    <span>Fechas (opc.):</span>
                    <input
                      type="date"
                      disabled={disabled}
                      value={slot.validFrom ?? ""}
                      onChange={(e) => updateSlot(idx, { validFrom: e.target.value || null })}
                      className="rounded-lg border border-white/10 bg-card px-2 py-1 text-[11px] text-foreground"
                    />
                    <span>–</span>
                    <input
                      type="date"
                      disabled={disabled}
                      value={slot.validUntil ?? ""}
                      onChange={(e) => updateSlot(idx, { validUntil: e.target.value || null })}
                      className="rounded-lg border border-white/10 bg-card px-2 py-1 text-[11px] text-foreground"
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
