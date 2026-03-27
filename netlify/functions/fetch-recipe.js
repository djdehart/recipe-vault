const https = require("https");
const http = require("http");
 
exports.handler = async function (event) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Content-Type": "application/json",
  };
 
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }
 
  let url, manual, manualText;
  try {
    const body = JSON.parse(event.body || "{}");
    url = body.url;
    manual = body.manual;
    manualText = body.manualText;
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid request" }) };
  }
 
  // ── Manual entry path ─────────────────────────────────────────────────────
  if (manual && manualText) {
    try {
      const aiResponse = await callClaude(buildPrompt(url || "", "", manualText));
      let parsed = parseJSON(aiResponse);
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, image: "", ...parsed }) };
    } catch (err) {
      return { statusCode: 200, headers, body: JSON.stringify({ success: false, error: err.message }) };
    }
  }
 
  if (!url || !url.startsWith("http")) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid URL" }) };
  }
 
  // ── Fetch the page ────────────────────────────────────────────────────────
  let rawHtml = "";
  let imageUrl = "";
  try {
    const result = await fetchUrl(url);
    rawHtml = result.html;
    imageUrl = result.image;
  } catch (err) {
    rawHtml = "";
  }
 
  // ── Approach 1: JSON-LD structured data ───────────────────────────────────
  let jsonLdRecipe = null;
  if (rawHtml) {
    jsonLdRecipe = extractJsonLd(rawHtml);
  }
 
  // ── Approach 2: Raw text for Claude ───────────────────────────────────────
  const pageText = rawHtml
    ? rawHtml
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 10000)
    : "";
 
  // ── Decide what to send Claude ────────────────────────────────────────────
  // If JSON-LD gave us ingredients AND instructions, use it directly
  if (
    jsonLdRecipe &&
    jsonLdRecipe.ingredients &&
    jsonLdRecipe.ingredients.length > 0 &&
    jsonLdRecipe.instructions &&
    jsonLdRecipe.instructions.length > 0
  ) {
    try {
      // Still call Claude for tagging, but seed it with the clean JSON-LD data
      const seedText = `Title: ${jsonLdRecipe.title || ""}
Description: ${jsonLdRecipe.description || ""}
Ingredients: ${jsonLdRecipe.ingredients.join(", ")}
Instructions: ${jsonLdRecipe.instructions.join(". ")}
Total Time: ${jsonLdRecipe.totalTime || ""}
Servings: ${jsonLdRecipe.servings || ""}`;
 
      const aiResponse = await callClaude(buildPrompt(url, "", seedText));
      const parsed = parseJSON(aiResponse);
 
      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          success: true,
          image: imageUrl || jsonLdRecipe.image || "",
          title: jsonLdRecipe.title || parsed.title || urlToTitle(url),
          description: jsonLdRecipe.description || parsed.description || "",
          servings: jsonLdRecipe.servings || parsed.servings || "",
          prepTime: jsonLdRecipe.prepTime || parsed.prepTime || "",
          cookTime: jsonLdRecipe.cookTime || parsed.cookTime || "",
          totalTime: jsonLdRecipe.totalTime || parsed.totalTime || "",
          difficulty: parsed.difficulty || "",
          ingredients: jsonLdRecipe.ingredients,
          instructions: jsonLdRecipe.instructions,
          notes: parsed.notes || "",
          tags: parsed.tags || { methods: [], proteins: [], cuisines: [], diets: [], mainIngredients: [], types: [] }
        })
      };
    } catch (err) {
      // Fall through to raw text approach
    }
  }
 
  // ── Fall back to raw text approach ────────────────────────────────────────
  // If JSON-LD gave us partial data, include it as a hint to Claude
  let contextText = pageText;
  if (jsonLdRecipe) {
    const hint = [
      jsonLdRecipe.title ? `Title: ${jsonLdRecipe.title}` : "",
      jsonLdRecipe.description ? `Description: ${jsonLdRecipe.description}` : "",
      jsonLdRecipe.ingredients?.length ? `Ingredients hint: ${jsonLdRecipe.ingredients.join(", ")}` : "",
      jsonLdRecipe.instructions?.length ? `Instructions hint: ${jsonLdRecipe.instructions.join(". ")}` : "",
    ].filter(Boolean).join("\n");
    if (hint) contextText = hint + "\n\n" + pageText;
  }
 
  try {
    const aiResponse = await callClaude(buildPrompt(url, contextText, ""));
    const parsed = parseJSON(aiResponse);
    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        success: true,
        image: imageUrl || jsonLdRecipe?.image || "",
        title: parsed.title || jsonLdRecipe?.title || urlToTitle(url),
        description: parsed.description || jsonLdRecipe?.description || "",
        servings: parsed.servings || jsonLdRecipe?.servings || "",
        prepTime: parsed.prepTime || jsonLdRecipe?.prepTime || "",
        cookTime: parsed.cookTime || jsonLdRecipe?.cookTime || "",
        totalTime: parsed.totalTime || jsonLdRecipe?.totalTime || "",
        difficulty: parsed.difficulty || "",
        ingredients: parsed.ingredients?.length ? parsed.ingredients : (jsonLdRecipe?.ingredients || []),
        instructions: parsed.instructions?.length ? parsed.instructions : (jsonLdRecipe?.instructions || []),
        notes: parsed.notes || "",
        tags: parsed.tags || { methods: [], proteins: [], cuisines: [], diets: [], mainIngredients: [], types: [] }
      })
    };
  } catch (err) {
    return { statusCode: 200, headers, body: JSON.stringify({ success: false, error: err.message }) };
  }
};
 
// ── JSON-LD extractor ─────────────────────────────────────────────────────────
function extractJsonLd(html) {
  try {
    const scripts = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
    for (const match of scripts) {
      try {
        const data = JSON.parse(match[1]);
        const recipes = findRecipes(data);
        if (recipes.length > 0) return normalizeRecipe(recipes[0]);
      } catch {}
    }
  } catch {}
  return null;
}
 
function findRecipes(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data.flatMap(findRecipes);
  if (data["@type"] === "Recipe") return [data];
  if (Array.isArray(data["@type"]) && data["@type"].includes("Recipe")) return [data];
  if (data["@graph"]) return findRecipes(data["@graph"]);
  return [];
}
 
function normalizeRecipe(r) {
  // Ingredients
  const ingredients = (r.recipeIngredient || []).map(i => String(i).trim()).filter(Boolean);
 
  // Instructions — can be string, array of strings, or array of HowToStep objects
  let instructions = [];
  const raw = r.recipeInstructions || [];
  if (typeof raw === "string") {
    instructions = raw.split(/\n+/).map(s => s.trim()).filter(Boolean);
  } else if (Array.isArray(raw)) {
    instructions = raw.map(step => {
      if (typeof step === "string") return step.trim();
      if (step.text) return step.text.trim();
      if (step.itemListElement) return step.itemListElement.map(s => s.text || s).join(" ");
      return "";
    }).filter(Boolean);
  }
 
  // Times — ISO 8601 duration to human readable
  const totalTime = parseDuration(r.totalTime);
  const prepTime = parseDuration(r.prepTime);
  const cookTime = parseDuration(r.cookTime);
 
  // Servings
  const servings = r.recipeYield
    ? (Array.isArray(r.recipeYield) ? r.recipeYield[0] : r.recipeYield).toString()
    : "";
 
  // Image
  let image = "";
  if (r.image) {
    if (typeof r.image === "string") image = r.image;
    else if (r.image.url) image = r.image.url;
    else if (Array.isArray(r.image) && r.image[0]) image = typeof r.image[0] === "string" ? r.image[0] : r.image[0].url || "";
  }
 
  return {
    title: r.name || "",
    description: r.description || "",
    ingredients, instructions,
    totalTime, prepTime, cookTime, servings, image
  };
}
 
function parseDuration(iso) {
  if (!iso) return "";
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/i);
  if (!match) return iso;
  const h = parseInt(match[1] || 0);
  const m = parseInt(match[2] || 0);
  if (h && m) return `${h} hr ${m} min`;
  if (h) return `${h} hour${h > 1 ? "s" : ""}`;
  if (m) return `${m} minutes`;
  return "";
}
 
// ── Claude prompt builder ─────────────────────────────────────────────────────
function buildPrompt(url, pageText, seedText) {
  const content = seedText || pageText || "";
  return `Extract the recipe from this webpage (URL: ${url || "unknown"}) and return ONLY valid JSON with no markdown or explanation:
{
  "title": "Recipe name",
  "description": "Brief description",
  "servings": "4 servings",
  "prepTime": "15 minutes",
  "cookTime": "30 minutes",
  "totalTime": "45 minutes",
  "difficulty": "Easy",
  "ingredients": ["1 cup flour", "2 eggs"],
  "instructions": ["Step 1", "Step 2"],
  "notes": "Tips if any, else empty string",
  "tags": {
    "methods": [],
    "proteins": [],
    "cuisines": [],
    "diets": [],
    "mainIngredients": [],
    "types": []
  }
}
For tags, only pick from these values:
- methods: slow cooker, instant pot, grill, stovetop, oven, air fryer, no-cook, smoker, pressure cooker
- proteins: chicken, beef, pork, lamb, seafood, fish, shrimp, tofu, eggs, turkey, vegetarian, vegan
- cuisines: Italian, Mexican, Asian, American, Mediterranean, Indian, French, Thai, Chinese, Japanese, Greek, Middle Eastern
- diets: gluten-free, dairy-free, low-carb, keto, paleo, vegetarian, vegan, whole30
- mainIngredients: pasta, rice, potatoes, beans, mushrooms, tomatoes, cheese, bread, lentils, corn, zucchini
- types: main dish, side dish, appetizer, dessert, beverage, cocktail, smoothie, soup, salad, breakfast, snack, sauce
Only include tags that genuinely apply. Empty arrays are fine.
${content ? "Content:\n" + content : "Note: page could not be fetched. Use the URL to infer what you can."}`;
}
 
// ── Parse Claude JSON response ────────────────────────────────────────────────
function parseJSON(text) {
  try {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
  } catch {}
  return {};
}
 
// ── Fetch page ────────────────────────────────────────────────────────────────
function fetchUrl(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error("Too many redirects"));
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, {
      timeout: 12000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "identity",
      }
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const next = res.headers.location.startsWith("http")
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        return fetchUrl(next, redirectCount + 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      let data = "";
      res.on("data", chunk => { data += chunk; if (data.length > 800000) req.destroy(); });
      res.on("end", () => {
        let image = "";
        const ogImg = data.match(/property=["']og:image["'][^>]*content=["']([^"']+)["']/i)
                   || data.match(/content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
        if (ogImg) image = ogImg[1];
        resolve({ html: data, image });
      });
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("Timed out")); });
    req.on("error", reject);
  });
}
 
// ── Call Claude API ───────────────────────────────────────────────────────────
function callClaude(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }]
    });
    const req = https.request({
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      timeout: 25000,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "x-api-key": process.env.ANTHROPIC_API_KEY || "",
        "anthropic-version": "2023-06-01",
      }
    }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          const text = parsed?.content?.[0]?.text || "";
          if (!text) return reject(new Error("Empty AI response: " + JSON.stringify(parsed)));
          resolve(text);
        } catch (e) {
          reject(new Error("Failed to parse AI response: " + data.slice(0, 200)));
        }
      });
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("Claude API timed out")); });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}
 
// ── Helpers ───────────────────────────────────────────────────────────────────
function urlToTitle(url) {
  try {
    const p = new URL(url).pathname.split("/").filter(Boolean).pop() || "";
    return p.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase()).replace(/\d+$/, "").trim() || "Recipe";
  } catch { return "Recipe"; }
}
 
