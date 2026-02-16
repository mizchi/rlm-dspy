///|
priv struct DummyProvider {
  responses : Array[String]
  mut cursor : Int
}

///|
impl @llm.Provider for DummyProvider with stream(
  self,
  _messages,
  _tools,
  handler,
) {
  if self.cursor < self.responses.length() {
    let text = self.responses[self.cursor]
    self.cursor += 1
    (handler.on_event)(@llm.StreamEvent::TextDelta(text))
    (handler.on_event)(
      @llm.StreamEvent::MessageEnd(
        finish_reason=@llm.FinishReason::Stop,
        usage=None,
      ),
    )
  }
}

///|
impl @llm.Provider for DummyProvider with name(_self) -> String {
  "dummy"
}

///|
test "run_rlm_with_provider can execute JSON DSL loop" {
  let provider : DummyProvider = {
    responses: [
      "{\"op\":\"set\",\"path\":\"scratch.answer\",\"value\":\"ok\"}", "{\"op\":\"finalize\",\"from\":\"answer\"}",
    ],
    cursor: 0,
  }

  let out = run_rlm_with_provider("prompt", provider)
  let summary = match out {
    Ok(v) => "ok:\{v.final_output}"
    Err(err) => "err:\{err}"
  }
  inspect(summary, content="ok:ok")
}

///|
test "to_llm_messages maps all roles" {
  let messages : Array[RLMChatMessage] = [
    { role: System, content: "sys" },
    { role: User, content: "usr" },
    { role: Assistant, content: "asst" },
  ]
  let out = to_llm_messages(messages)
  let roles : Array[String] = []
  let texts : Array[String] = []
  for msg in out {
    let json = msg.to_openai_json()
    roles.push(@llm.json_get_string(json, "role").unwrap_or(""))
    texts.push(msg.get_text())
  }
  inspect(roles.join(","), content="system,user,assistant")
  inspect(texts.join(","), content="sys,usr,asst")
}

///|
test "create_plan_with_provider parses noisy JSON plan text" {
  let provider : DummyProvider = {
    responses: [
      "plan => {\"mode\":\"single\",\"task\":\"extract\",\"symbols\":[\"metric_symbol\"]}",
    ],
    cursor: 0,
  }
  let plan = create_plan_with_provider("fallback", "prompt", provider, available_symbols=[
    "metric_symbol",
  ])
  inspect(
    match plan.mode {
      Single => true
      _ => false
    },
    content="true",
  )
  inspect(plan.task, content="extract")
  inspect(plan.symbols.join(","), content="metric_symbol")
}

///|
test "run_planned_rlm_with_provider runs single mode end-to-end" {
  let provider : DummyProvider = {
    responses: [
      "{\"mode\":\"single\",\"task\":\"do\"}", "{\"op\":\"set\",\"path\":\"scratch.answer\",\"value\":\"ok\"}",
      "{\"op\":\"finalize\",\"from\":\"answer\"}",
    ],
    cursor: 0,
  }

  let out : Result[PlannedRLMResult[Unit, Unit], String] = run_planned_rlm_with_provider(
    "do", "prompt", provider,
  )
  let summary = match out {
    Ok(SingleResult(plan, result)) => "ok:\{plan.task}:\{result.final_output}"
    Ok(_) => "err:unexpected_mode"
    Err(err) => "err:\{err}"
  }
  inspect(summary, content="ok:do:ok")
}

///|
test "run_planned_rlm_with_provider runs long_run mode with hooks" {
  let provider : DummyProvider = {
    responses: [
      "{\"mode\":\"long_run\",\"task\":\"opt\",\"longRun\":{\"objectives\":[{\"key\":\"score\",\"direction\":\"minimize\"}],\"maxIterations\":2}}",
    ],
    cursor: 0,
  }

  let hooks : PlannedLongRunHooks[Int, Int] = {
    baseline: snapshot({ "score": 10.0 }),
    initial_state: 0,
    max_iterations: Some(3),
    stop_when_no_accept: Some(true),
    generate_candidates: fn(context, _plan) {
      if context.iteration == 0 {
        [{ id: "cand-5", input: 5 }]
      } else {
        []
      }
    },
    evaluate: fn(candidate, _context, _plan) {
      Ok(snapshot({ "score": candidate.input.to_double() }))
    },
    on_accepted: Some(fn(_accepted, state) { state + 1 }),
  }

  let out : Result[PlannedRLMResult[Int, Int], String] = run_planned_rlm_with_provider(
    "opt",
    "prompt",
    provider,
    long_run=Some(hooks),
  )
  let summary = match out {
    Ok(LongRunResult(plan, report)) => {
      let score = report.final_baseline.metric("score")
      "ok:\{plan.task}:\{score}"
    }
    Ok(_) => "err:unexpected_mode"
    Err(err) => "err:\{err}"
  }
  inspect(summary, content="ok:opt:Some(5)")
}
