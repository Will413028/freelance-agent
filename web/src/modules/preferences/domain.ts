import { Conflict, InvalidAction } from "@/platform/errors";
import type { PyDateTime } from "@/platform/py/datetime";
import { pyLen, pyStrip } from "@/platform/py/unicode";
import { pyEq, PyDict, type PyValue } from "@/platform/py/value";

// Port of preferences/domain.py: manual feedback/outcomes, independent of proposal authorization
// and delivery.

export const FEEDBACK = ["neutral", "interested", "skipped"] as const;
export const REASONS = ["budget", "skills", "hours", "location", "scope", "other"] as const;
export const STAGES = ["not_applied", "applied", "replied", "negotiating", "won", "lost", "withdrawn"] as const;
const TRANSITIONS: Record<string, readonly string[]> = {
  not_applied: ["applied"],
  applied: ["replied", "negotiating", "won", "lost", "withdrawn"],
  replied: ["negotiating", "won", "lost", "withdrawn"],
  negotiating: ["won", "lost", "withdrawn"],
  won: [], lost: [], withdrawn: [],
};
const oneOf = (v: PyValue, list: readonly string[]) => list.some((s) => pyEq(v, s));

export const emptyTracking = () => PyDict.of({
  revision: 0n, feedback: "neutral", stage: "not_applied", reason: "", note: "", evidence: "", updated_at: null, provenance: "user_reported",
});

export type TrackingChange = { feedback?: PyValue; stage?: PyValue; reason?: PyValue; note?: PyValue; evidence?: PyValue };

export function updateTracking(current: PyDict, revision: PyValue, now: PyDateTime, change: TrackingChange): PyDict {
  const feedback = change.feedback ?? null, stage = change.stage ?? null;
  if (typeof revision !== "bigint" || !pyEq(revision, current.req("revision"))) throw new Conflict("追蹤紀錄已更新，請重新載入");
  // Omitted means the Python default ''; an explicit None stays None and fails the str check.
  const raw = { note: change.note === undefined ? "" : change.note, evidence: change.evidence === undefined ? "" : change.evidence,
    reason: change.reason === undefined ? "" : change.reason };
  for (const [value, limit] of [[raw.note, 2000], [raw.evidence, 2000], [raw.reason, 50]] as const) {
    if (typeof value !== "string" || pyLen(value) > limit) throw new InvalidAction("追蹤欄位格式或長度不符限制");
  }
  const note = pyStrip(raw.note as string), evidence = pyStrip(raw.evidence as string), reason = pyStrip(raw.reason as string);
  if (feedback === null && stage === null) throw new InvalidAction("請選擇回饋或應徵進度");
  const result = new PyDict(current);
  if (feedback !== null) {
    if (!oneOf(feedback, FEEDBACK)) throw new InvalidAction("不支援的回饋");
    if (pyEq(feedback, "skipped") && reason && (!oneOf(reason, REASONS) || (reason === "other" && !note))) {
      throw new InvalidAction("請選擇略過原因；其他原因需填寫說明");
    }
    result.update({ feedback, reason: pyEq(feedback, "skipped") ? reason : "" });
  }
  if (stage !== null) {
    if (!oneOf(stage, STAGES)) throw new InvalidAction("不支援的應徵進度");
    const currentStage = current.str("stage");
    if (pyEq(stage, "not_applied") && currentStage !== "not_applied") {
      if (!note) throw new InvalidAction("重設進度需填寫更正原因，歷史紀錄會保留");
      result.set("evidence", "");
    } else if (!pyEq(stage, currentStage)) {
      if (!TRANSITIONS[currentStage].includes(stage as string)) throw new InvalidAction("請先記錄已投遞；此進度轉換不被允許");
    }
    if (pyEq(stage, "applied") && currentStage === "not_applied" && !evidence) {
      throw new InvalidAction("已投遞需填寫平台確認編號或送出紀錄；不會代為投遞");
    }
    result.set("stage", stage);
  }
  if (evidence && !pyEq(stage, "not_applied")) result.set("evidence", evidence);
  result.update({ note, revision: revision + 1n, updated_at: now.isoformat() });
  return result;
}
