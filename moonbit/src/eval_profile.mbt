///|
pub fn parse_rlm_profile(input : String?) -> Result[RLMProfile, String] {
  match input {
    None => Ok(Hybrid)
    Some(value) =>
      if value == "" || value == "hybrid" {
        Ok(Hybrid)
      } else if value == "pure" {
        Ok(Pure)
      } else {
        Err("unknown_profile:\{value}")
      }
  }
}

///|
pub fn build_profile_rlm_options(profile : RLMProfile) -> RLMRunOptions {
  let budget = default_rlm_budget(max_steps=6, max_sub_calls=16, max_depth=4)
  match profile {
    Pure =>
      default_rlm_options(budget~, require_prompt_read_before_finalize=false)
    Hybrid =>
      default_rlm_options(budget~, require_prompt_read_before_finalize=true)
  }
}
