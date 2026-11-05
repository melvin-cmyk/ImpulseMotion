import { Zap } from "lucide-react";

/** ImpulseMotion's mark: the white bolt on a flat tile of the brand violet (#7043F5, Impulse Analytics palette) — no gradient, no glow. */
export function LogoMark({ size = 28, className = "" }: { size?: number; className?: string }) {
  return (
    <span
      className={`inline-flex items-center justify-center shrink-0 bg-[#7043f5] ${className}`}
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.28) }}
      aria-hidden
    >
      <Zap className="text-ui-fg fill-white" style={{ width: size * 0.5, height: size * 0.5 }} />
    </span>
  );
}
