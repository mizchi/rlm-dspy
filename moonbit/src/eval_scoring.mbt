///|
pub fn score_answer(
  expected : String,
  answer : String,
  metric : EvalMetric,
) -> Bool {
  let exp = expected.trim().to_string()
  let act = answer.trim().to_string()
  match metric {
    Contains => act.contains(exp)
    Exact => act == exp
  }
}
