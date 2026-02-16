///|
pub struct RLMBudgetPatch {
  max_steps : Int?
  max_sub_calls : Int?
  max_depth : Int?
  max_prompt_read_chars : Int?
}

///|
pub struct PlannerObjectiveSpec {
  key : String
  direction : MetricDirection
  weight : Double
}

///|
pub struct PlannerConstraintSpec {
  key : String
  comparator : MetricComparator
  value : Double
  source : ConstraintSource
}

///|
pub struct PlannerLongRunSpec {
  objectives : Array[PlannerObjectiveSpec]
  constraints : Array[PlannerConstraintSpec]
  max_iterations : Int?
  stop_when_no_accept : Bool?
  min_score_delta : Double?
}

///|
pub struct RLMPlannerPlan {
  kind : String
  version : Int
  mode : ProgramMode
  task : String
  profile : RLMProfile?
  budget : RLMBudgetPatch?
  require_prompt_read_before_finalize : Bool?
  symbols : Array[String]
  long_run : PlannerLongRunSpec?
}

///|
pub struct PlannedLongRunHooks[T, S] {
  baseline : MetricSnapshot
  initial_state : S
  max_iterations : Int?
  stop_when_no_accept : Bool?
  generate_candidates : (LongRunIterationContext[T, S], RLMPlannerPlan) -> Array[
    ImprovementCandidate[T],
  ]
  evaluate : (
    ImprovementCandidate[T],
    LongRunIterationContext[T, S],
    RLMPlannerPlan,
  ) -> Result[MetricSnapshot, String]
  on_accepted : ((ImprovementResult[T], S) -> S)?
}

///|
pub enum PlannedRLMResult[T, S] {
  SingleResult(RLMPlannerPlan, RLMResultPack)
  LongRunResult(RLMPlannerPlan, LongRunImprovementReport[T, S])
}
