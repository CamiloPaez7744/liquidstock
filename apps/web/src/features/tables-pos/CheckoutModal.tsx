import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Ban,
  BookOpen,
  CheckCircle2,
  CreditCard,
  Gift,
  PlusCircle,
  Search,
  ShieldCheck,
  Sparkles,
  Tag,
  UserPlus,
  X,
} from "lucide-react";
import {
  evaluateCreditRequest,
  evaluateSubAccountPromotion,
  isPromotionEligibleAt,
  type Customer,
  type OrderItemLine,
  type PaymentMethod,
  type PromotionRule,
} from "@liquistock/domain";
import type { LocalSubAccount } from "../../infrastructure/storage/dexie/db.js";
import { formatCOP, getCurrentIsoDayAndTime } from "../../shared/lib/format.js";
import { haptics } from "../../shared/lib/haptics.js";

interface CheckoutModalProps {
  tableLabel: string;
  subAccount: LocalSubAccount;
  items: OrderItemLine[];
  paymentMethods: PaymentMethod[];
  customers: Customer[];
  promotionRules: PromotionRule[];
  enableCredit: boolean;
  isAdmin: boolean;
  initialMode?: "pay" | "credit" | "courtesy" | "extra";
  onQuickAddWhitelistCustomer: (input: {
    fullName: string;
    nickname?: string;
    phone?: string;
    creditLimit?: number | null;
  }) => Promise<Customer>;
  onPromoteToWhitelist: (customerId: string) => Promise<void>;
  onAdjustItemPrice: (orderItemId: string, newLineTotal: number, reason: string) => Promise<void>;
  onAddCustomCharge: (input: {
    description: string;
    amount: number;
    categoryLabel?: string;
    quantity?: number;
  }) => Promise<void>;
  onApplyManualPromo: (rule: PromotionRule) => Promise<void>;
  onPay: (paymentMethodId: string, amount: number, methodName: string) => Promise<void>;
  onChargeCredit: (customer: Customer, amount: number, adminOverride: boolean) => Promise<void>;
  onClose: () => void;
}

const CUSTOM_CHARGE_PRESETS: Array<{ label: string; categoryLabel: string; placeholderAmount: string }> = [
  { label: "Vaso / Copa rota", categoryLabel: "Reposición / Daño", placeholderAmount: "15000" },
  { label: "Descorche", categoryLabel: "Descorche", placeholderAmount: "30000" },
  { label: "Servicio / Propina", categoryLabel: "Servicio", placeholderAmount: "10000" },
  { label: "Daño / Reposición", categoryLabel: "Reposición / Daño", placeholderAmount: "20000" },
  { label: "Domicilio / Empaque", categoryLabel: "Adicional", placeholderAmount: "5000" },
  { label: "Otro cobro adicional", categoryLabel: "Cargo adicional", placeholderAmount: "" },
];

export function CheckoutModal({
  tableLabel,
  subAccount,
  items,
  paymentMethods,
  customers,
  promotionRules,
  enableCredit,
  isAdmin,
  initialMode = "pay",
  onQuickAddWhitelistCustomer,
  onPromoteToWhitelist,
  onAdjustItemPrice,
  onAddCustomCharge,
  onApplyManualPromo,
  onPay,
  onChargeCredit,
  onClose,
}: CheckoutModalProps) {
  const remaining = Math.max(0, subAccount.totalAmount - subAccount.paidAmount - subAccount.creditAmount);
  const [mode, setMode] = useState<"pay" | "credit" | "courtesy" | "extra">(initialMode);
  const [extraDescription, setExtraDescription] = useState("");
  const [extraCategoryLabel, setExtraCategoryLabel] = useState("Reposición / Daño");
  const [extraAmount, setExtraAmount] = useState("");
  const [extraQty, setExtraQty] = useState("1");
  const [extraError, setExtraError] = useState<string | null>(null);
  const [selectedMethodId, setSelectedMethodId] = useState(paymentMethods[0]?.id ?? "");
  const [payAmount, setPayAmount] = useState(String(Math.round(remaining)));
  const [cashTendered, setCashTendered] = useState(String(Math.round(remaining)));
  const [customerSearch, setCustomerSearch] = useState("");
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(null);
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [customPrice, setCustomPrice] = useState("");
  const [adjustReason, setAdjustReason] = useState("Cortesía / Ajuste en caja");
  const [showQuickAddWhitelist, setShowQuickAddWhitelist] = useState(false);
  const [quickFullName, setQuickFullName] = useState("");
  const [quickNickname, setQuickNickname] = useState("");
  const [quickPhone, setQuickPhone] = useState("");
  const [quickLimit, setQuickLimit] = useState("");
  const [quickError, setQuickError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Keep payment amount synchronized whenever a courtesy or manual promotion lowers the balance!
  useEffect(() => {
    setPayAmount(String(Math.round(remaining)));
    setCashTendered(String(Math.round(remaining)));
  }, [remaining]);

  const { isoDay, hhmm, yyyymmdd } = getCurrentIsoDayAndTime();

  const manualPromosWithPreview = useMemo(() => {
    const lineInputs = items
      .filter(
        (i) =>
          i.status === "active" &&
          !i.adjustmentReason &&
          Boolean(i.menuProductId && i.presentationId && i.categoryId),
      )
      .map((i) => ({
        id: i.id,
        categoryId: i.categoryId!,
        menuProductId: i.menuProductId!,
        presentationId: i.presentationId!,
        presentationGroup: i.presentationGroupSnap,
        unitPrice: i.unitPriceSnap,
        quantity: i.quantity,
      }));

    return promotionRules
      .filter((r) => r.isActive && r.applicationMode === "manual_at_checkout")
      .filter((r) =>
        isPromotionEligibleAt(r, {
          isoDayOfWeek: isoDay,
          currentTimeHHMM: hhmm,
          currentDateYYYYMMDD: yyyymmdd,
        }),
      )
      .map((rule) => ({
        rule,
        preview: evaluateSubAccountPromotion(rule, lineInputs),
      }));
  }, [promotionRules, items, isoDay, hhmm, yyyymmdd]);

  const selectedMethod = paymentMethods.find((m) => m.id === selectedMethodId) ?? paymentMethods[0];
  const numericPayAmount = Math.min(remaining, Math.max(0, Number(payAmount) || 0));
  const changeDue = Math.max(0, (Number(cashTendered) || 0) - numericPayAmount);

  const allySubtotal = useMemo(
    () => items.filter((i) => i.allyIdSnap).reduce((acc, i) => acc + i.lineTotal, 0),
    [items],
  );
  const barSubtotal = Math.max(0, subAccount.totalAmount - allySubtotal);

  const filteredCustomers = useMemo(() => {
    const q = customerSearch.trim().toLowerCase();
    if (!q) return customers;
    return customers.filter(
      (c) =>
        c.fullName.toLowerCase().includes(q) ||
        (c.nickname?.toLowerCase().includes(q) ?? false) ||
        (c.phone?.includes(q) ?? false),
    );
  }, [customers, customerSearch]);

  const selectedCustomer = customers.find((c) => c.id === selectedCustomerId) ?? null;
  const creditEval = selectedCustomer ? evaluateCreditRequest(selectedCustomer, remaining) : null;

  const quickBills = [
    Math.round(remaining),
    Math.ceil(remaining / 10000) * 10000,
    Math.ceil(remaining / 50000) * 50000,
    100000,
  ].filter((v, idx, arr) => v >= remaining && arr.indexOf(v) === idx);

  const handleConfirmPay = async () => {
    if (!selectedMethod || busy) return;
    if (remaining <= 0.01) {
      // 100% courtesy account ($0) -> close immediately with 0-amount payment or cash
      setBusy(true);
      try {
        haptics.success();
        await onPay(selectedMethod.id, 0, "Cortesía 100%");
      } finally {
        setBusy(false);
      }
      return;
    }
    if (numericPayAmount <= 0) return;
    setBusy(true);
    try {
      haptics.success();
      await onPay(selectedMethod.id, numericPayAmount, selectedMethod.name);
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmCredit = async (amountToCharge: number, adminOverride = false) => {
    if (!selectedCustomer || amountToCharge <= 0 || busy) return;
    setBusy(true);
    try {
      haptics.success();
      await onChargeCredit(selectedCustomer, amountToCharge, adminOverride);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/75 backdrop-blur-sm sm:items-center sm:p-4">
      <div className="material-thick safe-bottom flex max-h-[92dvh] w-full max-w-3xl flex-col overflow-hidden rounded-t-3xl border border-white/10 sm:rounded-3xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <div>
            <h2 className="font-display text-lg font-bold sm:text-xl">
              Cobrar · {tableLabel} ({subAccount.label})
            </h2>
            {subAccount.description && (
              <p className="text-xs font-semibold text-primary">{subAccount.description}</p>
            )}
            <p className="text-xs text-muted-foreground">
              {items.length} línea(s) · Aplica cortesías, promos manuales o cobra
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="press-response flex h-11 w-11 items-center justify-center rounded-xl bg-secondary text-foreground"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="grid flex-1 gap-4 overflow-y-auto p-4 sm:p-5 md:grid-cols-12">
          {/* Resumen financiero + selector de modo */}
          <div className="space-y-3 md:col-span-5">
            <div className="solid-card space-y-2 rounded-2xl p-4 text-sm tabular-nums">
              <div className="flex justify-between text-muted-foreground">
                <span>Consumo Bar</span>
                <span>{formatCOP(barSubtotal)}</span>
              </div>
              {allySubtotal > 0 && (
                <div className="flex justify-between text-warning">
                  <span>Comida / Combos Aliados</span>
                  <span>{formatCOP(allySubtotal)}</span>
                </div>
              )}
              {subAccount.discountAmount > 0 && (
                <div className="flex justify-between text-success">
                  <span>Promos / Cortesías</span>
                  <span>-{formatCOP(subAccount.discountAmount)}</span>
                </div>
              )}
              <div className="flex justify-between border-t border-white/10 pt-2 text-base font-bold">
                <span>Total cuenta</span>
                <span>{formatCOP(subAccount.totalAmount)}</span>
              </div>
              {subAccount.paidAmount > 0 && (
                <div className="flex justify-between text-success">
                  <span>Pagado parcial</span>
                  <span>-{formatCOP(subAccount.paidAmount)}</span>
                </div>
              )}
              <div className="flex justify-between rounded-xl bg-primary/15 px-3 py-2.5 text-lg font-bold text-primary">
                <span>Restante</span>
                <span>{formatCOP(remaining)}</span>
              </div>
            </div>

            <div className={`grid gap-2 ${enableCredit ? "grid-cols-2 sm:grid-cols-4" : "grid-cols-3"}`}>
              <button
                type="button"
                onClick={() => {
                  haptics.tap();
                  setMode("pay");
                }}
                className={`press-response flex min-h-12 flex-col items-center justify-center gap-0.5 rounded-2xl px-2 text-xs font-bold ${
                  mode === "pay"
                    ? "bg-primary text-primary-foreground"
                    : "bg-secondary text-muted-foreground"
                }`}
              >
                <CreditCard className="h-4 w-4" />
                Contado
              </button>
              <button
                type="button"
                onClick={() => {
                  haptics.tap();
                  setMode("courtesy");
                }}
                className={`press-response flex min-h-12 flex-col items-center justify-center gap-0.5 rounded-2xl px-2 text-xs font-bold ${
                  mode === "courtesy"
                    ? "bg-success text-primary-foreground"
                    : "bg-secondary text-muted-foreground"
                }`}
              >
                <Gift className="h-4 w-4" />
                Cortesía / Promo
              </button>
              <button
                type="button"
                onClick={() => {
                  haptics.tap();
                  setExtraError(null);
                  setMode("extra");
                }}
                className={`press-response flex min-h-12 flex-col items-center justify-center gap-0.5 rounded-2xl px-2 text-xs font-bold ${
                  mode === "extra"
                    ? "bg-accent text-white"
                    : "bg-secondary text-muted-foreground"
                }`}
              >
                <PlusCircle className="h-4 w-4" />
                Adicional
              </button>
              {enableCredit && (
                <button
                  type="button"
                  onClick={() => {
                    haptics.tap();
                    setMode("credit");
                  }}
                  className={`press-response flex min-h-12 flex-col items-center justify-center gap-0.5 rounded-2xl px-2 text-xs font-bold ${
                    mode === "credit"
                      ? "bg-warning text-primary-foreground"
                      : "bg-secondary text-muted-foreground"
                  }`}
                >
                  <BookOpen className="h-4 w-4" />
                  Fiar
                </button>
              )}
            </div>
          </div>

          {/* Panel derecho: Pago | Cortesía/Promos | Fiado */}
          <div className="space-y-4 md:col-span-7">
            {mode === "pay" ? (
              <>
                <div>
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Medio de pago
                  </p>
                  <div className="grid grid-cols-2 gap-2.5">
                    {paymentMethods.map((pm) => {
                      const active = pm.id === selectedMethod?.id;
                      return (
                        <button
                          key={pm.id}
                          type="button"
                          onClick={() => {
                            haptics.tap();
                            setSelectedMethodId(pm.id);
                          }}
                          className={`press-response flex min-h-14 items-center justify-center rounded-2xl border px-3 text-sm font-bold ${
                            active
                              ? "border-primary bg-primary/20 text-primary"
                              : "border-white/10 bg-secondary/60 text-foreground"
                          }`}
                        >
                          {pm.name}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {remaining > 0.01 && (
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="mb-1 block text-xs text-muted-foreground">
                        Monto a cobrar
                      </label>
                      <input
                        type="number"
                        min={0}
                        max={remaining}
                        value={payAmount}
                        onChange={(e) => {
                          setPayAmount(e.target.value);
                          setCashTendered(e.target.value);
                        }}
                        className="w-full rounded-xl border border-white/15 bg-background/80 px-3.5 py-3 text-base font-bold tabular-nums text-foreground focus:border-primary focus:outline-none"
                      />
                    </div>
                    {selectedMethod?.countsAsPhysicalCash && (
                      <div>
                        <label className="mb-1 block text-xs text-muted-foreground">
                          Recibido efectivo
                        </label>
                        <input
                          type="number"
                          min={0}
                          value={cashTendered}
                          onChange={(e) => setCashTendered(e.target.value)}
                          className="w-full rounded-xl border border-white/15 bg-background/80 px-3.5 py-3 text-base font-bold tabular-nums text-foreground focus:border-primary focus:outline-none"
                        />
                      </div>
                    )}
                  </div>
                )}

                {remaining > 0.01 && selectedMethod?.countsAsPhysicalCash && (
                  <div className="space-y-2 rounded-2xl bg-secondary/40 p-3">
                    <div className="flex flex-wrap gap-2">
                      {quickBills.map((bill) => (
                        <button
                          key={bill}
                          type="button"
                          onClick={() => {
                            haptics.tap();
                            setCashTendered(String(bill));
                          }}
                          className="press-response rounded-xl bg-background/80 px-3 py-2 text-xs font-bold tabular-nums text-foreground ring-1 ring-white/10"
                        >
                          {bill === Math.round(remaining) ? "Exacto" : formatCOP(bill)}
                        </button>
                      ))}
                    </div>
                    <div className="flex items-center justify-between pt-1 text-sm">
                      <span className="text-muted-foreground">Vueltas a entregar:</span>
                      <span className="text-lg font-bold tabular-nums text-success">
                        {formatCOP(changeDue)}
                      </span>
                    </div>
                  </div>
                )}

                <button
                  type="button"
                  disabled={busy || (remaining > 0.01 && numericPayAmount <= 0)}
                  onClick={handleConfirmPay}
                  className="press-response flex min-h-14 w-full items-center justify-center gap-2 rounded-2xl bg-success text-base font-bold text-primary-foreground disabled:opacity-50"
                >
                  <CheckCircle2 className="h-5 w-5" />
                  {remaining <= 0.01
                    ? "Cerrar Cuenta Cortesía ($0)"
                    : `Confirmar Pago ${formatCOP(numericPayAmount)} (${selectedMethod?.name})`}
                </button>
              </>
            ) : mode === "courtesy" ? (
              <div className="space-y-4">
                {/* 1. Promociones Manuales Vigentes (ej. Mes de la Mujer 3x2) */}
                {manualPromosWithPreview.length > 0 && (
                  <div className="space-y-2">
                    <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-accent">
                      <Sparkles className="h-3.5 w-3.5" />
                      Promociones Manuales Vigentes Hoy
                    </p>
                    <div className="space-y-2">
                      {manualPromosWithPreview.map(({ rule, preview }) => (
                        <button
                          key={rule.id}
                          type="button"
                          disabled={preview.totalDiscount <= 0}
                          onClick={() => {
                            haptics.success();
                            void onApplyManualPromo(rule);
                          }}
                          className="press-response flex w-full items-center justify-between gap-2 rounded-2xl border border-accent/40 bg-accent/10 p-3 text-left disabled:opacity-50"
                        >
                          <div>
                            <p className="text-sm font-bold text-foreground">{rule.name}</p>
                            <p className="text-xs text-muted-foreground">
                              {preview.totalDiscount > 0
                                ? `Descuento calculado: -${formatCOP(preview.totalDiscount)}`
                                : "Aún no cumple cantidad o productos en esta cuenta"}
                            </p>
                          </div>
                          <span className="shrink-0 rounded-xl bg-accent px-3 py-1.5 text-xs font-bold text-white">
                            Aplicar
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* 2. Cortesías y Ajustes de Precio por Ítem (auditados sin perder el inventario) */}
                <div className="space-y-2">
                  <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-success">
                    <Tag className="h-3.5 w-3.5" />
                    Cortesía o Ajuste de Precio por Ítem
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    El inventario del barril/licor se mantiene descontado; el descuento queda
                    auditado en caja y recibo.
                  </p>

                  <div className="max-h-60 space-y-2 overflow-y-auto pr-1">
                    {items.map((item) => {
                      const gross = item.unitPriceSnap * item.quantity;
                      const isEditing = editingItemId === item.id;
                      return (
                        <div
                          key={item.id}
                          className="rounded-2xl border border-white/10 bg-background/60 p-3"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div>
                              <p className="text-sm font-bold">
                                {item.quantity}× {item.productNameSnap} ({item.presentationNameSnap})
                              </p>
                              <p className="text-xs tabular-nums text-muted-foreground">
                                Lista: {formatCOP(gross)} → Cobra:{" "}
                                <strong className="text-primary">{formatCOP(item.lineTotal)}</strong>
                                {item.adjustmentReason ? ` · ${item.adjustmentReason}` : ""}
                              </p>
                            </div>
                          </div>

                          <div className="mt-2 flex flex-wrap gap-1.5">
                            <button
                              type="button"
                              onClick={() => {
                                haptics.tap();
                                void onAdjustItemPrice(item.id, 0, "Cortesía de la casa");
                              }}
                              className="press-response rounded-lg bg-success/20 px-2.5 py-1.5 text-xs font-bold text-success"
                            >
                              Cortesía ($0)
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                haptics.tap();
                                void onAdjustItemPrice(
                                  item.id,
                                  Math.round(gross / 2),
                                  "Mitad de precio (50%)",
                                );
                              }}
                              className="press-response rounded-lg bg-primary/20 px-2.5 py-1.5 text-xs font-bold text-primary"
                            >
                              50% ({formatCOP(gross / 2)})
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                haptics.tap();
                                setEditingItemId(isEditing ? null : item.id);
                                setCustomPrice(String(Math.round(item.lineTotal)));
                                setAdjustReason(item.adjustmentReason ?? "Precio especial acordado");
                              }}
                              className="press-response rounded-lg bg-secondary px-2.5 py-1.5 text-xs font-bold text-foreground"
                            >
                              $ Otro precio
                            </button>
                          </div>

                          {isEditing && (
                            <div className="mt-2.5 flex flex-wrap items-center gap-2 rounded-xl bg-card p-2.5">
                              <input
                                type="number"
                                min={0}
                                max={gross}
                                value={customPrice}
                                onChange={(e) => setCustomPrice(e.target.value)}
                                placeholder="Nuevo total"
                                className="w-28 rounded-lg border border-white/15 bg-background px-2.5 py-1.5 text-sm font-bold tabular-nums"
                              />
                              <input
                                type="text"
                                value={adjustReason}
                                onChange={(e) => setAdjustReason(e.target.value)}
                                placeholder="Motivo (ej. Cortesía cumpleaños)"
                                className="min-w-36 flex-1 rounded-lg border border-white/15 bg-background px-2.5 py-1.5 text-xs"
                              />
                              <button
                                type="button"
                                onClick={() => {
                                  haptics.success();
                                  void onAdjustItemPrice(
                                    item.id,
                                    Number(customPrice) || 0,
                                    adjustReason.trim() || "Ajuste manual",
                                  );
                                  setEditingItemId(null);
                                }}
                                className="press-response rounded-lg bg-primary px-3 py-1.5 text-xs font-bold text-primary-foreground"
                              >
                                Aplicar
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            ) : mode === "extra" ? (
              <div className="space-y-4">
                <div className="space-y-2">
                  <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-accent">
                    <PlusCircle className="h-3.5 w-3.5" />
                    Agregar Cargo / Ingreso Adicional a la Cuenta
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    Úsalo para cobrar vasos o copas rotas, descorche, daños, servicio o cualquier
                    cargo extra. Suma directo a esta cuenta y entra al recaudo sin tocar inventario.
                  </p>

                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {CUSTOM_CHARGE_PRESETS.map((preset) => (
                      <button
                        key={preset.label}
                        type="button"
                        onClick={() => {
                          haptics.tap();
                          setExtraDescription(preset.label === "Otro cobro adicional" ? "" : preset.label);
                          setExtraCategoryLabel(preset.categoryLabel);
                          if (preset.placeholderAmount && !extraAmount) {
                            setExtraAmount(preset.placeholderAmount);
                          }
                          setExtraError(null);
                        }}
                        className={`press-response rounded-xl border px-2.5 py-1.5 text-xs font-bold ${
                          extraDescription === preset.label
                            ? "border-accent bg-accent/20 text-accent"
                            : "border-white/10 bg-secondary/70 text-foreground"
                        }`}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-3 rounded-2xl border border-accent/30 bg-accent/8 p-3.5">
                  <div>
                    <label className="mb-1 block text-xs font-semibold text-muted-foreground">
                      Concepto del cobro *
                    </label>
                    <input
                      type="text"
                      placeholder="Ej. Vaso pinta roto, descorche botella, daño mesa..."
                      value={extraDescription}
                      onChange={(e) => {
                        setExtraDescription(e.target.value);
                        setExtraError(null);
                      }}
                      className="w-full rounded-xl border border-white/15 bg-background px-3.5 py-2.5 text-sm text-foreground focus:border-accent focus:outline-none"
                    />
                  </div>

                  <div className="grid grid-cols-3 gap-2.5">
                    <div className="col-span-2">
                      <label className="mb-1 block text-xs font-semibold text-muted-foreground">
                        Valor unitario (COP) *
                      </label>
                      <input
                        type="number"
                        min={1}
                        placeholder="15000"
                        value={extraAmount}
                        onChange={(e) => {
                          setExtraAmount(e.target.value);
                          setExtraError(null);
                        }}
                        className="w-full rounded-xl border border-white/15 bg-background px-3.5 py-2.5 text-base font-bold tabular-nums text-foreground focus:border-accent focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-semibold text-muted-foreground">
                        Cantidad
                      </label>
                      <input
                        type="number"
                        min={1}
                        max={50}
                        value={extraQty}
                        onChange={(e) => setExtraQty(e.target.value)}
                        className="w-full rounded-xl border border-white/15 bg-background px-3 py-2.5 text-base font-bold tabular-nums text-foreground focus:border-accent focus:outline-none"
                      />
                    </div>
                  </div>

                  {extraError && (
                    <p className="rounded-xl bg-destructive/15 px-3 py-2 text-xs font-semibold text-destructive">
                      {extraError}
                    </p>
                  )}

                  <button
                    type="button"
                    disabled={busy}
                    onClick={async () => {
                      const desc = extraDescription.trim();
                      const amt = Number(extraAmount);
                      const qty = Math.max(1, Math.round(Number(extraQty) || 1));
                      if (!desc) {
                        setExtraError("Escribe el concepto del cobro adicional.");
                        return;
                      }
                      if (!Number.isFinite(amt) || amt <= 0) {
                        setExtraError("Ingresa un valor mayor a $0.");
                        return;
                      }
                      setBusy(true);
                      try {
                        await onAddCustomCharge({
                          description: desc,
                          amount: amt,
                          categoryLabel: extraCategoryLabel,
                          quantity: qty,
                        });
                        haptics.success();
                        setExtraDescription("");
                        setExtraAmount("");
                        setExtraQty("1");
                        setExtraError(null);
                        setMode("pay");
                      } catch (err) {
                        haptics.blocked();
                        setExtraError(
                          err instanceof Error ? err.message : "No se pudo agregar el cargo",
                        );
                      } finally {
                        setBusy(false);
                      }
                    }}
                    className="press-response flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl bg-accent px-4 text-sm font-bold text-white disabled:opacity-50"
                  >
                    <PlusCircle className="h-4 w-4" />
                    Agregar a la cuenta y volver a cobrar
                    {Number(extraAmount) > 0
                      ? ` (+${formatCOP(Number(extraAmount) * Math.max(1, Math.round(Number(extraQty) || 1)))})`
                      : ""}
                  </button>
                </div>

                {items.filter((i) => !i.presentationId).length > 0 && (
                  <div className="space-y-1.5">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Cargos adicionales en esta cuenta
                    </p>
                    <div className="divide-y divide-white/10 rounded-xl bg-background/60 px-3 text-xs tabular-nums">
                      {items
                        .filter((i) => !i.presentationId)
                        .map((extra) => (
                          <div key={extra.id} className="flex items-center justify-between py-2">
                            <span className="font-semibold text-foreground">
                              {extra.quantity}× {extra.productNameSnap}
                            </span>
                            <span className="font-bold text-accent">
                              +{formatCOP(extra.lineTotal)}
                            </span>
                          </div>
                        ))}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Search className="pointer-events-none absolute left-3.5 top-3.5 h-4 w-4 text-muted-foreground" />
                    <input
                      type="text"
                      placeholder="Buscar cliente por nombre, apodo o teléfono..."
                      value={customerSearch}
                      onChange={(e) => setCustomerSearch(e.target.value)}
                      className="w-full rounded-xl border border-white/15 bg-background/80 py-3 pl-10 pr-4 text-base text-foreground focus:border-warning focus:outline-none sm:text-sm"
                    />
                  </div>
                  {isAdmin && (
                    <button
                      type="button"
                      onClick={() => {
                        haptics.tap();
                        setQuickError(null);
                        setQuickFullName((prev) => prev || customerSearch.trim());
                        setQuickLimit((prev) =>
                          prev || String(Math.max(200000, Math.ceil(remaining / 50000) * 50000)),
                        );
                        setShowQuickAddWhitelist((v) => !v);
                      }}
                      className={`press-response flex shrink-0 items-center gap-1.5 rounded-xl px-3 text-xs font-bold ${
                        showQuickAddWhitelist
                          ? "bg-secondary text-foreground"
                          : "bg-success/20 text-success ring-1 ring-success/40"
                      }`}
                    >
                      <UserPlus className="h-4 w-4" />
                      <span className="hidden sm:inline">+ Lista Blanca</span>
                    </button>
                  )}
                </div>

                {/* Alta instantánea en Lista Blanca solo para Admin */}
                {isAdmin && showQuickAddWhitelist && (
                  <div className="space-y-2.5 rounded-2xl border border-success/40 bg-success/10 p-3.5">
                    <p className="flex items-center gap-1.5 text-xs font-bold text-success">
                      <UserPlus className="h-4 w-4" />
                      Agregar cliente directo a Lista Blanca (Admin)
                    </p>
                    <div className="grid gap-2 sm:grid-cols-2">
                      <input
                        type="text"
                        placeholder="Nombre completo *"
                        value={quickFullName}
                        onChange={(e) => setQuickFullName(e.target.value)}
                        className="rounded-xl border border-white/15 bg-background px-3 py-2 text-base sm:text-xs"
                      />
                      <input
                        type="text"
                        placeholder="Apodo (opcional)"
                        value={quickNickname}
                        onChange={(e) => setQuickNickname(e.target.value)}
                        className="rounded-xl border border-white/15 bg-background px-3 py-2 text-base sm:text-xs"
                      />
                      <input
                        type="tel"
                        placeholder="Teléfono (opcional)"
                        value={quickPhone}
                        onChange={(e) => setQuickPhone(e.target.value)}
                        className="rounded-xl border border-white/15 bg-background px-3 py-2 text-base sm:text-xs"
                      />
                      <input
                        type="number"
                        min={0}
                        placeholder="Cupo máx. COP (vacío = sin tope)"
                        value={quickLimit}
                        onChange={(e) => setQuickLimit(e.target.value)}
                        className="rounded-xl border border-white/15 bg-background px-3 py-2 text-base tabular-nums sm:text-xs"
                      />
                    </div>
                    {quickError && (
                      <p className="text-xs font-semibold text-destructive">{quickError}</p>
                    )}
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setShowQuickAddWhitelist(false)}
                        className="press-response rounded-xl bg-secondary px-3 py-2 text-xs font-semibold"
                      >
                        Cancelar
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={async () => {
                          if (!quickFullName.trim()) {
                            setQuickError("Escribe el nombre del cliente.");
                            return;
                          }
                          setQuickError(null);
                          setBusy(true);
                          try {
                            const created = await onQuickAddWhitelistCustomer({
                              fullName: quickFullName.trim(),
                              nickname: quickNickname.trim() || undefined,
                              phone: quickPhone.trim() || undefined,
                              creditLimit: quickLimit.trim() ? Number(quickLimit) : null,
                            });
                            haptics.success();
                            setSelectedCustomerId(created.id);
                            setCustomerSearch("");
                            setQuickFullName("");
                            setQuickNickname("");
                            setQuickPhone("");
                            setShowQuickAddWhitelist(false);
                          } catch (err) {
                            setQuickError(
                              err instanceof Error ? err.message : "No se pudo agregar el cliente.",
                            );
                          } finally {
                            setBusy(false);
                          }
                        }}
                        className="press-response rounded-xl bg-success px-4 py-2 text-xs font-bold text-primary-foreground disabled:opacity-50"
                      >
                        Guardar en Lista Blanca y Seleccionar
                      </button>
                    </div>
                  </div>
                )}

                <div className="max-h-44 space-y-2 overflow-y-auto pr-1">
                  {filteredCustomers.map((c) => {
                    const selected = c.id === selectedCustomerId;
                    const badge =
                      c.creditStatus === "whitelist_credit"
                        ? { text: "Lista Blanca", cls: "bg-success/15 text-success" }
                        : c.creditStatus === "blacklist_blocked"
                          ? { text: "Lista Negra", cls: "bg-destructive/20 text-destructive" }
                          : { text: "Estándar", cls: "bg-secondary text-muted-foreground" };
                    return (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => {
                          if (c.creditStatus === "blacklist_blocked") {
                            haptics.blocked();
                          } else {
                            haptics.tap();
                          }
                          setSelectedCustomerId(c.id);
                        }}
                        className={`press-response flex w-full items-center justify-between rounded-2xl border p-3 text-left ${
                          selected
                            ? "border-warning bg-warning/10"
                            : "border-white/10 bg-secondary/40"
                        }`}
                      >
                        <div>
                          <p className="text-sm font-bold text-foreground">
                            {c.fullName} {c.nickname ? `("${c.nickname}")` : ""}
                          </p>
                          <p className="text-xs tabular-nums text-muted-foreground">
                            Deuda actual: {formatCOP(c.currentDebt)}
                            {c.creditLimit !== null && c.creditLimit !== undefined
                              ? ` · Cupo: ${formatCOP(c.creditLimit)}`
                              : ""}
                          </p>
                        </div>
                        <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${badge.cls}`}>
                          {badge.text}
                        </span>
                      </button>
                    );
                  })}
                </div>

                {selectedCustomer && creditEval && (
                  <div
                    className={`rounded-2xl border p-4 ${
                      creditEval.code === "APPROVED"
                        ? "border-success/40 bg-success/10"
                        : creditEval.code === "BLOCKED_BLACKLIST"
                          ? "border-destructive/50 bg-destructive/15"
                          : "border-warning/40 bg-warning/10"
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      {creditEval.code === "APPROVED" ? (
                        <ShieldCheck className="h-6 w-6 shrink-0 text-success" />
                      ) : creditEval.code === "BLOCKED_BLACKLIST" ? (
                        <Ban className="h-6 w-6 shrink-0 text-destructive" />
                      ) : (
                        <AlertTriangle className="h-6 w-6 shrink-0 text-warning" />
                      )}
                      <div className="flex-1 text-sm">
                        <p className="font-bold">
                          {creditEval.code === "APPROVED"
                            ? "Autorizado para Fiar (Lista Blanca)"
                            : creditEval.code === "BLOCKED_BLACKLIST"
                              ? "BLOQUEADO — CLIENTE EN LISTA NEGRA"
                              : "Requiere atención"}
                        </p>
                        <p className="mt-0.5 text-xs text-foreground/90">{creditEval.message}</p>
                      </div>
                    </div>

                    <div className="mt-3 flex flex-wrap gap-2">
                      {creditEval.allowed && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => handleConfirmCredit(remaining, false)}
                          className="press-response flex min-h-12 flex-1 items-center justify-center rounded-xl bg-success px-4 text-sm font-bold text-primary-foreground"
                        >
                          Confirmar Fiado {formatCOP(remaining)}
                        </button>
                      )}
                      {creditEval.code === "BLOCKED_BLACKLIST" && (
                        <button
                          type="button"
                          onClick={() => setMode("pay")}
                          className="press-response flex min-h-12 flex-1 items-center justify-center rounded-xl bg-primary px-4 text-sm font-bold text-primary-foreground"
                        >
                          Cambiar a Cobro de Contado
                        </button>
                      )}
                      {creditEval.code === "EXCEEDS_CREDIT_LIMIT" &&
                        creditEval.maxCreditableAmount > 0 && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              handleConfirmCredit(creditEval.maxCreditableAmount, false)
                            }
                            className="press-response flex min-h-12 flex-1 items-center justify-center rounded-xl bg-warning px-4 text-sm font-bold text-primary-foreground"
                          >
                            Fiar cupo ({formatCOP(creditEval.maxCreditableAmount)})
                          </button>
                        )}
                      {creditEval.requiresAdminOverride && isAdmin && (
                        <>
                          {selectedCustomer.creditStatus === "standard" && (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={async () => {
                                setBusy(true);
                                try {
                                  await onPromoteToWhitelist(selectedCustomer.id);
                                  haptics.success();
                                  await onChargeCredit(
                                    { ...selectedCustomer, creditStatus: "whitelist_credit" },
                                    remaining,
                                    true,
                                  );
                                } finally {
                                  setBusy(false);
                                }
                              }}
                              className="press-response flex min-h-12 flex-1 items-center justify-center rounded-xl bg-success px-4 text-xs font-bold text-primary-foreground"
                            >
                              Pasar a Lista Blanca y Fiar ({formatCOP(remaining)})
                            </button>
                          )}
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => handleConfirmCredit(remaining, true)}
                            className="press-response flex min-h-12 items-center justify-center rounded-xl bg-secondary px-4 text-xs font-bold text-foreground ring-1 ring-white/15"
                          >
                            Autorizar solo esta vez
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
