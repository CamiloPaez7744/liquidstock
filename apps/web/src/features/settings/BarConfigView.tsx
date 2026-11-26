import { useState } from "react";
import {
  Clock,
  Eye,
  Lock,
  Pencil,
  Plus,
  RotateCcw,
  Shield,
  ShieldAlert,
  Sliders,
  Sparkles,
  Store,
  Trash2,
} from "lucide-react";
import {
  DEFAULT_BRANCH_ROLE_PERMISSIONS,
  resolveBranchRolePermissions,
  type AppModuleId,
  type BranchFeatureFlags,
  type ModuleAccessLevel,
  type OperatingScheduleSlot,
  type PromotionRule,
} from "@liquistock/domain";
import { ApiError, apiFetch } from "../../infrastructure/api/api-client.js";
import type { useLiquiStock } from "../../infrastructure/sync/useLiquiStock.js";
import { useFeedback } from "../../shared/components/FeedbackProvider.js";
import { ScheduleSlotsEditor } from "../../shared/components/ScheduleSlotsEditor.js";
import { formatCOP } from "../../shared/lib/format.js";
import { haptics } from "../../shared/lib/haptics.js";
import { NewPromotionModal } from "./NewPromotionModal.js";

type StoreType = ReturnType<typeof useLiquiStock>;
type ConfigTab = "rules" | "promos" | "allies" | "access";

const FLAG_LABELS: Array<{ key: keyof BranchFeatureFlags; label: string; desc: string }> = [
  {
    key: "enableFoamLossFormula",
    label: "Fórmula de merma por espuma y purga",
    desc: "Descuenta automáticamente % de espuma + ml de purga en barriles y shots.",
  },
  {
    key: "autoHideClosedAllies",
    label: "Ocultar combos de aliados al cerrar",
    desc: "Cuando un local aliado pasa su hora de cierre, sus productos desaparecen del POS.",
  },
  {
    key: "hideOutOfStockInPos",
    label: "Ocultar presentaciones agotadas",
    desc: "Activo: las oculta. Desactivado: las muestra bloqueadas como 'Agotado'.",
  },
  {
    key: "enableSplitAccounts",
    label: "División de cuentas en mesas",
    desc: "Permite crear sub-cuentas independientes y mover ítems entre ellas.",
  },
  {
    key: "enableCreditAccounts",
    label: "Control de Fiado (Lista Blanca / Negra)",
    desc: "Activa venta a crédito con cupo máximo y bloqueo de Lista Negra.",
  },
  {
    key: "enablePromotions",
    label: "Motor de promociones automáticas",
    desc: "Aplica reglas 2x1 y Happy Hour configuradas por esta sucursal.",
  },
];

const MODULE_META: Array<{ id: AppModuleId; label: string; desc: string }> = [
  { id: "pos", label: "Mesas & POS", desc: "Tomar pedidos, dividir cuentas y cobrar" },
  {
    id: "inventory",
    label: "Stock y Carta",
    desc: "Inventario, compras, precios, fotos y combos",
  },
  { id: "cash", label: "Caja & Turno", desc: "Abrir/cerrar turno, gastos del turno y cartera" },
  {
    id: "finance",
    label: "Ingresos y Egresos",
    desc: "Libro financiero editable, saldos por cuenta y Bodega",
  },
  { id: "kpis", label: "KPIs", desc: "Métricas de ventas, alertas inteligentes y auditoría" },
  {
    id: "settings",
    label: "Config Bar",
    desc: "Reglas del bar, horarios, promociones, aliados y clientes",
  },
  { id: "users", label: "Mi Bar & Equipo", desc: "Perfil del bar, mesas, medios de pago y equipo" },
];

const CONFIGURABLE_ROLES: Array<{ id: "cashier" | "waiter"; label: string; hint: string }> = [
  { id: "cashier", label: "Cajero", hint: "Personal de caja y cobros" },
  { id: "waiter", label: "Mesero", hint: "Personal de salón y barra" },
];

export function BarConfigView({
  store,
  branchId,
  canEdit = true,
  isAdmin = true,
  onGoToPos,
}: {
  store: StoreType;
  branchId: string;
  canEdit?: boolean;
  isAdmin?: boolean;
  onGoToPos?: () => void;
}) {
  const { toast, showAlertModal } = useFeedback();
  const [activeTab, setActiveTab] = useState<ConfigTab>("rules");
  const [selectedPermRole, setSelectedPermRole] = useState<"cashier" | "waiter">("cashier");
  const [showPromoModal, setShowPromoModal] = useState(false);
  const [editingPromo, setEditingPromo] = useState<PromotionRule | null>(null);
  const [confirmDeletePromoId, setConfirmDeletePromoId] = useState<string | null>(null);

  // Nuevo aliado
  const [allyName, setAllyName] = useState("");
  const [allyOpen, setAllyOpen] = useState("17:00");
  const [allyClose, setAllyClose] = useState("23:30");
  const [editingAllySchedulesId, setEditingAllySchedulesId] = useState<string | null>(null);
  const [allyScheduleDraft, setAllyScheduleDraft] = useState<OperatingScheduleSlot[]>([]);

  // Horarios del local (sucursal)
  const [branchSchedulesDraft, setBranchSchedulesDraft] = useState<OperatingScheduleSlot[] | null>(
    null,
  );
  const currentBranchSchedules = branchSchedulesDraft ?? store.branch?.operatingSchedules ?? [];

  // Nuevo cliente
  const [custName, setCustName] = useState("");
  const [custStatus, setCustStatus] = useState<
    "whitelist_credit" | "standard" | "blacklist_blocked"
  >("whitelist_credit");
  const [custLimit, setCustLimit] = useState("150000");

  const [saving, setSaving] = useState(false);

  const notify = (kind: "ok" | "err", text: string) => {
    toast({
      kind: kind === "ok" ? "success" : "error",
      title: kind === "ok" ? "Cambio guardado" : "Atención",
      description: text,
    });
  };

  const runAction = async (label: string, fn: () => Promise<void>) => {
    setSaving(true);
    try {
      await fn();
      haptics.success();
      await store.refresh();
      notify("ok", label);
    } catch (err) {
      haptics.blocked();
      notify("err", err instanceof Error ? err.message : "No se pudo guardar el cambio");
    } finally {
      setSaving(false);
    }
  };

  const toggleFlag = async (key: keyof BranchFeatureFlags) => {
    const nextValue = !store.featureFlags[key];
    setSaving(true);
    try {
      await apiFetch(`/api/v1/branches/${branchId}/settings`, {
        method: "PATCH",
        body: JSON.stringify({ [key]: nextValue }),
      });
      haptics.success();
      await store.refresh();
      notify("ok", `Módulo actualizado (${nextValue ? "ACTIVO" : "OFF"})`);
    } catch (err) {
      haptics.blocked();
      if (err instanceof ApiError && err.code === "SPLIT_ACCOUNTS_OPEN") {
        const affected = (err.details?.affectedTables ?? []) as Array<{
          tableLabel: string;
          openSubAccountsCount: number;
          pendingTotal: number;
          secondaryHavePayments: boolean;
        }>;
        const canAutoConsolidate = Boolean(err.details?.canAutoConsolidate);

        showAlertModal({
          tone: "warning",
          title: "Hay mesas con cuentas divididas abiertas",
          description: canAutoConsolidate
            ? "Para cambiar a modo «Solo mesa» (una cuenta por mesa), primero debes cerrar o unificar las sub-cuentas abiertas."
            : "Algunas sub-cuentas secundarias ya tienen abonos o fiado registrados. Debes finalizar su cobro en Mesas & POS antes de cambiar a modo solo mesa.",
          bulletItems: affected.map(
            (t) =>
              `${t.tableLabel}: ${t.openSubAccountsCount} cuentas abiertas · Saldo ${formatCOP(t.pendingTotal)}${t.secondaryHavePayments ? " (con abonos)" : ""}`,
          ),
          actions: [
            ...(canAutoConsolidate
              ? [
                  {
                    label: "Unificar en Cuenta 1 y pasar a solo mesa",
                    variant: "warning" as const,
                    onClick: async () => {
                      await apiFetch(
                        `/api/v1/branches/${branchId}/settings/consolidate-and-disable-splits`,
                        { method: "POST" },
                      );
                      haptics.success();
                      await store.refresh();
                      toast({
                        kind: "success",
                        title: "Modo solo mesa activado",
                        description:
                          "Se unificaron las cuentas divididas en la cuenta principal de cada mesa.",
                      });
                    },
                  },
                ]
              : []),
            ...(onGoToPos
              ? [
                  {
                    label: "Ir a Mesas & POS",
                    variant: "primary" as const,
                    onClick: () => {
                      onGoToPos();
                    },
                  },
                ]
              : []),
            { label: "Cancelar", variant: "secondary" },
          ],
        });
      } else {
        notify("err", err instanceof Error ? err.message : "No se pudo guardar el cambio");
      }
    } finally {
      setSaving(false);
    }
  };

  const handleCreateAlly = () => {
    if (!allyName.trim()) return;
    void runAction(`Aliado "${allyName.trim()}" creado`, async () => {
      await apiFetch(`/api/v1/branches/${branchId}/allies`, {
        method: "POST",
        body: JSON.stringify({
          name: allyName.trim(),
          openTime: allyOpen,
          closeTime: allyClose,
        }),
      });
      setAllyName("");
    });
  };

  const handleCreateCustomer = () => {
    if (!custName.trim()) return;
    void runAction(`Cliente "${custName.trim()}" registrado`, async () => {
      await apiFetch(`/api/v1/branches/${branchId}/customers`, {
        method: "POST",
        body: JSON.stringify({
          fullName: custName.trim(),
          creditStatus: custStatus,
          creditLimit: custStatus === "whitelist_credit" ? Number(custLimit) || 0 : null,
        }),
      });
      setCustName("");
    });
  };

  const resolvedRolePermissions = resolveBranchRolePermissions(store.branch?.rolePermissions);

  const handleUpdateRolePermission = async (
    roleId: "cashier" | "waiter",
    moduleId: AppModuleId,
    level: ModuleAccessLevel,
  ) => {
    if (!isAdmin || saving) return;
    const roleLabel = roleId === "cashier" ? "Cajero" : "Mesero";
    const modLabel = MODULE_META.find((m) => m.id === moduleId)?.label ?? moduleId;
    const levelLabel =
      level === "edit" ? "Editor" : level === "view" ? "Solo vista" : "Sin acceso";
    await runAction(`${roleLabel} → ${modLabel}: ${levelLabel}`, async () => {
      await apiFetch(`/api/v1/branches/${branchId}/role-permissions`, {
        method: "PATCH",
        body: JSON.stringify({ [roleId]: { [moduleId]: level } }),
      });
    });
  };

  const handleResetRolePermissions = async () => {
    if (!isAdmin || saving) return;
    await runAction("Permisos por rol restablecidos a valores por defecto", async () => {
      await apiFetch(`/api/v1/branches/${branchId}/role-permissions`, {
        method: "PATCH",
        body: JSON.stringify({
          cashier: DEFAULT_BRANCH_ROLE_PERMISSIONS.cashier,
          waiter: DEFAULT_BRANCH_ROLE_PERMISSIONS.waiter,
        }),
      });
    });
  };

  return (
    <div className="space-y-4">
      {/* Cabecera minimalista con 4 tabs */}
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <div>
          <h2 className="font-display text-lg font-bold">Configuración del Bar</h2>
          <p className="text-xs text-muted-foreground">
            Reglas operativas, horarios, promociones, aliados y permisos. (Precios y combos ahora viven en <strong>Stock y Carta</strong>.)
          </p>
        </div>

        <div className="no-scrollbar flex max-w-full overflow-x-auto rounded-2xl border border-white/10 bg-secondary/60 p-1">
          {(
            [
              { id: "rules", label: "Reglas y Horarios", icon: Sliders },
              {
                id: "promos",
                label: "Promociones",
                icon: Sparkles,
                count: store.promotionRules.length,
              },
              { id: "allies", label: "Aliados", icon: Store, count: store.allies.length },
              { id: "access", label: "Permisos y Clientes", icon: Shield },
            ] as Array<{ id: ConfigTab; label: string; icon: typeof Sliders; count?: number }>
          ).map(({ id, label, icon: TabIcon, count }) => {
            const active = activeTab === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => {
                  haptics.tap();
                  setActiveTab(id);
                }}
                className={`press-response flex min-h-9 shrink-0 items-center gap-1.5 rounded-xl px-3 text-xs font-bold transition ${
                  active
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <TabIcon className="h-3.5 w-3.5" />
                <span>{label}</span>
                {count !== undefined && (
                  <span
                    className={`rounded-full px-1.5 py-0.5 text-[10px] tabular-nums ${
                      active
                        ? "bg-black/20 text-primary-foreground"
                        : "bg-background/70 text-muted-foreground"
                    }`}
                  >
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {!canEdit && (
        <div className="flex items-center gap-2 rounded-2xl border border-warning/35 bg-warning/10 px-4 py-3 text-xs font-semibold text-warning">
          <Eye className="h-4 w-4 shrink-0" />
          <span>
            Modo solo vista: puedes consultar la configuración del bar pero no realizar cambios.
          </span>
        </div>
      )}

      <fieldset disabled={!canEdit} className="space-y-5">
        {/* TAB 1: REGLAS Y HORARIOS */}
        {activeTab === "rules" && (
          <>
            <section className="solid-card rounded-2xl p-5">
              <div className="mb-3 flex items-center gap-2">
                <Sliders className="h-5 w-5 text-primary" />
                <div>
                  <h3 className="font-display text-base font-bold">
                    Reglas Activas de Esta Sucursal
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    Toca cualquier tarjeta para activar o desactivar esa función en tiempo real.
                  </p>
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {FLAG_LABELS.map(({ key, label, desc }) => {
                  const enabled = store.featureFlags[key];
                  return (
                    <button
                      key={key}
                      type="button"
                      disabled={saving}
                      onClick={() => void toggleFlag(key)}
                      className={`press-response flex flex-col justify-between rounded-xl border p-3.5 text-left ${
                        enabled
                          ? "border-primary/40 bg-primary/10"
                          : "border-white/10 bg-background/50 opacity-75"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-bold">{label}</span>
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                            enabled
                              ? "bg-success/20 text-success"
                              : "bg-secondary text-muted-foreground"
                          }`}
                        >
                          {enabled ? "ACTIVO" : "OFF"}
                        </span>
                      </div>
                      <p className="mt-1.5 text-xs text-muted-foreground">{desc}</p>
                    </button>
                  );
                })}
              </div>
            </section>

            <section className="solid-card space-y-4 rounded-2xl p-5">
              <ScheduleSlotsEditor
                slots={currentBranchSchedules}
                onChange={setBranchSchedulesDraft}
                disabled={!canEdit}
                title="Horarios y Fechas de Funcionamiento del Local"
                hint="Configura múltiples franjas (ej. Lunes a Jueves hasta 11:30 p.m., Viernes y Sábado hasta las 3:00 a.m. o fechas especiales)."
              />
              {canEdit && (
                <div className="flex justify-end">
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() =>
                      void runAction("Horarios del local guardados", async () => {
                        await apiFetch(`/api/v1/branches/${branchId}/operating-schedules`, {
                          method: "PATCH",
                          body: JSON.stringify({ operatingSchedules: currentBranchSchedules }),
                        });
                        setBranchSchedulesDraft(null);
                      })
                    }
                    className="press-response rounded-xl bg-primary px-4 py-2.5 text-xs font-bold text-primary-foreground"
                  >
                    Guardar Horarios del Local
                  </button>
                </div>
              )}
            </section>
          </>
        )}

        {/* TAB 2: PROMOCIONES */}
        {activeTab === "promos" && (
          <section className="solid-card space-y-4 rounded-2xl p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Sparkles className="h-5 w-5 text-success" />
                <div>
                  <h3 className="font-display text-base font-bold">Promociones de la Sucursal</h3>
                  <p className="text-xs text-muted-foreground">
                    Reglas automáticas (2x1, Happy Hour, descuentos por horario) o manuales al cobrar.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  haptics.tap();
                  setEditingPromo(null);
                  setShowPromoModal(true);
                }}
                className="press-response flex min-h-10 items-center gap-1.5 rounded-xl bg-success px-3.5 text-xs font-bold text-primary-foreground"
              >
                <Plus className="h-4 w-4" />
                Nueva Promo
              </button>
            </div>

            {store.promotionRules.length === 0 ? (
              <p className="rounded-xl border border-dashed border-white/10 p-6 text-center text-xs text-muted-foreground">
                Aún no tienes promociones creadas. Crea una regla 2x1, Happy Hour o descuento especial.
              </p>
            ) : (
              <div className="space-y-2.5">
                {store.promotionRules.map((rule) => {
                  const modeLabel =
                    rule.applicationMode === "manual_at_checkout"
                      ? "Manual al cobrar"
                      : "Automática";
                  const mechanic =
                    rule.ruleType === "bxgy"
                      ? `Lleva ${rule.config.buyQty ?? 2} · Paga ${rule.config.payQty ?? 1}`
                      : rule.ruleType === "percentage_discount"
                        ? `-${rule.config.percent ?? 0}%${(rule.config.minQuantity ?? 1) > 1 ? ` (desde ${rule.config.minQuantity}+)` : ""}`
                        : rule.ruleType === "fixed_discount"
                          ? `-${formatCOP(rule.config.fixedAmount ?? 0)}/und`
                          : `Precio fijo ${formatCOP(rule.config.fixedUnitPrice ?? 0)}`;
                  const scopeTargetLabel =
                    rule.scopeType === "category"
                      ? (store.categories.find((c) => c.id === rule.targetId)?.name ?? "Categoría")
                      : rule.scopeType === "product"
                        ? (store.menuProducts.find((p) => p.id === rule.targetId)?.name ??
                          "Producto")
                        : rule.scopeType === "presentation"
                          ? (() => {
                              const pr = store.presentations.find((x) => x.id === rule.targetId);
                              const prod = pr
                                ? store.menuProducts.find((p) => p.id === pr.menuProductId)
                                : null;
                              return pr ? `${prod?.name ?? ""} · ${pr.name}`.trim() : "Presentación";
                            })()
                          : "Toda la carta";
                  const groupFilterLabel =
                    rule.config.presentationGroups && rule.config.presentationGroups.length > 0
                      ? `Solo: ${rule.config.presentationGroups.join(", ")}`
                      : null;
                  return (
                    <div
                      key={rule.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/10 bg-background/50 p-3.5"
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <p className="text-sm font-bold">{rule.name}</p>
                          <span
                            className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                              rule.applicationMode === "manual_at_checkout"
                                ? "bg-accent/20 text-accent"
                                : "bg-primary/15 text-primary"
                            }`}
                          >
                            {modeLabel}
                          </span>
                          {groupFilterLabel && (
                            <span className="rounded-full bg-success/15 px-2 py-0.5 text-[10px] font-bold capitalize text-success">
                              {groupFilterLabel}
                            </span>
                          )}
                        </div>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {scopeTargetLabel} · {mechanic} · {rule.startTime ?? "00:00"}–
                          {rule.endTime ?? "23:59"}
                          {rule.validFrom || rule.validUntil
                            ? ` · ${rule.validFrom ?? "…"} a ${rule.validUntil ?? "…"}`
                            : ""}
                        </p>
                      </div>
                      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                        <button
                          type="button"
                          disabled={saving}
                          onClick={() =>
                            void runAction(
                              `Promoción ${!rule.isActive ? "activada" : "desactivada"}`,
                              async () => {
                                await apiFetch(
                                  `/api/v1/branches/${branchId}/promotions/${rule.id}`,
                                  {
                                    method: "PATCH",
                                    body: JSON.stringify({ isActive: !rule.isActive }),
                                  },
                                );
                              },
                            )
                          }
                          className={`press-response rounded-xl px-3 py-1.5 text-xs font-bold ${
                            rule.isActive
                              ? "bg-success/20 text-success"
                              : "bg-secondary text-muted-foreground"
                          }`}
                        >
                          {rule.isActive ? "ACTIVA" : "INACTIVA"}
                        </button>

                        <button
                          type="button"
                          disabled={saving}
                          title="Editar promoción"
                          onClick={() => {
                            haptics.tap();
                            setEditingPromo(rule);
                            setShowPromoModal(true);
                          }}
                          className="press-response flex h-9 w-9 items-center justify-center rounded-xl bg-secondary text-foreground"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>

                        {confirmDeletePromoId === rule.id ? (
                          <button
                            type="button"
                            disabled={saving}
                            onClick={() =>
                              void runAction(`Promoción "${rule.name}" eliminada`, async () => {
                                await apiFetch(
                                  `/api/v1/branches/${branchId}/promotions/${rule.id}`,
                                  {
                                    method: "DELETE",
                                  },
                                );
                                setConfirmDeletePromoId(null);
                              })
                            }
                            className="press-response rounded-xl bg-destructive px-2.5 py-1.5 text-xs font-bold text-white"
                          >
                            ¿Eliminar?
                          </button>
                        ) : (
                          <button
                            type="button"
                            disabled={saving}
                            title="Eliminar promoción"
                            onClick={() => {
                              haptics.tap();
                              setConfirmDeletePromoId(rule.id);
                            }}
                            className="press-response flex h-9 w-9 items-center justify-center rounded-xl bg-destructive/15 text-destructive"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        )}

        {/* TAB 3: ALIADOS */}
        {activeTab === "allies" && (
          <section className="solid-card space-y-4 rounded-2xl p-5">
            <div className="flex items-center gap-2">
              <Store className="h-5 w-5 text-warning" />
              <div>
                <h3 className="font-display text-base font-bold">
                  Locales Aliados y Horarios de Atención
                </h3>
                <p className="text-xs text-muted-foreground">
                  Cuando un aliado cierra o se marca cerrado, sus combos (configurados en Stock y Carta) se ocultan automáticamente del POS.
                </p>
              </div>
            </div>

            <div className="space-y-3">
              {store.allies.length === 0 && (
                <p className="rounded-xl border border-dashed border-white/10 p-4 text-center text-xs text-muted-foreground">
                  Aún no has agregado locales aliados. Registra uno abajo si vendes comida de un vecino o combos mixtos.
                </p>
              )}
              {store.allies.map((ally) => {
                const isEditingSched = editingAllySchedulesId === ally.id;
                const slotCount = ally.operatingSchedules?.length ?? 0;
                return (
                  <div
                    key={ally.id}
                    className="space-y-2.5 rounded-xl border border-white/10 bg-background/50 p-3.5"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="font-bold">{ally.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {slotCount > 0
                            ? `${slotCount} franja(s) horaria(s) configurada(s)`
                            : `Horario simple: ${ally.operatingSchedule?.openTime ?? "00:00"} – ${ally.operatingSchedule?.closeTime ?? "23:59"}`}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            haptics.tap();
                            if (isEditingSched) {
                              setEditingAllySchedulesId(null);
                            } else {
                              setEditingAllySchedulesId(ally.id);
                              setAllyScheduleDraft(
                                ally.operatingSchedules && ally.operatingSchedules.length > 0
                                  ? ally.operatingSchedules
                                  : [
                                      {
                                        daysOfWeek: ally.operatingSchedule?.daysOfWeek ?? [
                                          1, 2, 3, 4, 5, 6, 7,
                                        ],
                                        openTime: ally.operatingSchedule?.openTime ?? "17:00",
                                        closeTime: ally.operatingSchedule?.closeTime ?? "23:30",
                                        label: "Horario regular",
                                      },
                                    ],
                              );
                            }
                          }}
                          className="press-response flex items-center gap-1 rounded-xl bg-secondary px-3 py-2 text-xs font-bold text-primary"
                        >
                          <Clock className="h-3.5 w-3.5" />
                          {isEditingSched ? "Ocultar horarios" : "Horarios / Madrugadas"}
                        </button>
                        <button
                          type="button"
                          disabled={saving}
                          onClick={() =>
                            void runAction(
                              ally.isTemporarilyClosed
                                ? `${ally.name} ahora está ABIERTO`
                                : `${ally.name} marcado CERRADO (oculto en POS)`,
                              async () => {
                                await apiFetch(`/api/v1/branches/${branchId}/allies/${ally.id}`, {
                                  method: "PATCH",
                                  body: JSON.stringify({
                                    isTemporarilyClosed: !ally.isTemporarilyClosed,
                                  }),
                                });
                              },
                            )
                          }
                          className={`press-response rounded-xl px-3.5 py-2 text-xs font-bold ${
                            ally.isTemporarilyClosed
                              ? "bg-destructive text-white"
                              : "bg-success/20 text-success"
                          }`}
                        >
                          {ally.isTemporarilyClosed
                            ? "CERRADO (Oculto en POS)"
                            : "ABIERTO (Visible)"}
                        </button>
                      </div>
                    </div>

                    {isEditingSched && (
                      <div className="space-y-2.5 border-t border-white/10 pt-3">
                        <ScheduleSlotsEditor
                          slots={allyScheduleDraft}
                          onChange={setAllyScheduleDraft}
                          disabled={!canEdit}
                          title={`Franjas horarias de ${ally.name}`}
                          hint="Soporta horarios distintos entre semana, madrugadas de fin de semana y fechas especiales."
                        />
                        <div className="flex justify-end">
                          <button
                            type="button"
                            disabled={saving}
                            onClick={() =>
                              void runAction(`Horarios de ${ally.name} guardados`, async () => {
                                await apiFetch(`/api/v1/branches/${branchId}/allies/${ally.id}`, {
                                  method: "PATCH",
                                  body: JSON.stringify({ operatingSchedules: allyScheduleDraft }),
                                });
                                setEditingAllySchedulesId(null);
                              })
                            }
                            className="press-response rounded-xl bg-primary px-4 py-2 text-xs font-bold text-primary-foreground"
                          >
                            Guardar Horarios del Aliado
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-warning/20 bg-warning/5 p-3">
              <input
                type="text"
                placeholder="Nuevo aliado (ej. Salchipapas Don Lucho)"
                value={allyName}
                onChange={(e) => setAllyName(e.target.value)}
                className="min-w-52 flex-1 rounded-xl border border-white/15 bg-background px-3 py-2 text-xs"
              />
              <input
                type="time"
                value={allyOpen}
                onChange={(e) => setAllyOpen(e.target.value)}
                className="rounded-xl border border-white/15 bg-background px-2 py-2 text-xs"
              />
              <span className="text-xs text-muted-foreground">a</span>
              <input
                type="time"
                value={allyClose}
                onChange={(e) => setAllyClose(e.target.value)}
                className="rounded-xl border border-white/15 bg-background px-2 py-2 text-xs"
              />
              <button
                type="button"
                disabled={saving || !allyName.trim()}
                onClick={handleCreateAlly}
                className="press-response rounded-xl bg-warning px-4 py-2 text-xs font-bold text-primary-foreground disabled:opacity-50"
              >
                + Agregar Aliado
              </button>
            </div>
          </section>
        )}

        {/* TAB 4: PERMISOS Y CLIENTES */}
        {activeTab === "access" && (
          <div className="space-y-5">
            {isAdmin && (
              <section className="solid-card space-y-4 rounded-2xl border-primary/25 p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex items-center gap-2.5">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
                      <Shield className="h-5 w-5" />
                    </div>
                    <div>
                      <h3 className="font-display text-base font-bold">
                        Permisos de Módulos por Rol
                      </h3>
                      <p className="text-xs text-muted-foreground">
                        Define qué módulos puede ver o editar cada rol. El{" "}
                        <strong>Administrador</strong> siempre mantiene acceso total y el cuadre de stock con contraseña.
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void handleResetRolePermissions()}
                    className="press-response flex min-h-9 items-center gap-1.5 rounded-xl bg-secondary px-3 text-xs font-semibold text-muted-foreground hover:text-foreground disabled:opacity-50"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    Restablecer
                  </button>
                </div>

                <div className="flex flex-wrap gap-2">
                  {CONFIGURABLE_ROLES.map((r) => {
                    const active = selectedPermRole === r.id;
                    return (
                      <button
                        key={r.id}
                        type="button"
                        onClick={() => {
                          haptics.tap();
                          setSelectedPermRole(r.id);
                        }}
                        className={`press-response flex min-h-11 items-center gap-2 rounded-xl border px-4 text-left text-xs transition ${
                          active
                            ? "border-primary bg-primary/15 text-foreground"
                            : "border-white/10 bg-background/50 text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        <div>
                          <p className="font-bold">{r.label}</p>
                          <p className="text-[10px] opacity-80">{r.hint}</p>
                        </div>
                      </button>
                    );
                  })}
                </div>

                <div className="grid gap-2.5 sm:grid-cols-2">
                  {MODULE_META.map((mod) => {
                    const currentLevel = resolvedRolePermissions[selectedPermRole][mod.id];
                    return (
                      <div
                        key={mod.id}
                        className="flex flex-col justify-between gap-2.5 rounded-xl border border-white/10 bg-background/55 p-3.5"
                      >
                        <div>
                          <p className="text-sm font-bold text-foreground">{mod.label}</p>
                          <p className="text-[11px] text-muted-foreground">{mod.desc}</p>
                        </div>

                        <div className="grid grid-cols-3 gap-1.5">
                          {(
                            [
                              {
                                id: "none",
                                label: "Sin acceso",
                                icon: Lock,
                                activeClass:
                                  "border-destructive/50 bg-destructive/15 text-destructive",
                              },
                              {
                                id: "view",
                                label: "Solo vista",
                                icon: Eye,
                                activeClass: "border-warning/55 bg-warning/15 text-warning",
                              },
                              {
                                id: "edit",
                                label: "Editor",
                                icon: Pencil,
                                activeClass: "border-success/55 bg-success/18 text-success",
                              },
                            ] as const
                          ).map(({ id, label, icon: LevelIcon, activeClass }) => {
                            const active = currentLevel === id;
                            return (
                              <button
                                key={id}
                                type="button"
                                disabled={saving}
                                onClick={() =>
                                  void handleUpdateRolePermission(selectedPermRole, mod.id, id)
                                }
                                className={`press-response flex min-h-9 items-center justify-center gap-1 rounded-lg border px-2 text-[11px] font-bold transition disabled:opacity-50 ${
                                  active
                                    ? activeClass
                                    : "border-white/10 bg-secondary/50 text-muted-foreground hover:text-foreground"
                                }`}
                              >
                                <LevelIcon className="h-3 w-3 shrink-0" />
                                <span className="truncate">{label}</span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            <section className="solid-card space-y-3 rounded-2xl p-5">
              <div className="flex items-center gap-2">
                <ShieldAlert className="h-5 w-5 text-accent" />
                <div>
                  <h3 className="font-display text-base font-bold">
                    Clientes: Lista Blanca / Lista Negra
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    Administra cupos de fiado autorizados o clientes bloqueados.
                  </p>
                </div>
              </div>

              {store.customers.length === 0 ? (
                <p className="rounded-xl border border-dashed border-white/10 p-4 text-center text-xs text-muted-foreground">
                  No hay clientes registrados aún.
                </p>
              ) : (
                <div className="grid gap-2.5 sm:grid-cols-2">
                  {store.customers.map((c) => (
                    <div
                      key={c.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/10 bg-background/50 p-3"
                    >
                      <div>
                        <p className="text-sm font-bold">{c.fullName}</p>
                        <p className="text-xs tabular-nums text-muted-foreground">
                          Deuda: {formatCOP(c.currentDebt)}
                          {c.creditLimit ? ` · Cupo: ${formatCOP(c.creditLimit)}` : ""}
                        </p>
                      </div>
                      <select
                        value={c.creditStatus}
                        onChange={(e) =>
                          void runAction(`Estado de ${c.fullName} actualizado`, async () => {
                            await apiFetch(`/api/v1/branches/${branchId}/customers/${c.id}`, {
                              method: "PATCH",
                              body: JSON.stringify({
                                creditStatus: e.target.value as
                                  | "standard"
                                  | "whitelist_credit"
                                  | "blacklist_blocked",
                              }),
                            });
                          })
                        }
                        className="rounded-xl border border-white/15 bg-card px-2.5 py-1.5 text-xs font-bold"
                      >
                        <option value="whitelist_credit">Lista Blanca (Fiado)</option>
                        <option value="standard">Estándar</option>
                        <option value="blacklist_blocked">Lista Negra (Bloqueado)</option>
                      </select>
                    </div>
                  ))}
                </div>
              )}

              <div className="flex flex-wrap gap-2 rounded-xl border border-accent/20 bg-accent/5 p-3">
                <input
                  type="text"
                  placeholder="Nuevo cliente..."
                  value={custName}
                  onChange={(e) => setCustName(e.target.value)}
                  className="min-w-40 flex-1 rounded-xl border border-white/15 bg-background px-3 py-1.5 text-xs"
                />
                <select
                  value={custStatus}
                  onChange={(e) =>
                    setCustStatus(
                      e.target.value as "whitelist_credit" | "standard" | "blacklist_blocked",
                    )
                  }
                  className="rounded-xl border border-white/15 bg-background px-2 py-1.5 text-xs"
                >
                  <option value="whitelist_credit">Lista Blanca</option>
                  <option value="standard">Estándar</option>
                  <option value="blacklist_blocked">Lista Negra</option>
                </select>
                {custStatus === "whitelist_credit" && (
                  <input
                    type="number"
                    placeholder="Cupo"
                    value={custLimit}
                    onChange={(e) => setCustLimit(e.target.value)}
                    className="w-28 rounded-xl border border-white/15 bg-background px-2 py-1.5 text-xs tabular-nums"
                  />
                )}
                <button
                  type="button"
                  disabled={saving || !custName.trim()}
                  onClick={handleCreateCustomer}
                  className="press-response rounded-xl bg-accent px-3.5 py-1.5 text-xs font-bold text-white disabled:opacity-50"
                >
                  + Agregar
                </button>
              </div>
            </section>
          </div>
        )}
      </fieldset>

      {showPromoModal && (
        <NewPromotionModal
          branchId={branchId}
          categories={store.categories}
          products={store.menuProducts}
          presentations={store.presentations}
          editingRule={editingPromo}
          onClose={() => {
            setShowPromoModal(false);
            setEditingPromo(null);
          }}
          onCreated={async () => {
            await store.refresh();
            notify("ok", editingPromo ? "Promoción actualizada" : "Promoción creada y activa");
          }}
        />
      )}
    </div>
  );
}
