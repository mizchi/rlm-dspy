///|
test "run_long_improvement_loop updates baseline with best accepted" {
  let policy : ImprovementPolicy = {
    objectives: [{ key: "score", direction: Minimize, weight: 1.0 }],
    constraints: [],
    min_score_delta: 0.0,
  }
  let baseline : MetricSnapshot = { metrics: { "score": 10.0 }, gates: {} }

  let report = run_long_improvement_loop(
    baseline,
    policy,
    (),
    2,
    true,
    fn(context) {
      if context.iteration == 0 {
        [{ id: "improved", input: 5 }, { id: "worse", input: 20 }]
      } else {
        []
      }
    },
    fn(candidate, _context) {
      Ok({ metrics: { "score": candidate.input.to_double() }, gates: {} })
    },
    fn(_accepted, state) { state },
  )

  inspect(report.final_baseline.metrics["score"], content="5")
  inspect(report.accepted_history.length(), content="1")
}
