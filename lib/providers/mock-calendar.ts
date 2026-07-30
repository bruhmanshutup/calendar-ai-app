import type {
  CalendarEvent,
  CalendarProvider,
  PlannedEvent,
} from "./calendar";

export class MockCalendarProvider implements CalendarProvider {
  private readonly events = new Map<string, PlannedEvent>();
  private readonly idempotencyIndex = new Map<string, string>();

  async getEvents(start: Date, end: Date): Promise<CalendarEvent[]> {
    return [...this.events.entries()]
      .filter(
        ([, event]) =>
          new Date(event.start) < end && new Date(event.end) > start,
      )
      .map(([id, event]) => ({
        id,
        title: event.title,
        start: event.start,
        end: event.end,
        source: "mock" as const,
      }));
  }

  async createEvent(event: PlannedEvent): Promise<string> {
    const existing = this.idempotencyIndex.get(event.idempotencyKey);
    if (existing) return existing;
    const id = `mock-calendar-${this.events.size + 1}`;
    this.events.set(id, event);
    this.idempotencyIndex.set(event.idempotencyKey, id);
    return id;
  }

  async updateEvent(id: string, event: PlannedEvent): Promise<void> {
    if (!this.events.has(id)) throw new Error("Mock calendar event not found.");
    this.events.set(id, event);
    this.idempotencyIndex.set(event.idempotencyKey, id);
  }

  async deleteEvent(id: string): Promise<void> {
    const event = this.events.get(id);
    if (!event) return;
    this.events.delete(id);
    this.idempotencyIndex.delete(event.idempotencyKey);
  }
}

