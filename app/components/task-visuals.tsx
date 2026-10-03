/**
 * Task icons for the polish pass (inspired by Structured, where every task
 * gets a recognisable icon in its own color). Purely decorative: the icon is
 * picked from words in the task's title, with a neutral dot as the fallback.
 */
import { createElement } from "react";
import {
  BookOpen,
  Brain,
  Briefcase,
  Calculator,
  CircleDot,
  ClipboardList,
  Dumbbell,
  FlaskConical,
  GraduationCap,
  HeartPulse,
  Home,
  NotebookPen,
  Phone,
  Presentation,
  Shirt,
  ShoppingCart,
  Users,
  Utensils,
  type LucideIcon,
} from "lucide-react";

const ICON_RULES: Array<[RegExp, LucideIcon]> = [
  [/\blab(oratory)?\b/, FlaskConical],
  [/\bseminar\b|\bpresentation\b|\bworkshop\b/, Presentation],
  [/\bdiscussion\b|\brecitation\b|\bmeeting\b|\bstudy group\b|\bclub\b/, Users],
  [/\blecture\b|\bclass\b|\bcourse\b/, GraduationCap],
  [/\bsurvey\b|\bform\b|\bapplication\b|\bchecklist\b/, ClipboardList],
  [/\bexam\b|\bmidterm\b|\bfinal\b|\bquiz\b|\btest\b|\bstudy\b|\breview\b/, Brain],
  [/\bread(ing)?\b|\bbook\b|\bchapter\b/, BookOpen],
  [/\bhomework\b|\bassignment\b|\bproblem set\b|\bpset\b|\bessay\b|\bpaper\b|\bwrite\b|\bproject\b/, NotebookPen],
  [/\blaundry\b|\bclothes\b|\bironing\b/, Shirt],
  [/\bgym\b|\bworkout\b|\brun(ning)?\b|\bexercise\b|\byoga\b|\bpractice\b/, Dumbbell],
  [/\bdoctor\b|\bdentist\b|\bmedication\b|\btherapy\b|\bappointment\b/, HeartPulse],
  [/\bcall\b|\bphone\b/, Phone],
  [/\bwork\b|\bshift\b|\bjob\b|\binternship\b/, Briefcase],
  [/\bcook\b|\bmeal\b|\bbreakfast\b|\blunch\b|\bdinner\b/, Utensils],
  [/\bgrocer(y|ies)\b|\bshopping\b|\berrand\b/, ShoppingCart],
  [/\bclean\b|\bchores?\b|\bdishes\b|\btidy\b/, Home],
  [/\bmath\b|\bcalc(ulus)?\b|\bstats?\b/, Calculator],
];

export function taskIconFor(title: string): LucideIcon {
  const text = title.toLowerCase();
  return ICON_RULES.find(([pattern]) => pattern.test(text))?.[1] ?? CircleDot;
}

/** A small icon that matches what the task is (book, flask, shirt, ...). */
export function TaskIcon({ title, size = 14, className }: { title: string; size?: number; className?: string }) {
  return createElement(taskIconFor(title), { size, className, "aria-hidden": true });
}
