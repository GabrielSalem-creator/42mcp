const boxdClient = require('./boxdClient');

class ScreenAnalyzer {
  /**
   * Analyzes the active page in the VM browser by reading interactive elements,
   * URL, and title, detecting login forms, 2FA prompts, and active sessions.
   */
  async analyzePage() {
    try {
      const [urlRes, titleRes, snapRes] = await Promise.all([
        boxdClient.exec('DISPLAY=:100 agent-browser get url'),
        boxdClient.exec('DISPLAY=:100 agent-browser get title'),
        boxdClient.exec('DISPLAY=:100 agent-browser snapshot -i')
      ]);

      const url = urlRes.stdout.trim();
      const title = titleRes.stdout.trim();
      const snapshot = snapRes.stdout.trim();

      const lines = snapshot.split('\n').map(l => l.trim()).filter(Boolean);

      // Detect input fields and buttons
      let usernameRef = null;
      let passwordRef = null;
      let twoFactorRef = null;
      let submitRef = null;
      const detectedInputs = [];
      const detectedButtons = [];

      for (const line of lines) {
        const refMatch = line.match(/\[ref=(e\d+)\]/);
        const ref = refMatch ? refMatch[1] : null;

        if (line.startsWith('- textbox') || line.startsWith('- combobox')) {
          const lower = line.toLowerCase();
          const label = line.split('[')[0].replace(/^- (textbox|combobox)\s*/, '').replace(/"/g, '').trim();

          if (lower.includes('two-factor') || lower.includes('security code') || lower.includes('confirmation code') || lower.includes('verification code') || lower.includes('6-digit') || lower.includes('code')) {
            twoFactorRef = ref;
            detectedInputs.push({ ref, type: '2fa', label: label || 'Security Code' });
          } else if (lower.includes('password') || lower.includes('passcode')) {
            passwordRef = ref;
            detectedInputs.push({ ref, type: 'password', label: label || 'Password' });
          } else if (lower.includes('username') || lower.includes('email') || lower.includes('phone') || lower.includes('mobile')) {
            usernameRef = ref;
            detectedInputs.push({ ref, type: 'username', label: label || 'Username / Email' });
          } else {
            detectedInputs.push({ ref, type: 'text', label: label || 'Input field' });
          }
        } else if (line.startsWith('- button')) {
          const lower = line.toLowerCase();
          const label = line.split('[')[0].replace(/^- button\s*/, '').replace(/"/g, '').trim();
          detectedButtons.push({ ref, label });

          if (!submitRef && (lower.includes('log in') || lower.includes('sign in') || lower.includes('submit') || lower.includes('continue') || lower.includes('next') || lower.includes('confirm'))) {
            submitRef = ref;
          }
        }
      }

      // Determine page classification
      let pageType = 'generic';
      let statusMessage = '';
      let is2FA = Boolean(twoFactorRef) || snapshot.toLowerCase().includes('enter the 6-digit code') || snapshot.toLowerCase().includes('security code');
      let isRateLimited = url.includes('chrome-error') || title.includes('429') || snapshot.includes('HTTP ERROR 429') || snapshot.includes('page isn’t working');

      if (isRateLimited) {
        pageType = 'rate_limited';
        statusMessage = 'Page rate-limited or error. Instagram requires login to browse profiles.';
      } else if (is2FA) {
        pageType = '2fa_checkpoint';
        statusMessage = '2FA Checkpoint detected! Enter your 6-digit verification code to complete login.';
      } else if (usernameRef && passwordRef) {
        pageType = 'login_form';
        statusMessage = 'Login form detected. Enter your credentials or click on screen to sign in.';
      } else if (url.includes('instagram.com') && !url.includes('login') && (snapshot.includes('Home') || snapshot.includes('Search') || snapshot.includes('Direct') || snapshot.includes('Profile'))) {
        pageType = 'logged_in_feed';
        statusMessage = 'Authenticated session active! You can now instruct the AI to extract data.';
      }

      return {
        success: true,
        url,
        title,
        pageType,
        statusMessage,
        is2FA,
        fields: {
          usernameRef,
          passwordRef,
          twoFactorRef,
          submitRef
        },
        detectedInputs,
        detectedButtons,
        interactiveLineCount: lines.length
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * AI-powered auto-fill and submit on the VM page
   */
  async aiFillAndSubmit({ username, password, twoFactorCode, submit = true }) {
    const analysis = await this.analyzePage();
    if (!analysis.success) throw new Error(analysis.error);

    const commands = [];

    // If 2FA code is provided and 2FA input is present
    if (twoFactorCode && analysis.fields.twoFactorRef) {
      commands.push(`agent-browser fill @${analysis.fields.twoFactorRef} "${twoFactorCode.replace(/"/g, '')}"`);
    } else {
      if (username && analysis.fields.usernameRef) {
        commands.push(`agent-browser fill @${analysis.fields.usernameRef} "${username.replace(/"/g, '')}"`);
      }
      if (password && analysis.fields.passwordRef) {
        commands.push(`agent-browser fill @${analysis.fields.passwordRef} "${password.replace(/"/g, '')}"`);
      }
    }

    if (submit && analysis.fields.submitRef) {
      commands.push(`agent-browser click @${analysis.fields.submitRef}`);
    }

    if (commands.length > 0) {
      const fullCmd = `DISPLAY=:100 ${commands.join(' && ')}`;
      await boxdClient.exec(fullCmd, undefined, 30000);
      // Wait for page transition
      await new Promise(r => setTimeout(r, 2500));
    }

    // Re-analyze after submit
    const nextState = await this.analyzePage();
    return nextState;
  }

  /**
   * Click an element by label (e.g. "Log In") or ref (@e74)
   */
  async clickElement(labelOrRef) {
    const analysis = await this.analyzePage();
    let targetRef = null;
    const clean = (labelOrRef || '').replace(/^@/, '').trim();
    if (clean.startsWith('e') && /^\d+$/.test(clean.slice(1))) {
      targetRef = clean;
    } else {
      const match = analysis.detectedButtons?.find(b => b.label && b.label.toLowerCase().includes(clean.toLowerCase()));
      if (match && match.ref) {
        targetRef = match.ref;
      } else if (analysis.fields?.submitRef && (clean.includes('log in') || clean.includes('submit') || clean.includes('sign in') || clean.includes('continue'))) {
        targetRef = analysis.fields.submitRef;
      }
    }

    if (targetRef) {
      await boxdClient.exec(`DISPLAY=:100 agent-browser click @${targetRef}`, undefined, 15000);
    } else {
      await boxdClient.exec(`DISPLAY=:100 agent-browser press Enter`, undefined, 10000);
    }
    await new Promise(r => setTimeout(r, 2000));
    return this.analyzePage();
  }

  /**
   * Press a key on the VM browser
   */
  async pressKey(key = 'Enter') {
    const safeKey = key.replace(/[^a-zA-Z0-9_+ -]/g, '');
    await boxdClient.exec(`DISPLAY=:100 agent-browser press ${safeKey}`, undefined, 10000);
    await new Promise(r => setTimeout(r, 1000));
    return this.analyzePage();
  }
}

module.exports = new ScreenAnalyzer();
