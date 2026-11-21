import {
  Beer,
  Cigarette,
  Coffee,
  Handshake,
  Layers,
  Martini,
  Package,
  Utensils,
  Wine,
} from "lucide-react";
import type { PresentationGroup, ProductKind } from "@liquistock/domain";
import { resolveImageUrl } from "../../infrastructure/api/api-client.js";

/**
 * Custom Lucide-style stroke SVG for commercial bottled beer (matching 24x24, strokeWidth 2).
 */
export function BeerBottleIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M10 2h4" />
      <path d="M10.5 2v4.2a2 2 0 0 1-.6 1.4L8.6 9A3 3 0 0 0 7.7 11.1V20a2 2 0 0 0 2 2h4.6a2 2 0 0 0 2-2v-8.9a3 3 0 0 0-.9-2.1l-1.3-1.4a2 2 0 0 1-.6-1.4V2" />
      <path d="M7.7 13h8.6" />
      <path d="M7.7 17.5h8.6" />
    </svg>
  );
}

export type ProductIconToken =
  | "icon:craft_beer"
  | "icon:beer_bottle"
  | "icon:coffee"
  | "icon:cocktail"
  | "icon:liquor"
  | "icon:food"
  | "icon:snacks"
  | "icon:cigarettes"
  | "icon:combo";

interface IconStyleConfig {
  Icon: typeof Beer | typeof BeerBottleIcon;
  containerClass: string;
}

function resolveIconConfig(params: {
  imageUrl?: string | null;
  productKind?: ProductKind;
  allyId?: string | null;
  presentationGroup?: PresentationGroup;
  name?: string;
}): IconStyleConfig {
  const { imageUrl, productKind, allyId, presentationGroup, name = "" } = params;
  const lower = name.toLowerCase();

  if (imageUrl === "icon:coffee") {
    return { Icon: Coffee, containerClass: "bg-warning/15 text-warning ring-1 ring-warning/25" };
  }
  if (imageUrl === "icon:cocktail") {
    return { Icon: Martini, containerClass: "bg-accent/15 text-accent ring-1 ring-accent/25" };
  }
  if (imageUrl === "icon:beer_bottle") {
    return {
      Icon: BeerBottleIcon,
      containerClass: "bg-primary/15 text-primary ring-1 ring-primary/25",
    };
  }
  if (imageUrl === "icon:craft_beer") {
    return { Icon: Beer, containerClass: "bg-warning/15 text-warning ring-1 ring-warning/25" };
  }
  if (imageUrl === "icon:liquor") {
    return { Icon: Wine, containerClass: "bg-accent/15 text-accent ring-1 ring-accent/25" };
  }
  if (imageUrl === "icon:food") {
    return { Icon: Utensils, containerClass: "bg-success/15 text-success ring-1 ring-success/25" };
  }
  if (imageUrl === "icon:snacks") {
    return { Icon: Package, containerClass: "bg-secondary text-primary ring-1 ring-white/10" };
  }
  if (imageUrl === "icon:cigarettes") {
    return {
      Icon: Cigarette,
      containerClass: "bg-secondary text-muted-foreground ring-1 ring-white/10",
    };
  }
  if (imageUrl === "icon:combo") {
    return { Icon: Layers, containerClass: "bg-primary/15 text-primary ring-1 ring-primary/25" };
  }

  // Automatic fallback inference when no explicit icon token is set
  if (allyId || productKind === "third_party_ally") {
    return { Icon: Handshake, containerClass: "bg-warning/15 text-warning ring-1 ring-warning/25" };
  }
  if (productKind === "combo") {
    return { Icon: Layers, containerClass: "bg-primary/15 text-primary ring-1 ring-primary/25" };
  }
  if (
    lower.includes("café") ||
    lower.includes("cafe") ||
    lower.includes("espresso") ||
    lower.includes("tinto") ||
    lower.includes("latte") ||
    lower.includes("capuccino") ||
    lower.includes("cappuccino") ||
    lower.includes("carajillo")
  ) {
    return { Icon: Coffee, containerClass: "bg-warning/15 text-warning ring-1 ring-warning/25" };
  }
  if (presentationGroup === "coctel") {
    return { Icon: Martini, containerClass: "bg-accent/15 text-accent ring-1 ring-accent/25" };
  }
  if (presentationGroup === "botella" || presentationGroup === "lata") {
    if (lower.includes("cerveza") || lower.includes("club") || lower.includes("poker") || lower.includes("aguila") || lower.includes("corona")) {
      return {
        Icon: BeerBottleIcon,
        containerClass: "bg-primary/15 text-primary ring-1 ring-primary/25",
      };
    }
    return { Icon: Wine, containerClass: "bg-accent/15 text-accent ring-1 ring-accent/25" };
  }
  if (presentationGroup === "shot" || presentationGroup === "trago") {
    return { Icon: Wine, containerClass: "bg-accent/15 text-accent ring-1 ring-accent/25" };
  }
  if (presentationGroup === "comida") {
    return { Icon: Utensils, containerClass: "bg-success/15 text-success ring-1 ring-success/25" };
  }
  if (lower.includes("cigarr") || lower.includes("marlboro")) {
    return {
      Icon: Cigarette,
      containerClass: "bg-secondary text-muted-foreground ring-1 ring-white/10",
    };
  }
  return { Icon: Beer, containerClass: "bg-primary/12 text-primary ring-1 ring-primary/20" };
}

export function ProductVisualAvatar({
  imageUrl,
  name,
  productKind,
  allyId,
  presentationGroup,
  size = "md",
}: {
  imageUrl?: string | null;
  name: string;
  productKind?: ProductKind;
  allyId?: string | null;
  presentationGroup?: PresentationGroup;
  size?: "sm" | "md";
}) {
  const realUrl = resolveImageUrl(imageUrl);
  const dim = size === "sm" ? "h-12 w-12" : "h-14 w-14";
  const iconDim = size === "sm" ? "h-5 w-5" : "h-6 w-6";

  if (realUrl) {
    return (
      <img
        src={realUrl}
        alt={name}
        loading="lazy"
        className={`${dim} shrink-0 rounded-xl object-cover ring-1 ring-white/10`}
      />
    );
  }

  const { Icon, containerClass } = resolveIconConfig({
    imageUrl,
    productKind,
    allyId,
    presentationGroup,
    name,
  });

  return (
    <div
      className={`flex ${size === "sm" ? "h-12 w-12" : "h-12 w-12"} shrink-0 items-center justify-center rounded-xl ${containerClass}`}
    >
      <Icon className={iconDim} />
    </div>
  );
}

export function InventoryItemTypeIcon({
  name,
  baseUnit,
  isKeg,
  className = "h-4 w-4",
}: {
  name: string;
  baseUnit: "ml" | "g" | "unit";
  isKeg?: boolean;
  className?: string;
}) {
  const lower = name.toLowerCase();
  if (isKeg) return <Beer className={`${className} text-warning`} />;
  if (lower.includes("café") || lower.includes("cafe") || lower.includes("grano")) {
    return <Coffee className={`${className} text-warning`} />;
  }
  if (
    baseUnit === "unit" &&
    (lower.includes("cerveza") ||
      lower.includes("poker") ||
      lower.includes("club") ||
      lower.includes("aguila") ||
      lower.includes("corona") ||
      lower.includes("heineken") ||
      lower.includes("botella"))
  ) {
    return <BeerBottleIcon className={`${className} text-primary`} />;
  }
  if (lower.includes("cigarr") || lower.includes("marlboro")) {
    return <Cigarette className={`${className} text-muted-foreground`} />;
  }
  if (baseUnit === "ml") {
    return <Wine className={`${className} text-accent`} />;
  }
  if (lower.includes("empanada") || lower.includes("carne") || lower.includes("limón") || lower.includes("limon")) {
    return <Utensils className={`${className} text-success`} />;
  }
  return <Package className={`${className} text-primary`} />;
}
