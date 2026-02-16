///|
/// Single-round improvement semantics.

///|
pub fn score_snapshot(
  snapshot : MetricSnapshot,
  policy : ImprovementPolicy,
) -> Double {
  let mut score = 0.0
  for objective in policy.objectives {
    let value = lookup_metric(snapshot.metrics, objective.key)
    let oriented = match objective.direction {
      Maximize => value
      Minimize => -value
    }
    score = score + oriented * objective.weight
  }
  score
}

///|
pub fn[T] run_improvement_loop(
  baseline : MetricSnapshot,
  policy : ImprovementPolicy,
  candidates : Array[ImprovementCandidate[T]],
  evaluate : (ImprovementCandidate[T], ImprovementContext[T]) -> Result[
    MetricSnapshot,
    String,
  ],
  update_baseline_on_accept? : Bool = false,
) -> ImprovementReport[T] {
  let base_score = score_snapshot(baseline, policy)
  let mut current_baseline = baseline
  let mut current_baseline_score = base_score

  let results : Array[ImprovementResult[T]] = []
  let accepted_results : Array[ImprovementResult[T]] = []

  for i in 0..<candidates.length() {
    let candidate = candidates[i]
    let context : ImprovementContext[T] = {
      baseline: current_baseline,
      baseline_score: current_baseline_score,
      accepted: accepted_results,
      index: i,
    }

    match evaluate(candidate, context) {
      Ok(snapshot) => {
        let reasons = validate_snapshot(snapshot, policy, current_baseline)
        let has_invalid = reasons.contains("invalid_snapshot")
        let has_missing = has_missing_metric_reason(reasons)
        let score = if has_invalid || has_missing {
          None
        } else {
          Some(score_snapshot(snapshot, policy))
        }
        let score_delta = match score {
          Some(v) => Some(v - current_baseline_score)
          None => None
        }

        match score_delta {
          Some(v) =>
            if v < policy.min_score_delta {
              reasons.push("score_delta_too_small")
            }
          None => ()
        }

        let accepted = reasons.length() == 0
        let result : ImprovementResult[T] = {
          candidate,
          accepted,
          reasons,
          snapshot: Some(snapshot),
          score,
          score_delta,
          error: None,
        }
        results.push(result)

        if accepted {
          accepted_results.push(result)
          if update_baseline_on_accept {
            current_baseline = snapshot
            current_baseline_score = match score {
              Some(v) => v
              None => current_baseline_score
            }
          }
        }
      }
      Err(message) =>
        results.push({
          candidate,
          accepted: false,
          reasons: ["evaluation_error"],
          snapshot: None,
          score: None,
          score_delta: None,
          error: Some(message),
        })
    }
  }

  let best_accepted = pick_best_accepted(results)
  { policy, baseline, baseline_score: base_score, results, best_accepted }
}

///|
fn lookup_metric(metrics : Map[String, Double], key : String) -> Double {
  match metrics.get(key) {
    Some(v) => v
    None => abort("metric_missing:\{key}")
  }
}

///|
fn validate_snapshot(
  snapshot : MetricSnapshot,
  policy : ImprovementPolicy,
  baseline : MetricSnapshot,
) -> Array[String] {
  let reasons : Array[String] = []
  let mut invalid = false

  for entry in snapshot.metrics.to_array() {
    let key = entry.0
    let value = entry.1
    if !is_finite(value) {
      invalid = true
      reasons.push("invalid_metric:\{key}")
    }
  }

  for objective in policy.objectives {
    match snapshot.metrics.get(objective.key) {
      Some(v) =>
        if !is_finite(v) {
          invalid = true
          reasons.push("metric_missing:\{objective.key}")
        }
      None => {
        invalid = true
        reasons.push("metric_missing:\{objective.key}")
      }
    }
  }

  for constraint in policy.constraints {
    match snapshot.metrics.get(constraint.key) {
      None => {
        invalid = true
        reasons.push("metric_missing:\{constraint.key}")
      }
      Some(metric) =>
        if !is_finite(metric) {
          invalid = true
          reasons.push("metric_missing:\{constraint.key}")
        } else {
          let baseline_value = match baseline.metrics.get(constraint.key) {
            Some(v) => v
            None => 0.0
          }
          match
            to_constraint_target(constraint.source, metric, baseline_value) {
            None => {
              invalid = true
              reasons.push("invalid_constraint_source:\{constraint.key}")
            }
            Some(target) =>
              if !compare_metric(
                  target,
                  constraint.comparator,
                  constraint.value,
                ) {
                reasons.push("constraint_failed:\{constraint.key}")
              }
          }
        }
    }
  }

  for entry in snapshot.gates.to_array() {
    let gate = entry.0
    let passed = entry.1
    if !passed {
      reasons.push("gate_failed:\{gate}")
    }
  }

  if invalid {
    let prefixed : Array[String] = ["invalid_snapshot"]
    for reason in reasons {
      prefixed.push(reason)
    }
    return dedupe_reasons(prefixed)
  }
  dedupe_reasons(reasons)
}

///|
fn has_missing_metric_reason(reasons : Array[String]) -> Bool {
  for reason in reasons {
    if reason.has_prefix("metric_missing:") {
      return true
    }
  }
  false
}

///|
fn compare_metric(
  value : Double,
  comparator : MetricComparator,
  expected : Double,
) -> Bool {
  match comparator {
    Lt => value < expected
    Lte => value <= expected
    Gt => value > expected
    Gte => value >= expected
    Eq => value == expected
  }
}

///|
fn to_constraint_target(
  source : ConstraintSource,
  metric : Double,
  baseline : Double,
) -> Double? {
  match source {
    Absolute => Some(metric)
    Delta => Some(metric - baseline)
    Ratio => if baseline == 0.0 { None } else { Some(metric / baseline) }
    DeltaRatio =>
      if baseline == 0.0 {
        None
      } else {
        Some((metric - baseline) / baseline)
      }
  }
}

///|
fn dedupe_reasons(reasons : Array[String]) -> Array[String] {
  let seen : Map[String, Bool] = {}
  let out : Array[String] = []
  for reason in reasons {
    if !seen.contains(reason) {
      seen.set(reason, true)
      out.push(reason)
    }
  }
  out
}

///|
fn[T] pick_best_accepted(
  results : Array[ImprovementResult[T]],
) -> ImprovementResult[T]? {
  let mut best : ImprovementResult[T]? = None
  let mut best_score = -1.0 / 0.0

  for row in results {
    if !row.accepted {
      continue
    }
    match row.score {
      None => ()
      Some(score) =>
        if score > best_score {
          best_score = score
          best = Some(row)
        }
    }
  }
  best
}

///|
fn is_finite(v : Double) -> Bool {
  !v.is_nan() && !v.is_inf()
}
