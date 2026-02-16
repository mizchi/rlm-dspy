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
