import { mkdir, readFile, writeFile } from 'node:fs/promises';

const OUTPUT_PATH = 'data/smart_money.json';
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const TOPICS = [
  { key: 'whales', label: 'Bitcoin Whales' },
  { key: 'hedgeFunds', label: 'Bitcoin Hedge Funds' },
  { key: 'etfs', label: 'Bitcoin ETFs' }
];

function stripCdata(value = '') {
  return value.replaceAll('<![CDATA[', '').replaceAll(']]>', '').trim();
}

function decodeXml(value = '') {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'");
}

function parseGoogleNewsRss(xml = '') {
  const items = [];
  const matches = xml.matchAll(/<item>([\s\S]*?)<\/item>/g);

  for (const match of matches) {
    const itemXml = match[1] || '';
    const titleMatch = itemXml.match(/<title>([\s\S]*?)<\/title>/i);
    const linkMatch = itemXml.match(/<link>([\s\S]*?)<\/link>/i);
    const pubDateMatch = itemXml.match(/<pubDate>([\s\S]*?)<\/pubDate>/i);

    const rawTitle = titleMatch?.[1] || '';
    const title = decodeXml(stripCdata(rawTitle));
    const url = (linkMatch?.[1] || '').trim();
    const publishedAt = pubDateMatch?.[1]?.trim() || '';

    if (!title || !url) continue;
    items.push({ title, url, publishedAt });
  }

  return items;
}

async function fetchTopicArticles(topicLabel) {
  const query = encodeURIComponent(`${topicLabel} Bitcoin when:7d`);
  const url = `https://news.google.com/rss/search?q=${query}&hl=en-US&gl=US&ceid=US:en`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`RSS-Fehler für ${topicLabel}: ${response.status}`);
  }

  const xml = await response.text();
  return parseGoogleNewsRss(xml).slice(0, 8);
}

function buildPrompt(topicArticles) {
  const lines = [];

  for (const topic of TOPICS) {
    lines.push(`${topic.label}:`);
    const articles = topicArticles[topic.key] || [];

    if (articles.length === 0) {
      lines.push('- keine gefundenen Artikel');
      continue;
    }

    articles.forEach((article, index) => {
      lines.push(`${index + 1}. ${article.title} | ${article.publishedAt} | ${article.url}`);
    });
  }

  return `
Du erstellst für ein Bitcoin-Dashboard eine tagesaktuelle, knappe Smart-Money-Zusammenfassung auf Deutsch.

AUFGABE:
- Für jede Kategorie (whales, hedgeFunds, etfs) genau 1-2 Sätze.
- Keine Finanzberatung, nur neutrale Einordnung.
- Nutze nur Informationen aus den bereitgestellten Artikeln.
- Wähle pro Kategorie 1-2 Quellenlinks aus den bereitgestellten Artikeln.
- Wenn zu wenig Informationen vorliegen, schreibe das transparent in 1 Satz.

AUSGABEFORMAT (strict JSON, ohne Markdown):
{
  "segments": {
    "whales": { "summary": "...", "sources": [1,2] },
    "hedgeFunds": { "summary": "...", "sources": [1,2] },
    "etfs": { "summary": "...", "sources": [1,2] }
  }
}

HINWEIS ZU sources:
- sources referenziert die Indexnummern pro Kategorie-Liste separat.
- Maximal zwei Einträge pro Kategorie.

ARTIKEL:
${lines.join('\n')}
`.trim();
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function summarizeWithLlm(topicArticles) {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY ist nicht gesetzt.');
  }

  const response = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: 'Du bist ein präziser Marktanalyst und antwortest ausschließlich mit gültigem JSON.'
        },
        {
          role: 'user',
          content: buildPrompt(topicArticles)
        }
      ]
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`LLM-Request fehlgeschlagen (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  const parsed = safeJsonParse(content);

  if (!parsed?.segments) {
    throw new Error('LLM-Antwort konnte nicht als erwartetes JSON geparst werden.');
  }

  return parsed;
}

function mapSourcesForTopic(topicKey, sourceIndexes, topicArticles) {
  const indexes = Array.isArray(sourceIndexes) ? sourceIndexes.slice(0, 2) : [];
  const articles = topicArticles[topicKey] || [];

  return indexes
    .map((index) => articles[(Number(index) || 0) - 1])
    .filter(Boolean)
    .map((article) => ({ title: article.title, url: article.url }));
}

function buildFallback(existingData) {
  return {
    updatedAt: new Date().toISOString(),
    meta: {
      generator: 'fallback_existing_data',
      model: OPENAI_MODEL,
      notes: 'OPENAI_API_KEY fehlt oder LLM-Update fehlgeschlagen. Vorherige Daten bleiben erhalten.'
    },
    segments: existingData?.segments || {
      whales: { summary: 'Keine aktuellen Daten verfügbar.', links: [] },
      hedgeFunds: { summary: 'Keine aktuellen Daten verfügbar.', links: [] },
      etfs: { summary: 'Keine aktuellen Daten verfügbar.', links: [] }
    }
  };
}

async function loadExistingOutput() {
  try {
    const raw = await readFile(OUTPUT_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function main() {
  const topicArticles = {};

  for (const topic of TOPICS) {
    try {
      topicArticles[topic.key] = await fetchTopicArticles(topic.label);
      console.log(`${topic.label}: ${topicArticles[topic.key].length} Artikel geladen.`);
    } catch (error) {
      console.warn(`${topic.label}: ${error.message}`);
      topicArticles[topic.key] = [];
    }
  }

  const existing = await loadExistingOutput();

  try {
    const llmData = await summarizeWithLlm(topicArticles);

    const output = {
      updatedAt: new Date().toISOString(),
      meta: {
        generator: 'scripts/update-smart-money.mjs',
        model: OPENAI_MODEL,
        source: 'Google News RSS + LLM-Zusammenfassung'
      },
      segments: {
        whales: {
          summary: llmData.segments.whales?.summary || 'Keine aktuellen Daten verfügbar.',
          links: mapSourcesForTopic('whales', llmData.segments.whales?.sources, topicArticles)
        },
        hedgeFunds: {
          summary: llmData.segments.hedgeFunds?.summary || 'Keine aktuellen Daten verfügbar.',
          links: mapSourcesForTopic('hedgeFunds', llmData.segments.hedgeFunds?.sources, topicArticles)
        },
        etfs: {
          summary: llmData.segments.etfs?.summary || 'Keine aktuellen Daten verfügbar.',
          links: mapSourcesForTopic('etfs', llmData.segments.etfs?.sources, topicArticles)
        }
      }
    };

    await mkdir('data', { recursive: true });
    await writeFile(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
    console.log(`Aktualisiert: ${OUTPUT_PATH}`);
  } catch (error) {
    console.warn(`Smart-Money-Update fehlgeschlagen: ${error.message}`);

    if (!existing) {
      const fallback = buildFallback(null);
      await mkdir('data', { recursive: true });
      await writeFile(OUTPUT_PATH, `${JSON.stringify(fallback, null, 2)}\n`, 'utf8');
      console.log(`Fallback angelegt: ${OUTPUT_PATH}`);
      return;
    }

    const fallback = buildFallback(existing);
    await writeFile(OUTPUT_PATH, `${JSON.stringify(fallback, null, 2)}\n`, 'utf8');
    console.log(`Bestehende Daten behalten: ${OUTPUT_PATH}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
