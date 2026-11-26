import { useCallback, useEffect, useState } from "react";
import {
  BarChart3,
  Beer,
  BookOpen,
  Building2,
  CloudOff,
  LogOut,
  Receipt,
  Settings2,
  Users,
  UtensilsCrossed,
  Wifi,
} from "lucide-react";
import {
  hasModuleAccess,
  resolveBranchRolePermissions,
  type AppModuleId,
} from "@liquistock/domain";
import {
  apiFetch,
  clearStoredSession,
  getStoredSession,
  resolveImageUrl,
  saveStoredSession,
  type OrganizationProfile,
  type StoredAuthSession,
  type StoredAuthUser,
} from "./infrastructure/api/api-client.js";
import { localDb } from "./infrastructure/storage/dexie/db.js";
import { syncEngine, type SyncStatusSnapshot } from "./infrastructure/sync/sync-engine.js";
import { useLiquiStock } from "./infrastructure/sync/useLiquiStock.js";
import { AuthScreen } from "./features/auth/AuthScreen.js";
import { CashShiftView } from "./features/cash-shift/CashShiftView.js";
import { FinanceLedgerView } from "./features/finance/FinanceLedgerView.js";
import { InventoryView } from "./features/inventory/InventoryView.js";
import { KpisView } from "./features/kpis/KpisView.js";
import { BarConfigView } from "./features/settings/BarConfigView.js";
import { SuperAdminDashboard } from "./features/superadmin/SuperAdminDashboard.js";
import { TablesPosView } from "./features/tables-pos/TablesPosView.js";
import { UsersBranchesView } from "./features/users/UsersBranchesView.js";
import { FeedbackProvider } from "./shared/components/FeedbackProvider.js";
import { haptics } from "./shared/lib/haptics.js";

type PosSection = AppModuleId;

const NAV_ITEMS: Array<{
  id: PosSection;
  label: string;
  shortLabel: string;
  icon: typeof Beer;
}> = [
  { id: "pos", label: "Mesas & POS", shortLabel: "POS", icon: UtensilsCrossed },
  { id: "inventory", label: "Stock y Carta", shortLabel: "Stock", icon: Beer },
  { id: "cash", label: "Caja & Turno", shortLabel: "Caja", icon: Receipt },
  { id: "finance", label: "Ingresos y Egresos", shortLabel: "Finanzas", icon: BookOpen },
  { id: "kpis", label: "KPIs", shortLabel: "KPIs", icon: BarChart3 },
  { id: "settings", label: "Config Bar", shortLabel: "Config", icon: Settings2 },
  { id: "users", label: "Mi Bar & Equipo", shortLabel: "Mi Bar", icon: Users },
];

function AuthenticatedPosShell({
  session,
  onUpdateSession,
  onLogout,
}: {
  session: StoredAuthSession;
  onUpdateSession: (next: StoredAuthSession) => void;
  onLogout: () => void;
}) {
  const [section, setSection] = useState<PosSection>("pos");
  const [organizations, setOrganizations] = useState<OrganizationProfile[]>([]);
  const [syncStatus, setSyncStatus] = useState<SyncStatusSnapshot>({
    connectivity: "online",
    pendingCount: 0,
    lastSyncedAt: null,
    wsConnected: false,
  });

  const activeBranchId = session.activeBranchId ?? session.user.memberships[0]?.branchId ?? "";
  const activeMembership =
    session.user.memberships.find((m) => m.branchId === activeBranchId) ??
    session.user.memberships[0];
  const activeRole = activeMembership?.role ?? "waiter";
  const isAdmin = activeRole === "admin";
  const isOffline = syncStatus.connectivity === "offline";

  const store = useLiquiStock(activeBranchId, session.user.userId);

  useEffect(() => {
    if (!activeBranchId) return;
    const unsub = syncEngine.subscribe(setSyncStatus);
    const stop = syncEngine.start(activeBranchId);
    return () => {
      unsub();
      stop();
    };
  }, [activeBranchId]);

  const refreshProfile = useCallback(async () => {
    try {
      const me = await apiFetch<{
        user: StoredAuthUser;
        organizations: OrganizationProfile[];
      }>("/api/v1/auth/me");
      setOrganizations(me.organizations ?? []);
      const validBranch = me.user.memberships.some((m) => m.branchId === session.activeBranchId)
        ? session.activeBranchId
        : (me.user.memberships[0]?.branchId ?? session.activeBranchId);
      const updated: StoredAuthSession = {
        ...session,
        user: me.user,
        activeBranchId: validBranch,
      };
      saveStoredSession(updated);
      onUpdateSession(updated);
    } catch {
      // Offline: keep cached session
    }
  }, [session, onUpdateSession]);

  useEffect(() => {
    void refreshProfile();
  }, []);

  const branchRolePermissions = resolveBranchRolePermissions(store.branch?.rolePermissions);
  const myPermissions = branchRolePermissions[activeRole];
  const visibleNav = NAV_ITEMS.filter((item) => hasModuleAccess(myPermissions, item.id, "view"));
  const currentSection = visibleNav.some((n) => n.id === section)
    ? section
    : (visibleNav[0]?.id ?? "pos");
  const canEditModule = (mod: AppModuleId) => hasModuleAccess(myPermissions, mod, "edit");

  const handleSwitchBranch = (nextBranchId: string) => {
    const updated: StoredAuthSession = { ...session, activeBranchId: nextBranchId };
    saveStoredSession(updated);
    onUpdateSession(updated);
  };

  const activeOrg = organizations.find((o) => o.id === activeMembership?.organizationId);
  const barTitle = activeOrg?.name ?? activeMembership?.organizationName ?? "LiquiStock";
  const barLogo = resolveImageUrl(activeOrg?.logoUrl ?? activeMembership?.organizationLogoUrl);

  return (
    <div className="flex h-dvh flex-col">
      {/* Cabecera con Logo real del bar, selector multi-sede, rol real y cerrar sesión */}
      <header className="material-thick safe-top z-20 flex shrink-0 items-center justify-between gap-2 border-b px-3 pb-2 sm:px-4 sm:py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          {barLogo ? (
            <img
              src={barLogo}
              alt={barTitle}
              className="h-9 w-9 shrink-0 rounded-xl object-cover ring-1 ring-white/20 sm:h-10 sm:w-10"
            />
          ) : (
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary ring-1 ring-primary/30 sm:h-10 sm:w-10">
              <Beer className="h-5 w-5" />
            </div>
          )}
          <div className="min-w-0">
            <h1 className="truncate font-display text-sm font-bold leading-tight tracking-tight sm:text-base">
              {barTitle}
            </h1>
            {session.user.memberships.length > 1 ? (
              <label className="mt-0.5 inline-flex items-center gap-1 rounded-lg border border-primary/25 bg-primary/10 pl-2 pr-1 text-[11px] text-primary">
                <Building2 className="h-3 w-3 shrink-0" />
                <select
                  value={activeBranchId}
                  onChange={(e) => handleSwitchBranch(e.target.value)}
                  className="max-w-40 truncate border-0 bg-transparent py-0.5 text-[11px] font-semibold text-primary focus:shadow-none sm:max-w-none"
                >
                  {session.user.memberships.map((m) => (
                    <option key={m.branchId} value={m.branchId}>
                      {m.organizationName !== barTitle
                        ? `${m.organizationName} · ${m.branchName}`
                        : m.branchName}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <p className="hidden truncate text-[11px] text-muted-foreground sm:block">
                {activeMembership?.branchName ?? store.branch?.name ?? "Sucursal"}
              </p>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
          <div className="hidden items-center gap-1.5 rounded-full bg-secondary/80 px-3 py-1.5 text-xs font-semibold sm:flex">
            <span className="max-w-28 truncate">{session.user.fullName}</span>
            <span className="rounded-full bg-primary/20 px-1.5 py-0.5 text-[10px] font-bold uppercase text-primary">
              {activeRole === "admin" ? "Admin" : activeRole === "cashier" ? "Caja" : "Mesero"}
            </span>
          </div>

          <button
            type="button"
            onClick={() => void syncEngine.flushOutbox(activeBranchId)}
            title="Estado de sincronización"
            className={`press-response flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-xs font-semibold ${
              isOffline
                ? "bg-warning/15 text-warning ring-1 ring-warning/40"
                : "bg-success/15 text-success ring-1 ring-success/35"
            }`}
          >
            {isOffline ? <CloudOff className="h-3.5 w-3.5" /> : <Wifi className="h-3.5 w-3.5" />}
            <span className="hidden sm:inline">
              {isOffline
                ? `Local (${syncStatus.pendingCount})`
                : syncStatus.wsConnected
                  ? syncStatus.pendingCount > 0
                    ? `Sync (${syncStatus.pendingCount})`
                    : "En vivo"
                  : "En línea"}
            </span>
            <span className="sm:hidden">
              {isOffline ? `${syncStatus.pendingCount}` : syncStatus.wsConnected ? "Vivo" : "OK"}
            </span>
          </button>

          <button
            type="button"
            onClick={onLogout}
            title="Cerrar sesión"
            className="press-response flex h-9 w-9 items-center justify-center rounded-full bg-secondary/80 text-muted-foreground hover:text-destructive"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </header>

      {/* Área principal */}
      <main
        className={`min-h-0 flex-1 ${
          currentSection === "pos" ? "overflow-hidden p-0 lg:p-4" : "overflow-y-auto p-3 sm:p-5"
        }`}
      >
        <div
          className={`mx-auto h-full max-w-7xl ${currentSection === "pos" ? "flex flex-col" : ""}`}
        >
          {store.loading && store.diningTables.length === 0 && store.menuProducts.length === 0 ? (
            <div className="m-4 rounded-2xl bg-card p-8 text-center text-sm text-muted-foreground">
              Sincronizando datos de {activeMembership?.branchName ?? "tu sucursal"}...
            </div>
          ) : visibleNav.length === 0 ? (
            <div className="m-4 rounded-2xl border border-warning/30 bg-card p-8 text-center">
              <p className="font-display text-base font-bold text-foreground">
                Sin módulos habilitados para tu rol
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Pide al Administrador que habilite al menos un módulo para tu rol desde Config Bar.
              </p>
            </div>
          ) : currentSection === "pos" ? (
            <TablesPosView
              store={store}
              isAdmin={isAdmin}
              canEdit={canEditModule("pos")}
              canEditInventory={canEditModule("inventory")}
              barBranding={
                activeOrg
                  ? {
                      name: activeOrg.name,
                      legalName: activeOrg.legalName,
                      taxId: activeOrg.taxId,
                      logoUrl: activeOrg.logoUrl,
                      instagram: activeOrg.socialLinks?.instagram,
                      contactPhone: activeOrg.contactPhone,
                    }
                  : undefined
              }
              onGoToInventory={() => setSection("inventory")}
              onGoToCash={() => setSection("cash")}
            />
          ) : currentSection === "inventory" ? (
            <InventoryView
              store={store}
              branchId={activeBranchId}
              isAdmin={canEditModule("inventory")}
              isBranchAdmin={isAdmin}
            />
          ) : currentSection === "cash" ? (
            <CashShiftView
              store={store}
              branchId={activeBranchId}
              canEdit={canEditModule("cash")}
              canEditFinance={canEditModule("finance")}
              isAdmin={isAdmin}
            />
          ) : currentSection === "finance" ? (
            <FinanceLedgerView
              store={store}
              branchId={activeBranchId}
              canEdit={canEditModule("finance")}
            />
          ) : currentSection === "kpis" ? (
            <KpisView store={store} branchId={activeBranchId} />
          ) : currentSection === "settings" ? (
            <BarConfigView
              store={store}
              branchId={activeBranchId}
              canEdit={canEditModule("settings")}
              isAdmin={isAdmin}
              onGoToPos={() => setSection("pos")}
            />
          ) : (
            <UsersBranchesView
              store={store}
              branchId={activeBranchId}
              memberships={session.user.memberships}
              organizations={organizations}
              currentUserId={session.user.userId}
              canEdit={canEditModule("users")}
              isAdmin={isAdmin}
              onProfileOrBranchesChanged={refreshProfile}
            />
          )}
        </div>
      </main>

      {/* Navegación inferior táctil (si es mesero y solo tiene POS, no estorba la pantalla!) */}
      {visibleNav.length > 1 && (
        <nav
          className="material-thick safe-bottom z-20 grid shrink-0 gap-1 border-t px-2 pt-1.5 sm:gap-2 sm:px-3 sm:pt-2"
          style={{ gridTemplateColumns: `repeat(${visibleNav.length}, minmax(0, 1fr))` }}
        >
          {visibleNav.map(({ id, label, shortLabel, icon: Icon }) => {
            const active = currentSection === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => {
                  haptics.tap();
                  setSection(id);
                }}
                className={`press-response flex min-h-12 flex-col items-center justify-center gap-0.5 rounded-xl px-1 text-[11px] font-semibold sm:min-h-13 sm:gap-1 sm:text-xs ${
                  active
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
                }`}
              >
                <Icon className="h-5 w-5" />
                <span className="truncate sm:hidden">{shortLabel}</span>
                <span className="hidden truncate sm:inline">{label}</span>
              </button>
            );
          })}
        </nav>
      )}
    </div>
  );
}

export function App() {
  const [session, setSession] = useState<StoredAuthSession | null>(() => getStoredSession());

  useEffect(() => {
    const onUnauthorized = () => {
      clearStoredSession();
      setSession(null);
    };
    window.addEventListener("liquistock:unauthorized", onUnauthorized);
    return () => window.removeEventListener("liquistock:unauthorized", onUnauthorized);
  }, []);

  const handleLogout = async () => {
    clearStoredSession();
    const pending = await localDb.syncOutbox.where("syncStatus").equals("pending").count();
    if (pending === 0) {
      await localDb.delete();
      await localDb.open();
    }
    setSession(null);
  };

  return (
    <FeedbackProvider>
      {!session ? (
        <AuthScreen onAuthenticated={setSession} />
      ) : session.user.isSuperAdmin ? (
        <SuperAdminDashboard user={session.user} onLogout={() => void handleLogout()} />
      ) : (
        <AuthenticatedPosShell
          session={session}
          onUpdateSession={setSession}
          onLogout={() => void handleLogout()}
        />
      )}
    </FeedbackProvider>
  );
}
