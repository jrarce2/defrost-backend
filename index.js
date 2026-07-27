require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const { XMLParser } = require('fast-xml-parser');
const fs = require('fs');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const FEEDS = [
  { source: 'Telemundo 52', url: 'https://www.telemundo52.com/noticias/inmigracion/?rss=y' },
  { source: 'Telemundo Chicago', url: 'https://www.telemundochicago.com/noticias/inmigracion/?rss=y' },
  { source: 'Telemundo Miami', url: 'https://www.telemundo51.com/noticias/inmigracion/?rss=y' },
  { source: 'Univision Miami', url: 'https://rss.app/feeds/5Vc9Yh7izwD14izB.xml' },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchArticles(feedUrl, sourceName) {
  const response = await fetch(feedUrl);
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
    source: sourceName,
  }));
}

const cheerio = require('cheerio');

async function fetchFullArticleText(url) {
  try {
    const response = await fetch(url);
    const html = await response.text();
    const $ = cheerio.load(html);

    // Most news sites put the actual article body in <p> tags
    // inside the main content area. This grabs all paragraph text
    // and joins it into one block, ignoring menus/ads/etc.
    const paragraphs = $('article p, main p, .article-body p').text();
    return paragraphs || $('p').text(); // fallback: grab all <p> tags if the specific ones aren't found
  } catch (error) {
    console.log('Could not fetch full article:', error.message);
    return null;
  }
}

async function fetchWikipediaIncidents() {
  const url = 'https://en.wikipedia.org/wiki/List_of_shootings_by_U.S._immigration_agents_in_the_second_Trump_administration';
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Defrost-App/1.0 (personal project)' },
  });
  const html = await response.text();
  const $ = cheerio.load(html);

  const incidents = [];
  const table = $('table.wikitable').first();

  table.find('tbody > tr').each((i, row) => {
    const cells = $(row).find('td');
    if (cells.length < 7) return; // skip header or malformed rows

    const date = $(cells[0]).text().trim();
    const location = $(cells[1]).text().trim();
    const state = $(cells[2]).text().trim();
    const description = $(cells[6]).text().trim();

    if (!date || !description) return;

    incidents.push({
      id: `wiki-${date}-${location}`.replace(/\s+/g, '-'),
      date,
      location,
      state,
      description,
    });
  });

  return incidents;
}

async function analyzeIncidentLocation(incident) {
  const prompt = `You are extracting the most specific location from a record of an ICE/immigration enforcement shooting incident.

Date: ${incident.date}
General location: ${incident.location}, ${incident.state}
Description: ${incident.description}

Answer in this exact JSON format, nothing else:
{"locations": ["specific location"]}

Be as SPECIFIC as possible using only what's actually stated:
- If a street, intersection, business, or landmark is mentioned in the description, combine it with the city/state (e.g. "gas station, Willowbrook, Los Angeles, California")
- If only a neighborhood or city is available, use that with the state
- Do not guess or add details not actually stated
- All locations are in the United States. Always include the U.S. state (e.g. "Florence, Arizona" not just "Florence")`;
  const message = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 200,
    messages: [{ role: 'user', content: prompt }],
  });

  let responseText = message.content[0].text;
  responseText = responseText.replace(/```json\s*/g, '').replace(/```/g, '').trim();

  try {
    return JSON.parse(responseText);
  } catch (e) {
    console.log('Could not parse response:', responseText);
    return { locations: [] };
  }
}

async function analyzeArticle(article) {
  const fullText = await fetchFullArticleText(article.link);
  const contentToAnalyze = fullText || article.excerpt; // fall back to excerpt if full fetch fails

  const prompt = `You are helping identify ICE/immigration enforcement news and exactly where it happened.

Article title: ${article.title}
Article content: ${contentToAnalyze}

Answer in this exact JSON format, nothing else:
{"is_ice_related": true or false, "locations": ["specific location", "specific location"] or []}

Only set is_ice_related to true if this is specifically about an ICE enforcement action, raid, detention, or encounter (not general immigration policy/legislation/visa news).

For locations, be as SPECIFIC as possible using only what's actually stated in the text:
- If a street, intersection, or specific address is mentioned, use that (e.g. "corner of Main St and 5th Ave, Chicago, Illinois")
- If a specific business or landmark is named, include it (e.g. "Home Depot parking lot, Yakima, Washington")
- If only a neighborhood is mentioned, use that (e.g. "Panorama City, Los Angeles, California")
- Only fall back to city, or city+state, if that's genuinely the most specific detail given in the article
- List every distinct place mentioned where something happened — there may be one, several, or none
- Do not guess or add details not actually stated in the text
- All locations are in the United States. Always include the U.S. state, even if the article doesn't explicitly say "USA" (e.g. write "Florence, Arizona" not just "Florence") — use context clues and general knowledge to determine the correct state when it's not explicitly stated`;

  const message = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 400,
    messages: [{ role: 'user', content: prompt }],
  });

  let responseText = message.content[0].text;
  responseText = responseText.replace(/```json\s*/g, '').replace(/```/g, '').trim();

  try {
    return JSON.parse(responseText);
  } catch (e) {
    console.log('Could not parse response:', responseText);
    return { is_ice_related: false, locations: [] };
  }
}

async function geocodeLocation(locationText) {
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(
      locationText
    )}&format=json&limit=1&countrycodes=us`;

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Defrost-App/1.0 (personal project)',
      },
    });

    if (!response.ok) {
      console.log('Geocoding request failed:', response.status);
      return null;
    }

    const results = await response.json();

    if (results.length === 0) {
      return null;
    }

    return {
      latitude: parseFloat(results[0].lat),
      longitude: parseFloat(results[0].lon),
    };
  } catch (error) {
    console.log('Geocoding error for', locationText, '-', error.message);
    return null;
  }
}

async function main() {
  let seenLinks = [];
  if (fs.existsSync('seen-articles.json')) {
    seenLinks = JSON.parse(fs.readFileSync('seen-articles.json'));
  }

  let seenIncidents = [];
  if (fs.existsSync('seen-incidents.json')) {
    seenIncidents = JSON.parse(fs.readFileSync('seen-incidents.json'));
  }

  let pins = [];
  if (fs.existsSync('pins.json')) {
    pins = JSON.parse(fs.readFileSync('pins.json'));
  }

  // --- Existing news feeds ---
  for (const feed of FEEDS) {
    console.log(`\nFetching from ${feed.source}...`);
    const articles = await fetchArticles(feed.url, feed.source);

    for (const article of articles) {
      if (seenLinks.includes(article.link)) {
        console.log('Already processed, skipping:', article.title);
        continue;
      }

      const analysis = await analyzeArticle(article);
      console.log('---');
      console.log('Title:', article.title, `(${article.source})`);
      console.log('ICE-related:', analysis.is_ice_related);
      console.log('Locations:', analysis.locations);

      if (analysis.is_ice_related && analysis.locations && analysis.locations.length > 0) {
        for (const location of analysis.locations) {
          const coords = await geocodeLocation(location);
          console.log(`  → ${location}:`, coords);
          await sleep(1000);

          if (coords) {
            pins.push({
              id: `${pins.length}`,
              title: article.title,
              link: article.link,
              location: location,
              source: article.source,
              latitude: coords.latitude,
              longitude: coords.longitude,
            });
          }
        }
      }

      seenLinks.push(article.link);
    }
  }

  // --- Wikipedia ICE shootings table ---
  console.log('\nFetching Wikipedia ICE shootings table...');
  const incidents = await fetchWikipediaIncidents();

  for (const incident of incidents) {
    if (seenIncidents.includes(incident.id)) {
      continue;
    }

    const analysis = await analyzeIncidentLocation(incident);
    console.log('---');
    console.log('Wikipedia incident:', incident.date, incident.description.slice(0, 80));
    console.log('Locations:', analysis.locations);

    if (analysis.locations && analysis.locations.length > 0) {
      for (const location of analysis.locations) {
        const coords = await geocodeLocation(location);
        console.log(`  → ${location}:`, coords);
        await sleep(1000);
        if (coords) {
          pins.push({
            id: `${pins.length}`,
            title: incident.description,
            link: 'https://en.wikipedia.org/wiki/List_of_shootings_by_U.S._immigration_agents_in_the_second_Trump_administration',
            location: location,
            source: 'Wikipedia ICE Tracker',
            latitude: coords.latitude,
            longitude: coords.longitude,
          });
        }
      }
    }

    seenIncidents.push(incident.id);
  }

  fs.writeFileSync('pins.json', JSON.stringify(pins, null, 2));
  fs.writeFileSync('seen-articles.json', JSON.stringify(seenLinks, null, 2));
  fs.writeFileSync('seen-incidents.json', JSON.stringify(seenIncidents, null, 2));
  console.log(`\nSaved ${pins.length} total pins.`);
}

main();