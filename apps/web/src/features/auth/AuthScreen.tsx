import { useEffect, useState } from "react";
import {
  ArrowRight,
  Beer,
  Building2,
  CheckCircle2,
  Clock,
  Crown,
  Eye,
  EyeOff,
  KeyRound,
  Lock,
  Mail,
  ShieldCheck,
  Store,
} from "lucide-react";
import {
  apiFetch,
  saveStoredSession,
  type StoredAuthSession,
  type StoredAuthUser,
} from "../../infrastructure/api/api-client.js";
import { haptics } from "../../shared/lib/haptics.js";

type MainTab = "login" | "register";
type BusinessType = "bar" | "restaurant" | "brewery" | "pub" | "cafe" | "other";

export function AuthScreen({
  onAuthenticated,
}: {
  onAuthenticated: (session: StoredAuthSession) => void;
}) {
  const [hasSuperAdmin, setHasSuperAdmin] = useState<boolean | null>(null);
  const [mainTab, setMainTab] = useState<MainTab>("login");
  const [loginMode, setLoginMode] = useState<"email" | "pin">("email");
  const [registerStep, setRegisterStep] = useState<1 | 2>(1);
  const [registrationSent, setRegistrationSent] = useState<{ barName: string; email: string } | null>(
    null,
  );
  const [showPassword, setShowPassword] = useState(false);

  // SuperAdmin first-time setup
  const [saFullName, setSaFullName] = useState("");
  const [saEmail, setSaEmail] = useState("");
  const [saPassword, setSaPassword] = useState("");

  // Login state
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pinBranchCode, setPinBranchCode] = useState("SEDE1");
  const [pin, setPin] = useState("");

  // Bar/Restaurant Registration state
  const [barName, setBarName] = useState("");
  const [businessType, setBusinessType] = useState<BusinessType>("bar");
  const [legalName, setLegalName] = useState("");
  const [taxId, setTaxId] = useState("");
  const [city, setCity] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [currency, setCurrency] = useState<"COP" | "USD" | "MXN" | "PEN">("COP");
  const [instagram, setInstagram] = useState("");
  const [adminFullName, setAdminFullName] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [adminPin, setAdminPin] = useState("");
  const [branchName, setBranchName] = useState("Sede Principal");
  const [branchCode, setBranchCode] = useState("SEDE1");
  const [tableCount, setTableCount] = useState("6");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void apiFetch<{ hasSuperAdmin: boolean }>("/api/v1/auth/status")
      .then((res) => setHasSuperAdmin(res.hasSuperAdmin))
      .catch(() => setHasSuperAdmin(true));
  }, []);

  const handleCreateSuperAdmin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (saPassword.length < 8) {
      setError("La contraseña del SuperAdmin debe tener mínimo 8 caracteres.");
      return;
    }
    setBusy(true);
    try {
      const res = await apiFetch<{
        token: string;
        user: StoredAuthUser;
        defaultBranchId: string | null;
      }>("/api/v1/auth/superadmin-setup", {
        method: "POST",
        body: JSON.stringify({
          fullName: saFullName.trim(),
          email: saEmail.trim(),
          password: saPassword,
        }),
      });
      const session: StoredAuthSession = {
        token: res.token,
        user: res.user,
        activeBranchId: null,
      };
      saveStoredSession(session);
      haptics.success();
      onAuthenticated(session);
    } catch (err) {
      haptics.blocked();
      setError(err instanceof Error ? err.message : "No se pudo crear el SuperAdmin");
    } finally {
      setBusy(false);
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const endpoint = loginMode === "email" ? "/api/v1/auth/login" : "/api/v1/auth/pin-login";
      const payload =
        loginMode === "email"
          ? { email: email.trim(), password }
          : { branchCode: pinBranchCode.trim().toUpperCase(), pin: pin.trim() };

      const res = await apiFetch<{
        token: string;
        user: StoredAuthUser;
        defaultBranchId: string | null;
      }>(endpoint, {
        method: "POST",
        body: JSON.stringify(payload),
      });

      const activeBranchId = res.user.isSuperAdmin
        ? null
        : (res.defaultBranchId ?? res.user.memberships[0]?.branchId ?? null);

      if (!res.user.isSuperAdmin && !activeBranchId) {
        throw new Error("Tu usuario no tiene sucursales activas en un bar aprobado.");
      }

      const session: StoredAuthSession = {
        token: res.token,
        user: res.user,
        activeBranchId,
      };
      saveStoredSession(session);
      haptics.success();
      onAuthenticated(session);
    } catch (err) {
      haptics.blocked();
      setError(err instanceof Error ? err.message : "No se pudo iniciar sesión");
    } finally {
      setBusy(false);
    }
  };

  const handleRegisterBar = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (adminPassword.length < 8) {
      setError("La contraseña del administrador debe tener mínimo 8 caracteres.");
      return;
    }

    setBusy(true);
    try {
      await apiFetch("/api/v1/auth/register-bar", {
        method: "POST",
        body: JSON.stringify({
          barName: barName.trim(),
          businessType,
          legalName: legalName.trim() || barName.trim(),
          taxId: taxId.trim() || undefined,
          city: city.trim() || undefined,
          contactPhone: contactPhone.trim() || undefined,
          currency,
          socialLinks: instagram.trim() ? { instagram: instagram.trim() } : {},
          adminFullName: adminFullName.trim(),
          adminEmail: adminEmail.trim(),
          adminPassword,
          adminPin: adminPin.trim() || undefined,
          branchName: branchName.trim() || "Sede Principal",
          branchCode: branchCode.trim().toUpperCase() || "SEDE1",
          tableCount: Math.max(0, Number(tableCount) || 6),
          openingFloat: 0,
        }),
      });
      haptics.success();
      setRegistrationSent({ barName: barName.trim(), email: adminEmail.trim() });
    } catch (err) {
      haptics.blocked();
      setError(err instanceof Error ? err.message : "No se pudo enviar la solicitud");
    } finally {
      setBusy(false);
    }
  };

  if (hasSuperAdmin === null) {
    return (
      <div className="flex h-dvh items-center justify-center p-6">
        <div className="solid-card rounded-3xl px-8 py-6 text-center">
          <Beer className="mx-auto h-8 w-8 animate-pulse text-primary" />
          <p className="mt-3 text-sm text-muted-foreground">Conectando con LiquiStock...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-dvh flex-col items-center justify-center overflow-y-auto p-4 sm:p-6">
      <div className="w-full max-w-lg space-y-5">
        {/* Marca */}
        <div className="text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/15 text-primary ring-1 ring-primary/35">
            {hasSuperAdmin ? <Beer className="h-8 w-8" /> : <Crown className="h-8 w-8" />}
          </div>
          <h1 className="mt-3 font-display text-2xl font-bold tracking-tight">LiquiStock</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {!hasSuperAdmin
              ? "Activación de Plataforma · Crea la cuenta del SuperAdmin"
              : "Plataforma POS Offline-First para Bares y Restaurantes"}
          </p>
        </div>

        {/* === FASE 0: CREACIÓN DEL SUPERADMIN ÚNICO (BD EN BLANCO) === */}
        {!hasSuperAdmin ? (
          <form
            onSubmit={handleCreateSuperAdmin}
            className="solid-card space-y-4 rounded-3xl border-warning/30 p-5 sm:p-6"
          >
            <div className="flex items-center gap-2 border-b border-white/10 pb-3 text-xs font-bold text-warning">
              <Crown className="h-4 w-4" />
              <span>Configuración del SuperAdmin de Plataforma</span>
            </div>
            <p className="text-xs text-muted-foreground">
              El SuperAdmin aprueba qué bares y restaurantes pueden ingresar a LiquiStock y supervisa
              el directorio de clientes (no opera como administrador interno de un bar).
            </p>

            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">
                  Nombre completo del SuperAdmin *
                </label>
                <input
                  type="text"
                  required
                  placeholder="Ej. Camilo Páez"
                  value={saFullName}
                  onChange={(e) => setSaFullName(e.target.value)}
                  className="w-full rounded-xl border border-white/15 bg-background px-3.5 py-2.5 text-base sm:text-sm"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">
                  Correo electrónico *
                </label>
                <input
                  type="email"
                  required
                  placeholder="superadmin@liquistock.com"
                  value={saEmail}
                  onChange={(e) => setSaEmail(e.target.value)}
                  className="w-full rounded-xl border border-white/15 bg-background px-3.5 py-2.5 text-base sm:text-sm"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">
                  Contraseña segura (mín. 8 caracteres) *
                </label>
                <div className="relative">
                  <input
                    type={showPassword ? "text" : "password"}
                    required
                    minLength={8}
                    placeholder="••••••••"
                    value={saPassword}
                    onChange={(e) => setSaPassword(e.target.value)}
                    className="w-full rounded-xl border border-white/15 bg-background py-2.5 pl-3.5 pr-10 text-base sm:text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    className="absolute right-3 top-2.5 text-muted-foreground"
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>
            </div>

            {error && (
              <div className="rounded-xl border border-destructive/40 bg-destructive/15 px-3.5 py-2.5 text-xs font-semibold text-destructive">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={busy}
              className="press-response flex min-h-13 w-full items-center justify-center gap-2 rounded-2xl bg-warning text-sm font-bold text-primary-foreground disabled:opacity-50"
            >
              <ShieldCheck className="h-5 w-5" />
              {busy ? "Creando SuperAdmin..." : "Activar Plataforma como SuperAdmin"}
            </button>
          </form>
        ) : (
          /* === FASE NORMAL: LOGIN + REGISTRO DE NUEVOS BARES/RESTAURANTES === */
          <div className="solid-card space-y-4 rounded-3xl p-5 sm:p-6">
            {/* Selector principal: Iniciar Sesión vs Registrar Bar */}
            <div className="grid grid-cols-2 gap-2 rounded-2xl bg-background/70 p-1">
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  setRegistrationSent(null);
                  setMainTab("login");
                }}
                className={`press-response flex min-h-11 items-center justify-center gap-1.5 rounded-xl text-xs font-bold ${
                  mainTab === "login"
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground"
                }`}
              >
                <Lock className="h-4 w-4" />
                Iniciar Sesión
              </button>
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  setRegistrationSent(null);
                  setRegisterStep(1);
                  setMainTab("register");
                }}
                className={`press-response flex min-h-11 items-center justify-center gap-1.5 rounded-xl text-xs font-bold ${
                  mainTab === "register"
                    ? "bg-success text-primary-foreground"
                    : "text-muted-foreground"
                }`}
              >
                <Store className="h-4 w-4" />
                Registrar mi Bar
              </button>
            </div>

            {mainTab === "login" ? (
              <form onSubmit={handleLogin} className="space-y-4">
                <div className="flex items-center justify-center gap-2 text-xs">
                  <button
                    type="button"
                    onClick={() => {
                      setError(null);
                      setLoginMode("email");
                    }}
                    className={`rounded-lg px-3 py-1.5 font-semibold ${
                      loginMode === "email"
                        ? "bg-secondary text-foreground"
                        : "text-muted-foreground"
                    }`}
                  >
                    <Mail className="mr-1 inline h-3.5 w-3.5" />
                    Correo y Clave
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setError(null);
                      setLoginMode("pin");
                    }}
                    className={`rounded-lg px-3 py-1.5 font-semibold ${
                      loginMode === "pin"
                        ? "bg-secondary text-foreground"
                        : "text-muted-foreground"
                    }`}
                  >
                    <KeyRound className="mr-1 inline h-3.5 w-3.5" />
                    PIN Mesero / Tablet
                  </button>
                </div>

                {loginMode === "email" ? (
                  <div className="space-y-3">
                    <div>
                      <label className="mb-1 block text-xs text-muted-foreground">
                        Correo electrónico
                      </label>
                      <input
                        type="email"
                        required
                        autoComplete="email"
                        placeholder="usuario@tubar.com"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        className="w-full rounded-xl border border-white/15 bg-background px-3.5 py-3 text-base sm:text-sm"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs text-muted-foreground">Contraseña</label>
                      <div className="relative">
                        <input
                          type={showPassword ? "text" : "password"}
                          required
                          autoComplete="current-password"
                          placeholder="••••••••"
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          className="w-full rounded-xl border border-white/15 bg-background py-3 pl-3.5 pr-10 text-base sm:text-sm"
                        />
                        <button
                          type="button"
                          onClick={() => setShowPassword((v) => !v)}
                          className="absolute right-3 top-3 text-muted-foreground"
                        >
                          {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div>
                      <label className="mb-1 block text-xs text-muted-foreground">
                        Código de Sucursal (ej. SEDE1)
                      </label>
                      <input
                        type="text"
                        required
                        value={pinBranchCode}
                        onChange={(e) => setPinBranchCode(e.target.value.toUpperCase())}
                        className="w-full rounded-xl border border-white/15 bg-background px-3.5 py-3 text-base font-bold uppercase sm:text-sm"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs text-muted-foreground">
                        PIN de acceso (4-6 dígitos)
                      </label>
                      <input
                        type="password"
                        required
                        inputMode="numeric"
                        maxLength={6}
                        placeholder="••••"
                        value={pin}
                        onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
                        className="w-full rounded-xl border border-white/15 bg-background px-3.5 py-3 text-center text-xl font-bold tracking-[0.4em] tabular-nums"
                      />
                    </div>
                  </div>
                )}

                {error && (
                  <div className="rounded-xl border border-destructive/40 bg-destructive/15 px-3.5 py-2.5 text-xs font-semibold text-destructive">
                    {error}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={busy}
                  className="press-response flex min-h-13 w-full items-center justify-center gap-2 rounded-2xl bg-primary text-sm font-bold text-primary-foreground disabled:opacity-50"
                >
                  <Lock className="h-4 w-4" />
                  {busy ? "Verificando..." : "Entrar"}
                </button>
              </form>
            ) : registrationSent ? (
              /* === CONFIRMACIÓN DE SOLICITUD ENVIADA AL SUPERADMIN === */
              <div className="space-y-4 py-4 text-center">
                <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-warning/15 text-warning">
                  <Clock className="h-8 w-8" />
                </div>
                <div>
                  <h2 className="font-display text-lg font-bold">¡Solicitud enviada!</h2>
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    Registramos <strong>{registrationSent.barName}</strong> con el correo{" "}
                    <strong>{registrationSent.email}</strong>.
                  </p>
                  <p className="mt-2 rounded-xl border border-warning/30 bg-warning/10 p-3 text-xs text-warning">
                    Tu cuenta quedará activa tan pronto sea aprobada tu solicitud.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setEmail(registrationSent.email);
                    setRegistrationSent(null);
                    setMainTab("login");
                  }}
                  className="press-response flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl bg-primary text-sm font-bold text-primary-foreground"
                >
                  <CheckCircle2 className="h-4 w-4" />
                  Ir a Iniciar Sesión
                </button>
              </div>
            ) : (
              /* === REGISTRO DE NUEVO BAR / RESTAURANTE (2 PASOS) === */
              <form onSubmit={handleRegisterBar} className="space-y-4">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-bold text-success">Paso {registerStep} de 2</span>
                  <span className="text-muted-foreground">
                    {registerStep === 1
                      ? "Datos del Bar / Restaurante"
                      : "Cuenta Administrador y Sede"}
                  </span>
                </div>

                {registerStep === 1 ? (
                  <div className="space-y-3">
                    <div className="grid gap-2.5 sm:grid-cols-3">
                      <div className="sm:col-span-2">
                        <label className="mb-1 block text-xs text-muted-foreground">
                          Nombre comercial del Bar / Restaurante *
                        </label>
                        <input
                          type="text"
                          required
                          placeholder="Ej. Cervecería La 80"
                          value={barName}
                          onChange={(e) => setBarName(e.target.value)}
                          className="w-full rounded-xl border border-white/15 bg-background px-3 py-2.5 text-sm"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-xs text-muted-foreground">Tipo *</label>
                        <select
                          value={businessType}
                          onChange={(e) => setBusinessType(e.target.value as BusinessType)}
                          className="w-full rounded-xl border border-white/15 bg-background px-2.5 py-2.5 text-sm"
                        >
                          <option value="bar">Bar</option>
                          <option value="brewery">Cervecería</option>
                          <option value="restaurant">Restaurante</option>
                          <option value="pub">Pub / Gastrobar</option>
                          <option value="cafe">Café Bar</option>
                          <option value="other">Otro</option>
                        </select>
                      </div>
                    </div>

                    <div className="grid gap-2.5 sm:grid-cols-3">
                      <div className="sm:col-span-2">
                        <label className="mb-1 block text-xs text-muted-foreground">
                          Razón Social *
                        </label>
                        <input
                          type="text"
                          required
                          placeholder="Ej. Inversiones La 80 S.A.S."
                          value={legalName}
                          onChange={(e) => setLegalName(e.target.value)}
                          className="w-full rounded-xl border border-white/15 bg-background px-3 py-2.5 text-sm"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-xs text-muted-foreground">
                          NIT / Tax ID
                        </label>
                        <input
                          type="text"
                          placeholder="900.123.456-7"
                          value={taxId}
                          onChange={(e) => setTaxId(e.target.value)}
                          className="w-full rounded-xl border border-white/15 bg-background px-3 py-2.5 text-sm"
                        />
                      </div>
                    </div>

                    <div className="grid gap-2.5 sm:grid-cols-3">
                      <div>
                        <label className="mb-1 block text-xs text-muted-foreground">Ciudad</label>
                        <input
                          type="text"
                          placeholder="Bogotá"
                          value={city}
                          onChange={(e) => setCity(e.target.value)}
                          className="w-full rounded-xl border border-white/15 bg-background px-3 py-2.5 text-sm"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-xs text-muted-foreground">
                          WhatsApp / Tel.
                        </label>
                        <input
                          type="tel"
                          placeholder="300 123 4567"
                          value={contactPhone}
                          onChange={(e) => setContactPhone(e.target.value)}
                          className="w-full rounded-xl border border-white/15 bg-background px-3 py-2.5 text-sm"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-xs text-muted-foreground">Moneda</label>
                        <select
                          value={currency}
                          onChange={(e) =>
                            setCurrency(e.target.value as "COP" | "USD" | "MXN" | "PEN")
                          }
                          className="w-full rounded-xl border border-white/15 bg-background px-2.5 py-2.5 text-sm"
                        >
                          <option value="COP">COP ($)</option>
                          <option value="USD">USD ($)</option>
                          <option value="MXN">MXN ($)</option>
                          <option value="PEN">PEN (S/)</option>
                        </select>
                      </div>
                    </div>

                    <div>
                      <label className="mb-1 block text-xs text-muted-foreground">
                        Instagram / Red social principal (opcional)
                      </label>
                      <input
                        type="text"
                        placeholder="@cerveceriala80"
                        value={instagram}
                        onChange={(e) => setInstagram(e.target.value)}
                        className="w-full rounded-xl border border-white/15 bg-background px-3 py-2.5 text-sm"
                      />
                    </div>

                    <button
                      type="button"
                      onClick={() => {
                        setError(null);
                        if (!barName.trim() || !legalName.trim()) {
                          setError("Completa el nombre comercial y la razón social.");
                          return;
                        }
                        haptics.tap();
                        setRegisterStep(2);
                      }}
                      className="press-response flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl bg-success text-sm font-bold text-primary-foreground"
                    >
                      Continuar a Administrador
                      <ArrowRight className="h-4 w-4" />
                    </button>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="grid gap-2.5 sm:grid-cols-2">
                      <div>
                        <label className="mb-1 block text-xs text-muted-foreground">
                          Nombre del Administrador *
                        </label>
                        <input
                          type="text"
                          required
                          placeholder="Tu nombre completo"
                          value={adminFullName}
                          onChange={(e) => setAdminFullName(e.target.value)}
                          className="w-full rounded-xl border border-white/15 bg-background px-3 py-2.5 text-sm"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-xs text-muted-foreground">
                          Correo electrónico *
                        </label>
                        <input
                          type="email"
                          required
                          placeholder="admin@tubar.com"
                          value={adminEmail}
                          onChange={(e) => setAdminEmail(e.target.value)}
                          className="w-full rounded-xl border border-white/15 bg-background px-3 py-2.5 text-sm"
                        />
                      </div>
                    </div>

                    <div className="grid gap-2.5 sm:grid-cols-2">
                      <div>
                        <label className="mb-1 block text-xs text-muted-foreground">
                          Contraseña (mín. 8) *
                        </label>
                        <input
                          type={showPassword ? "text" : "password"}
                          required
                          minLength={8}
                          placeholder="••••••••"
                          value={adminPassword}
                          onChange={(e) => setAdminPassword(e.target.value)}
                          className="w-full rounded-xl border border-white/15 bg-background px-3 py-2.5 text-sm"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-xs text-muted-foreground">
                          PIN rápido (4-6 díg., opcional)
                        </label>
                        <input
                          type="password"
                          inputMode="numeric"
                          maxLength={6}
                          placeholder="1234"
                          value={adminPin}
                          onChange={(e) => setAdminPin(e.target.value.replace(/\D/g, ""))}
                          className="w-full rounded-xl border border-white/15 bg-background px-3 py-2.5 text-sm tabular-nums"
                        />
                      </div>
                    </div>

                    <div className="rounded-2xl border border-white/10 bg-background/50 p-3">
                      <p className="mb-2 flex items-center gap-1.5 text-xs font-bold text-primary">
                        <Building2 className="h-3.5 w-3.5" />
                        Primera Sucursal (luego podrás crear más)
                      </p>
                      <div className="grid grid-cols-3 gap-2 text-xs">
                        <input
                          type="text"
                          placeholder="Sede Principal"
                          value={branchName}
                          onChange={(e) => setBranchName(e.target.value)}
                          className="rounded-lg border border-white/15 bg-card px-2.5 py-2"
                        />
                        <input
                          type="text"
                          placeholder="Código (SEDE1)"
                          value={branchCode}
                          onChange={(e) => setBranchCode(e.target.value.toUpperCase())}
                          className="rounded-lg border border-white/15 bg-card px-2.5 py-2 font-bold uppercase"
                        />
                        <input
                          type="number"
                          min={0}
                          max={60}
                          placeholder="Mesas"
                          value={tableCount}
                          onChange={(e) => setTableCount(e.target.value)}
                          className="rounded-lg border border-white/15 bg-card px-2.5 py-2 tabular-nums"
                        />
                      </div>
                    </div>

                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => setRegisterStep(1)}
                        className="press-response min-h-12 rounded-2xl bg-secondary px-4 text-sm font-semibold"
                      >
                        Volver
                      </button>
                      <button
                        type="submit"
                        disabled={busy}
                        className="press-response flex min-h-12 flex-1 items-center justify-center gap-2 rounded-2xl bg-success text-sm font-bold text-primary-foreground disabled:opacity-50"
                      >
                        <ShieldCheck className="h-4 w-4" />
                        {busy ? "Enviando solicitud..." : "Enviar solicitud"}
                      </button>
                    </div>
                  </div>
                )}

                {error && (
                  <div className="rounded-xl border border-destructive/40 bg-destructive/15 px-3.5 py-2.5 text-xs font-semibold text-destructive">
                    {error}
                  </div>
                )}
              </form>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
