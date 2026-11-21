import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  Award,
  Beer,
  Building2,
  ChevronRight,
  Droplets,
  RefreshCw,
  ShieldAlert,
  TrendingUp,
  Users,
} from "lucide-react";
import { apiFetch } from "../../infrastructure/api/api-client.js";
import type { useLiquiStock } from "../../infrastructure/sync/useLiquiStock.js";
import { formatBaseQuantity, formatCOP } from "../../shared/lib/format.js";
import { haptics } from "../../shared/lib/haptics.js";
import {
  DeltaBadge,
  KpiDetailModal,
  type KpiModalTopic,
  type KpiPeriod,
  type KpiResponse,
} from "./KpiDetailModal.js";

type StoreType = ReturnType<typeof useLiquiStock>;

const PERIOD_PILLS: Array<{ id: KpiPeriod; label: string }> = [
  { id: "daily", label: "Diario" },
  { id: "weekly", label: "Semanal" },
  { id: "monthly", label: "Mensual" },
  { id: "all", label: "Todo" },
];

interface SmartAlert {
  id: string;
  type: "low_stock" | "credit_limit" | "foam_high" | "cash_discrepancy";
  severity: "critical" | "warning" | "info";
  title: string;
  detail: string;
}

interface AuditEntry {
  id: string;
  eventType: "void" | "courtesy" | "price_adjustment" | "promotion_discount";
  productName: string;
  presentationName: string;
  quantity: number;
  originalTotal: number;
  discountAmount: number;
  finalTotal: number;
  reason: string | null;
  actorName: string | null;
  createdAt: string;
}

interface MultiBranchResponse {
  period: KpiPeriod;
  consolidated: {
    totalNetSales: number;
    totalDiscounts: number;
    totalUnitsSold: number;
    totalTickets: number;
    totalFoamLossBase: number;
    totalPendingCredit: number;
    totalLowStockCount: number;
  } | null;
  branches: Array<{
    branchId: string;
    branchName: string;
    organizationName: string;
    netSales: number;
    discounts: number;
    unitsSold: number;
    tickets: number;
    foamLossBase: number;
    pendingCredit: number;
    lowStockCount: number;
    salesSharePct: number;
  }>;
}

export function KpisView({ store, branchId }: { store: StoreType; branchId: string }) {
  const [period, setPeriod] = useState<KpiPeriod>("monthly");
  const [data, setData] = useState<KpiResponse | null>(null);
  const [alerts, setAlerts] = useState<SmartAlert[]>([]);
  const [auditLog, setAuditLog] = useState<AuditEntry[]>([]);
  const [multiBranch, setMultiBranch] = useState<MultiBranchResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [modalTopic, setModalTopic] = useState<KpiModalTopic | null>(null);

  const loadKpis = useCallback(
    async (targetPeriod: KpiPeriod = period) => {
      try {
        setLoadError(null);
        const [kpiRes, alertsRes, multiRes] = await Promise.all([
          apiFetch<KpiResponse>(`/api/v1/branches/${branchId}/kpis?period=${targetPeriod}`),
          apiFetch<{ alerts: SmartAlert[]; auditLog: AuditEntry[] }>(
            `/api/v1/branches/${branchId}/alerts-audit`,
          ).catch(() => ({ alerts: [], auditLog: [] })),
          apiFetch<MultiBranchResponse>(`/api/v1/kpis/multi-branch?period=${targetPeriod}`).catch(
            () => null,
          ),
        ]);
        setData(kpiRes);
        setAlerts(alertsRes.alerts ?? []);
        setAuditLog(alertsRes.auditLog ?? []);
        setMultiBranch(multiRes);
      } catch (err) {
        setLoadError(
          err instanceof Error ? err.message : "No se pudo conectar al servidor de KPIs",
        );
      }
    },
    [branchId, period],
  );

  useEffect(() => {
    void loadKpis(period);
  }, [loadKpis, period, store.lastHydratedAt]);

  useEffect(() => {
    if (!loadError || data) return;
    const t = window.setTimeout(() => {
      void loadKpis(period);
    }, 1500);
    return () => window.clearTimeout(t);
  }, [loadError, data, loadKpis, period]);

  const handleChangePeriod = (next: KpiPeriod) => {
    haptics.tap();
    setPeriod(next);
  };

  if (!data) {
    return (
      <div className="solid-card space-y-3 rounded-2xl p-8 text-center text-sm text-muted-foreground">
        <p>
          {loadError
            ? "Reconectando para cargar los KPIs..."
            : "Cargando métricas en tiempo real del bar..."}
        </p>
        {loadError && (
          <button
            type="button"
            onClick={() => void loadKpis(period)}
            className="press-response rounded-xl bg-primary px-4 py-2 text-xs font-bold text-primary-foreground"
          >
            Reintentar ahora
          </button>
        )}
      </div>
    );
  }

  const deltas = data.deltas ?? {
    salesPct: null,
    discountsPct: null,
    unitsPct: null,
    ticketsPct: null,
    foamPct: null,
  };
  const periodLabel = data.periodLabel ?? "Este mes";
  const comparisonLabel = data.comparisonLabel ?? "";
  const topProducts = data.topProducts ?? [];
  const topPresentations = data.topPresentations ?? [];
  const inventoryHealth = data.inventoryHealth ?? [];
  const maxProdRevenue = Math.max(1, ...topProducts.map((p) => p.revenue));
  const maxPresUnits = Math.max(1, ...topPresentations.map((p) => p.unitsSold));

  return (
    <div className="space-y-5">
      {/* Cabecera + Filtros Diario / Semanal / Mensual / Todo */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-xl font-bold">Dashboard, Alertas & KPIs</h2>
          <p className="text-xs text-muted-foreground">
            Toca cualquier tarjeta para ver su evolución detallada y comparación por periodo
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-xl bg-secondary/70 p-1">
            {PERIOD_PILLS.map((pill) => (
              <button
                key={pill.id}
                type="button"
                onClick={() => handleChangePeriod(pill.id)}
                className={`press-response min-h-9 rounded-lg px-3 text-xs font-bold ${
                  period === pill.id
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {pill.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => void loadKpis(period)}
            className="press-response flex min-h-10 items-center gap-1.5 rounded-xl bg-secondary px-3 text-xs font-semibold"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Centro de Alertas Inteligentes */}
      {alerts.length > 0 && (
        <section className="solid-card space-y-2.5 rounded-2xl border-warning/35 p-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-warning" />
              <h3 className="font-display text-sm font-bold">
                Alertas Activas ({alerts.length})
              </h3>
            </div>
            <span className="text-[11px] text-muted-foreground">
              Stock bajo · Cupos de fiado · Espuma · Caja
            </span>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {alerts.slice(0, 6).map((al) => (
              <div
                key={al.id}
                className={`rounded-xl border px-3 py-2.5 text-xs ${
                  al.severity === "critical"
                    ? "border-destructive/40 bg-destructive/10"
                    : "border-warning/35 bg-warning/10"
                }`}
              >
                <p
                  className={`font-bold ${
                    al.severity === "critical" ? "text-destructive" : "text-warning"
                  }`}
                >
                  {al.title}
                </p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">{al.detail}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Tarjetas KPI Principales (Interactivas -> abren Modal de Evolución) */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <button
          type="button"
          onClick={() => {
            haptics.tap();
            setModalTopic("sales");
          }}
          className="solid-card press-response flex flex-col justify-between rounded-2xl p-4 text-left hover:border-primary/50"
        >
          <div>
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>Ventas Netas · {periodLabel}</span>
              <TrendingUp className="h-4 w-4 text-primary" />
            </div>
            <p className="mt-2 font-display text-2xl font-bold tabular-nums text-primary">
              {formatCOP(data.summary?.totalNetSales ?? 0)}
            </p>
          </div>
          <div className="mt-2.5 flex items-center justify-between gap-2">
            <DeltaBadge pct={deltas.salesPct} label={comparisonLabel} />
            <span className="flex items-center text-[11px] font-semibold text-primary">
              Evolución <ChevronRight className="h-3.5 w-3.5" />
            </span>
          </div>
        </button>

        <button
          type="button"
          onClick={() => {
            haptics.tap();
            setModalTopic("foam");
          }}
          className="solid-card press-response flex flex-col justify-between rounded-2xl p-4 text-left hover:border-warning/50"
        >
          <div>
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>Espuma / Purga · {periodLabel}</span>
              <Droplets className="h-4 w-4 text-warning" />
            </div>
            <p className="mt-2 font-display text-2xl font-bold tabular-nums text-warning">
              {formatBaseQuantity(data.foamAnalytics?.totalFoamLossBase ?? 0, "ml")}
            </p>
          </div>
          <div className="mt-2.5 flex items-center justify-between gap-2">
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {data.foamAnalytics?.foamRatioPercent ?? 0}% servido
            </span>
            <span className="flex items-center text-[11px] font-semibold text-warning">
              Detalle <ChevronRight className="h-3.5 w-3.5" />
            </span>
          </div>
        </button>

        <button
          type="button"
          onClick={() => {
            haptics.tap();
            setModalTopic("credit");
          }}
          className="solid-card press-response flex flex-col justify-between rounded-2xl p-4 text-left hover:border-accent/50"
        >
          <div>
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>Cartera Pendiente (Fiado)</span>
              <Users className="h-4 w-4 text-accent" />
            </div>
            <p className="mt-2 font-display text-2xl font-bold tabular-nums text-accent">
              {formatCOP(data.creditPortfolio?.totalPendingCredit ?? 0)}
            </p>
          </div>
          <div className="mt-2.5 flex items-center justify-between gap-2">
            <span className="text-[11px] text-muted-foreground">
              {data.creditPortfolio?.debtorCount ?? 0} deudor(es)
            </span>
            <span className="flex items-center text-[11px] font-semibold text-accent">
              Ver lista <ChevronRight className="h-3.5 w-3.5" />
            </span>
          </div>
        </button>

        <button
          type="button"
          onClick={() => {
            haptics.tap();
            setModalTopic("discounts");
          }}
          className="solid-card press-response flex flex-col justify-between rounded-2xl p-4 text-left hover:border-success/50"
        >
          <div>
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>Promos & Cortesías</span>
              <Award className="h-4 w-4 text-success" />
            </div>
            <p className="mt-2 font-display text-2xl font-bold tabular-nums text-success">
              {formatCOP(data.summary?.totalDiscounts ?? 0)}
            </p>
          </div>
          <div className="mt-2.5 flex items-center justify-between gap-2">
            <DeltaBadge pct={deltas.discountsPct} label={comparisonLabel} />
            <span className="flex items-center text-[11px] font-semibold text-success">
              Evolución <ChevronRight className="h-3.5 w-3.5" />
            </span>
          </div>
        </button>
      </div>

      {/* Comparativa Multi-Sucursal (visible automáticamente cuando el Admin tiene >= 2 sucursales) */}
      {multiBranch && multiBranch.branches.length > 1 && multiBranch.consolidated && (
        <section className="solid-card space-y-3 rounded-2xl border-primary/25 p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Building2 className="h-5 w-5 text-primary" />
              <div>
                <h3 className="font-display text-base font-bold">
                  Comparativa Multi-Sucursal ({periodLabel})
                </h3>
                <p className="text-xs text-muted-foreground">
                  Consolidado total:{" "}
                  <strong className="text-primary">
                    {formatCOP(multiBranch.consolidated.totalNetSales)}
                  </strong>{" "}
                  · {multiBranch.consolidated.totalTickets} cuentas · Cartera global:{" "}
                  {formatCOP(multiBranch.consolidated.totalPendingCredit)}
                </p>
              </div>
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {multiBranch.branches.map((b) => (
              <div
                key={b.branchId}
                className={`rounded-xl border p-3.5 ${
                  b.branchId === branchId
                    ? "border-primary/50 bg-primary/10"
                    : "border-white/10 bg-background/50"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-[10px] font-semibold text-primary">
                      {b.organizationName}
                    </p>
                    <p className="truncate font-display text-sm font-bold">{b.branchName}</p>
                  </div>
                  <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] font-bold tabular-nums">
                    {b.salesSharePct}%
                  </span>
                </div>
                <p className="mt-2 font-display text-lg font-bold tabular-nums text-foreground">
                  {formatCOP(b.netSales)}
                </p>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-background">
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{ width: `${Math.max(4, b.salesSharePct)}%` }}
                  />
                </div>
                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] tabular-nums text-muted-foreground">
                  <span>{b.tickets} cuentas</span>
                  <span>Espuma: {formatBaseQuantity(b.foamLossBase, "ml")}</span>
                  <span>Fiado: {formatCOP(b.pendingCredit)}</span>
                  {b.lowStockCount > 0 && (
                    <span className="font-bold text-destructive">
                      {b.lowStockCount} stock bajo
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Rankings: Producto Más Vendido vs Presentación Más Vendida */}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="solid-card rounded-2xl p-5">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div>
              <h3 className="font-display text-base font-bold">Top Productos ({periodLabel})</h3>
              <p className="text-xs text-muted-foreground">Sumando todas sus presentaciones</p>
            </div>
            <button
              type="button"
              onClick={() => {
                haptics.tap();
                setModalTopic("products");
              }}
              className="press-response flex items-center gap-0.5 rounded-xl bg-secondary px-3 py-1.5 text-xs font-bold text-primary"
            >
              Ampliar <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
          {topProducts.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">
              Sin ventas en {periodLabel.toLowerCase()}.
            </p>
          ) : (
            <div className="space-y-3">
              {topProducts.slice(0, 6).map((p, idx) => (
                <div key={p.productId} className="space-y-1">
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-semibold">
                      #{idx + 1} {p.productName}
                    </span>
                    <span className="font-bold tabular-nums text-primary">
                      {formatCOP(p.revenue)}{" "}
                      <span className="text-xs font-normal text-muted-foreground">
                        ({p.unitsSold} und)
                      </span>
                    </span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-background">
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{ width: `${Math.round((p.revenue / maxProdRevenue) * 100)}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="solid-card rounded-2xl p-5">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div>
              <h3 className="font-display text-base font-bold">
                Top Presentaciones ({periodLabel})
              </h3>
              <p className="text-xs text-muted-foreground">
                Pintas vs Vasos vs Jirafas vs Shots
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                haptics.tap();
                setModalTopic("presentations");
              }}
              className="press-response flex items-center gap-0.5 rounded-xl bg-secondary px-3 py-1.5 text-xs font-bold text-warning"
            >
              Ampliar <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
          {topPresentations.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">
              Sin ventas en {periodLabel.toLowerCase()}.
            </p>
          ) : (
            <div className="space-y-3">
              {topPresentations.slice(0, 6).map((pr, idx) => (
                <div key={pr.presentationId} className="space-y-1">
                  <div className="flex items-center justify-between text-sm">
                    <div>
                      <span className="font-semibold">
                        #{idx + 1} {pr.presentationName}
                      </span>{" "}
                      <span className="text-xs text-muted-foreground">· {pr.productName}</span>
                    </div>
                    <span className="font-bold tabular-nums text-warning">
                      {pr.unitsSold} und{" "}
                      <span className="text-xs font-normal text-muted-foreground">
                        ({formatCOP(pr.revenue)})
                      </span>
                    </span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-background">
                    <div
                      className="h-full rounded-full bg-warning"
                      style={{ width: `${Math.round((pr.unitsSold / maxPresUnits) * 100)}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Salud de Barriles + Auditoría de Cortesías y Anulaciones */}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="solid-card rounded-2xl p-5">
          <div className="mb-3 flex items-center gap-2">
            <Beer className="h-5 w-5 text-warning" />
            <h3 className="font-display text-base font-bold">Nivel Actual de Barriles y Stock</h3>
          </div>
          {inventoryHealth.length === 0 ? (
            <p className="py-4 text-center text-xs text-muted-foreground">
              Aún no hay insumos registrados en inventario.
            </p>
          ) : (
            <div className="grid gap-2.5 sm:grid-cols-2">
              {inventoryHealth.map((inv) => {
                const critical = inv.currentStockBase <= inv.minStockBase;
                return (
                  <div
                    key={inv.id}
                    className={`rounded-xl border p-3 ${
                      critical
                        ? "border-destructive/40 bg-destructive/10"
                        : "border-white/10 bg-background/50"
                    }`}
                  >
                    <p className="truncate text-sm font-bold">{inv.name}</p>
                    <p className="mt-1 text-lg font-bold tabular-nums">
                      {formatBaseQuantity(inv.currentStockBase, inv.baseUnit)}
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      Mínimo alerta: {formatBaseQuantity(inv.minStockBase, inv.baseUnit)}
                    </p>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="solid-card rounded-2xl p-5">
          <div className="mb-3 flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-accent" />
            <div>
              <h3 className="font-display text-base font-bold">
                Auditoría: Cortesías, Ajustes y Anulaciones
              </h3>
              <p className="text-xs text-muted-foreground">
                Control de descuentos manuales y anulaciones por usuario
              </p>
            </div>
          </div>
          {auditLog.length === 0 ? (
            <p className="py-4 text-center text-xs text-muted-foreground">
              Sin cortesías, ajustes ni anulaciones registradas.
            </p>
          ) : (
            <div className="max-h-72 divide-y divide-white/10 overflow-y-auto text-xs tabular-nums">
              {auditLog.slice(0, 15).map((ev) => {
                const badge =
                  ev.eventType === "void"
                    ? { text: "ANULADO", cls: "bg-destructive/20 text-destructive" }
                    : ev.eventType === "courtesy"
                      ? { text: "CORTESÍA", cls: "bg-accent/20 text-accent" }
                      : ev.eventType === "price_adjustment"
                        ? { text: "AJUSTE", cls: "bg-warning/20 text-warning" }
                        : { text: "PROMO", cls: "bg-success/20 text-success" };
                return (
                  <div key={ev.id} className="flex items-start justify-between gap-2 py-2.5">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${badge.cls}`}>
                          {badge.text}
                        </span>
                        <span className="truncate font-semibold">
                          {ev.quantity}x {ev.productName} ({ev.presentationName})
                        </span>
                      </div>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        {ev.actorName ?? "Usuario"} ·{" "}
                        {new Date(ev.createdAt).toLocaleString("es-CO")}
                        {ev.reason ? ` · "${ev.reason}"` : ""}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="font-bold text-destructive">
                        -{formatCOP(ev.eventType === "void" ? ev.originalTotal : ev.discountAmount)}
                      </p>
                      <p className="text-[11px] text-muted-foreground">
                        Final: {formatCOP(ev.eventType === "void" ? 0 : ev.finalTotal)}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Modal de Evolución y Comparación */}
      {modalTopic && (
        <KpiDetailModal
          topic={modalTopic}
          data={data}
          period={period}
          onChangePeriod={handleChangePeriod}
          onClose={() => setModalTopic(null)}
        />
      )}
    </div>
  );
}
