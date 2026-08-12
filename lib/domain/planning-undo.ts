import type {
  ExtractedTask,
  PlanningRules,
  PlanningMode,
  ReplanProposal,
  ScheduleProposal,
  SessionReview,
} from "./types";

export type PlanningUndoSnapshot = {
  label: string;
  tasks: ExtractedTask[];
  proposal: ScheduleProposal;
  planningMode: PlanningMode;
  planningRules: PlanningRules;
  replan?: ReplanProposal;
  selectedSessionIds: string[];
  sessionReviews: SessionReview[];
  lastImportedTaskIds: string[];
};

const MAX_UNDO_STEPS = 20;

function representsSameState(
  left: PlanningUndoSnapshot,
  right: PlanningUndoSnapshot,
): boolean {
  return (
    left.tasks === right.tasks &&
    left.proposal === right.proposal &&
    left.planningMode === right.planningMode &&
    left.planningRules === right.planningRules &&
    left.replan === right.replan &&
    left.selectedSessionIds === right.selectedSessionIds &&
    left.sessionReviews === right.sessionReviews &&
    left.lastImportedTaskIds === right.lastImportedTaskIds
  );
}

export function pushPlanningUndo(
  stack: PlanningUndoSnapshot[],
  snapshot: PlanningUndoSnapshot,
): PlanningUndoSnapshot[] {
  const previous = stack.at(-1);
  if (previous && representsSameState(previous, snapshot)) return stack;
  return [...stack.slice(-(MAX_UNDO_STEPS - 1)), snapshot];
}

export function popPlanningUndo(stack: PlanningUndoSnapshot[]): {
  snapshot?: PlanningUndoSnapshot;
  remaining: PlanningUndoSnapshot[];
} {
  return {
    snapshot: stack.at(-1),
    remaining: stack.slice(0, -1),
  };
}
