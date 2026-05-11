import { cn } from "@/lib/utils";

/**
 * Design system primitives. Use these instead of writing bg-gray-900/border-gray-800
 * by hand. Tokens consolidated here so we can iterate the palette in one place.
 *
 * Palette tokens (Tailwind-mapped):
 *   surface       — page background           bg-gray-950
 *   surface-card  — raised card               bg-gray-900
 *   surface-mute  — muted nested surface      bg-gray-950/50
 *   border        — default border            border-gray-800
 *   border-mute   — softer border             border-gray-800/60
 *   text-primary  — primary text              text-white
 *   text-secondary— secondary text            text-gray-300
 *   text-muted    — labels/hints              text-gray-500
 *   accent        — primary brand             violet-500
 *   accent-soft   — brand tint                violet-500/15
 *
 * Semantic colors: emerald (positive), amber (warning), red (critical), blue (info).
 */

type CardProps = React.HTMLAttributes<HTMLDivElement> & {
  padded?: boolean;
  interactive?: boolean;
};

export function Card({ className, padded, interactive, ...rest }: CardProps) {
  return (
    <div
      className={cn(
        "bg-gray-900 border border-gray-800 rounded-2xl",
        padded && "p-5",
        interactive && "transition-colors hover:bg-gray-800/40",
        className,
      )}
      {...rest}
    />
  );
}

type SectionProps = {
  title?: React.ReactNode;
  icon?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  tone?: "default" | "warning" | "critical" | "positive";
};

const TONE_BORDER: Record<NonNullable<SectionProps["tone"]>, string> = {
  default: "border-gray-800",
  warning: "border-amber-900/40",
  critical: "border-red-900/40",
  positive: "border-emerald-900/40",
};

export function Section({ title, icon, action, children, className, bodyClassName, tone = "default" }: SectionProps) {
  return (
    <section className={cn("bg-gray-900 border rounded-2xl", TONE_BORDER[tone], className)}>
      {(title || action) && (
        <header className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-white flex items-center gap-2">
            {icon}
            {title}
          </h2>
          {action}
        </header>
      )}
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

type KpiProps = {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  icon?: React.ReactNode;
  accent?: "violet" | "emerald" | "amber" | "red" | "blue" | "gray";
};

const ACCENT_BG: Record<NonNullable<KpiProps["accent"]>, string> = {
  violet: "bg-violet-500/15 text-violet-400",
  emerald: "bg-emerald-500/15 text-emerald-400",
  amber: "bg-amber-500/15 text-amber-400",
  red: "bg-red-500/15 text-red-400",
  blue: "bg-blue-500/15 text-blue-400",
  gray: "bg-gray-800 text-gray-500",
};

export function Kpi({ label, value, sub, icon, accent = "violet" }: KpiProps) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4 flex items-start gap-3">
      {icon && (
        <div className={cn("w-9 h-9 rounded-xl flex items-center justify-center shrink-0", ACCENT_BG[accent])}>
          {icon}
        </div>
      )}
      <div className="min-w-0">
        <p className="text-[11px] text-gray-500 uppercase tracking-wide font-medium">{label}</p>
        <p className="text-xl font-bold text-white mt-0.5 truncate">{value}</p>
        {sub && <p className="text-[11px] text-gray-500 mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

type PageHeaderProps = {
  title: string;
  subtitle?: React.ReactNode;
  action?: React.ReactNode;
};

export function PageHeader({ title, subtitle, action }: PageHeaderProps) {
  return (
    <div className="flex items-end justify-between">
      <div>
        <h1 className="text-2xl font-bold text-white">{title}</h1>
        {subtitle && <p className="text-sm text-gray-400 mt-1">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

type PillProps = {
  children: React.ReactNode;
  tone?: "default" | "violet" | "emerald" | "amber" | "red" | "blue";
  className?: string;
};

const PILL_TONE: Record<NonNullable<PillProps["tone"]>, string> = {
  default: "bg-gray-800 text-gray-300",
  violet: "bg-violet-500/15 text-violet-300",
  emerald: "bg-emerald-500/15 text-emerald-300",
  amber: "bg-amber-500/15 text-amber-300",
  red: "bg-red-500/15 text-red-300",
  blue: "bg-blue-500/15 text-blue-300",
};

export function Pill({ children, tone = "default", className }: PillProps) {
  return (
    <span className={cn("text-xs px-2 py-0.5 rounded font-medium", PILL_TONE[tone], className)}>
      {children}
    </span>
  );
}
