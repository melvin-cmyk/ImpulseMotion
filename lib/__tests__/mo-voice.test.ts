import { describe, expect, it } from "vitest";
import { VAD_DEFAULT, initialSpeech, nextSentences, sayProgress, speechReduce, splitSentences, vadInitial, vadStep, type SpeechState, type VadState } from "@/lib/mo/voice";

describe("Mo voice — the « say » of a streaming answer", () => {
  it("reads the field while it streams and knows when it is complete", () => {
    expect(sayProgress('```mo\n{\n  "say": "Voilà les créas. Deux ont')).toEqual({ text: "Voilà les créas. Deux ont", complete: false });
    expect(sayProgress('{"say": "Voilà les créas. Deux ont bien marché.", "cards": []')).toEqual({ text: "Voilà les créas. Deux ont bien marché.", complete: true });
    expect(sayProgress('{"cards": [')).toBeNull();
    expect(sayProgress('{"say": "L\\u2019écart est net. ')).toEqual({ text: "L’écart est net. ", complete: false });
  });
  it("splits sentences and keeps the trailing fragment", () => {
    expect(splitSentences("Voilà les créas. Deux ont bien marché ! Et la suite")).toEqual(["Voilà les créas.", "Deux ont bien marché !", "Et la suite"]);
    expect(splitSentences("Une seule phrase…")).toEqual(["Une seule phrase…"]);
  });
  it("hands out the complete sentences once, the fragment at the end", () => {
    let r = nextSentences({ text: "Voilà les créas. Deux ont", complete: false }, 0);
    expect(r).toEqual({ sentences: ["Voilà les créas."], spoken: 1 });
    r = nextSentences({ text: "Voilà les créas. Deux ont bien marché. Et", complete: false }, r.spoken);
    expect(r).toEqual({ sentences: ["Deux ont bien marché."], spoken: 2 });
    r = nextSentences({ text: "Voilà les créas. Deux ont bien marché. Et la suite.", complete: true }, r.spoken);
    expect(r).toEqual({ sentences: ["Et la suite."], spoken: 3 });
    expect(nextSentences({ text: "Voilà les créas. Deux ont bien marché. Et la suite.", complete: true }, 3).sentences).toEqual([]);
  });
  it("waits on a short false end (a decimal, an abbreviation) until the field is complete", () => {
    expect(nextSentences({ text: "CPA 12.", complete: false }, 0).sentences).toEqual([]);
    expect(nextSentences({ text: "CPA 12.", complete: true }, 0).sentences).toEqual(["CPA 12."]);
  });
});

describe("Mo voice — speech queue and barge-in", () => {
  const run = (state: SpeechState, events: Parameters<typeof speechReduce>[1][]) => events.reduce<{ state: SpeechState; starts: string[] }>((acc, e) => { const r = speechReduce(acc.state, e); return { state: r.state, starts: r.start ? [...acc.starts, r.start] : acc.starts }; }, { state, starts: [] });
  it("says sentences one after the other", () => {
    const r = run(initialSpeech, [{ type: "say", text: "Un." }, { type: "say", text: "Deux." }, { type: "say", text: "Trois." }, { type: "ended" }, { type: "ended" }, { type: "ended" }]);
    expect(r.starts).toEqual(["Un.", "Deux.", "Trois."]);
    expect(r.state.speaking).toBe(false);
    expect(r.state.queue).toEqual([]);
  });
  it("« speak » replaces what is being said and what waits", () => {
    const r = run(initialSpeech, [{ type: "say", text: "Un." }, { type: "say", text: "Deux." }, { type: "say", text: "Urgent.", replace: true }]);
    expect(r.starts).toEqual(["Un.", "Urgent."]);
    expect(r.state.queue).toEqual([]);
    expect(r.state.generation).toBe(1);
  });
  it("the person starts talking: Mo stops, the queue is emptied, a late « ended » starts nothing", () => {
    const r = run(initialSpeech, [{ type: "say", text: "Un." }, { type: "say", text: "Deux." }, { type: "hush" }]);
    expect(r.state).toEqual({ speaking: false, current: null, queue: [], generation: 1 });
    const late = speechReduce(r.state, { type: "ended" });
    expect(late.start).toBeNull();
    expect(late.state.speaking).toBe(false);
  });
  it("ignores empty sentences", () => {
    expect(speechReduce(initialSpeech, { type: "say", text: "   " })).toEqual({ state: initialSpeech, start: null });
  });
});

describe("Mo voice — hands-free end-point (700 ms of silence)", () => {
  const feed = (levels: Array<[number, number]>) => { let st: VadState = vadInitial; const events: Array<[number, string]> = []; for (const [t, level] of levels) { const r = vadStep(st, level, t); st = r.state; if (r.event) events.push([t, r.event]); } return events; };
  it("starts on voice and ends after the silence", () => {
    const events = feed([[0, 0.02], [100, 0.3], [200, 0.4], [500, 0.3], [600, 0.02], [900, 0.02], [1200, 0.02], [1310, 0.02]]);
    expect(events).toEqual([[100, "start"], [1200, "end"]]); // 700 ms after the last voice at 500
  });
  it("a pause shorter than the silence does not end the sentence", () => {
    const events = feed([[0, 0.3], [400, 0.02], [800, 0.3], [1200, 0.02], [1500, 0.02], [1900, 0.02], [1950, 0.02]]);
    expect(events).toEqual([[0, "start"], [1500, "end"]]); // the 400 ms pause at 400 did not end it; 700 ms after 800 did
  });
  it("a short burst is noise: cancelled, nothing sent", () => {
    const events = feed([[0, 0.3], [100, 0.02], [900, 0.02]]);
    expect(events).toEqual([[0, "start"], [900, "cancel"]]);
  });
  it("silence alone never fires", () => {
    expect(feed([[0, 0.01], [1000, 0.05], [5000, 0.1]])).toEqual([]);
    expect(VAD_DEFAULT.silenceMs).toBe(700);
  });
});
