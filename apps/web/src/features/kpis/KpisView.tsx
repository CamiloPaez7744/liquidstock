import { useCallback, useEffect, useState } from "react";
import { Award, Beer, ChevronRight, Droplets, RefreshCw, TrendingUp, Users } from "lucide-react";
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

export function KpisView({ store, branchId }: { store: StoreType; branchId: string }) {
  const [period, setPeriod] = useState<KpiPeriod>("monthly");
  const [data, setData] = useState<KpiResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [modalTopic, setModalTopic] = useState<KpiModalTopic | null>(null);

  const loadKpis = useCallback(
    async (targetPeriod: KpiPeriod = period) => {
      try {
        setLoadError(null);
        const res = await apiFetch<KpiResponse>(
          `/api/v1/branches/${branchId}/kpis?period=${targetPeriod}`,
        );
        setData(res);
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

  // Auto-retry once if initial load hit a brief reconnect/restart
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
        <p>{loadError ? "Reconectando para cargar los KPIs..." : "Cargando métricas en tiempo real del bar..."}</p>
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
          <h2 className="font-display text-xl font-bold">Dashboard & KPIs del Bar</h2>
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

      {/* Rankings: Producto Más Vendido vs Presentación Más Vendida */}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="solid-card rounded-2xl p-5">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div>
              <h3 className="font-display text-base font-bold">Top Productos ({periodLabel})</h3>
              <p className="text-xs text-muted-foreground">
                Sumando todas sus presentaciones
              </p>
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

      {/* Salud de Barriles */}
      <div className="solid-card rounded-2xl p-5">
        <div className="mb-3 flex items-center gap-2">
          <Beer className="h-5 w-5 text-warning" />
          <h3 className="font-display text-base font-bold">Nivel Actual de Barriles y Licores</h3>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
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
                <p className="text-sm font-bold">{inv.name}</p>
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
