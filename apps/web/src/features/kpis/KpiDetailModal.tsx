import { ArrowDownRight, ArrowUpRight, Award, BarChart3, Droplets, TrendingUp, Users, X } from "lucide-react";
import { formatBaseQuantity, formatCOP } from "../../shared/lib/format.js";
import { haptics } from "../../shared/lib/haptics.js";

export type KpiPeriod = "daily" | "weekly" | "monthly" | "all";
export type KpiModalTopic = "sales" | "foam" | "credit" | "discounts" | "products" | "presentations";

export interface KpiResponse {
  period: KpiPeriod;
  periodLabel: string;
  comparisonLabel: string;
  summary: {
    totalNetSales: number;
    totalDiscounts: number;
    totalUnitsSold: number;
    totalTickets: number;
  };
  previousSummary: {
    totalNetSales: number;
    totalDiscounts: number;
    totalUnitsSold: number;
    totalTickets: number;
    totalFoamLossBase: number;
  };
  deltas: {
    salesPct: number | null;
    discountsPct: number | null;
    unitsPct: number | null;
    ticketsPct: number | null;
    foamPct: number | null;
  };
  evolution: Array<{
    bucket: string;
    label: string;
    netSales: number;
    discounts: number;
    unitsSold: number;
    tickets: number;
    foamLossBase: number;
  }>;
  salesByCategory: Array<{
    categoryId: string;
    categoryName: string;
    unitsSold: number;
    revenue: number;
  }>;
  topProducts: Array<{
    productId: string;
    productName: string;
    unitsSold: number;
    revenue: number;
  }>;
  topPresentations: Array<{
    presentationId: string;
    productName: string;
    presentationName: string;
    presentationGroup: string;
    unitsSold: number;
    revenue: number;
  }>;
  inventoryHealth: Array<{
    id: string;
    name: string;
    baseUnit: "ml" | "g" | "unit";
    isKeg: boolean;
    currentStockBase: number;
    minStockBase: number;
    defaultPourLossPercent: number;
  }>;
  foamAnalytics: {
    totalNominalSoldBase: number;
    totalFoamLossBase: number;
    foamRatioPercent: number;
  };
  creditPortfolio: {
    totalPendingCredit: number;
    debtorCount: number;
    blacklistedCount: number;
  };
  debtors: Array<{
    id: string;
    fullName: string;
    nickname?: string | null;
    creditStatus: string;
    creditLimit?: number | null;
    currentDebt: number;
  }>;
}

const PERIOD_OPTIONS: Array<{ id: KpiPeriod; label: string }> = [
  { id: "daily", label: "Diario" },
  { id: "weekly", label: "Semanal" },
  { id: "monthly", label: "Mensual" },
  { id: "all", label: "Todo" },
];

export function DeltaBadge({ pct, label }: { pct: number | null; label: string }) {
  if (pct === null) {
    return <span className="text-[11px] text-muted-foreground">{label}</span>;
  }
  const positive = pct >= 0;
  return (
    <span
      className={`inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[11px] font-bold tabular-nums ${
        positive ? "bg-success/15 text-success" : "bg-destructive/15 text-destructive"
      }`}
    >
      {positive ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
      {positive ? "+" : ""}
      {pct}% {label}
    </span>
  );
}

function EvolutionBarChart({
  points,
  barColorClass,
  formatValue,
}: {
  points: Array<{ label: string; value: number; sublabel?: string }>;
  barColorClass: string;
  formatValue: (v: number) => string;
}) {
  const maxVal = Math.max(1, ...points.map((p) => p.value));

  return (
    <div className="rounded-2xl border border-white/10 bg-background/60 p-4">
      <div className="flex h-44 items-end gap-2">
        {points.map((pt, idx) => {
          const heightPct = pt.value > 0 ? Math.max(10, Math.round((pt.value / maxVal) * 100)) : 3;
          return (
            <div key={idx} className="group flex h-full flex-1 flex-col items-center justify-end gap-1.5">
              <span className="text-center text-[10px] font-bold tabular-nums text-foreground/90">
                {pt.value > 0 ? formatValue(pt.value) : ""}
              </span>
              <div className="flex w-full flex-1 items-end">
                <div
                  className={`w-full rounded-t-lg transition-all ${pt.value > 0 ? barColorClass : "bg-white/10"}`}
                  style={{ height: `${heightPct}%` }}
                  title={`${pt.label}: ${formatValue(pt.value)}`}
                />
              </div>
              <span className="truncate text-[10px] font-semibold text-muted-foreground">
                {pt.label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function KpiDetailModal({
  topic,
  data,
  period,
  onChangePeriod,
  onClose,
}: {
  topic: KpiModalTopic;
  data: KpiResponse;
  period: KpiPeriod;
  onChangePeriod: (p: KpiPeriod) => void;
  onClose: () => void;
}) {
  const titles: Record<KpiModalTopic, { title: string; subtitle: string; icon: typeof TrendingUp }> = {
    sales: {
      title: "Evolución y Comparación de Ventas",
      subtitle:
        period === "daily"
          ? "Comportamiento por hora hoy vs. ayer"
          : period === "weekly"
            ? "Últimos 7 días vs. semana anterior"
            : "Evolución mensual (últimos 6 meses) y desglose por categoría",
      icon: TrendingUp,
    },
    foam: {
      title: "Evolución de Merma por Espuma y Purga",
      subtitle: "Seguimiento del desgaste en barriles y licores por periodo",
      icon: Droplets,
    },
    discounts: {
      title: "Promociones y Cortesías Otorgadas",
      subtitle: "Control de descuentos acumulados frente a ventas netas",
      icon: Award,
    },
    credit: {
      title: "Detalle de Cartera Pendiente (Fiado)",
      subtitle: "Clientes con saldo activo y estado de crédito",
      icon: Users,
    },
    products: {
      title: "Ranking Completo de Productos",
      subtitle: `Desempeño por producto · ${data.periodLabel}`,
      icon: BarChart3,
    },
    presentations: {
      title: "Ranking Completo de Presentaciones",
      subtitle: `Pintas, Vasos, Jirafas, Shots y Combos · ${data.periodLabel}`,
      icon: BarChart3,
    },
  };

  const meta = titles[topic];
  const Icon = meta.icon;
  const evolution = data.evolution ?? [];
  const salesByCategory = data.salesByCategory ?? [];
  const debtors = data.debtors ?? [];
  const topProducts = data.topProducts ?? [];
  const topPresentations = data.topPresentations ?? [];
  const deltas = data.deltas ?? {
    salesPct: null,
    discountsPct: null,
    unitsPct: null,
    ticketsPct: null,
    foamPct: null,
  };
  const previousSummary = data.previousSummary ?? {
    totalNetSales: 0,
    totalDiscounts: 0,
    totalUnitsSold: 0,
    totalTickets: 0,
    totalFoamLossBase: 0,
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/75 backdrop-blur-sm sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        className="material-thick safe-bottom flex max-h-[92dvh] w-full max-w-3xl flex-col overflow-hidden rounded-t-3xl border border-white/10 sm:rounded-3xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mt-2.5 h-1.5 w-12 rounded-full bg-white/20 sm:hidden" />

        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-white/10 px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-primary/15 text-primary">
              <Icon className="h-5 w-5" />
            </div>
            <div>
              <h3 className="font-display text-lg font-bold">{meta.title}</h3>
              <p className="text-xs text-muted-foreground">{meta.subtitle}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="press-response flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-secondary"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Selector de periodo dentro del modal */}
        <div className="flex items-center gap-1.5 border-b border-white/10 px-5 py-3">
          {PERIOD_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              onClick={() => {
                haptics.tap();
                onChangePeriod(opt.id);
              }}
              className={`press-response min-h-10 flex-1 rounded-xl text-xs font-bold ${
                period === opt.id
                  ? "bg-primary text-primary-foreground"
                  : "bg-secondary/70 text-muted-foreground"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* Contenido dinámico del modal */}
        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          {topic === "sales" && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div className="solid-card rounded-2xl p-4 tabular-nums">
                  <p className="text-xs text-muted-foreground">{data.periodLabel}</p>
                  <p className="mt-1 font-display text-2xl font-bold text-primary">
                    {formatCOP(data.summary.totalNetSales)}
                  </p>
                  <div className="mt-1.5">
                    <DeltaBadge pct={deltas.salesPct} label={data.comparisonLabel ?? ""} />
                  </div>
                </div>
                <div className="solid-card rounded-2xl p-4 tabular-nums">
                  <p className="text-xs text-muted-foreground">Periodo anterior</p>
                  <p className="mt-1 font-display text-2xl font-bold text-muted-foreground">
                    {formatCOP(previousSummary.totalNetSales)}
                  </p>
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    {data.summary.totalTickets} cuentas ({data.summary.totalUnitsSold} ítems)
                  </p>
                </div>
              </div>

              <div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {period === "daily"
                    ? "Ventas por hora (Hoy)"
                    : period === "weekly"
                      ? "Ventas últimos 7 días"
                      : "Comparación mensual (Últimos 6 meses)"}
                </p>
                <EvolutionBarChart
                  points={evolution.map((e) => ({ label: e.label, value: e.netSales }))}
                  barColorClass="bg-primary"
                  formatValue={(v) => (v >= 1000 ? `$${Math.round(v / 1000)}k` : `$${v}`)}
                />
              </div>

              {salesByCategory.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Ventas por Categoría ({data.periodLabel})
                  </p>
                  <div className="space-y-2">
                    {salesByCategory.map((cat) => {
                      const share =
                        data.summary.totalNetSales > 0
                          ? Math.round((cat.revenue / data.summary.totalNetSales) * 100)
                          : 0;
                      return (
                        <div
                          key={cat.categoryId}
                          className="rounded-xl border border-white/10 bg-background/50 p-3 text-xs"
                        >
                          <div className="flex justify-between font-bold">
                            <span>{cat.categoryName}</span>
                            <span className="tabular-nums text-primary">
                              {formatCOP(cat.revenue)} ({share}%) · {cat.unitsSold} und
                            </span>
                          </div>
                          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-secondary">
                            <div className="h-full bg-primary" style={{ width: `${share}%` }} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          )}

          {topic === "foam" && (
            <>
              <div className="grid grid-cols-2 gap-3 tabular-nums">
                <div className="solid-card rounded-2xl p-4">
                  <p className="text-xs text-muted-foreground">Espuma / Purga ({data.periodLabel})</p>
                  <p className="mt-1 font-display text-2xl font-bold text-warning">
                    {formatBaseQuantity(data.foamAnalytics.totalFoamLossBase, "ml")}
                  </p>
                  <div className="mt-1.5">
                    <DeltaBadge pct={deltas.foamPct} label={data.comparisonLabel ?? ""} />
                  </div>
                </div>
                <div className="solid-card rounded-2xl p-4">
                  <p className="text-xs text-muted-foreground">Proporción vs. Servido</p>
                  <p className="mt-1 font-display text-2xl font-bold text-foreground">
                    {data.foamAnalytics.foamRatioPercent}%
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Servido: {formatBaseQuantity(data.foamAnalytics.totalNominalSoldBase, "ml")}
                  </p>
                </div>
              </div>

              <EvolutionBarChart
                points={evolution.map((e) => ({ label: e.label, value: e.foamLossBase }))}
                barColorClass="bg-warning"
                formatValue={(v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}L` : `${Math.round(v)}ml`)}
              />
            </>
          )}

          {topic === "discounts" && (
            <>
              <div className="grid grid-cols-2 gap-3 tabular-nums">
                <div className="solid-card rounded-2xl p-4">
                  <p className="text-xs text-muted-foreground">
                    Promos y Cortesías ({data.periodLabel})
                  </p>
                  <p className="mt-1 font-display text-2xl font-bold text-success">
                    {formatCOP(data.summary.totalDiscounts)}
                  </p>
                  <div className="mt-1.5">
                    <DeltaBadge pct={deltas.discountsPct} label={data.comparisonLabel ?? ""} />
                  </div>
                </div>
                <div className="solid-card rounded-2xl p-4">
                  <p className="text-xs text-muted-foreground">% sobre ventas brutas</p>
                  <p className="mt-1 font-display text-2xl font-bold text-foreground">
                    {data.summary.totalNetSales + data.summary.totalDiscounts > 0
                      ? `${(
                          (data.summary.totalDiscounts /
                            (data.summary.totalNetSales + data.summary.totalDiscounts)) *
                          100
                        ).toFixed(1)}%`
                      : "0%"}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Anterior: {formatCOP(previousSummary.totalDiscounts)}
                  </p>
                </div>
              </div>

              <EvolutionBarChart
                points={evolution.map((e) => ({ label: e.label, value: e.discounts }))}
                barColorClass="bg-success"
                formatValue={(v) => (v >= 1000 ? `$${Math.round(v / 1000)}k` : `$${v}`)}
              />
            </>
          )}

          {topic === "credit" && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3 tabular-nums">
                <div className="solid-card rounded-2xl p-4">
                  <p className="text-xs text-muted-foreground">Total Cartera por Cobrar</p>
                  <p className="mt-1 font-display text-2xl font-bold text-accent">
                    {formatCOP(data.creditPortfolio.totalPendingCredit)}
                  </p>
                </div>
                <div className="solid-card rounded-2xl p-4">
                  <p className="text-xs text-muted-foreground">Clientes con saldo / Lista Negra</p>
                  <p className="mt-1 font-display text-2xl font-bold">
                    {data.creditPortfolio.debtorCount} /{" "}
                    <span className="text-destructive">{data.creditPortfolio.blacklistedCount}</span>
                  </p>
                </div>
              </div>

              <div className="space-y-2">
                {debtors.length === 0 ? (
                  <p className="py-6 text-center text-xs text-muted-foreground">
                    No hay clientes con cartera pendiente.
                  </p>
                ) : (
                  debtors.map((d) => (
                    <div
                      key={d.id}
                      className="flex items-center justify-between rounded-xl border border-white/10 bg-background/50 p-3 text-sm"
                    >
                      <div>
                        <p className="font-bold">
                          {d.fullName} {d.nickname ? `("${d.nickname}")` : ""}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {d.creditStatus === "blacklist_blocked"
                            ? "Lista Negra"
                            : d.creditStatus === "whitelist_credit"
                              ? "Lista Blanca"
                              : "Estándar"}
                          {d.creditLimit ? ` · Cupo ${formatCOP(d.creditLimit)}` : ""}
                        </p>
                      </div>
                      <span className="font-bold tabular-nums text-accent">
                        {formatCOP(d.currentDebt)}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {topic === "products" && (
            <div className="space-y-2.5">
              {topProducts.length === 0 ? (
                <p className="py-8 text-center text-xs text-muted-foreground">
                  Sin ventas registradas en {data.periodLabel}.
                </p>
              ) : (
                topProducts.map((p, idx) => {
                  const share =
                    data.summary.totalNetSales > 0
                      ? Math.round((p.revenue / data.summary.totalNetSales) * 100)
                      : 0;
                  return (
                    <div
                      key={p.productId}
                      className="rounded-xl border border-white/10 bg-background/50 p-3 text-sm"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-bold">
                          #{idx + 1} {p.productName}
                        </span>
                        <span className="tabular-nums font-bold text-primary">
                          {formatCOP(p.revenue)} ({share}%)
                        </span>
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {p.unitsSold} unidades vendidas en {data.periodLabel}
                      </p>
                    </div>
                  );
                })
              )}
            </div>
          )}

          {topic === "presentations" && (
            <div className="space-y-2.5">
              {topPresentations.length === 0 ? (
                <p className="py-8 text-center text-xs text-muted-foreground">
                  Sin ventas registradas en {data.periodLabel}.
                </p>
              ) : (
                topPresentations.map((pr, idx) => (
                  <div
                    key={pr.presentationId}
                    className="rounded-xl border border-white/10 bg-background/50 p-3 text-sm"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <span className="font-bold">
                          #{idx + 1} {pr.presentationName}
                        </span>{" "}
                        <span className="text-xs text-muted-foreground">· {pr.productName}</span>
                      </div>
                      <span className="tabular-nums font-bold text-warning">
                        {pr.unitsSold} und · {formatCOP(pr.revenue)}
                      </span>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

