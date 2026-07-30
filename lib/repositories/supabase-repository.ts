import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type {
  ExtractedTask,
  ExistingSession,
  PlanningMode,
  ScheduleProposal,
  SchedulingPreferences,
} from "@/lib/domain/types";
import type {
  PlanPilotRepository,
  UserProfile,
} from "./planpilot-repository";

function configuredClient(accessToken: string): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) throw new Error("Supabase is not configured.");
  return createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export class SupabasePlanPilotRepository implements PlanPilotRepository {
  private readonly client: SupabaseClient;

  constructor(accessToken: string) {
    this.client = configuredClient(accessToken);
  }

  private async userId(): Promise<string> {
    const { data, error } = await this.client.auth.getUser();
    if (error || !data.user) throw new Error("Authentication is required.");
    return data.user.id;
  }

  async getProfile(): Promise<UserProfile | null> {
    const userId = await this.userId();
    const { data, error } = await this.client
      .from("profiles")
      .select("id, display_name, time_zone")
      .eq("id", userId)
      .maybeSingle();
    if (error) throw error;
    return data
      ? { id: data.id, name: data.display_name, timeZone: data.time_zone }
      : null;
  }

  async savePreferences(preferences: SchedulingPreferences): Promise<void> {
    const userId = await this.userId();
    const { error } = await this.client.from("user_preferences").upsert({
      user_id: userId,
      waking_time: preferences.wakingTime,
      sleeping_time: preferences.sleepingTime,
      preferred_focus_minutes: preferences.preferredBlockMinutes,
      maximum_focus_minutes: preferences.maximumBlockMinutes,
      preferred_break_minutes: preferences.preferredBreakMinutes,
      planning_mode: preferences.planningMode,
      weekends_allowed: preferences.weekendsAllowed,
      preferred_focus_windows: preferences.preferredFocusWindows,
      preferred_routine_windows: preferences.preferredRoutineWindows,
    });
    if (error) throw error;
  }

  async saveTaskSource(
    content: string,
    sourceType: "pasted_text" | "txt",
  ): Promise<string> {
    const userId = await this.userId();
    const { data, error } = await this.client
      .from("task_sources")
      .insert({ user_id: userId, source_type: sourceType, content })
      .select("id")
      .single();
    if (error) throw error;
    return data.id;
  }

  async saveTasks(sourceId: string, tasks: ExtractedTask[]): Promise<void> {
    const userId = await this.userId();
    const { error } = await this.client.from("tasks").insert(
      tasks.map((task) => ({
        user_id: userId,
        source_id: sourceId,
        title: task.title,
        description: task.description,
        task_type: task.taskType,
        due_date: task.dueDate,
        due_time: task.dueTime,
        fixed_start_at: task.fixedStartAt,
        fixed_end_at: task.fixedEndAt,
        estimated_minutes: task.estimatedMinutes,
        priority: task.priority,
        category: task.category,
        energy_demand: task.energyDemand,
        splittable: task.splittable,
        minimum_session_minutes: task.minimumSessionMinutes,
        recurrence: task.recurrence,
        confidence: task.confidence,
        field_confidence: task.fieldConfidence,
        missing_information: task.missingInformation,
        source_excerpt: task.sourceText,
        review_required: task.reviewRequired ?? false,
        approved_at: task.approved ? new Date().toISOString() : null,
      })),
    );
    if (error) throw error;
  }

  async saveScheduleVersion(proposal: ScheduleProposal): Promise<string> {
    const userId = await this.userId();
    const { data, error } = await this.client
      .from("schedule_versions")
      .insert({
        user_id: userId,
        status: "proposed",
        proposal,
        plan_health: proposal.planHealth,
      })
      .select("id")
      .single();
    if (error) throw error;
    return data.id;
  }

  async approveSessions(sessionIds: string[]): Promise<void> {
    const userId = await this.userId();
    const { error } = await this.client
      .from("planned_sessions")
      .update({ status: "approved", approved_at: new Date().toISOString() })
      .eq("user_id", userId)
      .in("id", sessionIds);
    if (error) throw error;
  }

  async listSessions(): Promise<ExistingSession[]> {
    const userId = await this.userId();
    const { data, error } = await this.client
      .from("planned_sessions")
      .select("id, task_id, title, start_at, end_at, locked, status")
      .eq("user_id", userId)
      .order("start_at");
    if (error) throw error;
    return (data ?? []).map((session) => ({
      id: session.id,
      taskId: session.task_id,
      title: session.title,
      start: session.start_at,
      end: session.end_at,
      locked: session.locked,
      status: session.status,
    }));
  }

  async appendHistory(
    entityType: "task" | "session" | "calendar",
    entityId: string,
    action: string,
    message: string,
  ): Promise<void> {
    const userId = await this.userId();
    const { error } = await this.client.from("task_history").insert({
      user_id: userId,
      entity_type: entityType,
      entity_id: entityId,
      action,
      message,
    });
    if (error) throw error;
  }

  async updatePlanningMode(mode: PlanningMode): Promise<void> {
    const userId = await this.userId();
    const { error } = await this.client
      .from("user_preferences")
      .update({ planning_mode: mode })
      .eq("user_id", userId);
    if (error) throw error;
  }
}

