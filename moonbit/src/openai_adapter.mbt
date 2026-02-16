///|
/// OpenAI/LLM provider adapter for RLM runtime.

///|
pub struct RLMOpenAIOptions {
  model : String
  max_tokens : Int
  system_prompt : String
  timeout_sec : Int
  max_retries : Int
}

///|
pub fn default_rlm_openai_options(
  model? : String = "gpt-4.1-mini",
  max_tokens? : Int = 4096,
  system_prompt? : String = "",
  timeout_sec? : Int = 300,
  max_retries? : Int = 3,
) -> RLMOpenAIOptions {
  { model, max_tokens, system_prompt, timeout_sec, max_retries }
}

///|
pub fn run_rlm_with_openai(
  prompt : String,
  api_key : String,
  rlm_options? : RLMRunOptions = default_rlm_options(),
  openai_options? : RLMOpenAIOptions = default_rlm_openai_options(),
) -> Result[RLMResultPack, String] {
  let provider = @llm_openai.OpenAIProvider::new(
    api_key,
    model=openai_options.model,
    max_tokens=openai_options.max_tokens,
    system_prompt=openai_options.system_prompt,
    timeout_sec=openai_options.timeout_sec,
    max_retries=openai_options.max_retries,
  )
  run_rlm_with_provider(prompt, provider, options=rlm_options)
}

///|
pub fn run_rlm_with_provider(
  prompt : String,
  provider : &@llm.Provider,
  options? : RLMRunOptions = default_rlm_options(),
) -> Result[RLMResultPack, String] {
  run_rlm_from_json(
    prompt,
    fn(messages, _depth) {
      let llm_messages = to_llm_messages(messages)
      @llm.collect_text(provider, llm_messages)
    },
    options~,
  )
}

///|
fn to_llm_messages(messages : Array[RLMChatMessage]) -> Array[@llm.Message] {
  let out : Array[@llm.Message] = []
  for message in messages {
    let mapped = match message.role {
      System => @llm.Message::system(message.content)
      User => @llm.Message::user(message.content)
      Assistant => @llm.Message::assistant(message.content)
    }
    out.push(mapped)
  }
  out
}

///|
pub fn default_planner_system_prompt() -> String {
  (
    #|You are an RLM planner.
    #|Convert user input to one JSON plan object.
    #|Output exactly one JSON object and nothing else.
    #|Schema:
    #|{
    #|  "mode": "single" | "long_run",
    #|  "task": string,
    #|  "profile"?: "pure" | "hybrid",
    #|  "symbols"?: string[],
    #|  "budget"?: { "maxSteps"?: number, "maxSubCalls"?: number, "maxDepth"?: number, "maxPromptReadChars"?: number },
    #|  "requirePromptReadBeforeFinalize"?: boolean,
    #|  "longRun"?: {
    #|    "objectives": [{ "key": string, "direction": "minimize"|"maximize", "weight"?: number }],
    #|    "constraints"?: [{ "key": string, "comparator": "lt"|"lte"|"gt"|"gte"|"eq", "value": number, "source"?: "absolute"|"delta"|"ratio"|"delta_ratio" }],
    #|    "maxIterations"?: number,
    #|    "stopWhenNoAccept"?: boolean,
    #|    "minScoreDelta"?: number
    #|  }
    #|}
    #|Use mode=single unless the task explicitly needs iterative metric optimization.
  )
}

///|
pub fn create_plan_with_provider(
  input : String,
  prompt : String,
  provider : &@llm.Provider,
  available_symbols? : Array[String] = [],
  planner_system_prompt? : String = default_planner_system_prompt(),
) -> RLMPlannerPlan {
  let messages : Array[@llm.Message] = [
    @llm.Message::system(planner_system_prompt),
    @llm.Message::user(
      build_planner_request_payload(input, prompt, available_symbols).stringify(),
    ),
  ]
  let text = @llm.collect_text(provider, messages)
  parse_planner_plan_text(text, input, available_symbols)
}

///|
pub fn[T, S] run_planned_rlm_with_provider(
  input : String,
  prompt : String,
  provider : &@llm.Provider,
  available_symbols? : Array[String] = [],
  runtime_options? : RLMRunOptions? = None,
  long_run? : PlannedLongRunHooks[T, S]? = None,
  planner_system_prompt? : String = default_planner_system_prompt(),
) -> Result[PlannedRLMResult[T, S], String] {
  run_planned_rlm_with_providers(
    input,
    prompt,
    provider,
    provider,
    available_symbols~,
    runtime_options~,
    long_run~,
    planner_system_prompt~,
  )
}

///|
pub fn[T, S] run_planned_rlm_with_providers(
  input : String,
  prompt : String,
  planner_provider : &@llm.Provider,
  executor_provider : &@llm.Provider,
  available_symbols? : Array[String] = [],
  runtime_options? : RLMRunOptions? = None,
  long_run? : PlannedLongRunHooks[T, S]? = None,
  planner_system_prompt? : String = default_planner_system_prompt(),
) -> Result[PlannedRLMResult[T, S], String] {
  let plan = create_plan_with_provider(
    input,
    prompt,
    planner_provider,
    available_symbols~,
    planner_system_prompt~,
  )

  match plan.mode {
    Single => {
      let options = compile_plan_to_rlm_options(plan, base=runtime_options)
      match
        run_rlm_from_json(
          prompt,
          fn(messages, _depth) {
            @llm.collect_text(executor_provider, to_llm_messages(messages))
          },
          options~,
        ) {
        Ok(result) => Ok(SingleResult(plan, result))
        Err(message) => Err(message)
      }
    }
    LongRun =>
      run_planned_rlm(
        prompt,
        fn(_messages, _depth) { PromptMeta },
        plan,
        runtime_options~,
        long_run~,
      )
  }
}

///|
pub fn[T, S] run_planned_rlm_with_openai(
  input : String,
  prompt : String,
  api_key : String,
  available_symbols? : Array[String] = [],
  runtime_options? : RLMRunOptions? = None,
  long_run? : PlannedLongRunHooks[T, S]? = None,
  planner_system_prompt? : String = default_planner_system_prompt(),
  planner_openai_options? : RLMOpenAIOptions = default_rlm_openai_options(),
  executor_openai_options? : RLMOpenAIOptions? = None,
) -> Result[PlannedRLMResult[T, S], String] {
  let planner_provider = @llm_openai.OpenAIProvider::new(
    api_key,
    model=planner_openai_options.model,
    max_tokens=planner_openai_options.max_tokens,
    system_prompt=planner_openai_options.system_prompt,
    timeout_sec=planner_openai_options.timeout_sec,
    max_retries=planner_openai_options.max_retries,
  )
  let exec_opts = match executor_openai_options {
    Some(v) => v
    None => planner_openai_options
  }
  let executor_provider = @llm_openai.OpenAIProvider::new(
    api_key,
    model=exec_opts.model,
    max_tokens=exec_opts.max_tokens,
    system_prompt=exec_opts.system_prompt,
    timeout_sec=exec_opts.timeout_sec,
    max_retries=exec_opts.max_retries,
  )
  run_planned_rlm_with_providers(
    input,
    prompt,
    planner_provider,
    executor_provider,
    available_symbols~,
    runtime_options~,
    long_run~,
    planner_system_prompt~,
  )
}

///|
fn parse_planner_plan_text(
  text : String,
  fallback_task : String,
  available_symbols : Array[String],
) -> RLMPlannerPlan {
  let parsed = try? @json.parse(text)
  match parsed {
    Ok(value) =>
      coerce_planner_plan_from_json(value, fallback_task, available_symbols)
    Err(_) =>
      match openai_extract_first_json_object_text(text) {
        Some(object_text) => {
          let nested = try? @json.parse(object_text)
          match nested {
            Ok(value) =>
              coerce_planner_plan_from_json(
                value, fallback_task, available_symbols,
              )
            Err(_) =>
              coerce_planner_plan_from_json(
                Json::null(),
                fallback_task,
                available_symbols,
              )
          }
        }
        None =>
          coerce_planner_plan_from_json(
            Json::null(),
            fallback_task,
            available_symbols,
          )
      }
  }
}

///|
fn build_planner_request_payload(
  input : String,
  prompt : String,
  available_symbols : Array[String],
) -> Json {
  let symbols : Array[Json] = []
  for symbol in available_symbols {
    symbols.push(Json::string(symbol))
  }

  Json::object({
    "kind": Json::string("rlm_plan_request"),
    "input": Json::string(input),
    "prompt": Json::object({
      "length": Json::number(prompt.length().to_double()),
      "preview": Json::string(openai_cut_text(prompt, 200)),
    }),
    "availableSymbols": Json::array(symbols),
  })
}

///|
fn openai_cut_text(value : String, max_chars : Int) -> String {
  if max_chars <= 0 {
    return ""
  }
  let end = openai_min_int(max_chars, value.length())
  if end <= 0 {
    ""
  } else {
    value.unsafe_substring(start=0, end~)
  }
}

///|
fn openai_min_int(a : Int, b : Int) -> Int {
  if a < b {
    a
  } else {
    b
  }
}

///|
fn openai_extract_first_json_object_text(text : String) -> String? {
  let chars = text.to_array()
  let mut start = -1
  let mut depth = 0
  let mut in_string = false
  let mut escaped = false

  for i in 0..<chars.length() {
    let ch = chars[i]

    if start < 0 {
      if ch == '{' {
        start = i
        depth = 1
        in_string = false
        escaped = false
      }
      continue
    }

    if in_string {
      if escaped {
        escaped = false
      } else if ch == '\\' {
        escaped = true
      } else if ch == '"' {
        in_string = false
      }
      continue
    }

    if ch == '"' {
      in_string = true
      continue
    }
    if ch == '{' {
      depth += 1
      continue
    }
    if ch == '}' {
      depth -= 1
      if depth == 0 {
        return Some(text.unsafe_substring(start~, end=i + 1))
      }
    }
  }
  None
}
