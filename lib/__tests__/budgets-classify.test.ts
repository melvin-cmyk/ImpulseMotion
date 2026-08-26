import { describe, it, expect } from "vitest";
import { classify } from "@/lib/budgets";

describe("classify (budget pacing)", () => {
  it("maps pacing % to the 5 documented buckets", () => {
    expect(classify(50)).toBe("critical_under");
    expect(classify(69.9)).toBe("critical_under");
    expect(classify(70)).toBe("under");
    expect(classify(89.9)).toBe("under");
    expect(classify(90)).toBe("on_track");
    expect(classify(100)).toBe("on_track");
    expect(classify(110)).toBe("on_track");
    expect(classify(110.1)).toBe("over");
    expect(classify(130)).toBe("over");
    expect(classify(130.1)).toBe("critical_over");
  });
});
