const confidence = {
  type: "number",
  minimum: 0,
  maximum: 1,
} as const;

const sourceSpan = {
  type: "object",
  description:
    "Exact character offsets and quote from the source. The end offset must be greater than the start offset.",
  properties: {
    sourceId: { type: "string", minLength: 1, maxLength: 180 },
    start: { type: "integer", minimum: 0 },
    end: { type: "integer", minimum: 1 },
    quote: { type: "string", minLength: 1, maxLength: 4000 },
  },
  required: ["start", "end", "quote"],
} as const;

const temporalWindow = {
  type: "object",
  description:
    "A resolved local-date window. The end must occur after the start.",
  properties: {
    start: { type: "string", format: "date-time" },
    end: { type: "string", format: "date-time" },
    label: { type: "string", minLength: 1, maxLength: 180 },
    precision: {
      type: "string",
      enum: ["exact", "named_period", "approximate"],
    },
  },
  required: ["start", "end", "label", "precision"],
} as const;

const durationRange = {
  type: "object",
  description:
    "An explicitly stated or semantically relevant duration range. maximumMinutes must be at least minimumMinutes; preferredMinutes must fall within the range.",
  properties: {
    minimumMinutes: { type: "integer", minimum: 1, maximum: 1440 },
    maximumMinutes: { type: "integer", minimum: 1, maximum: 1440 },
    preferredMinutes: { type: "integer", minimum: 1, maximum: 1440 },
  },
  required: ["minimumMinutes"],
} as const;

export const GEMINI_EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    tasks: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
          taskType: {
            type: "string",
            enum: ["flexible", "fixed_time", "recurring_goal"],
          },
          responsibilityKind: {
            type: "string",
            enum: ["task", "event", "reminder", "milestone"],
          },
          deadlineStrength: {
            type: "string",
            enum: ["hard", "soft"],
          },
          dueDate: {
            type: "string",
            description: "Resolved local calendar date in YYYY-MM-DD format.",
          },
          dueTime: {
            type: "string",
            description: "Resolved local time in HH:mm format, only when stated.",
          },
          dueAt: { type: "string", format: "date-time" },
          dueWindow: temporalWindow,
          occurrenceWindow: temporalWindow,
          fixedStartAt: { type: "string", format: "date-time" },
          fixedEndAt: { type: "string", format: "date-time" },
          estimatedMinutes: {
            type: "integer",
            minimum: 1,
            maximum: 1440,
            description: "Total active effort, or effort per recurring occurrence.",
          },
          durationRange,
          effortEstimateSource: {
            type: "string",
            enum: ["stated", "ai", "heuristic"],
          },
          effortEstimateRationale: {
            type: "string",
            description: "Short explanation of the duration or scope assumption.",
          },
          priority: {
            type: "string",
            enum: ["low", "medium", "high", "urgent"],
          },
          category: {
            type: "string",
            enum: [
              "school",
              "work",
              "health",
              "fitness",
              "errand",
              "personal",
              "other",
            ],
          },
          energyDemand: {
            type: "string",
            enum: ["low", "medium", "high"],
          },
          splittable: { type: "boolean" },
          minimumSessionMinutes: {
            type: "integer",
            minimum: 1,
            maximum: 240,
            description: "Shortest useful session; never more than estimatedMinutes.",
          },
          schedulingConstraints: {
            type: "object",
            properties: {
              allowedTimeWindows: {
                type: "array",
                minItems: 1,
                maxItems: 14,
                description:
                  "Hard local clock windows when the task can occur, such as business hours.",
                items: {
                  type: "object",
                  properties: {
                    start: { type: "string", pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$" },
                    end: { type: "string", pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$" },
                  },
                  required: ["start", "end"],
                },
              },
              allowedDateWindows: {
                type: "array",
                minItems: 1,
                maxItems: 14,
                description:
                  "Hard resolved date/time windows during which the responsibility may occur.",
                items: temporalWindow,
              },
              preferredTimeWindows: {
                type: "array",
                minItems: 1,
                maxItems: 14,
                description:
                  "Soft local clock preferences; scheduling outside them remains valid.",
                items: {
                  type: "object",
                  properties: {
                    start: { type: "string", pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$" },
                    end: { type: "string", pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$" },
                  },
                  required: ["start", "end"],
                },
              },
              preferredDateWindows: {
                type: "array",
                minItems: 1,
                maxItems: 14,
                description:
                  "Soft resolved date/time preferences such as Thursday evening; scheduling outside them remains valid.",
                items: temporalWindow,
              },
              avoidConsecutiveDays: { type: "boolean" },
              sessionCount: { type: "integer", minimum: 2, maximum: 31 },
              maximumSessionMinutes: {
                type: "integer",
                minimum: 1,
                maximum: 1440,
              },
            },
          },
          sequence: {
            type: "object",
            description:
              "Explicit ordering metadata for a task in a source-defined plan or progression.",
            properties: {
              groupId: { type: "string", minLength: 1, maxLength: 120 },
              order: { type: "integer", minimum: 0, maximum: 1000000 },
              week: { type: "integer", minimum: 1, maximum: 1000 },
              day: { type: "integer", minimum: 1, maximum: 366 },
              anchorDate: {
                type: "string",
                pattern: "^\\d{4}-\\d{2}-\\d{2}$",
              },
              minimumGapDays: { type: "integer", minimum: 0, maximum: 31 },
            },
            required: ["groupId", "order"],
          },
          recurrence: {
            type: "object",
            properties: {
              frequency: { type: "string", enum: ["daily", "weekly", "monthly"] },
              mode: {
                type: "string",
                enum: ["quota", "fixed_times"],
                description:
                  "quota is a flexible occurrence count; fixed_times is a recurring schedule with exact per-day times.",
              },
              interval: { type: "integer", minimum: 1, maximum: 365 },
              anchorDate: {
                type: "string",
                pattern: "^\\d{4}-\\d{2}-\\d{2}$",
              },
              occurrenceLimit: {
                type: "integer",
                minimum: 1,
                maximum: 10000,
              },
              count: { type: "integer", minimum: 1, maximum: 31 },
              daysOfWeek: {
                type: "array",
                maxItems: 7,
                items: {
                  type: "string",
                  enum: [
                    "monday",
                    "tuesday",
                    "wednesday",
                    "thursday",
                    "friday",
                    "saturday",
                    "sunday",
                  ],
                },
              },
              timeRules: {
                type: "array",
                minItems: 1,
                maxItems: 28,
                description:
                  "Grouped local times for a fixed_times recurrence. A day may appear in multiple rules only for multiple daily occurrences.",
                items: {
                  type: "object",
                  properties: {
                    daysOfWeek: {
                      type: "array",
                      minItems: 1,
                      maxItems: 7,
                      items: {
                        type: "string",
                        enum: [
                          "monday",
                          "tuesday",
                          "wednesday",
                          "thursday",
                          "friday",
                          "saturday",
                          "sunday",
                        ],
                      },
                    },
                    time: {
                      type: "string",
                      pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$",
                      description: "Local time in HH:mm format.",
                    },
                  },
                  required: ["daysOfWeek", "time"],
                },
              },
              monthlyRules: {
                type: "array",
                minItems: 1,
                maxItems: 12,
                items: {
                  type: "object",
                  properties: {
                    type: {
                      type: "string",
                      enum: ["days_of_month", "ordinal_weekday", "last_day_of_month"],
                    },
                    daysOfMonth: {
                      type: "array",
                      minItems: 1,
                      maxItems: 31,
                      items: { type: "integer", minimum: 1, maximum: 31 },
                    },
                    ordinal: {
                      type: "integer",
                      enum: [1, 2, 3, 4, 5, -1],
                    },
                    dayOfWeek: {
                      type: "string",
                      enum: [
                        "monday",
                        "tuesday",
                        "wednesday",
                        "thursday",
                        "friday",
                        "saturday",
                        "sunday",
                      ],
                    },
                    times: {
                      type: "array",
                      minItems: 1,
                      maxItems: 8,
                      items: {
                        type: "string",
                        pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$",
                      },
                    },
                  },
                  required: ["type", "times"],
                },
              },
              dateOverrides: {
                type: "array",
                maxItems: 50,
                items: {
                  type: "object",
                  properties: {
                    date: {
                      type: "string",
                      pattern: "^\\d{4}-\\d{2}-\\d{2}$",
                    },
                    skip: { type: "boolean" },
                    times: {
                      type: "array",
                      minItems: 1,
                      maxItems: 8,
                      items: {
                        type: "string",
                        pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$",
                      },
                    },
                  },
                  required: ["date"],
                },
              },
              windowStart: { type: "string", format: "date-time" },
              windowEnd: { type: "string", format: "date-time" },
            },
            required: ["frequency"],
          },
          confidence,
          fieldConfidence: {
            type: "object",
            properties: {
              title: confidence,
              taskType: confidence,
              dueDate: confidence,
              dueTime: confidence,
              estimatedMinutes: confidence,
              priority: confidence,
              recurrence: confidence,
            },
            required: ["title", "taskType"],
          },
          missingInformation: {
            type: "array",
            maxItems: 20,
            items: { type: "string" },
          },
          sourceText: {
            type: "string",
            description:
              "Complete exact source span for this responsibility, including its contiguous duration, deadline, priority, recurrence, preference, dependency, and constraint details.",
          },
          sourceSpan,
          dependencies: {
            type: "array",
            maxItems: 20,
            description:
              "Explicit before/after relationships to other extracted tasks. Use taskId only when the related task has an id.",
            items: {
              type: "object",
              properties: {
                taskId: { type: "string", minLength: 1, maxLength: 180 },
                targetTitle: {
                  type: "string",
                  minLength: 1,
                  maxLength: 180,
                  description:
                    "Source-grounded title of the related responsibility when taskId is unavailable or needs clarification.",
                },
                relation: { type: "string", enum: ["before", "after"] },
                strength: { type: "string", enum: ["hard", "soft"] },
                minimumGapMinutes: {
                  type: "integer",
                  minimum: 0,
                  maximum: 525600,
                },
                maximumLagMinutes: {
                  type: "integer",
                  minimum: 0,
                  maximum: 525600,
                },
                evidence: sourceSpan,
              },
              required: ["relation"],
            },
          },
          conditionalRules: {
            type: "array",
            maxItems: 20,
            description:
              "Source-stated conditional scheduling or duration rules that cannot always be applied without outside context.",
            items: {
              type: "object",
              properties: {
                condition: { type: "string", minLength: 1, maxLength: 500 },
                effect: { type: "string", minLength: 1, maxLength: 500 },
                requiresReview: { type: "boolean" },
              },
              required: ["condition", "effect"],
            },
          },
          approved: { type: "boolean" },
          reviewRequired: { type: "boolean" },
        },
        required: [
          "title",
          "taskType",
          "estimatedMinutes",
          "effortEstimateSource",
          "effortEstimateRationale",
          "priority",
          "category",
          "energyDemand",
          "splittable",
          "minimumSessionMinutes",
          "confidence",
          "fieldConfidence",
          "missingInformation",
          "sourceText",
        ],
      },
    },
    ignoredStatements: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        properties: {
          sourceText: { type: "string" },
          reason: { type: "string" },
        },
        required: ["sourceText", "reason"],
      },
    },
    planningRules: {
      type: "object",
      description:
        "Global work-hour preferences and explicit protected intervals from the source.",
      properties: {
        earliestWorkTime: {
          type: "string",
          pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$",
        },
        latestWorkTime: {
          type: "string",
          pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$",
        },
        blockedTimes: {
          type: "array",
          maxItems: 100,
          items: {
            type: "object",
            properties: {
              start: { type: "string", format: "date-time" },
              end: { type: "string", format: "date-time" },
              label: { type: "string" },
            },
            required: ["start", "end", "label"],
          },
        },
      },
    },
  },
  required: ["tasks", "ignoredStatements"],
} as const;
