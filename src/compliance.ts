export type SensitivityLevel = "UNCLASSIFIED" | "IN_CONFIDENCE" | "SENSITIVE" | "RESTRICTED";
export type RecordCategory = "FINANCIAL" | "PERSONNEL" | "LEGAL_CONTRACT" | "GOVERNANCE_POLICY" | "OPERATIONAL" | "TRANSITORY";
export type DisposalAction = "DESTROY" | "TRANSFER_TO_ARCHIVES" | "PERMANENT_RETAIN";

export interface ComplianceClassification {
  category: RecordCategory;
  sensitivity: SensitivityLevel;
  statutoryScheduleYears: number;
  disposalAction: DisposalAction;
  matchedRules: string[];
}

export interface RetentionCalculation {
  classification: ComplianceClassification;
  createdDate: string;
  triggerDate: string;
  disposalTargetDate: string;
  isDisposalDue: boolean;
  daysUntilDisposal: number;
}

export interface BatchComplianceSummary {
  total: number;
  bySensitivity: Record<SensitivityLevel, number>;
  byAction: Record<DisposalAction, number>;
  flaggedCount: number;
  items: Array<{
    id: string | number;
    title: string;
    classification: ComplianceClassification;
    disposalTargetDate: string;
  }>;
}

const RULES: Array<{
  category: RecordCategory;
  sensitivity: SensitivityLevel;
  years: number;
  action: DisposalAction;
  name: string;
  pattern: RegExp;
}> = [
  {
    name: "executive-cabinet-policy",
    category: "GOVERNANCE_POLICY",
    sensitivity: "RESTRICTED",
    years: 25,
    action: "TRANSFER_TO_ARCHIVES",
    pattern: /(cabinet\s+in\s+confidence|ministerial\s+briefing|statutory\s+regulation|board\s+minutes|constitutional\s+charter)/i,
  },
  {
    name: "personnel-hr-health",
    category: "PERSONNEL",
    sensitivity: "SENSITIVE",
    years: 7,
    action: "DESTROY",
    pattern: /(medical\s+certificate|disciplinary\s+hearing|salary\s+review|performance\s+appraisal|employee\s+health|grievance\s+record)/i,
  },
  {
    name: "financial-tax-audit",
    category: "FINANCIAL",
    sensitivity: "IN_CONFIDENCE",
    years: 7,
    action: "DESTROY",
    pattern: /(tax\s+return|ird\s+number|\b\d{2,3}-\d{3}-\d{3}\b|audit\s+finding|financial\s+statements|payroll\s+ledger)/i,
  },
  {
    name: "legal-procurement-contract",
    category: "LEGAL_CONTRACT",
    sensitivity: "IN_CONFIDENCE",
    years: 10,
    action: "DESTROY",
    pattern: /(commercial\s+in\s+confidence|pricing\s+schedule|master\s+services\s+agreement|procurement\s+contract|vendor\s+deed)/i,
  },
  {
    name: "transitory-scratchpad",
    category: "TRANSITORY",
    sensitivity: "UNCLASSIFIED",
    years: 1,
    action: "DESTROY",
    pattern: /(transitory\s+record|informal\s+notes|temporary\s+scratchpad|calendar\s+placeholder)/i,
  },
];

export function classifyDocumentContent(title: string, text: string): ComplianceClassification {
  const combined = `${title}\n${text}`;
  const matchedRules: string[] = [];

  let highestPriorityRule = RULES[RULES.length - 1]; // default transitory/lowest
  let found = false;

  for (const rule of RULES) {
    if (rule.pattern.test(combined)) {
      matchedRules.push(rule.name);
      if (!found) {
        highestPriorityRule = rule;
        found = true;
      }
    }
  }

  if (!found) {
    return {
      category: "OPERATIONAL",
      sensitivity: "UNCLASSIFIED",
      statutoryScheduleYears: 7,
      disposalAction: "DESTROY",
      matchedRules: ["default-operational"],
    };
  }

  return {
    category: highestPriorityRule.category,
    sensitivity: highestPriorityRule.sensitivity,
    statutoryScheduleYears: highestPriorityRule.years,
    disposalAction: highestPriorityRule.action,
    matchedRules,
  };
}

export function calculateRetentionSchedule(
  classification: ComplianceClassification,
  createdDateInput?: string | Date,
  eventDateInput?: string | Date
): RetentionCalculation {
  const created = createdDateInput ? new Date(createdDateInput) : new Date();
  const trigger = eventDateInput ? new Date(eventDateInput) : created;

  const target = new Date(trigger.getTime());
  target.setFullYear(target.getFullYear() + classification.statutoryScheduleYears);

  const now = new Date();
  const diffMs = target.getTime() - now.getTime();
  const daysUntilDisposal = Math.round(diffMs / (1000 * 60 * 60 * 24));
  const isDisposalDue = daysUntilDisposal <= 0;

  return {
    classification,
    createdDate: created.toISOString().split("T")[0],
    triggerDate: trigger.toISOString().split("T")[0],
    disposalTargetDate: target.toISOString().split("T")[0],
    isDisposalDue,
    daysUntilDisposal,
  };
}

export function evaluateBatchCompliance(
  records: Array<{ id: string | number; title: string; content: string; createdDate?: string; eventDate?: string }>
): BatchComplianceSummary {
  const bySensitivity: Record<SensitivityLevel, number> = {
    UNCLASSIFIED: 0,
    IN_CONFIDENCE: 0,
    SENSITIVE: 0,
    RESTRICTED: 0,
  };

  const byAction: Record<DisposalAction, number> = {
    DESTROY: 0,
    TRANSFER_TO_ARCHIVES: 0,
    PERMANENT_RETAIN: 0,
  };

  let flaggedCount = 0;
  const items: BatchComplianceSummary["items"] = [];

  for (const rec of records) {
    const classification = classifyDocumentContent(rec.title, rec.content);
    const schedule = calculateRetentionSchedule(classification, rec.createdDate, rec.eventDate);

    bySensitivity[classification.sensitivity] += 1;
    byAction[classification.disposalAction] += 1;

    if (classification.sensitivity === "SENSITIVE" || classification.sensitivity === "RESTRICTED") {
      flaggedCount += 1;
    }

    items.push({
      id: rec.id,
      title: rec.title,
      classification,
      disposalTargetDate: schedule.disposalTargetDate,
    });
  }

  return {
    total: records.length,
    bySensitivity,
    byAction,
    flaggedCount,
    items,
  };
}
