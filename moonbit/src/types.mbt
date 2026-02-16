///|
/// Core semantics for metric-driven improvement loops.

///|
pub enum MetricDirection {
  Maximize
  Minimize
}

///|
pub enum MetricComparator {
  Lt
  Lte
  Gt
  Gte
  Eq
}

///|
pub enum ConstraintSource {
  Absolute
  Delta
  Ratio
  DeltaRatio
}

///|
pub struct ImprovementObjective {
  key : String
  direction : MetricDirection
  weight : Double
}

///|
pub struct ImprovementConstraint {
  key : String
  comparator : MetricComparator
  value : Double
  source : ConstraintSource
}

///|
pub struct ImprovementPolicy {
  objectives : Array[ImprovementObjective]
  constraints : Array[ImprovementConstraint]
  min_score_delta : Double
}

///|
pub struct MetricSnapshot {
  metrics : Map[String, Double]
  gates : Map[String, Bool]
}

///|
pub struct ImprovementCandidate[T] {
  id : String
  input : T
}

///|
pub struct ImprovementContext[T] {
  baseline : MetricSnapshot
  baseline_score : Double
  accepted : Array[ImprovementResult[T]]
  index : Int
}

///|
pub struct ImprovementResult[T] {
  candidate : ImprovementCandidate[T]
  accepted : Bool
  reasons : Array[String]
  snapshot : MetricSnapshot?
  score : Double?
  score_delta : Double?
  error : String?
}

///|
pub struct ImprovementReport[T] {
  policy : ImprovementPolicy
  baseline : MetricSnapshot
  baseline_score : Double
  results : Array[ImprovementResult[T]]
  best_accepted : ImprovementResult[T]?
}

///|
pub struct LongRunIterationContext[T, S] {
  iteration : Int
  state : S
  baseline : MetricSnapshot
  baseline_score : Double
  rounds : Array[ImprovementReport[T]]
  accepted_history : Array[ImprovementResult[T]]
}

///|
pub struct LongRunImprovementReport[T, S] {
  rounds : Array[ImprovementReport[T]]
  accepted_history : Array[ImprovementResult[T]]
  final_baseline : MetricSnapshot
  final_baseline_score : Double
  final_state : S
}

///|
pub struct RoundSummary {
  result_ids : Array[String]
  accepted_count : Int
}

///|
pub enum ProgramMode {
  Single
  LongRun
}

///|
pub struct ProgramPlan {
  mode : ProgramMode
  candidate_limit : Int
  max_iterations : Int
  stop_when_no_accept : Bool
}

///|
pub enum ProgramRun[T, S] {
  SingleRun(ImprovementReport[T])
  LongRunRun(LongRunImprovementReport[T, S])
}

///|
pub struct ProgramResult[T, S] {
  plan : ProgramPlan
  run : ProgramRun[T, S]
  logs : Array[String]
}
