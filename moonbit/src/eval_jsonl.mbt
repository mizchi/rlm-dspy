///|
pub fn parse_eval_jsonl(input : String) -> Result[Array[EvalCase], String] {
  let lines = split_jsonl_lines(input)
  let out : Array[EvalCase] = []

  for i in 0..<lines.length() {
    let line_no = i + 1
    let line = lines[i].trim().to_string()
    if line == "" || line.has_prefix("#") {
      continue
    }

    let parsed = try? @json.parse(line)
    let value = match parsed {
      Ok(v) => v
      Err(_) => return Err("invalid_jsonl_line:\{line_no}")
    }

    let row = match validate_eval_case(value, line_no) {
      Ok(v) => v
      Err(message) => return Err(message)
    }
    out.push(row)
  }

  Ok(out)
}

///|
fn validate_eval_case(input : Json, line_no : Int) -> Result[EvalCase, String] {
  let row = match input {
    Json::Object(v) => v
    _ => return Err("line_\{line_no}:object_required")
  }

  let id = match json_required_string(row, "id", line_no) {
    Ok(v) => v
    Err(message) => return Err(message)
  }
  let prompt = match json_required_string(row, "prompt", line_no) {
    Ok(v) => v
    Err(message) => return Err(message)
  }
  let query = match json_required_string(row, "query", line_no) {
    Ok(v) => v
    Err(message) => return Err(message)
  }
  let expected = match json_required_string(row, "expected", line_no) {
    Ok(v) => v
    Err(message) => return Err(message)
  }

  let metric = match row.get("metric") {
    None => Exact
    Some(Json::String(v)) =>
      if v == "exact" {
        Exact
      } else if v == "contains" {
        Contains
      } else {
        return Err("line_\{line_no}:metric_invalid")
      }
    Some(_) => return Err("line_\{line_no}:metric_invalid")
  }

  let tags = match row.get("tags") {
    None => []
    Some(Json::Array(values)) => {
      let out : Array[String] = []
      for value in values {
        match value {
          Json::String(v) => out.push(v)
          _ => return Err("line_\{line_no}:tags_invalid")
        }
      }
      out
    }
    Some(_) => return Err("line_\{line_no}:tags_invalid")
  }

  let budget = match row.get("budget") {
    None => None
    Some(Json::Object(v)) =>
      match parse_budget_patch(v, line_no) {
        Ok(parsed) => Some(parsed)
        Err(message) => return Err(message)
      }
    Some(_) => return Err("line_\{line_no}:budget_invalid")
  }

  Ok({ id, prompt, query, expected, metric, tags, budget })
}

///|
fn parse_budget_patch(
  row : Map[String, Json],
  line_no : Int,
) -> Result[EvalBudgetPatch, String] {
  let max_steps = json_optional_int(row, "maxSteps")
  let max_sub_calls = json_optional_int(row, "maxSubCalls")
  let max_depth = json_optional_int(row, "maxDepth")
  let max_prompt_read_chars = json_optional_int(row, "maxPromptReadChars")

  if (row.contains("maxSteps") && max_steps == None) ||
    (row.contains("maxSubCalls") && max_sub_calls == None) ||
    (row.contains("maxDepth") && max_depth == None) ||
    (row.contains("maxPromptReadChars") && max_prompt_read_chars == None) {
    return Err("line_\{line_no}:budget_invalid")
  }

  Ok({ max_steps, max_sub_calls, max_depth, max_prompt_read_chars })
}

///|
fn split_jsonl_lines(input : String) -> Array[String] {
  let out : Array[String] = []
  for row in input.split("\n") {
    let line = row.to_string()
    if line.has_suffix("\r") {
      out.push(line.unsafe_substring(start=0, end=line.length() - 1))
    } else {
      out.push(line)
    }
  }
  out
}

///|
fn json_required_string(
  row : Map[String, Json],
  key : String,
  line_no : Int,
) -> Result[String, String] {
  match row.get(key) {
    Some(Json::String(v)) => Ok(v)
    _ => Err("line_\{line_no}:\{key}_must_be_string")
  }
}

///|
fn json_optional_int(row : Map[String, Json], key : String) -> Int? {
  match row.get(key) {
    Some(Json::Number(v, ..)) => Some(v.to_int())
    Some(Json::String(v)) =>
      match parse_jsonl_number(v) {
        Some(n) => Some(n.to_int())
        None => None
      }
    _ => None
  }
}

///|
fn parse_jsonl_number(input : String) -> Double? {
  let trimmed = input.trim().to_string()
  if trimmed == "" {
    return None
  }
  let parsed = try? @json.parse(trimmed)
  match parsed {
    Ok(Json::Number(v, ..)) => Some(v)
    _ => None
  }
}
