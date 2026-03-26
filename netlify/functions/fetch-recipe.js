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

  let url;
  try {
    const body = JSON.parse(event.body || "{}");
    url = body.url;
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid request" }) };
  }

  if (!url || !url.startsWith("http")) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid URL" }) };
  }

  // Step 1: Fetch the page
  let pageText = "";
  let imageUrl = "";
  try {
    const result = await fetchUrl(url);
    pageText = result.text;
    imageUrl = result.image;
  } catch (err) {
    pageText = "";
  }

  // Step 2: Call Claude API server-side
  const prompt = `Extract the recipe from this webpage (URL: ${url}) and return ONLY valid JSON with no markdown or explanation:
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
    "mainIngredients": []
  }
}
For tags, only pick from these values:
- methods: slow cooker, instant pot, grill, stovetop, oven, air fryer, no-cook, smoker, pressure cooker
- proteins: chicken, beef, pork, lamb, seafood, fish, shrimp, tofu, eggs, turkey, vegetarian, vegan
- cuisines: Italian, Mexican, Asian, American, Mediterranean, Indian, French, Thai, Chinese, Japanese, Greek, Middle Eastern
- diets: gluten-free, dairy-free, low-carb, keto, paleo, vegetarian, vegan, whole30
- mainIngredients: pasta, rice, potatoes, beans, mushrooms, tomatoes, cheese, bread, lentils, corn, zucchini
Only include tags that genuinely apply. Empty arrays are fine.
${pageText ? "Webpage text:\n" + pageText : "Note: page could not be fetched. Use the URL to infer what you can."}`;

  try {
    const aiResponse = await callClaude(prompt);
    let parsed = {};
    try {
      const m = aiResponse.match(/\{[\s\S]*\}/);
      if (m) parsed = JSON.parse(m[0]);
    } catch {}

    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        success: true,
        image: imageUrl,
        title: parsed.title || urlToTitle(url),
        description: parsed.description || "",
        servings: parsed.servings || "",
        prepTime: parsed.prepTime || "",
        cookTime: parsed.cookTime || "",
        totalTime: parsed.totalTime || "",
        difficulty: parsed.difficulty || "",
        ingredients: parsed.ingredients || [],
        instructions: parsed.instructions || [],
        notes: parsed.notes || "",
        tags: {
          methods: [],
          proteins: [],
          cuisines: [],
          diets: [],
          mainIngredients: [],
          ...(parsed.tags || {})
        }
      })
    };
  } catch (err) {
    return {
      statusCode: 200, headers,
      body: JSON.stringify({ success: false, error: err.message })
    };
  }
};

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
      res.on("data", chunk => { data += chunk; if (data.length > 600000) req.destroy(); });
      res.on("end", () => {
        let image = "";
        const ogImg = data.match(/property=["']og:image["'][^>]*content=["']([^"']+)["']/i)
                   || data.match(/content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
        if (ogImg) image = ogImg[1];
        const text = data
          .replace(/<script[\s\S]*?<\/script>/gi, "")
          .replace(/<style[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 10000);
        resolve({ text, image });
      });
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("Timed out")); });
    req.on("error", reject);
  });
}

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
        "anthropic-version": "2023-06-01",
      }
    }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          const text = parsed?.content?.[0]?.text || "";
          if (!text) return reject(new Error("Empty AI response"));
          resolve(text);
        } catch (e) {
          reject(new Error("Failed to parse AI response"));
        }
      });
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("Claude API timed out")); });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function urlToTitle(url) {
  try {
    const p = new URL(url).pathname.split("/").filter(Boolean).pop() || "";
    return p.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase()).replace(/\d+$/, "").trim() || "Recipe";
  } catch { return "Recipe"; }
}
