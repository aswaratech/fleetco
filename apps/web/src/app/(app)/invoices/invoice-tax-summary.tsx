import { formatNpr } from "@/lib/money";
import { formatRateBpPercent } from "@/lib/invoices-tax";

// The VAT/TDS money breakdown for an invoice (D6 / ADR-0039 c3, c8). A pure
// presentation component shared by the detail page and the edit page. It renders
// whatever figures it is handed:
//   - an ISSUED invoice passes its FROZEN snapshot columns (the anti-tamper
//     freeze — the numbers are a historical fact, never recomputed);
//   - a DRAFT passes a PROVISIONAL preview computed client/server-side from the
//     current lines (computeInvoiceTaxPreview), flagged `provisional` so the
//     operator knows these numbers finalize only at issue.
//
// The breakdown follows ADR-0039 c3: subtotal → discount → taxable → VAT (a
// percentage of taxable) → GROSS BILLED (what the customer owes), then the TDS
// memo (withheld by the payer, NOT added to gross) → NET RECEIVABLE (the cash
// FleetCo expects). Money via formatNpr; integer paisa in, formatted only at the
// edge (anti-pattern #14). No new design token.

export interface InvoiceTaxSummaryFigures {
  subtotalPaisa: number;
  discountPaisa: number;
  vatRateBp: number;
  vatPaisa: number;
  grossPaisa: number;
  tdsRateBp: number;
  tdsPaisa: number;
  netReceivablePaisa: number;
}

interface InvoiceTaxSummaryProps {
  figures: InvoiceTaxSummaryFigures;
  /** A DRAFT preview (true) vs an issued, frozen snapshot (false/undefined). */
  provisional?: boolean;
}

function Row({
  label,
  value,
  emphasis,
  muted,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  emphasis?: boolean;
  muted?: boolean;
}): React.ReactElement {
  return (
    <div
      className={[
        "flex items-baseline justify-between gap-4 py-1.5",
        emphasis ? "border-border-subtle border-t pt-2.5" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <dt className={muted ? "text-text-muted text-sm" : "text-text-secondary text-sm"}>{label}</dt>
      <dd
        className={[
          "tabular-nums",
          emphasis ? "text-text-primary text-base font-semibold" : "text-text-primary text-sm",
          muted ? "text-text-muted" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {value}
      </dd>
    </div>
  );
}

export function InvoiceTaxSummary({
  figures,
  provisional,
}: InvoiceTaxSummaryProps): React.ReactElement {
  const hasDiscount = figures.discountPaisa > 0;
  const taxablePaisa = figures.subtotalPaisa - figures.discountPaisa;

  return (
    <dl className="ml-auto w-full max-w-sm">
      <Row label="Subtotal" value={formatNpr(figures.subtotalPaisa)} />
      {hasDiscount ? (
        <Row label="Discount" value={`− ${formatNpr(figures.discountPaisa)}`} />
      ) : null}
      {hasDiscount ? <Row label="Taxable value" value={formatNpr(taxablePaisa)} muted /> : null}
      <Row
        label={`VAT (${formatRateBpPercent(figures.vatRateBp)})`}
        value={formatNpr(figures.vatPaisa)}
      />
      <Row label="Gross billed" value={formatNpr(figures.grossPaisa)} emphasis />
      <Row
        label={`Less: TDS withheld (${formatRateBpPercent(figures.tdsRateBp)})`}
        value={`− ${formatNpr(figures.tdsPaisa)}`}
        muted
      />
      <Row label="Net receivable" value={formatNpr(figures.netReceivablePaisa)} emphasis />
      <p className="text-text-muted mt-3 text-xs">
        {provisional
          ? "Provisional — these figures are computed from the current lines and are frozen when the invoice is issued."
          : "Gross is the amount billed to the customer. TDS is withheld by the customer and remitted to the IRD on FleetCo’s behalf; net receivable is the expected cash."}
      </p>
      <p className="text-text-muted mt-1 text-xs">
        VAT/TDS rates are proposed pending operator/accountant verification (ADR-0039).
      </p>
    </dl>
  );
}
