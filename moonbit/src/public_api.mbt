///|
/// Public constructors and read accessors for external packages.

///|
pub fn objective(
  key : String,
  direction : MetricDirection,
  weight? : Double = 1.0,
) -> ImprovementObjective {
  { key, direction, weight }
}

///|
pub fn constraint(
  key : String,
  comparator : MetricComparator,
  value : Double,
  source? : ConstraintSource = Absolute,
) -> ImprovementConstraint {
  { key, comparator, value, source }
}

///|
pub fn policy(
  objectives : Array[ImprovementObjective],
  constraints? : Array[ImprovementConstraint] = [],
  min_score_delta? : Double = 0.0,
) -> ImprovementPolicy {
  { objectives, constraints, min_score_delta }
}

///|
pub fn snapshot(
  metrics : Map[String, Double],
  gates? : Map[String, Bool] = {},
) -> MetricSnapshot {
  { metrics, gates }
}

///|
pub fn[T] candidate(id : String, input : T) -> ImprovementCandidate[T] {
  { id, input }
}

///|
pub fn round_summary(
  result_ids : Array[String],
  accepted_count : Int,
) -> RoundSummary {
  { result_ids, accepted_count }
}

///|
pub fn MetricDirection::maximize() -> MetricDirection {
  Maximize
}

///|
pub fn MetricDirection::minimize() -> MetricDirection {
  Minimize
}

///|
pub fn MetricComparator::lt() -> MetricComparator {
  Lt
}

///|
pub fn MetricComparator::lte() -> MetricComparator {
  Lte
}

///|
pub fn MetricComparator::gt() -> MetricComparator {
  Gt
}

///|
pub fn MetricComparator::gte() -> MetricComparator {
  Gte
}

///|
pub fn MetricComparator::eq() -> MetricComparator {
  Eq
}

///|
pub fn ConstraintSource::absolute() -> ConstraintSource {
  Absolute
}

///|
pub fn ConstraintSource::delta() -> ConstraintSource {
  Delta
}

///|
pub fn ConstraintSource::ratio() -> ConstraintSource {
  Ratio
}

///|
pub fn ConstraintSource::delta_ratio() -> ConstraintSource {
  DeltaRatio
}

///|
pub fn MetricSnapshot::metric(self : MetricSnapshot, key : String) -> Double? {
  self.metrics.get(key)
}

///|
pub fn MetricSnapshot::gate(self : MetricSnapshot, key : String) -> Bool? {
  self.gates.get(key)
}

///|
pub fn[T] ImprovementCandidate::id(self : ImprovementCandidate[T]) -> String {
  self.id
}

///|
pub fn[T] ImprovementCandidate::input(self : ImprovementCandidate[T]) -> T {
  self.input
}

///|
pub fn[T] ImprovementResult::is_accepted(self : ImprovementResult[T]) -> Bool {
  self.accepted
}

///|
pub fn[T] ImprovementResult::reasons(
  self : ImprovementResult[T],
) -> Array[String] {
  self.reasons
}

///|
pub fn[T] ImprovementResult::score(self : ImprovementResult[T]) -> Double? {
  self.score
}

///|
pub fn[T] ImprovementResult::snapshot(
  self : ImprovementResult[T],
) -> MetricSnapshot? {
  self.snapshot
}

///|
pub fn[T] ImprovementReport::results(
  self : ImprovementReport[T],
) -> Array[ImprovementResult[T]] {
  self.results
}

///|
pub fn[T] ImprovementReport::best_accepted(
  self : ImprovementReport[T],
) -> ImprovementResult[T]? {
  self.best_accepted
}

///|
pub fn[T, S] LongRunIterationContext::iteration(
  self : LongRunIterationContext[T, S],
) -> Int {
  self.iteration
}

///|
pub fn[T, S] LongRunImprovementReport::final_baseline(
  self : LongRunImprovementReport[T, S],
) -> MetricSnapshot {
  self.final_baseline
}

///|
pub fn[T, S] LongRunImprovementReport::accepted_history_length(
  self : LongRunImprovementReport[T, S],
) -> Int {
  self.accepted_history.length()
}

///|
pub fn ProgramMode::single() -> ProgramMode {
  Single
}

///|
pub fn ProgramMode::long_run() -> ProgramMode {
  LongRun
}

///|
pub fn program_plan(
  mode : ProgramMode,
  candidate_limit : Int,
  max_iterations : Int,
  stop_when_no_accept? : Bool = true,
) -> ProgramPlan {
  { mode, candidate_limit, max_iterations, stop_when_no_accept }
}

///|
pub fn[T, S] ProgramResult::plan(self : ProgramResult[T, S]) -> ProgramPlan {
  self.plan
}

///|
pub fn[T, S] ProgramResult::logs(self : ProgramResult[T, S]) -> Array[String] {
  self.logs
}

///|
pub fn[T, S] ProgramResult::is_single(self : ProgramResult[T, S]) -> Bool {
  match self.run {
    SingleRun(_) => true
    _ => false
  }
}

///|
pub fn[T, S] ProgramResult::is_long_run(self : ProgramResult[T, S]) -> Bool {
  match self.run {
    LongRunRun(_) => true
    _ => false
  }
}

///|
pub fn[T, S] ProgramResult::single(
  self : ProgramResult[T, S],
) -> ImprovementReport[T]? {
  match self.run {
    SingleRun(report) => Some(report)
    _ => None
  }
}

///|
pub fn[T, S] ProgramResult::long_run(
  self : ProgramResult[T, S],
) -> LongRunImprovementReport[T, S]? {
  match self.run {
    LongRunRun(report) => Some(report)
    _ => None
  }
}
