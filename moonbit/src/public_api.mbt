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
pub fn[T, S] objective_metric_symbol(
  key : String,
  direction : MetricDirection,
  read : (ImprovementCandidate[T], Int, S) -> Result[Double, String],
  weight? : Double = 1.0,
) -> ObjectiveMetricSymbol[T, S] {
  { key, direction, weight, read }
}

///|
pub fn[T, S] constraint_metric_symbol(
  key : String,
  comparator : MetricComparator,
  value : Double,
  read : (ImprovementCandidate[T], Int, S) -> Result[Double, String],
  source? : ConstraintSource = Absolute,
) -> ConstraintMetricSymbol[T, S] {
  { key, comparator, value, source, read }
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
pub fn planner_budget_patch(
  max_steps? : Int? = None,
  max_sub_calls? : Int? = None,
  max_depth? : Int? = None,
  max_prompt_read_chars? : Int? = None,
) -> RLMBudgetPatch {
  { max_steps, max_sub_calls, max_depth, max_prompt_read_chars }
}

///|
pub fn planner_objective_spec(
  key : String,
  direction : MetricDirection,
  weight? : Double = 1.0,
) -> PlannerObjectiveSpec {
  { key, direction, weight }
}

///|
pub fn planner_constraint_spec(
  key : String,
  comparator : MetricComparator,
  value : Double,
  source? : ConstraintSource = Absolute,
) -> PlannerConstraintSpec {
  { key, comparator, value, source }
}

///|
pub fn planner_long_run_spec(
  objectives : Array[PlannerObjectiveSpec],
  constraints? : Array[PlannerConstraintSpec] = [],
  max_iterations? : Int? = None,
  stop_when_no_accept? : Bool? = None,
  min_score_delta? : Double? = None,
) -> PlannerLongRunSpec {
  {
    objectives,
    constraints,
    max_iterations,
    stop_when_no_accept,
    min_score_delta,
  }
}

///|
pub fn planner_plan(
  mode : ProgramMode,
  task : String,
  profile? : RLMProfile? = None,
  budget? : RLMBudgetPatch? = None,
  require_prompt_read_before_finalize? : Bool? = None,
  symbols? : Array[String] = [],
  long_run? : PlannerLongRunSpec? = None,
) -> RLMPlannerPlan {
  {
    kind: "rlm_plan",
    version: 1,
    mode,
    task,
    profile,
    budget,
    require_prompt_read_before_finalize,
    symbols,
    long_run,
  }
}

///|
pub fn[T, S] planned_long_run_hooks(
  baseline : MetricSnapshot,
  initial_state : S,
  generate_candidates : (LongRunIterationContext[T, S], RLMPlannerPlan) -> Array[
    ImprovementCandidate[T],
  ],
  evaluate : (
    ImprovementCandidate[T],
    LongRunIterationContext[T, S],
    RLMPlannerPlan,
  ) -> Result[MetricSnapshot, String],
  max_iterations? : Int? = None,
  stop_when_no_accept? : Bool? = None,
  on_accepted? : ((ImprovementResult[T], S) -> S)? = None,
) -> PlannedLongRunHooks[T, S] {
  {
    baseline,
    initial_state,
    max_iterations,
    stop_when_no_accept,
    generate_candidates,
    evaluate,
    on_accepted,
  }
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

///|
pub fn dsl_prompt_meta() -> RLMDSL {
  PromptMeta
}

///|
pub fn dsl_slice_prompt(start : Int, end : Int, out : String) -> RLMDSL {
  SlicePrompt(start, end, out)
}

///|
pub fn dsl_find(
  needle : String,
  from? : Int = 0,
  out? : String = "hits",
) -> RLMDSL {
  Find(needle, from, out)
}

///|
pub fn dsl_chunk_newlines(max_lines : Int, out : String) -> RLMDSL {
  ChunkNewlines(max_lines, out)
}

///|
pub fn dsl_doc_parse(
  format? : String? = None,
  delimiter? : String? = None,
  out? : String = "doc",
) -> RLMDSL {
  DocParse(format, delimiter, out)
}

///|
pub fn dsl_doc_select_section(
  in_key : String,
  title : String,
  out : String,
) -> RLMDSL {
  DocSelectSection(in_key, title, out)
}

///|
pub fn dsl_doc_table_sum(
  in_key : String,
  column : Json,
  out : String,
) -> RLMDSL {
  DocTableSum(in_key, column, out)
}

///|
pub fn dsl_doc_select_rows(
  in_key : String,
  column : Json,
  comparator? : String? = None,
  value? : Json? = None,
  out? : String = "rows",
) -> RLMDSL {
  DocSelectRows(in_key, column, comparator, value, out)
}

///|
pub fn dsl_doc_project_columns(
  in_key : String,
  columns : Array[Json],
  out : String,
  separator? : String? = None,
  include_header? : Bool? = None,
) -> RLMDSL {
  DocProjectColumns(in_key, columns, out, separator, include_header)
}

///|
pub fn dsl_chunk_tokens(
  max_tokens : Int,
  overlap? : Int? = None,
  out? : String = "chunks",
) -> RLMDSL {
  ChunkTokens(max_tokens, overlap, out)
}

///|
pub fn dsl_sum_csv_column(
  column : Int,
  delimiter? : String? = None,
  out? : String = "total",
) -> RLMDSL {
  SumCsvColumn(column, delimiter, out)
}

///|
pub fn dsl_pick_word(index? : Int? = None, out? : String = "picked") -> RLMDSL {
  PickWord(index, out)
}

///|
pub fn dsl_call_symbol(
  symbol : String,
  out : String,
  args? : Json? = None,
  input? : Json? = None,
) -> RLMDSL {
  CallSymbol(symbol, out, args, input)
}

///|
pub fn dsl_sub_map(
  in_key : String,
  query_template : String,
  out : String,
  limit? : Int? = None,
  concurrency? : Int? = None,
) -> RLMDSL {
  SubMap(in_key, query_template, out, limit, concurrency)
}

///|
pub fn dsl_reduce_join(in_key : String, sep : String, out : String) -> RLMDSL {
  ReduceJoin(in_key, sep, out)
}

///|
pub fn dsl_set(path : String, value : Json) -> RLMDSL {
  Set(path, value)
}

///|
pub fn dsl_set_string(path : String, value : String) -> RLMDSL {
  Set(path, Json::string(value))
}

///|
pub fn dsl_finalize(from : String) -> RLMDSL {
  Finalize(from)
}

///|
pub fn RLMResultPack::final_output(self : RLMResultPack) -> String {
  self.final_output
}

///|
pub fn RLMResultPack::trace(self : RLMResultPack) -> Array[RLMTraceEvent] {
  self.trace
}

///|
pub fn RLMResultPack::budget(self : RLMResultPack) -> RLMBudgetState {
  self.budget
}
