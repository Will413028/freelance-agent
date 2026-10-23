from datetime import datetime, timezone
from math import isfinite
import re

DEFAULT_HOURS = 30

def number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and isfinite(value)


def qualify(job, available_hours=DEFAULT_HOURS, now=None, minimum_budget=3000):
    now = now or datetime.now(timezone.utc)
    reasons, questions = [], []
    text = (job.get("title", "") + " " + job.get("description", "")).lower()
    categories = [
        ("AI agent", 95, ["ai agent", "agentic", "tool calling", "智能代理", "智慧代理"], ["agent-project", "team-product"]),
        ("AI 整合／自動化", 85, ["rag", "llm", "automation", "自動化", "自动化", "聊天機器人", "聊天机器人", "ai 整合"], ["agent-project", "team-product"]),
        ("全端 MVP", 70, ["fullstack", "full-stack", "mvp", "website", "全端", "全栈", "網站", "网站", "會員"], ["booking-demo", "side-project"]),
        ("後端／API", 75, ["backend", "api", "後端", "后端", "串接"], ["team-product"]),
    ]
    def contains(term):
        return bool(re.search(r"(?<![a-z0-9])" + re.escape(term) + r"(?![a-z0-9])", text)) if term.isascii() else term in text

    matches = [(cat, score, ids) for cat, score, terms, ids in categories if any(contains(t) for t in terms)]
    category, score, portfolio_ids = max(matches, key=lambda x: x[1]) if matches else ("其他", 0, [])
    if job.get("listing_closed") is True:
        reasons.append("來源已標示結案或已徵到")
    if job.get('compensation_evidence') == 'unpaid_or_equity_only':
        reasons.append('來源明示無薪或僅股權，不符合接案收入需求')
    if not matches:
        reasons.append("不在目前接案專長範圍")
    if job.get("kind") == "full_time":
        reasons.append("全職職缺不符目前接案安排")
    elif job.get("kind") not in ("fixed", "hourly", "contract"):
        questions.append("確認合作型態")
    for key, label in [("taiwan_eligible", "台灣接案資格"), ("timezone_compatible", "時區重疊要求")]:
        if job.get(key) is False:
            reasons.append(f"{label}不符")
        elif job.get(key) is not True:
            questions.append(f"確認{label}")
    hours = job.get("weekly_hours")
    if not number(hours) or hours <= 0:
        questions.append("確認每週工時，需包含溝通與修改")
    elif available_hours is not None and hours > available_hours:
        reasons.append(f"每週需求 {hours:g} 小時，超過目前可排 {available_hours:g} 小時")
    if job.get("kind") == "fixed":
        low, high = job.get("budget_min"), job.get("budget_max")
        if not number(high) or high <= 0 or (low is not None and (not number(low) or low < 0 or low > high)):
            questions.append("確認有效的單案預算區間")
        elif job.get("currency") != "TWD":
            questions.append("確認外幣換算匯率及日期")
        elif high < minimum_budget:
            reasons.append(f"預算上限低於單案底價 TWD {minimum_budget:,.0f}")
        elif low is None or low < minimum_budget:
            questions.append(f"確認實際報價至少 TWD {minimum_budget:,.0f}")
    elif job.get("kind") in ("hourly", "contract"):
        questions.append("確認目標時薪與合約報酬，不套用單案總價門檻")
    deadline = job.get("deadline")
    if not deadline:
        questions.append("確認申請截止時間與交付時程")
    else:
        try:
            parsed = datetime.fromisoformat(deadline.replace("Z", "+00:00"))
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", deadline) and parsed.tzinfo is None:
                questions.append("確認截止時間的時區")
            elif (parsed <= now if parsed.tzinfo else parsed.date() < now.date()):
                reasons.append("申請已過期")
        except (ValueError, AttributeError):
            questions.append("確認有效的截止日期")
    if job.get("complete") is not True:
        questions.append("取得完整需求；通知摘要不足以承諾報價與交期")
    return {"status": "excluded" if reasons else "needs_info" if questions else "qualified",
            "category": category, "score": score, "reasons": reasons,
            "questions": questions, "portfolio_ids": portfolio_ids,
            "method": "規則評估", "available_hours": available_hours}


def qualify_for_intake(job, now=None):
    """Personal price/hour limits belong to the saved view, not permanent intake loss."""
    return qualify(job, available_hours=None, minimum_budget=0, now=now)
