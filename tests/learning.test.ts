import { describe, expect, it } from "vitest";
import { LearningEngine, type LearningItem, type ReviewRecord, type LearnerMastery } from "../src/learning.js";

describe("Adaptive Learning Progression & Spaced Repetition Engine", () => {
  const engine = new LearningEngine();

  const mockItemA: LearningItem = {
    id: "item_vocab_01",
    unitId: "unit_travel_1",
    topic: "Directions",
    level: "A1",
    prompt: "Where is the train station?",
    correctAnswer: "Wo ist der Bahnhof?",
    distractors: ["Wie viel kostet das?", "Guten Tag"],
    contentHash: LearningEngine.computeContentHash("Where is the train station?", "Wo ist der Bahnhof?"),
  };

  const mockItemB: LearningItem = {
    id: "item_vocab_02",
    unitId: "unit_travel_1",
    topic: "Directions",
    level: "A1",
    prompt: "Turn left at the corner",
    correctAnswer: "Biegen Sie an der Ecke links ab",
    distractors: ["Geradeaus bitte", "Rechts abbiegen"],
    contentHash: LearningEngine.computeContentHash("Turn left at the corner", "Biegen Sie an der Ecke links ab"),
  };

  it("calculates progression on successful fast recall: promotes Leitner box and scales interval", () => {
    const review: ReviewRecord = {
      learnerId: "user_de_101",
      itemId: mockItemA.id,
      accuracyScore: 1.0,
      latencyMs: 1800, // fast recall bonus (<3000ms)
      reviewedAt: "2026-11-24T10:00:00.000Z",
    };

    const nextMastery = engine.calculateProgression(review, null, new Date(review.reviewedAt));

    expect(nextMastery.leitnerBox).toBe(2);
    expect(nextMastery.repetitionCount).toBe(1);
    expect(nextMastery.stabilityFactor).toBeGreaterThan(1.5);
    expect(nextMastery.intervalDays).toBeGreaterThanOrEqual(3);
    expect(nextMastery.nextDueAt).toBe("2026-11-29T10:00:00.000Z"); // 5 days spaced interval
  });

  it("resets Leitner box to 1 on memory lapse", () => {
    const existingMastery: LearnerMastery = {
      learnerId: "user_de_101",
      itemId: mockItemA.id,
      leitnerBox: 4,
      repetitionCount: 5,
      stabilityFactor: 2.4,
      intervalDays: 28,
      nextDueAt: "2026-11-24T00:00:00.000Z",
      lastReviewedAt: "2026-10-27T00:00:00.000Z",
    };

    const failedReview: ReviewRecord = {
      learnerId: "user_de_101",
      itemId: mockItemA.id,
      accuracyScore: 0.4, // failure
      latencyMs: 11000,
      reviewedAt: "2026-11-24T12:00:00.000Z",
    };

    const lapsed = engine.calculateProgression(failedReview, existingMastery, new Date(failedReview.reviewedAt));

    expect(lapsed.leitnerBox).toBe(1);
    expect(lapsed.intervalDays).toBe(1);
    expect(lapsed.stabilityFactor).toBeLessThan(existingMastery.stabilityFactor);
  });

  it("prioritizes due spaced repetition reviews before introducing unattempted catalog items", () => {
    const masteries = new Map<string, LearnerMastery>();
    
    // Item A is overdue by 2 days
    masteries.set(mockItemA.id, {
      learnerId: "user_de_101",
      itemId: mockItemA.id,
      leitnerBox: 2,
      repetitionCount: 2,
      stabilityFactor: 1.5,
      intervalDays: 3,
      nextDueAt: "2026-11-22T10:00:00.000Z",
      lastReviewedAt: "2026-11-19T10:00:00.000Z",
    });

    const catalog = [mockItemB, mockItemA]; // Catalog has B first, then A
    const now = new Date("2026-11-24T12:00:00.000Z");

    const queue = engine.selectNextQueue(catalog, masteries, 2, now);

    // Item A should be placed first because it is due for review
    expect(queue[0].id).toBe(mockItemA.id);
    expect(queue[1].id).toBe(mockItemB.id);
  });

  it("constructs deterministic telemetry events with cryptographic payload hashing", () => {
    const review: ReviewRecord = {
      learnerId: "user_de_101",
      itemId: mockItemA.id,
      accuracyScore: 0.95,
      latencyMs: 2200,
      reviewedAt: "2026-11-24T14:30:00.000Z",
    };

    const mastery = engine.calculateProgression(review, null, new Date(review.reviewedAt));
    const telemetry = engine.buildTelemetryEvent(review, mastery);

    expect(telemetry.eventType).toBe("MASTERY_PROMOTED");
    expect(telemetry.payloadHash).toMatch(/^[a-f0-9]{64}$/);
    expect(telemetry.eventId).toContain("evt_");
  });
});
