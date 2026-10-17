"""
POD Scorecard & Weekly Review Engine — standalone module with no external deps.

1.  score_idea()        —  100-point weighted scorecard with hard knockouts
2.  evaluate_batch()     —  batch evaluator (CSV/JSON rows) with kill/hold/scale/graduate
3.  weekly_review()      —  markdown generator for the weekly review loop

All functions are pure: they take data in, return dicts/strings out.
No network, no disk, no side effects.
"""

from dataclasses import dataclass, field
from enum import Enum
from typing import Any

# ── constants ──────────────────────────────────────────────────────────────

WEIGHTS: dict[str, int] = {
    "gift_fit":            20,
    "demand_evidence":     20,
    "differentiation":     15,
    "margin":              15,
    "cutoff_speed":        10,
    "visual_strength":     10,
    "legal_safety":         5,
    "bundle_repeat":        5,
}  # total = 100

CRITERIA = list(WEIGHTS)


class Verdict(Enum):
    PASS = "PASS"    # >= 70, no knockouts
    HOLD = "HOLD"    # 55-69
    KILL = "KILL"    # < 55 or any knockout


class BatchVerdict(Enum):
    KILL     = "kill"
    HOLD     = "hold"
    SCALE    = "scale"
    GRADUATE = "graduate"

# ── data shapes ───────────────────────────────────────────────────────────────

@dataclass
class ScorecardResult:
    name: str
    scores: dict[str, int] = field(default_factory=dict)
    weighted_total: float = 0.0
    verdict: Verdict = Verdict.KILL
    knockouts: list[str] = field(default_factory=list)
    raw_total: float = 0.0

@dataclass
class BatchIdea:
    """One row from a CSV/JSON batch of live ideas under test."""
    name: str
    ad_spend: float = 0.0
    impressions: int = 0
    clicks: int = 0
    visits: int = 0
    add_to_carts: int = 0
    purchases: int = 0
    gross_profit_per_unit: float = 0.0
    contribution_margin_pct: float = 0.0
    days_steady: int = 0
    predicted_score: float | None = None
    category: str = ""

@dataclass
class BatchResult:
    name: str
    verdict: BatchVerdict = BatchVerdict.KILL
    reasons: list[str] = field(default_factory=list)
    ctr_pct: float = 0.0
    atc_rate_pct: float = 0.0
    roas: float | None = None
    predicted_score: float | None = None
    category: str = ""


# ── 1.  score_idea ────────────────────────────────────────────────────────

def score_idea(
    name: str,
    ratings: dict[str, int],
    *,
    trademark_flag: bool = False,
    contribution_margin_pct: float = 0.0,
    before_cutoff: bool = True,
) -> ScorecardResult:
    """
    Score one idea on the eight criteria.

    ratings :: {criterion_name: 1-5} for every key in CRITERIA.
    Hard knockouts:
      - trademark_flag
      - contribution_margin_pct < 35
      - before_cutoff == False
    """
    knockouts: list[str] = []
    if trademark_flag:
        knockouts.append("trademark flag — possible copyright/trademark problem")
    if contribution_margin_pct < 35:
        knockouts.append(f"contribution margin {contribution_margin_pct:.1f}% < 35%")
    if not before_cutoff:
        knockouts.append("cannot deliver before Christmas cutoff")

    raw = 0.0
    for c in CRITERIA:
        v = ratings.get(c, 1)
        if not (1 <= v <= 5):
            v = max(1, min(5, v))
        raw += v

    weighted = 0.0
    for c, w in WEIGHTS.items():
        v = ratings.get(c, 1)
        if not (1 <= v <= 5):
            v = max(1, min(5, v))
        weighted += (v / 5.0) * w

    if knockouts:
        verdict = Verdict.KILL
    elif weighted >= 70:
        verdict = Verdict.PASS
    elif weighted >= 55:
        verdict = Verdict.HOLD
    else:
        verdict = Verdict.KILL

    return ScorecardResult(
        name=name,
        scores=ratings,
        weighted_total=round(weighted, 1),
        verdict=verdict,
        knockouts=knockouts,
        raw_total=raw,
    )


# ── 2.  evaluate_batch ───────────────────────────────────────────────────

def evaluate_batch(ideas: list[BatchIdea]) -> tuple[list[BatchResult], dict]:
    """
    Apply kill/hold/scale/graduate thresholds to a batch of tested ideas.

    Returns (results, summary_dict) where summary carries:
      - winner_count, total_tested, winner_ratio
      - total_spend, cost_per_winner
    """
    results: list[BatchResult] = []
    total_spend = 0.0

    for idea in ideas:
        r = BatchResult(
            name=idea.name,
            predicted_score=idea.predicted_score,
            category=idea.category,
        )
        total_spend += idea.ad_spend

        # computed metrics
        if idea.impressions > 0:
            r.ctr_pct = (idea.clicks / idea.impressions) * 100
        if idea.visits > 0:
            r.atc_rate_pct = (idea.add_to_carts / idea.visits) * 100
        if idea.ad_spend > 0 and idea.purchases > 0:
            revenue = idea.purchases * idea.gross_profit_per_unit
            r.roas = revenue / idea.ad_spend

        reasons: list[str] = []

        # kill gates
        killed = False
        if idea.purchases == 0 and idea.ad_spend > 0:
            gp = idea.gross_profit_per_unit
            if gp > 0 and idea.ad_spend > 2 * gp:
                reasons.append(
                    f"spend ${idea.ad_spend:.2f} > 2x gross profit ${gp:.2f} with no purchase"
                )
                killed = True
        if idea.impressions >= 1000 and idea.clicks == 0 and not killed:
            reasons.append(f"no clicks after {idea.impressions} impressions")
            killed = True
        if idea.impressions >= 1000 and idea.clicks > 0:
            ctr = (idea.clicks / idea.impressions) * 100
            if ctr < 0.8:
                reasons.append(f"CTR {ctr:.2f}% < 0.8% (after 1k+ impressions)")
                killed = True
        if idea.visits >= 100 and idea.add_to_carts > 0:
            atc = (idea.add_to_carts / idea.visits) * 100
            if atc < 3.0:
                reasons.append(f"add-to-cart rate {atc:.2f}% < 3% (after 100+ visits)")
                killed = True

        # margin gate
        if idea.contribution_margin_pct < 35 and idea.purchases > 0:
            reasons.append(f"margin {idea.contribution_margin_pct:.1f}% < 35%")
            killed = True

        if killed:
            r.verdict = BatchVerdict.KILL
            r.reasons = reasons
            results.append(r)
            continue

        # graduate
        if idea.days_steady >= 3 and idea.purchases >= 2:
            r.verdict = BatchVerdict.GRADUATE
            r.reasons = [f"{idea.days_steady}d steady, {idea.purchases} purchases"]
            results.append(r)
            continue

        # scale
        if idea.purchases >= 2 and r.roas and idea.gross_profit_per_unit > 0:
            if r.roas > 1.67:
                r.verdict = BatchVerdict.SCALE
                r.reasons.append(f"ROAS {r.roas:.2f} > 1.7x breakeven")
                results.append(r)
                continue

        # hold
        if idea.clicks > 0 or idea.add_to_carts > 0 or idea.purchases > 0:
            r.verdict = BatchVerdict.HOLD
            if idea.purchases > 0:
                r.reasons.append(f"{idea.purchases} purchase(s) - unclear signal, hold")
            else:
                r.reasons.append("some engagement - hold for one more creative angle")
        else:
            r.verdict = BatchVerdict.HOLD
            r.reasons.append("insufficient data - hold")

        results.append(r)

    winner_cnt = sum(1 for r in results if r.verdict in (BatchVerdict.SCALE, BatchVerdict.GRADUATE))
    tested = max(len(results), 1)
    summary = {
        "winner_count": winner_cnt,
        "total_tested": tested,
        "winner_ratio": round(winner_cnt / tested, 3),
        "total_spend": round(total_spend, 2),
        "cost_per_winner": round(total_spend / winner_cnt, 2) if winner_cnt > 0 else None,
    }
    return results, summary


# ── 3.  weekly_review ──────────────────────────────────────────────────────

def weekly_review(
    *,
    week_label: str = "",
    date: str = "",
    revenue: float = 0.0,
    orders: int = 0,
    aov: float = 0.0,
    contribution_margin: float = 0.0,
    ad_spend: float = 0.0,
    roas: float | None = None,
    refund_rate_pct: float = 0.0,
    email_revenue_pct: float = 0.0,
    batch_results: list[BatchResult] | None = None,
    batch_summary: dict | None = None,
    idea_queue: list[dict] | None = None,
    decisions: str = "",
    learnings: str = "",
    ops_notes: str = "",
) -> str:
    """
    Generate a markdown weekly review.

    Sections:
      1.  Numbers
      2.  Idea table
      3.  Ratio check
      4.  Decisions
      5.  Learnings
      6.  Operations check
    """
    batch_results = batch_results or []
    label = week_label or date or "Weekly Review"
    lines = [
        f"# {label}",
        "",
        "Prepared by Atlas. Mr Thompson decides everything that spends or sends.",
        "",
        "## 1. Numbers",
        "",
        f"- Revenue: ${revenue:,.2f}",
        f"- Orders: {orders}",
        f"- Average order value: ${aov:,.2f}",
        f"- Contribution margin: ${contribution_margin:,.2f}",
        f"- Ad spend: ${ad_spend:,.2f}",
    ]
    if roas is not None:
        lines.append(f"- Return on ad spend: {roas:.2f}x")
    lines.extend([
        f"- Refund/defect rate: {refund_rate_pct:.1f}%",
        f"- Email revenue share: {email_revenue_pct:.1f}%",
        "",
    ])

    # 2.  Idea table
    lines.append("## 2. Idea table")
    lines.append("")
    if batch_results:
        lines.append("| Name | Predicted | CTR% | ATC% | Purchases | ROAS | Verdict |") 
        lines.append("|------|-----------|------|------|-----------|------|---------|")
        for r in batch_results:
            pred = f"{r.predicted_score:.0f}" if r.predicted_score is not None else "-"
            roas_s = f"{r.roas:.2f}" if r.roas else "-"
            lines.append(
                f"| {r.name} | {pred} | {r.ctr_pct:.1f} | {r.atc_rate_pct:.1f} "
                f"| - | {roas_s} | {r.verdict.value.upper()} |"
            )
    else:
        lines.append("(no batch results)")
    lines.append("")

    #3.  Ratio check
    lines.append("##3. Ratio check")
    lines.append("")
    if batch_summary:
        lines.append(
            f"- Winners / tested: {batch_summary['winner_count']} / "
            f"{batch_summary['total_tested']} = {batch_summary['winner_ratio']:.2%}"
        )
        cw = batch_summary.get('cost_per_winner')
        if cw is not None:
            lines.append(f"- Cost per winner found: ${cw:,.2f}")
        else:
            lines.append("- Cost per winner: N/A")
    else:
        lines.append("(no batch sumary)")
    lines.append("")

    #4.  Decisions
    lines.append("##4. Decisions")
    lines.append("")
    if decisions:
        lines.append(decisions)
    else:
        lines.append("(decisions to be filled during review)")
    lines.append("")

    #5.  Learnings
    lines.append("##5. Learnings")
    lines.append("")
    if learnings:
        lines.append(learnings)
    else:
        lines.append("- Scoring weight adjustments: (none needed)")
        lines.append("- Notes: (none)")
    lines.append("")

    #6.  Operations check
    lines.append("##6. Operations check")
    lines.append("")
    lines.append("- Fulfillment delays: (check)")
    lines.append("- Support tickets: (check)")
    lines.append("- Cutoff date countdown: (check)")
    lines.append("- Store health: (shopify-store weekly check)")
    if ops_notes:
        lines.append(f"- Notes: {ops_notes}")
    lines.append("")

    lines.append("---")
    lines.append("*Update scoring weights after comparing predicted vs real results.*")

    return "\n".join(lines)


# ── helpers ──────────────────────────────────────────────────────────────

def scorecard_breakdown(result: ScorecardResult) -> str:
    """Print-friendly scorecard breakdown."""
    lines = [
        f"SCORECARD: {result.name}",
        f"Verdict: {result.verdict.value}   Total: {result.weighted_total:.1f}/100",
        "",
    ]
    if result.knockouts:
        lines.append("KNOCKOUTS:")
        for k in result.knockouts:
            lines.append(f"  X  {k}")
        lines.append("")
    lines.append(f"{'Criteria':<22}  {'Rating':>6}  {'Weighted':>8}")
    lines.append(f"{'-'*22}  {'-'*6}  {'-'*8}")
    for c in CRITERIA:
        r = result.scores.get(c, 1)
        w = WEIGHTS[c]
        lines.append(f"{c:<22}  {r}/5 {'  '}  { (r/5)*w:>6.1f}")
    lines.append(f"{'-'*22}  {'-'*6}  {'-'*8}")
    lines.append(f"{'TOTAL':<22}  {result.raw_total:>5.0f}/40  {result.weighted_total:>6.1f}/100")
    return "\n".join(lines)