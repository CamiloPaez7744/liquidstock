import { useState } from "react";
import { Check, CheckCircle2, Copy, X } from "lucide-react";
import type { OrderItemLine } from "@liquistock/domain";
import { resolveImageUrl } from "../../infrastructure/api/api-client.js";
import { formatCOP } from "../../shared/lib/format.js";
import { haptics } from "../../shared/lib/haptics.js";

export interface ReceiptBarBranding {
  name: string;
  legalName?: string | null;
  taxId?: string | null;
  logoUrl?: string | null;
  instagram?: string | null;
  contactPhone?: string | null;
}

export interface DigitalReceiptData {
  branchName: string;
  barBranding?: ReceiptBarBranding;
  tableLabel: string;
  subAccountLabel: string;
  closedAt: string;
  items: OrderItemLine[];
  subtotal: number;
  discount: number;
  total: number;
  paymentSummary: string;
  customerName?: string | null;
  creditAmount?: number;
}

export function DigitalReceiptModal({
  receipt,
  onClose,
}: {
  receipt: DigitalReceiptData;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const branding = receipt.barBranding;
  const logoSrc = resolveImageUrl(branding?.logoUrl);

  const buildPlainText = () => {
    const headerTitle = branding?.name
      ? `${branding.name} · ${receipt.branchName}`
      : receipt.branchName;
    const lines = [`*${headerTitle}*`];
    if (branding?.legalName) {
      lines.push(
        branding.taxId ? `${branding.legalName} · NIT ${branding.taxId}` : branding.legalName,
      );
    }
    lines.push(
      `${receipt.tableLabel} · ${receipt.subAccountLabel}`,
      new Date(receipt.closedAt).toLocaleString("es-CO"),
      "------------------------",
      ...receipt.items.map(
        (i) =>
          `${i.quantity}x ${i.productNameSnap} (${i.presentationNameSnap}) - ${formatCOP(i.lineTotal)}`,
      ),
      "------------------------",
    );
    if (receipt.discount > 0) lines.push(`Descuento promos/cortesías: -${formatCOP(receipt.discount)}`);
    lines.push(`*TOTAL: ${formatCOP(receipt.total)}*`);
    lines.push(`Estado: ${receipt.paymentSummary}`);
    if (receipt.customerName) lines.push(`Cliente: ${receipt.customerName}`);
    if (branding?.instagram) lines.push(`Síguenos: ${branding.instagram}`);
    return lines.join("\n");
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(buildPlainText());
      haptics.tap();
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Ignore clipboard failure
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/75 backdrop-blur-sm sm:items-center sm:p-4">
      <div className="material-thick safe-bottom w-full max-w-md overflow-hidden rounded-t-3xl border border-white/10 sm:rounded-3xl">
        <div className="flex items-center justify-between border-b border-white/10 bg-success/10 px-5 py-4">
          <div className="flex items-center gap-3">
            <CheckCircle2 className="h-7 w-7 text-success" />
            <div>
              <h3 className="font-display text-lg font-bold text-foreground">Recibo Digital</h3>
              <p className="text-xs text-muted-foreground">
                {receipt.tableLabel} · {receipt.subAccountLabel}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="press-response flex h-10 w-10 items-center justify-center rounded-xl bg-secondary/80 text-foreground"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="max-h-[60vh] space-y-3 overflow-y-auto p-5">
          <div className="flex flex-col items-center text-center">
            {logoSrc && (
              <img
                src={logoSrc}
                alt={branding?.name ?? receipt.branchName}
                className="mb-2 h-12 w-12 rounded-xl object-cover ring-1 ring-white/20"
              />
            )}
            <p className="font-display text-base font-bold">
              {branding?.name ?? receipt.branchName}
            </p>
            {branding?.name && (
              <p className="text-xs font-medium text-primary">{receipt.branchName}</p>
            )}
            {branding?.legalName && (
              <p className="text-[11px] text-muted-foreground">
                {branding.legalName}
                {branding.taxId ? ` · NIT ${branding.taxId}` : ""}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              {new Date(receipt.closedAt).toLocaleString("es-CO")}
            </p>
          </div>

          <div className="divide-y divide-white/10 rounded-2xl bg-background/60 p-3">
            {receipt.items.map((item) => (
              <div key={item.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                <div>
                  <p className="font-medium text-foreground">
                    {item.quantity}x {item.productNameSnap}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {item.presentationNameSnap}
                    {item.allyIdSnap ? " · Aliado" : ""}
                  </p>
                </div>
                <div className="text-right tabular-nums">
                  <p className="font-semibold">{formatCOP(item.lineTotal)}</p>
                  {item.discountAmount > 0 && (
                    <p className="text-xs text-success">-{formatCOP(item.discountAmount)}</p>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div className="space-y-1.5 rounded-2xl bg-secondary/40 p-4 text-sm tabular-nums">
            <div className="flex justify-between text-muted-foreground">
              <span>Subtotal</span>
              <span>{formatCOP(receipt.subtotal)}</span>
            </div>
            {receipt.discount > 0 && (
              <div className="flex justify-between text-success">
                <span>Promociones / Cortesías</span>
                <span>-{formatCOP(receipt.discount)}</span>
              </div>
            )}
            <div className="flex justify-between border-t border-white/10 pt-2 text-lg font-bold text-foreground">
              <span>Total</span>
              <span className="text-primary">{formatCOP(receipt.total)}</span>
            </div>
            <p className="pt-1 text-xs font-medium text-success">{receipt.paymentSummary}</p>
            {receipt.customerName && (
              <p className="text-xs text-warning">
                Cliente: {receipt.customerName}
                {receipt.creditAmount ? ` (Fiado: ${formatCOP(receipt.creditAmount)})` : ""}
              </p>
            )}
            {branding?.instagram && (
              <p className="pt-1 text-center text-[11px] text-muted-foreground">
                Síguenos en {branding.instagram}
              </p>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 border-t border-white/10 p-4">
          <button
            type="button"
            onClick={handleCopy}
            className="press-response flex min-h-13 items-center justify-center gap-2 rounded-2xl bg-secondary font-semibold text-foreground"
          >
            {copied ? <Check className="h-5 w-5 text-success" /> : <Copy className="h-5 w-5" />}
            <span>{copied ? "Copiado" : "Copiar WhatsApp"}</span>
          </button>
          <button
            type="button"
            onClick={onClose}
            className="press-response flex min-h-13 items-center justify-center rounded-2xl bg-primary font-bold text-primary-foreground"
          >
            Listo
          </button>
        </div>
      </div>
    </div>
  );
}
