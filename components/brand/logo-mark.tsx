import { Zap } from "lucide-react";

/** ImpulseMotion's mark: the white bolt on the violet tile (same as the sidebar and the tab icon). */
export function LogoMark({ size = 28, className = "" }: { size?: number; className?: string }) {
  return (
    <span
      className={`inline-flex items-center justify-center shrink-0 bg-gradient-to-br from-violet-500 to-purple-700 shadow-[0_0_0_1px_rgba(255,255,255,0.06),0_6px_20px_-6px_rgba(139,92,246,0.6)] ${className}`}
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.28) }}
      aria-hidden
    >
      <Zap className="text-white fill-white" style={{ width: size * 0.5, height: size * 0.5 }} />
    </span>
  );
}
