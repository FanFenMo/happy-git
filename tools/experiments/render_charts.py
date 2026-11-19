#!/usr/bin/env python3
"""Zero-dependency SVG chart generator for HappyGit portrait experiment reports."""

from __future__ import annotations

import html
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


PALETTE = [
    "#2563eb",  # blue
    "#16a34a",  # green
    "#ea580c",  # orange
    "#7c3aed",  # purple
    "#0891b2",  # cyan
    "#dc2626",  # red
]


def _esc(text: Any) -> str:
    return html.escape(str(text), quote=True)


def _render_grouped_bar_svg(
    title: str,
    subtitle: str,
    categories: List[str],
    series: List[Tuple[str, List[Optional[float]]]],
    width: int = 860,
    height: int = 420,
) -> str:
    pad_left = 68
    pad_right = 28
    pad_top = 86
    pad_bottom = 86
    chart_w = max(200, width - pad_left - pad_right)
    chart_h = max(140, height - pad_top - pad_bottom)

    lines: List[str] = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">',
        '<rect width="100%" height="100%" fill="#ffffff"/>',
        '<style>'
        'text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif; fill: #0f172a; }'
        '.title { font-size: 16px; font-weight: 700; }'
        '.sub { font-size: 11px; fill: #475569; }'
        '.axis { font-size: 11px; fill: #334155; }'
        '.val { font-size: 10px; fill: #1e293b; font-weight: 600; }'
        '.legend { font-size: 11px; fill: #1e293b; }'
        '</style>',
        f'<text x="{pad_left}" y="28" class="title">{_esc(title)}</text>',
        f'<text x="{pad_left}" y="46" class="sub">{_esc(subtitle)}</text>',
    ]

    # Legend row
    lx = pad_left
    for idx, (name, _) in enumerate(series):
        color = PALETTE[idx % len(PALETTE)]
        lines.append(f'<rect x="{lx}" y="58" width="12" height="12" rx="2" fill="{color}"/>')
        lines.append(f'<text x="{lx + 17}" y="68" class="legend">{_esc(name)}</text>')
        lx += max(125, len(name) * 8 + 38)

    # Gridlines & Y-axis ticks (0.0 to 1.0)
    for step in range(6):
        frac = step / 5.0
        y = pad_top + chart_h - frac * chart_h
        lines.append(
            f'<line x1="{pad_left}" y1="{y:.1f}" x2="{pad_left + chart_w}" y2="{y:.1f}" '
            f'stroke="#e2e8f0" stroke-width="1"/>'
        )
        lines.append(
            f'<text x="{pad_left - 8}" y="{y + 4:.1f}" text-anchor="end" class="axis">{frac:.1f}</text>'
        )

    lines.append(
        f'<line x1="{pad_left}" y1="{pad_top + chart_h}" x2="{pad_left + chart_w}" '
        f'y2="{pad_top + chart_h}" stroke="#64748b" stroke-width="1.2"/>'
    )

    if not categories or not series:
        lines.append(
            f'<text x="{width // 2}" y="{pad_top + chart_h // 2}" text-anchor="middle" class="sub">No completed series available</text>'
        )
        lines.append("</svg>")
        return "\n".join(lines) + "\n"

    n_cat = len(categories)
    n_ser = len(series)
    group_w = chart_w / max(1, n_cat)
    bar_area = group_w * 0.72
    bar_w = max(8.0, min(36.0, bar_area / max(1, n_ser) - 2.0))
    total_bars_w = n_ser * bar_w + max(0, n_ser - 1) * 2.0

    for c_idx, cat in enumerate(categories):
        gx = pad_left + c_idx * group_w + (group_w - total_bars_w) / 2.0
        center_x = pad_left + c_idx * group_w + group_w / 2.0
        label_y = pad_top + chart_h + 18
        if len(cat) > 14:
            lines.append(
                f'<text x="{center_x:.1f}" y="{label_y:.1f}" text-anchor="end" '
                f'transform="rotate(-24 {center_x:.1f} {label_y:.1f})" class="axis">{_esc(cat)}</text>'
            )
        else:
            lines.append(
                f'<text x="{center_x:.1f}" y="{label_y:.1f}" text-anchor="middle" class="axis">{_esc(cat)}</text>'
            )

        for s_idx, (_, values) in enumerate(series):
            val = values[c_idx] if c_idx < len(values) else None
            bx = gx + s_idx * (bar_w + 2.0)
            color = PALETTE[s_idx % len(PALETTE)]
            if val is None:
                lines.append(
                    f'<text x="{bx + bar_w / 2:.1f}" y="{pad_top + chart_h - 4:.1f}" '
                    f'text-anchor="middle" class="sub">N/A</text>'
                )
                continue
            clamped = max(0.0, min(1.0, float(val)))
            bh = clamped * chart_h
            by = pad_top + chart_h - bh
            lines.append(
                f'<rect x="{bx:.1f}" y="{by:.1f}" width="{bar_w:.1f}" height="{bh:.1f}" rx="2" fill="{color}"/>'
            )
            lines.append(
                f'<text x="{bx + bar_w / 2:.1f}" y="{max(pad_top + 10, by - 4):.1f}" '
                f'text-anchor="middle" class="val">{clamped:.2f}</text>'
            )

    lines.append("</svg>")
    return "\n".join(lines) + "\n"


def render_experiment_charts(report: Dict[str, Any], charts_dir: Path) -> List[Dict[str, str]]:
    charts_dir.mkdir(parents=True, exist_ok=True)
    methods = report.get("methods") or {}
    completed = [
        (name, block)
        for name, block in methods.items()
        if block.get("status") == "completed" and isinstance(block.get("metrics"), dict)
    ]
    if not completed:
        return []

    meta = report.get("metadata") or {}
    subtitle = (
        f"dataset={meta.get('datasetVersion', 'unknown')} | split={meta.get('split', 'test')} | "
        f"n={meta.get('subjectCount', 0)}"
    )
    generated: List[Dict[str, str]] = []

    # 1. Overall core metrics
    overall_keys = [
        ("f1At8", "F1@8"),
        ("jaccard", "Jaccard@8"),
        ("ndcgAt8", "nDCG@8"),
        ("langCosine", "Lang Cos"),
        ("topicCosine", "Topic Cos"),
        ("evidenceValidRate", "Evidence"),
        ("emptyHandlingAccuracy", "Empty Acc"),
    ]
    overall_series: List[Tuple[str, List[Optional[float]]]] = []
    for name, block in completed:
        ov = (block.get("metrics") or {}).get("overall") or {}
        label = f"{name} ({block.get('modelVersion') or '-'})"
        overall_series.append((label, [ov.get(k) for k, _ in overall_keys]))

    overall_path = charts_dir / "overall-metrics.svg"
    overall_path.write_text(
        _render_grouped_bar_svg(
            title="HappyGit Portrait Evaluation - Overall Metrics",
            subtitle=subtitle,
            categories=[lbl for _, lbl in overall_keys],
            series=overall_series,
        ),
        encoding="utf-8",
    )
    generated.append({
        "id": "overall_metrics",
        "title": "各方法核心指标总览",
        "path": "charts/overall-metrics.svg",
    })

    # 2. Scenario F1@8 breakdown
    all_scenarios: List[str] = sorted({
        scen
        for _, block in completed
        for scen in ((block.get("metrics") or {}).get("byScenario") or {}).keys()
    })
    if all_scenarios:
        first_by_scen = ((completed[0][1].get("metrics") or {}).get("byScenario") or {})
        scen_labels = [
            f"{s} (n={first_by_scen.get(s, {}).get('count', 0)})"
            for s in all_scenarios
        ]
        scen_series: List[Tuple[str, List[Optional[float]]]] = []
        for name, block in completed:
            by_scen = (block.get("metrics") or {}).get("byScenario") or {}
            scen_series.append((name, [(by_scen.get(s) or {}).get("f1At8") for s in all_scenarios]))

        scen_path = charts_dir / "scenario-f1.svg"
        scen_path.write_text(
            _render_grouped_bar_svg(
                title="HappyGit Portrait Evaluation - Top-8 F1 by Scenario",
                subtitle=subtitle,
                categories=scen_labels,
                series=scen_series,
                width=max(860, len(all_scenarios) * 95 + 140),
            ),
            encoding="utf-8",
        )
        generated.append({
            "id": "scenario_f1",
            "title": "分场景 Top-8 F1 对比",
            "path": "charts/scenario-f1.svg",
        })

    # 3. Sparsity F1@8 breakdown
    sparsity_order = ["empty", "sparse", "medium", "dense", "rich"]
    all_sp_keys = {
        sp
        for _, b in completed
        for sp in ((b.get("metrics") or {}).get("bySparsity") or {}).keys()
    }
    present_sparsity = [sp for sp in sparsity_order if sp in all_sp_keys] + sorted(
        sp for sp in all_sp_keys if sp not in sparsity_order
    )
    if present_sparsity:
        first_sp = ((completed[0][1].get("metrics") or {}).get("bySparsity") or {})
        sp_labels = [f"{sp} (n={first_sp.get(sp, {}).get('count', 0)})" for sp in present_sparsity]
        sp_series: List[Tuple[str, List[Optional[float]]]] = []
        for name, block in completed:
            by_sp = (block.get("metrics") or {}).get("bySparsity") or {}
            sp_series.append((name, [(by_sp.get(sp) or {}).get("f1At8") for sp in present_sparsity]))

        sp_path = charts_dir / "sparsity-f1.svg"
        sp_path.write_text(
            _render_grouped_bar_svg(
                title="HappyGit Portrait Evaluation - Top-8 F1 by Evidence Sparsity",
                subtitle=subtitle,
                categories=sp_labels,
                series=sp_series,
            ),
            encoding="utf-8",
        )
        generated.append({
            "id": "sparsity_f1",
            "title": "分证据稀疏度 Top-8 F1 对比",
            "path": "charts/sparsity-f1.svg",
        })

    return generated
