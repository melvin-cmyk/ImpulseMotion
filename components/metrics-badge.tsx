import { cn } from "@/lib/utils";

interface MetricBadgeProps {
  label: string;
  value: string;
  highlight?: "green" | "red" | "yellow" | "blue" | "none";
  className?: string;
}

export function MetricBadge({
  label,
  value,
  highlight = "none",
  className,
}: MetricBadgeProps) {
  const highlightClasses = {
    green: "text-green-400",
    red: "text-red-400",
    yellow: "text-yellow-400",
    blue: "text-blue-400",
    none: "text-white",
  };

  return (
    <div
      className={cn(
        "flex items-center justify-between rounded bg-gray-800/60 px-2.5 py-1.5 border border-gray-700/40",
        className
      )}
    >
      <span className="text-xs text-gray-400 font-medium">{label}</span>
      <span className={cn("text-xs font-bold ml-2", highlightClasses[highlight])}>
        {value}
      </span>
    </div>
  );
}

export function MetricStack({
  metrics,
  compact = false,
}: {
  metrics: Array<{ label: string; value: string; highlight?: MetricBadgeProps["highlight"] }>;
  compact?: boolean;
}) {
  return (
    <div className={cn("flex flex-col gap-1", compact ? "gap-0.5" : "gap-1")}>
      {metrics.map((m) => (
        <MetricBadge
          key={m.label}
          label={m.label}
          value={m.value}
          highlight={m.highlight}
        />
      ))}
    </div>
  );
}
