from fastapi import FastAPI, Request
import uvicorn
from dotenv import load_dotenv
import os

load_dotenv(dotenv_path="../.env")

app = FastAPI(title="FOPs Pulse AI Service")

# ── Startup diagnostics ──
groq_key = os.getenv("GROQ_API_KEY", "")
gemini_key = os.getenv("GEMINI_API_KEY", "")
print(f"[AI SERVICE BOOT] GROQ_API_KEY loaded: {'YES (' + groq_key[:8] + '...)' if groq_key else 'NO — MISSING!'}")
print(f"[AI SERVICE BOOT] GEMINI_API_KEY loaded: {'YES' if gemini_key else 'NO (no fallback)'}")
print(f"[AI SERVICE BOOT] GROQ_API_KEY length: {len(groq_key)}, contains comma: {',' in groq_key}")

@app.get("/health")
async def health_check():
    return {"status": "ok", "service": "fops-pulse-ai-service", "groq_loaded": bool(groq_key), "key_count": len(groq_key.split(',')) if groq_key else 0}

@app.post("/api/scan-articles")
async def scan_articles(request: Request):
    payload = await request.json()
    articles = payload.get("articles", [])
    profile = payload.get("profile", {})
    alerted_set = payload.get("alertedSet", [])
    
    # TODO: Pass through pipeline
    return {"accepted": [], "rejected": []}

from planner import generate_planner_recommendations

@app.post("/api/analyze-planner")
async def analyze_planner(request: Request):
    payload = await request.json()
    try:
        recommendations = await generate_planner_recommendations(payload)
        return {"success": True, "recommendations": recommendations.get("recommendations", [])}
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"Error generating recommendations: {e}")
        return {"success": False, "recommendations": [], "error": str(e)}

from market_drivers.schema import PipelineInput
from market_drivers.pipeline import run_pipeline

@app.post("/api/market-drivers")
async def market_drivers(request: Request):
    try:
        payload = await request.json()
        pipeline_input = PipelineInput(**payload)
        result = run_pipeline(pipeline_input)
        return {"success": True, **result}
    except Exception as e:
        print(f"Error generating market drivers: {e}")
        return {"success": False, "error": str(e)}

if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
