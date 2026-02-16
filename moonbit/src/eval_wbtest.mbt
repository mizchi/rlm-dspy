///|
test "score_answer supports exact and contains metrics" {
  inspect(score_answer("alpha", "alpha", Exact), content="true")
  inspect(score_answer("alp", "alpha", Contains), content="true")
  inspect(score_answer("beta", "alpha", Exact), content="false")
}

///|
test "parse_rlm_profile defaults to hybrid and validates input" {
  let defaulted = parse_rlm_profile(None)
  let from_pure = parse_rlm_profile(Some("pure"))
  let invalid = parse_rlm_profile(Some("x"))

  let is_default_hybrid = match defaulted {
    Ok(Hybrid) => true
    _ => false
  }
  let is_pure = match from_pure {
    Ok(Pure) => true
    _ => false
  }
  let is_invalid_err = match invalid {
    Ok(_) => false
    Err(_) => true
  }
  let summary = "\{is_default_hybrid}:\{is_pure}:\{is_invalid_err}"
  inspect(summary, content="true:true:true")
}

///|
test "build_profile_rlm_options configures budget and finalize guard" {
  let pure = build_profile_rlm_options(Pure)
  let hybrid = build_profile_rlm_options(Hybrid)
  inspect(pure.budget.max_steps, content="6")
  inspect(hybrid.budget.max_sub_calls, content="16")
  inspect(pure.require_prompt_read_before_finalize, content="false")
  inspect(hybrid.require_prompt_read_before_finalize, content="true")
}

///|
test "parse_eval_jsonl parses valid rows and skips comments" {
  let input =
    #|# comment
    #|{"id":"c1","prompt":"p","query":"q","expected":"a","metric":"contains","tags":["x"]}
    #|{"id":"c2","prompt":"p2","query":"q2","expected":"a2"}
  let parsed = parse_eval_jsonl(input)
  let summary = match parsed {
    Ok(rows) => {
      let metric = rows[0].metric
      let metric_text = match metric {
        Exact => "exact"
        Contains => "contains"
      }
      "ok:\{rows.length()}:\{metric_text}"
    }
    Err(err) => "err:\{err}"
  }
  inspect(summary, content="ok:2:contains")
}

///|
test "parse_eval_jsonl returns error on invalid line" {
  let input = "{\"id\":1}"
  let parsed = parse_eval_jsonl(input)
  let is_err = match parsed {
    Ok(_) => false
    Err(_) => true
  }
  inspect(is_err, content="true")
}
