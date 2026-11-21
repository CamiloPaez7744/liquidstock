import { useCallback, useEffect, useState } from "react";
import {
  Ban,
  Building2,
  CheckCircle2,
  Clock,
  Crown,
  Globe,
  LogOut,
  MapPin,
  Phone,
  RefreshCw,
  Search,
  Store,
  Users,
  XCircle,
} from "lucide-react";
import {
  apiFetch,
  resolveImageUrl,
  type OrganizationSocialLinks,
  type StoredAuthUser,
} from "../../infrastructure/api/api-client.js";
import { haptics } from "../../shared/lib/haptics.js";

interface PlatformBar {
  id: string;
  name: string;
  businessType: string;
  legalName: string | null;
  taxId: string | null;
  logoUrl: string | null;
  contactPhone: string | null;
  city: string | null;
  address: string | null;
  currency: string;
  socialLinks: OrganizationSocialLinks;
  approvalStatus: "pending_approval" | "approved" | "rejected" | "suspended";
  approvalNotes: string | null;
  approvedAt: string | null;
  createdAt: string;
  ownerName: string | null;
  ownerEmail: string | null;
  branchCount: number;
  userCount: number;
}

interface PlatformCounts {
  pending: number;
  approved: number;
  rejected: number;
  suspended: number;
  totalBranches: number;
  totalUsers: number;
}

type StatusFilter = "all" | "pending_approval" | "approved" | "inactive";

const BUSINESS_LABELS: Record<string, string> = {
  bar: "Bar",
  restaurant: "Restaurante",
  brewery: "Cervecería",
  pub: "Pub / Gastrobar",
  cafe: "Café Bar",
  other: "Negocio",
};

export function SuperAdminDashboard({
  user,
  onLogout,
}: {
  user: StoredAuthUser;
  onLogout: () => void;
}) {
  const [bars, setBars] = useState<PlatformBar[]>([]);
  const [counts, setCounts] = useState<PlatformCounts>({
    pending: 0,
    approved: 0,
    rejected: 0,
    suspended: 0,
    totalBranches: 0,
    totalUsers: 0,
  });
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notesByBar, setNotesByBar] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const notify = (kind: "ok" | "err", text: string) => {
    setNotice({ kind, text });
    window.setTimeout(() => setNotice(null), 4000);
  };

  const loadBars = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch<{ bars: PlatformBar[]; counts: PlatformCounts }>(
        "/api/v1/superadmin/bars",
      );
      setBars(res.bars);
      setCounts(res.counts);
    } catch (err) {
      notify("err", err instanceof Error ? err.message : "No se pudieron cargar los bares");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadBars();
  }, [loadBars]);

  const handleSetStatus = async (
    bar: PlatformBar,
    status: "approved" | "rejected" | "suspended",
  ) => {
    setBusyId(bar.id);
    try {
      await apiFetch(`/api/v1/superadmin/bars/${bar.id}/status`, {
        method: "PATCH",
        body: JSON.stringify({
          status,
          notes: notesByBar[bar.id]?.trim() || undefined,
        }),
      });
      haptics.success();
      await loadBars();
      notify(
        "ok",
        status === "approved"
          ? `"${bar.name}" aprobado ✓ Ya puede iniciar sesión y operar.`
          : status === "rejected"
            ? `Solicitud de "${bar.name}" rechazada.`
            : `"${bar.name}" suspendido temporalmente.`,
      );
    } catch (err) {
      haptics.blocked();
      notify("err", err instanceof Error ? err.message : "No se pudo cambiar el estado");
    } finally {
      setBusyId(null);
    }
  };

  const filteredBars = bars.filter((b) => {
    if (filter === "pending_approval" && b.approvalStatus !== "pending_approval") return false;
    if (filter === "approved" && b.approvalStatus !== "approved") return false;
    if (
      filter === "inactive" &&
      b.approvalStatus !== "rejected" &&
      b.approvalStatus !== "suspended"
    ) {
      return false;
    }
    if (!query.trim()) return true;
    const q = query.trim().toLowerCase();
    return (
      b.name.toLowerCase().includes(q) ||
      (b.legalName ?? "").toLowerCase().includes(q) ||
      (b.taxId ?? "").toLowerCase().includes(q) ||
      (b.ownerEmail ?? "").toLowerCase().includes(q) ||
      (b.city ?? "").toLowerCase().includes(q)
    );
  });

  return (
    <div className="flex h-dvh flex-col">
      {/* Cabecera exclusiva SuperAdmin */}
      <header className="material-thick safe-top z-20 flex shrink-0 items-center justify-between gap-3 border-b px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-warning/15 text-warning ring-1 ring-warning/40">
            <Crown className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate font-display text-base font-bold">LiquiStock · SuperAdmin</h1>
              <span className="rounded-full bg-warning/20 px-2 py-0.5 text-[10px] font-bold uppercase text-warning">
                Plataforma
              </span>
            </div>
            <p className="truncate text-xs text-muted-foreground">
              Aprobación y directorio global de bares y restaurantes · {user.fullName}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void loadBars()}
            className="press-response flex min-h-10 items-center gap-1.5 rounded-xl bg-secondary px-3 text-xs font-semibold"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            <span className="hidden sm:inline">Actualizar</span>
          </button>
          <button
            type="button"
            onClick={onLogout}
            className="press-response flex min-h-10 items-center gap-1.5 rounded-xl bg-destructive/15 px-3 text-xs font-bold text-destructive"
          >
            <LogOut className="h-4 w-4" />
            <span className="hidden sm:inline">Salir</span>
          </button>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        <div className="mx-auto max-w-6xl space-y-5">
          {notice && (
            <div
              className={`flex items-center gap-2 rounded-2xl border px-4 py-3 text-sm font-semibold ${
                notice.kind === "ok"
                  ? "border-success/40 bg-success/15 text-success"
                  : "border-destructive/40 bg-destructive/15 text-destructive"
              }`}
            >
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              <span>{notice.text}</span>
            </div>
          )}

          {/* KPIs de Plataforma */}
          <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <div className="solid-card rounded-2xl border-warning/30 p-4">
              <div className="flex items-center justify-between text-xs text-warning">
                <span className="font-semibold">Pendientes por aprobar</span>
                <Clock className="h-4 w-4" />
              </div>
              <p className="mt-2 font-display text-2xl font-bold tabular-nums text-warning">
                {counts.pending}
              </p>
            </div>
            <div className="solid-card rounded-2xl border-success/30 p-4">
              <div className="flex items-center justify-between text-xs text-success">
                <span className="font-semibold">Bares / Rest. Activos</span>
                <Store className="h-4 w-4" />
              </div>
              <p className="mt-2 font-display text-2xl font-bold tabular-nums text-success">
                {counts.approved}
              </p>
            </div>
            <div className="solid-card rounded-2xl p-4">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span className="font-semibold">Sucursales Totales</span>
                <Building2 className="h-4 w-4 text-primary" />
              </div>
              <p className="mt-2 font-display text-2xl font-bold tabular-nums">
                {counts.totalBranches}
              </p>
            </div>
            <div className="solid-card rounded-2xl p-4">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span className="font-semibold">Usuarios en Plataforma</span>
                <Users className="h-4 w-4 text-primary" />
              </div>
              <p className="mt-2 font-display text-2xl font-bold tabular-nums">
                {counts.totalUsers}
              </p>
            </div>
          </section>

          {/* Filtros y Buscador */}
          <section className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap gap-1.5">
              {(
                [
                  { id: "all", label: `Todos (${bars.length})` },
                  { id: "pending_approval", label: `Pendientes (${counts.pending})` },
                  { id: "approved", label: `Aprobados (${counts.approved})` },
                  {
                    id: "inactive",
                    label: `Rechazados / Susp. (${counts.rejected + counts.suspended})`,
                  },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setFilter(tab.id)}
                  className={`press-response rounded-xl px-3.5 py-2 text-xs font-bold ${
                    filter === tab.id
                      ? "bg-primary text-primary-foreground"
                      : "bg-secondary text-muted-foreground"
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <div className="relative min-w-60 flex-1 sm:max-w-xs">
              <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
              <input
                type="search"
                placeholder="Buscar bar, razón social, NIT o correo..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="w-full rounded-xl border border-white/15 bg-card py-2 pl-9 pr-3 text-xs"
              />
            </div>
          </section>

          {/* Listado de Bares y Solicitudes */}
          {loading && bars.length === 0 ? (
            <div className="solid-card rounded-2xl p-10 text-center text-sm text-muted-foreground">
              Cargando bares y solicitudes...
            </div>
          ) : filteredBars.length === 0 ? (
            <div className="solid-card rounded-2xl p-10 text-center">
              <Store className="mx-auto h-10 w-10 text-muted-foreground/60" />
              <p className="mt-3 font-display text-base font-bold">
                {bars.length === 0
                  ? "Aún no hay bares o restaurantes registrados"
                  : "No hay bares que coincidan con este filtro"}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Cuando un propietario se registre en la pantalla de acceso (“Registrar mi Bar”),
                su solicitud aparecerá aquí para que la apruebes.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {filteredBars.map((bar) => {
                const logo = resolveImageUrl(bar.logoUrl);
                const statusBadge =
                  bar.approvalStatus === "pending_approval"
                    ? { label: "PENDIENTE DE APROBACIÓN", cls: "bg-warning/20 text-warning" }
                    : bar.approvalStatus === "approved"
                      ? { label: "APROBADO · ACTIVO", cls: "bg-success/20 text-success" }
                      : bar.approvalStatus === "suspended"
                        ? { label: "SUSPENDIDO", cls: "bg-destructive/20 text-destructive" }
                        : { label: "RECHAZADO", cls: "bg-destructive/20 text-destructive" };

                const socials = Object.entries(bar.socialLinks ?? {}).filter(
                  ([, val]) => Boolean(val && String(val).trim()),
                );

                return (
                  <article
                    key={bar.id}
                    className={`solid-card rounded-2xl p-4 sm:p-5 ${
                      bar.approvalStatus === "pending_approval" ? "border-warning/40" : ""
                    }`}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div className="flex min-w-0 items-start gap-3.5">
                        {logo ? (
                          <img
                            src={logo}
                            alt={bar.name}
                            className="h-14 w-14 shrink-0 rounded-2xl object-cover ring-1 ring-white/15"
                          />
                        ) : (
                          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-primary/15 font-display text-lg font-bold text-primary">
                            {bar.name.slice(0, 2).toUpperCase()}
                          </div>
                        )}

                        <div className="min-w-0 space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <h2 className="font-display text-base font-bold">{bar.name}</h2>
                            <span className="rounded-md bg-secondary px-2 py-0.5 text-[10px] font-bold uppercase text-muted-foreground">
                              {BUSINESS_LABELS[bar.businessType] ?? bar.businessType}
                            </span>
                            <span
                              className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold ${statusBadge.cls}`}
                            >
                              {statusBadge.label}
                            </span>
                          </div>

                          <p className="text-xs text-muted-foreground">
                            Razón social:{" "}
                            <strong className="text-foreground">{bar.legalName ?? "—"}</strong>
                            {bar.taxId ? ` · NIT: ${bar.taxId}` : ""} · Moneda: {bar.currency}
                          </p>

                          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                            <span>
                              Dueño/Admin:{" "}
                              <strong className="text-foreground">
                                {bar.ownerName ?? "—"}
                              </strong>{" "}
                              ({bar.ownerEmail ?? "—"})
                            </span>
                            {bar.city && (
                              <span className="flex items-center gap-1">
                                <MapPin className="h-3.5 w-3.5" />
                                {bar.city}
                              </span>
                            )}
                            {bar.contactPhone && (
                              <span className="flex items-center gap-1">
                                <Phone className="h-3.5 w-3.5" />
                                {bar.contactPhone}
                              </span>
                            )}
                          </div>

                          <div className="flex flex-wrap items-center gap-2 pt-1 text-[11px]">
                            <span className="rounded-lg bg-background/70 px-2.5 py-1 font-semibold">
                              <Building2 className="mr-1 inline h-3.5 w-3.5 text-primary" />
                              {bar.branchCount} sucursal{bar.branchCount === 1 ? "" : "es"}
                            </span>
                            <span className="rounded-lg bg-background/70 px-2.5 py-1 font-semibold">
                              <Users className="mr-1 inline h-3.5 w-3.5 text-primary" />
                              {bar.userCount} usuario{bar.userCount === 1 ? "" : "s"}
                            </span>
                            {socials.map(([k, v]) => (
                              <span
                                key={k}
                                className="flex items-center gap-1 rounded-lg bg-primary/10 px-2.5 py-1 text-primary"
                              >
                                <Globe className="h-3 w-3" />
                                {k}: {v}
                              </span>
                            ))}
                          </div>

                          {bar.approvalNotes && (
                            <p className="pt-1 text-xs italic text-muted-foreground">
                              Nota: {bar.approvalNotes}
                            </p>
                          )}
                        </div>
                      </div>

                      {/* Acciones de aprobación */}
                      <div className="flex w-full flex-col gap-2 sm:w-64">
                        <input
                          type="text"
                          placeholder="Nota / motivo (opcional)"
                          value={notesByBar[bar.id] ?? ""}
                          onChange={(e) =>
                            setNotesByBar((prev) => ({ ...prev, [bar.id]: e.target.value }))
                          }
                          className="w-full rounded-xl border border-white/15 bg-background px-3 py-2 text-xs"
                        />
                        <div className="flex gap-2">
                          {bar.approvalStatus !== "approved" && (
                            <button
                              type="button"
                              disabled={busyId === bar.id}
                              onClick={() => void handleSetStatus(bar, "approved")}
                              className="press-response flex min-h-10 flex-1 items-center justify-center gap-1.5 rounded-xl bg-success px-3 text-xs font-bold text-primary-foreground disabled:opacity-50"
                            >
                              <CheckCircle2 className="h-4 w-4" />
                              Aprobar
                            </button>
                          )}
                          {bar.approvalStatus === "pending_approval" && (
                            <button
                              type="button"
                              disabled={busyId === bar.id}
                              onClick={() => void handleSetStatus(bar, "rejected")}
                              className="press-response flex min-h-10 flex-1 items-center justify-center gap-1.5 rounded-xl bg-destructive/20 px-3 text-xs font-bold text-destructive disabled:opacity-50"
                            >
                              <XCircle className="h-4 w-4" />
                              Rechazar
                            </button>
                          )}
                          {bar.approvalStatus === "approved" && (
                            <button
                              type="button"
                              disabled={busyId === bar.id}
                              onClick={() => void handleSetStatus(bar, "suspended")}
                              className="press-response flex min-h-10 flex-1 items-center justify-center gap-1.5 rounded-xl bg-destructive/15 px-3 text-xs font-bold text-destructive disabled:opacity-50"
                            >
                              <Ban className="h-4 w-4" />
                              Suspender
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

