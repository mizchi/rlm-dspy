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

///|
test "build_policy_from_metric_symbols converts symbol specs to policy" {
  let objectives : Array[ObjectiveMetricSymbol[Int, Int]] = [
    {
      key: "latency",
      direction: Minimize,
      weight: 2.0,
      read: fn(_candidate, _iteration, _state) { Ok(10.0) },
    },
  ]
  let constraints : Array[ConstraintMetricSymbol[Int, Int]] = [
    {
      key: "errors",
      comparator: Eq,
      value: 0.0,
      source: Absolute,
      read: fn(_candidate, _iteration, _state) { Ok(0.0) },
    },
  ]

  let policy = build_policy_from_metric_symbols(
    objectives,
    constraints~,
    min_score_delta=1.5,
  )

  inspect(policy.objectives.length(), content="1")
  inspect(policy.objectives[0].weight, content="2")
  inspect(policy.constraints.length(), content="1")
  inspect(policy.min_score_delta, content="1.5")
}

///|
test "collect_metric_snapshot_by_symbols reads objective and constraint metrics" {
  let candidate : ImprovementCandidate[Int] = { id: "c1", input: 3 }
  let objectives : Array[ObjectiveMetricSymbol[Int, Int]] = [
    {
      key: "score",
      direction: Maximize,
      weight: 1.0,
      read: fn(cand, iteration, state) {
        Ok(cand.input.to_double() + iteration.to_double() + state.to_double())
      },
    },
  ]
  let constraints : Array[ConstraintMetricSymbol[Int, Int]] = [
    {
      key: "errors",
      comparator: Eq,
      value: 0.0,
      source: Absolute,
      read: fn(_cand, _iteration, _state) { Ok(0.0) },
    },
  ]

  let snapshot = collect_metric_snapshot_by_symbols(
    candidate,
    2,
    4,
    objectives,
    constraints~,
  )

  let summary = match snapshot {
    Ok(s) => {
      let score = s.metrics["score"]
      let errors = s.metrics["errors"]
      "ok:\{score}:\{errors}"
    }
    Err(err) => "err:\{err}"
  }
  inspect(summary, content="ok:9:0")
}
