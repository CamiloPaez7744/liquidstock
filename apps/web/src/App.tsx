import { useEffect, useState } from "react";
import {
  BarChart3,
  Beer,
  CloudOff,
  Receipt,
  Settings2,
  UtensilsCrossed,
  Wifi,
} from "lucide-react";
import { syncEngine, type SyncStatusSnapshot } from "./infrastructure/sync/sync-engine.js";
import { haptics } from "./shared/lib/haptics.js";

type PosSection = "pos" | "inventory" | "cash" | "kpis" | "settings";

const DEMO_BRANCH_ID = "01950000-0000-7000-8000-000000000001";

const NAV_ITEMS: Array<{ id: PosSection; label: string; icon: typeof Beer }> = [
  { id: "pos", label: "Mesas & POS", icon: UtensilsCrossed },
  { id: "inventory", label: "Barriles & Stock", icon: Beer },
  { id: "cash", label: "Caja & Cierre", icon: Receipt },
  { id: "kpis", label: "KPIs", icon: BarChart3 },
  { id: "settings", label: "Config Bar", icon: Settings2 },
];

export function App() {
  const [section, setSection] = useState<PosSection>("pos");
  const [syncStatus, setSyncStatus] = useState<SyncStatusSnapshot>({
    connectivity: "online",
    pendingCount: 0,
    lastSyncedAt: null,
    wsConnected: false,
  });

  useEffect(() => {
    const unsub = syncEngine.subscribe(setSyncStatus);
    const stop = syncEngine.start(DEMO_BRANCH_ID);
    return () => {
      unsub();
      stop();
    };
  }, []);

  const isOffline = syncStatus.connectivity === "offline";

  return (
    <div className="flex h-full flex-col">
      {/* Cabecera nocturna de baja fricción con semáforo de resiliencia Offline-First */}
      <header className="material-thick z-20 flex items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/15 text-primary ring-1 ring-primary/35">
            <Beer className="h-6 w-6" />
          </div>
          <div>
            <h1 className="font-display text-lg font-bold tracking-tight">LiquiStock</h1>
            <p className="text-xs text-muted-foreground">Sucursal Principal · Offline-First POS</p>
          </div>
        </div>

        {/* Semáforo no intrusivo: transmite seguridad ante cortes de red o luz */}
        <div
          className={`flex items-center gap-2 rounded-full px-3.5 py-2 text-xs font-semibold ${
            isOffline
              ? "bg-warning/15 text-warning ring-1 ring-warning/40"
              : "bg-success/15 text-success ring-1 ring-success/35"
          }`}
        >
          {isOffline ? <CloudOff className="h-4 w-4" /> : <Wifi className="h-4 w-4" />}
          <span>
            {isOffline
              ? `Modo Local Seguro (${syncStatus.pendingCount} pend.)`
              : syncStatus.wsConnected
                ? "Sincronizado en vivo"
                : "En línea (Outbox listo)"}
          </span>
        </div>
      </header>

      {/* Área de trabajo principal */}
      <main className="flex-1 overflow-y-auto p-4 md:p-6">
        <div className="mx-auto max-w-5xl space-y-4">
          <section className="solid-card rounded-2xl p-6">
            <span className="inline-block rounded-full bg-primary/15 px-3 py-1 text-xs font-semibold text-primary">
              Fase 0 Completada · Núcleo Clean Architecture + Offline-First
            </span>
            <h2 className="mt-3 font-display text-2xl font-bold">
              {NAV_ITEMS.find((n) => n.id === section)?.label}
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Motor compartido <code className="text-foreground">@liquistock/domain</code> activo con
              conversión de barriles/jirafas/shots, fórmula de merma por espuma, sincronización de
              agotados y horarios de aliados, IndexedDB local (<code className="text-foreground">Dexie.js</code>)
              y sincronización multi-tablet por WebSocket + Outbox idempotente.
            </p>
          </section>
        </div>
      </main>

      {/* Barra inferior táctil (targets >= 56px para operación rápida en tablets y celulares) */}
      <nav className="material-thick z-20 grid grid-cols-5 gap-2 px-3 py-2">
        {NAV_ITEMS.map(({ id, label, icon: Icon }) => {
          const active = section === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => {
                haptics.tap();
                setSection(id);
              }}
              className={`press-response flex min-h-14 flex-col items-center justify-center gap-1 rounded-xl px-2 text-xs font-semibold ${
                active
                  ? "bg-primary text-primary-foreground shadow-lg"
                  : "bg-secondary/60 text-muted-foreground hover:text-foreground"
              }`}
            >
              <Icon className="h-5 w-5" />
              <span className="truncate">{label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}

