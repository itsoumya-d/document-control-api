import { createHash } from "node:crypto";

export type ProficiencyLevel = "A1" | "A2" | "B1" | "B2" | "C1";

export interface LearningItem {
  id: string;
  unitId: string;
  topic: string;
  level: ProficiencyLevel;
  prompt: string;
  correctAnswer: string;
  distractors: string[];
  contentHash: string;
}

export interface ReviewRecord {
  learnerId: string;
  itemId: string;
  accuracyScore: number; // 0.0 to 1.0
  latencyMs: number;
  reviewedAt: string;
}

export interface LearnerMastery {
  learnerId: string;
  itemId: string;
  leitnerBox: number; // 1 to 5
  repetitionCount: number;
  stabilityFactor: number;
  intervalDays: number;
  nextDueAt: string;
  lastReviewedAt: string;
}

export interface TelemetryEvent {
  eventId: string;
  eventType: "REVIEW_RECORDED" | "MASTERY_PROMOTED" | "RETENTION_LAPSED";
  learnerId: string;
  itemId: string;
  payload: Record<string, unknown>;
  payloadHash: string;
  emittedAt: string;
}

export class LearningEngine {
  public static computeContentHash(prompt: string, answer: string): string {
    return createHash("sha256")
      .update(`${prompt.trim()}::${answer.trim()}`)
      .digest("hex");
  }

  public calculateProgression(
    review: ReviewRecord,
    current: LearnerMastery | null,
    referenceNow?: Date
  ): LearnerMastery {
    const now = referenceNow || new Date(review.reviewedAt);
    const isFirstAttempt = !current;

    // Latency multiplier: response under 3000ms demonstrates high retrieval fluency
    const speedBonus = review.latencyMs < 3000 ? 1.15 : review.latencyMs > 8000 ? 0.9 : 1.0;
    const isPassing = review.accuracyScore >= 0.75;

    let leitnerBox = current ? current.leitnerBox : 1;
    let repetitionCount = current ? current.repetitionCount + 1 : 1;
    let stability = current ? current.stabilityFactor : 1.0;
    let intervalDays = 1;

    if (isPassing) {
      leitnerBox = Math.min(5, leitnerBox + 1);
      stability = Number((stability * (1.2 + review.accuracyScore * 0.3) * speedBonus).toFixed(3));
      
      // Exponential spaced interval: Box 1: 1d, Box 2: 3d, Box 3: 7d, Box 4: 14d, Box 5: 30d
      const baseIntervals = [1, 3, 7, 14, 30];
      intervalDays = Math.max(1, Math.round(baseIntervals[leitnerBox - 1] * stability));
    } else {
      // Memory lapse: reset box to 1 and reduce stability factor
      leitnerBox = 1;
      stability = Math.max(0.6, Number((stability * 0.65).toFixed(3)));
      intervalDays = 1;
    }

    const nextDue = new Date(now.getTime() + intervalDays * 24 * 60 * 60 * 1000);

    return {
      learnerId: review.learnerId,
      itemId: review.itemId,
      leitnerBox,
      repetitionCount,
      stabilityFactor: stability,
      intervalDays,
      nextDueAt: nextDue.toISOString(),
      lastReviewedAt: now.toISOString(),
    };
  }

  public selectNextQueue(
    catalog: LearningItem[],
    masteries: Map<string, LearnerMastery>,
    targetBatchSize: number = 5,
    referenceNow?: Date
  ): LearningItem[] {
    const now = (referenceNow || new Date()).getTime();
    const dueReviews: LearningItem[] = [];
    const newItems: LearningItem[] = [];

    for (const item of catalog) {
      const mastery = masteries.get(item.id);
      if (!mastery) {
        newItems.push(item);
      } else {
        const dueDate = new Date(mastery.nextDueAt).getTime();
        if (dueDate <= now) {
          dueReviews.push(item);
        }
      }
    }

    // Sort due items by most overdue first
    dueReviews.sort((a, b) => {
      const dueA = new Date(masteries.get(a.id)!.nextDueAt).getTime();
      const dueB = new Date(masteries.get(b.id)!.nextDueAt).getTime();
      return dueA - dueB;
    });

    const queue = [...dueReviews];
    if (queue.length < targetBatchSize) {
      const needed = targetBatchSize - queue.length;
      queue.push(...newItems.slice(0, needed));
    }

    return queue.slice(0, targetBatchSize);
  }

  public buildTelemetryEvent(
    review: ReviewRecord,
    updatedMastery: LearnerMastery
  ): TelemetryEvent {
    let eventType: TelemetryEvent["eventType"] = "REVIEW_RECORDED";
    if (updatedMastery.leitnerBox > 1 && review.accuracyScore >= 0.75) {
      eventType = "MASTERY_PROMOTED";
    } else if (review.accuracyScore < 0.75) {
      eventType = "RETENTION_LAPSED";
    }

    const payload: Record<string, unknown> = {
      learnerId: review.learnerId,
      itemId: review.itemId,
      accuracy: review.accuracyScore,
      latencyMs: review.latencyMs,
      leitnerBox: updatedMastery.leitnerBox,
      intervalDays: updatedMastery.intervalDays,
      stabilityFactor: updatedMastery.stabilityFactor,
    };

    const payloadHash = createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex");

    const eventId = `evt_${createHash("sha256")
      .update(`${review.learnerId}_${review.itemId}_${review.reviewedAt}`)
      .digest("hex")
      .slice(0, 16)}`;

    return {
      eventId,
      eventType,
      learnerId: review.learnerId,
      itemId: review.itemId,
      payload,
      payloadHash,
      emittedAt: new Date().toISOString(),
    };
  }
}
