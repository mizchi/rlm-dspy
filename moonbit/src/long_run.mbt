///|
/// Iterative long-run semantics.

///|
pub fn[T, S] build_policy_from_metric_symbols(
  objectives : Array[ObjectiveMetricSymbol[T, S]],
  constraints? : Array[ConstraintMetricSymbol[T, S]] = [],
  min_score_delta? : Double = 0.0,
) -> ImprovementPolicy {
  let built_objectives : Array[ImprovementObjective] = []
  for row in objectives {
    built_objectives.push({
      key: row.key,
      direction: row.direction,
      weight: row.weight,
    })
  }

  let built_constraints : Array[ImprovementConstraint] = []
  for row in constraints {
    built_constraints.push({
      key: row.key,
      comparator: row.comparator,
      value: row.value,
      source: row.source,
    })
  }

  {
    objectives: built_objectives,
    constraints: built_constraints,
    min_score_delta,
  }
}

///|
pub fn[T, S] collect_metric_snapshot_by_symbols(
  candidate : ImprovementCandidate[T],
  iteration : Int,
  state : S,
  objectives : Array[ObjectiveMetricSymbol[T, S]],
  constraints? : Array[ConstraintMetricSymbol[T, S]] = [],
) -> Result[MetricSnapshot, String] {
  let metrics : Map[String, Double] = {}

  for objective in objectives {
    let value = match (objective.read)(candidate, iteration, state) {
      Ok(v) => v
      Err(message) => return Err(message)
    }
    metrics.set(objective.key, value)
  }

  for constraint in constraints {
    let value = match (constraint.read)(candidate, iteration, state) {
      Ok(v) => v
      Err(message) => return Err(message)
    }
    metrics.set(constraint.key, value)
  }

  Ok({ metrics, gates: {} })
}

///|
pub fn[T, S] run_long_improvement_loop(
  baseline : MetricSnapshot,
  policy : ImprovementPolicy,
  initial_state : S,
  max_iterations : Int,
  stop_when_no_accept : Bool,
  generate_candidates : (LongRunIterationContext[T, S]) -> Array[
    ImprovementCandidate[T],
  ],
  evaluate : (ImprovementCandidate[T], LongRunIterationContext[T, S]) -> Result[
    MetricSnapshot,
    String,
  ],
  on_accepted : (ImprovementResult[T], S) -> S,
) -> LongRunImprovementReport[T, S] {
  let mut current_baseline = baseline
  let mut current_baseline_score = score_snapshot(baseline, policy)
  let mut current_state = initial_state

  let rounds : Array[ImprovementReport[T]] = []
  let accepted_history : Array[ImprovementResult[T]] = []

  let upper = if max_iterations < 0 { 0 } else { max_iterations }
  for iteration in 0..<upper {
    let context : LongRunIterationContext[T, S] = {
      iteration,
      state: current_state,
      baseline: current_baseline,
      baseline_score: current_baseline_score,
      rounds,
      accepted_history,
    }
    let candidates = generate_candidates(context)
    if candidates.length() == 0 {
      break
    }

    let round = run_improvement_loop(current_baseline, policy, candidates, fn(
      candidate,
      _ctx,
    ) {
      evaluate(candidate, context)
    })
    rounds.push(round)

    for row in round.results {
      if row.accepted {
        accepted_history.push(row)
      }
    }

    match round.best_accepted {
      Some(best) =>
        match best.snapshot {
          Some(snapshot) => {
            current_baseline = snapshot
            current_baseline_score = match best.score {
              Some(v) => v
              None => score_snapshot(snapshot, policy)
            }
            current_state = on_accepted(best, current_state)
          }
          None => ()
        }
      None => if stop_when_no_accept { break }
    }
  }

  {
    rounds,
    accepted_history,
    final_baseline: current_baseline,
    final_baseline_score: current_baseline_score,
    final_state: current_state,
  }
}
