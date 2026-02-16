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
