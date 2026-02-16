///|
/// Minimal RLM runtime loop + DSL executor.

///|
priv struct MarkdownSectionDoc {
  title : String
  body : String
}

///|
priv struct MarkdownDoc {
  sections : Array[MarkdownSectionDoc]
}

///|
priv struct CsvDoc {
  delimiter : String
  headers : Array[String]
  rows : Array[Array[String]]
}

///|
priv enum ParsedDoc {
  Markdown(MarkdownDoc)
  Csv(CsvDoc)
  Text
}

///|
pub fn run_rlm(
  prompt : String,
  complete : (Array[RLMChatMessage], Int) -> RLMDSL,
  options? : RLMRunOptions = default_rlm_options(),
) -> Result[RLMResultPack, String] {
  let prompt_id = "p-\{prompt.hash()}"
  let scratch : Map[String, Json] = {}
  let docs : Map[String, ParsedDoc] = {}
  let cache : Map[String, String] = {}
  let trace : Array[RLMTraceEvent] = []

  let history : Array[RLMChatMessage] = [
    {
      role: System,
      content: "You are an RLM controller. Emit one DSL op per step.",
    },
    { role: User, content: build_initial_metadata(prompt_id, prompt, options) },
  ]

  let mut steps_used = options.budget.steps_used
  let mut sub_calls_used = options.budget.sub_calls_used
  let mut prompt_read_chars_used = options.budget.prompt_read_chars_used
  let mut prompt_was_read = false
  let mut final_output : String? = None

  for _ in 0..<options.budget.max_steps {
    if final_output != None {
      break
    }
    if steps_used + 1 > options.budget.max_steps {
      return Err("budget_exceeded:max_steps")
    }
    steps_used += 1
    let step = steps_used

    let dsl = complete(history, options.budget.depth)
    history.push({ role: Assistant, content: dsl_debug(dsl) })

    match
      exec_dsl(
        dsl, prompt, prompt_id, scratch, docs, cache, trace, step, options, prompt_read_chars_used,
        sub_calls_used, prompt_was_read, final_output,
      ) {
      Ok(state) => {
        let stdout = state.0
        prompt_read_chars_used = state.1
        sub_calls_used = state.2
        prompt_was_read = state.3
        final_output = state.4

        history.push({
          role: User,
          content: build_stdout_metadata(stdout, scratch, step),
        })
        trace.push(
          RootStep({
            step,
            prompt_meta: make_prompt_meta(
              prompt_id,
              prompt,
              options.meta_preview_chars,
            ),
            stdout_meta: make_stdout_meta(
              stdout,
              scratch,
              options.meta_preview_chars,
            ),
          }),
        )
      }
      Err(message) => {
        let stdout = "ERROR:\{message}"
        history.push({
          role: User,
          content: build_error_metadata(message, step),
        })
        trace.push(
          RootStep({
            step,
            prompt_meta: make_prompt_meta(
              prompt_id,
              prompt,
              options.meta_preview_chars,
            ),
            stdout_meta: make_stdout_meta(
              stdout,
              scratch,
              options.meta_preview_chars,
            ),
          }),
        )
      }
    }
  }

  match final_output {
    Some(answer) =>
      Ok({
        final_output: answer,
        trace,
        budget: {
          max_steps: options.budget.max_steps,
          max_sub_calls: options.budget.max_sub_calls,
          max_depth: options.budget.max_depth,
          max_prompt_read_chars: options.budget.max_prompt_read_chars,
          steps_used,
          sub_calls_used,
          depth: options.budget.depth,
          prompt_read_chars_used,
        },
      })
    None => Err("budget_exceeded:max_steps")
  }
}

///|
pub fn run_rlm_from_json(
  prompt : String,
  complete_text : (Array[RLMChatMessage], Int) -> String,
  options? : RLMRunOptions = default_rlm_options(),
) -> Result[RLMResultPack, String] {
  run_rlm(
    prompt,
    fn(messages, depth) {
      let text = complete_text(messages, depth)
      let parsed = parse_json_with_first_object_fallback(text)
      match parsed {
        Ok(value) =>
          match coerce_dsl_from_json(value) {
            Ok(dsl) => dsl
            Err(_) =>
              Set("scratch.__dsl_parse_error", Json::string("invalid_dsl_json"))
          }
        Err(_) => Set("scratch.__dsl_parse_error", Json::string("invalid_json"))
      }
    },
    options~,
  )
}

///|
fn parse_json_with_first_object_fallback(text : String) -> Result[Json, String] {
  let parsed = try? @json.parse(text)
  match parsed {
    Ok(value) => Ok(value)
    Err(_) =>
      match extract_first_json_object_text(text) {
        Some(object_text) => {
          let nested = try? @json.parse(object_text)
          match nested {
            Ok(value) => Ok(value)
            Err(_) => Err("invalid_json")
          }
        }
        None => Err("invalid_json")
      }
  }
}

///|
fn extract_first_json_object_text(text : String) -> String? {
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

///|
fn exec_dsl(
  dsl : RLMDSL,
  prompt : String,
  prompt_id : String,
  scratch : Map[String, Json],
  docs : Map[String, ParsedDoc],
  cache : Map[String, String],
  trace : Array[RLMTraceEvent],
  step : Int,
  options : RLMRunOptions,
  prompt_read_chars_used : Int,
  sub_calls_used : Int,
  prompt_was_read : Bool,
  final_output : String?,
) -> Result[(String, Int, Int, Bool, String?), String] {
  match dsl {
    PromptMeta => {
      let stdout = "prompt_id=\{prompt_id},length=\{prompt.length()}"
      trace.push(
        ReplExec({
          step,
          op: dsl_name(dsl),
          stdout,
          stdout_meta: make_stdout_meta(
            stdout,
            scratch,
            options.meta_preview_chars,
          ),
        }),
      )
      Ok(
        (
          stdout, prompt_read_chars_used, sub_calls_used, prompt_was_read, final_output,
        ),
      )
    }
    DocParse(format_opt, delimiter_opt, out) => {
      if out == "" {
        return Err("doc_parse.out_empty")
      }
      let next_read = prompt_read_chars_used + prompt.length()
      if next_read > options.budget.max_prompt_read_chars {
        return Err("budget_exceeded:max_prompt_read_chars")
      }
      let format = normalize_doc_format(format_opt)
      let delimiter = match delimiter_opt {
        Some(v) => v
        None => ","
      }
      let doc = parse_doc(prompt, format, delimiter)
      docs.set(out, doc)
      scratch.set(out, Json::string("doc:\{doc_format(doc)}"))

      let stdout = "doc_parse out=\{out} format=\{doc_format(doc)}"
      trace.push(
        ReplExec({
          step,
          op: dsl_name(dsl),
          stdout,
          stdout_meta: make_stdout_meta(
            stdout,
            scratch,
            options.meta_preview_chars,
          ),
        }),
      )
      Ok((stdout, next_read, sub_calls_used, true, final_output))
    }
    DocSelectSection(in_key, title, out) => {
      if in_key == "" || out == "" || title == "" {
        return Err("doc_select_section.invalid_args")
      }
      let source = match docs.get(in_key) {
        Some(v) => v
        None => return Err("doc_select_section.source_missing:\{in_key}")
      }
      let body = match source {
        Markdown(doc) =>
          match find_markdown_section(doc, title) {
            Some(v) => v
            None => return Err("doc_select_section.not_found:\{title}")
          }
        _ => return Err("doc_select_section.source_not_markdown")
      }
      scratch.set(out, Json::string(body))
      docs.remove(out)
      let stdout = "doc_select_section out=\{out} length=\{body.length()}"
      trace.push(
        ReplExec({
          step,
          op: dsl_name(dsl),
          stdout,
          stdout_meta: make_stdout_meta(
            stdout,
            scratch,
            options.meta_preview_chars,
          ),
        }),
      )
      Ok(
        (
          stdout, prompt_read_chars_used, sub_calls_used, prompt_was_read, final_output,
        ),
      )
    }
    DocTableSum(in_key, column, out) => {
      if in_key == "" || out == "" {
        return Err("doc_table_sum.invalid_args")
      }
      let source = match docs.get(in_key) {
        Some(v) => v
        None => return Err("doc_table_sum.source_missing:\{in_key}")
      }
      let csv = match source {
        Csv(doc) => doc
        _ => return Err("doc_table_sum.source_not_csv")
      }
      let column_index = match resolve_csv_column_index(csv, column) {
        Ok(v) => v
        Err(message) => return Err(message)
      }

      let mut sum = 0.0
      let mut used = 0
      for row in csv.rows {
        let raw = match row.get(column_index) {
          Some(v) => v
          None => ""
        }
        let parsed = parse_number(raw)
        if parsed != None {
          match parsed {
            Some(v) => {
              sum += v
              used += 1
            }
            None => ()
          }
        }
      }

      let sum_text = number_to_text(sum)
      scratch.set(out, Json::string(sum_text))
      docs.remove(out)
      let stdout = "doc_table_sum out=\{out} sum=\{sum_text} used=\{used}"
      trace.push(
        ReplExec({
          step,
          op: dsl_name(dsl),
          stdout,
          stdout_meta: make_stdout_meta(
            stdout,
            scratch,
            options.meta_preview_chars,
          ),
        }),
      )
      Ok(
        (
          stdout, prompt_read_chars_used, sub_calls_used, prompt_was_read, final_output,
        ),
      )
    }
    DocSelectRows(in_key, column, comparator_opt, value_opt, out) => {
      if in_key == "" || out == "" {
        return Err("doc_select_rows.invalid_args")
      }
      let source = match docs.get(in_key) {
        Some(v) => v
        None => return Err("doc_select_rows.source_missing:\{in_key}")
      }
      let csv = match source {
        Csv(doc) => doc
        _ => return Err("doc_select_rows.source_not_csv")
      }
      let column_index = match resolve_csv_column_index(csv, column) {
        Ok(v) => v
        Err(message) => return Err(message)
      }
      let comparator = normalize_csv_comparator(comparator_opt)
      let expected = match value_opt {
        Some(v) => normalize_scalar_json(v)
        None => ""
      }

      let filtered_rows : Array[Array[String]] = []
      for row in csv.rows {
        let actual = match row.get(column_index) {
          Some(v) => normalize_scalar(v)
          None => ""
        }
        if compare_scalar(actual, expected, comparator) {
          let copied : Array[String] = []
          for cell in row {
            copied.push(cell)
          }
          filtered_rows.push(copied)
        }
      }

      let filtered : CsvDoc = {
        delimiter: csv.delimiter,
        headers: csv.headers,
        rows: filtered_rows,
      }
      docs.set(out, Csv(filtered))
      scratch.set(out, Json::string("doc:csv"))
      let stdout = "doc_select_rows out=\{out} count=\{filtered_rows.length()}"
      trace.push(
        ReplExec({
          step,
          op: dsl_name(dsl),
          stdout,
          stdout_meta: make_stdout_meta(
            stdout,
            scratch,
            options.meta_preview_chars,
          ),
        }),
      )
      Ok(
        (
          stdout, prompt_read_chars_used, sub_calls_used, prompt_was_read, final_output,
        ),
      )
    }
    DocProjectColumns(in_key, columns, out, separator_opt, include_header_opt) => {
      if in_key == "" || out == "" {
        return Err("doc_project_columns.invalid_args")
      }
      if columns.length() == 0 {
        return Err("doc_project_columns.columns_empty")
      }
      let source = match docs.get(in_key) {
        Some(v) => v
        None => return Err("doc_project_columns.source_missing:\{in_key}")
      }
      let csv = match source {
        Csv(doc) => doc
        _ => return Err("doc_project_columns.source_not_csv")
      }
      let sep = match separator_opt {
        Some(v) => v
        None => ","
      }
      let include_header = match include_header_opt {
        Some(v) => v
        None => false
      }

      let indices : Array[Int] = []
      let out_headers : Array[String] = []
      for column in columns {
        let idx = match resolve_csv_column_index(csv, column) {
          Ok(v) => v
          Err(message) => return Err(message)
        }
        indices.push(idx)
        let header = match csv.headers.get(idx) {
          Some(v) => v
          None => "col\{idx}"
        }
        out_headers.push(header)
      }

      let lines : Array[String] = []
      if include_header {
        lines.push(out_headers.join(sep))
      }
      for row in csv.rows {
        let projected : Array[String] = []
        for idx in indices {
          let cell = match row.get(idx) {
            Some(v) => v
            None => ""
          }
          projected.push(cell)
        }
        lines.push(projected.join(sep))
      }

      let json_lines : Array[Json] = []
      for line in lines {
        json_lines.push(Json::string(line))
      }
      scratch.set(out, Json::array(json_lines))
      docs.remove(out)
      let stdout = "doc_project_columns out=\{out} count=\{lines.length()}"
      trace.push(
        ReplExec({
          step,
          op: dsl_name(dsl),
          stdout,
          stdout_meta: make_stdout_meta(
            stdout,
            scratch,
            options.meta_preview_chars,
          ),
        }),
      )
      Ok(
        (
          stdout, prompt_read_chars_used, sub_calls_used, prompt_was_read, final_output,
        ),
      )
    }
    SlicePrompt(start, end, out) => {
      if out == "" {
        return Err("slice_prompt.out_empty")
      }
      let sliced = slice_clamped(prompt, start, end)
      let read_chars = sliced.length()
      let next_read = prompt_read_chars_used + read_chars
      if next_read > options.budget.max_prompt_read_chars {
        return Err("budget_exceeded:max_prompt_read_chars")
      }

      scratch.set(out, Json::string(sliced))
      let stdout = "slice_prompt out=\{out} length=\{sliced.length()}"
      trace.push(
        ReplExec({
          step,
          op: dsl_name(dsl),
          stdout,
          stdout_meta: make_stdout_meta(
            stdout,
            scratch,
            options.meta_preview_chars,
          ),
        }),
      )
      Ok((stdout, next_read, sub_calls_used, true, final_output))
    }
    Find(needle, from, out) => {
      if out == "" {
        return Err("find.out_empty")
      }
      if needle == "" {
        return Err("find.needle_empty")
      }
      let next_read = prompt_read_chars_used + prompt.length()
      if next_read > options.budget.max_prompt_read_chars {
        return Err("budget_exceeded:max_prompt_read_chars")
      }

      let hits = find_all_indices(prompt, needle, from)
      let json_hits : Array[Json] = []
      for hit in hits {
        json_hits.push(Json::number(hit.to_double()))
      }
      scratch.set(out, Json::array(json_hits))
      let stdout = "find out=\{out} count=\{hits.length()}"
      trace.push(
        ReplExec({
          step,
          op: dsl_name(dsl),
          stdout,
          stdout_meta: make_stdout_meta(
            stdout,
            scratch,
            options.meta_preview_chars,
          ),
        }),
      )
      Ok((stdout, next_read, sub_calls_used, true, final_output))
    }
    ChunkNewlines(max_lines, out) => {
      if out == "" {
        return Err("chunk_newlines.out_empty")
      }
      if max_lines <= 0 {
        return Err("chunk_newlines.max_lines_must_be_positive")
      }
      let next_read = prompt_read_chars_used + prompt.length()
      if next_read > options.budget.max_prompt_read_chars {
        return Err("budget_exceeded:max_prompt_read_chars")
      }

      let lines = split_lines(prompt)
      let chunks = chunk_lines(lines, max_lines)
      let json_chunks : Array[Json] = []
      for chunk in chunks {
        json_chunks.push(Json::string(chunk))
      }
      scratch.set(out, Json::array(json_chunks))

      let stdout = "chunk_newlines out=\{out} count=\{chunks.length()}"
      trace.push(
        ReplExec({
          step,
          op: dsl_name(dsl),
          stdout,
          stdout_meta: make_stdout_meta(
            stdout,
            scratch,
            options.meta_preview_chars,
          ),
        }),
      )
      Ok((stdout, next_read, sub_calls_used, true, final_output))
    }
    ChunkTokens(max_tokens, overlap_opt, out) => {
      if out == "" {
        return Err("chunk_tokens.out_empty")
      }
      if max_tokens <= 0 {
        return Err("chunk_tokens.max_tokens_must_be_positive")
      }
      let overlap = match overlap_opt {
        Some(v) => v
        None => 0
      }
      if overlap < 0 || overlap >= max_tokens {
        return Err("chunk_tokens.overlap_invalid")
      }
      let next_read = prompt_read_chars_used + prompt.length()
      if next_read > options.budget.max_prompt_read_chars {
        return Err("budget_exceeded:max_prompt_read_chars")
      }

      let tokens = split_whitespace_tokens(prompt)
      let chunks = chunk_tokens(tokens, max_tokens, overlap)
      let json_chunks : Array[Json] = []
      for chunk in chunks {
        json_chunks.push(Json::string(chunk))
      }
      scratch.set(out, Json::array(json_chunks))
      docs.remove(out)

      let stdout = "chunk_tokens out=\{out} count=\{chunks.length()}"
      trace.push(
        ReplExec({
          step,
          op: dsl_name(dsl),
          stdout,
          stdout_meta: make_stdout_meta(
            stdout,
            scratch,
            options.meta_preview_chars,
          ),
        }),
      )
      Ok((stdout, next_read, sub_calls_used, true, final_output))
    }
    SumCsvColumn(column, delimiter_opt, out) => {
      if out == "" {
        return Err("sum_csv_column.out_empty")
      }
      if column < 0 {
        return Err("sum_csv_column.column_invalid")
      }
      let delimiter = match delimiter_opt {
        Some(v) => v
        None => ","
      }
      let next_read = prompt_read_chars_used + prompt.length()
      if next_read > options.budget.max_prompt_read_chars {
        return Err("budget_exceeded:max_prompt_read_chars")
      }

      let lines = split_non_empty_trimmed_lines(prompt)
      let mut sum = 0.0
      let mut used = 0
      for line in lines {
        let cols = split_and_trim(line, delimiter)
        let raw = match cols.get(column) {
          Some(v) => v
          None => ""
        }
        match parse_number(raw) {
          Some(v) => {
            sum += v
            used += 1
          }
          None => ()
        }
      }

      let sum_text = number_to_text(sum)
      scratch.set(out, Json::string(sum_text))
      docs.remove(out)
      let stdout = "sum_csv_column out=\{out} sum=\{sum_text} used=\{used}"
      trace.push(
        ReplExec({
          step,
          op: dsl_name(dsl),
          stdout,
          stdout_meta: make_stdout_meta(
            stdout,
            scratch,
            options.meta_preview_chars,
          ),
        }),
      )
      Ok((stdout, next_read, sub_calls_used, true, final_output))
    }
    PickWord(index_opt, out) => {
      if out == "" {
        return Err("pick_word.out_empty")
      }
      let requested = match index_opt {
        Some(v) => v
        None => 1
      }
      let next_read = prompt_read_chars_used + prompt.length()
      if next_read > options.budget.max_prompt_read_chars {
        return Err("budget_exceeded:max_prompt_read_chars")
      }

      let words = split_words(prompt)
      let word = if words.length() == 0 {
        ""
      } else {
        let idx = clamp_int(requested, 0, words.length() - 1)
        words[idx]
      }
      scratch.set(out, Json::string(word))
      docs.remove(out)
      let stdout = "pick_word out=\{out} word=\{word}"
      trace.push(
        ReplExec({
          step,
          op: dsl_name(dsl),
          stdout,
          stdout_meta: make_stdout_meta(
            stdout,
            scratch,
            options.meta_preview_chars,
          ),
        }),
      )
      Ok((stdout, next_read, sub_calls_used, true, final_output))
    }
    CallSymbol(symbol, out, args_opt, input_opt) => {
      if symbol == "" || out == "" {
        return Err("call_symbol.invalid_args")
      }
      let runner = match options.symbol_runner {
        Some(fn_) => fn_
        None => return Err("call_symbol.runner_missing")
      }
      let call : RLMExternalSymbolCall = {
        symbol,
        prompt,
        prompt_id,
        depth: options.budget.depth,
        args: args_opt,
        input: input_opt,
      }
      let value = match runner(call) {
        Ok(v) => v
        Err(message) => return Err("call_symbol_error:\{message}")
      }
      scratch.set(out, value)
      docs.remove(out)
      let stdout = "call_symbol out=\{out} symbol=\{symbol}"
      trace.push(
        ReplExec({
          step,
          op: dsl_name(dsl),
          stdout,
          stdout_meta: make_stdout_meta(
            stdout,
            scratch,
            options.meta_preview_chars,
          ),
        }),
      )
      Ok(
        (
          stdout, prompt_read_chars_used, sub_calls_used, prompt_was_read, final_output,
        ),
      )
    }
    SubMap(in_key, query_template, out, limit, _concurrency) => {
      if out == "" {
        return Err("sub_map.out_empty")
      }
      let runner = match options.sub_runner {
        Some(fn_) => fn_
        None => return Err("sub_map.sub_runner_missing")
      }
      let values = match read_string_array(scratch, in_key) {
        Ok(v) => v
        Err(message) => return Err(message)
      }

      let mut sub_count = sub_calls_used
      let mapped : Array[Json] = []
      let upper = match limit {
        Some(v) => if v < 0 { 0 } else { min_int(v, values.length()) }
        None => values.length()
      }

      for i in 0..<upper {
        let item = values[i]
        let query = query_template.replace_all(old="{{item}}", new=item)
        match cache.get(query) {
          Some(cached_result) => {
            mapped.push(Json::string(cached_result))
            trace.push(
              SubCall({
                depth: options.budget.depth + 1,
                query,
                result_meta: make_stdout_meta(
                  cached_result,
                  scratch,
                  options.meta_preview_chars,
                ),
                cached: true,
              }),
            )
          }
          None => {
            if options.budget.depth + 1 > options.budget.max_depth {
              return Err("budget_exceeded:max_depth")
            }
            if sub_count + 1 > options.budget.max_sub_calls {
              return Err("budget_exceeded:max_sub_calls")
            }
            sub_count += 1
            let result = match runner(query) {
              Ok(v) => v
              Err(message) => return Err("sub_runner_error:\{message}")
            }
            cache.set(query, result)
            mapped.push(Json::string(result))
            trace.push(
              SubCall({
                depth: options.budget.depth + 1,
                query,
                result_meta: make_stdout_meta(
                  result,
                  scratch,
                  options.meta_preview_chars,
                ),
                cached: false,
              }),
            )
          }
        }
      }

      scratch.set(out, Json::array(mapped))
      docs.remove(out)
      let stdout = "sub_map out=\{out} count=\{upper}"
      trace.push(
        ReplExec({
          step,
          op: dsl_name(dsl),
          stdout,
          stdout_meta: make_stdout_meta(
            stdout,
            scratch,
            options.meta_preview_chars,
          ),
        }),
      )
      Ok(
        (
          stdout, prompt_read_chars_used, sub_count, prompt_was_read, final_output,
        ),
      )
    }
    ReduceJoin(in_key, sep, out) => {
      if out == "" {
        return Err("reduce_join.out_empty")
      }
      let values = match read_string_array(scratch, in_key) {
        Ok(v) => v
        Err(message) => return Err(message)
      }
      let joined = values.join(sep)
      scratch.set(out, Json::string(joined))
      let stdout = "reduce_join out=\{out} length=\{joined.length()}"
      trace.push(
        ReplExec({
          step,
          op: dsl_name(dsl),
          stdout,
          stdout_meta: make_stdout_meta(
            stdout,
            scratch,
            options.meta_preview_chars,
          ),
        }),
      )
      Ok(
        (
          stdout, prompt_read_chars_used, sub_calls_used, prompt_was_read, final_output,
        ),
      )
    }
    Set(path, value) => {
      let key = scratch_key(path)
      if key == "" {
        return Err("set.path_empty")
      }
      set_by_path(scratch, path, value)
      let stdout = "set path=\{path}"
      if key != "" {
        docs.remove(key)
      }
      trace.push(
        ReplExec({
          step,
          op: dsl_name(dsl),
          stdout,
          stdout_meta: make_stdout_meta(
            stdout,
            scratch,
            options.meta_preview_chars,
          ),
        }),
      )
      Ok(
        (
          stdout, prompt_read_chars_used, sub_calls_used, prompt_was_read, final_output,
        ),
      )
    }
    Finalize(from) => {
      if options.require_prompt_read_before_finalize && !prompt_was_read {
        return Err("finalize_before_prompt_read")
      }
      let source = match get_scratch_value(scratch, from) {
        Some(v) => v
        None => return Err("finalize.missing:\{from}")
      }
      let answer = to_output_text(source)
      let stdout = "finalize from=\{from}"
      trace.push(
        ReplExec({
          step,
          op: dsl_name(dsl),
          stdout,
          stdout_meta: make_stdout_meta(
            stdout,
            scratch,
            options.meta_preview_chars,
          ),
        }),
      )
      Ok(
        (
          stdout,
          prompt_read_chars_used,
          sub_calls_used,
          prompt_was_read,
          Some(answer),
        ),
      )
    }
  }
}

///|
fn dsl_name(dsl : RLMDSL) -> String {
  match dsl {
    PromptMeta => "prompt_meta"
    DocParse(_, _, _) => "doc_parse"
    DocSelectSection(_, _, _) => "doc_select_section"
    DocTableSum(_, _, _) => "doc_table_sum"
    DocSelectRows(_, _, _, _, _) => "doc_select_rows"
    DocProjectColumns(_, _, _, _, _) => "doc_project_columns"
    SlicePrompt(_, _, _) => "slice_prompt"
    Find(_, _, _) => "find"
    ChunkNewlines(_, _) => "chunk_newlines"
    ChunkTokens(_, _, _) => "chunk_tokens"
    SumCsvColumn(_, _, _) => "sum_csv_column"
    PickWord(_, _) => "pick_word"
    CallSymbol(_, _, _, _) => "call_symbol"
    SubMap(_, _, _, _, _) => "sub_map"
    ReduceJoin(_, _, _) => "reduce_join"
    Set(_, _) => "set"
    Finalize(_) => "finalize"
  }
}

///|
fn dsl_debug(dsl : RLMDSL) -> String {
  "dsl:" + dsl_name(dsl)
}

///|
fn make_prompt_meta(
  prompt_id : String,
  prompt : String,
  preview_chars : Int,
) -> RLMPromptMeta {
  {
    prompt_id,
    length: prompt.length(),
    preview_head: cut_text(prompt, preview_chars),
  }
}

///|
fn make_stdout_meta(
  stdout : String,
  scratch : Map[String, Json],
  preview_chars : Int,
) -> RLMStdoutMeta {
  {
    length: stdout.length(),
    preview: cut_text(stdout, preview_chars),
    keys: scratch_keys(scratch),
  }
}

///|
fn scratch_keys(scratch : Map[String, Json]) -> Array[String] {
  let out : Array[String] = []
  for row in scratch.to_array() {
    if out.length() >= 16 {
      break
    }
    out.push(row.0)
  }
  out
}

///|
fn cut_text(value : String, preview_chars : Int) -> String {
  if preview_chars <= 0 {
    return ""
  }
  let end = min_int(preview_chars, value.length())
  if end <= 0 {
    ""
  } else {
    value.unsafe_substring(start=0, end~)
  }
}

///|
fn build_initial_metadata(
  prompt_id : String,
  prompt : String,
  options : RLMRunOptions,
) -> String {
  let task = match options.task {
    Some(v) => v
    None => ""
  }
  "kind=rlm_init depth=\{options.budget.depth} prompt_id=\{prompt_id} length=\{prompt.length()} task=\{task}"
}

///|
fn build_stdout_metadata(
  stdout : String,
  scratch : Map[String, Json],
  step : Int,
) -> String {
  let keys = scratch_keys(scratch).join(",")
  "kind=rlm_stdout step=\{step} stdout_length=\{stdout.length()} keys=\{keys}"
}

///|
fn build_error_metadata(error : String, step : Int) -> String {
  "kind=rlm_error step=\{step} error=\{error}"
}

///|
fn slice_clamped(prompt : String, start : Int, end : Int) -> String {
  let n = prompt.length()
  let bounded_start = clamp_int(start, 0, n)
  let bounded_end = clamp_int(end, 0, n)
  let safe_end = if bounded_end < bounded_start {
    bounded_start
  } else {
    bounded_end
  }
  if safe_end <= bounded_start {
    ""
  } else {
    prompt.unsafe_substring(start=bounded_start, end=safe_end)
  }
}

///|
fn find_all_indices(prompt : String, needle : String, from : Int) -> Array[Int] {
  let hits : Array[Int] = []
  if needle == "" {
    return hits
  }

  let n = prompt.length()
  let width = needle.length()
  if width <= 0 || width > n {
    return hits
  }
  let start = clamp_int(from, 0, n - width)

  for i in start..<=(n - width) {
    let part = prompt.unsafe_substring(start=i, end=i + width)
    if part == needle {
      hits.push(i)
    }
  }
  hits
}

///|
fn split_lines(text : String) -> Array[String] {
  let out : Array[String] = []
  for row in text.split("\n") {
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
fn chunk_lines(lines : Array[String], max_lines : Int) -> Array[String] {
  if max_lines <= 0 {
    return []
  }

  let chunks : Array[String] = []
  for i = 0; i < lines.length(); {
    let end = min_int(i + max_lines, lines.length())
    let part : Array[String] = []
    for j in i..<end {
      part.push(lines[j])
    }
    chunks.push(part.join("\n"))
    continue end
  }
  chunks
}

///|
fn split_whitespace_tokens(text : String) -> Array[String] {
  let tokens : Array[String] = []
  let current : Array[Char] = []
  for ch in text.to_array() {
    if ch.is_whitespace() {
      if current.length() > 0 {
        tokens.push(String::from_array(current))
        current.clear()
      }
    } else {
      current.push(ch)
    }
  }
  if current.length() > 0 {
    tokens.push(String::from_array(current))
  }
  tokens
}

///|
fn chunk_tokens(
  tokens : Array[String],
  max_tokens : Int,
  overlap : Int,
) -> Array[String] {
  if max_tokens <= 0 {
    return []
  }
  let stride = max_tokens - overlap
  if stride <= 0 {
    return []
  }
  let out : Array[String] = []
  for i = 0; i < tokens.length(); {
    let end = min_int(i + max_tokens, tokens.length())
    let part : Array[String] = []
    for j in i..<end {
      part.push(tokens[j])
    }
    if part.length() > 0 {
      out.push(part.join(" "))
    }
    if end >= tokens.length() {
      break
    }
    continue i + stride
  }
  out
}

///|
fn split_words(text : String) -> Array[String] {
  let words : Array[String] = []
  let current : Array[Char] = []
  for ch in text.to_array() {
    let is_word = ch.is_ascii_alphabetic() ||
      ch.is_ascii_digit() ||
      ch == '_' ||
      ch == '-'
    if is_word {
      current.push(ch)
    } else if current.length() > 0 {
      words.push(String::from_array(current))
      current.clear()
    }
  }
  if current.length() > 0 {
    words.push(String::from_array(current))
  }
  words
}

///|
fn split_non_empty_trimmed_lines(text : String) -> Array[String] {
  let out : Array[String] = []
  for row in split_lines(text) {
    let trimmed = normalize_scalar(row)
    if trimmed != "" {
      out.push(trimmed)
    }
  }
  out
}

///|
fn split_and_trim(line : String, delimiter : String) -> Array[String] {
  let out : Array[String] = []
  for row in line.split(delimiter) {
    out.push(normalize_scalar(row.to_string()))
  }
  out
}

///|
fn normalize_doc_format(format_opt : String?) -> String {
  match format_opt {
    Some(v) =>
      if v == "auto" || v == "text" || v == "markdown" || v == "csv" {
        v
      } else {
        "auto"
      }
    None => "auto"
  }
}

///|
fn doc_format(doc : ParsedDoc) -> String {
  match doc {
    Markdown(_) => "markdown"
    Csv(_) => "csv"
    Text => "text"
  }
}

///|
fn parse_doc(prompt : String, format : String, delimiter : String) -> ParsedDoc {
  if format == "markdown" {
    return Markdown(parse_markdown_doc(prompt))
  }
  if format == "csv" {
    return Csv(parse_csv_doc(prompt, delimiter))
  }
  if format == "text" {
    return Text
  }
  if looks_like_markdown(prompt) {
    return Markdown(parse_markdown_doc(prompt))
  }
  if looks_like_csv(prompt, delimiter) {
    return Csv(parse_csv_doc(prompt, delimiter))
  }
  Text
}

///|
fn parse_markdown_doc(prompt : String) -> MarkdownDoc {
  let lines = split_lines(prompt)
  let headings : Array[(Int, Int, String)] = []
  for i in 0..<lines.length() {
    let line = lines[i]
    match parse_markdown_heading(line) {
      Some(heading) => headings.push((i, heading.0, heading.1))
      None => ()
    }
  }

  let sections : Array[MarkdownSectionDoc] = []
  for i in 0..<headings.length() {
    let heading = headings[i]
    let line_index = heading.0
    let level = heading.1
    let title = heading.2

    let mut end_line = lines.length()
    for j in (i + 1)..<headings.length() {
      let next = headings[j]
      if next.1 <= level {
        end_line = next.0
        break
      }
    }

    let body_lines : Array[String] = []
    for j in (line_index + 1)..<end_line {
      body_lines.push(lines[j])
    }
    let body = trim_blank_edges(body_lines).join("\n")
    sections.push({ title, body })
  }

  { sections, }
}

///|
fn parse_markdown_heading(line : String) -> (Int, String)? {
  let trimmed = normalize_scalar(line)
  if trimmed == "" {
    return None
  }

  let chars = trimmed.to_array()
  let mut level = 0
  for ch in chars {
    if ch == '#' {
      level += 1
    } else {
      break
    }
  }
  if level <= 0 || level > 6 {
    return None
  }
  if chars.length() <= level || chars[level] != ' ' {
    return None
  }
  let title = normalize_scalar(
    trimmed.unsafe_substring(start=level + 1, end=trimmed.length()),
  )
  if title == "" {
    None
  } else {
    Some((level, title))
  }
}

///|
fn trim_blank_edges(lines : Array[String]) -> Array[String] {
  let mut start = 0
  let mut end = lines.length()
  for i in start..<end {
    if normalize_scalar(lines[i]) == "" {
      start += 1
    } else {
      break
    }
  }
  for i = end - 1; i >= start; {
    if normalize_scalar(lines[i]) == "" {
      end -= 1
      continue i - 1
    } else {
      break
    }
  }

  let out : Array[String] = []
  for i in start..<end {
    out.push(lines[i])
  }
  out
}

///|
fn parse_csv_doc(prompt : String, delimiter : String) -> CsvDoc {
  let lines = split_non_empty_trimmed_lines(prompt)
  let rows : Array[Array[String]] = []
  for line in lines {
    rows.push(split_and_trim(line, delimiter))
  }

  let first = rows.get(0)
  let second = rows.get(1)
  let has_header_by_numeric_hint = match (first, second) {
    (Some(head), Some(next)) => {
      let mut found = false
      for i in 0..<head.length() {
        let h = head[i]
        let n = match next.get(i) {
          Some(v) => v
          None => ""
        }
        if !looks_numeric(h) && looks_numeric(n) {
          found = true
          break
        }
      }
      found
    }
    _ => false
  }
  let has_header_by_name_hint = match (first, second) {
    (Some(head), Some(_)) =>
      if head.length() == 0 {
        false
      } else {
        let mut all_header = true
        for cell in head {
          if !is_likely_header_cell(cell) {
            all_header = false
            break
          }
        }
        all_header
      }
    _ => false
  }
  let has_header = has_header_by_numeric_hint || has_header_by_name_hint

  let headers : Array[String] = []
  let data_rows : Array[Array[String]] = []
  match first {
    Some(head) =>
      if has_header {
        for cell in head {
          headers.push(cell)
        }
        for i in 1..<rows.length() {
          data_rows.push(rows[i])
        }
      } else {
        for i in 0..<head.length() {
          headers.push("col\{i}")
        }
        for row in rows {
          data_rows.push(row)
        }
      }
    None => ()
  }

  { delimiter, headers, rows: data_rows }
}

///|
fn find_markdown_section(doc : MarkdownDoc, title : String) -> String? {
  for section in doc.sections {
    if section.title == title {
      return Some(section.body)
    }
  }
  let lowered = title.to_lower()
  for section in doc.sections {
    if section.title.to_lower() == lowered {
      return Some(section.body)
    }
  }
  None
}

///|
fn resolve_csv_column_index(csv : CsvDoc, column : Json) -> Result[Int, String] {
  match column {
    Json::Number(v, ..) => {
      let idx = v.to_int()
      if idx < 0 {
        Err("csv_column_negative")
      } else {
        Ok(idx)
      }
    }
    Json::String(name) => {
      for i in 0..<csv.headers.length() {
        if csv.headers[i] == name {
          return Ok(i)
        }
      }
      let lowered = name.to_lower()
      for i in 0..<csv.headers.length() {
        if csv.headers[i].to_lower() == lowered {
          return Ok(i)
        }
      }
      Err("csv_column_not_found:\{name}")
    }
    _ => Err("csv_column_invalid")
  }
}

///|
fn normalize_csv_comparator(input : String?) -> String {
  match input {
    Some(v) =>
      if v == "eq" ||
        v == "contains" ||
        v == "gt" ||
        v == "gte" ||
        v == "lt" ||
        v == "lte" {
        v
      } else {
        "eq"
      }
    None => "eq"
  }
}

///|
fn normalize_scalar(value : String) -> String {
  value.trim().to_string()
}

///|
fn normalize_scalar_json(value : Json) -> String {
  match value {
    Json::String(v) => normalize_scalar(v)
    Json::Number(v, ..) => normalize_scalar(number_to_text(v))
    Json::True => "true"
    Json::False => "false"
    Json::Null => ""
    _ => normalize_scalar(value.stringify())
  }
}

///|
fn compare_scalar(
  actual : String,
  expected : String,
  comparator : String,
) -> Bool {
  if comparator == "eq" {
    return actual == expected
  }
  if comparator == "contains" {
    return actual.contains(expected)
  }
  if comparator == "gt" {
    return compare_numeric(actual, expected, "gt")
  }
  if comparator == "gte" {
    return compare_numeric(actual, expected, "gte")
  }
  if comparator == "lt" {
    return compare_numeric(actual, expected, "lt")
  }
  if comparator == "lte" {
    return compare_numeric(actual, expected, "lte")
  }
  false
}

///|
fn compare_numeric(
  actual : String,
  expected : String,
  comparator : String,
) -> Bool {
  let a = parse_number(actual)
  let b = parse_number(expected)
  match (a, b) {
    (Some(x), Some(y)) =>
      if comparator == "gt" {
        x > y
      } else if comparator == "gte" {
        x >= y
      } else if comparator == "lt" {
        x < y
      } else if comparator == "lte" {
        x <= y
      } else {
        false
      }
    _ => false
  }
}

///|
fn looks_like_markdown(prompt : String) -> Bool {
  for line in split_lines(prompt) {
    if parse_markdown_heading(line) != None {
      return true
    }
  }
  false
}

///|
fn looks_like_csv(prompt : String, delimiter : String) -> Bool {
  let lines = split_non_empty_trimmed_lines(prompt)
  if lines.length() < 2 {
    return false
  }
  let first_count = split_and_trim(lines[0], delimiter).length()
  if first_count <= 1 {
    return false
  }
  for line in lines {
    if split_and_trim(line, delimiter).length() != first_count {
      return false
    }
  }
  true
}

///|
fn looks_numeric(input : String) -> Bool {
  parse_number(normalize_scalar(input)) != None
}

///|
fn is_likely_header_cell(input : String) -> Bool {
  let normalized = normalize_scalar(input)
  if normalized == "" || looks_numeric(normalized) {
    return false
  }
  let chars = normalized.to_array()
  let first = chars[0]
  if !(first.is_ascii_alphabetic() || first == '_') {
    return false
  }
  true
}

///|
fn parse_number(input : String) -> Double? {
  let trimmed = normalize_scalar(input)
  if trimmed == "" {
    return None
  }
  let parsed = try? @json.parse(trimmed)
  match parsed {
    Ok(Json::Number(v, ..)) => Some(v)
    _ => None
  }
}

///|
fn number_to_text(value : Double) -> String {
  let int_value = value.to_int()
  if int_value.to_double() == value {
    int_value.to_string()
  } else {
    value.to_string()
  }
}

///|
fn coerce_dsl_from_json(value : Json) -> Result[RLMDSL, String] {
  let row = match value {
    Json::Object(v) => v
    _ => return Err("dsl_not_object")
  }
  let op = match json_get_string(row, "op") {
    Some(v) => v
    None => return Err("dsl_op_missing")
  }

  if op == "prompt_meta" {
    return Ok(PromptMeta)
  }
  if op == "doc_parse" {
    return Ok(
      DocParse(
        json_get_string(row, "format"),
        json_get_string(row, "delimiter"),
        json_get_string(row, "out").unwrap_or("doc"),
      ),
    )
  }
  if op == "doc_select_section" {
    let in_key = json_get_string(row, "in").unwrap_or("doc")
    let title = match json_get_string(row, "title") {
      Some(v) => v
      None => json_get_string(row, "section").unwrap_or("Introduction")
    }
    let out = json_get_string(row, "out").unwrap_or("answer")
    return Ok(DocSelectSection(in_key, title, out))
  }
  if op == "doc_table_sum" {
    let in_key = json_get_string(row, "in").unwrap_or("doc")
    let column = row.get("column").unwrap_or(Json::number(1.0))
    let out = json_get_string(row, "out").unwrap_or("total")
    return Ok(DocTableSum(in_key, column, out))
  }
  if op == "doc_select_rows" {
    let in_key = json_get_string(row, "in").unwrap_or("doc")
    let column = match row.get("column") {
      Some(v) => v
      None => row.get("whereColumn").unwrap_or(Json::number(0.0))
    }
    let comparator = match json_get_string(row, "comparator") {
      Some(v) => Some(v)
      None => json_get_string(row, "operator")
    }
    let expected = match row.get("equals") {
      Some(v) => Some(v)
      None =>
        match row.get("value") {
          Some(v) => Some(v)
          None => row.get("match")
        }
    }
    let out = json_get_string(row, "out").unwrap_or("rows")
    return Ok(DocSelectRows(in_key, column, comparator, expected, out))
  }
  if op == "doc_project_columns" {
    let in_key = json_get_string(row, "in").unwrap_or("doc")
    let columns = match json_get_array(row, "columns") {
      Some(v) => v
      None =>
        match json_get_array(row, "cols") {
          Some(v) => v
          None => [Json::number(0.0)]
        }
    }
    let out = json_get_string(row, "out").unwrap_or("lines")
    let separator = match json_get_string(row, "separator") {
      Some(v) => Some(v)
      None => json_get_string(row, "sep")
    }
    let include_header = json_get_bool(row, "includeHeader")
    return Ok(
      DocProjectColumns(in_key, columns, out, separator, include_header),
    )
  }
  if op == "slice_prompt" {
    let start = json_get_int(row, "start").unwrap_or(0)
    let end = json_get_int(row, "end").unwrap_or(start)
    let out = match json_get_string(row, "out") {
      Some(v) => v
      None => json_get_string(row, "from").unwrap_or("chunk")
    }
    return Ok(SlicePrompt(start, end, out))
  }
  if op == "find" {
    let needle = json_get_string(row, "needle").unwrap_or("")
    let from = json_get_int(row, "from").unwrap_or(0)
    let out = json_get_string(row, "out").unwrap_or("hits")
    return Ok(Find(needle, from, out))
  }
  if op == "chunk_newlines" {
    let max_lines = json_get_int(row, "maxLines").unwrap_or(20)
    let out = json_get_string(row, "out").unwrap_or("chunks")
    return Ok(ChunkNewlines(max_lines, out))
  }
  if op == "chunk_tokens" {
    let max_tokens = match json_get_int(row, "maxTokens") {
      Some(v) => v
      None => json_get_int(row, "maxWords").unwrap_or(200)
    }
    let overlap = json_get_int(row, "overlap")
    let out = json_get_string(row, "out").unwrap_or("chunks")
    return Ok(ChunkTokens(max_tokens, overlap, out))
  }
  if op == "sum_csv_column" {
    let column = json_get_int(row, "column").unwrap_or(1)
    let delimiter = json_get_string(row, "delimiter")
    let out = json_get_string(row, "out").unwrap_or("total")
    return Ok(SumCsvColumn(column, delimiter, out))
  }
  if op == "pick_word" {
    let index = json_get_int(row, "index")
    let out = json_get_string(row, "out").unwrap_or("picked")
    return Ok(PickWord(index, out))
  }
  if op == "call_symbol" {
    let symbol = match json_get_string(row, "symbol") {
      Some(v) => v
      None => json_get_string(row, "name").unwrap_or("")
    }
    let out = json_get_string(row, "out").unwrap_or("answer")
    let args = row.get("args")
    let input = row.get("input")
    return Ok(CallSymbol(symbol, out, args, input))
  }
  if op == "sub_map" {
    let in_key = json_get_string(row, "in").unwrap_or("chunks")
    let query_template = match json_get_string(row, "queryTemplate") {
      Some(v) => v
      None => json_get_string(row, "template").unwrap_or("{{item}}")
    }
    let out = json_get_string(row, "out").unwrap_or("mapped")
    let limit = json_get_int(row, "limit")
    let concurrency = json_get_int(row, "concurrency")
    return Ok(SubMap(in_key, query_template, out, limit, concurrency))
  }
  if op == "reduce_join" {
    let in_key = json_get_string(row, "in").unwrap_or("mapped")
    let sep = json_get_string(row, "sep").unwrap_or("\n")
    let out = json_get_string(row, "out").unwrap_or("joined")
    return Ok(ReduceJoin(in_key, sep, out))
  }
  if op == "set" {
    let path = match json_get_string(row, "path") {
      Some(v) => v
      None => "scratch." + json_get_string(row, "key").unwrap_or("answer")
    }
    let value = match row.get("value") {
      Some(v) => v
      None =>
        match row.get("answer") {
          Some(v) => v
          None => row.get("result").unwrap_or(Json::string(""))
        }
    }
    return Ok(Set(path, value))
  }
  if op == "finalize" {
    let from = match json_get_string(row, "from") {
      Some(v) => v
      None =>
        match json_get_string(row, "path") {
          Some(v) => v
          None => json_get_string(row, "key").unwrap_or("answer")
        }
    }
    return Ok(Finalize(from))
  }

  Err("dsl_unknown_op:\{op}")
}

///|
fn json_get_string(row : Map[String, Json], key : String) -> String? {
  match row.get(key) {
    Some(Json::String(v)) => Some(v)
    _ => None
  }
}

///|
fn json_get_array(row : Map[String, Json], key : String) -> Array[Json]? {
  match row.get(key) {
    Some(Json::Array(v)) => Some(v)
    _ => None
  }
}

///|
fn json_get_int(row : Map[String, Json], key : String) -> Int? {
  match row.get(key) {
    Some(Json::Number(v, ..)) => Some(v.to_int())
    Some(Json::String(v)) =>
      match parse_number(v) {
        Some(n) => Some(n.to_int())
        None => None
      }
    _ => None
  }
}

///|
fn json_get_bool(row : Map[String, Json], key : String) -> Bool? {
  match row.get(key) {
    Some(Json::True) => Some(true)
    Some(Json::False) => Some(false)
    Some(Json::String(v)) =>
      if v == "true" {
        Some(true)
      } else if v == "false" {
        Some(false)
      } else {
        None
      }
    _ => None
  }
}

///|
fn read_string_array(
  scratch : Map[String, Json],
  key : String,
) -> Result[Array[String], String] {
  let source = match scratch.get(key) {
    Some(v) => v
    None => return Err("scratch_missing:\{key}")
  }
  match source {
    Json::Array(values) => {
      let out : Array[String] = []
      for row in values {
        out.push(to_output_text(row))
      }
      Ok(out)
    }
    _ => Err("scratch_not_array:\{key}")
  }
}

///|
fn scratch_key(path : String) -> String {
  if path.has_prefix("scratch.") {
    if path.length() <= 8 {
      ""
    } else {
      path.unsafe_substring(start=8, end=path.length())
    }
  } else {
    path
  }
}

///|
fn set_by_path(
  scratch : Map[String, Json],
  path : String,
  value : Json,
) -> Unit {
  let key = scratch_key(path)
  if key != "" {
    scratch.set(key, value)
  }
}

///|
fn get_scratch_value(scratch : Map[String, Json], path : String) -> Json? {
  let key = scratch_key(path)
  if key == "" {
    None
  } else {
    scratch.get(key)
  }
}

///|
fn to_output_text(value : Json) -> String {
  match value {
    Json::String(v) => v
    _ => value.stringify()
  }
}

///|
fn min_int(a : Int, b : Int) -> Int {
  if a < b {
    a
  } else {
    b
  }
}

///|
fn clamp_int(value : Int, min_value : Int, max_value : Int) -> Int {
  if value < min_value {
    min_value
  } else if value > max_value {
    max_value
  } else {
    value
  }
}
