import type { Db } from "@/db/client";
import { Conflict, InvalidAction, InvalidSettings, NotFound } from "@/platform/errors";
import type { PyDateTime } from "@/platform/py/datetime";
import { PyDict, type PyValue } from "@/platform/py/value";
import { feedback, replaceSettings } from "@/services/discovery";
import { guardedForm, messagePage, NO_STORE, safePath } from "./guard";

// The two page writes (plan step 11): a listing's feedback and the discovery settings. Each takes a
// urlencoded form that passed guardedForm, calls the service's write unit, and answers 303 back to
// the page with a fixed notice code, or a short page with the status the error class maps to.

export type WriteDeps = { db: Db; now: () => PyDateTime; writes: boolean };

/** The notice codes a write sends back; the page maps each to its text (never free text from the URL). */
export const NOTICES = { saved: "已加入收藏", unsaved: "已取消收藏", skipped: "已略過", restored: "已恢復待看", settings: "篩選設定已儲存，清單會依新設定排序" } as const;
export type Notice = keyof typeof NOTICES;

/** The buttons a page shows: the feedback each one saves and the notice it answers with. */
const FEEDBACK: Record<string, { value: string; notice: Notice }> = {
  interested: { value: "interested", notice: "saved" }, unsave: { value: "neutral", notice: "unsaved" },
  skipped: { value: "skipped", notice: "skipped" }, restore: { value: "neutral", notice: "restored" },
};

export async function handleFeedback(request: Request, id: string, deps: WriteDeps): Promise<Response> {
  return write(request, deps, async (form, back) => {
    const action = form.get("value") ?? "", token = form.get("token");
    if (!Object.hasOwn(FEEDBACK, action) || token === null) throw new InvalidAction("回饋欄位不符");
    await feedback(deps.db, id, PyDict.of({ [id]: token }), FEEDBACK[action].value, deps.now());
    return seeOther(back, FEEDBACK[action].notice);
  });
}

export async function handleSettings(request: Request, deps: WriteDeps): Promise<Response> {
  return write(request, deps, async (form, back) => {
    // Syntax only: preferences() (in replaceSettings) is the one place that checks ranges and categories.
    const hours = form.get("max_weekly_hours") ?? "";
    const settings = PyDict.of({
      max_weekly_hours: hours.trim() === "" ? null : integer(hours, "每週工時上限"),
      min_fixed_twd: integer(form.get("min_fixed_twd") ?? "", "固定專案最低預算"),
      categories: form.getAll("categories"),
    });
    await replaceSettings(deps.db, integer(form.get("revision") ?? "", "設定版本"), settings);
    return seeOther(back, "settings");
  });
}

async function write(request: Request, deps: WriteDeps, run: (form: URLSearchParams, back: string) => Promise<Response>): Promise<Response> {
  const form = await guardedForm(request, deps.writes);
  if (form instanceof Response) return form;
  const back = safePath(form.get("back"));
  try {
    return await run(form, back);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // Conflict is also a ValueError, so it is told apart first.
    if (e instanceof Conflict) {
      console.warn(`page write conflict: ${message}`);
      return messagePage(409, message, back);
    }
    if (e instanceof NotFound) return messagePage(404, "找不到這筆職缺", "/");
    // Only the person's input is a 400; any other ValueError (a corrupt row) is a 500 below.
    if (e instanceof InvalidAction || e instanceof InvalidSettings) return messagePage(400, message, back);
    console.error(`page write failed: ${e instanceof Error ? e.stack ?? message : message}`);
    // D1 is reached over HTTP: a request that failed or timed out may still have written its batch.
    return messagePage(500, "結果未知，請重新載入確認是否已儲存", back);
  }
}

function integer(value: string, field: string): PyValue {
  if (!/^-?[0-9]{1,15}$/.test(value.trim())) throw new InvalidAction(`${field}需為整數`);
  return BigInt(value.trim());
}

function seeOther(back: string, notice: Notice): Response {
  const url = new URL(back, "http://page.invalid");
  url.searchParams.set("notice", notice);
  return new Response(null, { status: 303, headers: { ...NO_STORE, location: url.pathname + url.search } });
}
