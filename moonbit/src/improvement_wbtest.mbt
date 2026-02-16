///|
test "score_snapshot applies direction and weight" {
  let policy : ImprovementPolicy = {
    objectives: [
      { key: "latency", direction: Minimize, weight: 1.0 },
      { key: "throughput", direction: Maximize, weight: 0.5 },
    ],
    constraints: [],
    min_score_delta: 0.0,
  }
  let snapshot : MetricSnapshot = {
    metrics: { "latency": 100.0, "throughput": 40.0 },
    gates: {},
  }
  let score = score_snapshot(snapshot, policy)
  inspect(score, content="-80")
}

///|
test "run_improvement_loop rejects when ratio constraint fails" {
  let policy : ImprovementPolicy = {
    objectives: [{ key: "latency", direction: Minimize, weight: 1.0 }],
    constraints: [
      { key: "error_rate", comparator: Lte, value: 1.05, source: Ratio },
    ],
    min_score_delta: 0.0,
  }
  let baseline : MetricSnapshot = {
    metrics: { "latency": 100.0, "error_rate": 0.01 },
    gates: {},
  }
  let candidates : Array[ImprovementCandidate[Int]] = [
    { id: "cand-a", input: 1 },
  ]

  let report = run_improvement_loop(baseline, policy, candidates, fn(
    _candidate,
    _context,
  ) {
    Ok({ metrics: { "latency": 90.0, "error_rate": 0.02 }, gates: {} })
  })

  inspect(report.results[0].accepted, content="false")
  inspect(
    report.results[0].reasons.contains("constraint_failed:error_rate"),
    content="true",
  )
}
