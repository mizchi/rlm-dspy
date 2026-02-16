///|
/// Core types for MoonBit RLM runtime.

///|
pub enum RLMRole {
  System
  User
  Assistant
}

///|
pub struct RLMChatMessage {
  role : RLMRole
  content : String
}

///|
pub struct RLMBudgetState {
  max_steps : Int
  max_sub_calls : Int
  max_depth : Int
  max_prompt_read_chars : Int
  steps_used : Int
  sub_calls_used : Int
  depth : Int
  prompt_read_chars_used : Int
}

///|
pub struct RLMPromptMeta {
  prompt_id : String
  length : Int
  preview_head : String
}

///|
pub struct RLMStdoutMeta {
  length : Int
  preview : String
  keys : Array[String]
}

///|
pub struct RLMRootStepTrace {
  step : Int
  prompt_meta : RLMPromptMeta
  stdout_meta : RLMStdoutMeta
}

///|
pub struct RLMReplExecTrace {
  step : Int
  op : String
  stdout : String
  stdout_meta : RLMStdoutMeta
}

///|
pub struct RLMSubCallTrace {
  depth : Int
  query : String
  result_meta : RLMStdoutMeta
  cached : Bool
}

///|
pub enum RLMTraceEvent {
  RootStep(RLMRootStepTrace)
  ReplExec(RLMReplExecTrace)
  SubCall(RLMSubCallTrace)
}

///|
pub enum RLMDSL {
  PromptMeta
  DocParse(String?, String?, String)
  DocSelectSection(String, String, String)
  DocTableSum(String, Json, String)
  DocSelectRows(String, Json, String?, Json?, String)
  DocProjectColumns(String, Array[Json], String, String?, Bool?)
  SlicePrompt(Int, Int, String)
  Find(String, Int, String)
  ChunkNewlines(Int, String)
  ChunkTokens(Int, Int?, String)
  SumCsvColumn(Int, String?, String)
  PickWord(Int?, String)
  CallSymbol(String, String, Json?, Json?)
  SubMap(String, String, String, Int?, Int?)
  ReduceJoin(String, String, String)
  Set(String, Json)
  Finalize(String)
}

///|
pub struct RLMExternalSymbolCall {
  symbol : String
  prompt : String
  prompt_id : String
  depth : Int
  args : Json?
  input : Json?
}

///|
pub struct RLMRunOptions {
  budget : RLMBudgetState
  meta_preview_chars : Int
  task : String?
  require_prompt_read_before_finalize : Bool
  sub_runner : ((String) -> Result[String, String])?
  symbol_runner : ((RLMExternalSymbolCall) -> Result[Json, String])?
}

///|
pub struct RLMResultPack {
  final_output : String
  trace : Array[RLMTraceEvent]
  budget : RLMBudgetState
}

///|
pub fn default_rlm_budget(
  max_steps? : Int = 32,
  max_sub_calls? : Int = 32,
  max_depth? : Int = 4,
  max_prompt_read_chars? : Int = 200000,
  depth? : Int = 0,
) -> RLMBudgetState {
  {
    max_steps,
    max_sub_calls,
    max_depth,
    max_prompt_read_chars,
    steps_used: 0,
    sub_calls_used: 0,
    depth,
    prompt_read_chars_used: 0,
  }
}

///|
pub fn default_rlm_options(
  budget? : RLMBudgetState = default_rlm_budget(),
  meta_preview_chars? : Int = 200,
  task? : String? = None,
  require_prompt_read_before_finalize? : Bool = false,
  sub_runner? : ((String) -> Result[String, String])? = None,
  symbol_runner? : ((RLMExternalSymbolCall) -> Result[Json, String])? = None,
) -> RLMRunOptions {
  {
    budget,
    meta_preview_chars,
    task,
    require_prompt_read_before_finalize,
    sub_runner,
    symbol_runner,
  }
}
