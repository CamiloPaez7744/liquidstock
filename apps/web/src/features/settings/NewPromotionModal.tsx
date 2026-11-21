import { useMemo, useState } from "react";
import { Calendar, Gift, Percent, Sparkles, Tag, Users, X, Zap } from "lucide-react";
import type {
  MenuCategory,
  MenuProduct,
  PresentationGroup,
  ProductPresentation,
  PromotionApplicationMode,
  PromotionRule,
  PromotionRuleType,
  PromotionScopeType,
} from "@liquistock/domain";
import { apiFetch } from "../../infrastructure/api/api-client.js";
import { haptics } from "../../shared/lib/haptics.js";

const PRESENTATION_GROUP_LABELS: Record<PresentationGroup, string> = {
  vaso: "Vaso / Media",
  pinta: "Pinta",
  jarra: "Jarra",
  jirafa: "Jirafa",
  shot: "Shot",
  trago: "Trago",
  coctel: "Cóctel",
  botella: "Botella",
  lata: "Lata",
  combo: "Combo",
  comida: "Comida",
  otro: "Otro",
};

const FALLBACK_GROUPS: PresentationGroup[] = [
  "vaso",
  "pinta",
  "jarra",
  "jirafa",
  "botella",
  "shot",
  "coctel",
];

const DAYS = [
  { id: 1, label: "L" },
  { id: 2, label: "M" },
  { id: 3, label: "X" },
  { id: 4, label: "J" },
  { id: 5, label: "V" },
  { id: 6, label: "S" },
  { id: 7, label: "D" },
];

type PromoPreset = "bxgy_3x2_women" | "ten_plus_one" | "happy_hour" | "qty_percent";

interface NewPromotionModalProps {
  branchId: string;
  categories: MenuCategory[];
  products: MenuProduct[];
  presentations: ProductPresentation[];
  editingRule?: PromotionRule | null;
  onCreated: () => Promise<void>;
  onClose: () => void;
}

export function NewPromotionModal({
  branchId,
  categories,
  products,
  presentations,
  editingRule,
  onCreated,
  onClose,
}: NewPromotionModalProps) {
  const isEditing = Boolean(editingRule);
  const [name, setName] = useState(editingRule?.name ?? "");
  const [ruleType, setRuleType] = useState<PromotionRuleType>(editingRule?.ruleType ?? "bxgy");
  const [applicationMode, setApplicationMode] = useState<PromotionApplicationMode>(
    editingRule?.applicationMode ?? "automatic",
  );
  const [scopeType, setScopeType] = useState<PromotionScopeType>(
    editingRule?.scopeType ?? "category",
  );
  const [targetId, setTargetId] = useState(editingRule?.targetId ?? categories[0]?.id ?? "");
  const [presentationGroups, setPresentationGroups] = useState<PresentationGroup[]>(
    editingRule?.config.presentationGroups ?? [],
  );

  const productNameById = useMemo(
    () => new Map(products.map((p) => [p.id, p.name])),
    [products],
  );

  const availablePresentationGroups = useMemo(() => {
    const groupSet = new Set<PresentationGroup>();
    if (scopeType === "category" && targetId) {
      const catProductIds = new Set(
        products.filter((p) => p.categoryId === targetId).map((p) => p.id),
      );
      for (const pr of presentations) {
        if (catProductIds.has(pr.menuProductId)) {
          groupSet.add(pr.presentationGroup);
        }
      }
    } else if (scopeType === "product" && targetId) {
      for (const pr of presentations) {
        if (pr.menuProductId === targetId) {
          groupSet.add(pr.presentationGroup);
        }
      }
    } else if (scopeType === "order") {
      for (const pr of presentations) {
        groupSet.add(pr.presentationGroup);
      }
    }
    for (const g of presentationGroups) {
      groupSet.add(g);
    }
    return groupSet.size > 0 ? Array.from(groupSet) : FALLBACK_GROUPS;
  }, [scopeType, targetId, products, presentations, presentationGroups]);

  const togglePresentationGroup = (group: PresentationGroup) => {
    haptics.tap();
    setPresentationGroups((prev) =>
      prev.includes(group) ? prev.filter((g) => g !== group) : [...prev, group],
    );
  };

  // Cantidad / Porcentaje / Precio fijo
  const [buyQty, setBuyQty] = useState(String(editingRule?.config.buyQty ?? 3));
  const [payQty, setPayQty] = useState(String(editingRule?.config.payQty ?? 2));
  const [percent, setPercent] = useState(String(editingRule?.config.percent ?? 20));
  const [fixedAmount, setFixedAmount] = useState(String(editingRule?.config.fixedAmount ?? 2000));
  const [fixedUnitPrice, setFixedUnitPrice] = useState(
    String(editingRule?.config.fixedUnitPrice ?? 10000),
  );
  const [minQuantity, setMinQuantity] = useState(String(editingRule?.config.minQuantity ?? 1));

  // Días, horario y rango de fechas (ej. Marzo Mes de la Mujer)
  const [daysOfWeek, setDaysOfWeek] = useState<number[]>(
    editingRule?.daysOfWeek && editingRule.daysOfWeek.length > 0
      ? editingRule.daysOfWeek
      : [1, 2, 3, 4, 5, 6, 7],
  );
  const [startTime, setStartTime] = useState(editingRule?.startTime ?? "00:00");
  const [endTime, setEndTime] = useState(editingRule?.endTime ?? "23:59");
  const [validFrom, setValidFrom] = useState(editingRule?.validFrom ?? "");
  const [validUntil, setValidUntil] = useState(editingRule?.validUntil ?? "");

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const applyPreset = (preset: PromoPreset) => {
    haptics.tap();
    setPresentationGroups([]);
    if (preset === "bxgy_3x2_women") {
      setName("Mes de la Mujer · Mesa con Chicas 3x2");
      setRuleType("bxgy");
      setBuyQty("3");
      setPayQty("2");
      setMinQuantity("1");
      setApplicationMode("manual_at_checkout");
      setScopeType("category");
      setTargetId(categories[0]?.id ?? "");
      setDaysOfWeek([1, 2, 3, 4, 5, 6, 7]);
      setStartTime("00:00");
      setEndTime("23:59");
      const year = new Date().getFullYear();
      setValidFrom(`${year}-03-01`);
      setValidUntil(`${year}-03-31`);
    } else if (preset === "ten_plus_one") {
      setName("Toma 10 y la 11 es Gratis");
      setRuleType("bxgy");
      setBuyQty("11");
      setPayQty("10");
      setMinQuantity("1");
      setApplicationMode("automatic");
      setScopeType("category");
      setTargetId(categories[0]?.id ?? "");
      setDaysOfWeek([1, 2, 3, 4, 5, 6, 7]);
      setStartTime("00:00");
      setEndTime("23:59");
      setValidFrom("");
      setValidUntil("");
    } else if (preset === "happy_hour") {
      setName("Happy Hour -20% (Lun a Jue)");
      setRuleType("percentage_discount");
      setPercent("20");
      setMinQuantity("1");
      setApplicationMode("automatic");
      setScopeType("category");
      setTargetId(categories[0]?.id ?? "");
      setDaysOfWeek([1, 2, 3, 4]);
      setStartTime("16:00");
      setEndTime("20:00");
      setValidFrom("");
      setValidUntil("");
    } else if (preset === "qty_percent") {
      setName("Desde 6 Cervezas -15%");
      setRuleType("percentage_discount");
      setPercent("15");
      setMinQuantity("6");
      setApplicationMode("automatic");
      setScopeType("category");
      setTargetId(categories[0]?.id ?? "");
      setDaysOfWeek([1, 2, 3, 4, 5, 6, 7]);
      setStartTime("00:00");
      setEndTime("23:59");
      setValidFrom("");
      setValidUntil("");
    }
  };

  const toggleDay = (dayId: number) => {
    haptics.tap();
    setDaysOfWeek((prev) =>
      prev.includes(dayId) ? prev.filter((d) => d !== dayId) : [...prev, dayId].sort(),
    );
  };

  const handleSubmit = async () => {
    setError(null);
    if (!name.trim()) {
      setError("Escribe un nombre para la promoción.");
      return;
    }
    if (ruleType === "bxgy" && Number(buyQty) <= Number(payQty)) {
      setError("En Lleva X / Paga Y, la cantidad que lleva debe ser mayor a la que paga (ej. Lleva 11, Paga 10).");
      return;
    }

    const config: Record<string, unknown> = {
      minQuantity: Math.max(1, Number(minQuantity) || 1),
    };
    if (ruleType === "bxgy") {
      config.buyQty = Number(buyQty) || 2;
      config.payQty = Number(payQty) || 1;
    } else if (ruleType === "percentage_discount") {
      config.percent = Number(percent) || 10;
    } else if (ruleType === "fixed_discount") {
      config.fixedAmount = Number(fixedAmount) || 0;
    } else if (ruleType === "fixed_price") {
      config.fixedUnitPrice = Number(fixedUnitPrice) || 0;
    }
    if (scopeType !== "presentation" && presentationGroups.length > 0) {
      config.presentationGroups = presentationGroups;
    }

    setSaving(true);
    try {
      const endpoint = editingRule
        ? `/api/v1/branches/${branchId}/promotions/${editingRule.id}`
        : `/api/v1/branches/${branchId}/promotions`;

      await apiFetch(endpoint, {
        method: editingRule ? "PATCH" : "POST",
        body: JSON.stringify({
          name: name.trim(),
          ruleType,
          scopeType,
          applicationMode,
          targetId: scopeType === "order" ? null : targetId || null,
          daysOfWeek: daysOfWeek.length > 0 ? daysOfWeek : null,
          startTime: startTime || null,
          endTime: endTime || null,
          validFrom: validFrom || null,
          validUntil: validUntil || null,
          config,
          isActive: editingRule ? editingRule.isActive : true,
        }),
      });
      haptics.success();
      await onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar la promoción.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/75 backdrop-blur-sm sm:items-center sm:p-4">
      <div className="material-thick safe-bottom flex max-h-[92dvh] w-full max-w-2xl flex-col overflow-hidden rounded-t-3xl border border-white/10 sm:rounded-3xl">
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <div>
            <h2 className="font-display text-lg font-bold">
              {isEditing ? "Editar Promoción" : "Crear Promoción Configurable"}
            </h2>
            <p className="text-xs text-muted-foreground">
              Por días, fechas (ej. marzo), cantidad acumulada (10+1 gratis), porcentaje o botón
              manual al cobrar
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="press-response flex h-10 w-10 items-center justify-center rounded-xl bg-secondary"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          {/* Plantillas rápidas de ejemplos reales */}
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Plantillas de 1 toque (todas editables)
            </p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <button
                type="button"
                onClick={() => applyPreset("bxgy_3x2_women")}
                className="press-response flex flex-col items-start gap-1 rounded-xl border border-accent/35 bg-accent/10 p-2.5 text-left text-xs"
              >
                <Users className="h-4 w-4 text-accent" />
                <span className="font-bold">Mes Mujer 3x2</span>
                <span className="text-[10px] text-muted-foreground">Marzo · Manual en caja</span>
              </button>
              <button
                type="button"
                onClick={() => applyPreset("ten_plus_one")}
                className="press-response flex flex-col items-start gap-1 rounded-xl border border-primary/35 bg-primary/10 p-2.5 text-left text-xs"
              >
                <Gift className="h-4 w-4 text-primary" />
                <span className="font-bold">10 + 1 Gratis</span>
                <span className="text-[10px] text-muted-foreground">Acumulado en cuenta</span>
              </button>
              <button
                type="button"
                onClick={() => applyPreset("happy_hour")}
                className="press-response flex flex-col items-start gap-1 rounded-xl border border-warning/35 bg-warning/10 p-2.5 text-left text-xs"
              >
                <Calendar className="h-4 w-4 text-warning" />
                <span className="font-bold">Happy Hour %</span>
                <span className="text-[10px] text-muted-foreground">Días + franja horaria</span>
              </button>
              <button
                type="button"
                onClick={() => applyPreset("qty_percent")}
                className="press-response flex flex-col items-start gap-1 rounded-xl border border-success/35 bg-success/10 p-2.5 text-left text-xs"
              >
                <Percent className="h-4 w-4 text-success" />
                <span className="font-bold">Por Cantidad %</span>
                <span className="text-[10px] text-muted-foreground">Desde 6+ unidades</span>
              </button>
            </div>
          </div>

          {/* 1. Nombre y Modo de aplicación */}
          <div className="solid-card space-y-3 rounded-2xl p-4">
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">
                Nombre de la promoción *
              </label>
              <input
                type="text"
                placeholder="Ej. Mes de la Mujer 3x2 / Toma 10 y la 11 gratis"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full rounded-xl border border-white/15 bg-background px-3 py-2.5 text-sm font-semibold focus:border-primary focus:outline-none"
              />
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => setApplicationMode("automatic")}
                className={`press-response rounded-xl border p-3 text-left text-xs ${
                  applicationMode === "automatic"
                    ? "border-primary bg-primary/15 text-foreground"
                    : "border-white/10 bg-background/50 text-muted-foreground"
                }`}
              >
                <p className="flex items-center gap-1.5 font-bold">
                  <Zap className="h-3.5 w-3.5 text-primary" />
                  Automática
                </p>
                <p className="mt-0.5 text-[11px] opacity-80">
                  Se aplica sola al cumplir día, hora o cantidad (ej. Happy Hour, 10+1 gratis).
                </p>
              </button>
              <button
                type="button"
                onClick={() => setApplicationMode("manual_at_checkout")}
                className={`press-response rounded-xl border p-3 text-left text-xs ${
                  applicationMode === "manual_at_checkout"
                    ? "border-accent bg-accent/15 text-foreground"
                    : "border-white/10 bg-background/50 text-muted-foreground"
                }`}
              >
                <p className="flex items-center gap-1.5 font-bold">
                  <Tag className="h-3.5 w-3.5 text-accent" />
                  Manual al Cobrar (Condicional)
                </p>
                <p className="mt-0.5 text-[11px] opacity-80">
                  Aparece como botón al cobrar para mesas que cumplan (ej. mesa con chicas en marzo).
                </p>
              </button>
            </div>
          </div>

          {/* 2. Regla y Mecánica (Cantidad, Porcentaje, Descuento fijo, Precio fijo) */}
          <div className="solid-card space-y-3 rounded-2xl p-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">Tipo de beneficio</label>
                <select
                  value={ruleType}
                  onChange={(e) => setRuleType(e.target.value as PromotionRuleType)}
                  className="w-full rounded-xl border border-white/15 bg-background px-3 py-2.5 text-sm"
                >
                  <option value="bxgy">Lleva X, Paga Y (2x1, 3x2, 10+1 gratis)</option>
                  <option value="percentage_discount">Porcentaje de descuento (%)</option>
                  <option value="fixed_discount">Descuento fijo por unidad ($)</option>
                  <option value="fixed_price">Precio especial fijo ($)</option>
                </select>
              </div>

              <div>
                <label className="mb-1 block text-xs text-muted-foreground">Aplica sobre</label>
                <select
                  value={scopeType}
                  onChange={(e) => {
                    const next = e.target.value as PromotionScopeType;
                    setScopeType(next);
                    setPresentationGroups([]);
                    if (next === "category") setTargetId(categories[0]?.id ?? "");
                    else if (next === "product") setTargetId(products[0]?.id ?? "");
                    else if (next === "presentation") setTargetId(presentations[0]?.id ?? "");
                    else setTargetId("");
                  }}
                  className="w-full rounded-xl border border-white/15 bg-background px-3 py-2.5 text-sm"
                >
                  <option value="category">Una Categoría (ej. Cervezas Artesanales)</option>
                  <option value="product">Un Producto específico</option>
                  <option value="presentation">Una Presentación puntual de 1 producto</option>
                  <option value="order">Toda la carta</option>
                </select>
              </div>
            </div>

            {scopeType !== "order" && (
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">Objetivo</label>
                <select
                  value={targetId}
                  onChange={(e) => {
                    setTargetId(e.target.value);
                    setPresentationGroups([]);
                  }}
                  className="w-full rounded-xl border border-white/15 bg-background px-3 py-2 text-sm"
                >
                  {scopeType === "category" &&
                    categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  {scopeType === "product" &&
                    products.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  {scopeType === "presentation" &&
                    presentations.map((pr) => (
                      <option key={pr.id} value={pr.id}>
                        {productNameById.get(pr.menuProductId) ?? "Producto"} — {pr.name}
                      </option>
                    ))}
                </select>
              </div>
            )}

            {scopeType !== "presentation" && (
              <div className="rounded-xl border border-white/10 bg-background/50 p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <label className="text-xs font-semibold text-foreground">
                    Filtrar por presentación (opcional)
                  </label>
                  <span className="text-[11px] text-muted-foreground">
                    {presentationGroups.length === 0
                      ? "Todas las presentaciones"
                      : `Solo: ${presentationGroups.map((g) => PRESENTATION_GROUP_LABELS[g]).join(", ")}`}
                  </span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      haptics.tap();
                      setPresentationGroups([]);
                    }}
                    className={`press-response rounded-lg border px-2.5 py-1.5 text-xs font-bold transition ${
                      presentationGroups.length === 0
                        ? "border-primary bg-primary/20 text-primary"
                        : "border-white/10 bg-secondary/60 text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    Todas
                  </button>
                  {availablePresentationGroups.map((group) => {
                    const selected = presentationGroups.includes(group);
                    return (
                      <button
                        key={group}
                        type="button"
                        onClick={() => togglePresentationGroup(group)}
                        className={`press-response rounded-lg border px-2.5 py-1.5 text-xs font-bold transition ${
                          selected
                            ? "border-success bg-success/20 text-success"
                            : "border-white/10 bg-secondary/60 text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        {PRESENTATION_GROUP_LABELS[group]}
                      </button>
                    );
                  })}
                </div>
                <p className="mt-2 text-[11px] text-muted-foreground">
                  Ej.: elige categoría <strong>Cervezas Artesanales</strong> y marca solo{" "}
                  <strong>Pinta</strong> o solo <strong>Jirafa</strong> para aplicar a todas las
                  cervezas en ese formato.
                </p>
              </div>
            )}

            {ruleType === "bxgy" ? (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">
                    Lleva (total en la cuenta)
                  </label>
                  <input
                    type="number"
                    min={2}
                    value={buyQty}
                    onChange={(e) => setBuyQty(e.target.value)}
                    className="w-full rounded-xl border border-white/15 bg-background px-3 py-2 text-base font-bold tabular-nums"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">Solo paga</label>
                  <input
                    type="number"
                    min={1}
                    value={payQty}
                    onChange={(e) => setPayQty(e.target.value)}
                    className="w-full rounded-xl border border-white/15 bg-background px-3 py-2 text-base font-bold tabular-nums text-success"
                  />
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">
                    {ruleType === "percentage_discount"
                      ? "Porcentaje (%)"
                      : ruleType === "fixed_discount"
                        ? "Descuento por unidad (COP)"
                        : "Precio especial unitario (COP)"}
                  </label>
                  <input
                    type="number"
                    min={0}
                    value={
                      ruleType === "percentage_discount"
                        ? percent
                        : ruleType === "fixed_discount"
                          ? fixedAmount
                          : fixedUnitPrice
                    }
                    onChange={(e) => {
                      if (ruleType === "percentage_discount") setPercent(e.target.value);
                      else if (ruleType === "fixed_discount") setFixedAmount(e.target.value);
                      else setFixedUnitPrice(e.target.value);
                    }}
                    className="w-full rounded-xl border border-white/15 bg-background px-3 py-2 text-base font-bold tabular-nums text-success"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">
                    Cantidad mínima acumulada
                  </label>
                  <input
                    type="number"
                    min={1}
                    value={minQuantity}
                    onChange={(e) => setMinQuantity(e.target.value)}
                    className="w-full rounded-xl border border-white/15 bg-background px-3 py-2 text-base font-bold tabular-nums"
                  />
                </div>
              </div>
            )}
          </div>

          {/* 3. Días, Horarios y Fechas de Temporada */}
          <div className="solid-card space-y-3 rounded-2xl p-4">
            <div>
              <p className="mb-2 text-xs text-muted-foreground">Días activos</p>
              <div className="grid grid-cols-7 gap-1.5">
                {DAYS.map((d) => {
                  const active = daysOfWeek.includes(d.id);
                  return (
                    <button
                      key={d.id}
                      type="button"
                      onClick={() => toggleDay(d.id)}
                      className={`press-response min-h-10 rounded-xl text-xs font-bold ${
                        active
                          ? "bg-primary text-primary-foreground"
                          : "bg-secondary text-muted-foreground"
                      }`}
                    >
                      {d.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">Hora inicio</label>
                <input
                  type="time"
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                  className="w-full rounded-xl border border-white/15 bg-background px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">Hora fin</label>
                <input
                  type="time"
                  value={endTime}
                  onChange={(e) => setEndTime(e.target.value)}
                  className="w-full rounded-xl border border-white/15 bg-background px-3 py-2 text-sm"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">
                  Válida desde (opcional, ej. marzo)
                </label>
                <input
                  type="date"
                  value={validFrom}
                  onChange={(e) => setValidFrom(e.target.value)}
                  className="w-full rounded-xl border border-white/15 bg-background px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">
                  Válida hasta (opcional)
                </label>
                <input
                  type="date"
                  value={validUntil}
                  onChange={(e) => setValidUntil(e.target.value)}
                  className="w-full rounded-xl border border-white/15 bg-background px-3 py-2 text-sm"
                />
              </div>
            </div>
          </div>

          {error && (
            <div className="rounded-xl border border-destructive/40 bg-destructive/15 px-3.5 py-2.5 text-xs font-semibold text-destructive">
              {error}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-3 border-t border-white/10 px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            className="press-response min-h-12 rounded-xl bg-secondary px-5 text-sm font-semibold"
          >
            Cancelar
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={handleSubmit}
            className="press-response flex min-h-12 items-center gap-2 rounded-xl bg-success px-6 text-sm font-bold text-primary-foreground disabled:opacity-50"
          >
            <Sparkles className="h-4 w-4" />
            {saving ? "Guardando..." : isEditing ? "Guardar Cambios" : "Guardar Promoción"}
          </button>
        </div>
      </div>
    </div>
  );
}

