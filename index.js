require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const { XMLParser } = require('fast-xml-parser');
const fs = require('fs');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const FEED_URL = 'https://www.telemundo52.com/noticias/inmigracion/?rss=y';

async function fetchArticles() {
  const response = await fetch(FEED_URL);
  const xmlText = await response.text();

  const parser = new XMLParser({ ignoreAttributes: false });
  const result = parser.parse(xmlText);

  let items = result.rss.channel.item || [];
  if (!Array.isArray(items)) {
    items = [items];
  }

  return items.map((item) => ({
    title: item.title,
    link: item.link,
    excerpt: item.excerpt || '',
  }));
}

async function analyzeArticle(article) {
  const prompt = `You are helping identify ICE/immigration enforcement news and where it happened.

Article title: ${article.title}
Article excerpt: ${article.excerpt}

Answer in this exact JSON format, nothing else:
{"is_ice_related": true or false, "locations": ["city, state", "city, state"] or []}

Only set is_ice_related to true if this is specifically about an ICE enforcement action, raid, detention, or encounter (not general immigration policy/legislation/visa news). List every distinct specific place mentioned in the text where something happened — there may be one, several, or none.`;

  const message = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 200,
    messages: [{ role: 'user', content: prompt }],
  });

  let responseText = message.content[0].text;

  // Strip markdown code fences if Claude includes them
  responseText = responseText.replace(/```json\s*/g, '').replace(/```/g, '').trim();

  try {
    return JSON.parse(responseText);
  } catch (e) {
    console.log('Could not parse response:', responseText);
    return { is_ice_related: false, location: null };
  }
}

async function geocodeLocation(locationText) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(
    locationText
  )}&format=json&limit=1`;

  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Defrost-App/1.0 (personal project)',
    },
  });

  const results = await response.json();

  if (results.length === 0) {
    return null;
  }

  return {
    latitude: parseFloat(results[0].lat),
    longitude: parseFloat(results[0].lon),
  };
}

async function main() {
  // Load what we've already processed (if this file doesn't exist yet, start empty)
  let seenLinks = [];
  if (fs.existsSync('seen-articles.json')) {
    seenLinks = JSON.parse(fs.readFileSync('seen-articles.json'));
  }

  // Load existing pins (if any) instead of starting from scratch
  let pins = [];
  if (fs.existsSync('pins.json')) {
    pins = JSON.parse(fs.readFileSync('pins.json'));
  }

  console.log('Fetching articles...\n');
  const articles = await fetchArticles();

  for (const article of articles) {
    if (seenLinks.includes(article.link)) {
      console.log('Already processed, skipping:', article.title);
      continue; // skip to the next article
    }

    const analysis = await analyzeArticle(article);
    console.log('---');
    console.log('Title:', article.title);
    console.log('ICE-related:', analysis.is_ice_related);
    console.log('Locations:', analysis.locations);

    if (analysis.is_ice_related && analysis.locations && analysis.locations.length > 0) {
      for (const location of analysis.locations) {
        const coords = await geocodeLocation(location);
        console.log(`  → ${location}:`, coords);

        if (coords) {
          pins.push({
            id: `${pins.length}`,
            title: article.title,
            link: article.link,
            location: location,
            latitude: coords.latitude,
            longitude: coords.longitude,
          });
        }
      }
    }

    // Mark this article as processed, regardless of whether it became a pin
    seenLinks.push(article.link);
  }

  fs.writeFileSync('pins.json', JSON.stringify(pins, null, 2));
  fs.writeFileSync('seen-articles.json', JSON.stringify(seenLinks, null, 2));
  console.log(`\nSaved ${pins.length} total pins. ${seenLinks.length} articles tracked as seen.`);
}

main();