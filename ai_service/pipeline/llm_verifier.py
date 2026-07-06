async def call_llm(system_prompt, user_prompt, model="llama-3.3-70b-versatile"):
    return {"relevant": False, "reason": "LLM verification disabled; API tokens reserved for planner recommendations and deep dives only."}

async def verify_with_llm(article, profile):
    """Stage 7: LLM Verifier"""
    return {"relevant": False, "reason": "LLM verification disabled"}
