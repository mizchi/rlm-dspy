///|
test "coerce_planner_plan_from_json parses long_run fields" {
  let raw = Json::object({
    "mode": Json::string("long_run"),
    "task": Json::string("optimize"),
    "profile": Json::string("hybrid"),
    "budget": Json::object({ "maxSteps": Json::number(9.0) }),
    "symbols": Json::array([Json::string("metric_symbol")]),
    "longRun": Json::object({
      "objectives": Json::array([
        Json::object({
          "key": Json::string("latency"),
          "direction": Json::string("minimize"),
          "weight": Json::number(2.0),
        }),
      ]),
      "constraints": Json::array([
        Json::object({
          "key": Json::string("errors"),
          "comparator": Json::string("eq"),
          "value": Json::number(0.0),
        }),
      ]),
      "maxIterations": Json::number(3.0),
      "stopWhenNoAccept": Json::boolean(true),
      "minScoreDelta": Json::number(1.0),
    }),
  })

  let plan = coerce_planner_plan_from_json(raw, "fallback", [])
  inspect(
    match plan.mode {
      LongRun => true
      _ => false
    },
    content="true",
  )
  inspect(plan.task, content="optimize")
  inspect(plan.symbols.join(","), content="metric_symbol")
  inspect(
    match plan.long_run {
      Some(_) => true
      None => false
    },
    content="true",
  )
}

///|
test "compile_plan_to_rlm_options merges task and budget patch" {
  let plan : RLMPlannerPlan = {
    kind: "rlm_plan",
    version: 1,
    mode: Single,
    task: "find token",
    profile: Some(Pure),
    budget: Some({
      max_steps: Some(9),
      max_sub_calls: None,
      max_depth: None,
      max_prompt_read_chars: None,
    }),
    require_prompt_read_before_finalize: Some(false),
    symbols: [],
    long_run: None,
  }
  let opts = compile_plan_to_rlm_options(plan)
  inspect(opts.task, content="Some(\"find token\")")
  inspect(opts.budget.max_steps, content="9")
  inspect(opts.require_prompt_read_before_finalize, content="false")
}

///|
test "run_planned_rlm runs single mode with compiled options" {
  let plan : RLMPlannerPlan = {
    kind: "rlm_plan",
    version: 1,
    mode: Single,
    task: "task",
    profile: Some(Hybrid),
    budget: None,
    require_prompt_read_before_finalize: Some(false),
    symbols: [],
    long_run: None,
  }

  let scripts : Array[RLMDSL] = [
    Set("scratch.answer", Json::string("ok")),
    Finalize("answer"),
  ]
  let mut cursor = 0
  let out : Result[PlannedRLMResult[Unit, Unit], String] = run_planned_rlm(
    "prompt",
    fn(_messages, _depth) {
      let picked = if cursor < scripts.length() {
        scripts[cursor]
      } else {
        scripts[scripts.length() - 1]
      }
      cursor += 1
      picked
    },
    plan,
  )

  let summary = match out {
    Ok(SingleResult(_plan, result)) => result.final_output
    _ => "ng"
  }
  inspect(summary, content="ok")
}

///|
test "run_planned_rlm runs long_run mode with hooks" {
  let long_run : PlannerLongRunSpec = {
    objectives: [{ key: "score", direction: Minimize, weight: 1.0 }],
    constraints: [],
    max_iterations: Some(2),
    stop_when_no_accept: Some(true),
    min_score_delta: Some(0.0),
  }
  let plan : RLMPlannerPlan = {
    kind: "rlm_plan",
    version: 1,
    mode: LongRun,
    task: "task",
    profile: None,
    budget: None,
    require_prompt_read_before_finalize: None,
    symbols: [],
    long_run: Some(long_run),
  }

  let hooks : PlannedLongRunHooks[Int, Int] = {
    baseline: snapshot({ "score": 10.0 }),
    initial_state: 0,
    max_iterations: Some(3),
    stop_when_no_accept: Some(true),
    generate_candidates: fn(context, _plan) {
      if context.iteration == 0 {
        [{ id: "cand-5", input: 5 }]
      } else {
        []
      }
    },
    evaluate: fn(candidate, _context, _plan) {
      Ok(snapshot({ "score": candidate.input.to_double() }))
    },
    on_accepted: Some(fn(_accepted, state) { state + 1 }),
  }

  let out = run_planned_rlm(
    "prompt",
    fn(_messages, _depth) { PromptMeta },
    plan,
    long_run=Some(hooks),
  )
  let summary = match out {
    Ok(LongRunResult(_plan, report)) => report.final_baseline.metric("score")
    _ => None
  }
  inspect(summary, content="Some(5)")
}
