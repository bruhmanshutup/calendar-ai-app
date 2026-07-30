import type {
  ExtractedTask,
  ExistingSession,
  PlanningMode,
  ScheduleProposal,
  SchedulingPreferences,
} from "@/lib/domain/types";

export type UserProfile = {
  id: string;
  name: string;
  timeZone: string;
};

export interface PlanPilotRepository {
  getProfile(): Promise<UserProfile | null>;
  savePreferences(preferences: SchedulingPreferences): Promise<void>;
  saveTaskSource(content: string, sourceType: "pasted_text" | "txt"): Promise<string>;
  saveTasks(sourceId: string, tasks: ExtractedTask[]): Promise<void>;
  saveScheduleVersion(proposal: ScheduleProposal): Promise<string>;
  approveSessions(sessionIds: string[]): Promise<void>;
  listSessions(): Promise<ExistingSession[]>;
  appendHistory(
    entityType: "task" | "session" | "calendar",
    entityId: string,
    action: string,
    message: string,
  ): Promise<void>;
  updatePlanningMode(mode: PlanningMode): Promise<void>;
}

