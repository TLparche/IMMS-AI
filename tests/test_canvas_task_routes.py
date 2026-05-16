from __future__ import annotations

import unittest
import threading
import time
from uuid import uuid4

from fastapi.testclient import TestClient

from backend.api import (
    _append_canvas_operation_log_from_change,
    _canvas_activity_events_from_new_operations,
    _canvas_activity_line_from_activity_events,
    _canvas_task_lock,
    _finish_canvas_llm_inflight_entry_locked,
    _has_newer_canvas_task_scope_record,
    _mark_canvas_task_record,
    _run_canvas_task_cached_request,
    _supersede_older_canvas_task_scope_records,
    app,
    RuntimeStore,
)


LOCAL_HEADERS = {"x-real-ip": "127.0.0.1"}


class CanvasTaskRouteSmokeTest(unittest.TestCase):
    def setUp(self) -> None:
        self.client = TestClient(app)
        self.meeting_id = f"route-smoke-{uuid4().hex}"

    def _get(self, path: str):
        return self.client.get(path, headers=LOCAL_HEADERS)

    def _post(self, path: str, payload: dict):
        return self.client.post(path, json=payload, headers=LOCAL_HEADERS)

    def assertRouteOk(self, method: str, path: str, status_code: int) -> None:
        self.assertNotIn(status_code, {404, 405}, f"{method} {path} is not registered")
        self.assertLess(status_code, 500, f"{method} {path} failed with {status_code}")

    def test_task_policy_registry_exposes_expected_canvas_tasks(self) -> None:
        response = self._get("/api/ai/tasks/policies")

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertTrue(body["ok"])

        policies = {item["task_type"]: item for item in body["policies"]}
        expected_queues = {
            "ideation.assimilate_preview": "ideation_preview",
            "ideation.assimilate": "ideation_realtime",
            "ideation.topic_summary": "topic_summary",
            "ideation.recommend": "recommendation",
            "problem.discussion": "problem_discussion",
            "problem.definition": "problem_definition",
            "problem.conclusion": "problem_conclusion",
            "meeting.goal": "meeting_goal",
            "solution.stage": "solution_stage",
        }

        for task_type, queue_name in expected_queues.items():
            self.assertIn(task_type, policies)
            self.assertEqual(policies[task_type]["queue_name"], queue_name)

    def test_split_canvas_task_routes_accept_frontend_paths_without_env(self) -> None:
        long_utterance = {
            "id": "u1",
            "speaker": "A",
            "text": "사용자가 회의 중 핵심 문제를 더 빨리 찾을 수 있도록 아이디어를 구조화해야 한다는 의견입니다.",
            "timestamp": "00:00",
        }
        post_checks = [
            (
                "/api/canvas/ideation/ideas/assimilate-preview",
                {"meeting_id": self.meeting_id, "meeting_topic": "회의 보조", "target_utterances": [long_utterance]},
            ),
            (
                "/api/canvas/ideation/ideas/assimilate",
                {"meeting_id": self.meeting_id, "meeting_topic": "회의 보조", "target_utterances": []},
            ),
            (
                "/api/canvas/ideation/topics/summarize",
                {"meeting_id": self.meeting_id, "meeting_topic": "회의 보조", "topic_item_id": "missing-topic"},
            ),
            (
                "/api/canvas/problem/discussions/assimilate",
                {"meeting_id": self.meeting_id, "meeting_topic": "회의 보조", "target_utterances": []},
            ),
            (
                "/api/canvas/problem/groups/generate",
                {
                    "meeting_id": self.meeting_id,
                    "topic": "회의 보조",
                    "ideas": [
                        {
                            "id": "idea-1",
                            "agenda_id": "agenda-1",
                            "title": "발언 자동 정리",
                            "body": "아이디어를 계층화한다.",
                        }
                    ],
                },
            ),
            (
                "/api/canvas/problem/groups/conclusion",
                {
                    "meeting_id": self.meeting_id,
                    "meeting_topic": "회의 보조",
                    "group": {
                        "group_id": "group-1",
                        "topic": "아이디어 구조화",
                        "insight_lens": "회의 흐름",
                        "source_summary_items": ["아이디어가 많아지면 찾기 어렵다."],
                        "ideas": [{"id": "idea-1", "title": "계층 캔버스", "body": "n차 자식을 포커스 캔버스로 보여준다."}],
                    },
                },
            ),
            (
                "/api/canvas/meeting/goal",
                {"meeting_id": self.meeting_id, "topic": "AI 퍼실리테이터"},
            ),
            (
                "/api/canvas/solution/stage/generate",
                {
                    "meeting_id": self.meeting_id,
                    "meeting_topic": "AI 퍼실리테이터",
                    "topics": [{"group_id": "group-1", "topic_no": 1, "topic": "계층 캔버스", "conclusion": "탐색 부담을 줄인다."}],
                },
            ),
            (
                "/api/canvas/ideation/suggestions/generate",
                {
                    "meeting_id": self.meeting_id,
                    "meeting_topic": "AI 퍼실리테이터",
                    "topic": {"id": "topic-1", "title": "계층 캔버스", "body": "아이디어 탐색을 돕는다."},
                    "child_items": [{"id": "child-1", "title": "포커스 캔버스", "body": "선택한 자식만 보여준다."}],
                },
            ),
        ]

        for path, payload in post_checks:
            with self.subTest(path=path):
                response = self._post(path, payload)
                self.assertRouteOk("POST", path, response.status_code)

        get_checks = [
            f"/api/canvas/ideation/jobs/missing-job?meeting_id={self.meeting_id}",
            f"/api/canvas/problem/jobs/missing-job?meeting_id={self.meeting_id}",
        ]
        for path in get_checks:
            with self.subTest(path=path):
                response = self._get(path)
                self.assertRouteOk("GET", path, response.status_code)
                self.assertEqual(response.json()["status"], "missing")

    def test_task_records_endpoint_returns_route_activity(self) -> None:
        response = self._post(
            "/api/canvas/problem/groups/generate",
            {
                "meeting_id": self.meeting_id,
                "topic": "AI 퍼실리테이터",
                "ideas": [
                    {
                        "id": "idea-1",
                        "agenda_id": "agenda-1",
                        "title": "발언 정리",
                        "body": "회의 발언을 자동으로 정리한다.",
                    }
                ],
            },
        )
        self.assertRouteOk("POST", "/api/canvas/problem/groups/generate", response.status_code)

        tasks_response = self._get(f"/api/ai/tasks?meeting_id={self.meeting_id}")
        self.assertEqual(tasks_response.status_code, 200)
        body = tasks_response.json()
        self.assertTrue(body["ok"])
        self.assertEqual(body["meeting_id"], self.meeting_id)

        task_types = {task["task_type"] for task in body["tasks"]}
        self.assertIn("problem.definition", task_types)
        self.assertIn("problem_definition", body["queues"])
        problem_definition_task = next(task for task in body["tasks"] if task["task_type"] == "problem.definition")
        self.assertEqual(problem_definition_task["activity_type"], "generate_problem")
        self.assertEqual(problem_definition_task["activity_line"], "문제정의 그룹 생성")

        filtered_response = self._get(
            f"/api/ai/tasks?meeting_id={self.meeting_id}&task_type=problem.definition&limit=1"
        )
        self.assertEqual(filtered_response.status_code, 200)
        filtered = filtered_response.json()
        self.assertEqual(filtered["limit"], 1)
        self.assertGreaterEqual(filtered["total"], 1)
        self.assertLessEqual(len(filtered["tasks"]), 1)
        self.assertTrue(all(task["task_type"] == "problem.definition" for task in filtered["tasks"]))
        self.assertEqual(filtered["filters"]["task_type"], ["problem.definition"])

    def test_newer_same_scope_task_supersedes_older_active_task(self) -> None:
        rt = RuntimeStore()
        meeting_id = f"task-supersede-{uuid4().hex}"
        scope_key = "problem_definition:agenda-1"
        task_type = "problem.definition"

        _mark_canvas_task_record(
            rt,
            meeting_id,
            "old-task",
            task_type=task_type,
            scope_key=scope_key,
            status="processing",
            target_signature="old-signature",
            created_epoch=1.0,
        )
        _mark_canvas_task_record(
            rt,
            meeting_id,
            "new-task",
            task_type=task_type,
            scope_key=scope_key,
            status="processing",
            target_signature="new-signature",
            created_epoch=2.0,
        )

        superseded_count = _supersede_older_canvas_task_scope_records(
            rt,
            meeting_id,
            "new-task",
            task_type,
            scope_key,
            "new-signature",
        )

        self.assertEqual(superseded_count, 1)
        old_record = rt.canvas_task_records_by_meeting[meeting_id]["old-task"]
        new_record = rt.canvas_task_records_by_meeting[meeting_id]["new-task"]
        self.assertEqual(old_record["status"], "stale_superseded")
        self.assertEqual(old_record["stale_reason"], "superseded")
        self.assertEqual(new_record["status"], "processing")
        self.assertTrue(
            _has_newer_canvas_task_scope_record(
                rt,
                meeting_id,
                "old-task",
                task_type,
                scope_key,
                "old-signature",
            )
        )
        self.assertFalse(
            _has_newer_canvas_task_scope_record(
                rt,
                meeting_id,
                "new-task",
                task_type,
                scope_key,
                "new-signature",
            )
        )

    def test_llm_inflight_completion_preserves_newer_signature_entry(self) -> None:
        rt = RuntimeStore()
        meeting_id = f"inflight-{uuid4().hex}"
        cache_key = "problem.definition:agenda-1"
        old_event = threading.Event()
        new_event = threading.Event()

        with rt.lock:
            rt.canvas_llm_inflight_by_meeting[meeting_id] = {
                cache_key: {"signature": "new-signature", "event": new_event, "error": ""},
            }
            _finish_canvas_llm_inflight_entry_locked(
                rt,
                meeting_id,
                cache_key,
                "old-signature",
                old_event,
            )

        self.assertTrue(old_event.is_set())
        self.assertFalse(new_event.is_set())
        self.assertIs(rt.canvas_llm_inflight_by_meeting[meeting_id][cache_key]["event"], new_event)

    def test_superseded_task_response_is_marked_stale(self) -> None:
        rt = RuntimeStore()
        meeting_id = f"stale-response-{uuid4().hex}"
        scope_key = "ideation-assimilate:latest"

        def compute() -> dict:
            records = rt.canvas_task_records_by_meeting[meeting_id]
            old_task_id, old_record = next(iter(records.items()))
            _mark_canvas_task_record(
                rt,
                meeting_id,
                "new-task",
                task_type="ideation.assimilate",
                scope_key=scope_key,
                status="processing",
                target_signature="new-signature",
                created_epoch=float(old_record["created_epoch"]) + 1.0,
            )
            _supersede_older_canvas_task_scope_records(
                rt,
                meeting_id,
                "new-task",
                "ideation.assimilate",
                scope_key,
                "new-signature",
            )
            self.assertEqual(records[old_task_id]["status"], "stale_superseded")
            return {"ok": True, "used_llm": False, "generated_at": "now"}

        response = _run_canvas_task_cached_request(
            rt,
            "ideation.assimilate",
            meeting_id,
            scope_key,
            "old-signature",
            compute,
        )

        self.assertEqual(response["status"], "stale_superseded")
        self.assertEqual(response["stale_reason"], "superseded")
        self.assertFalse(response["retryable"])
        self.assertIn("적용하지 않았습니다", response["warning"])

    def test_superseded_task_skips_compute_before_llm_call(self) -> None:
        rt = RuntimeStore()
        meeting_id = f"skip-compute-{uuid4().hex}"
        scope_key = "problem_definition:agenda-1"
        request_lock = _canvas_task_lock(rt, "problem.definition", "request")
        request_lock.acquire()
        compute_called = False
        response_holder: dict[str, dict] = {}
        error_holder: dict[str, BaseException] = {}

        def compute() -> dict:
            nonlocal compute_called
            compute_called = True
            return {"ok": True, "used_llm": True, "generated_at": "now", "groups": []}

        def run_request() -> None:
            try:
                response_holder["response"] = _run_canvas_task_cached_request(
                    rt,
                    "problem.definition",
                    meeting_id,
                    scope_key,
                    "old-signature",
                    compute,
                )
            except BaseException as exc:
                error_holder["error"] = exc

        worker = threading.Thread(target=run_request, daemon=True)
        worker.start()
        try:
            old_task_id = ""
            old_created_epoch = 0.0
            for _ in range(100):
                with rt.lock:
                    records = rt.canvas_task_records_by_meeting.get(meeting_id) or {}
                    old_task_id, old_record = next(iter(records.items()), ("", {}))
                    old_created_epoch = float((old_record or {}).get("created_epoch") or 0)
                if old_task_id:
                    break
                time.sleep(0.01)

            self.assertTrue(old_task_id)
            _mark_canvas_task_record(
                rt,
                meeting_id,
                "new-task",
                task_type="problem.definition",
                scope_key=scope_key,
                status="processing",
                target_signature="new-signature",
                created_epoch=old_created_epoch + 1.0,
            )
            _supersede_older_canvas_task_scope_records(
                rt,
                meeting_id,
                "new-task",
                "problem.definition",
                scope_key,
                "new-signature",
            )
        finally:
            request_lock.release()

        worker.join(timeout=2.0)

        self.assertFalse(worker.is_alive())
        self.assertNotIn("error", error_holder)
        self.assertFalse(compute_called)
        self.assertEqual(response_holder["response"]["status"], "stale_superseded")
        self.assertIn("LLM 호출을 생략", response_holder["response"]["warning"])

    def test_operation_log_summarizes_node_names_for_merge(self) -> None:
        previous_workspace = {
            "canvas_items": [
                {"id": "idea-a", "kind": "note", "title": "A 아이디어"},
                {"id": "idea-b", "kind": "note", "title": "B 아이디어"},
            ],
            "operation_log": [],
        }
        next_workspace = {
            "canvas_items": [
                {
                    "id": "topic-c",
                    "kind": "topic",
                    "title": "C 토픽",
                    "child_item_ids": ["idea-a", "idea-b"],
                    "created_by": "ai",
                    "ai_generated": True,
                },
                {"id": "idea-a", "kind": "note", "title": "A 아이디어", "parent_topic_id": "topic-c"},
                {"id": "idea-b", "kind": "note", "title": "B 아이디어", "parent_topic_id": "topic-c"},
            ],
        }

        result = _append_canvas_operation_log_from_change(previous_workspace, next_workspace, source="test")

        summaries = [entry["summary"] for entry in result["operation_log"]]
        self.assertIn('"A 아이디어"와 "B 아이디어"를 "C 토픽"에 병합', summaries)

        events = _canvas_activity_events_from_new_operations(result, set())
        self.assertEqual(events[0]["summary"], '"A 아이디어"와 "B 아이디어"를 "C 토픽"에 병합')
        self.assertEqual(
            _canvas_activity_line_from_activity_events(events, "fallback"),
            '"A 아이디어"와 "B 아이디어"를 "C 토픽"에 병합',
        )


if __name__ == "__main__":
    unittest.main()
