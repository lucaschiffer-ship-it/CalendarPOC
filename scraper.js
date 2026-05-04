const puppeteer = require('puppeteer');
const fs        = require('fs');

const BASE_URL     = 'https://spaces.kisd.de';
const FILTERED_URL = `${BASE_URL}/course-selection/?semester=2026-1&mycourses=on`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function scrapeKISD(username, password, requestMfaCode) {
  // Regular (non-incognito) context so cookies persist across navigations
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // Block the MFA page's auto-submit: the IDPLogin form fires document.IDPLogin.submit()
    // on page load with an empty nffc field, consuming the OTP attempt before the user
    // can type the real code. Patch submit() to ignore calls where nffc is empty.
    await page.evaluateOnNewDocument(() => {
      const _origSubmit = HTMLFormElement.prototype.submit;
      HTMLFormElement.prototype.submit = function () {
        const nffc = this.elements && this.elements['nffc'];
        if (nffc !== undefined && nffc.value === '') {
          console.log('[injected] Blocked IDPLogin auto-submit (nffc empty)');
          return;
        }
        return _origSubmit.call(this);
      };
    });

    // ── 1. Navigate to portal and click "TH Login" (SAML SSO) ────────────
    // Local login only works for admin accounts. Student accounts must use
    // SAML via login.th-koeln.de.

    console.log('[scraper] Step 1 — navigating to portal…');
    await page.goto(`${BASE_URL}/public/`, { waitUntil: 'networkidle2', timeout: 45000 });
    console.log('[scraper] Landed on:', page.url());

    const samlLink = await page.$('#saml-login-link, a[title="TH Login"]');
    if (!samlLink) throw new Error('SAML login link not found on portal page.');

    console.log('[scraper] Step 1 — clicking TH Login (SAML)…');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 45000 }),
      samlLink.click(),
    ]);
    console.log('[scraper] Redirected to:', page.url());

    // ── 2. Fill credentials on the TH Köln identity provider ─────────────

    console.log('[scraper] Step 2 — filling credentials on IdP…');

    // Log all inputs to identify the right selectors
    const idpInputs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input')).map((i) => ({
        type: i.type, name: i.name, id: i.id,
      }))
    );
    console.log('[scraper] IdP inputs:', JSON.stringify(idpInputs));

    const userEl = await page.$('input[name="Ecom_User_ID"], input[name="username"], input[name="user"], #username, input[type="text"]');
    const passEl = await page.$('input[name="Ecom_Password"], input[name="password"], input[name="pass"], #password, input[type="password"]');

    if (!userEl) throw new Error('Username field not found on IdP page.');
    if (!passEl) throw new Error('Password field not found on IdP page.');

    await userEl.click({ clickCount: 3 });
    await userEl.type(username, { delay: 30 });
    await passEl.click({ clickCount: 3 });
    await passEl.type(password, { delay: 30 });

    // ── 3. Submit and wait for SAML to redirect back ──────────────────────
    // The IdP may use a non-standard submit element; pressing Enter is universal.

    console.log('[scraper] Step 3 — submitting IdP form…');
    await page.keyboard.press('Enter');

    // Follow redirect chain after credential submission (may go through MFA or straight to spaces)
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
    console.log('[scraper] After credentials hop 1:', page.url());

    if (!page.url().includes('spaces.kisd.de') &&
        !page.url().includes('mfa.th-koeln.de') &&
        !page.url().includes('/osp/')) {
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
      console.log('[scraper] After credentials hop 2:', page.url());
    }

    // ── 4. Handle MFA if required ─────────────────────────────────────────

    if (page.url().includes('mfa.th-koeln.de') || page.url().includes('/osp/')) {
      console.log('[scraper] Step 4 — MFA required, requesting code from UI…');
      if (!requestMfaCode) throw new Error('MFA required but no handler provided.');

      const mfaCode = await requestMfaCode();
      console.log('[scraper] Step 4 — MFA code received, entering…');

      // MFA field confirmed: id="nffc", type="password" (TH Köln NetIQ IdP)
      // After OTP submit, the chain is:
      //   mfa.th-koeln.de/osp/... → login.th-koeln.de/nidp/saml2/sso?sid=0
      //   → auto-submit SAML assertion → spaces.kisd.de
      // waitForNavigation only catches the first hop, so poll until we land home.

      await page.waitForSelector('#nffc', { timeout: 10000 });

      // Set value directly (no per-character delay) and submit immediately.
      // The evaluateOnNewDocument patch above ensures the auto-submit with
      // empty nffc was blocked, so this is the first real submission.
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }),
        page.evaluate((code) => {
          document.getElementById('nffc').value = code;
          document.IDPLogin.submit();
        }, mfaCode),
      ]);
      console.log('[scraper] After MFA hop 1:', page.url());

      // The SAML assertion page (sid=0) has an auto-submit form.
      // If it hasn't navigated away, explicitly submit it.
      if (!page.url().includes('spaces.kisd.de')) {
        require('fs').writeFileSync('/tmp/kisd-saml-sid0.html', await page.content());
        console.log('[scraper] Saved sid=0 HTML to /tmp/kisd-saml-sid0.html');

        const formInfo = await page.evaluate(() => {
          const forms = Array.from(document.forms);
          return forms.map((f) => ({
            id: f.id, name: f.name, action: f.action, method: f.method,
            inputs: Array.from(f.elements).map((e) => ({ tag: e.tagName, type: e.type, name: e.name })),
          }));
        });
        console.log('[scraper] Forms on sid=0 page:', JSON.stringify(formInfo));

        // Try to submit the first form (SAML assertion)
        const submitted = await page.evaluate(() => {
          const f = document.forms[0];
          if (f) { f.submit(); return true; }
          return false;
        });
        console.log('[scraper] sid=0 form submitted:', submitted);

        if (submitted) {
          await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
          console.log('[scraper] After sid=0 submit:', page.url());
        }
      }
    }

    const urlAfterLogin = page.url();
    const titleAfterLogin = await page.title();
    console.log('[scraper] URL after login:', urlAfterLogin);
    console.log('[scraper] Title after login:', titleAfterLogin);

    // ── 5. Check for login failure ────────────────────────────────────────

    if (!urlAfterLogin.includes('spaces.kisd.de')) {
      const errorMsg = await page.evaluate(() => {
        const el = document.querySelector('.login-error, #login_error, .message, .error, #error');
        return el ? el.innerText : null;
      });
      console.log('[LOGIN ERROR]', errorMsg);
      throw new Error(`Login failed — still on login page. Error: ${errorMsg || 'none visible'}`);
    }

    // ── 8. Prime course-selection subsite ────────────────────────────────

    console.log('[scraper] Priming course-selection subsite…');
    await page.goto(`${BASE_URL}/course-selection/`, { waitUntil: 'networkidle2', timeout: 45000 });
    await sleep(2000);
    await page.evaluate(() => console.log('[BODY CLASS after prime]', document.body.className));

    // ── 9–10. Navigate to filtered URL and scrape ─────────────────────────

    console.log('[scraper] Navigating to filtered URL…');
    await page.goto(FILTERED_URL, { waitUntil: 'networkidle2', timeout: 45000 });
    await page.evaluate(() => console.log('[BODY CLASS on filtered page]', document.body.className));

    console.log('[scraper] Waiting 5000ms for render…');
    await sleep(5000);

    const courses = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('article.card.course')).map((el) => {
        const h1 = el.querySelector('h1[title]');
        const title = h1
          ? h1.getAttribute('title')
          : (el.querySelector('h1')?.textContent.trim() || 'Untitled');

        const courseType =
          el.querySelector('.info-chip-course_type .value')?.textContent.trim() || null;

        const lecturers = [...new Set(
          Array.from(el.querySelectorAll('.avatar-name'))
            .map((e) => e.textContent.trim()).filter(Boolean)
        )];

        let timeframe = null, meetingTimes = null, location = null, description = null;
        for (const label of el.querySelectorAll('.info-label')) {
          const key     = label.textContent.trim();
          const content = label.parentElement?.querySelector('.info-content');
          if (!content) continue;
          if (key === 'Timeframe')
            timeframe = content.textContent.replace(/\s+/g, ' ').trim();
          if (key === 'Meeting Times')
            meetingTimes = content.innerHTML
              .replace(/<br\s*\/?>/gi, ' · ').replace(/<[^>]+>/g, '')
              .replace(/\s*·\s*/g, ' · ').replace(/\s+/g, ' ').trim();
          if (key === 'Location')
            location = content.textContent.replace(/\s+/g, ' ').trim();
          if (key === 'Description')
            description = content.textContent.replace(/\s+/g, ' ').trim();
        }

        return {
          title, courseType, lecturers,
          timeframe, meetingTimes, location, description,
          courseUrl: el.getAttribute('data-post-url') || null,
        };
      });
    });

    console.log(`[scraper] Found ${courses.length} course(s).`);
    return courses;

  } finally {
    await browser.close();
  }
}

module.exports = { scrapeKISD };
