import { useState } from "react";
import {
  Clock,
  ImagePlus,
  Layers,
  Pencil,
  Plus,
  ShieldAlert,
  Sliders,
  Sparkles,
  Trash2,
} from "lucide-react";
import type {
  BranchFeatureFlags,
  DisplayUnit,
  PresentationGroup,
  PromotionRule,
} from "@liquistock/domain";
import { ApiError, apiFetch } from "../../infrastructure/api/api-client.js";
import type { useLiquiStock } from "../../infrastructure/sync/useLiquiStock.js";
import { useFeedback } from "../../shared/components/FeedbackProvider.js";
import { ProductVisualAvatar } from "../../shared/components/ProductTypeIcon.js";
import { formatCOP } from "../../shared/lib/format.js";
import { haptics } from "../../shared/lib/haptics.js";
import { NewComboModal } from "./NewComboModal.js";
import { NewPromotionModal } from "./NewPromotionModal.js";

type StoreType = ReturnType<typeof useLiquiStock>;

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

export function BarConfigView({
  store,
  branchId,
  onGoToPos,
}: {
  store: StoreType;
  branchId: string;
  onGoToPos?: () => void;
}) {
  const { toast, showAlertModal } = useFeedback();
  const [showComboModal, setShowComboModal] = useState(false);
  const [showPromoModal, setShowPromoModal] = useState(false);
  const [editingPromo, setEditingPromo] = useState<PromotionRule | null>(null);
  const [confirmDeletePromoId, setConfirmDeletePromoId] = useState<string | null>(null);
  const [uploadingProductId, setUploadingProductId] = useState<string | null>(null);

  // Nueva presentación en producto existente
  const [newPresProductId, setNewPresProductId] = useState("");
  const [newPresName, setNewPresName] = useState("Jirafa 5 Litros");
  const [newPresGroup, setNewPresGroup] = useState<PresentationGroup>("jirafa");
  const [newPresPrice, setNewPresPrice] = useState("115000");
  const [newPresInvId, setNewPresInvId] = useState("");
  const [newPresUnit, setNewPresUnit] = useState<DisplayUnit>("L");
  const [newPresQty, setNewPresQty] = useState("5");
  const [newPresFoamPct, setNewPresFoamPct] = useState("3");
  const [newPresPurgeMl, setNewPresPurgeMl] = useState("30");

  // Nuevo aliado
  const [allyName, setAllyName] = useState("");
  const [allyOpen, setAllyOpen] = useState("17:00");
  const [allyClose, setAllyClose] = useState("23:30");

  // Nuevo cliente
  const [custName, setCustName] = useState("");
  const [custStatus, setCustStatus] = useState<"whitelist_credit" | "standard" | "blacklist_blocked">(
    "whitelist_credit",
  );
  const [custLimit, setCustLimit] = useState("150000");

  const [saving, setSaving] = useState(false);

  const effectivePresProductId = newPresProductId || store.menuProducts[0]?.id || "";
  const effectivePresInvId = newPresInvId || store.inventoryItems[0]?.id || "";
  const selectedPresInv = store.inventoryItems.find((i) => i.id === effectivePresInvId);
  const selectedPresSupportsFoam = Boolean(
    selectedPresInv && (selectedPresInv.isKeg || selectedPresInv.baseUnit === "ml"),
  );

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

  const handleUploadImage = async (productId: string, file: File) => {
    setUploadingProductId(productId);
    try {
      const form = new FormData();
      form.append("file", file);
      const uploaded = await apiFetch<{ imageUrl: string }>("/api/v1/uploads/image", {
        method: "POST",
        body: form,
      });
      await apiFetch(`/api/v1/branches/${branchId}/products/${productId}`, {
        method: "PATCH",
        body: JSON.stringify({ imageUrl: uploaded.imageUrl }),
      });
      haptics.success();
      await store.refresh();
      notify("ok", "Foto del producto actualizada ✓");
    } catch (err) {
      notify("err", err instanceof Error ? err.message : "Error subiendo imagen");
    } finally {
      setUploadingProductId(null);
    }
  };

  const handleCreateAlly = () => {
    if (!allyName.trim()) return;
    void runAction(`Aliado "${allyName.trim()}" creado ✓`, async () => {
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

  const handleCreatePresentation = () => {
    if (!effectivePresProductId || !newPresName.trim()) return;
    void runAction(`Presentación "${newPresName.trim()}" añadida ✓`, async () => {
      await apiFetch(`/api/v1/branches/${branchId}/presentations`, {
        method: "POST",
        body: JSON.stringify({
          menuProductId: effectivePresProductId,
          name: newPresName.trim(),
          shortLabel: newPresName.trim().slice(0, 14),
          presentationGroup: newPresGroup,
          salePrice: Number(newPresPrice) || 0,
          recipes: effectivePresInvId
            ? [
                {
                  inventoryItemId: effectivePresInvId,
                  displayUnit: newPresUnit,
                  displayQuantity: Math.max(0.001, Number(newPresQty) || 1),
                  pourLossPercent: selectedPresSupportsFoam ? Number(newPresFoamPct) || 0 : 0,
                  fixedLossBase: selectedPresSupportsFoam ? Number(newPresPurgeMl) || 0 : 0,
                },
              ]
            : [],
        }),
      });
    });
  };

  const handleCreateCustomer = () => {
    if (!custName.trim()) return;
    void runAction(`Cliente "${custName.trim()}" registrado ✓`, async () => {
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

  return (
    <div className="space-y-6">
      {/* Acción destacada: Constructor de Combos */}
      <section className="solid-card flex flex-wrap items-center justify-between gap-4 rounded-2xl border-primary/30 p-5">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/15 text-primary">
            <Layers className="h-6 w-6" />
          </div>
          <div>
            <h2 className="font-display text-lg font-bold">Combos del Bar y Combos con Aliados</h2>
            <p className="text-xs text-muted-foreground">
              Crea combos como <strong>Pinta + Salchipapa</strong> o{" "}
              <strong>2 Pintas + Empanadas</strong>: descuenta tu cerveza/insumos y liquida al
              aliado automáticamente.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            haptics.tap();
            setShowComboModal(true);
          }}
          className="press-response flex min-h-12 items-center gap-2 rounded-2xl bg-primary px-5 text-sm font-bold text-primary-foreground"
        >
          <Plus className="h-5 w-5" />
          Crear Combo (ej. Pinta + Salchipapa)
        </button>
      </section>

      {/* 1. Módulos Configurables por Bar */}
      <section className="solid-card rounded-2xl p-5">
        <div className="mb-3 flex items-center gap-2">
          <Sliders className="h-5 w-5 text-primary" />
          <div>
            <h2 className="font-display text-lg font-bold">Módulos Activos de Esta Sucursal</h2>
            <p className="text-xs text-muted-foreground">
              Toca cualquier tarjeta para activar o desactivar esa función en tiempo real
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
                      enabled ? "bg-success/20 text-success" : "bg-secondary text-muted-foreground"
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

      {/* 2. Aliados y Horarios de Cierre Automático */}
      <section className="solid-card space-y-4 rounded-2xl p-5">
        <div className="flex items-center gap-2">
          <Clock className="h-5 w-5 text-warning" />
          <div>
            <h2 className="font-display text-lg font-bold">Locales Aliados y Horario de Cierre</h2>
            <p className="text-xs text-muted-foreground">
              Cuando un aliado cierra, sus productos y combos (ej. Pinta + Salchipapa) se ocultan
              automáticamente del POS.
            </p>
          </div>
        </div>

        <div className="space-y-3">
          {store.allies.length === 0 && (
            <p className="rounded-xl border border-dashed border-white/10 p-3 text-xs text-muted-foreground">
              Aún no has agregado locales aliados. Registra uno abajo si vendes comida de un vecino o
              combos mixtos (ej. Pinta + Salchipapa).
            </p>
          )}
          {store.allies.map((ally) => (
            <div
              key={ally.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 bg-background/50 p-3.5"
            >
              <div>
                <p className="font-bold">{ally.name}</p>
                <p className="text-xs text-muted-foreground">
                  Horario: {ally.operatingSchedule?.openTime ?? "00:00"} –{" "}
                  {ally.operatingSchedule?.closeTime ?? "23:59"}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="time"
                  defaultValue={ally.operatingSchedule?.openTime ?? "11:00"}
                  onBlur={(e) =>
                    void runAction("Horario de aliado actualizado ✓", async () => {
                      await apiFetch(`/api/v1/branches/${branchId}/allies/${ally.id}`, {
                        method: "PATCH",
                        body: JSON.stringify({
                          openTime: e.target.value,
                          closeTime: ally.operatingSchedule?.closeTime ?? "23:30",
                        }),
                      });
                    })
                  }
                  className="rounded-lg border border-white/15 bg-card px-2 py-1.5 text-xs"
                />
                <span className="text-xs text-muted-foreground">a</span>
                <input
                  type="time"
                  defaultValue={ally.operatingSchedule?.closeTime ?? "23:30"}
                  onBlur={(e) =>
                    void runAction("Horario de aliado actualizado ✓", async () => {
                      await apiFetch(`/api/v1/branches/${branchId}/allies/${ally.id}`, {
                        method: "PATCH",
                        body: JSON.stringify({
                          openTime: ally.operatingSchedule?.openTime ?? "11:00",
                          closeTime: e.target.value,
                        }),
                      });
                    })
                  }
                  className="rounded-lg border border-white/15 bg-card px-2 py-1.5 text-xs"
                />
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
                          body: JSON.stringify({ isTemporarilyClosed: !ally.isTemporarilyClosed }),
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
                  {ally.isTemporarilyClosed ? "CERRADO (Oculto en POS)" : "ABIERTO (Visible)"}
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* Agregar nuevo aliado */}
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

      {/* 3. Catálogo, Fotos, Precios y Nueva Presentación */}
      <section className="solid-card space-y-4 rounded-2xl p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <ImagePlus className="h-5 w-5 text-primary" />
            <div>
              <h2 className="font-display text-lg font-bold">
                Productos, Imágenes, Precios y Presentaciones
              </h2>
              <p className="text-xs text-muted-foreground">
                Edita precios (se guardan al salir del campo) o sube foto a cualquier producto
              </p>
            </div>
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          {store.menuProducts.map((prod) => {
            const presList = store.presentations.filter((p) => p.menuProductId === prod.id);
            return (
              <div
                key={prod.id}
                className="rounded-xl border border-white/10 bg-background/50 p-3.5"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <ProductVisualAvatar
                      imageUrl={prod.imageUrl}
                      name={prod.name}
                      productKind={prod.productKind}
                      allyId={prod.allyId}
                      presentationGroup={presList[0]?.presentationGroup}
                      size="sm"
                    />
                    <div>
                      <p className="font-bold">{prod.name}</p>
                      <p className="text-[11px] text-muted-foreground">{prod.productKind}</p>
                    </div>
                  </div>
                  <label className="press-response cursor-pointer rounded-xl bg-secondary px-3 py-2 text-xs font-semibold text-primary">
                    {uploadingProductId === prod.id ? "Subiendo..." : "Subir foto"}
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) void handleUploadImage(prod.id, f);
                      }}
                    />
                  </label>
                </div>

                <div className="mt-3 space-y-1.5">
                  {presList.map((pr) => (
                    <div
                      key={pr.id}
                      className="flex items-center justify-between gap-2 rounded-lg bg-card/70 px-2.5 py-2 text-xs"
                    >
                      <div>
                        <span className="font-semibold">{pr.name}</span>
                        {pr.recipes[0] && (
                          <span className="ml-2 text-[11px] text-muted-foreground">
                            ({pr.recipes[0].displayQuantity} {pr.recipes[0].displayUnit}
                            {pr.recipes[0].pourLossPercent > 0 || pr.recipes[0].fixedLossBase > 0
                              ? ` · espuma ${pr.recipes[0].pourLossPercent}%${pr.recipes[0].fixedLossBase > 0 ? ` + ${pr.recipes[0].fixedLossBase}ml` : ""}`
                              : ""}
                            )
                          </span>
                        )}
                      </div>
                      <input
                        type="number"
                        defaultValue={pr.salePrice}
                        onBlur={(e) => {
                          const v = Number(e.target.value);
                          if (v >= 0 && v !== pr.salePrice) {
                            void runAction(`Precio actualizado a ${formatCOP(v)} ✓`, async () => {
                              await apiFetch(
                                `/api/v1/branches/${branchId}/presentations/${pr.id}`,
                                {
                                  method: "PATCH",
                                  body: JSON.stringify({ salePrice: v }),
                                },
                              );
                            });
                          }
                        }}
                        className="w-24 rounded-lg border border-white/10 bg-background px-2 py-1 text-right font-bold tabular-nums text-primary"
                      />
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        {/* Añadir nueva presentación a un producto existente */}
        <div className="rounded-xl border border-primary/25 bg-primary/5 p-4">
          <p className="mb-3 flex items-center gap-1.5 text-sm font-bold text-primary">
            <Plus className="h-4 w-4" />
            Añadir Presentación a Producto Existente (ej. Jirafa 5L, Shot 2oz)
          </p>
          <div className="grid gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
            <select
              value={effectivePresProductId}
              onChange={(e) => setNewPresProductId(e.target.value)}
              className="rounded-xl border border-white/15 bg-background px-2.5 py-2 text-xs"
            >
              {store.menuProducts.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <input
              type="text"
              placeholder="Nombre (ej. Jirafa 5L)"
              value={newPresName}
              onChange={(e) => setNewPresName(e.target.value)}
              className="rounded-xl border border-white/15 bg-background px-2.5 py-2 text-xs"
            />
            <select
              value={newPresGroup}
              onChange={(e) => setNewPresGroup(e.target.value as PresentationGroup)}
              className="rounded-xl border border-white/15 bg-background px-2.5 py-2 text-xs"
            >
              <option value="vaso">vaso</option>
              <option value="pinta">pinta</option>
              <option value="jarra">jarra</option>
              <option value="jirafa">jirafa</option>
              <option value="shot">shot</option>
              <option value="coctel">coctel</option>
              <option value="botella">botella</option>
              <option value="combo">combo</option>
            </select>
            <input
              type="number"
              placeholder="Precio COP"
              value={newPresPrice}
              onChange={(e) => setNewPresPrice(e.target.value)}
              className="rounded-xl border border-white/15 bg-background px-2.5 py-2 text-xs tabular-nums"
            />
            <select
              value={effectivePresInvId}
              onChange={(e) => setNewPresInvId(e.target.value)}
              className="rounded-xl border border-white/15 bg-background px-2.5 py-2 text-xs"
            >
              {store.inventoryItems.map((i) => (
                <option key={i.id} value={i.id}>
                  Insumo: {i.name}
                </option>
              ))}
            </select>
            <div className="flex gap-1.5">
              <input
                type="number"
                step="0.5"
                value={newPresQty}
                onChange={(e) => setNewPresQty(e.target.value)}
                className="w-16 rounded-xl border border-white/15 bg-background px-2 py-2 text-xs tabular-nums"
              />
              <select
                value={newPresUnit}
                onChange={(e) => setNewPresUnit(e.target.value as DisplayUnit)}
                className="flex-1 rounded-xl border border-white/15 bg-background px-2 py-2 text-xs"
              >
                <option value="ml">ml</option>
                <option value="L">L</option>
                <option value="oz">oz</option>
                <option value="g">g</option>
                <option value="kg">kg</option>
                <option value="unit">und</option>
              </select>
            </div>
          </div>

          <div className="mt-2.5 flex flex-wrap items-center gap-3 text-xs">
            {selectedPresSupportsFoam && (
              <>
                <label className="flex items-center gap-1.5">
                  <span className="text-muted-foreground">% Espuma:</span>
                  <input
                    type="number"
                    min={0}
                    max={50}
                    value={newPresFoamPct}
                    onChange={(e) => setNewPresFoamPct(e.target.value)}
                    className="w-16 rounded-lg border border-white/15 bg-background px-2 py-1.5 tabular-nums"
                  />
                </label>
                <label className="flex items-center gap-1.5">
                  <span className="text-muted-foreground">Purga fija (ml):</span>
                  <input
                    type="number"
                    min={0}
                    value={newPresPurgeMl}
                    onChange={(e) => setNewPresPurgeMl(e.target.value)}
                    className="w-16 rounded-lg border border-white/15 bg-background px-2 py-1.5 tabular-nums"
                  />
                </label>
              </>
            )}
            <button
              type="button"
              disabled={saving || !effectivePresProductId}
              onClick={handleCreatePresentation}
              className="press-response ml-auto rounded-xl bg-primary px-4 py-2 font-bold text-primary-foreground disabled:opacity-50"
            >
              Guardar Presentación
            </button>
          </div>
        </div>
      </section>

      {/* 4. Promociones Modulares y Clientes (Lista Blanca / Lista Negra) */}
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="solid-card space-y-3 rounded-2xl p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-success" />
              <h3 className="font-display text-base font-bold">Promociones de la Sucursal</h3>
            </div>
            <button
              type="button"
              onClick={() => {
                haptics.tap();
                setEditingPromo(null);
                setShowPromoModal(true);
              }}
              className="press-response flex min-h-10 items-center gap-1 rounded-xl bg-success px-3.5 text-xs font-bold text-primary-foreground"
            >
              <Plus className="h-4 w-4" />
              Nueva Promo
            </button>
          </div>
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
                  ? store.categories.find((c) => c.id === rule.targetId)?.name ?? "Categoría"
                  : rule.scopeType === "product"
                    ? store.menuProducts.find((p) => p.id === rule.targetId)?.name ?? "Producto"
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
                  className="flex items-center justify-between gap-2 rounded-xl border border-white/10 bg-background/50 p-3"
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
                        <span className="rounded-full bg-success/15 px-2 py-0.5 text-[10px] font-bold text-success capitalize">
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
                          `Promoción ${!rule.isActive ? "activada" : "desactivada"} ✓`,
                          async () => {
                            await apiFetch(`/api/v1/branches/${branchId}/promotions/${rule.id}`, {
                              method: "PATCH",
                              body: JSON.stringify({ isActive: !rule.isActive }),
                            });
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
                          void runAction(`Promoción "${rule.name}" eliminada ✓`, async () => {
                            await apiFetch(`/api/v1/branches/${branchId}/promotions/${rule.id}`, {
                              method: "DELETE",
                            });
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
        </section>

        <section className="solid-card space-y-3 rounded-2xl p-5">
          <div className="flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-accent" />
            <h3 className="font-display text-base font-bold">
              Clientes: Lista Blanca / Lista Negra
            </h3>
          </div>
          <div className="space-y-2.5">
            {store.customers.map((c) => (
              <div
                key={c.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/10 bg-background/50 p-3"
              >
                <div>
                  <p className="text-sm font-bold">{c.fullName}</p>
                  <p className="text-xs tabular-nums text-muted-foreground">
                    Deuda: {formatCOP(c.currentDebt)}
                  </p>
                </div>
                <select
                  value={c.creditStatus}
                  onChange={(e) =>
                    void runAction(`Estado de ${c.fullName} actualizado ✓`, async () => {
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
                  <option value="whitelist_credit">🟢 Lista Blanca</option>
                  <option value="standard">⚪ Estándar</option>
                  <option value="blacklist_blocked">🔴 Lista Negra</option>
                </select>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap gap-2 rounded-xl border border-accent/20 bg-accent/5 p-3">
            <input
              type="text"
              placeholder="Nuevo cliente..."
              value={custName}
              onChange={(e) => setCustName(e.target.value)}
              className="min-w-36 flex-1 rounded-xl border border-white/15 bg-background px-3 py-1.5 text-xs"
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
                className="w-24 rounded-xl border border-white/15 bg-background px-2 py-1.5 text-xs tabular-nums"
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

      {showComboModal && (
        <NewComboModal
          branchId={branchId}
          categories={store.categories}
          inventoryItems={store.inventoryItems}
          allies={store.allies}
          onClose={() => setShowComboModal(false)}
          onCreated={async () => {
            await store.refresh();
            notify("ok", "Combo creado y publicado en Mesas & POS ✓");
          }}
        />
      )}

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
            notify("ok", editingPromo ? "Promoción actualizada ✓" : "Promoción creada y activa ✓");
          }}
        />
      )}
    </div>
  );
}
