import "server-only";

import type {
  CalendarEvent,
  CalendarProvider,
  PlannedEvent,
} from "./calendar";

type GoogleEvent = {
  id?: string;
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
};

type GoogleListResponse = {
  items?: GoogleEvent[];
  nextPageToken?: string;
};

function eventInterval(event: GoogleEvent): { start: string; end: string } | null {
  const start = event.start?.dateTime ?? event.start?.date;
  const end = event.end?.dateTime ?? event.end?.date;
  if (!start || !end) return null;
  return { start, end };
}

async function stableEventId(idempotencyKey: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(idempotencyKey),
  );
  const alphabet = "0123456789abcdefghijklmnopqrstuv";
  return [...new Uint8Array(digest)]
    .map((byte) => alphabet[byte % alphabet.length])
    .join("")
    .slice(0, 32);
}

export class GoogleCalendarProvider implements CalendarProvider {
  constructor(
    private readonly accessToken: string,
    private readonly calendarId = "primary",
  ) {}

  private async request<T>(
    path: string,
    init?: RequestInit,
  ): Promise<T | undefined> {
    const response = await fetch(
      `https://www.googleapis.com/calendar/v3${path}`,
      {
        ...init,
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json",
          ...init?.headers,
        },
      },
    );
    if (!response.ok) {
      const error = new Error(
        `Google Calendar request failed with status ${response.status}.`,
      );
      Object.defineProperty(error, "status", { value: response.status });
      throw error;
    }
    if (response.status === 204) return undefined;
    return (await response.json()) as T;
  }

  async getEvents(start: Date, end: Date): Promise<CalendarEvent[]> {
    const events: CalendarEvent[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        timeMin: start.toISOString(),
        timeMax: end.toISOString(),
        singleEvents: "true",
        orderBy: "startTime",
        maxResults: "250",
      });
      if (pageToken) params.set("pageToken", pageToken);
      const result = await this.request<GoogleListResponse>(
        `/calendars/${encodeURIComponent(this.calendarId)}/events?${params}`,
      );
      for (const item of result?.items ?? []) {
        const interval = eventInterval(item);
        if (!item.id || !interval) continue;
        events.push({
          id: item.id,
          title: item.summary ?? "Busy",
          ...interval,
          source: "google",
        });
      }
      pageToken = result?.nextPageToken;
    } while (pageToken);
    return events;
  }

  async createEvent(event: PlannedEvent): Promise<string> {
    const id = await stableEventId(event.idempotencyKey);
    try {
      const created = await this.request<GoogleEvent>(
        `/calendars/${encodeURIComponent(this.calendarId)}/events`,
        {
          method: "POST",
          body: JSON.stringify({
            id,
            summary: event.title,
            description: event.description,
            start: { dateTime: event.start },
            end: { dateTime: event.end },
            reminders: {
              useDefault: false,
              overrides: [
                { method: "popup", minutes: event.reminderMinutes },
              ],
            },
            extendedProperties: {
              private: {
                planpilotSessionId: event.session.id,
                planpilotIdempotencyKey: event.idempotencyKey,
              },
            },
          }),
        },
      );
      return created?.id ?? id;
    } catch (error) {
      const status = Object.getOwnPropertyDescriptor(error, "status")?.value;
      if (status === 409) return id;
      throw error;
    }
  }

  async updateEvent(id: string, event: PlannedEvent): Promise<void> {
    await this.request(
      `/calendars/${encodeURIComponent(this.calendarId)}/events/${encodeURIComponent(id)}`,
      {
        method: "PUT",
        body: JSON.stringify({
          id,
          summary: event.title,
          description: event.description,
          start: { dateTime: event.start },
          end: { dateTime: event.end },
          reminders: {
            useDefault: false,
            overrides: [
              { method: "popup", minutes: event.reminderMinutes },
            ],
          },
        }),
      },
    );
  }

  async deleteEvent(id: string): Promise<void> {
    await this.request(
      `/calendars/${encodeURIComponent(this.calendarId)}/events/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
  }
}

