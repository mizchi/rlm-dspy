///|
test "run_rlm does not place prompt body in history" {
  let prompt = "SECRET-LONG-PROMPT-1234567890"
  let scripts : Array[RLMDSL] = [
    Set("scratch.answer", Json::string("ok")),
    Finalize("answer"),
  ]
  let mut cursor = 0
  let calls : Array[Array[RLMChatMessage]] = []

  let out = run_rlm(prompt, fn(messages, _depth) {
    let snap : Array[RLMChatMessage] = []
    for row in messages {
      snap.push(row)
    }
    calls.push(snap)

    let picked = if cursor < scripts.length() {
      scripts[cursor]
    } else {
      scripts[scripts.length() - 1]
    }
    cursor += 1
    picked
  })

  let final_output = match out {
    Ok(res) => res.final_output
    Err(err) => abort(err)
  }
  inspect(final_output, content="ok")

  let mut leaked = false
  for call in calls {
    for message in call {
      if message.content.contains(prompt) {
        leaked = true
      }
    }
  }
  inspect(leaked, content="false")
}

///|
test "run_rlm returns budget exceeded when max steps is reached" {
  let out = run_rlm(
    "p",
    fn(_messages, _depth) { Set("scratch.tmp", Json::string("x")) },
    options=default_rlm_options(budget=default_rlm_budget(max_steps=2)),
  )

  let is_budget = match out {
    Ok(_) => false
    Err(message) => message == "budget_exceeded:max_steps"
  }
  inspect(is_budget, content="true")
}

///|
test "run_rlm sub_map uses cache for duplicate queries" {
  let prompt = "dup\ndup"
  let scripts : Array[RLMDSL] = [
    ChunkNewlines(1, "chunks"),
    SubMap("chunks", "sum: {{item}}", "parts", None, None),
    ReduceJoin("parts", "|", "joined"),
    Finalize("joined"),
  ]
  let mut cursor = 0
  let sub_queries : Array[String] = []

  let out = run_rlm(
    prompt,
    fn(_messages, _depth) {
      let picked = if cursor < scripts.length() {
        scripts[cursor]
      } else {
        scripts[scripts.length() - 1]
      }
      cursor += 1
      picked
    },
    options=default_rlm_options(
      sub_runner=Some(fn(query) {
        sub_queries.push(query)
        Ok("sub")
      }),
    ),
  )

  let final_output = match out {
    Ok(res) => res.final_output
    Err(err) => abort(err)
  }
  inspect(final_output, content="sub|sub")
  inspect(sub_queries.length(), content="1")
}

///|
test "run_rlm returns budget exceeded when max sub calls is reached" {
  let prompt = "a\nb"
  let scripts : Array[RLMDSL] = [
    ChunkNewlines(1, "chunks"),
    SubMap("chunks", "sum: {{item}}", "parts", None, None),
  ]
  let mut cursor = 0

  let out = run_rlm(
    prompt,
    fn(_messages, _depth) {
      let picked = if cursor < scripts.length() {
        scripts[cursor]
      } else {
        scripts[scripts.length() - 1]
      }
      cursor += 1
      picked
    },
    options=default_rlm_options(
      budget=default_rlm_budget(max_steps=4, max_sub_calls=1),
      sub_runner=Some(fn(_query) { Ok("sub") }),
    ),
  )

  let is_budget = match out {
    Ok(_) => false
    Err(message) => message == "budget_exceeded:max_steps"
  }
  inspect(is_budget, content="true")
}

///|
test "run_rlm supports doc_parse and doc_table_sum" {
  let prompt = "name,score\nalice,3\nbob,5"
  let scripts : Array[RLMDSL] = [
    DocParse(Some("csv"), None, "doc"),
    DocTableSum("doc", Json::string("score"), "answer"),
    Finalize("answer"),
  ]
  let mut cursor = 0

  let out = run_rlm(prompt, fn(_messages, _depth) {
    let picked = if cursor < scripts.length() {
      scripts[cursor]
    } else {
      scripts[scripts.length() - 1]
    }
    cursor += 1
    picked
  })

  let final_output = match out {
    Ok(res) => res.final_output
    Err(err) => abort(err)
  }
  inspect(final_output, content="8")
}

///|
test "run_rlm supports doc_select_rows and doc_project_columns" {
  let prompt = "name,score,team\nalice,3,a\nbob,5,b\nalice,7,c"
  let scripts : Array[RLMDSL] = [
    DocParse(Some("csv"), None, "doc"),
    DocSelectRows(
      "doc",
      Json::string("name"),
      Some("eq"),
      Some(Json::string("alice")),
      "rows",
    ),
    DocProjectColumns("rows", [Json::string("score")], "scores", None, None),
    ReduceJoin("scores", "|", "answer"),
    Finalize("answer"),
  ]
  let mut cursor = 0

  let out = run_rlm(prompt, fn(_messages, _depth) {
    let picked = if cursor < scripts.length() {
      scripts[cursor]
    } else {
      scripts[scripts.length() - 1]
    }
    cursor += 1
    picked
  })

  let final_output = match out {
    Ok(res) => res.final_output
    Err(err) => abort(err)
  }
  inspect(final_output, content="3|7")
}

///|
test "run_rlm supports sum_csv_column op" {
  let prompt = "name,score\nalice,3\nbob,5"
  let scripts : Array[RLMDSL] = [
    SumCsvColumn(1, Some(","), "total"),
    Finalize("total"),
  ]
  let mut cursor = 0

  let out = run_rlm(prompt, fn(_messages, _depth) {
    let picked = if cursor < scripts.length() {
      scripts[cursor]
    } else {
      scripts[scripts.length() - 1]
    }
    cursor += 1
    picked
  })

  let final_output = match out {
    Ok(res) => res.final_output
    Err(err) => abort(err)
  }
  inspect(final_output, content="8")
}

///|
test "run_rlm supports pick_word op" {
  let prompt = "alpha beta gamma"
  let scripts : Array[RLMDSL] = [
    PickWord(Some(1), "picked"),
    Finalize("picked"),
  ]
  let mut cursor = 0

  let out = run_rlm(prompt, fn(_messages, _depth) {
    let picked = if cursor < scripts.length() {
      scripts[cursor]
    } else {
      scripts[scripts.length() - 1]
    }
    cursor += 1
    picked
  })

  let final_output = match out {
    Ok(res) => res.final_output
    Err(err) => abort(err)
  }
  inspect(final_output, content="beta")
}

///|
test "run_rlm supports call_symbol op" {
  let scripts : Array[RLMDSL] = [
    CallSymbol(
      "score_symbol",
      "answer",
      Some(Json::object({ "x": Json::number(1) })),
      None,
    ),
    Finalize("answer"),
  ]
  let mut cursor = 0
  let calls : Array[String] = []

  let out = run_rlm(
    "p",
    fn(_messages, _depth) {
      let picked = if cursor < scripts.length() {
        scripts[cursor]
      } else {
        scripts[scripts.length() - 1]
      }
      cursor += 1
      picked
    },
    options=default_rlm_options(
      symbol_runner=Some(fn(call) {
        calls.push(call.symbol)
        Ok(Json::string("42"))
      }),
    ),
  )

  let final_output = match out {
    Ok(res) => res.final_output
    Err(err) => abort(err)
  }
  inspect(final_output, content="42")
  inspect(calls.join(","), content="score_symbol")
}

///|
test "run_rlm requires prompt read before finalize when option is enabled" {
  let scripts : Array[RLMDSL] = [
    Set("scratch.answer", Json::string("ok")),
    Finalize("answer"),
  ]
  let mut cursor = 0
  let out = run_rlm(
    "p",
    fn(_messages, _depth) {
      let picked = if cursor < scripts.length() {
        scripts[cursor]
      } else {
        scripts[scripts.length() - 1]
      }
      cursor += 1
      picked
    },
    options=default_rlm_options(require_prompt_read_before_finalize=true),
  )

  let is_budget = match out {
    Ok(_) => false
    Err(message) => message == "budget_exceeded:max_steps"
  }
  inspect(is_budget, content="true")
}

///|
test "run_rlm_from_json can execute set/finalize flow" {
  let scripts = [
    "{\"op\":\"set\",\"path\":\"scratch.answer\",\"value\":\"ok\"}", "{\"op\":\"finalize\",\"from\":\"answer\"}",
  ]
  let mut cursor = 0
  let out = run_rlm_from_json("p", fn(_messages, _depth) {
    let picked = if cursor < scripts.length() {
      scripts[cursor]
    } else {
      scripts[scripts.length() - 1]
    }
    cursor += 1
    picked
  })

  let final_output = match out {
    Ok(res) => res.final_output
    Err(err) => abort(err)
  }
  inspect(final_output, content="ok")
}

///|
test "run_rlm_from_json can parse doc ops" {
  let scripts = [
    "{\"op\":\"doc_parse\",\"format\":\"csv\",\"out\":\"doc\"}", "{\"op\":\"doc_table_sum\",\"in\":\"doc\",\"column\":\"score\",\"out\":\"answer\"}",
    "{\"op\":\"finalize\",\"from\":\"answer\"}",
  ]
  let prompt =
    #|name,score
    #|alice,3
    #|bob,5
  let mut cursor = 0
  let out = run_rlm_from_json(prompt, fn(_messages, _depth) {
    let picked = if cursor < scripts.length() {
      scripts[cursor]
    } else {
      scripts[scripts.length() - 1]
    }
    cursor += 1
    picked
  })

  let summary = match out {
    Ok(res) => "ok:\{res.final_output}"
    Err(err) => "err:\{err}"
  }
  inspect(summary, content="ok:8")
}

///|
test "run_rlm_from_json extracts first object from noisy text" {
  let scripts = [
    "assistant: {\"op\":\"set\",\"path\":\"scratch.answer\",\"value\":\"ok\"} done",
    "```json\n{\"op\":\"finalize\",\"from\":\"answer\"}\n```",
  ]
  let mut cursor = 0
  let out = run_rlm_from_json("p", fn(_messages, _depth) {
    let picked = if cursor < scripts.length() {
      scripts[cursor]
    } else {
      scripts[scripts.length() - 1]
    }
    cursor += 1
    picked
  })

  let summary = match out {
    Ok(res) => "ok:\{res.final_output}"
    Err(err) => "err:\{err}"
  }
  inspect(summary, content="ok:ok")
}
