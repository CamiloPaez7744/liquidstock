export function formatCOP(amount: number): string {
  return new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    maximumFractionDigits: 0,
  }).format(Math.round(amount));
}

export function formatBaseQuantity(qty: number, baseUnit: "ml" | "g" | "unit"): string {
  if (baseUnit === "ml") {
    if (Math.abs(qty) >= 1000) {
      return `${(qty / 1000).toFixed(2)} L`;
    }
    return `${Math.round(qty)} ml`;
  }
  if (baseUnit === "g") {
    if (Math.abs(qty) >= 1000) {
      return `${(qty / 1000).toFixed(2)} kg`;
    }
    return `${Math.round(qty)} g`;
  }
  return `${Math.round(qty)} und`;
}

export function getCurrentIsoDayAndTime(): {
  isoDay: number;
  hhmm: string;
  yyyymmdd: string;
} {
  const now = new Date();
  const jsDay = now.getDay();
  const isoDay = jsDay === 0 ? 7 : jsDay;
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const yyyy = now.getFullYear();
  const mo = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return { isoDay, hhmm: `${hh}:${mm}`, yyyymmdd: `${yyyy}-${mo}-${dd}` };
}

