#!/usr/bin/env node
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const boxdClient = require('../boxdClient');
const scraperEngine = require('../scraperEngine');
const dataStore = require('../dataStore');
const config = require('../config');
const screenAnalyzer = require('../screenAnalyzer');
const agentBrain = require('../agentBrain');
const { vmBrowserExec, vmScreenshot } = require('../vmBrowserExec');

const MCP_INSTRUCTIONS = `You operate a real Boxd cloud Linux VM with a live Chrome browser (DISPLAY :100).

When the user asks to do anything on a website (login, Instagram, scrape profiles, stories, posts, click, type, navigate, collect data):
1. Call vm_do with their message exactly as they wrote it. This runs the task on the VM (fast scrape + Artbloom tools).
2. Only use browser_input / browser_screenshot for fine-grained mouse/keyboard if vm_do is not enough.
3. Never tell the user to "use the web dashboard" — you execute on the VM for them.
4. Parse any @handles or org names (e.g. McGill, NASA, NatGeo); plural "profiles" expands to known related accounts. Results return structured payload for the UI/API.
5. Check check_login_status before scraping if unsure.`;

function formatVmDoResult(response) {
  const payload = {
    ok: true,
    action: response.action,
    message: response.text,
    itemCount: response.data?.count ?? response.data?.items?.length,
    requiresLogin: response.data?.requiresLogin,
    profile: response.data?.profile
      ? {
          username: response.data.profile.username,
          bio: String(response.data.profile.bio || '').slice(0, 400),
          hasActiveStory: response.data.profile.hasActiveStory,
          highlights: response.data.profile.highlights?.slice?.(0, 8)
        }
      : undefined,
    sampleItems: response.data?.items?.slice?.(0, 5),
    payload: response.payload
  };
  return JSON.stringify(payload, null, 2);
}

// Create MCP server
const server = new Server(
  {
    name: 'boxd-vps-mcp-wrapper',
    version: '1.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
    instructions: MCP_INSTRUCTIONS,
  }
);

// Define available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'vm_do',
        description:
          'PRIMARY TOOL for Cursor: run the user\'s natural-language command on the cloud VM browser (navigate, login flows, Instagram scrape, screen read, collect data). Pass their words verbatim.',
        inputSchema: {
          type: 'object',
          properties: {
            command: {
              type: 'string',
              description: 'The user\'s full request, copied as they said it.'
            }
          },
          required: ['command']
        }
      },
      {
        name: 'boxd_vm_info',
        description: 'Get details about the Boxd cloud VM (status, specifications, public URL, and live interactive desktop URL).',
        inputSchema: {
          type: 'object',
          properties: {
            vmName: {
              type: 'string',
              description: 'Optional VM name. Defaults to current active VM.'
            }
          }
        }
      },
      {
        name: 'boxd_vm_exec',
        description: 'Execute a bash command directly inside the Boxd cloud Linux VM as root/boxd user.',
        inputSchema: {
          type: 'object',
          properties: {
            command: {
              type: 'string',
              description: 'The shell command to execute inside the VM.'
            },
            timeoutMs: {
              type: 'number',
              description: 'Timeout in milliseconds (default 60000).'
            }
          },
          required: ['command']
        }
      },
      {
        name: 'browser_open',
        description: 'Opens a URL in the VM persistent browser (e.g. Instagram login, target profiles, or web pages).',
        inputSchema: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description: 'The URL to open in the browser.'
            },
            platform: {
              type: 'string',
              description: 'Optional platform name (e.g. instagram, twitter, linkedin) to launch login flow.'
            }
          }
        }
      },
      {
        name: 'browser_screenshot',
        description: 'Takes a real-time screenshot of the current page or a specified URL inside the VM browser. Returns page title and visual base64 image.',
        inputSchema: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description: 'Optional URL to navigate to before taking the screenshot.'
            }
          }
        }
      },
      {
        name: 'check_login_status',
        description: 'Check if a specific platform (e.g. instagram, twitter, linkedin) has an active, authenticated session in the VM browser.',
        inputSchema: {
          type: 'object',
          properties: {
            platform: {
              type: 'string',
              description: 'The platform to check (instagram, twitter, linkedin).'
            }
          },
          required: ['platform']
        }
      },
      {
        name: 'scrape_target',
        description: 'Run targeted autonomous data extraction on a logged-in platform (e.g. Instagram profile/posts) without needing official API keys. Extracts text, images, video links, metrics, and saves them to the web dashboard.',
        inputSchema: {
          type: 'object',
          properties: {
            platform: {
              type: 'string',
              description: 'Target platform: "instagram" | "twitter" | "web".',
              default: 'instagram'
            },
            target: {
              type: 'string',
              description: 'Target username (e.g. "natgeo" or "openai"), hashtag, or direct post URL.'
            },
            dataTypes: {
              type: 'array',
              items: { type: 'string' },
              description: 'Types of data to extract: ["text", "images", "videos", "metrics"].'
            },
            depth: {
              type: 'number',
              description: 'Number of items to extract (e.g. 5, 10, 25). Default is 10.'
            }
          },
          required: ['target']
        }
      },
      {
        name: 'get_collected_data',
        description: 'Query all structured data items collected by the VM scraper (posts, captions, image URLs, video URLs, metrics).',
        inputSchema: {
          type: 'object',
          properties: {
            platform: {
              type: 'string',
              description: 'Filter by platform ("instagram", "all", etc.).'
            },
            type: {
              type: 'string',
              description: 'Filter by data type ("image", "video", "text", "all").'
            },
            search: {
              type: 'string',
              description: 'Keyword search query matching captions or authors.'
            }
          }
        }
      },
      {
        name: 'list_saved_sessions',
        description: 'List all accounts and sessions currently authenticated in the VM browser environment.',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'browser_input',
        description: 'Click coordinates (x, y), type text, press keys, or scroll directly inside the VM browser without opening popups.',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              description: 'Action type: "click" | "type" | "key" | "scroll".'
            },
            x: { type: 'number', description: 'X coordinate for click.' },
            y: { type: 'number', description: 'Y coordinate for click.' },
            text: { type: 'string', description: 'Text to type into focused element.' },
            key: { type: 'string', description: 'Key to press (e.g. "Enter", "Tab", "BackSpace").' },
            dy: { type: 'number', description: 'Scroll delta.' }
          },
          required: ['action']
        }
      },
      {
        name: 'screen_analyze',
        description: 'Analyze the current screen and DOM on the VM to detect login forms, input fields, 2FA code checkpoints, and session status.',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'agent_chat',
        description: 'Send a natural language instruction to the autonomous VM agent (e.g. "Scrape 5 posts from @natgeo", "Check if logged in", "What is on the screen").',
        inputSchema: {
          type: 'object',
          properties: {
            message: {
              type: 'string',
              description: 'Natural language command or question for the AI agent.'
            }
          },
          required: ['message']
        }
      },
      {
        name: 'import_session_cookies',
        description: 'Import session cookies (sessionid, ds_user_id, or JSON array) to authenticate without password / 2FA prompts.',
        inputSchema: {
          type: 'object',
          properties: {
            platform: {
              type: 'string',
              description: 'Target platform: "instagram" | "twitter" | "linkedin".',
              default: 'instagram'
            },
            cookies: {
              type: 'string',
              description: 'Raw sessionid string (e.g. "12345%3A..."), cookie header string, or JSON array.'
            }
          },
          required: ['cookies']
        }
      },
      {
        name: 'configure_proxy',
        description: 'Configure an HTTP/HTTPS/SOCKS5 or residential proxy on the VM browser to mask datacenter IP.',
        inputSchema: {
          type: 'object',
          properties: {
            proxyUrl: {
              type: 'string',
              description: 'Proxy URL (e.g. "http://user:pass@host:port" or "socks5://host:port"). Leave empty to clear.'
            }
          }
        }
      }
    ]
  };
});

// Handle tool executions
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'boxd_vm_info': {
        const vmName = args.vmName || config.defaultVmName;
        const machine = await boxdClient.getMachine(vmName);
        if (!machine) {
          return {
            content: [{ type: 'text', text: `VM "${vmName}" not found.` }]
          };
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  id: machine.id,
                  name: machine.name,
                  status: machine.status,
                  url: machine.access?.url,
                  desktopUrl: machine.access?.desktopUrl,
                  sshPort: machine.access?.sshPort,
                  vcpu: machine.resources?.vcpu || 2,
                  ram: '8 GB',
                  disk: '100 GB'
                },
                null,
                2
              )
            }
          ]
        };
      }

      case 'boxd_vm_exec': {
        const { command, timeoutMs } = args;
        const res = await boxdClient.exec(command, undefined, timeoutMs || 60000);
        return {
          content: [
            {
              type: 'text',
              text: `Exit Code: ${res.exitCode}\n\nSTDOUT:\n${res.stdout}\n\nSTDERR:\n${res.stderr}`
            }
          ]
        };
      }

      case 'browser_open': {
        if (args.platform) {
          const res = await scraperEngine.openLoginWindow(args.platform);
          return {
            content: [
              {
                type: 'text',
                text: `Launched login page for ${args.platform} on VM display.\nDesktop URL to interact: https://app.boxd.sh/desktop/${config.defaultVmName}`
              }
            ]
          };
        } else if (args.url) {
          const cmd = `python3 /home/boxd/vm_agent_controller.py screenshot --url "${args.url}"`;
          const res = await boxdClient.exec(cmd, undefined, 60000);
          return {
            content: [{ type: 'text', text: `Opened ${args.url} in VM browser: ${res.stdout.slice(0, 300)}` }]
          };
        }
        return {
          content: [{ type: 'text', text: 'Please provide either url or platform parameter.' }]
        };
      }

      case 'browser_screenshot': {
        const urlArg = args.url ? `--url "${args.url}"` : '';
        const cmd = `python3 /home/boxd/vm_agent_controller.py screenshot ${urlArg}`;
        const res = await boxdClient.exec(cmd, undefined, 60000);
        let parsed = {};
        try { parsed = JSON.parse(res.stdout); } catch (e) { parsed = { raw: res.stdout }; }
        
        return {
          content: [
            {
              type: 'text',
              text: `Page Title: ${parsed.title || 'N/A'}\nURL: ${parsed.url || 'N/A'}\nScreenshot captured (Base64 length: ${parsed.screenshot ? parsed.screenshot.length : 0}).`
            }
          ]
        };
      }

      case 'check_login_status': {
        const status = await scraperEngine.verifyLogin(args.platform);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(status, null, 2)
            }
          ]
        };
      }

      case 'scrape_target': {
        const platform = args.platform || 'instagram';
        const depth = args.depth || 12;
        if (platform === 'instagram') {
          const parsed = await scraperEngine.scrapeDirect({
            platform: 'instagram',
            target: args.target,
            depth,
            dataTypes: args.dataTypes || ['text', 'images', 'videos', 'metrics']
          });
          return {
            content: [{ type: 'text', text: JSON.stringify(parsed, null, 2) }]
          };
        }
        const job = await scraperEngine.runJob({
          platform,
          target: args.target,
          dataTypes: args.dataTypes || ['text', 'images', 'videos', 'metrics'],
          depth
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ jobId: job.id, status: job.status, message: 'Job started on VM' }, null, 2)
            }
          ]
        };
      }

      case 'get_collected_data': {
        const items = dataStore.getItems(args);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  totalCount: items.length,
                  items: items
                },
                null,
                2
              )
            }
          ]
        };
      }

      case 'list_saved_sessions': {
        const sessions = dataStore.getSessions();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(sessions, null, 2)
            }
          ]
        };
      }

      case 'browser_input': {
        const { action, x, y, text, key, dy } = args;
        if (action === 'click') {
          const clickX = Math.round(Number(x));
          const clickY = Math.round(Number(y));
          await vmBrowserExec(
            `agent-browser mouse move ${clickX} ${clickY} && agent-browser mouse down left && agent-browser mouse up left`,
            15000
          );
        } else if (action === 'type') {
          const safeText = (text || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
          await vmBrowserExec(`agent-browser keyboard type "${safeText}"`, 20000);
        } else if (action === 'key') {
          const safeKey = (key || 'Return').replace(/[^a-zA-Z0-9_+ -]/g, '');
          await vmBrowserExec(`agent-browser press ${safeKey}`, 12000);
        } else if (action === 'scroll') {
          const delta = Math.round(Number(dy) || 300);
          await vmBrowserExec(`agent-browser mouse wheel ${delta}`, 12000);
        }

        const parsed = await vmScreenshot(30000);
        return {
          content: [
            {
              type: 'text',
              text: `Action "${action}" executed. Current URL: ${parsed.url}, Title: ${parsed.title}`
            }
          ]
        };
      }

      case 'screen_analyze': {
        const analysis = await screenAnalyzer.analyzePage();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(analysis, null, 2)
            }
          ]
        };
      }

      case 'vm_do':
      case 'agent_chat': {
        const command = args.command || args.message;
        const response = await agentBrain.processMessage(command);
        return {
          content: [
            {
              type: 'text',
              text: formatVmDoResult(response)
            }
          ]
        };
      }

      case 'import_session_cookies': {
        const { platform = 'instagram', cookies } = args;
        const safeCookies = typeof cookies === 'object' ? JSON.stringify(cookies) : String(cookies);
        const b64 = Buffer.from(safeCookies, 'utf8').toString('base64');
        const cmd = `python3 /home/boxd/vm_agent_controller.py import-cookies "${platform}" "$(echo '${b64}' | base64 -d)"`;
        const result = await boxdClient.exec(cmd, undefined, 60000);
        let parsed = {};
        try {
          const jsonMatch = result.stdout.match(/\{[\s\S]*\}/);
          if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
        } catch (_) {}

        if (parsed.connected) {
          dataStore.setSession(platform, {
            connected: true,
            username: parsed.username,
            lastVerified: new Date().toISOString(),
            cookieCount: parsed.cookieCount
          });
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ success: true, platform, ...parsed }, null, 2)
            }
          ]
        };
      }

      case 'configure_proxy': {
        const { proxyUrl } = args;
        const cmd = `python3 /home/boxd/vm_agent_controller.py set-proxy "${proxyUrl || ''}"`;
        const result = await boxdClient.exec(cmd, undefined, 30000);
        let parsed = { success: true, message: 'Proxy updated' };
        try { parsed = JSON.parse(result.stdout); } catch (_) {}
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(parsed, null, 2)
            }
          ]
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `Tool execution failed: ${error.message}`
        }
      ]
    };
  }
});

async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Boxd VPS MCP Server running on stdio');
}

if (require.main === module) {
  run().catch((err) => {
    console.error('Fatal MCP Server error:', err);
    process.exit(1);
  });
}

module.exports = server;
