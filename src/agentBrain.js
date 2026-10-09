const config = require('./config');
const dataStore = require('./dataStore');
const { runArtbloomAgent } = require('./artbloomAgent');
const { runLocalVmAgent } = require('./localVmAgent');
const { parseIntent } = require('./intentParser');

let artbloomDisabledUntil = 0;

class AgentBrain {
  /**
   * Every user message must result in VM actions — never a static help menu.
   * Try Artbloom when the key works; otherwise local planner always runs tools.
   */
  async processMessage(userMessage) {
    const raw = (userMessage || '').trim();
    if (!raw) {
      return { text: 'Say what to do on the VM (site, profile, or task).', action: 'empty' };
    }

    const intent = parseIntent(raw);
    const skipLlm =
      intent.discoverProfiles || (intent.platform === 'instagram' && intent.targets.length > 2);

    if (!skipLlm && config.artbloomApiKey && Date.now() > artbloomDisabledUntil) {
      try {
        const llm = await runArtbloomAgent(raw);
        if (llm && llm.action !== 'artbloom_agent_incomplete' && llm.text) {
          dataStore.rememberHowToAsk('instagram', { title: 'AI task', example: raw });
          return llm;
        }
      } catch (err) {
        if (/model_not_permitted|403/.test(err.message)) {
          artbloomDisabledUntil = Date.now() + 60 * 60 * 1000;
        }
        console.error('[agent] Artbloom unavailable, using local VM agent:', err.message);
      }
    }

    const result = await runLocalVmAgent(raw);
    dataStore.rememberHowToAsk('instagram', { title: 'Task', example: raw });
    return result;
  }
}

module.exports = new AgentBrain();
