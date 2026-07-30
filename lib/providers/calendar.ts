import type { PlannedSession, TimeInterval } from "@/lib/domain/types";

export type CalendarEvent = TimeInterval & {
  id: string;
  title: string;
  source: "google" | "mock";
};

export type PlannedEvent = {
  idempotencyKey: string;
  title: string;
  start: string;
  end: string;
  description: string;
  reminderMinutes: number;
  session: PlannedSession;
};

export interface CalendarProvider {
  getEvents(start: Date, end: Date): Promise<CalendarEvent[]>;
  createEvent(event: PlannedEvent): Promise<string>;
  updateEvent(id: string, event: PlannedEvent): Promise<void>;
  deleteEvent(id: string): Promise<void>;
}

