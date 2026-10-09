import {
  addDays,
  differenceInCalendarDays,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  isSameMonth,
  startOfMonth,
  startOfWeek,
} from "date-fns";
import { zhCN } from "date-fns/locale";
import type { DeadlineTask } from "../types";

export const COURSE_COLORS = [
  "#8b7cf6",
  "#4fa6ff",
  "#2ec7a6",
  "#f4a261",
  "#ef6f91",
  "#58c4dc",
];

export function monthDays(month: Date): Date[] {
  const start = startOfWeek(startOfMonth(month), { weekStartsOn: 1 });
  const end = endOfWeek(endOfMonth(month), { weekStartsOn: 1 });
  const dates: Date[] = [];
  for (let cursor = start; cursor <= end; cursor = addDays(cursor, 1)) {
    dates.push(cursor);
  }
  return dates;
}

export function tasksForDay(tasks: DeadlineTask[], day: Date): DeadlineTask[] {
  return tasks
    .filter((task) => isSameDay(new Date(task.dueAt), day))
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt));
}

export function monthLabel(month: Date): string {
  return format(month, "yyyy年 M月", { locale: zhCN });
}

export function dayLabel(day: Date): string {
  return format(day, "M月d日 EEEE", { locale: zhCN });
}

export function isOutsideMonth(day: Date, month: Date): boolean {
  return !isSameMonth(day, month);
}

export function urgency(task: DeadlineTask): "overdue" | "urgent" | "soon" | "normal" {
  if (task.completed) return "normal";
  const days = differenceInCalendarDays(new Date(task.dueAt), new Date());
  if (days < 0) return "overdue";
  if (days <= 1) return "urgent";
  if (days <= 3) return "soon";
  return "normal";
}

export function courseColor(course: string): string {
  let hash = 0;
  for (const char of course || "其他") hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return COURSE_COLORS[hash % COURSE_COLORS.length];
}
