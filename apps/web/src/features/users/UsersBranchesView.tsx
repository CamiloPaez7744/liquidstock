import { useCallback, useEffect, useState } from "react";
import {
  Building2,
  CheckCircle2,
  CreditCard,
  Globe,
  ImagePlus,
  KeyRound,
  Plus,
  Save,
  Shield,
  Store,
  Table2,
  UserPlus,
  Users,
} from "lucide-react";
import type { UserRole } from "@liquistock/domain";
import {
  apiFetch,
  resolveImageUrl,
  type OrganizationProfile,
  type StoredBranchMembership,
} from "../../infrastructure/api/api-client.js";
import type { useLiquiStock } from "../../infrastructure/sync/useLiquiStock.js";
import { haptics } from "../../shared/lib/haptics.js";

interface ManagedUser {
  id: string;
  fullName: string;
  email: string;
  hasPin: boolean;
  isActive: boolean;
  assignments: Array<{ branchId: string; branchName: string; role: UserRole }>;
}

export function UsersBranchesView({
  store,
  branchId,
  memberships,
  organizations,
  currentUserId,
  onProfileOrBranchesChanged,
}: {
  store: ReturnType<typeof useLiquiStock>;
  branchId: string;
  memberships: StoredBranchMembership[];
  organizations: OrganizationProfile[];
  currentUserId: string;
  onProfileOrBranchesChanged: () => Promise<void>;
}) {
  const activeMembership =
    memberships.find((m) => m.branchId === branchId) ?? memberships[0];
  const activeOrg =
    organizations.find((o) => o.id === activeMembership?.organizationId) ?? organizations[0];

  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // Perfil del Bar (Logo, Razón Social, NIT, Redes Sociales)
  const [barName, setBarName] = useState(activeOrg?.name ?? "");
  const [businessType, setBusinessType] = useState<OrganizationProfile["businessType"]>(
    activeOrg?.businessType ?? "bar",
  );
  const [legalName, setLegalName] = useState(activeOrg?.legalName ?? "");
  const [taxId, setTaxId] = useState(activeOrg?.taxId ?? "");
  const [logoUrl, setLogoUrl] = useState<string | null>(activeOrg?.logoUrl ?? null);
  const [contactPhone, setContactPhone] = useState(activeOrg?.contactPhone ?? "");
  const [city, setCity] = useState(activeOrg?.city ?? "");
  const [address, setAddress] = useState(activeOrg?.address ?? "");
  const [instagram, setInstagram] = useState(activeOrg?.socialLinks?.instagram ?? "");
  const [facebook, setFacebook] = useState(activeOrg?.socialLinks?.facebook ?? "");
  const [tiktok, setTiktok] = useState(activeOrg?.socialLinks?.tiktok ?? "");
  const [website, setWebsite] = useState(activeOrg?.socialLinks?.website ?? "");
  const [uploadingLogo, setUploadingLogo] = useState(false);

  // Agregar nuevo Bar adicional (va a aprobación SuperAdmin)
  const [showNewBarForm, setShowNewBarForm] = useState(false);
  const [extraBarName, setExtraBarName] = useState("");
  const [extraLegalName, setExtraLegalName] = useState("");
  const [extraBarType, setExtraBarType] = useState<OrganizationProfile["businessType"]>("bar");
  const [extraBranchName, setExtraBranchName] = useState("Sede Principal");
  const [extraBranchCode, setExtraBranchCode] = useState("");

  // Create user form
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [quickPin, setQuickPin] = useState("");
  const [role, setRole] = useState<UserRole>("waiter");
  const [selectedBranchIds, setSelectedBranchIds] = useState<string[]>([branchId]);

  // Reset password inline
  const [resetUserId, setResetUserId] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState("");

  // New branch form
  const [newBranchName, setNewBranchName] = useState("");
  const [newBranchCode, setNewBranchCode] = useState("");
  const [newBranchTables, setNewBranchTables] = useState("6");

  // New table & payment method for current branch
  const [newTableLabel, setNewTableLabel] = useState("");
  const [newPaymentName, setNewPaymentName] = useState("");
  const [newPaymentCash, setNewPaymentCash] = useState(false);

  useEffect(() => {
    if (!activeOrg) return;
    setBarName(activeOrg.name);
    setBusinessType(activeOrg.businessType);
    setLegalName(activeOrg.legalName ?? "");
    setTaxId(activeOrg.taxId ?? "");
    setLogoUrl(activeOrg.logoUrl ?? null);
    setContactPhone(activeOrg.contactPhone ?? "");
    setCity(activeOrg.city ?? "");
    setAddress(activeOrg.address ?? "");
    setInstagram(activeOrg.socialLinks?.instagram ?? "");
    setFacebook(activeOrg.socialLinks?.facebook ?? "");
    setTiktok(activeOrg.socialLinks?.tiktok ?? "");
    setWebsite(activeOrg.socialLinks?.website ?? "");
  }, [activeOrg?.id, activeOrg?.logoUrl, activeOrg?.name]);

  const notify = (kind: "ok" | "err", text: string) => {
    setNotice({ kind, text });
    window.setTimeout(() => setNotice(null), 4000);
  };

  const loadUsers = useCallback(async () => {
    try {
      const res = await apiFetch<{ users: ManagedUser[] }>("/api/v1/users");
      setUsers(res.users);
    } catch {
      // Offline
    }
  }, []);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  const handleUploadLogo = async (file: File) => {
    if (!activeOrg) return;
    setUploadingLogo(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const uploaded = await apiFetch<{ imageUrl: string }>("/api/v1/uploads/image", {
        method: "POST",
        body: form,
      });
      setLogoUrl(uploaded.imageUrl);
      await apiFetch(`/api/v1/organizations/${activeOrg.id}/profile`, {
        method: "PATCH",
        body: JSON.stringify({ logoUrl: uploaded.imageUrl }),
      });
      haptics.success();
      await onProfileOrBranchesChanged();
      notify("ok", "Logo del bar actualizado ✓");
    } catch (err) {
      notify("err", err instanceof Error ? err.message : "Error subiendo el logo");
    } finally {
      setUploadingLogo(false);
    }
  };

  const handleSaveOrgProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeOrg || !barName.trim()) return;
    setBusy(true);
    try {
      await apiFetch(`/api/v1/organizations/${activeOrg.id}/profile`, {
        method: "PATCH",
        body: JSON.stringify({
          name: barName.trim(),
          businessType,
          legalName: legalName.trim() || null,
          taxId: taxId.trim() || null,
          logoUrl,
          contactPhone: contactPhone.trim() || null,
          city: city.trim() || null,
          address: address.trim() || null,
          socialLinks: {
            instagram: instagram.trim(),
            facebook: facebook.trim(),
            tiktok: tiktok.trim(),
            website: website.trim(),
          },
        }),
      });
      haptics.success();
      await onProfileOrBranchesChanged();
      notify("ok", "Perfil, razón social y redes del bar guardados ✓");
    } catch (err) {
      notify("err", err instanceof Error ? err.message : "Error guardando perfil");
    } finally {
      setBusy(false);
    }
  };

  const handleCreateExtraBar = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!extraBarName.trim() || !extraLegalName.trim()) return;
    setBusy(true);
    try {
      await apiFetch("/api/v1/organizations", {
        method: "POST",
        body: JSON.stringify({
          barName: extraBarName.trim(),
          legalName: extraLegalName.trim(),
          businessType: extraBarType,
          branchName: extraBranchName.trim() || "Sede Principal",
          branchCode: extraBranchCode.trim().toUpperCase() || "BAR2",
          tableCount: 6,
        }),
      });
      haptics.success();
      setExtraBarName("");
      setExtraLegalName("");
      setExtraBranchCode("");
      setShowNewBarForm(false);
      await onProfileOrBranchesChanged();
      notify("ok", "Solicitud enviada para aprobación ✓");
    } catch (err) {
      notify("err", err instanceof Error ? err.message : "No se pudo registrar el bar");
    } finally {
      setBusy(false);
    }
  };

  const toggleBranchSelection = (id: string) => {
    setSelectedBranchIds((prev) =>
      prev.includes(id) ? (prev.length > 1 ? prev.filter((x) => x !== id) : prev) : [...prev, id],
    );
  };

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!fullName.trim() || !email.trim() || password.length < 8) {
      notify("err", "Completa nombre, correo y contraseña de mínimo 8 caracteres.");
      return;
    }
    setBusy(true);
    try {
      await apiFetch("/api/v1/users", {
        method: "POST",
        body: JSON.stringify({
          fullName: fullName.trim(),
          email: email.trim(),
          password,
          quickPin: quickPin.trim() || undefined,
          assignments: selectedBranchIds.map((bId) => ({ branchId: bId, role })),
        }),
      });
      haptics.success();
      setFullName("");
      setEmail("");
      setPassword("");
      setQuickPin("");
      await Promise.all([loadUsers(), store.refresh()]);
      notify("ok", "Usuario creado ✓");
    } catch (err) {
      notify("err", err instanceof Error ? err.message : "Error creando usuario");
    } finally {
      setBusy(false);
    }
  };

  const handleToggleActive = async (u: ManagedUser) => {
    setBusy(true);
    try {
      await apiFetch(`/api/v1/users/${u.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive: !u.isActive }),
      });
      haptics.tap();
      await loadUsers();
      notify("ok", `Usuario ${!u.isActive ? "activado" : "desactivado"} ✓`);
    } catch (err) {
      notify("err", err instanceof Error ? err.message : "No se pudo actualizar");
    } finally {
      setBusy(false);
    }
  };

  const handleResetPassword = async (userId: string) => {
    if (newPassword.length < 8) {
      notify("err", "La nueva contraseña debe tener mínimo 8 caracteres.");
      return;
    }
    setBusy(true);
    try {
      await apiFetch(`/api/v1/users/${userId}`, {
        method: "PATCH",
        body: JSON.stringify({ password: newPassword }),
      });
      haptics.success();
      setResetUserId(null);
      setNewPassword("");
      notify("ok", "Contraseña actualizada y cifrada ✓");
    } catch (err) {
      notify("err", err instanceof Error ? err.message : "Error cambiando contraseña");
    } finally {
      setBusy(false);
    }
  };

  const handleCreateBranch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newBranchName.trim() || !newBranchCode.trim()) return;
    setBusy(true);
    try {
      await apiFetch("/api/v1/branches", {
        method: "POST",
        body: JSON.stringify({
          organizationId: activeOrg?.id,
          name: newBranchName.trim(),
          code: newBranchCode.trim().toUpperCase(),
          tableCount: Math.max(0, Number(newBranchTables) || 6),
          openingFloat: 0,
        }),
      });
      haptics.success();
      setNewBranchName("");
      setNewBranchCode("");
      await onProfileOrBranchesChanged();
      notify("ok", "Nueva sucursal creada y disponible en el selector superior ✓");
    } catch (err) {
      notify("err", err instanceof Error ? err.message : "Error creando sucursal");
    } finally {
      setBusy(false);
    }
  };

  const handleAddTable = async () => {
    if (!newTableLabel.trim()) return;
    setBusy(true);
    try {
      await apiFetch(`/api/v1/branches/${branchId}/tables`, {
        method: "POST",
        body: JSON.stringify({ label: newTableLabel.trim(), zone: "Salón" }),
      });
      haptics.success();
      setNewTableLabel("");
      await store.refresh();
      notify("ok", "Mesa agregada a esta sucursal ✓");
    } catch (err) {
      notify("err", err instanceof Error ? err.message : "Error agregando mesa");
    } finally {
      setBusy(false);
    }
  };

  const handleAddPaymentMethod = async () => {
    if (!newPaymentName.trim()) return;
    setBusy(true);
    try {
      await apiFetch(`/api/v1/branches/${branchId}/payment-methods`, {
        method: "POST",
        body: JSON.stringify({
          name: newPaymentName.trim(),
          countsAsPhysicalCash: newPaymentCash,
        }),
      });
      haptics.success();
      setNewPaymentName("");
      setNewPaymentCash(false);
      await store.refresh();
      notify("ok", "Medio de pago agregado ✓");
    } catch (err) {
      notify("err", err instanceof Error ? err.message : "Error agregando medio de pago");
    } finally {
      setBusy(false);
    }
  };

  const resolvedLogo = resolveImageUrl(logoUrl);

  return (
    <div className="space-y-6">
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

      {/* 1. IDENTIDAD DEL BAR: Logo, Razón Social, NIT y Redes Sociales */}
      {activeOrg && (
        <section className="solid-card space-y-4 rounded-2xl border-primary/25 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              {resolvedLogo ? (
                <img
                  src={resolvedLogo}
                  alt={barName}
                  className="h-14 w-14 rounded-2xl object-cover ring-1 ring-white/20"
                />
              ) : (
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/15 text-primary">
                  <Store className="h-7 w-7" />
                </div>
              )}
              <div>
                <h2 className="font-display text-lg font-bold">
                  Identidad del Bar: Logo, Razón Social y Redes
                </h2>
                <p className="text-xs text-muted-foreground">
                  Personaliza el logo y datos legales de <strong>{activeOrg.name}</strong>
                </p>
              </div>
            </div>

            <label className="press-response flex cursor-pointer items-center gap-1.5 rounded-xl bg-secondary px-3.5 py-2 text-xs font-bold text-primary">
              <ImagePlus className="h-4 w-4" />
              {uploadingLogo ? "Subiendo logo..." : "Subir Logo"}
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleUploadLogo(f);
                }}
              />
            </label>
          </div>

          <form onSubmit={handleSaveOrgProfile} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">
                  Nombre comercial *
                </label>
                <input
                  type="text"
                  required
                  value={barName}
                  onChange={(e) => setBarName(e.target.value)}
                  className="w-full rounded-xl border border-white/15 bg-background px-3 py-2 text-sm font-semibold"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">Tipo de negocio</label>
                <select
                  value={businessType}
                  onChange={(e) =>
                    setBusinessType(e.target.value as OrganizationProfile["businessType"])
                  }
                  className="w-full rounded-xl border border-white/15 bg-background px-3 py-2 text-sm"
                >
                  <option value="bar">Bar</option>
                  <option value="brewery">Cervecería</option>
                  <option value="restaurant">Restaurante</option>
                  <option value="pub">Pub / Gastrobar</option>
                  <option value="cafe">Café Bar</option>
                  <option value="other">Otro</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">Razón Social</label>
                <input
                  type="text"
                  placeholder="Ej. Cervecería La 80 S.A.S."
                  value={legalName}
                  onChange={(e) => setLegalName(e.target.value)}
                  className="w-full rounded-xl border border-white/15 bg-background px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">
                  NIT / Documento fiscal
                </label>
                <input
                  type="text"
                  placeholder="900.123.456-7"
                  value={taxId}
                  onChange={(e) => setTaxId(e.target.value)}
                  className="w-full rounded-xl border border-white/15 bg-background px-3 py-2 text-sm"
                />
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">
                  Teléfono / WhatsApp
                </label>
                <input
                  type="tel"
                  placeholder="300 123 4567"
                  value={contactPhone}
                  onChange={(e) => setContactPhone(e.target.value)}
                  className="w-full rounded-xl border border-white/15 bg-background px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">Ciudad</label>
                <input
                  type="text"
                  placeholder="Bogotá"
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                  className="w-full rounded-xl border border-white/15 bg-background px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">Dirección</label>
                <input
                  type="text"
                  placeholder="Calle 80 # 12-34"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  className="w-full rounded-xl border border-white/15 bg-background px-3 py-2 text-sm"
                />
              </div>
            </div>

            <div className="rounded-xl border border-white/10 bg-background/40 p-3">
              <p className="mb-2 flex items-center gap-1.5 text-xs font-bold text-primary">
                <Globe className="h-3.5 w-3.5" />
                Redes Sociales del Bar
              </p>
              <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
                <input
                  type="text"
                  placeholder="Instagram (@tubar)"
                  value={instagram}
                  onChange={(e) => setInstagram(e.target.value)}
                  className="rounded-xl border border-white/15 bg-card px-3 py-2 text-xs"
                />
                <input
                  type="text"
                  placeholder="Facebook (fb.com/tubar)"
                  value={facebook}
                  onChange={(e) => setFacebook(e.target.value)}
                  className="rounded-xl border border-white/15 bg-card px-3 py-2 text-xs"
                />
                <input
                  type="text"
                  placeholder="TikTok (@tubar)"
                  value={tiktok}
                  onChange={(e) => setTiktok(e.target.value)}
                  className="rounded-xl border border-white/15 bg-card px-3 py-2 text-xs"
                />
                <input
                  type="text"
                  placeholder="Sitio Web (https://...)"
                  value={website}
                  onChange={(e) => setWebsite(e.target.value)}
                  className="rounded-xl border border-white/15 bg-card px-3 py-2 text-xs"
                />
              </div>
            </div>

            <div className="flex justify-end">
              <button
                type="submit"
                disabled={busy}
                className="press-response flex min-h-11 items-center gap-2 rounded-xl bg-primary px-5 text-xs font-bold text-primary-foreground disabled:opacity-50"
              >
                <Save className="h-4 w-4" />
                Guardar Perfil del Bar
              </button>
            </div>
          </form>
        </section>
      )}

      {/* 2. Administración de Usuarios */}
      <section className="solid-card space-y-4 rounded-2xl p-5">
        <div className="flex items-center gap-2">
          <Users className="h-5 w-5 text-primary" />
          <div>
            <h2 className="font-display text-lg font-bold">Administración de Usuarios y Roles</h2>
            <p className="text-xs text-muted-foreground">
              Crea meseros, cajeros u otros administradores con acceso seguro y PIN opcional
            </p>
          </div>
        </div>

        <form
          onSubmit={handleCreateUser}
          className="space-y-3 rounded-2xl border border-primary/25 bg-primary/5 p-4"
        >
          <p className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-primary">
            <UserPlus className="h-4 w-4" />
            Crear nuevo integrante del equipo
          </p>
          <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-5">
            <input
              type="text"
              required
              placeholder="Nombre completo *"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              className="rounded-xl border border-white/15 bg-background px-3 py-2 text-sm"
            />
            <input
              type="email"
              required
              placeholder="Correo electrónico *"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="rounded-xl border border-white/15 bg-background px-3 py-2 text-sm"
            />
            <input
              type="password"
              required
              minLength={8}
              placeholder="Contraseña (mín. 8) *"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="rounded-xl border border-white/15 bg-background px-3 py-2 text-sm"
            />
            <input
              type="password"
              inputMode="numeric"
              maxLength={6}
              placeholder="PIN rápido (4-6 díg.)"
              value={quickPin}
              onChange={(e) => setQuickPin(e.target.value.replace(/\D/g, ""))}
              className="rounded-xl border border-white/15 bg-background px-3 py-2 text-sm tabular-nums"
            />
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as UserRole)}
              className="rounded-xl border border-white/15 bg-background px-3 py-2 text-sm font-semibold"
            >
              <option value="waiter">Mesero / Vendedor</option>
              <option value="cashier">Cajero</option>
              <option value="admin">Administrador</option>
            </select>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="text-muted-foreground">Sucursales asignadas:</span>
              {memberships.map((m) => {
                const selected = selectedBranchIds.includes(m.branchId);
                return (
                  <button
                    key={m.branchId}
                    type="button"
                    onClick={() => toggleBranchSelection(m.branchId)}
                    className={`press-response rounded-lg px-2.5 py-1 text-xs font-bold ${
                      selected
                        ? "bg-primary text-primary-foreground"
                        : "bg-secondary text-muted-foreground"
                    }`}
                  >
                    {m.branchName}
                  </button>
                );
              })}
            </div>
            <button
              type="submit"
              disabled={busy}
              className="press-response rounded-xl bg-primary px-5 py-2.5 text-xs font-bold text-primary-foreground disabled:opacity-50"
            >
              Crear Usuario
            </button>
          </div>
        </form>

        <div className="space-y-2.5">
          {users.map((u) => (
            <div
              key={u.id}
              className="rounded-xl border border-white/10 bg-background/50 p-3.5"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-bold">{u.fullName}</p>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                        u.isActive
                          ? "bg-success/15 text-success"
                          : "bg-destructive/20 text-destructive"
                      }`}
                    >
                      {u.isActive ? "ACTIVO" : "DESACTIVADO"}
                    </span>
                    {u.hasPin && (
                      <span className="flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
                        <KeyRound className="h-3 w-3" /> PIN activo
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">{u.email}</p>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {u.assignments.map((a) => (
                      <span
                        key={`${u.id}-${a.branchId}`}
                        className="rounded bg-card px-2 py-0.5 text-[11px] font-semibold"
                      >
                        <Shield className="mr-1 inline h-3 w-3 text-primary" />
                        {a.branchName}: {a.role}
                      </span>
                    ))}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setResetUserId(resetUserId === u.id ? null : u.id);
                      setNewPassword("");
                    }}
                    className="press-response rounded-xl bg-secondary px-3 py-1.5 text-xs font-semibold"
                  >
                    Cambiar clave
                  </button>
                  {u.id !== currentUserId && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleToggleActive(u)}
                      className={`press-response rounded-xl px-3 py-1.5 text-xs font-bold ${
                        u.isActive
                          ? "bg-destructive/15 text-destructive"
                          : "bg-success/20 text-success"
                      }`}
                    >
                      {u.isActive ? "Desactivar" : "Activar"}
                    </button>
                  )}
                </div>
              </div>

              {resetUserId === u.id && (
                <div className="mt-3 flex flex-wrap gap-2 rounded-xl bg-card p-2.5">
                  <input
                    type="password"
                    minLength={8}
                    placeholder="Nueva contraseña (mín. 8 caracteres)"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    className="min-w-52 flex-1 rounded-lg border border-white/15 bg-background px-3 py-1.5 text-xs"
                  />
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleResetPassword(u.id)}
                    className="press-response rounded-lg bg-primary px-3.5 py-1.5 text-xs font-bold text-primary-foreground"
                  >
                    Guardar nueva clave
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* 3. Mis Bares y Sucursales Multi-Sede */}
      <section className="solid-card space-y-4 rounded-2xl p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Building2 className="h-5 w-5 text-warning" />
            <div>
              <h2 className="font-display text-lg font-bold">Mis Bares y Sucursales</h2>
              <p className="text-xs text-muted-foreground">
                Agrega nuevas sucursales a tu bar o solicita registrar un nuevo bar/restaurante
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setShowNewBarForm((v) => !v)}
            className="press-response flex items-center gap-1 rounded-xl bg-secondary px-3 py-2 text-xs font-bold text-primary"
          >
            <Plus className="h-3.5 w-3.5" />
            Agregar otro Bar
          </button>
        </div>

        {/* Lista de bares del admin (incluye pendientes de aprobación) */}
        {organizations.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {organizations.map((org) => (
              <div
                key={org.id}
                className="flex items-center gap-2 rounded-xl border border-white/10 bg-background/60 px-3 py-2 text-xs"
              >
                <Store className="h-3.5 w-3.5 text-primary" />
                <span className="font-bold">{org.name}</span>
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                    org.approvalStatus === "approved"
                      ? "bg-success/20 text-success"
                      : "bg-warning/20 text-warning"
                  }`}
                >
                  {org.approvalStatus === "approved"
                    ? "Aprobado"
                    : org.approvalStatus === "pending_approval"
                      ? "Pendiente de aprobación"
                      : org.approvalStatus}
                </span>
              </div>
            ))}
          </div>
        )}

        {showNewBarForm && (
          <form
            onSubmit={handleCreateExtraBar}
            className="space-y-2.5 rounded-xl border border-primary/30 bg-primary/5 p-3.5"
          >
            <p className="text-xs font-bold text-primary">
              Registrar un nuevo Bar / Restaurante (sujeto a aprobación)
            </p>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
              <input
                type="text"
                required
                placeholder="Nombre del nuevo bar *"
                value={extraBarName}
                onChange={(e) => setExtraBarName(e.target.value)}
                className="rounded-xl border border-white/15 bg-background px-3 py-2 text-xs"
              />
              <input
                type="text"
                required
                placeholder="Razón Social *"
                value={extraLegalName}
                onChange={(e) => setExtraLegalName(e.target.value)}
                className="rounded-xl border border-white/15 bg-background px-3 py-2 text-xs"
              />
              <select
                value={extraBarType}
                onChange={(e) =>
                  setExtraBarType(e.target.value as OrganizationProfile["businessType"])
                }
                className="rounded-xl border border-white/15 bg-background px-2.5 py-2 text-xs"
              >
                <option value="bar">Bar</option>
                <option value="restaurant">Restaurante</option>
                <option value="brewery">Cervecería</option>
                <option value="pub">Pub / Gastrobar</option>
              </select>
              <input
                type="text"
                placeholder="Sede inicial"
                value={extraBranchName}
                onChange={(e) => setExtraBranchName(e.target.value)}
                className="rounded-xl border border-white/15 bg-background px-3 py-2 text-xs"
              />
              <input
                type="text"
                placeholder="Código (ej. BAR2)"
                value={extraBranchCode}
                onChange={(e) => setExtraBranchCode(e.target.value.toUpperCase())}
                className="rounded-xl border border-white/15 bg-background px-3 py-2 text-xs font-bold uppercase"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowNewBarForm(false)}
                className="rounded-xl bg-secondary px-3 py-1.5 text-xs font-semibold"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={busy}
                className="press-response rounded-xl bg-primary px-4 py-1.5 text-xs font-bold text-primary-foreground"
              >
                Enviar solicitud
              </button>
            </div>
          </form>
        )}

        <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
          {memberships.map((m) => (
            <div
              key={m.branchId}
              className={`rounded-xl border p-3.5 ${
                m.branchId === branchId
                  ? "border-primary/50 bg-primary/10"
                  : "border-white/10 bg-background/50"
              }`}
            >
              <p className="text-[11px] font-semibold text-primary">{m.organizationName}</p>
              <p className="font-bold">{m.branchName}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Código para PIN: <strong className="text-foreground">{m.branchCode}</strong>
              </p>
            </div>
          ))}
        </div>

        <form onSubmit={handleCreateBranch} className="flex flex-wrap gap-2 rounded-xl bg-background/50 p-3">
          <input
            type="text"
            required
            placeholder="Nueva sucursal (ej. Sede Chapinero)"
            value={newBranchName}
            onChange={(e) => setNewBranchName(e.target.value)}
            className="min-w-48 flex-1 rounded-xl border border-white/15 bg-card px-3 py-2 text-xs"
          />
          <input
            type="text"
            required
            placeholder="Código (ej. CHAP)"
            value={newBranchCode}
            onChange={(e) => setNewBranchCode(e.target.value.toUpperCase())}
            className="w-28 rounded-xl border border-white/15 bg-card px-3 py-2 text-xs font-bold uppercase"
          />
          <input
            type="number"
            min={0}
            max={60}
            value={newBranchTables}
            onChange={(e) => setNewBranchTables(e.target.value)}
            placeholder="Mesas"
            className="w-20 rounded-xl border border-white/15 bg-card px-2.5 py-2 text-xs tabular-nums"
          />
          <button
            type="submit"
            disabled={busy}
            className="press-response flex items-center gap-1 rounded-xl bg-warning px-4 py-2 text-xs font-bold text-primary-foreground"
          >
            <Plus className="h-4 w-4" />
            Crear Sucursal
          </button>
        </form>
      </section>

      {/* 4. Mesas y Medios de Pago de la Sucursal Actual */}
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="solid-card space-y-3 rounded-2xl p-5">
          <div className="flex items-center gap-2">
            <Table2 className="h-5 w-5 text-primary" />
            <h3 className="font-display text-base font-bold">Mesas de Esta Sucursal</h3>
          </div>
          <div className="flex flex-wrap gap-2">
            {store.diningTables.map((t) => (
              <span
                key={t.id}
                className="rounded-xl border border-white/10 bg-background/60 px-3 py-1.5 text-xs font-semibold"
              >
                {t.label}
              </span>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="Ej. Mesa 7, Barra 2, Terraza 1"
              value={newTableLabel}
              onChange={(e) => setNewTableLabel(e.target.value)}
              className="flex-1 rounded-xl border border-white/15 bg-background px-3 py-2 text-xs"
            />
            <button
              type="button"
              disabled={busy || !newTableLabel.trim()}
              onClick={() => void handleAddTable()}
              className="press-response rounded-xl bg-primary px-4 py-2 text-xs font-bold text-primary-foreground"
            >
              + Mesa
            </button>
          </div>
        </section>

        <section className="solid-card space-y-3 rounded-2xl p-5">
          <div className="flex items-center gap-2">
            <CreditCard className="h-5 w-5 text-success" />
            <h3 className="font-display text-base font-bold">Medios de Pago Configurados</h3>
          </div>
          <div className="flex flex-wrap gap-2">
            {store.paymentMethods.map((pm) => (
              <span
                key={pm.id}
                className="rounded-xl border border-white/10 bg-background/60 px-3 py-1.5 text-xs font-semibold"
              >
                {pm.name} {pm.countsAsPhysicalCash ? "(Efectivo)" : ""}
              </span>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              placeholder="Ej. Transferencia, Bold, Bancolombia"
              value={newPaymentName}
              onChange={(e) => setNewPaymentName(e.target.value)}
              className="min-w-44 flex-1 rounded-xl border border-white/15 bg-background px-3 py-2 text-xs"
            />
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={newPaymentCash}
                onChange={(e) => setNewPaymentCash(e.target.checked)}
                className="accent-success"
              />
              Efectivo físico
            </label>
            <button
              type="button"
              disabled={busy || !newPaymentName.trim()}
              onClick={() => void handleAddPaymentMethod()}
              className="press-response rounded-xl bg-success px-4 py-2 text-xs font-bold text-primary-foreground"
            >
              + Medio
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
