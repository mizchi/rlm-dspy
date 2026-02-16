///|
/// Program-level harness that unifies single/long_run execution.

///|
pub fn[TPool, T, S] run_program(
  plan : ProgramPlan,
  baseline : MetricSnapshot,
  policy : ImprovementPolicy,
  pool : Array[TPool],
  initial_state : S,
  to_candidate : (TPool) -> ImprovementCandidate[T],
  evaluate : (ImprovementCandidate[T], LongRunIterationContext[T, S]) -> Result[
    MetricSnapshot,
    String,
  ],
  on_accepted : (ImprovementResult[T], S) -> S,
  format_metrics : (Map[String, Double]) -> String,
) -> ProgramResult[T, S] {
  let logs : Array[String] = []
  logs.push("[baseline] " + format_metrics(baseline.metrics))

  match plan.mode {
    Single => {
      let round_summaries : Array[RoundSummary] = []
      let candidates = select_untried_candidates(
        pool,
        round_summaries,
        plan.candidate_limit,
        to_candidate,
      )
      logs.push("[round 0] candidates=" + candidate_ids(candidates))

      let context : LongRunIterationContext[T, S] = {
        iteration: 0,
        state: initial_state,
        baseline,
        baseline_score: score_snapshot(baseline, policy),
        rounds: [],
        accepted_history: [],
      }
      let report = run_improvement_loop(baseline, policy, candidates, fn(
        candidate,
        _ctx,
      ) {
        evaluate(candidate, context)
      })

      logs.push("completed rounds=1 accepted=\{count_accepted(report.results)}")
      append_round_logs([report], logs, format_metrics)

      let final_baseline = match report.best_accepted {
        Some(best) => {
          logs.push("best accepted candidate: " + best.candidate.id)
          match best.snapshot {
            Some(snapshot) => snapshot
            None => baseline
          }
        }
        None => {
          logs.push("no accepted candidate")
          baseline
        }
      }
      logs.push("final baseline: " + format_metrics(final_baseline.metrics))

      { plan, run: SingleRun(report), logs }
    }
    LongRun => {
      let report = run_long_improvement_loop(
        baseline,
        policy,
        initial_state,
        plan.max_iterations,
        plan.stop_when_no_accept,
        fn(context) {
          let summaries = to_round_summaries(context.rounds)
          let out = select_untried_candidates(
            pool,
            summaries,
            plan.candidate_limit,
            to_candidate,
          )
          logs.push(
            "[round \{context.iteration}] candidates=" + candidate_ids(out),
          )
          out
        },
        evaluate,
        on_accepted,
      )

      logs.push(
        "completed rounds=\{report.rounds.length()} accepted=\{report.accepted_history.length()}",
      )
      append_round_logs(report.rounds, logs, format_metrics)

      if report.accepted_history.length() == 0 {
        logs.push("no accepted candidate")
      } else {
        let last = report.accepted_history[report.accepted_history.length() - 1]
        logs.push("best accepted candidate: " + last.candidate.id)
      }
      logs.push(
        "final baseline: " + format_metrics(report.final_baseline.metrics),
      )

      { plan, run: LongRunRun(report), logs }
    }
  }
}

///|
fn[T] append_round_logs(
  rounds : Array[ImprovementReport[T]],
  logs : Array[String],
  format_metrics : (Map[String, Double]) -> String,
) -> Unit {
  for i in 0..<rounds.length() {
    let round = rounds[i]
    logs.push("- round \{i}")
    for row in round.results {
      let summary = match row.snapshot {
        Some(snapshot) => format_metrics(snapshot.metrics)
        None => "no-snapshot"
      }
      let reasons = row.reasons.join("|")
      let status = if row.accepted { "accepted" } else { "rejected" }
      logs.push(
        "  \{row.candidate.id}: \{status} \{summary} reasons=\{reasons}",
      )
    }
  }
}

///|
fn[T] count_accepted(results : Array[ImprovementResult[T]]) -> Int {
  let mut n = 0
  for row in results {
    if row.accepted {
      n += 1
    }
  }
  n
}

///|
fn[T] candidate_ids(candidates : Array[ImprovementCandidate[T]]) -> String {
  let ids : Array[String] = []
  for candidate in candidates {
    ids.push(candidate.id)
  }
  if ids.length() == 0 {
    "(none)"
  } else {
    ids.join(",")
  }
}

///|
fn[T] to_round_summaries(
  rounds : Array[ImprovementReport[T]],
) -> Array[RoundSummary] {
  let out : Array[RoundSummary] = []
  for round in rounds {
    let ids : Array[String] = []
    let mut accepted_count = 0
    for row in round.results {
      ids.push(row.candidate.id)
      if row.accepted {
        accepted_count += 1
      }
    }
    out.push({ result_ids: ids, accepted_count })
  }
  out
}
