def draft(job, evaluation):
    from freelance.legacy.portfolio import PORTFOLIO
    english = job.get("language") != "zh-TW"
    locale = "en" if english else "zh"
    facts = "\n".join(PORTFOLIO[p][locale] for p in evaluation["portfolio_ids"])
    title = job.get("title", "")
    if english:
        return (f"Hello, I am interested in your project: {title}.\n\n{facts}\n\n"
                "I would start by confirming the workflow, existing systems and acceptance criteria, then propose a scoped implementation. "
                "Could you share the full requirements, access constraints and desired delivery window? "
                "I will confirm pricing and timeline after reviewing the scope.")
    return (f"您好，我對「{title}」有興趣。\n\n{facts}\n\n"
            "我會先確認使用流程、既有系統與驗收條件，再提出分階段實作方式。"
            "請提供完整需求、串接限制與期望交付時間；確認範圍後再回覆報價及工期。")
