"""Cross-module attempt orchestration; external I/O never holds SQLite locks."""


def execute(store,key,*,provider,environment,account,send):
    with store.database.connect() as conn:
        current=store.submissions.row_in(conn,key)
        if current['status']=='approved':store.validate_submission_in(conn,current)
        row,claimed=store.submissions.claim_in(conn,key,provider,environment,account)
    if not claimed:return row
    try:
        result=send(row['snapshot'])
    except Exception:
        result=None
    return store.submissions.finish(key,result)
