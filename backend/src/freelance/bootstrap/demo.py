from freelance.platform.sqlite import MemoryDatabase
from freelance.bootstrap.store import SQLiteStore

from freelance.modules.collection.source_catalog import PLATFORMS


def demo_store():
    store = SQLiteStore(None, database=MemoryDatabase())
    store.migrate()
    base = dict(description="", kind="fixed", currency="TWD", budget_min=5000, budget_max=12000,
                weekly_hours=12, taiwan_eligible=True, timezone_compatible=True,
                deadline="2099-01-01", complete=True, language="zh-TW", synthetic=True)
    samples = [
        {"source": "tasker", "external_id": "demo-1", "title": "AI Agent｜客服工具呼叫與訂單查詢", "description": "串接既有 API，實作 tool calling、人工確認與執行紀錄。", "budget_min": 18000, "budget_max": 35000},
        {"source": "freelancer", "external_id": "demo-2", "title": "AI agent for internal knowledge research", "description": "RAG and API integration with cited sources and human review.", "currency": "USD", "budget_min": 500, "budget_max": 900, "taiwan_eligible": None, "language": "en"},
        {"source": "tasker", "external_id": "demo-3", "title": "會員預約網站 MVP", "description": "登入、會員方案、預約與管理後台。", "budget_min": 25000, "budget_max": 50000, "weekly_hours": 18},
        {"source": "justremote", "external_id": "demo-4", "title": "Part-time Backend API Developer", "description": "Python API integration, 20 hours per week.", "kind": "contract", "currency": "USD", "budget_min": 35, "budget_max": 50, "weekly_hours": 20, "language": "en"},
        {"source": "flexjobs", "external_id": "demo-5", "title": "AI Automation Engineer — US only", "description": "Full-time automation platform development.", "kind": "full_time", "weekly_hours": 40, "taiwan_eligible": False, "language": "en"},
        {"source": "remoters", "external_id": "demo-6", "title": "API integration opportunity", "description": "Email notification excerpt; full requirements not supplied.", "complete": False, "budget_min": None, "budget_max": None, "weekly_hours": None, "taiwan_eligible": None, "language": "en"},
    ]
    for sample in samples:
        store.ingest(base | sample | {"url": "https://example.invalid/demo/" + sample["external_id"]})
    return store
