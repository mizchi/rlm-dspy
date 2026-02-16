///|
test "run_program long_run mode updates baseline and logs" {
  let p = policy([objective("score", MetricDirection::minimize())])
  let base = snapshot({ "score": 10.0 })
  let pool = [5, 20]
  let plan = program_plan(
    ProgramMode::long_run(),
    2,
    2,
    stop_when_no_accept=true,
  )

  let out = run_program(
    plan,
    base,
    p,
    pool,
    (),
    fn(v) { candidate("cand-\{v}", v) },
    fn(cand, _ctx) { Ok(snapshot({ "score": cand.input().to_double() })) },
    fn(_accepted, state) { state },
    fn(metrics) {
      let score = metrics["score"]
      "score=\{score}"
    },
  )

  inspect(out.is_long_run(), content="true")
  inspect(
    out
    .logs()
    .any(fn(line) { line.contains("best accepted candidate: cand-5") }),
    content="true",
  )

  let final_score = match out.long_run() {
    Some(report) => report.final_baseline().metric("score")
    None => None
  }
  inspect(final_score, content="Some(5)")
}

///|
test "run_program single mode evaluates once" {
  let p = policy([objective("score", MetricDirection::minimize())])
  let base = snapshot({ "score": 10.0 })
  let pool = [5, 20]
  let plan = program_plan(ProgramMode::single(), 1, 3, stop_when_no_accept=true)

  let out = run_program(
    plan,
    base,
    p,
    pool,
    (),
    fn(v) { candidate("cand-\{v}", v) },
    fn(cand, _ctx) { Ok(snapshot({ "score": cand.input().to_double() })) },
    fn(_accepted, state) { state },
    fn(metrics) {
      let score = metrics["score"]
      "score=\{score}"
    },
  )

  inspect(out.is_single(), content="true")
  let result_len = match out.single() {
    Some(report) => report.results().length()
    None => 0
  }
  inspect(result_len, content="1")
  inspect(
    out.logs().any(fn(line) { line.contains("[round 0] candidates=cand-5") }),
    content="true",
  )
}
