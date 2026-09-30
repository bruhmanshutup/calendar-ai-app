import { format } from "date-fns";
import { toZonedTime } from "date-fns-tz";
import type { PlanningRules, TimeInterval } from "./types";

type BlockedTime = TimeInterval & { label: string };

function blockedTimeKey(item: BlockedTime): string {
  return `${item.start}|${item.end}|${item.label}`;
}

function blockedRuleSignature(item: BlockedTime, timeZone: string): string {
  const localStart = toZonedTime(new Date(item.start), timeZone);
  return `${item.label.trim().toLocaleLowerCase()}|${format(localStart, "EEEE").toLocaleLowerCase()}|${format(localStart, "HH:mm")}`;
}

/**
 * Adds planning rules from a new import while replacing a dated occurrence of
 * the same protected-time rule. This keeps unrelated rules additive, but a
 * re-imported weekly agenda does not leave last week's copy behind.
 */
export function mergeImportedPlanningRules(
  current: PlanningRules,
  incoming: PlanningRules | undefined,
  timeZone: string,
): PlanningRules {
  if (!incoming) return current;

  const incomingBlocked = incoming.blockedTimes ?? [];
  const replacedSignatures = new Set(
    incomingBlocked.map((item) => blockedRuleSignature(item, timeZone)),
  );
  const blocked = [
    ...(current.blockedTimes ?? []).filter(
      (item) => !replacedSignatures.has(blockedRuleSignature(item, timeZone)),
    ),
    ...incomingBlocked,
  ];
  const seen = new Set<string>();

  return {
    earliestWorkTime: incoming.earliestWorkTime ?? current.earliestWorkTime,
    latestWorkTime: incoming.latestWorkTime ?? current.latestWorkTime,
    blockedTimes: blocked
      .filter((item) => {
        const key = blockedTimeKey(item);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(-100),
  };
}
