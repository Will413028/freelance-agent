from copy import deepcopy
from datetime import datetime, timezone
from hashlib import sha256
import json
from threading import RLock

from freelance.modules.discovery.rules import DEFAULTS, evaluate, project, preferences, group_items
from freelance.modules.discovery.ranking import rank_items


from freelance.platform.errors import Conflict, InvalidAction


from freelance.modules.collection.observation import older_notification


class ReviewStore:
    def __init__(self, clock=None):
        self._items = {}
        self._lock = RLock()
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._preferences = dict(revision=0, settings=deepcopy(DEFAULTS))

    def _refresh(self, item):
        item["evaluation"] = evaluate(item["job"], self._preferences['settings'], self._clock())
        if item["evaluation"]["status"] != "qualified" and item["review_status"] == "approved":
            item.update(review_status="draft", approved_hash=None, version=item["version"] + 1)

    def ingest(self, job):
        if not job.get("source") or not job.get("external_id"):
            raise ValueError("source and external_id required")
        key = sha256(json.dumps([job["source"], job["external_id"]]).encode()).hexdigest()[:24]
        content = {k: v for k, v in job.items() if k not in {"received_at", "receipt_id", "evidence_ref", "raw_evidence_ref"}}
        fingerprint = sha256(json.dumps(content, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        with self._lock:
            old = self._items.get(key)
            if old and older_notification(job, old['job']):
                self._refresh(old)
                return deepcopy(old)
            if old and old["fingerprint"] == fingerprint:
                old["job"] = deepcopy(job)
                self._refresh(old)
                return deepcopy(old)
            from freelance.modules.preferences.domain import empty_tracking
            evaluation = evaluate(job, self._preferences['settings'], self._clock())
            item = {"id": key, "job": deepcopy(job), "fingerprint": fingerprint,
                    "evaluation": evaluation, "proposal": '',
                    "version": old["version"] + 1 if old else 1,
                    "review_status": "draft", "approved_hash": None, "skip_reason": "",
                    "draft_method": "未建立提案", "delivery_mode": "manual",
                    "tracking": deepcopy(old['tracking']) if old else empty_tracking()}
            if old and old["review_status"] == "skipped":
                item.update(review_status="skipped", skip_reason=old["skip_reason"])
            self._items[key] = item
            return deepcopy(item)

    def list(self):
        with self._lock:
            now = self._clock()
            items = [project(item, self._preferences['settings'], now) for item in self._items.values()]
            return rank_items(items, now)

    def preferences(self):
        with self._lock:
            return deepcopy(self._preferences)

    def set_preferences(self, revision, settings):
        settings = preferences(settings)
        with self._lock:
            if type(revision) is not int or revision != self._preferences['revision']:
                raise Conflict('篩選設定已更新，請重新載入')
            self._preferences = dict(revision=revision + 1, settings=settings)
            return deepcopy(self._preferences)

    def feedback(self, key, versions, feedback):
        from freelance.modules.preferences.domain import update_tracking
        with self._lock:
            group = next((item for item in group_items(self.list()) if key in item['member_ids']), None)
            if group is None:
                raise KeyError(key)
            expected = {member['id']: member['token'] for member in group['members']}
            if (not isinstance(versions, dict) or any(not isinstance(value, str) for value in versions.values())
                    or versions != expected):
                raise Conflict('職缺或收藏狀態已更新，請重新載入')
            updates = {}
            for member in group['members']:
                current = self._items[member['id']]['tracking']
                updates[member['id']] = update_tracking(current, member['revision'], self._clock(),
                                                       feedback=feedback, note=current.get('note', ''))
            for identity, state in updates.items():
                item = self._items[identity]
                item['tracking'] = state
                if feedback != 'skipped' and item['review_status'] == 'skipped':
                    item.update(review_status='draft', skip_reason='', approved_hash=None, version=item['version'] + 1)
                if feedback == 'skipped' and item['review_status'] == 'approved':
                    item.update(review_status='draft', approved_hash=None, version=item['version'] + 1)
            return {'status': 'saved'}

    def review(self, key, action, version, text="", reason=""):
        with self._lock:
            if key not in self._items:
                raise KeyError(key)
            item = self._items[key]
            if isinstance(version, bool) or not isinstance(version, int) or version != item["version"]:
                raise Conflict("草稿已更新，請重新載入後確認")
            if action == "edit":
                if not isinstance(text, str) or not text.strip() or len(text) > 10000:
                    raise InvalidAction("申請稿需為 1–10000 字")
                item.update(proposal=text.strip(), version=version + 1, review_status="draft", approved_hash=None)
            elif action == "approve":
                if not item['proposal'].strip() or item['tracking']['feedback'] == 'skipped':
                    raise InvalidAction('尚未建立提案或已略過，無法核准')
                evaluation = evaluate(item["job"], self._preferences['settings'], self._clock())
                item["evaluation"] = evaluation
                if evaluation["status"] != "qualified":
                    raise InvalidAction("案件仍有未確認或不符合的条件，無法核准")
                if item["review_status"] == "skipped":
                    raise InvalidAction("請先編輯草稿以重新開啟略過的案件")
                item.update(review_status="approved", approved_hash=sha256(item["proposal"].encode()).hexdigest())
            elif action == "skip":
                if not isinstance(reason, str) or not reason.strip() or len(reason) > 500:
                    raise InvalidAction("請填寫 1–500 字略過原因")
                item.update(review_status="skipped", skip_reason=reason.strip(), approved_hash=None)
            else:
                raise InvalidAction("不支援的操作；Demo 不會寄信或投遞")
            return deepcopy(item)
