#!/usr/bin/env python3
"""Compute per-feature student usage ratios from AI tutor event logs.

Expected input is one or more JSON files containing either:
1) newline-delimited JSON objects (JSONL), or
2) a JSON array of event objects.

Each event object should follow the frontend logger shape:
{
  "event_type": "...",
  "user_email": "student@school.edu",
  "payload": { ... }
}

The script computes, for each feature:
- eligible students: unique students with exp_turn_start for that feature's experiment
- used students: unique students with one or more usage events for that feature
- ratio: used / eligible
"""

from __future__ import annotations

import argparse
import csv
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class FeatureConfig:
    name: str
    experiment_id: str
    usage_event_types: tuple[str, ...]


FEATURES: tuple[FeatureConfig, ...] = (
    FeatureConfig(
        name="follow_up",
        experiment_id="exp_follow_up",
        usage_event_types=("follow_up_question", "exp_follow_up_impression"),
    ),
    FeatureConfig(
        name="relevant_lectures",
        experiment_id="exp_relevant_lectures",
        usage_event_types=("exp_lectures_impression",),
    ),
    FeatureConfig(
        name="practice_problems",
        experiment_id="exp_practice_problems",
        usage_event_types=("practice_problems_request", "exp_practice_impression"),
    ),
    FeatureConfig(
        name="exam_mode",
        experiment_id="exp_exam_mode",
        usage_event_types=("exam_mode_started", "exp_exam_mode_activated"),
    ),
)


def _as_dict(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            pass
    return {}


def _iter_events_from_file(path: Path) -> list[dict[str, Any]]:
    text = path.read_text(encoding="utf-8").strip()
    if not text:
        return []

    events: list[dict[str, Any]] = []

    try:
        parsed = json.loads(text)
        if isinstance(parsed, list):
            for item in parsed:
                if isinstance(item, dict):
                    events.append(item)
            return events
        if isinstance(parsed, dict):
            return [parsed]
    except json.JSONDecodeError:
        pass

    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
            if isinstance(event, dict):
                events.append(event)
        except json.JSONDecodeError:
            continue

    return events


def _extract_student_id(event: dict[str, Any]) -> str | None:
    payload = _as_dict(event.get("payload"))

    candidate_keys = (
        "student_key_hash",
        "student_hash",
        "student_id",
        "user_id",
    )
    for key in candidate_keys:
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()

    user_email = event.get("user_email")
    if isinstance(user_email, str) and user_email.strip():
        return user_email.strip().lower()

    return None


def _event_type(event: dict[str, Any]) -> str:
    value = event.get("event_type")
    return value if isinstance(value, str) else ""


def _experiment_id(event: dict[str, Any]) -> str:
    payload = _as_dict(event.get("payload"))
    value = payload.get("experiment_id")
    return value if isinstance(value, str) else ""


def _collect(paths: list[Path]) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for path in paths:
        events.extend(_iter_events_from_file(path))
    return events


def _feature_rows(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []

    for feature in FEATURES:
        eligible_students: set[str] = set()
        used_students: set[str] = set()
        usage_event_count = 0

        for event in events:
            student_id = _extract_student_id(event)
            if not student_id:
                continue

            event_type = _event_type(event)
            experiment_id = _experiment_id(event)

            if event_type == "exp_turn_start" and experiment_id == feature.experiment_id:
                eligible_students.add(student_id)

            if event_type in feature.usage_event_types:
                # Some usage events include experiment_id, some do not.
                # If present, enforce matching to avoid accidental cross-feature counting.
                if not experiment_id or experiment_id == feature.experiment_id:
                    used_students.add(student_id)
                    usage_event_count += 1

        eligible_count = len(eligible_students)
        used_count = len(used_students)
        ratio = (used_count / eligible_count) if eligible_count else 0.0

        rows.append(
            {
                "feature": feature.name,
                "experiment_id": feature.experiment_id,
                "eligible_students": eligible_count,
                "students_used": used_count,
                "usage_ratio": ratio,
                "usage_pct": round(ratio * 100, 2),
                "usage_events": usage_event_count,
            }
        )

    return rows


def _print_table(rows: list[dict[str, Any]]) -> None:
    headers = [
        "feature",
        "experiment_id",
        "eligible_students",
        "students_used",
        "usage_ratio",
        "usage_pct",
        "usage_events",
    ]

    formatted_rows: list[list[str]] = []
    for row in rows:
        formatted_rows.append(
            [
                str(row["feature"]),
                str(row["experiment_id"]),
                str(row["eligible_students"]),
                str(row["students_used"]),
                f"{row['usage_ratio']:.4f}",
                f"{row['usage_pct']:.2f}%",
                str(row["usage_events"]),
            ]
        )

    widths = [len(h) for h in headers]
    for r in formatted_rows:
        widths = [max(widths[i], len(r[i])) for i in range(len(headers))]

    def fmt_line(values: list[str]) -> str:
        return " | ".join(values[i].ljust(widths[i]) for i in range(len(values)))

    print(fmt_line(headers))
    print("-+-".join("-" * w for w in widths))
    for r in formatted_rows:
        print(fmt_line(r))


def _write_csv(rows: list[dict[str, Any]], output_path: Path) -> None:
    fieldnames = [
        "feature",
        "experiment_id",
        "eligible_students",
        "students_used",
        "usage_ratio",
        "usage_pct",
        "usage_events",
    ]
    with output_path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow(row)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Calculate per-feature student usage ratios from tutor log exports."
    )
    parser.add_argument(
        "--input",
        "-i",
        nargs="+",
        required=True,
        help="One or more log files (JSON array or JSONL).",
    )
    parser.add_argument(
        "--output-format",
        choices=("table", "json", "csv"),
        default="table",
        help="How to display results. Default: table.",
    )
    parser.add_argument(
        "--output-file",
        help="Optional output path (required for csv, optional for json).",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    paths = [Path(p) for p in args.input]

    missing = [str(p) for p in paths if not p.exists()]
    if missing:
        print(f"Error: input file(s) not found: {', '.join(missing)}")
        return 1

    events = _collect(paths)
    rows = _feature_rows(events)

    if args.output_format == "table":
        _print_table(rows)
        return 0

    if args.output_format == "json":
        rendered = json.dumps(rows, indent=2)
        if args.output_file:
            Path(args.output_file).write_text(rendered + "\n", encoding="utf-8")
        else:
            print(rendered)
        return 0

    # csv
    if not args.output_file:
        print("Error: --output-file is required when --output-format csv")
        return 1
    _write_csv(rows, Path(args.output_file))
    print(f"Wrote CSV: {args.output_file}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
