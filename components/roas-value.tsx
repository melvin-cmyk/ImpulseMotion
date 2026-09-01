import { cn } from "@/lib/utils";
import { fmtX } from "@/lib/creative-format";

export const ROAS_ESTIMATED_TITLE = "ROAS estimé (panier moyen)";

interface RoasValueProps {
  value: number | null | undefined;
  /** True when the underlying revenue was estimated from purchases × AOV. */
  estimated?: boolean;
  /** Colour by threshold (>= 2 emerald, >= 1 amber, else red). Default: inherit. */
  tone?: boolean;
  className?: string;
}

/** ROAS with the "*" marker required whenever the value is estimated. */
export function RoasValue({ value, estimated, tone, className }: RoasValueProps) {
  const hasValue = value !== null && value !== undefined && Number.isFinite(value);
  const color =
    tone && hasValue
      ? value >= 2
        ? "text-emerald-400"
        : value >= 1
          ? "text-amber-400"
          : "text-red-400"
      : undefined;
  return (
    <span className={cn(color, className)} title={estimated && hasValue ? ROAS_ESTIMATED_TITLE : undefined}>
      {fmtX(value)}
      {estimated && hasValue && <span className="text-gray-500 ml-0.5">*</span>}
    </span>
  );
}
