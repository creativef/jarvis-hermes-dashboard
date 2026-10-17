import sys
import unittest

sys.path.insert(0, "/Users/Condense/jarvis-hermes-dashboard")
import pod_engine as pe


class ScoreIdeaTests(unittest.TestCase):
    """100-point weighted scorecard: weighting, verdict thresholds, hard knockouts."""

    def test_pass_perfect(self):
        """All 5s gives 100 and PASS."""
        r = pe.score_idea("Perfect", {c: 5 for c in pe.CRITERIA},
                          contribution_margin_pct=40)
        self.assertEqual(r.weighted_total, 100.0)
        self.assertEqual(r.verdict, pe.Verdict.PASS)
        self.assertEqual(r.knockouts, [])

    def test_hold_at_60(self):
        """60 is HOLD (55-69 band)."""
        ratings = {c: 3 for c in pe.CRITERIA}  # all 3s = 60.0
        r = pe.score_idea("Mid", ratings, contribution_margin_pct=40)
        self.assertAlmostEqual(r.weighted_total, 60.0)
        self.assertEqual(r.verdict, pe.Verdict.HOLD)

    def test_pass_at_76(self):
        """76 is PASS."""
        ratings = {
            "gift_fit": 4, "demand_evidence": 4, "differentiation": 4,
            "margin": 4, "cutoff_speed": 4, "visual_strength": 3,
            "legal_safety": 3, "bundle_repeat": 3,
        }
        r = pe.score_idea("Good", ratings, contribution_margin_pct=40)
        self.assertAlmostEqual(r.weighted_total, 76.0)
        self.assertEqual(r.verdict, pe.Verdict.PASS)

    def test_kill_below_55(self):
        """Below 55 is KILL."""
        ratings = {c: 1 for c in pe.CRITERIA}  # all 1s = 20.0
        r = pe.score_idea("Bad", ratings, contribution_margin_pct=40)
        self.assertEqual(r.weighted_total, 20.0)
        self.assertEqual(r.verdict, pe.Verdict.KILL)

    def test_kill_trademark_knockout(self):
        """Trademark flag overrides score."""
        ratings = {c: 5 for c in pe.CRITERIA}
        r = pe.score_idea("TM Problem", ratings,
                          trademark_flag=True, contribution_margin_pct=40)
        self.assertEqual(r.verdict, pe.Verdict.KILL)
        self.assertTrue(any("trademark" in k.lower() for k in r.knockouts))

    def test_kill_margin_knockout(self):
        """Margin < 35% kills a perfect idea."""
        ratings = {c: 5 for c in pe.CRITERIA}
        r = pe.score_idea("Low Margin", ratings, contribution_margin_pct=20)
        self.assertEqual(r.verdict, pe.Verdict.KILL)
        self.assertTrue(any("margin" in k.lower() for k in r.knockouts))

    def test_kill_cutoff_knockout(self):
        """Missing cutoff kills."""
        ratings = {c: 5 for c in pe.CRITERIA}
        r = pe.score_idea("Too late", ratings,
                          contribution_margin_pct=40, before_cutoff=False)
        self.assertEqual(r.verdict, pe.Verdict.KILL)
        self.assertTrue(any("cutoff" in k.lower() for k in r.knockouts))

    def test_missing_criterion_defaults_to_1(self):
        """Missing keys get a 1 rating."""
        r = pe.score_idea("Sparse", {"gift_fit": 5}, contribution_margin_pct=40)
        self.assertEqual(r.weighted_total, 36.0)
        self.assertEqual(r.verdict, pe.Verdict.KILL)

    def test_invalid_rating_clamped(self):
        """Ratings outside 1-5 are clamped."""
        ratings = {c: 99 for c in pe.CRITERIA}
        r = pe.score_idea("Clamped", ratings, contribution_margin_pct=40)
        self.assertEqual(r.weighted_total, 100.0)


class EvaluateBatchTests(unittest.TestCase):
    """Kill/hold/scale/graduate thresholds."""

    def test_empty_batch(self):
        results, summary = pe.evaluate_batch([])
        self.assertEqual(results, [])
        self.assertEqual(summary["winner_count"], 0)
        self.assertEqual(summary["total_tested"], 1)
        self.assertEqual(summary["winner_ratio"], 0.0)

    def test_kill_no_purchase_spend_double_profit(self):
        """Spend > 2x gross profit with no purchase = kill."""
        item = pe.BatchIdea(
            name="Bad",
            ad_spend=30.0,
            impressions=1100, clicks=10, visits=50, add_to_carts=2, purchases=0,
            gross_profit_per_unit=10.0,
        )
        results, _ = pe.evaluate_batch([item])
        self.assertEqual(results[0].verdict, pe.BatchVerdict.KILL)
        self.assertTrue(any("spend" in r.lower() for r in results[0].reasons))

    def test_kill_low_ctr(self):
        """CTR < 0.8 after 1k+ impressions = kill."""
        item = pe.BatchIdea(
            name="Weak CTR",
            ad_spend=5.0,
            impressions=2000, clicks=4, visits=4, add_to_carts=0, purchases=0,
            gross_profit_per_unit=15.0,
        )  # CTR = 0.2%
        results, _ = pe.evaluate_batch([item])
        self.assertEqual(results[0].verdict, pe.BatchVerdict.KILL)

    def test_kill_low_atc(self):
        """ATC < 3% after 100+ visits = kill."""
        item = pe.BatchIdea(
            name="Weak ATC",
            ad_spend=5.0,
            impressions=2000, clicks=120, visits=120, add_to_carts=2, purchases=0,
            gross_profit_per_unit=15.0,
        )  # ATC = 1.67%
        results, _ = pe.evaluate_batch([item])
        self.assertEqual(results[0].verdict, pe.BatchVerdict.KILL)

    def test_hold_some_engagement(self):
        """Clicks but no purchases yet = hold."""
        item = pe.BatchIdea(
            name="Engaged",
            ad_spend=5.0,
            impressions=500, clicks=20, visits=20, add_to_carts=5, purchases=0,
            gross_profit_per_unit=15.0, contribution_margin_pct=40,
        )
        results, _ = pe.evaluate_batch([item])
        self.assertEqual(results[0].verdict, pe.BatchVerdict.HOLD)

    def test_scale_good_roas(self):
        """2+ purchases with ROAS > 1.67 = scale."""
        item = pe.BatchIdea(
            name="Winner",
            ad_spend=20.0,
            impressions=3000, clicks=150, visits=150, add_to_carts=25,
            purchases=3, gross_profit_per_unit=20.0,  # revenue=60, ROAS=3.0
            contribution_margin_pct=40,
        )
        results, _ = pe.evaluate_batch([item])
        self.assertEqual(results[0].verdict, pe.BatchVerdict.SCALE)
        self.assertIsNotNone(results[0].roas)
        self.assertGreater(results[0].roas or 0, 1.67)

    def test_graduate_three_days_steady(self):
        """3+ days steady with 2+ purchases = graduate."""
        item = pe.BatchIdea(
            name="Evergreen",
            ad_spend=30.0,
            impressions=5000, clicks=300, visits=300, add_to_carts=50,
            purchases=5, gross_profit_per_unit=18.0,
            contribution_margin_pct=40, days_steady=4,
        )
        results, _ = pe.evaluate_batch([item])
        self.assertEqual(results[0].verdict, pe.BatchVerdict.GRADUATE)

    def test_margin_gate_kills_scaler(self):
        """Even with good ROAS, margin < 35% kills."""
        item = pe.BatchIdea(
            name="Thin Margin",
            ad_spend=20.0,
            impressions=3000, clicks=150, visits=150, add_to_carts=25,
            purchases=3, gross_profit_per_unit=20.0,
            contribution_margin_pct=20,  # under 35%
        )
        results, _ = pe.evaluate_batch([item])
        self.assertEqual(results[0].verdict, pe.BatchVerdict.KILL)

    def test_summary_counts_winners(self):
        """Winner ratio and cost per winner are correct."""
        good = pe.BatchIdea(name="A", ad_spend=10, impressions=2000, clicks=100,
                            visits=100, add_to_carts=20, purchases=3,
                            gross_profit_per_unit=15, contribution_margin_pct=40)
        bad = pe.BatchIdea(name="B", ad_spend=20, impressions=1500, clicks=3,
                           visits=3, add_to_carts=0, purchases=0,
                           gross_profit_per_unit=12)
        results, summary = pe.evaluate_batch([good, bad])
        self.assertEqual(summary["winner_count"], 1)
        self.assertEqual(summary["total_tested"], 2)
        self.assertEqual(summary["winner_ratio"], 0.5)
        self.assertEqual(summary["total_spend"], 30.0)
        self.assertEqual(summary["cost_per_winner"], 30.0)

    def test_no_winners_cost_per_winner_none(self):
        bad = pe.BatchIdea(name="B", ad_spend=15, impressions=1500, clicks=3,
                           visits=3, add_to_carts=0, purchases=0,
                           gross_profit_per_unit=12)
        _, summary = pe.evaluate_batch([bad])
        self.assertIsNone(summary["cost_per_winner"])


class WeeklyReviewTests(unittest.TestCase):
    """Markdown generator produces expected sections."""

    def test_generates_all_sections(self):
        md = pe.weekly_review(
            week_label="Wk 42",
            revenue=1500, orders=25, aov=60.0, ad_spend=200, roas=2.5,
            refund_rate_pct=2.1, email_revenue_pct=12.0,
        )
        self.assertIn("Wk 42", md)
        self.assertIn("1. Numbers", md)
        self.assertIn("$1,500", md)
        self.assertIn("2. Idea table", md)
        self.assertIn("3. Ratio check", md)
        self.assertIn("4. Decisions", md)
        self.assertIn("5. Learnings", md)
        self.assertIn("6. Operations check", md)

    def test_no_roas_handled(self):
        md = pe.weekly_review(week_label="Test", revenue=100, orders=2, aov=50)
        self.assertNotIn("Return on ad spend", md)

    def test_batch_results_in_table(self):
        r = pe.BatchResult(name="Test", verdict=pe.BatchVerdict.SCALE,
                           ctr_pct=2.5, atc_rate_pct=5.0, roas=2.0)
        md = pe.weekly_review(week_label="Test", revenue=100, orders=2, aov=50,
                              batch_results=[r])
        self.assertIn("Test", md)
        self.assertIn("SCALE", md)

    def test_batch_summary_shown(self):
        summary = {"winner_count": 3, "total_tested": 8, "winner_ratio": 0.375,
                   "total_spend": 120, "cost_per_winner": 40.0}
        md = pe.weekly_review(week_label="Test", revenue=100, orders=2, aov=50,
                              batch_summary=summary)
        self.assertIn("3 / 8", md)
        self.assertIn("37.50%", md)
        self.assertIn("$40.00", md)


class ScorecardBreakdownTests(unittest.TestCase):
    def test_returns_string(self):
        r = pe.score_idea("Test", {c: 4 for c in pe.CRITERIA},
                          contribution_margin_pct=40)
        bd = pe.scorecard_breakdown(r)
        self.assertIsInstance(bd, str)
        self.assertIn("Test", bd)
        self.assertIn("PASS", bd)


if __name__ == "__main__":
    unittest.main()