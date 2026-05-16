# LLM Job Management Strategy

이 문서는 IMMS-AI의 canvas 퍼실리테이터 기능에서 LLM 요청을 많이, 자주 사용해도 충돌 없이 안정적으로 운영하기 위한 작업 관리 기준을 정리한다.

## 배경

IMMS-AI는 회의 전사 내용을 바탕으로 아이디어를 자동 정리하고, 문제정의와 해결책 단계에서는 AI 추천과 사용자 승인 흐름을 제공하는 AI 퍼실리테이터다.

이 구조에서는 LLM 요청이 여러 지점에서 동시에 발생한다.

- 전사 발화 -> 아이디어 생성
- 아이디어 유사도 병합
- topic node 제목/content 요약
- 문제정의 의견 생성
- 해결책 후보 추천
- 장기적으로 방해 발언 숨김, 과거 회의 검색, 공식 문서화

따라서 LLM 응답을 "최종 상태"로 바로 덮어쓰면 안 된다. 응답은 늦게 도착할 수 있고, 응답이 도착할 때는 이미 canvas 구조가 바뀌었을 수 있다.

## 핵심 원칙

LLM 결과는 전체 workspace snapshot이 아니라, 현재 상태 위에 적용 가능한 작은 작업 결과로 다룬다.

```text
LLM response = delayed patch or suggestion
workspace = server-side source of truth
```

작업 적용 전에 항상 다음을 확인한다.

- 이 작업의 대상 scope가 아직 유효한가?
- 요청 당시 입력과 현재 입력이 의미 있게 같은가?
- 더 최신 작업이 같은 scope에서 이미 진행 중이거나 완료되었는가?
- 대상 노드가 병합/삭제/이동되었는가?
- 사용자 편집 내용을 덮어쓰는가?

## Job Metadata

모든 LLM 작업에는 최소한 다음 정보를 붙인다.

```text
job_id
job_type
scope_key
base_version 또는 base_signature
target_signature
created_epoch
status
retry_count
workspace 또는 patch 결과
detail
warning
```

필드 의미:

- `job_id`: 개별 LLM 작업 ID
- `job_type`: `idea_assimilation`, `topic_summary`, `problem_discussion` 등 작업 종류
- `scope_key`: 같은 작업이 충돌할 수 있는 범위. 예: topic id, problem group id, meeting-level ideation
- `base_version`: 요청 당시 canvas version
- `base_signature`: 요청 당시 scope 입력 hash
- `target_signature`: 요청 대상 발화/노드/child 구성 hash
- `created_epoch`: 최신 작업 판단용 monotonic-ish timestamp
- `retry_count`: 재시도 횟수

## Scope 정책

전체 시스템은 병렬로 돌리되, 같은 scope에서는 최신 작업만 의미 있게 유지한다.

예시:

```text
topic_summary: scope_key = topic_item_id
idea_assimilation: scope_key = idea_assimilation
problem_discussion: scope_key = problem_group_id
solution_suggestion: scope_key = solution_topic_id
```

서로 다른 topic 요약은 병렬로 가능하다.
같은 topic 요약은 입력이 같으면 기존 작업을 재사용하고, 입력이 달라졌으면 이전 작업을 대체한다.

## Job Status

단순히 `processing/completed/error`만으로는 부족하다. stale 상태를 세분화한다.

```text
queued
processing
completed
error_retryable
error_final
stale_rebasable
stale_superseded
stale_obsolete
```

상태 의미:

- `stale_superseded`: 같은 scope에서 더 최신 요청이 있어 대체됨
- `stale_obsolete`: 대상 노드가 병합/삭제되어 더 이상 필요 없음
- `stale_rebasable`: 대상은 살아 있고 입력만 조금 바뀌어서 최신 상태 기준 재시도 가능
- `error_retryable`: 네트워크, timeout, 429처럼 지연 후 재시도 가능한 실패
- `error_final`: LLM JSON 형식 오류, 대상 없음 등 자동 재시도하면 안 되는 실패

## Retry 정책

재시도는 "같은 응답을 다시 적용"하는 것이 아니라 "현재 canvas 기준으로 새 payload를 만들어 다시 요청"하는 것이다.

권장 정책:

```text
error_retryable:
  retry after 5s, 20s, then stop

stale_rebasable:
  same scope에 최신 작업이 없으면 10~30s 뒤 현재 상태 기준 재요청

stale_superseded:
  retry하지 않음

stale_obsolete:
  retry하지 않음

user_edited conflict:
  자동 재시도하지 않고 로그만 남김
```

유예 시간은 너무 짧게 잡지 않는다. 회의 중에는 노드가 연속으로 이동/병합될 수 있기 때문에 10초 이상 기다렸다가 최신 상태가 안정되었을 때 요청하는 편이 낫다.

## Obsolete 예시

```text
A + B -> C 생성
C 요약 job 시작
C + D -> E 생성
C 요약 job 응답 도착
```

이때 C 요약은 실패한 것이 아니라 목적지가 사라진 작업이다.

처리:

- C 요약 job은 `stale_obsolete`
- C 요약은 재시도하지 않음
- E가 `ai_pending`이고 최신 요약 job이 없다면 E 요약 job만 예약

## Superseded 예시

```text
C 요약 job #1 시작
C 하위 아이디어가 변경됨
C 요약 job #2 시작
#1 응답 도착
```

처리:

- #1은 `stale_superseded`
- #2만 적용 대상
- #1 결과는 화면/공유 workspace에 적용하지 않음

## Rebasable 예시

```text
topic T 요약 job 시작
T 제목만 사용자가 조금 수정
하위 child 구성은 그대로 유지
요약 응답 도착
```

처리 후보:

- 사용자 제목은 보존
- AI body/keywords만 patch로 적용
- 또는 `stale_rebasable`로 표시하고 현재 상태 기준 재요약

## Lineage / Alias

노드 병합이 있는 시스템은 계보를 남겨야 한다.

```text
A -> C
B -> C
C -> E
D -> E
```

늦게 도착한 응답의 대상이 C라면 서버는 C가 E로 흡수되었음을 알 수 있다.

정책:

- C 자체 요약은 obsolete
- C에 붙어야 하는 근거/키워드가 있으면 E의 후보 정보로만 보관 가능
- E 요약이 필요하면 E scope로 새 job 예약

## Patch 중심 적용

LLM은 전체 workspace를 반환하지 않는 것이 좋다.

좋은 응답 형태:

```json
{
  "operation": "update_topic_summary",
  "target_id": "topic-123",
  "base_signature": "...",
  "patch": {
    "title": "...",
    "body": "...",
    "keywords": ["..."]
  }
}
```

나쁜 응답 형태:

```json
{
  "canvas_items": ["전체 canvas snapshot"]
}
```

Patch를 적용하면 늦은 응답도 현재 workspace 위에 재검증 후 적용할 수 있다.

## Idempotency

같은 요청이 두 번 실행되어도 중복 노드가 생기면 안 된다.

기준 키:

- 발화 기반 아이디어: utterance id set
- topic summary: topic id + child signature
- problem discussion: group id + utterance id set
- suggestion: scope id + input hash

## Audit Log

사용자에게 매번 방해하지는 않되, AI가 무엇을 처리했는지는 나중에 열어볼 수 있어야 한다.

AI 진행 로그에는 다음을 남긴다.

- 어떤 작업을 시작했는가
- 어떤 scope를 대상으로 했는가
- 적용되었는가
- 대체되었는가
- obsolete 되었는가
- 재시도 예정인가
- 사용자 편집 때문에 보류되었는가

예시 문구:

```text
AI가 "고객 온보딩" topic 요약을 시작했습니다.
하위 아이디어가 변경되어 이전 요약 요청을 적용하지 않았습니다.
더 최신 요청으로 대체되었습니다.
병합된 노드의 요약 요청은 종료했습니다.
```

## 현재 구현된 안전장치

현재 코드에는 1차 안전장치가 들어가 있다.

- `topic_summary`와 `idea_assimilation` 작업을 `job_type`으로 구분
- 아이디어 정리 요청이 진행 중인 topic summary 작업을 잘못 반환받지 않도록 분리
- topic summary에 `scope_key = topic_item_id` 저장
- topic summary 입력을 hash signature로 비교
- 같은 topic에 더 최신 입력 요청이 오면 기존 작업을 `stale_superseded` 처리
- 늦은 topic summary 응답이 도착했을 때 child 구성/입력이 바뀌었으면 `stale_rebasable` 처리
- 대상 topic이 삭제/병합되었으면 `stale_obsolete` 처리
- LLM 응답 실패/예외는 재시도 가능성을 남기기 위해 `error_retryable`로 구분
- 공유 canvas 저장 시 이전/현재 `canvas_items`를 비교해 `operation_log`에 구조 변경 이력 저장
- operation log는 최근 400개만 유지하며 `node_created`, `node_moved`, `node_merged`, `node_compacted`, `node_deleted`를 기록
- 병합/삭제된 노드는 `node_lineage`에 최근 계보를 저장하고, 늦게 도착한 topic summary 작업은 흡수된 최종 노드 ID를 확인해 `stale_obsolete`로 종료
- node lineage는 최근 2000개 record로 제한하며 C -> E, A -> C -> E 같은 체인을 최종 current node 기준으로 갱신

현재 상태는 "늦은 응답이 workspace를 망가뜨리지 않게 하면서, 이후 retry queue가 판단할 수 있는 상태값을 남기는 안전장치"에 가깝다.

## 다음 구현 순서

1. Retry queue 추가
   - error retryable만 지연 재시도
   - stale rebasable은 현재 상태 기준으로 새 요청
   - obsolete/superseded는 재시도하지 않음

2. Patch 기반 응답 적용
   - 전체 workspace 대신 작업별 patch 적용
   - 사용자 편집 필드는 덮어쓰지 않음

3. AI 진행 로그 패널 데이터화
   - 사용자별로 접어둔 상태
   - 열면 AI 작업 처리 이력 확인

## 목표 상태

최종 목표는 다음과 같다.

```text
LLM 요청은 많이 보낸다.
서로 독립적인 scope는 병렬 처리한다.
같은 scope는 최신 요청만 의미 있게 유지한다.
늦은 응답은 현재 상태에 맞게 검증한다.
쓸모 없어진 작업은 조용히 종료한다.
재시도 가능한 작업만 현재 상태 기준으로 재시도한다.
모든 처리는 AI 진행 로그에 남긴다.
```

이 구조가 잡히면 실시간 다중 사용자 회의에서도 LLM 요청량을 늘리면서 canvas 데이터 안정성을 유지할 수 있다.
