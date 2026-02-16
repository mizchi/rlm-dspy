///|
test "public constructors can run improvement loop" {
  let p = policy([objective("latency", MetricDirection::minimize())], constraints=[
    constraint(
      "error_rate",
      MetricComparator::lte(),
      1.1,
      source=ConstraintSource::ratio(),
    ),
  ])
  let base = snapshot({ "latency": 100.0, "error_rate": 0.01 })
  let cands = [candidate("c1", 1)]

  let report = run_improvement_loop(base, p, cands, fn(_cand, _ctx) {
    Ok(snapshot({ "latency": 90.0, "error_rate": 0.009 }))
  })

  inspect(report.results().length(), content="1")
  inspect(report.results()[0].is_accepted(), content="true")
}
