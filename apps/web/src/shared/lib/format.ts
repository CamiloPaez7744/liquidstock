import type { PurchasePresentation } from "@liquistock/domain";

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

/**
 * Translates raw base-unit stock into human-friendly pack & serving estimates:
 * - e.g. 74 units with "Canasta x30" -> "2 Canasta x30 + 14 und"
 * - e.g. 1250 g coffee -> "2.5 lb · ~69 tazas (18g)"
 * - e.g. 18500 ml keg -> "~34 pintas 500ml"
 * - e.g. 2250 ml liquor with "Botella 750ml" -> "3 Botella 750ml · ~50 shots"
 */
export function formatHumanStock(params: {
  name: string;
  stockBase: number;
  baseUnit: "ml" | "g" | "unit";
  isKeg: boolean;
  pourLossPercent: number;
  purchasePresentations: PurchasePresentation[];
}): string | null {
  const { name, stockBase, baseUnit, isKeg, pourLossPercent, purchasePresentations } = params;
  const stock = Math.max(0, stockBase);
  if (stock <= 0) return "Sin existencias";

  const lower = name.toLowerCase();

  // 1. Craft beer keg -> estimated 500ml pints
  if (isKeg && baseUnit === "ml") {
    const pintCost = 500 * (1 + pourLossPercent / 100);
    const pints = Math.floor(stock / pintCost);
    return `~${pints} pintas (500 ml)`;
  }

  // 2. Coffee beans in grams -> pounds + estimated 18g cups
  if (baseUnit === "g" && (lower.includes("café") || lower.includes("cafe") || lower.includes("grano"))) {
    const lbs = (stock / 500).toFixed(1).replace(/\.0$/, "");
    const cups = Math.floor(stock / 18);
    return `${lbs} lb · ~${cups} tazas (18 g)`;
  }

  // 3. Pick largest multi-unit pack (> 1) to express human breakdown (e.g., Canasta x30, Botella 750ml)
  const packs = [...purchasePresentations]
    .filter((p) => p.factorToBase > 1)
    .sort((a, b) => b.factorToBase - a.factorToBase);

  const mainPack = packs[0];
  if (mainPack && stock >= mainPack.factorToBase) {
    const whole = Math.floor(stock / mainPack.factorToBase);
    const rem = Math.round((stock - whole * mainPack.factorToBase) * 10) / 10;
    const packLabel = mainPack.name;
    const breakdown =
      rem > 0 ? `${whole} × ${packLabel} + ${formatBaseQuantity(rem, baseUnit)}` : `${whole} × ${packLabel}`;

    // If liquid bottle, also show approx 1.5oz shots
    if (baseUnit === "ml" && mainPack.factorToBase <= 1200) {
      const shots = Math.floor(stock / (44.36 * (1 + pourLossPercent / 100)));
      return `${breakdown} · ~${shots} shots`;
    }
    return breakdown;
  }

  // 4. Liquids without packs -> estimated shots
  if (baseUnit === "ml" && stock >= 45) {
    const shots = Math.floor(stock / (44.36 * (1 + pourLossPercent / 100)));
    return `~${shots} shots (1.5 oz)`;
  }

  // 5. Solid grams -> pounds if >= 250g
  if (baseUnit === "g" && stock >= 250) {
    const lbs = (stock / 500).toFixed(1).replace(/\.0$/, "");
    return `${lbs} lb`;
  }

  return null;
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
