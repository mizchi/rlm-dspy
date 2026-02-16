///|
/// Shared candidate selection helper.

///|
pub fn[T, U] select_untried_candidates(
  pool : Array[T],
  rounds : Array[RoundSummary],
  candidate_limit : Int,
  to_candidate : (T) -> ImprovementCandidate[U],
) -> Array[ImprovementCandidate[U]] {
  if candidate_limit <= 0 {
    return []
  }

  let tried : Map[String, Bool] = {}
  for round in rounds {
    for id in round.result_ids {
      tried.set(id, true)
    }
  }

  let out : Array[ImprovementCandidate[U]] = []
  for item in pool {
    let candidate = to_candidate(item)
    if tried.contains(candidate.id) {
      continue
    }
    out.push(candidate)
    if out.length() >= candidate_limit {
      break
    }
  }
  out
}

///|
pub fn[T, TMetrics] create_metric_symbol(
  baseline_input : T,
  coerce_candidate : (Json) -> Result[T, String],
  evaluate_candidate : (T) -> Result[TMetrics, String],
  pick_metric : (TMetrics, String) -> Result[Double, String],
  cache : Map[String, TMetrics],
  cache_key : (T) -> String,
) -> (RLMExternalSymbolCall) -> Result[Json, String] {
  fn(call) {
    let args_row = harness_json_object_or_empty(call.args)
    let metric_key = match harness_json_get_string(args_row, "metricKey") {
      Some(v) => v
      None => return Err("metricKey must be string")
    }

    let candidate = match args_row.get("candidate") {
      Some(v) =>
        match coerce_candidate(v) {
          Ok(parsed) => parsed
          Err(message) => return Err(message)
        }
      None =>
        match call.input {
          Some(v) =>
            match coerce_candidate(v) {
              Ok(parsed) => parsed
              Err(message) => return Err(message)
            }
          None => baseline_input
        }
    }

    let key = cache_key(candidate)
    let metrics = match cache.get(key) {
      Some(v) => v
      None => {
        let computed = match evaluate_candidate(candidate) {
          Ok(v) => v
          Err(message) => return Err(message)
        }
        cache.set(key, computed)
        computed
      }
    }

    let value = match pick_metric(metrics, metric_key) {
      Ok(v) => v
      Err(message) => return Err(message)
    }
    Ok(Json::number(value))
  }
}

///|
fn harness_json_object_or_empty(input : Json?) -> Map[String, Json] {
  match input {
    Some(Json::Object(v)) => v
    _ => {}
  }
}

///|
fn harness_json_get_string(row : Map[String, Json], key : String) -> String? {
  match row.get(key) {
    Some(Json::String(v)) => Some(v)
    _ => None
  }
}
