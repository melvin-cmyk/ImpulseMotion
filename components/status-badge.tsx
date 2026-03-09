import { cn } from "@/lib/utils";
import type { Status } from "@/lib/mock-data";

interface StatusBadgeProps {
  status: Status;
  className?: string;
}

const statusConfig: Record<Status, { label: string; classes: string }> = {
  Winner: {
    label: "Winner",
    classes: "bg-green-900/50 text-green-400 border border-green-700/50",
  },
  Loser: {
    label: "Loser",
    classes: "bg-red-900/50 text-red-400 border border-red-700/50",
  },
  Fatigued: {
    label: "Fatigued",
    classes: "bg-yellow-900/50 text-yellow-400 border border-yellow-700/50",
  },
  Active: {
    label: "Active",
    classes: "bg-blue-900/50 text-blue-400 border border-blue-700/50",
  },
};

export function StatusBadge({ status, className }: StatusBadgeProps) {
  const config = statusConfig[status];
  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-2 py-0.5 text-xs font-semibold",
        config.classes,
        className
      )}
    >
      <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-current" />
      {config.label}
    </span>
  );
}
