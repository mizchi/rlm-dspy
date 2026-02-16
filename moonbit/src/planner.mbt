///|
pub fn coerce_planner_plan_from_json(
  raw : Json,
  fallback_task : String,
  available_symbols : Array[String],
) -> RLMPlannerPlan {
  let row = match raw {
    Json::Object(v) => v
    _ =>
      return planner_make_default_single_plan(fallback_task, available_symbols)
  }

  let task = planner_json_get_string(row, "task").unwrap_or(fallback_task)
  let mode = match planner_json_get_string(row, "mode") {
    Some("long_run") => LongRun
    _ => Single
  }
  let profile = planner_parse_profile(planner_json_get_string(row, "profile"))
  let symbols = match planner_json_get_string_array(row, "symbols") {
    Some(v) =>
      if v.length() > 0 {
        v
      } else {
        planner_copy_strings(available_symbols)
      }
    None => planner_copy_strings(available_symbols)
  }
  let budget = match row.get("budget") {
    Some(Json::Object(v)) => planner_parse_budget_patch(v)
    _ => None
  }
  let require_prompt_read_before_finalize = planner_json_get_bool(
    row, "requirePromptReadBeforeFinalize",
  )
  let long_run = planner_parse_long_run_spec(row.get("longRun"))

  let mut plan : RLMPlannerPlan = {
    kind: "rlm_plan",
    version: 1,
    mode,
    task,
    profile,
    budget,
    require_prompt_read_before_finalize,
    symbols,
    long_run,
  }
  match mode {
    LongRun =>
      match long_run {
        Some(_) => ()
        None => plan = { ..plan, mode: Single }
      }
    Single => ()
  }
  plan
}

///|
pub fn compile_plan_to_rlm_options(
  plan : RLMPlannerPlan,
  base? : RLMRunOptions? = None,
) -> RLMRunOptions {
  let mut out = match plan.profile {
    Some(profile) => build_profile_rlm_options(profile)
    None => default_rlm_options()
  }
  out = { ..out, task: Some(plan.task) }
  match plan.require_prompt_read_before_finalize {
    Some(v) => out = { ..out, require_prompt_read_before_finalize: v }
    None => ()
  }
  match plan.budget {
    Some(patch) =>
      out = { ..out, budget: planner_apply_budget_patch(out.budget, patch) }
    None => ()
  }

  match base {
    Some(v) => {
      let merged_task = match v.task {
        Some(task) => Some(task)
        None => out.task
      }
      {
        budget: v.budget,
        meta_preview_chars: v.meta_preview_chars,
        task: merged_task,
        require_prompt_read_before_finalize: v.require_prompt_read_before_finalize,
        sub_runner: v.sub_runner,
        symbol_runner: v.symbol_runner,
      }
    }
    None => out
  }
}

///|
pub fn[T, S] run_planned_rlm(
  prompt : String,
  complete : (Array[RLMChatMessage], Int) -> RLMDSL,
  plan : RLMPlannerPlan,
  runtime_options? : RLMRunOptions? = None,
  long_run? : PlannedLongRunHooks[T, S]? = None,
) -> Result[PlannedRLMResult[T, S], String] {
  match plan.mode {
    Single =>
      match
        run_rlm(
          prompt,
          complete,
          options=compile_plan_to_rlm_options(plan, base=runtime_options),
        ) {
        Ok(result) => Ok(SingleResult(plan, result))
        Err(message) => Err(message)
      }
    LongRun => {
      let spec = match plan.long_run {
        Some(v) => v
        None => return Err("planner_long_run_requires_spec")
      }
      let hooks = match long_run {
        Some(v) => v
        None => return Err("planner_long_run_requires_hooks")
      }

      let policy = planner_policy_from_long_run_spec(spec)
      let max_iterations = match spec.max_iterations {
        Some(v) => v
        None =>
          match hooks.max_iterations {
            Some(x) => x
            None => 8
          }
      }
      let stop_when_no_accept = match spec.stop_when_no_accept {
        Some(v) => v
        None =>
          match hooks.stop_when_no_accept {
            Some(x) => x
            None => true
          }
      }
      let on_accepted = match hooks.on_accepted {
        Some(fn_) => fn_
        None => fn(_accepted, state) { state }
      }

      let report = run_long_improvement_loop(
        hooks.baseline,
        policy,
        hooks.initial_state,
        max_iterations,
        stop_when_no_accept,
        fn(context) { (hooks.generate_candidates)(context, plan) },
        fn(candidate, context) { (hooks.evaluate)(candidate, context, plan) },
        on_accepted,
      )

      Ok(LongRunResult(plan, report))
    }
  }
}

///|
fn planner_make_default_single_plan(
  task : String,
  available_symbols : Array[String],
) -> RLMPlannerPlan {
  {
    kind: "rlm_plan",
    version: 1,
    mode: Single,
    task,
    profile: None,
    budget: None,
    require_prompt_read_before_finalize: None,
    symbols: planner_copy_strings(available_symbols),
    long_run: None,
  }
}

///|
fn planner_parse_profile(value : String?) -> RLMProfile? {
  match value {
    Some("pure") => Some(Pure)
    Some("hybrid") => Some(Hybrid)
    _ => None
  }
}

///|
fn planner_parse_long_run_spec(input : Json?) -> PlannerLongRunSpec? {
  let row = match input {
    Some(Json::Object(v)) => v
    _ => return None
  }
  let objectives_raw = match row.get("objectives") {
    Some(Json::Array(v)) => v
    _ => return None
  }
  let objectives : Array[PlannerObjectiveSpec] = []
  for item in objectives_raw {
    let object = match item {
      Json::Object(v) => v
      _ => continue
    }
    let key = match planner_json_get_string(object, "key") {
      Some(v) => v
      None => continue
    }
    let direction = match planner_json_get_string(object, "direction") {
      Some("maximize") => Maximize
      Some("minimize") => Minimize
      _ => continue
    }
    let weight = planner_json_get_number(object, "weight").unwrap_or(1.0)
    objectives.push({ key, direction, weight })
  }
  if objectives.length() == 0 {
    return None
  }

  let constraints : Array[PlannerConstraintSpec] = []
  match row.get("constraints") {
    Some(Json::Array(values)) =>
      for item in values {
        let object = match item {
          Json::Object(v) => v
          _ => continue
        }
        let key = match planner_json_get_string(object, "key") {
          Some(v) => v
          None => continue
        }
        let comparator = match planner_json_get_string(object, "comparator") {
          Some("lt") => Lt
          Some("lte") => Lte
          Some("gt") => Gt
          Some("gte") => Gte
          Some("eq") => Eq
          _ => continue
        }
        let value = match planner_json_get_number(object, "value") {
          Some(v) => v
          None => continue
        }
        let source = match planner_json_get_string(object, "source") {
          Some("delta") => Delta
          Some("ratio") => Ratio
          Some("delta_ratio") => DeltaRatio
          _ => Absolute
        }
        constraints.push({ key, comparator, value, source })
      }
    _ => ()
  }

  let max_iterations = match planner_json_get_int(row, "maxIterations") {
    Some(v) => Some(if v <= 0 { 1 } else { v })
    None => None
  }
  let stop_when_no_accept = planner_json_get_bool(row, "stopWhenNoAccept")
  let min_score_delta = planner_json_get_number(row, "minScoreDelta")

  Some({
    objectives,
    constraints,
    max_iterations,
    stop_when_no_accept,
    min_score_delta,
  })
}

///|
fn planner_policy_from_long_run_spec(
  spec : PlannerLongRunSpec,
) -> ImprovementPolicy {
  let objectives : Array[ImprovementObjective] = []
  for row in spec.objectives {
    objectives.push({
      key: row.key,
      direction: row.direction,
      weight: row.weight,
    })
  }

  let constraints : Array[ImprovementConstraint] = []
  for row in spec.constraints {
    constraints.push({
      key: row.key,
      comparator: row.comparator,
      value: row.value,
      source: row.source,
    })
  }

  {
    objectives,
    constraints,
    min_score_delta: spec.min_score_delta.unwrap_or(0.0),
  }
}

///|
fn planner_parse_budget_patch(row : Map[String, Json]) -> RLMBudgetPatch? {
  let max_steps = planner_json_get_int(row, "maxSteps")
  let max_sub_calls = planner_json_get_int(row, "maxSubCalls")
  let max_depth = planner_json_get_int(row, "maxDepth")
  let max_prompt_read_chars = planner_json_get_int(row, "maxPromptReadChars")
  if max_steps == None &&
    max_sub_calls == None &&
    max_depth == None &&
    max_prompt_read_chars == None {
    return None
  }
  Some({ max_steps, max_sub_calls, max_depth, max_prompt_read_chars })
}

///|
fn planner_apply_budget_patch(
  base : RLMBudgetState,
  patch : RLMBudgetPatch,
) -> RLMBudgetState {
  {
    max_steps: patch.max_steps.unwrap_or(base.max_steps),
    max_sub_calls: patch.max_sub_calls.unwrap_or(base.max_sub_calls),
    max_depth: patch.max_depth.unwrap_or(base.max_depth),
    max_prompt_read_chars: patch.max_prompt_read_chars.unwrap_or(
      base.max_prompt_read_chars,
    ),
    steps_used: base.steps_used,
    sub_calls_used: base.sub_calls_used,
    depth: base.depth,
    prompt_read_chars_used: base.prompt_read_chars_used,
  }
}

///|
fn planner_json_get_string(row : Map[String, Json], key : String) -> String? {
  match row.get(key) {
    Some(Json::String(v)) => Some(v)
    _ => None
  }
}

///|
fn planner_json_get_string_array(
  row : Map[String, Json],
  key : String,
) -> Array[String]? {
  match row.get(key) {
    Some(Json::Array(values)) => {
      let out : Array[String] = []
      for value in values {
        match value {
          Json::String(v) => out.push(v)
          _ => ()
        }
      }
      Some(out)
    }
    _ => None
  }
}

///|
fn planner_json_get_bool(row : Map[String, Json], key : String) -> Bool? {
  match row.get(key) {
    Some(Json::True) => Some(true)
    Some(Json::False) => Some(false)
    _ => None
  }
}

///|
fn planner_json_get_number(row : Map[String, Json], key : String) -> Double? {
  match row.get(key) {
    Some(Json::Number(v, ..)) => Some(v)
    _ => None
  }
}

///|
fn planner_json_get_int(row : Map[String, Json], key : String) -> Int? {
  match planner_json_get_number(row, key) {
    Some(v) => Some(v.to_int())
    None => None
  }
}

///|
fn planner_copy_strings(input : Array[String]) -> Array[String] {
  let out : Array[String] = []
  for row in input {
    out.push(row)
  }
  out
}
