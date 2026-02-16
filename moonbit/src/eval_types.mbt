///|
pub enum EvalMetric {
  Exact
  Contains
}

///|
pub struct EvalBudgetPatch {
  max_steps : Int?
  max_sub_calls : Int?
  max_depth : Int?
  max_prompt_read_chars : Int?
}

///|
pub struct EvalCase {
  id : String
  prompt : String
  query : String
  expected : String
  metric : EvalMetric
  tags : Array[String]
  budget : EvalBudgetPatch?
}

///|
pub enum RLMProfile {
  Pure
  Hybrid
}
