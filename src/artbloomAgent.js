const config = require('./config');
const dataStore = require('./dataStore');
const { TOOL_DEFINITIONS, executeTool } = require('./vmTools');

const SYSTEM_PROMPT = `You are the operator for a cloud Linux VM with a real Chrome browser (DISPLAY :100).
You MUST use tools to act — never pretend you did something without calling a tool.

Rules:
- Instagram needs an active session: call vm_check_login first if unsure.
- University "McGill" on Instagram is usually @mcgillu (not mcgill).
- For profile + stories + posts requests: use vm_scrape_instagram with depth 15–20.
- Use few tool calls; batch intent into scrape when possible.
- Reply to the user in plain short English with concrete results (counts, usernames, links).
- Do not output markdown headers or long bullet menus.`;

async function chatCompletion(messages, tools) {
  const url = `${config.artbloomBaseUrl.replace(/\/$/, '')}/chat/completions`;
  const body = {
    model: config.artbloomModel,
    messages,
    tools,
    tool_choice: 'auto',
    max_tokens: 1200,
    temperature: 0.2
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.artbloomTimeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.artbloomApiKey}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Artbloom ${res.status}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text);
}

function messageFromChoice(choice) {
  return choice?.message || {};
}

async function runArtbloomAgent(userMessage) {
  if (!config.artbloomApiKey) {
    return null;
  }

  const accounts = dataStore.getAccountProfiles();
  const accountHint = accounts.length
    ? `Connected accounts: ${accounts.map((a) => `${a.label} (${a.username})`).join(', ')}`
    : 'No saved logins yet — user may need to log in on the live screen.';

  const messages = [
    { role: 'system', content: `${SYSTEM_PROMPT}\n\n${accountHint}` },
    { role: 'user', content: userMessage }
  ];

  const maxRounds = 6;
  let lastTool = null;

  for (let round = 0; round < maxRounds; round++) {
    const data = await chatCompletion(messages, TOOL_DEFINITIONS);
    const choice = data.choices?.[0];
    const msg = messageFromChoice(choice);

    if (msg.tool_calls?.length) {
      messages.push({
        role: 'assistant',
        content: msg.content || null,
        tool_calls: msg.tool_calls
      });

      for (const call of msg.tool_calls) {
        const fn = call.function?.name;
        let args = {};
        try {
          args = JSON.parse(call.function?.arguments || '{}');
        } catch (_) {}

        const result = await executeTool(fn, args);
        lastTool = { name: fn, args, result };
        dataStore.rememberHowToAsk('instagram', {
          title: fn,
          example: userMessage
        });

        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(result).slice(0, 12000)
        });
      }
      continue;
    }

    const text = (msg.content || '').trim();
    if (text) {
      return {
        text,
        action: 'artbloom_agent',
        tool: lastTool?.name,
        data: lastTool?.result
      };
    }
    break;
  }

  return null;
}

module.exports = { runArtbloomAgent };
