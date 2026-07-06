import re

def normalize_article(raw_article):
    """Stage 1: Normalize"""
    return {
        "title": raw_article.get("title", ""),
        "description": raw_article.get("description", ""),
        "content": raw_article.get("content", ""),
        "source": raw_article.get("source", ""),
        "url": raw_article.get("url", ""),
        "publishedAt": raw_article.get("publishedAt", "")
    }

def build_watchlist_profile(user_profile):
    """Stage 2: Profile Builder"""
    return {
        "userId": user_profile.get("user_id", user_profile.get("id")),
        "commodities": [c.lower() for c in user_profile.get("commodities", [])],
        "regions": [r.lower() for r in user_profile.get("regions", [])],
        "focus_product": user_profile.get("focus_product", "").lower()
    }

def apply_rule_engine(article, profile):
    """Stage 3: Rule Engine"""
    text = f"{article['title']} {article['description']} {article['content']}".lower()
    
    # Check commodities
    found_commodity = False
    for c in profile["commodities"]:
        if c in text:
            found_commodity = True
            break
            
    if not found_commodity:
        return {"passed": False, "reason": "No commodity terms found", "matchData": {}}
        
    return {"passed": True, "reason": "", "matchData": {}}

def match_region(article, profile):
    """Stage 4: Region Matcher"""
    text = f"{article['title']} {article['description']} {article['content']}".lower()
    matches = []
    for r in profile["regions"]:
        if r in text:
            matches.append(r)
    return {"regionMatches": matches}

def calculate_relevance_score(article, profile, match_data):
    """Stage 5: Relevance Scorer"""
    score = 50 # Baseline
    if match_data.get("regionMatches"):
        score += 20
    return {"score": score, "breakdown": {}}
