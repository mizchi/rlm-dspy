///|
test "select_untried_candidates excludes tried ids" {
  let pool : Array[Int] = [1, 2, 3]
  let rounds : Array[RoundSummary] = [
    { result_ids: ["cand-1"], accepted_count: 0 },
  ]

  let out = select_untried_candidates(pool, rounds, 2, fn(v) {
    { id: "cand-\{v}", input: v }
  })

  inspect(out.map(fn(v) { v.id }).join(","), content="cand-2,cand-3")
}

///|
test "select_untried_candidates returns empty when limit is non-positive" {
  let pool : Array[Int] = [1, 2]
  let rounds : Array[RoundSummary] = []

  let out = select_untried_candidates(pool, rounds, 0, fn(v) {
    { id: "cand-\{v}", input: v }
  })

  inspect(out.length(), content="0")
}

///|
test "create_metric_symbol evaluates metric and reuses cache" {
  let cache : Map[String, Map[String, Double]] = {}
  let mut eval_calls = 0

  let symbol = create_metric_symbol(
    0,
    fn(input) {
      match input {
        Json::Number(v, ..) => Ok(v.to_int())
        _ => Err("candidate must be number")
      }
    },
    fn(candidate) {
      eval_calls += 1
      Ok({ "score": candidate.to_double() + 1.0 })
    },
    fn(metrics, key) {
      match metrics.get(key) {
        Some(v) => Ok(v)
        None => Err("missing_metric")
      }
    },
    cache,
    fn(candidate) { "cand:\{candidate}" },
  )

  let call : RLMExternalSymbolCall = {
    symbol: "metric_symbol",
    prompt: "",
    prompt_id: "p",
    depth: 0,
    args: Some(
      Json::object({
        "metricKey": Json::string("score"),
        "candidate": Json::number(10.0),
      }),
    ),
    input: None,
  }

  let first = match symbol(call) {
    Ok(Json::Number(v, ..)) => v.to_int()
    Ok(_) => -1
    Err(_) => -2
  }
  let second = match symbol(call) {
    Ok(Json::Number(v, ..)) => v.to_int()
    Ok(_) => -1
    Err(_) => -2
  }

  inspect(first, content="11")
  inspect(second, content="11")
  inspect(eval_calls, content="1")
}

///|
test "create_metric_symbol uses baseline input when candidate is omitted" {
  let cache : Map[String, Map[String, Double]] = {}
  let symbol = create_metric_symbol(
    7,
    fn(input) {
      match input {
        Json::Number(v, ..) => Ok(v.to_int())
        _ => Err("candidate must be number")
      }
    },
    fn(candidate) { Ok({ "score": candidate.to_double() }) },
    fn(metrics, key) {
      match metrics.get(key) {
        Some(v) => Ok(v)
        None => Err("missing_metric")
      }
    },
    cache,
    fn(candidate) { "cand:\{candidate}" },
  )

  let call : RLMExternalSymbolCall = {
    symbol: "metric_symbol",
    prompt: "",
    prompt_id: "p",
    depth: 0,
    args: Some(Json::object({ "metricKey": Json::string("score") })),
    input: None,
  }

  let value = match symbol(call) {
    Ok(Json::Number(v, ..)) => v.to_int()
    Ok(_) => -1
    Err(_) => -2
  }
  inspect(value, content="7")
}
