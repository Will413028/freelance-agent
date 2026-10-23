import type { Job } from '../../shared/api/client';

export const kinds: Record<string, string> = { fixed: "固定專案", hourly: "時薪", contract: "兼職／合約", full_time: "全職" };
export function safeUrl(value?: string | null) {
  if (!value) return undefined;
  try { const url = new URL(value || ""); return url.protocol === "https:" && !url.username && !url.password ? value : undefined; }
  catch { return undefined; }
}
export function compensation(job: Job) {
  if (!job.currency || typeof job.budget_max !== "number") return "報酬待確認";
  return job.currency + " " + (job.budget_min?.toLocaleString() ?? "?") + "–" + job.budget_max.toLocaleString() +
    (job.kind === "hourly" ? "／時" : "");
}
export const fieldNames: Record<string, string> = { title: "職稱", company: "公司", description: "工作內容", kind: "合作型態",
  currency: "幣別", budget_min: "預算下限", budget_max: "預算上限", weekly_hours: "每週工時",
  location: "地點", location_evidence: "地點依據", taiwan_eligible: "台灣資格", timezone_compatible: "時區適用",
  deadline: "截止時間", listing_closed: "是否結案", url: "來源連結" };
export function fieldValue(job: Job, field: string) {
  const value = job[field as keyof Job];
  if (value === null || value === undefined || value === "") return "未提供";
  if (typeof value === "boolean") return value ? "是" : "否";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}
